import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32c } from '../../shared/moorWire/crc32c.js';

export enum MoorStoreKind {
  Event = 1,
  Log = 2,
  Exit = 3
}

export type MoorStoreErrorCode =
  | 'CORRUPT'
  | 'UNAVAILABLE'
  | 'GENERATION_MISMATCH'
  | 'COMPACTION_GAP'
  | 'CURSOR_AHEAD';

export class MoorStoreError extends Error {
  constructor(
    readonly code: MoorStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'MoorStoreError';
  }
}

export interface MoorCommit {
  readonly slot: 0 | 1;
  readonly bodySlot: 0 | 1;
  readonly kind: MoorStoreKind;
  readonly generation: number;
  readonly epoch: number;
  readonly index: bigint;
  readonly length: bigint;
  readonly start: bigint;
  readonly end: bigint;
  readonly hash: Uint8Array;
}

export interface MoorStoreSnapshot {
  readonly commit: MoorCommit;
  readonly bytes: Uint8Array;
}

export interface MoorEventRecord {
  readonly type: string;
  readonly epoch: number;
  readonly sequence: bigint;
  readonly kind: 'transition' | 'snapshot';
  readonly value: Readonly<Record<string, unknown>>;
}

export interface MoorEventSnapshot {
  /** The header's canonical session identity (§1.2 tagged bytes). */
  readonly sessionIdentity: Uint8Array;
  readonly generation: number;
  readonly epoch: number;
  readonly firstRetained: bigint;
  readonly nextSequence: bigint;
  readonly commitIndex: bigint;
  readonly commitHash: Uint8Array;
  readonly records: readonly MoorEventRecord[];
  readonly streamExhausted: boolean;
}

export interface MoorEventCursor {
  readonly generation: number;
  readonly epoch: number;
  readonly nextSequence: bigint;
  readonly commitIndex: bigint;
  readonly commitHash: Uint8Array;
}

export interface MoorEventCursorResult {
  readonly events: readonly MoorEventRecord[];
  readonly cursor: MoorEventCursor;
  readonly streamExhausted: boolean;
}

const SLOT_NAMES = ['body.0', 'body.1', 'commit.0', 'commit.1'] as const;
const EVENT_LIMIT = 320 << 10;
const EVENT_SOFT_CAP = 256 << 10;
const EXIT_LIMIT = 4 << 20;
const EVENT_END = 1n << 53n;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const decoder = new TextDecoder('utf-8', { fatal: true });
const UNAVAILABLE_ERRNO_CODES = new Set([
  'EACCES',
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'EPERM',
  'ESTALE',
  'ETIMEDOUT'
]);

interface CandidateRead {
  readonly candidate?: MoorStoreSnapshot;
  readonly generationMismatch: boolean;
  readonly unavailable?: boolean;
}

