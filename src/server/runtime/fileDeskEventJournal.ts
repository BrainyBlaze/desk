import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DESK_EVENT_SCHEMA_VERSION,
  DESK_EVENT_KINDS,
  parseChannelMessageDeskEventInput,
  parseDeskEvent,
  parseDeskEventReadRequest,
  projectTransitionToDeskEvents,
  type ChannelMessageDeskEventInput,
  type DeskEvent,
  type DeskEventFeedResponse,
  type DeskEventKind,
  type DeskEventReadRequest
} from '../../shared/controlPlane/eventFeed.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  parseSessionStateSnapshot,
  type SessionStateTransition,
  type SessionStateTransitionCause
} from '../../shared/controlPlane/contract.js';

const JOURNAL_RECORD_VERSION = 1 as const;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1_000;
const DEFAULT_MAX_RETAINED_EVENTS = 1_000;
const DEFAULT_MAX_RETAINED_TRANSITIONS = 1_000;
const DEFAULT_MAX_CHANNEL_RECEIPTS = 1_000;
const DEFAULT_COMPACT_EVERY_RECORDS = 1_000;
const TRANSITION_CAUSES: Record<SessionStateTransitionCause, true> = {
  registered: true,
  'lifecycle-running': true,
  'lifecycle-exited': true,
  'producer-reconciled': true,
  'agent-event': true,
  'title-fallback': true,
  'source-health': true,
  'working-lease-expired': true,
  delivery: true,
  policy: true
};

interface TransitionRecord {
  recordVersion: typeof JOURNAL_RECORD_VERSION;
  journalSeq: number;
  type: 'transition';
  transition: SessionStateTransition;
  events: DeskEvent[];
}

interface ChannelRecord {
  recordVersion: typeof JOURNAL_RECORD_VERSION;
  journalSeq: number;
  type: 'channel';
  dedupeKey: string;
  fingerprint: string;
  input: ChannelMessageDeskEventInput;
  event: Extract<DeskEvent, { kind: 'channel-message' }>;
}

interface ReadRecord {
  recordVersion: typeof JOURNAL_RECORD_VERSION;
  journalSeq: number;
  type: 'read';
  throughSeq: number;
  request: DeskEventReadRequest;
}

interface ClearRecord {
  recordVersion: typeof JOURNAL_RECORD_VERSION;
  journalSeq: number;
  type: 'clear';
  throughSeq: number;
}

interface TransitionEventSource {
  type: 'transition';
  transition: SessionStateTransition;
  projectionIndex: number;
}

interface ChannelEventSource {
  type: 'channel';
  input: ChannelMessageDeskEventInput;
}

type RetainedEventSource = TransitionEventSource | ChannelEventSource;

interface RetainedEventRecord {
  event: DeskEvent;
  source: RetainedEventSource;
}

interface CheckpointChannelReceipt {
  dedupeKey: string;
  fingerprint: string;
  event: Extract<DeskEvent, { kind: 'channel-message' }>;
}

interface CheckpointRecord {
  recordVersion: typeof JOURNAL_RECORD_VERSION;
  journalSeq: number;
  type: 'checkpoint';
  eventSeq: number;
  retainedEvents: RetainedEventRecord[];
  transitions: SessionStateTransition[];
  channelReceipts: CheckpointChannelReceipt[];
  readIds: string[];
  readAllThrough: number;
  kindReadThrough: Array<{ kind: DeskEventKind; throughSeq: number }>;
  clearedThrough: number;
}

type AppendRecord =
  | TransitionRecord
  | ChannelRecord
  | ReadRecord
  | ClearRecord;
type JournalRecord = AppendRecord | CheckpointRecord;

interface ChannelReceipt {
  fingerprint: string;
  event: Extract<DeskEvent, { kind: 'channel-message' }>;
}

export interface DeskEventJournalDegradation {
  reason: 'event-journal-corrupt' | 'event-journal-compaction-failed';
  detail: string;
  quarantinePath?: string;
}

export type DeskEventJournalHealth =
  | { status: 'healthy' }
  | {
      status: 'degraded';
      reasons: DeskEventJournalDegradation[];
    };

