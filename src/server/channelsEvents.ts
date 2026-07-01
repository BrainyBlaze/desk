import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsOps.js';
import type { SubmitState, LifecycleStatus } from './channelsProtocol.js';

/**
 * Channels delivery-history events ring. Engine-internal durable record
 * of every delivery-lifecycle state transition, consumed by the timeline UI
 * to reconstruct what happened across restarts.
 *
 * File layout: `<home>/_engine/events.jsonl` — one JSON object per line,
 * appended atomically per write via O_APPEND (POSIX). The ring is bounded:
 * entries beyond MAX_EVENTS are pruned by a periodic rewrite (writeFileAtomic).
 *
 * CONCURRENCY INVARIANT: the append path is a pure append (no read-modify-write),
 * so there is no lost-update race. The prune path IS a sync RMW (read → filter →
 * writeFileAtomic), but the engine is the sole writer (single process, event-
 * loop-serialized sync blocks), so concurrent RMW cannot occur. Do NOT add a
 * lock — this uses the same single-writer invariant as the user-workspace stores. If you
 * ever introduce an `await` inside the prune path, the invariant breaks → add
 * a lock THEN.
 *
 * Cross-lane: the engine (channelsEngine.ts) calls `appendDeliveryEvent` on
 * every state transition. The API (channelsApi.ts) exposes `readDeliveryEvents`
 * via an endpoint. The UI (ChannelsSubsystem) renders the timeline.
 */

const EVENTS_FILE = 'events.jsonl';
const MAX_EVENTS = 10_000;
const EVENTS_DIR = '_engine';
const PREVIEW_MAX_BYTES = 200;

/** In-memory seq cache: avoids O(file) readFileSync on every append.
 *  Re-initialized lazily from the file on first access after boot. */
let cachedSeq = 0;
let cachedHome: string | null = null;

/**
 * Delivery event kind — derived from the frozen protocol unions where they
 * overlap, plus event-log-specific kinds that have no protocol equivalent.
 *
 * SINGLE-SOURCE: the stuck terminals, active submit states, and paused status
 * are EXTRACTED from the frozen SubmitState / LifecycleStatus unions so a
 * protocol change automatically flows into the event-log type. The
 * 'approval-requested' / 'input-requested' values match AgentSignalKind
 * (channelsEngine.ts) but are kept local because importing from the engine
 * would create a circular dependency once the engine wires appendDeliveryEvent.
 * If AgentSignalKind is ever promoted to channelsProtocol.ts, derive those too.
 */
type StuckTerminal = Extract<SubmitState, `submit-stuck-${string}`>;
type SubmitActive = Extract<SubmitState, 'delivering' | 'submitted' | 'delivery-ack-timeout'>;
type PausedStatus = Extract<LifecycleStatus, 'paused'>;

export type DeliveryEventKind =
  | SubmitActive       // 'delivering' | 'submitted' | 'delivery-ack-timeout' — from SubmitState
  | StuckTerminal      // 'submit-stuck-paste' | 'submit-stuck-submit' | 'submit-stuck-unobservable' — from SubmitState
  | PausedStatus       // 'paused' — from LifecycleStatus
  | 'queued'           // -specific: item entered the queue
  | 'released'         // -specific: agent released (signal-driven)
  | 'resumed'          // -specific: operator resumed
  | 'dropped'          // -specific: item dropped (operator or overflow)
  | 'input-requested'  // matches AgentSignalKind (local to avoid circular import)
  | 'approval-requested'; // matches AgentSignalKind (local to avoid circular import)

export interface DeliveryEvent {
  seq: number;
  at: string;
  tmuxSession?: string;
  channel?: string;
  messageId?: string;
  kind: DeliveryEventKind;
  from?: string;
  to?: string;
  reason?: string;
  preview?: string;
}

export interface DeliveryEventFilter {
  tmuxSession?: string;
  channel?: string;
  sinceSeq?: number;
  kind?: DeliveryEventKind;
  limit?: number;
}