const EVENT_SCHEMAS: Readonly<Record<string, string>> = {
  ready: 'type:=ready,ts:*,epoch:u,seq:*,kind:=transition/snapshot',
  state:
    'type:=state,ts:*,epoch:u,seq:*,kind:=transition/snapshot,state:=idle/busy,title:t255,truncated:?',
  link:
    'type:=link,ts:*,epoch:u,seq:*,kind:=transition/snapshot,uri:t2048,truncated:?',
  'semantic-source':
    'type:=semantic-source,ts:*,epoch:u,seq:*,kind:=transition/snapshot,source:s,producer:b16,source_epoch:p,status:=connected,reason:=|type:=semantic-source,ts:*,epoch:u,seq:*,kind:=transition/snapshot,source:s,producer:b16,source_epoch:p,status:=exact,reason:=|type:=semantic-source,ts:*,epoch:u,seq:*,kind:=transition/snapshot,source:s,producer:b16,source_epoch:p,status:=degraded,reason:=heartbeat-timeout|type:=semantic-source,ts:*,epoch:u,seq:*,kind:=transition/snapshot,source:s,producer:b16,source_epoch:p,status:=disconnected,reason:=transport-closed/superseded/session-ending',
  'semantic-assertion':
    'type:=semantic-assertion,ts:*,epoch:u,seq:*,kind:=transition,source:s,producer:b16,source_epoch:p,source_seq:d,event_id:b16,assertion_kind:=transition,payload:j|type:=semantic-assertion,ts:*,epoch:u,seq:*,kind:=snapshot,source:s,producer:b16,source_epoch:p,source_seq:d,event_id:b16,assertion_kind:=snapshot,payload:j',
  'application-receipt':
    'type:=application-receipt,ts:*,epoch:u,seq:*,kind:=transition,source:s,producer:b16,source_epoch:p,source_seq:d,event_id:b16,application_request_id:b16,lease_epoch:p,request_id:d,status:=accepted/refused,provider_session:b4096,provider_turn:b4096',
  'application-receipt-missing':
    'type:=application-receipt-missing,ts:*,epoch:u,seq:*,kind:=transition,source:s,producer:b16,source_epoch:p,application_request_id:b16,lease_epoch:p,request_id:d,reason:=deadline/source-lost/retention-expired',
  'stream-exhausted':
    'type:=stream-exhausted,ts:*,epoch:u,seq:*,kind:=transition,axis:=seq/epoch/commit',
  exit:
    'type:=exit,ts:*,epoch:u,seq:*,kind:=transition,ended:=exited,code:u|type:=exit,ts:*,epoch:u,seq:*,kind:=transition,ended:=signalled,signal:p|type:=exit,ts:*,epoch:u,seq:*,kind:=transition,ended:=terminated,code:u,method:=graceful/forced',
  'observer-degraded':
    'type:=observer-degraded,ts:*,epoch:u,seq:*,kind:=transition,scanner:=osc/query,reason:=deadline/limit/cancelled/malformed'
};

const LIFECYCLE_BASE =
  'v:1,type:=lifecycle,phase:t,session:*,generation:*,wire_generation:u,incarnation:b16,start_wall_ms:D,start_mono_ms:D,boot_id:b16,path_encoding:=posix-bytes/windows-wtf8,event_path:n,instrument_path:n';
const LIFECYCLE_END =
  '|end_wall_ms:D,output_end:D,ended:=exited,code:u|end_wall_ms:D,output_end:D,ended:=signalled,signal:p|end_wall_ms:D,output_end:D,ended:=terminated,code:u,method:=graceful/forced';

export async function readMoorStoreSnapshot(
  directory: string,
  kind: MoorStoreKind,
  expectedGeneration?: number
): Promise<MoorStoreSnapshot> {
  assertKind(kind);
  if (
    expectedGeneration !== undefined &&
    (!Number.isInteger(expectedGeneration) || expectedGeneration <= 0 || expectedGeneration > 0xffff_ffff)
  ) {
    throw new MoorStoreError('GENERATION_MISMATCH', 'expected generation is out of range');
  }

  let directoryHandle: FileHandle | undefined;
  const slots: FileHandle[] = [];
  try {
    const directoryFlags =
      constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0);
    directoryHandle = await open(directory, directoryFlags);
    const [pathDirectory, openedDirectory] = await Promise.all([
      lstat(directory),
      directoryHandle.stat()
    ]);
    requireProtected(pathDirectory, 0o700, true);
    requireSameFile(pathDirectory, openedDirectory);

    const entries = await readdir(directory);
    if (
      entries.length !== SLOT_NAMES.length ||
      SLOT_NAMES.some((name) => !entries.includes(name)) ||
      entries.some((name) => !SLOT_NAMES.includes(name as (typeof SLOT_NAMES)[number]))
    ) {
      corrupt('store directory must contain exactly four slots');
    }

    const slotFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    for (const name of SLOT_NAMES) slots.push(await open(join(directory, name), slotFlags));
    for (let index = 0; index < SLOT_NAMES.length; index += 1) {
      const path = join(directory, SLOT_NAMES[index]!);
      const [pathMetadata, handleMetadata] = await Promise.all([lstat(path), slots[index]!.stat()]);
      requireProtected(pathMetadata, 0o600, false);
      requireSameFile(pathMetadata, handleMetadata);
    }

    const reads = await Promise.all([
      readCandidate(slots, 0, kind, expectedGeneration),
      readCandidate(slots, 1, kind, expectedGeneration)
    ]);
    const candidates = reads.flatMap((read) => (read.candidate === undefined ? [] : [read.candidate]));
    if (candidates.length === 0) {
      if (reads.some((read) => read.unavailable)) {
        throw new MoorStoreError('UNAVAILABLE', 'Moor store is temporarily unreadable');
      }
      if (reads.some((read) => read.generationMismatch)) {
        throw new MoorStoreError(
          'GENERATION_MISMATCH',
          `store has no valid generation ${expectedGeneration}`
        );
      }
      corrupt('store has no valid commit candidate');
    }
    if (candidates.length === 2) {
      const [left, right] = candidates as [MoorStoreSnapshot, MoorStoreSnapshot];
      if (
        left.commit.index === right.commit.index ||
        left.commit.generation !== right.commit.generation
      ) {
        corrupt('valid store candidates conflict');
      }
      return copySnapshot(left.commit.index > right.commit.index ? left : right);
    }
    return copySnapshot(candidates[0]!);
  } catch (error) {
    if (error instanceof MoorStoreError) throw error;
    const code = errnoCode(error);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new MoorStoreError('CORRUPT', 'Moor store path violates the filesystem trust boundary', {
        cause: error
      });
    }
    if (code !== undefined && UNAVAILABLE_ERRNO_CODES.has(code)) {
      throw new MoorStoreError('UNAVAILABLE', 'failed to read Moor store', {
        cause: error
      });
    }
    throw new MoorStoreError('CORRUPT', 'failed to validate Moor store', { cause: error });
  } finally {
    await Promise.allSettled([...slots, ...(directoryHandle === undefined ? [] : [directoryHandle])].map((file) => file.close()));
  }
}