export type AppendChannelDeskEventResult =
  | {
      kind: 'appended' | 'duplicate';
      event: Extract<DeskEvent, { kind: 'channel-message' }>;
    }
  | { kind: 'conflict' };

export interface FileDeskEventJournalOptions {
  now?: () => number;
  maxEvents?: number;
  maxTransitions?: number;
  maxChannelReceipts?: number;
  compactEveryRecords?: number;
}

class DeskEventJournalCorruptionError extends Error {}

export class FileDeskEventJournal {
  private readonly events: DeskEvent[] = [];
  private readonly eventSources = new Map<number, RetainedEventSource>();
  private readonly transitions: SessionStateTransition[] = [];
  private readonly channelReceipts = new Map<string, ChannelReceipt>();
  private readonly readIds = new Set<string>();
  private readonly kindReadThrough = new Map<DeskEventKind, number>();
  private readAllThrough = 0;
  private clearedThrough = 0;
  private eventSeq = 0;
  private journalSeq = 0;
  private recordsSinceCompaction = 0;
  private fd: number | null = null;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxTransitions: number;
  private readonly maxChannelReceipts: number;
  private readonly compactEveryRecords: number;
  private readonly degradations: DeskEventJournalDegradation[] = [];

  constructor(
    private readonly path: string,
    options: FileDeskEventJournalOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.maxEvents = positiveOption(
      options.maxEvents,
      DEFAULT_MAX_RETAINED_EVENTS,
      'maxEvents'
    );
    this.maxTransitions = positiveOption(
      options.maxTransitions,
      DEFAULT_MAX_RETAINED_TRANSITIONS,
      'maxTransitions'
    );
    this.maxChannelReceipts = positiveOption(
      options.maxChannelReceipts,
      DEFAULT_MAX_CHANNEL_RECEIPTS,
      'maxChannelReceipts'
    );
    this.compactEveryRecords = positiveOption(
      options.compactEveryRecords,
      DEFAULT_COMPACT_EVERY_RECORDS,
      'compactEveryRecords'
    );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      this.replay();
    } catch (error) {
      if (!(error instanceof DeskEventJournalCorruptionError)) throw error;
      const quarantinePath = this.quarantineCorruptJournal();
      this.resetData();
      this.degradations.push({
        reason: 'event-journal-corrupt',
        detail: error.message,
        quarantinePath
      });
    }
    this.fd = openSync(path, 'a', 0o600);
  }

  appendTransition(input: SessionStateTransition): DeskEvent[] {
    const transition = parseTransition(input);
    const projected = projectTransitionToDeskEvents(transition);
    const events = projected.map((draft, index) =>
      parseDeskEvent({
        ...draft,
        id: `desk-event-${this.eventSeq + index + 1}`,
        seq: this.eventSeq + index + 1,
        read: false
      })
    );
    const record: TransitionRecord = {
      recordVersion: JOURNAL_RECORD_VERSION,
      journalSeq: this.journalSeq + 1,
      type: 'transition',
      transition,
      events
    };
    this.commitRecord(record);
    return structuredClone(events);
  }

  appendChannel(input: unknown): AppendChannelDeskEventResult {
    const parsed = parseChannelMessageDeskEventInput(input);
    const dedupeKey = channelDedupeKey(parsed);
    const fingerprint = JSON.stringify(parsed);
    const prior = this.channelReceipts.get(dedupeKey);
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? { kind: 'duplicate', event: structuredClone(prior.event) }
        : { kind: 'conflict' };
    }

    const event = parseDeskEvent({
      schemaVersion: DESK_EVENT_SCHEMA_VERSION,
      id: `desk-event-${this.eventSeq + 1}`,
      seq: this.eventSeq + 1,
      at: isoTimestamp(this.now()),
      read: false,
      kind: 'channel-message',
      ...parsed
    }) as Extract<DeskEvent, { kind: 'channel-message' }>;
    const record: ChannelRecord = {
      recordVersion: JOURNAL_RECORD_VERSION,
      journalSeq: this.journalSeq + 1,
      type: 'channel',
      dedupeKey,
      fingerprint,
      input: parsed,
      event
    };
    this.commitRecord(record);
    return { kind: 'appended', event: structuredClone(event) };
  }

  markRead(input: unknown): number {
    const parsed = parseDeskEventReadRequest(input);
    const knownIds =
      parsed.ids === undefined
        ? undefined
        : [
            ...new Set(
              parsed.ids.filter((id) =>
                this.events.some((event) => event.id === id && event.seq > this.clearedThrough)
              )
            )
          ];
    const request: DeskEventReadRequest = {
      ...(parsed.all === undefined ? {} : { all: parsed.all }),
      ...(knownIds === undefined ? {} : { ids: knownIds }),
      ...(parsed.kinds === undefined
        ? {}
        : { kinds: [...new Set(parsed.kinds)] })
    };
    const hasEffect =
      request.all === true ||
      (request.ids !== undefined && request.ids.length > 0) ||
      (request.kinds !== undefined && request.kinds.length > 0);
    if (hasEffect) {
      const record: ReadRecord = {
        recordVersion: JOURNAL_RECORD_VERSION,
        journalSeq: this.journalSeq + 1,
        type: 'read',
        throughSeq: this.eventSeq,
        request
      };
      this.commitRecord(record);
    }
    return this.unreadCount();
  }

  clear(): 0 {
    if (this.eventSeq > this.clearedThrough) {
      const record: ClearRecord = {
        recordVersion: JOURNAL_RECORD_VERSION,
        journalSeq: this.journalSeq + 1,
        type: 'clear',
        throughSeq: this.eventSeq
      };
      this.commitRecord(record, true);
    }
    return 0;
  }

  snapshot(options: { limit?: number } = {}): DeskEventFeedResponse {
    const limit = boundedLimit(options.limit);
    const visible = this.events.filter(
      (event) => event.seq > this.clearedThrough
    );
    const items = visible
      .slice()
      .reverse()
      .slice(0, limit)
      .map((event) => this.withReadState(event));
    return {
      schemaVersion: DESK_EVENT_SCHEMA_VERSION,
      latestSeq: this.eventSeq,
      unread: visible.reduce(
        (count, event) => count + (this.isRead(event) ? 0 : 1),
        0
      ),
      items
    };
  }

  auditTransitions(): SessionStateTransition[] {
    return structuredClone(this.transitions);
  }

  health(): DeskEventJournalHealth {
    return this.degradations.length === 0
      ? { status: 'healthy' }
      : {
          status: 'degraded',
          reasons: structuredClone(this.degradations)
        };
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  private unreadCount(): number {
    return this.events.reduce(
      (count, event) =>
        count +
        (event.seq <= this.clearedThrough || this.isRead(event) ? 0 : 1),
      0
    );
  }

  private isRead(event: DeskEvent): boolean {
    return (
      event.seq <= this.readAllThrough ||
      event.seq <= (this.kindReadThrough.get(event.kind) ?? 0) ||
      this.readIds.has(event.id)
    );
  }

  private withReadState(event: DeskEvent): DeskEvent {
    return { ...structuredClone(event), read: this.isRead(event) } as DeskEvent;
  }

  private replay(): void {
    if (!existsSync(this.path)) return;
    const contents = readFileSync(this.path, 'utf8');
    let durableContents = contents;
    if (contents.length > 0 && !contents.endsWith('\n')) {
      const finalNewline = contents.lastIndexOf('\n');
      durableContents =
        finalNewline < 0 ? '' : contents.slice(0, finalNewline + 1);
      truncateSync(this.path, Buffer.byteLength(durableContents));
    }

    let lineNumber = 0;
    for (const line of durableContents.split('\n')) {
      if (line.length === 0) continue;
      lineNumber += 1;
      try {
        const record = parseJournalRecord(JSON.parse(line));
        if (record.type === 'checkpoint') {
          if (lineNumber !== 1) {
            throw new Error('desk event journal checkpoint is not first');
          }
          this.installCheckpoint(record);
          continue;
        }
        if (record.journalSeq !== this.journalSeq + 1) {
          throw new Error('desk event journal sequence gap');
        }
        this.installRecord(record);
        this.recordsSinceCompaction += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new DeskEventJournalCorruptionError(
          `desk event journal corrupt at record ${lineNumber}: ${detail}`
        );
      }
    }
  }

  private commitRecord(record: AppendRecord, forceCompact = false): void {
    this.appendRecord(record);
    this.installRecord(record);
    this.recordsSinceCompaction += 1;
    this.maybeCompact(forceCompact);
  }

  private appendRecord(record: AppendRecord): void {
    if (this.fd === null) this.fd = openSync(this.path, 'a', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    writeFully(this.fd, bytes, 'durable desk event append made no progress');
    fsyncSync(this.fd);
  }

  private installRecord(record: AppendRecord): void {
    if (record.journalSeq !== this.journalSeq + 1) {
      throw new Error('desk event journal record sequence is not monotonic');
    }
    if (record.type === 'transition') {
      this.transitions.push(structuredClone(record.transition));
      for (let index = 0; index < record.events.length; index += 1) {
        this.installEvent(record.events[index]!, {
          type: 'transition',
          transition: record.transition,
          projectionIndex: index
        });
      }
    } else if (record.type === 'channel') {
      this.installEvent(record.event, {
        type: 'channel',
        input: record.input
      });
      this.channelReceipts.set(record.dedupeKey, {
        fingerprint: record.fingerprint,
        event: structuredClone(record.event)
      });
    } else if (record.type === 'read') {
      if (record.throughSeq > this.eventSeq) {
        throw new Error('desk event read acknowledgment exceeds feed sequence');
      }
      if (record.request.all === true) {
        this.readAllThrough = Math.max(
          this.readAllThrough,
          record.throughSeq
        );
      }
      for (const kind of record.request.kinds ?? []) {
        this.kindReadThrough.set(
          kind,
          Math.max(this.kindReadThrough.get(kind) ?? 0, record.throughSeq)
        );
      }
      for (const id of record.request.ids ?? []) this.readIds.add(id);
    } else {
      if (record.throughSeq > this.eventSeq) {
        throw new Error('desk event clear acknowledgment exceeds feed sequence');
      }
      this.clearedThrough = Math.max(
        this.clearedThrough,
        record.throughSeq
      );
      this.dropClearedEvents();
    }
    this.journalSeq = record.journalSeq;
    this.enforceRetention();
  }

  private installEvent(event: DeskEvent, source: RetainedEventSource): void {
    if (
      event.seq !== this.eventSeq + 1 ||
      event.id !== `desk-event-${event.seq}` ||
      event.read
    ) {
      throw new Error('desk event feed sequence is corrupt');
    }
    this.events.push(structuredClone(event));
    this.eventSources.set(event.seq, structuredClone(source));
    this.eventSeq = event.seq;
  }

  private installCheckpoint(record: CheckpointRecord): void {
    this.resetData();
    this.eventSeq = record.eventSeq;
    for (const retained of record.retainedEvents) {
      this.events.push(structuredClone(retained.event));
      this.eventSources.set(
        retained.event.seq,
        structuredClone(retained.source)
      );
    }
    this.transitions.push(...structuredClone(record.transitions));
    for (const receipt of record.channelReceipts) {
      this.channelReceipts.set(receipt.dedupeKey, {
        fingerprint: receipt.fingerprint,
        event: structuredClone(receipt.event)
      });
    }
    for (const id of record.readIds) this.readIds.add(id);
    this.readAllThrough = record.readAllThrough;
    for (const item of record.kindReadThrough) {
      this.kindReadThrough.set(item.kind, item.throughSeq);
    }
    this.clearedThrough = record.clearedThrough;
    this.journalSeq = record.journalSeq;
    this.recordsSinceCompaction = 0;
    this.enforceRetention();
  }

  private enforceRetention(): void {
    const eventExcess = this.events.length - this.maxEvents;
    if (eventExcess > 0) {
      for (const event of this.events.splice(0, eventExcess)) {
        this.eventSources.delete(event.seq);
        this.readIds.delete(event.id);
      }
    }
    const transitionExcess = this.transitions.length - this.maxTransitions;
    if (transitionExcess > 0) {
      this.transitions.splice(0, transitionExcess);
    }
    while (this.channelReceipts.size > this.maxChannelReceipts) {
      const oldest = this.channelReceipts.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.channelReceipts.delete(oldest);
    }
    const retainedIds = new Set(this.events.map((event) => event.id));
    for (const id of this.readIds) {
      if (!retainedIds.has(id)) this.readIds.delete(id);
    }
  }

  private dropClearedEvents(): void {
    let dropCount = 0;
    while (
      dropCount < this.events.length &&
      this.events[dropCount]!.seq <= this.clearedThrough
    ) {
      const event = this.events[dropCount]!;
      this.eventSources.delete(event.seq);
      this.readIds.delete(event.id);
      dropCount += 1;
    }
    if (dropCount > 0) this.events.splice(0, dropCount);
  }

  private checkpoint(): CheckpointRecord {
    const retainedEvents = this.events.map((event): RetainedEventRecord => {
      const source = this.eventSources.get(event.seq);
      if (source === undefined) {
        throw new Error(`desk event ${event.id} is missing its source`);
      }
      return {
        event: structuredClone(event),
        source: structuredClone(source)
      };
    });
    return {
      recordVersion: JOURNAL_RECORD_VERSION,
      journalSeq: this.journalSeq,
      type: 'checkpoint',
      eventSeq: this.eventSeq,
      retainedEvents,
      transitions: structuredClone(this.transitions),
      channelReceipts: [...this.channelReceipts.entries()].map(
        ([dedupeKey, receipt]) => ({
          dedupeKey,
          fingerprint: receipt.fingerprint,
          event: structuredClone(receipt.event)
        })
      ),
      readIds: [...this.readIds],
      readAllThrough: this.readAllThrough,
      kindReadThrough: [...this.kindReadThrough.entries()].map(
        ([kind, throughSeq]) => ({ kind, throughSeq })
      ),
      clearedThrough: this.clearedThrough
    };
  }

  private maybeCompact(force: boolean): void {
    if (
      this.journalSeq === 0 ||
      (!force && this.recordsSinceCompaction < this.compactEveryRecords)
    ) {
      return;
    }
    try {
      this.compact();
    } catch (error) {
      this.recordDegradation({
        reason: 'event-journal-compaction-failed',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private compact(): void {
    const bytes = Buffer.from(`${JSON.stringify(this.checkpoint())}\n`, 'utf8');
    this.close();
    try {
      atomicReplace(this.path, bytes);
      this.recordsSinceCompaction = 0;
    } finally {
      this.fd = openSync(this.path, 'a', 0o600);
    }
  }

  private quarantineCorruptJournal(): string {
    const quarantinePath = uniqueQuarantinePath(this.path, this.now());
    renameSync(this.path, quarantinePath);
    fsyncDirectory(dirname(this.path));
    return quarantinePath;
  }

  private recordDegradation(degradation: DeskEventJournalDegradation): void {
    const index = this.degradations.findIndex(
      (item) => item.reason === degradation.reason
    );
    if (index < 0) {
      this.degradations.push(degradation);
    } else {
      this.degradations[index] = degradation;
    }
  }

  private resetData(): void {
    this.events.length = 0;
    this.eventSources.clear();
    this.transitions.length = 0;
    this.channelReceipts.clear();
    this.readIds.clear();
    this.kindReadThrough.clear();
    this.readAllThrough = 0;
    this.clearedThrough = 0;
    this.eventSeq = 0;
    this.journalSeq = 0;
    this.recordsSinceCompaction = 0;
  }
}

function boundedLimit(input: number | undefined): number {
  if (input === undefined) return DEFAULT_EVENT_LIMIT;
  if (!Number.isSafeInteger(input) || input <= 0) return DEFAULT_EVENT_LIMIT;
  return Math.min(input, MAX_EVENT_LIMIT);
}

function isoTimestamp(input: number): string {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new Error(`invalid desk event timestamp: ${input}`);
  }
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid desk event timestamp: ${input}`);
  }
  return date.toISOString();
}

function channelDedupeKey(input: ChannelMessageDeskEventInput): string {
  return JSON.stringify([input.channel, input.messageId]);
}

function parseTransition(input: unknown): SessionStateTransition {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid desk event transition');
  }
  const record = input as Record<string, unknown>;
  if (
    record.schemaVersion !== AGENT_STATE_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(record.revision) ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.trim().length === 0 ||
    !isPositiveSafeInteger(record.generation) ||
    !isNonNegativeSafeInteger(record.at) ||
    !isTransitionCause(record.cause) ||
    (record.acceptedEventId !== undefined &&
      (typeof record.acceptedEventId !== 'string' ||
        record.acceptedEventId.trim().length === 0)) ||
    typeof record.actionable !== 'boolean'
  ) {
    throw new Error('invalid desk event transition');
  }
  const from =
    record.from === null ? null : parseSessionStateSnapshot(record.from);
  const to = parseSessionStateSnapshot(record.to);
  if (
    to.revision !== record.revision ||
    to.sessionId !== record.sessionId ||
    to.generation !== record.generation ||
    (from !== null &&
      (from.sessionId !== record.sessionId ||
        from.generation !== record.generation))
  ) {
    throw new Error('inconsistent desk event transition');
  }
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    revision: record.revision,
    sessionId: record.sessionId,
    generation: record.generation,
    at: record.at,
    cause: record.cause,
    ...(record.acceptedEventId === undefined
      ? {}
      : { acceptedEventId: record.acceptedEventId }),
    actionable: record.actionable,
    from,
    to
  };
}

function parseJournalRecord(input: unknown): JournalRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid desk event journal record');
  }
  const record = input as Record<string, unknown>;
  if (
    record.recordVersion !== JOURNAL_RECORD_VERSION ||
    !isPositiveSafeInteger(record.journalSeq)
  ) {
    throw new Error('invalid desk event journal record');
  }
  const common = {
    recordVersion: JOURNAL_RECORD_VERSION,
    journalSeq: record.journalSeq
  } as const;

  if (record.type === 'checkpoint') {
    return parseCheckpointRecord(record, common);
  }

  if (record.type === 'transition') {
    if (!Array.isArray(record.events)) {
      throw new Error('invalid desk event transition record');
    }
    const transition = parseTransition(record.transition);
    const events = record.events.map(parseDeskEvent);
    const projected = projectTransitionToDeskEvents(transition);
    if (events.length !== projected.length) {
      throw new Error('desk event transition projection mismatch');
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const expected = parseDeskEvent({
        ...projected[index]!,
        id: `desk-event-${event.seq}`,
        seq: event.seq,
        read: false
      });
      if (!isDeepStrictEqual(event, expected)) {
        throw new Error('desk event transition projection mismatch');
      }
    }
    return {
      ...common,
      type: 'transition',
      transition,
      events
    };
  }

  if (record.type === 'channel') {
    const parsedInput = parseChannelMessageDeskEventInput(record.input);
    const event = parseDeskEvent(record.event);
    const dedupeKey = channelDedupeKey(parsedInput);
    const fingerprint = JSON.stringify(parsedInput);
    const expectedEvent = parseDeskEvent({
      schemaVersion: DESK_EVENT_SCHEMA_VERSION,
      id: `desk-event-${event.seq}`,
      seq: event.seq,
      at: event.at,
      read: false,
      kind: 'channel-message',
      ...parsedInput
    });
    if (
      event.kind !== 'channel-message' ||
      record.dedupeKey !== dedupeKey ||
      record.fingerprint !== fingerprint
    ) {
      throw new Error('invalid desk event channel record');
    }
    if (!isDeepStrictEqual(event, expectedEvent)) {
      throw new Error('desk event channel projection mismatch');
    }
    return {
      ...common,
      type: 'channel',
      dedupeKey,
      fingerprint,
      input: parsedInput,
      event
    };
  }

  if (record.type === 'read') {
    if (!isNonNegativeSafeInteger(record.throughSeq)) {
      throw new Error('invalid desk event read record');
    }
    return {
      ...common,
      type: 'read',
      throughSeq: record.throughSeq,
      request: parseDeskEventReadRequest(record.request)
    };
  }

  if (record.type === 'clear') {
    if (!isNonNegativeSafeInteger(record.throughSeq)) {
      throw new Error('invalid desk event clear record');
    }
    return {
      ...common,
      type: 'clear',
      throughSeq: record.throughSeq
    };
  }

  throw new Error('invalid desk event journal record type');
}

function parseCheckpointRecord(
  record: Record<string, unknown>,
  common: {
    recordVersion: typeof JOURNAL_RECORD_VERSION;
    journalSeq: number;
  }
): CheckpointRecord {
  if (
    !isNonNegativeSafeInteger(record.eventSeq) ||
    !Array.isArray(record.retainedEvents) ||
    !Array.isArray(record.transitions) ||
    !Array.isArray(record.channelReceipts) ||
    !Array.isArray(record.readIds) ||
    !isNonNegativeSafeInteger(record.readAllThrough) ||
    !Array.isArray(record.kindReadThrough) ||
    !isNonNegativeSafeInteger(record.clearedThrough) ||
    record.readAllThrough > record.eventSeq ||
    record.clearedThrough > record.eventSeq
  ) {
    throw new Error('invalid desk event checkpoint');
  }

  const retainedEvents = record.retainedEvents.map(parseRetainedEventRecord);
  let previousSeq: number | undefined;
  const retainedIds = new Set<string>();
  for (const retained of retainedEvents) {
    const { event } = retained;
    if (
      event.read ||
      event.seq > record.eventSeq ||
      event.seq <= record.clearedThrough ||
      retainedIds.has(event.id) ||
      (previousSeq !== undefined && event.seq !== previousSeq + 1)
    ) {
      throw new Error('invalid desk event checkpoint feed');
    }
    retainedIds.add(event.id);
    previousSeq = event.seq;
  }
  if (
    retainedEvents.length > 0 &&
    retainedEvents[retainedEvents.length - 1]!.event.seq !== record.eventSeq
  ) {
    throw new Error('invalid desk event checkpoint tail');
  }

  const transitions = record.transitions.map(parseTransition);
  const channelReceipts = record.channelReceipts.map(
    parseCheckpointChannelReceipt
  );
  const receiptKeys = new Set<string>();
  for (const receipt of channelReceipts) {
    if (
      receipt.event.seq > record.eventSeq ||
      receiptKeys.has(receipt.dedupeKey)
    ) {
      throw new Error('invalid desk event checkpoint receipt');
    }
    receiptKeys.add(receipt.dedupeKey);
  }

  const readIds: string[] = [];
  const readIdSet = new Set<string>();
  for (const id of record.readIds) {
    if (
      typeof id !== 'string' ||
      !retainedIds.has(id) ||
      readIdSet.has(id)
    ) {
      throw new Error('invalid desk event checkpoint read id');
    }
    readIdSet.add(id);
    readIds.push(id);
  }

  const kindReadThrough: Array<{
    kind: DeskEventKind;
    throughSeq: number;
  }> = [];
  const readKinds = new Set<DeskEventKind>();
  for (const item of record.kindReadThrough) {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item)
    ) {
      throw new Error('invalid desk event checkpoint kind read');
    }
    const candidate = item as Record<string, unknown>;
    if (
      !isDeskEventKind(candidate.kind) ||
      !isNonNegativeSafeInteger(candidate.throughSeq) ||
      candidate.throughSeq > record.eventSeq ||
      readKinds.has(candidate.kind)
    ) {
      throw new Error('invalid desk event checkpoint kind read');
    }
    readKinds.add(candidate.kind);
    kindReadThrough.push({
      kind: candidate.kind,
      throughSeq: candidate.throughSeq
    });
  }

  return {
    ...common,
    type: 'checkpoint',
    eventSeq: record.eventSeq,
    retainedEvents,
    transitions,
    channelReceipts,
    readIds,
    readAllThrough: record.readAllThrough,
    kindReadThrough,
    clearedThrough: record.clearedThrough
  };
}

function parseRetainedEventRecord(input: unknown): RetainedEventRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid retained desk event');
  }
  const record = input as Record<string, unknown>;
  const event = parseDeskEvent(record.event);
  if (event.read) throw new Error('invalid retained desk event read state');
  if (
    typeof record.source !== 'object' ||
    record.source === null ||
    Array.isArray(record.source)
  ) {
    throw new Error('invalid retained desk event source');
  }
  const source = record.source as Record<string, unknown>;
  if (source.type === 'transition') {
    const transition = parseTransition(source.transition);
    if (!isNonNegativeSafeInteger(source.projectionIndex)) {
      throw new Error('invalid retained desk event projection index');
    }
    const projected = projectTransitionToDeskEvents(transition);
    const draft = projected[source.projectionIndex];
    if (draft === undefined) {
      throw new Error('invalid retained desk event projection index');
    }
    const expected = parseDeskEvent({
      ...draft,
      id: `desk-event-${event.seq}`,
      seq: event.seq,
      read: false
    });
    if (!isDeepStrictEqual(event, expected)) {
      throw new Error('desk event checkpoint projection mismatch');
    }
    return {
      event,
      source: {
        type: 'transition',
        transition,
        projectionIndex: source.projectionIndex
      }
    };
  }
  if (source.type === 'channel') {
    const parsedInput = parseChannelMessageDeskEventInput(source.input);
    const expected = channelEventFromInput(parsedInput, event);
    if (event.kind !== 'channel-message' || !isDeepStrictEqual(event, expected)) {
      throw new Error('desk event checkpoint channel mismatch');
    }
    return {
      event,
      source: { type: 'channel', input: parsedInput }
    };
  }
  throw new Error('invalid retained desk event source type');
}

function parseCheckpointChannelReceipt(
  input: unknown
): CheckpointChannelReceipt {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid desk event checkpoint receipt');
  }
  const record = input as Record<string, unknown>;
  const event = parseDeskEvent(record.event);
  if (event.kind !== 'channel-message' || event.read) {
    throw new Error('invalid desk event checkpoint receipt');
  }
  const parsedInput = channelInputFromEvent(event);
  const dedupeKey = channelDedupeKey(parsedInput);
  const fingerprint = JSON.stringify(parsedInput);
  if (
    record.dedupeKey !== dedupeKey ||
    record.fingerprint !== fingerprint
  ) {
    throw new Error('invalid desk event checkpoint receipt binding');
  }
  return { dedupeKey, fingerprint, event };
}

function channelInputFromEvent(
  event: Extract<DeskEvent, { kind: 'channel-message' }>
): ChannelMessageDeskEventInput {
  return parseChannelMessageDeskEventInput({
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    channel: event.channel,
    messageId: event.messageId,
    ...(event.thread === undefined ? {} : { thread: event.thread }),
    author: event.author,
    mentionsOperator: event.mentionsOperator,
    message: event.message
  });
}

function channelEventFromInput(
  input: ChannelMessageDeskEventInput,
  identity: DeskEvent
): DeskEvent {
  return parseDeskEvent({
    schemaVersion: DESK_EVENT_SCHEMA_VERSION,
    id: `desk-event-${identity.seq}`,
    seq: identity.seq,
    at: identity.at,
    read: false,
    kind: 'channel-message',
    ...input
  });
}

function positiveOption(
  input: number | undefined,
  fallback: number,
  name: string
): number {
  if (input === undefined) return fallback;
  if (!Number.isSafeInteger(input) || input <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return input;
}

function writeFully(fd: number, bytes: Buffer, noProgressMessage: string): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error(noProgressMessage);
    offset += written;
  }
}

function atomicReplace(path: string, bytes: Buffer): void {
  const tempPath = uniqueSiblingPath(
    `${path}.tmp-${process.pid}-${Date.now()}`
  );
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFully(fd, bytes, 'durable desk event checkpoint made no progress');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function uniqueQuarantinePath(path: string, now: number): string {
  const timestamp =
    Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  return uniqueSiblingPath(
    `${path}.corrupt-${timestamp}-${process.pid}`
  );
}

function uniqueSiblingPath(base: string): string {
  if (!existsSync(base)) return base;
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate unique sibling path for ${base}`);
}

function isTransitionCause(
  input: unknown
): input is SessionStateTransitionCause {
  return (
    typeof input === 'string' &&
    Object.prototype.hasOwnProperty.call(TRANSITION_CAUSES, input)
  );
}

function isDeskEventKind(input: unknown): input is DeskEventKind {
  return (
    typeof input === 'string' &&
    (DESK_EVENT_KINDS as readonly string[]).includes(input)
  );
}

function isPositiveSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) > 0;
}

function isNonNegativeSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}