function eventsDir(home: string): string {
  return join(home, EVENTS_DIR);
}

function eventsPath(home: string): string {
  return join(eventsDir(home), EVENTS_FILE);
}

/**
 * Appends a single delivery event. The `seq` is auto-assigned from the current
 * file's line count + 1; `at` defaults to now. Sync, atomic per-line.
 */
export function appendDeliveryEvent(
  home: string,
  event: Omit<DeliveryEvent, 'seq' | 'at'> & { at?: string },
  now = new Date()
): DeliveryEvent {
  mkdirSync(eventsDir(home), { recursive: true });
  const seq = nextSeq(home);
  const preview = event.preview !== undefined
    ? Buffer.byteLength(event.preview, 'utf8') > PREVIEW_MAX_BYTES
      ? `${event.preview.slice(0, PREVIEW_MAX_BYTES)}…`
      : event.preview
    : undefined;
  const full: DeliveryEvent = { ...event, seq, at: event.at ?? now.toISOString(), preview };
  appendFileSync(eventsPath(home), `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

function nextSeq(home: string): number {
  if (cachedHome === home && cachedSeq > 0) {
    cachedSeq += 1;
    return cachedSeq;
  }
  const path = eventsPath(home);
  if (!existsSync(path)) {
    cachedHome = home;
    cachedSeq = 1;
    return 1;
  }
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      cachedHome = home;
      cachedSeq = 1;
      return 1;
    }
    const last = JSON.parse(lines[lines.length - 1]!) as Partial<DeliveryEvent>;
    cachedHome = home;
    cachedSeq = (Number.isFinite(last.seq) ? last.seq! : 0) + 1;
    return cachedSeq;
  } catch {
    cachedHome = home;
    cachedSeq = 1;
    return 1;
  }
}

/**
 * Reads delivery events matching the optional filter. Returns events in
 * chronological order (oldest first). Falls back to [] on corrupt file.
 */
export function readDeliveryEvents(home: string, filter: DeliveryEventFilter = {}): DeliveryEvent[] {
  const path = eventsPath(home);
  if (!existsSync(path)) {
    return [];
  }
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
  const events: DeliveryEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: DeliveryEvent;
    try {
      parsed = JSON.parse(trimmed) as DeliveryEvent;
    } catch {
      continue; // skip corrupt lines
    }
    if (typeof parsed.seq !== 'number' || typeof parsed.kind !== 'string') {
      continue;
    }
    if (filter.tmuxSession && parsed.tmuxSession !== filter.tmuxSession) {
      continue;
    }
    if (filter.channel && parsed.channel !== filter.channel) {
      continue;
    }
    if (filter.kind && parsed.kind !== filter.kind) {
      continue;
    }
    if (filter.sinceSeq !== undefined && parsed.seq <= filter.sinceSeq) {
      continue;
    }
    events.push(parsed);
  }
  if (filter.limit !== undefined && events.length > filter.limit) {
    return events.slice(-filter.limit);
  }
  return events;
}

/**
 * Prunes the events ring to at most `maxEvents` entries (keeping the newest).
 * Sync RMW via writeFileAtomic. Called periodically when the file grows past
 * the cap. Returns the number of events pruned.
 */
export function pruneDeliveryEvents(home: string, maxEvents = MAX_EVENTS): number {
  const path = eventsPath(home);
  if (!existsSync(path)) {
    return 0;
  }
  const events = readDeliveryEvents(home);
  if (events.length <= maxEvents) {
    return 0;
  }
  const kept = events.slice(-maxEvents);
  const content = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileAtomic(path, content);
  return events.length - kept.length;
}

/** The current maximum seq in the ring (0 if empty). */
export function latestEventSeq(home: string): number {
  const events = readDeliveryEvents(home);
  return events.length > 0 ? events[events.length - 1]!.seq : 0;
}