export function decodeMoorEventSnapshot(
  body: Uint8Array,
  commit: MoorCommit
): MoorEventSnapshot {
  try {
    if (
      commit.kind !== MoorStoreKind.Event ||
      BigInt(body.length) !== commit.length ||
      !equal(sha256(body), commit.hash)
    ) {
      corrupt('event body does not match its commit');
    }
    const text = decoder.decode(body);
    if (!text.endsWith('\n')) corrupt('event body must end with a newline');
    const lines = text.slice(0, -1).split('\n');
    if (lines.length === 0 || lines[0] === '') corrupt('event body has no header');

    const header = canonicalObject(lines[0]!, 16);
    const headerKeys = [
      'v',
      'type',
      'ts',
      'session',
      'generation',
      'epoch',
      'next_seq',
      'first_retained'
    ];
    if (!sameKeys(header, headerKeys) || header.v !== 2 || header.type !== 'header') {
      corrupt('invalid event header shape');
    }
    const identity = strictBase64(asString(header.session));
    const identityValid =
      (identity.length >= 2 && identity[0] === 1 && identity[1] === 0x2f) ||
      (identity.length === 25 && identity[0] === 2);
    const generationValid =
      commit.generation === 1
        ? header.generation === null
        : header.generation === commit.generation;
    const epoch = safeU32(header.epoch);
    const nextSequence = safeEventInteger(header.next_seq);
    const firstRetained = safeEventInteger(header.first_retained);
    if (
      !identityValid ||
      !generationValid ||
      epoch !== commit.epoch ||
      firstRetained > nextSequence ||
      nextSequence > EVENT_END ||
      firstRetained !== commit.start ||
      nextSequence !== commit.end
    ) {
      corrupt('event header does not match its commit');
    }

    const records: MoorEventRecord[] = [];
    let sequence = firstRetained;
    let transitions = 0n;
    let lastFlags = 0;
    let retained = false;
    for (const line of lines.slice(1)) {
      if (line === '' || (lastFlags & 2) !== 0) corrupt('invalid records after event frontier');
      const value = canonicalObject(line, 32);
      const type = asString(value.type);
      const schema = EVENT_SCHEMAS[type];
      if (schema === undefined || !matchesSchema(value, schema)) corrupt('invalid event record shape');
      const recordEpoch = safeU32(value.epoch);
      const recordSequence = safeEventInteger(value.seq);
      const recordKind = value.kind;
      if (
        recordEpoch !== epoch ||
        recordSequence !== sequence ||
        sequence >= EVENT_END ||
        (recordKind !== 'transition' && recordKind !== 'snapshot')
      ) {
        corrupt('event sequence is not contiguous');
      }
      const snapshot = recordKind === 'snapshot';
      const assertionSnapshot = value.assertion_kind === 'snapshot';
      const flags =
        Number(snapshot) |
        Number(type === 'stream-exhausted') * 2 |
        Number(type === 'semantic-source' || (type === 'semantic-assertion' && assertionSnapshot)) * 4 |
        Number(type === 'stream-exhausted' && value.axis === 'seq') * 8 |
        Number(type === 'stream-exhausted' && value.axis === 'epoch') * 16 |
        Number(type === 'stream-exhausted' && value.axis === 'commit') * 32;
      if (snapshot) {
        if (transitions !== 0n) corrupt('snapshot followed a transition');
      } else {
        transitions += 1n;
        lastFlags = flags;
        retained ||= (flags & 4) !== 0;
      }
      records.push(
        Object.freeze({
          type,
          epoch,
          sequence,
          kind: recordKind,
          value: Object.freeze(value)
        })
      );
      sequence += 1n;
    }

    const overage =
      (lastFlags & 2) !== 0 || (epoch !== 0 && !retained && transitions === 1n);
    const frontier =
      (lastFlags & 0x38) === 8
        ? nextSequence <= EVENT_END
        : (lastFlags & 0x38) === 16
          ? epoch === 0xffff_ffff && nextSequence < EVENT_END
          : (lastFlags & 0x38) === 32
            ? commit.index === U64_MAX && nextSequence < EVENT_END
            : (lastFlags & 0x38) === 0 && nextSequence < EVENT_END;
    if (
      sequence !== nextSequence ||
      (body.length - 1 >= EVENT_SOFT_CAP && !overage) ||
      !frontier
    ) {
      corrupt('invalid event body frontier');
    }
    return Object.freeze({
      sessionIdentity: identity,
      generation: commit.generation,
      epoch,
      firstRetained,
      nextSequence,
      commitIndex: commit.index,
      commitHash: commit.hash.slice(),
      records: Object.freeze(records.slice()),
      streamExhausted: (lastFlags & 2) !== 0
    });
  } catch (error) {
    if (error instanceof MoorStoreError) throw error;
    throw new MoorStoreError('CORRUPT', 'invalid Moor event snapshot', { cause: error });
  }
}

