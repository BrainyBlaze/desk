import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsOps.js';
import type { HistoricalSubmitState, SubmitState, DeliveryStatus } from './channelsProtocol.js';

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
const PRUNE_INTERVAL = 1_000;
const EVENTS_DIR = '_engine';
const PREVIEW_MAX_BYTES = 200;

/** In-memory seq cache: avoids O(file) readFileSync on every append.
 *  Re-initialized lazily from the file on first access after boot. */
let cachedSeq = 0;
let cachedHome: string | null = null;

function endsWithNewline(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) {
      return true;
    }
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Test seam: forget the in-process seq authority so the next append re-derives it from disk. */
export function resetDeliveryEventSeqCache(): void {
  cachedSeq = 0;
  cachedHome = null;
}

/**
 * Delivery event kind — derived from the frozen protocol unions where they
 * overlap, plus event-log-specific kinds that have no protocol equivalent.
 *
 * SINGLE-SOURCE: the stuck terminals, active submit states, and paused status
 * are EXTRACTED from the frozen SubmitState / LifecycleStatus unions so a
 * protocol change automatically flows into the event-log type.
 */
type StuckTerminal = Extract<SubmitState, `submit-stuck-${string}`>;
type SubmitActive = Extract<
  HistoricalSubmitState,
  'delivering' | 'submitted' | 'delivery-ack-timeout' | 'submit-not-applicable'
>;
type PausedStatus = Extract<DeliveryStatus, 'paused'>;

export type DeliveryEventKind =
  | SubmitActive       // 'delivering' | 'submitted' | 'delivery-ack-timeout' | 'submit-not-applicable' — from HistoricalSubmitState (the ring is durable history)
  | StuckTerminal      // 'submit-stuck-paste' | 'submit-stuck-submit' | 'submit-stuck-unobservable' — from SubmitState
  | PausedStatus       // 'paused' — from LifecycleStatus
  | 'queued'           // -specific: item entered the queue
  | 'released'         // -specific: agent released (signal-driven)
  | 'resumed'          // -specific: operator resumed
  | 'dropped';         // -specific: item dropped (operator or overflow)

/**
 * The kinds a LIVE producer may write. It is the read vocabulary minus
 * `delivery-ack-timeout`, a state no path has emitted since delivery ACK
 * outcomes were retired: it survives ONLY in historical rings, so admitting it
 * at a write would fabricate a retired state. The read model keeps it.
 */
export type WritableDeliveryEventKind = Exclude<DeliveryEventKind, 'delivery-ack-timeout'>;

export interface DeliveryEvent {
  seq: number;
  at: string;
  sessionId?: string;
  /**
   * The retired per-session identity Desk v0.3.1 and older keyed this record
   * by, carried by the reader AS FOUND. A record the v0.3.2 migration could not
   * map (its session was already gone) has this and no `sessionId`; a record
   * the migration DID map can still carry a stray retired key alongside its
   * `sessionId`, and both are kept — losing the resolved id to honour the
   * unresolved one would throw away real knowledge. This is a READ-only field:
   * no live write path sets it (see WritableDeliveryEventKind / the write input
   * type), so it never labels a freshly produced event.
   */
  preCutoverSession?: string;
  channel?: string;
  messageId?: string;
  kind: DeliveryEventKind;
  from?: string;
  to?: string;
  reason?: string;
  preview?: string;
}