export function eventsAfterMoorCursor(
  snapshot: MoorEventSnapshot,
  cursor?: MoorEventCursor
): MoorEventCursorResult {
  if (cursor !== undefined) {
    if (snapshot.generation !== cursor.generation) {
      throw new MoorStoreError('GENERATION_MISMATCH', 'event generation changed');
    }
    if (snapshot.epoch < cursor.epoch) {
      throw new MoorStoreError('CORRUPT', 'event epoch rolled back');
    }
    if (snapshot.commitIndex < cursor.commitIndex) {
      throw new MoorStoreError('CORRUPT', 'event commit index rolled back');
    }
    if (snapshot.commitIndex === cursor.commitIndex) {
      if (!equal(snapshot.commitHash, cursor.commitHash)) {
        throw new MoorStoreError('CORRUPT', 'same event commit index has a different hash');
      }
      return {
        events: Object.freeze([]),
        cursor: copyCursor(cursor),
        streamExhausted: snapshot.streamExhausted
      };
    }
    if (cursor.nextSequence < snapshot.firstRetained) {
      throw new MoorStoreError('COMPACTION_GAP', 'unread events were compacted');
    }
    if (cursor.nextSequence > snapshot.nextSequence) {
      throw new MoorStoreError('CURSOR_AHEAD', 'event cursor is ahead of the selected store');
    }
  }

  const first = cursor?.nextSequence ?? snapshot.firstRetained;
  const events = snapshot.records.filter(
    (record) => record.sequence >= first && record.sequence < snapshot.nextSequence
  );
  return {
    events: Object.freeze(events.slice()),
    cursor: {
      generation: snapshot.generation,
      epoch: snapshot.epoch,
      nextSequence: snapshot.nextSequence,
      commitIndex: snapshot.commitIndex,
      commitHash: snapshot.commitHash.slice()
    },
    streamExhausted: snapshot.streamExhausted
  };
}

async function readCandidate(
  slots: readonly FileHandle[],
  slot: 0 | 1,
  kind: MoorStoreKind,
  expectedGeneration?: number
): Promise<CandidateRead> {
  try {
    const commitFile = slots[2 + slot]!;
    if ((await commitFile.stat()).size !== 92) return { generationMismatch: false };
    const record = await readExact(commitFile, 92);
    const commit = decodeCommit(record, slot, kind);
    if (commit === undefined) return { generationMismatch: false };
    const length = exactAllocationLength(commit.length);
    const bytes = await readExact(slots[commit.bodySlot]!, length);
    if (!equal(sha256(bytes), commit.hash) || !bodyValid(commit, bytes)) {
      return { generationMismatch: false };
    }
    if (expectedGeneration !== undefined && commit.generation !== expectedGeneration) {
      return { generationMismatch: true };
    }
    return {
      candidate: { commit: copyCommit(commit), bytes: bytes.slice() },
      generationMismatch: false
    };
  } catch (error) {
    const code = errnoCode(error);
    return {
      generationMismatch: false,
      unavailable:
        (error instanceof MoorStoreError && error.code === 'UNAVAILABLE') ||
        (code !== undefined && UNAVAILABLE_ERRNO_CODES.has(code))
    };
  }
}

function decodeCommit(
  bytes: Uint8Array,
  slot: 0 | 1,
  kind: MoorStoreKind
): MoorCommit | undefined {
  if (bytes.length !== 92) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bodySlot = view.getUint8(10);
  const generation = view.getUint32(12, true);
  const epoch = view.getUint32(16, true);
  const index = view.getBigUint64(24, true);
  const length = view.getBigUint64(32, true);
  const start = view.getBigUint64(40, true);
  const end = view.getBigUint64(48, true);
  const validLength =
    kind === MoorStoreKind.Event
      ? length <= BigInt(EVENT_LIMIT)
      : kind === MoorStoreKind.Exit
        ? length <= BigInt(EXIT_LIMIT)
        : true;
  if (
    !equal(bytes.subarray(0, 9), Uint8Array.of(0x4d, 0x4f, 0x4f, 0x52, 0x43, 0x4d, 0x54, 0x31, 1)) ||
    bytes[9] !== slot ||
    bodySlot > 1 ||
    bytes[11] !== kind ||
    generation === 0 ||
    !isZero(bytes.subarray(20, 24)) ||
    index === 0n ||
    start > end ||
    !validLength ||
    view.getUint32(88, true) !== crc32c(bytes.subarray(0, 88))
  ) {
    return undefined;
  }
  return {
    slot,
    bodySlot: bodySlot as 0 | 1,
    kind,
    generation,
    epoch,
    index,
    length,
    start,
    end,
    hash: bytes.slice(56, 88)
  };
}

function bodyValid(commit: MoorCommit, bytes: Uint8Array): boolean {
  try {
    if (commit.kind === MoorStoreKind.Event) {
      decodeMoorEventSnapshot(bytes, commit);
      return true;
    }
    if (commit.kind === MoorStoreKind.Log) {
      return commit.epoch !== 0 && commit.end - commit.start === BigInt(bytes.length);
    }
    return validLifecycle(bytes, commit);
  } catch {
    return false;
  }
}