export interface DeliveryEventFilter {
  sessionId?: string;
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
 * What a live producer hands to a write: the read model minus the fields and
 * kinds that exist ONLY in history. `seq`/`at` are assigned here; `kind` is
 * narrowed to the writable vocabulary (no `delivery-ack-timeout`); and
 * `preCutoverSession` is pinned to `never`, not merely omitted. Omitting it
 * would only drop it from the declared surface — a producer VARIABLE (as
 * opposed to a fresh inline literal, which excess-property checks would catch)
 * carrying an extra `preCutoverSession` stays structurally assignable to an
 * Omit-based input. Typing the field `never` rejects any value for it whether
 * it arrives inline or through a variable. This is what stops the type system
 * from silently permitting a producer to fabricate retired history.
 */
export type DeliveryEventInput = Omit<DeliveryEvent, 'seq' | 'at' | 'kind' | 'preCutoverSession'> & {
  kind: WritableDeliveryEventKind;
  at?: string;
  preCutoverSession?: never;
};

// Compile-time boundary witnesses (verified by `npm run check`, which type-checks
// src/). Each asserts a NEGATIVE — that a producer value carrying a retired form
// is NOT assignable to the write input — using a VARIABLE-shaped source, because
// that is the assignment excess-property checks do not police. If a future edit
// re-admits either form, its `NotAssignable` flips to `false`, the `AssertTrue`
// stops satisfying `extends true`, and tsc fails here: the boundary cannot rot
// silently.
type AssertTrue<T extends true> = T;
type NotAssignable<TSource, TTarget> = TSource extends TTarget ? false : true;
type _WriteInputRejectsRetiredKindVariable = AssertTrue<
  NotAssignable<{ kind: 'delivery-ack-timeout' }, DeliveryEventInput>
>;
type _WriteInputRejectsHistoricalFieldVariable = AssertTrue<
  NotAssignable<{ kind: 'queued'; preCutoverSession: string }, DeliveryEventInput>
>;

/**
 * Appends a single delivery event. The `seq` is auto-assigned from the current
 * file's line count + 1; `at` defaults to now. Sync, atomic per-line.
 */
export function appendDeliveryEvent(
  home: string,
  event: DeliveryEventInput,
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
  // A torn tail (crash mid-append) ends without its newline. Appending
  // straight after it would fuse the new record onto the partial one and
  // lose BOTH; terminate the tail first so the torn line stays an isolated,
  // skippable line and the new record stays whole.
  const path = eventsPath(home);
  const terminator = existsSync(path) && !endsWithNewline(path) ? '\n' : '';
  appendFileSync(path, `${terminator}${JSON.stringify(full)}\n`, 'utf8');
  if (seq > MAX_EVENTS && seq % PRUNE_INTERVAL === 0) {
    pruneDeliveryEvents(home);
  }
  return full;
}

/**
 * The seq authority is the last line of the ring that PARSES, scanning
 * backwards. A torn tail (crash mid-append) must not reset numbering to 1
 * after thousands of real events, and a ring in which nothing parses is not
 * "empty" — it is unreadable, and appending a confident seq 1 into it would
 * silently restart the numbering of a ring an operator is still reading. Only
 * an absent file or one with no nonblank line at all starts at 1.
 */
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
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    cachedHome = home;
    cachedSeq = 1;
    return 1;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && Number.isFinite((parsed as { seq?: unknown }).seq)) {
      cachedHome = home;
      cachedSeq = ((parsed as { seq: number }).seq) + 1;
      return cachedSeq;
    }
  }
  throw new Error(`events ring at ${path} has no readable record to continue from; refusing to append`);
}

/**
 * The key Desk v0.3.1 and older used to attribute a record to its session.
 * Nothing since the cutover writes it. The migration that re-keyed such
 * records is gone (v0.3.2 was the last release to carry it), and v0.3.2 kept
 * in place every record whose session no longer existed — so a ring that was
 * migrated correctly may still hold them, and a never-migrated ring is gated
 * by the manifest refusal, not here. Refusing the whole ring would therefore
 * assert "pre-cutover store" about a store that is not, and name a remedy
 * (boot v0.3.2) that was already applied. What the reader knows about such a
 * record is exactly this: it is a session's history under an identity this
 * version cannot resolve. It returns the record with that identity carried
 * under a named field and no `sessionId` — not dropped, not attributed to
 * nobody, not attributed to anyone. Prune keeps the newest records whatever
 * their key, which is how a migrated ring eventually sheds them.
 */
const PRE_CUTOVER_SESSION_KEY = 'tmuxSession';

/**
 * Reads delivery events matching the optional filter. Returns events in
 * chronological order (oldest first). Falls back to [] on corrupt file.
 * A record keyed by the retired per-session identity comes back with that
 * identity under `preCutoverSession` and no `sessionId`; a per-session filter
 * never matches it, because it cannot be attributed.
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
    if (PRE_CUTOVER_SESSION_KEY in parsed) {
      const { [PRE_CUTOVER_SESSION_KEY]: retired, ...rest } = parsed as DeliveryEvent & {
        [PRE_CUTOVER_SESSION_KEY]?: unknown;
      };
      // Only a NONEMPTY STRING is an identity — exactly what the retired
      // migrator classified as one (a non-string or empty value was left
      // `unchanged`, never re-keyed). Carrying it means projecting the value AS
      // FOUND; `String(retired)` would instead fabricate a plausible identity
      // out of a malformed one (`String(null) === 'null'`,
      // `String({}) === '[object Object]'`), which is the very "assert more than
      // you know" the carry exists to avoid. A malformed retired value is not an
      // identity, so the record stays a non-attributed event: no
      // `preCutoverSession`, and the meaningless key dropped.
      parsed =
        typeof retired === 'string' && retired.length > 0
          ? { ...rest, preCutoverSession: retired }
          : (rest as DeliveryEvent);
    }
    if (filter.sessionId && parsed.sessionId !== filter.sessionId) {
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
  // Prune is a rewrite: it must not launder a lossy read into a clean file.
  // Every nonblank line that does not parse into an event is a line the
  // rewrite would silently discard, so the ring is left byte-for-byte as it
  // is and the caller hears why.
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const events: DeliveryEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`events ring at ${path} holds an unreadable line; refusing to prune over it`);
    }
    const event = parsed as Partial<DeliveryEvent>;
    if (typeof event.seq !== 'number' || typeof event.kind !== 'string') {
      throw new Error(`events ring at ${path} holds a record without seq/kind; refusing to prune over it`);
    }
    events.push(event as DeliveryEvent);
  }
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