function validLifecycle(bytes: Uint8Array, commit: MoorCommit): boolean {
  if (!decoder.decode(bytes).endsWith('\n') || commit.epoch !== 1 || commit.index > 2n || commit.start !== commit.end) {
    return false;
  }
  const text = decoder.decode(bytes);
  const line = text.slice(0, -1);
  if (line.includes('\n')) return false;
  const value = canonicalObject(line, 20);
  const keys = Object.keys(value);
  if (keys.length < 13 || !matchesSchemaRange(value, LIFECYCLE_BASE, 0, 13)) return false;
  if (!matchesSchemaRange(value, LIFECYCLE_END, 13, keys.length)) return false;
  const encoding = value.path_encoding;
  const session = strictBase64(asString(value.session));
  const sessionValid =
    encoding === 'posix-bytes'
      ? session.length >= 2 && session[0] === 1 && session[1] === 0x2f
      : encoding === 'windows-wtf8' && session.length === 25 && session[0] === 2;
  const generationValid =
    commit.generation === 1 ? value.generation === null : value.generation === commit.generation;
  if (!sessionValid || !generationValid || value.wire_generation !== commit.generation) return false;
  const outputEnd = typeof value.output_end === 'string' ? decimal(value.output_end) : undefined;
  const closed = commit.index === 2n && outputEnd === commit.end;
  if (value.phase === 'running' && value.ended === undefined) {
    return keys.length === 13 && commit.index === 1n && commit.start === 0n && commit.end === 0n;
  }
  if (value.phase !== 'exited') return false;
  if (value.ended === 'exited') {
    return closed && safeU32(value.code) <= (encoding === 'windows-wtf8' ? 0xffff_ffff : 255);
  }
  if (value.ended === 'signalled') return closed && encoding === 'posix-bytes';
  if (value.ended === 'terminated') return closed && encoding === 'windows-wtf8';
  return false;
}

function canonicalObject(line: string, maximumMembers: number): Record<string, unknown> {
  const match = /(?:^|,)"ts":([^,}]+)/u.exec(line);
  if (match === null || !validTimestamp(match[1]!)) corrupt('invalid canonical timestamp');
  const valueStart = match.index + match[0].lastIndexOf(':') + 1;
  const normalized = `${line.slice(0, valueStart)}0${line.slice(valueStart + match[1]!.length)}`;
  const parsed = JSON.parse(normalized) as unknown;
  if (!isObject(parsed) || Object.keys(parsed).length > maximumMembers) {
    corrupt('JSON record is not a bounded object');
  }
  const encoded = uppercaseEscapes(JSON.stringify(parsed));
  if (encoded !== normalized) corrupt('JSON record is not canonical');
  const actual = JSON.parse(line) as unknown;
  if (!isObject(actual)) corrupt('JSON record is not an object');
  return actual;
}

function matchesSchema(value: Record<string, unknown>, schema: string): boolean {
  return schema.split('|').some((choice) => schemaChoice(value, choice, 0, Object.keys(value).length));
}

function matchesSchemaRange(
  value: Record<string, unknown>,
  schema: string,
  start: number,
  end: number
): boolean {
  return schema.split('|').some((choice) => schemaChoice(value, choice, start, end));
}

function schemaChoice(
  value: Record<string, unknown>,
  choice: string,
  start: number,
  end: number
): boolean {
  const rules = choice.split(',').filter(Boolean);
  const entries = Object.entries(value).slice(start, end);
  return (
    rules.length === entries.length &&
    entries.every(([key, field], index) => {
      const rule = rules[index]?.split(/:(.*)/su);
      return rule !== undefined && rule[0] === key && validateField(rule[1] ?? '', field);
    })
  );
}

function validateField(rule: string, value: unknown): boolean {
  if (rule.startsWith('=')) {
    return typeof value === 'string' && rule.slice(1).split('/').includes(value);
  }
  switch (rule) {
    case '*':
      return true;
    case '1':
      return value === 1;
    case '2':
      return value === 2;
    case '?':
      return typeof value === 'boolean';
    case 't':
      return typeof value === 'string';
    case 'u':
      return isU32(value, false);
    case 'p':
      return isU32(value, true);
    case 'd':
      return typeof value === 'string' && decimal(value) !== undefined && decimal(value) !== 0n;
    case 'D':
      return typeof value === 'string' && decimal(value) !== undefined;
    case 's':
      return typeof value === 'string' && validSourceId(value);
    case 'b16':
      return typeof value === 'string' && strictBase64OrUndefined(value)?.length === 16;
    case 'b4096': {
      const decoded = typeof value === 'string' ? strictBase64OrUndefined(value) : undefined;
      return decoded !== undefined && decoded.length <= 4096;
    }
    case 'n': {
      if (value === null) return true;
      const decoded = typeof value === 'string' ? strictBase64OrUndefined(value) : undefined;
      return decoded !== undefined && decoded.length !== 0;
    }
    case 'j': {
      const decoded = typeof value === 'string' ? strictBase64OrUndefined(value) : undefined;
      return decoded !== undefined && decoded.length <= 32_768 && boundedJsonObject(decoded, 64, 1024);
    }
    default: {
      const cap = /^t([0-9]+)$/u.exec(rule);
      return (
        cap !== null &&
        typeof value === 'string' &&
        Buffer.byteLength(value) <= Number(cap[1])
      );
    }
  }
}

function validTimestamp(value: string): boolean {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{3}))?$/u.exec(value);
  if (match === null || match[2] === '000') return false;
  const milliseconds = BigInt(match[1]!) * 1000n + BigInt(match[2] ?? 0);
  return milliseconds <= U64_MAX;
}

function boundedJsonObject(bytes: Uint8Array, maxDepth: number, maxMembers: number): boolean {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    if (!isObject(value)) return false;
    let members = 0;
    const visit = (current: unknown, depth: number): boolean => {
      if (depth > maxDepth) return false;
      if (Array.isArray(current)) {
        members += current.length;
        return members <= maxMembers && current.every((item) => visit(item, depth + 1));
      }
      if (isObject(current)) {
        const values = Object.values(current);
        members += values.length;
        return members <= maxMembers && values.every((item) => visit(item, depth + 1));
      }
      return true;
    };
    return visit(value, 1);
  } catch {
    return false;
  }
}

async function readExact(file: FileHandle, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(bytes, offset, length - offset, offset);
    if (read.bytesRead === 0) {
      throw new MoorStoreError('UNAVAILABLE', 'Moor store slot changed while it was read');
    }
    offset += read.bytesRead;
  }
  return bytes;
}

function exactAllocationLength(length: bigint): number {
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) corrupt('committed body is too large to address');
  return Number(length);
}

function requireProtected(metadata: Stats, mode: number, directory: boolean): void {
  const owned = typeof process.getuid !== 'function' || metadata.uid === process.getuid();
  if (
    !owned ||
    (metadata.mode & 0o777) !== mode ||
    (directory ? !metadata.isDirectory() : !metadata.isFile() || metadata.nlink !== 1)
  ) {
    corrupt('store path is not owner-private');
  }
}

function requireSameFile(path: Stats, handle: Stats): void {
  if (path.dev !== handle.dev || path.ino !== handle.ino) corrupt('store path identity changed');
}

function assertKind(kind: MoorStoreKind): void {
  if (![MoorStoreKind.Event, MoorStoreKind.Log, MoorStoreKind.Exit].includes(kind)) {
    corrupt(`unsupported Moor store kind ${kind}`);
  }
}

function copySnapshot(snapshot: MoorStoreSnapshot): MoorStoreSnapshot {
  return { commit: copyCommit(snapshot.commit), bytes: snapshot.bytes.slice() };
}

function copyCommit(commit: MoorCommit): MoorCommit {
  return { ...commit, hash: commit.hash.slice() };
}

function copyCursor(cursor: MoorEventCursor): MoorEventCursor {
  return { ...cursor, commitHash: cursor.commitHash.slice() };
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function strictBase64(value: string): Uint8Array {
  const decoded = strictBase64OrUndefined(value);
  if (decoded === undefined) corrupt('invalid canonical base64');
  return decoded;
}

function strictBase64OrUndefined(value: string): Uint8Array | undefined {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return undefined;
  }
  const decoded = new Uint8Array(Buffer.from(value, 'base64'));
  return Buffer.from(decoded).toString('base64') === value ? decoded : undefined;
}

function safeEventInteger(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0) corrupt('event counter is not safe');
  return BigInt(value as number);
}

function safeU32(value: unknown): number {
  if (!isU32(value, false)) corrupt('value is not a u32');
  return value as number;
}

function isU32(value: unknown, positive: boolean): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= (positive ? 1 : 0) &&
    (value as number) <= 0xffff_ffff
  );
}

function decimal(value: string): bigint | undefined {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= U64_MAX ? parsed : undefined;
}

function validSourceId(value: string): boolean {
  return Buffer.byteLength(value) <= 128 && /^[A-Za-z0-9._-]+$/u.test(value);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') corrupt('value is not text');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uppercaseEscapes(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/gu, (_match, digits: string) => `\\u${digits.toUpperCase()}`);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function corrupt(message: string): never {
  throw new MoorStoreError('CORRUPT', message);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
