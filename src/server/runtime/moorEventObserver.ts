// Moor committed-store event observer (#3) — replaced the legacy NDJSON
// tailer in the atomic cutover to moor. Reads the four-slot
// committed store via readMoorStoreSnapshot/eventsAfterMoorCursor: the initial
// snapshot read is the replay phase (retained records, snapshots first), each
// poll re-runs commit selection and advances the cursor for live records.
// Cursor state is in-memory only: replay-vs-live is derived from the read
// itself, so no sidecar offset file survives restarts. A gap or corruption of
// COMMITTED CONTENT is terminal for this observer — report a diagnostic and
// stop, never resync. A failure to READ the store is a different claim: it
// says the directory was unreachable this instant, not that the session ended,
// so a bounded number of consecutive failures marks observation unavailable;
// polling continues until the same store becomes readable again.

import type { MoorExitOutcome } from '../../shared/controlPlane/contract.js';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MoorStoreError,
  MoorStoreKind,
  decodeMoorEventSnapshot,
  eventsAfterMoorCursor,
  readMoorStoreSnapshot,
  type MoorEventCursor,
  type MoorEventRecord
} from './moorStore.js';

/** The raw ending, tag preserved. Anything the grammar did not prove is unknown. */
function exitOutcome(value: Record<string, unknown>): MoorExitOutcome {
  const method = value.method;
  if (method !== 'none' && method !== 'graceful' && method !== 'forced') {
    return { kind: 'unknown' };
  }
  if (value.ended === 'exited' && typeof value.code === 'number') {
    return { kind: 'exited', code: value.code, method };
  }
  if (value.ended === 'signalled' && typeof value.signal === 'number') {
    return { kind: 'signalled', signal: value.signal, method };
  }
  return { kind: 'unknown' };
}

/** Desk-facing session event — the discriminated shape the router consumes. */
export type MoorSessionEvent =
  | { ts: number; type: 'ready' }
  | { ts: number; type: 'state'; state: 'busy' | 'idle'; title: string }
  | { ts: number; type: 'link'; uri: string }
  | {
      ts: number;
      type: 'exit';
      /** The raw ending, tag preserved -- the only view of the exit this event carries. */
      outcome: MoorExitOutcome;
      /** Validated lifecycle byte boundary, attached by the daemon consumer. */
      outputEnd?: bigint;
    };

export type { MoorExitOutcome } from '../../shared/controlPlane/contract.js';


export type MoorEventDiagnosticCode =
  | 'invalid-json'
  | 'invalid-record'
  | 'invalid-utf8'
  | 'line-too-long'
  | 'unterminated-line'
  | 'tailer-io'
  | 'observer-unavailable'
  | 'observer-recovered'
  | 'consumer-error';

export interface MoorEventDiagnostic {
  code: MoorEventDiagnosticCode;
  message: string;
}

export interface MoorEventContext {
  phase: 'replay' | 'live';
  kind: 'transition' | 'snapshot';
}

export type MoorEventObserverAvailability =
  | { status: 'unavailable'; consecutiveReadFailures: number; message: string }
  | { status: 'available' };

export interface MoorEventObserverOptions {
  directory: string;
  /** Supervised session generation the store must carry. */
  generation: number;
  /**
   * The canonical session identity (§1.2) this store must belong to. A valid
   * store carrying ANOTHER session's identity is refused — a supervisor never
   * adopts a neighbor's lifecycle.
   */
  identity?: Uint8Array;
  /**
   * OB-39: the holder's acknowledged event-store frontier from ATTACH_ACK.
   * The first observed commit may never be OLDER than what the holder
   * acknowledged — an older store is a stale or substituted directory.
   */
  descriptor?: {
    bodySlot: number;
    commitIndex: bigint;
    bodyLength: bigint;
    bodyHash: Uint8Array;
  };
  pollIntervalMs?: number;
  /**
   * How many CONSECUTIVE store reads may fail before observation is declared
   * unavailable. Any successful read clears the count and restores available
   * state; unavailability never claims that the holder or session died.
   */
  maxConsecutiveReadFailures?: number;
  onEvent: (event: MoorSessionEvent, context: MoorEventContext) => void | Promise<void>;
  onEventError?: (
    error: unknown,
    event: MoorSessionEvent,
    context: MoorEventContext
  ) => 'continue' | 'retry' | 'terminal';
  onDiagnostic: (diagnostic: string) => void;
  /** Availability transitions caused only by failed/successful store reads. */
  onAvailabilityChange?: (availability: MoorEventObserverAvailability) => void;
  /** The observer stopped on an authoritative cursor/identity/content contradiction. */
  onTerminal?: () => void;
}

/**
 * desk#59 — the final drain is bounded. Reading the committed store is a local
 * filesystem operation, so a read that has not settled in this long is stuck,
 * and holding teardown open for it trades one lost record for a hung session.
 */
const DEFAULT_DRAIN_DEADLINE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

/**
 * A body-first Moor rotation can leave an old commit pointing at its rewritten
 * body while the body fsync is still in progress. Identical samples therefore
 * become a corruption decision only after a sustained monotonic-time window,
 * not merely after two adjacent polls. Five seconds is 25 default poll periods:
 * long enough to absorb loaded local-disk flushes while still bounding a
 * permanently inconsistent store.
 */
const DEFAULT_MISMATCH_STABILITY_MS = 5_000;

/**
 * Five consecutive failures at the default 200 ms interval means the store has
 * been unreadable for a full second before observation is declared unavailable.
 * Polling then continues so the same observer can recover without replacing or
 * retiring the holder.
 */
const DEFAULT_MAX_CONSECUTIVE_READ_FAILURES = 5;

/**
 * The moor binary's OWN event-store root (unix.rs `root(invoked)`):
 * `temp_dir()/.{invoked-basename}-{euid}`. The holder REJECTS any `-T`
 * outside this directory (`outside-root`), so Desk must derive its handed-off
 * store paths from the SAME rule — never from its own socket root. Fidelity
 * to the vendored Moor source:
 * - `invoked` is the exact invocation name the spawn sees (argv0 override
 *   when set, else the binary path) — the basename decides the root name;
 *   an empty basename falls back to `moor` exactly like `root()`.
 * - the uid is the EFFECTIVE uid (`libc::geteuid`), never the real uid;
 * - the temp dir is Rust `std::env::temp_dir()` semantics: the spawn
 *   environment's TMPDIR when set, else `/tmp` — callers that override the
 *   child env MUST pass that env's TMPDIR here or the two sides diverge.
 * The holder creates the directory itself (owner-only) at launch.
 */
export function moorEventStoreRoot(
  invoked: string,
  opts: { tmpdir?: string; euid?: number } = {}
): string {
  const name = basename(invoked);
  const euid = opts.euid ?? process.geteuid!();
  const base = opts.tmpdir ?? process.env.TMPDIR ?? '/tmp';
  return join(base, `.${name.length > 0 ? name : 'moor'}-${euid}`);
}

/**
 * The per-generation committed event-store directory inside the given root:
 * `<root>/<sha256(sessionId).hex[:32]>.<generation>.events`. Hashing keeps the
 * name filesystem-safe for arbitrary session ids; the generation suffix keeps
 * lifetimes disjoint so a stale store can never be adopted by a new holder.
 */
export function moorEventStoreDir(root: string, sessionId: string, generation: number): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return join(root, `${digest}.${generation}.events`);
}

function mapRecord(record: MoorEventRecord): MoorSessionEvent | undefined {
  const value = record.value;
  const ts = typeof value.ts === 'number' ? value.ts : 0;
  switch (record.type) {
    case 'ready':
      return { ts, type: 'ready' };
    case 'state':
      return {
        ts,
        type: 'state',
        state: value.state === 'busy' ? 'busy' : 'idle',
        title: typeof value.title === 'string' ? value.title : ''
      };
    case 'link':
      return { ts, type: 'link', uri: typeof value.uri === 'string' ? value.uri : '' };
    case 'exit':
      // The store has already validated the record against the canonical
      // grammar, so each ending carries exactly its own fields. The tagged
      // outcome is what Desk persists and what the browser EXIT frame carries;
      // no numeric view is derived here.
      return { ts, type: 'exit', outcome: exitOutcome(value) };
    default:
      // Unknown-but-valid event types (future moor additions) are skipped: the
      // store already validated them; Desk just has no consumer yet.
      return undefined;
  }
}

export class MoorEventObserver {
  private readonly options: MoorEventObserverOptions;
  private cursor: MoorEventCursor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private polling = false;
  /** Consecutive failed store reads; any successful read resets it to zero. */
  private readFailures = 0;
  private unavailable = false;
  private mismatchWitness:
    | { fingerprint: string; firstObservedAt: number }
    | undefined;
  /** desk#59 — fences a drain read that completes after its own deadline. */
  private drainEpoch = 0;

  constructor(options: MoorEventObserverOptions) {
    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0)
    ) {
      // A zero/negative interval is a hot poll loop, not a configuration.
      throw new Error('moor event observer poll interval must be a positive integer');
    }
    if (
      options.maxConsecutiveReadFailures !== undefined &&
      (!Number.isSafeInteger(options.maxConsecutiveReadFailures) ||
        options.maxConsecutiveReadFailures <= 0)
    ) {
      // A zero threshold cannot distinguish a transient read stumble from a
      // persistent observation outage.
      throw new Error('moor event observer read-failure threshold must be a positive integer');
    }
    this.options = options;
  }

  /**
   * Initial replay read. False (with a diagnostic) when the store is
   * unreadable; a failed start may be retried. Idempotent once started —
   * a second call succeeds without replaying anything again.
   */
  async start(): Promise<boolean> {
    if (this.started) return true;
    try {
      const snapshot = await this.readSnapshot();
      const result = eventsAfterMoorCursor(snapshot);
      const delivery = await this.deliver(result.events, 'replay');
      if (delivery === 'terminal') {
        this.stop();
        this.options.onTerminal?.();
        return false;
      }
      this.started = true;
      if (delivery === 'retry') {
        this.schedule();
        return true;
      }
      this.cursor = result.cursor;
      if (!result.streamExhausted) this.schedule();
      return true;
    } catch (error) {
      this.options.onDiagnostic(describe(error));
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * desk#59 — one last bounded read of the committed store, then stop.
   *
   * The holder commits its lifecycle before unlinking, so at teardown the exit
   * record is routinely already on disk while Desk has not read it yet.
   * Stopping the observer at that moment discards the only evidence of how the
   * child died, which is why a retired session could never say more than
   * "someone retired it".
   *
   * The drain cancels further scheduling, serializes with any poll already in
   * flight (never running two readers over one cursor), performs AT MOST one
   * read, and never re-schedules. It reports whether the store could be read:
   * an unreadable or corrupt store yields `unobservable`, which the caller
   * must record as explicit retired provenance rather than an invented exit.
   */
  async drain(deadlineMs = DEFAULT_DRAIN_DEADLINE_MS): Promise<'drained' | 'unobservable'> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Serialize with the in-flight poll instead of racing it: two readers over
    // one cursor could deliver the same records twice or skip a commit. Bounded
    // by a deadline, because teardown must not hang on a reader that never
    // settles: a stuck store would otherwise hold the session's retirement open
    // forever.
    const deadline = Date.now() + deadlineMs;
    while (this.polling) {
      if (Date.now() >= deadline) {
        this.stop();
        return 'unobservable';
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.stopped) return 'drained';
    if (Date.now() >= deadline) {
      this.stop();
      return 'unobservable';
    }
    this.polling = true;
    // The epoch fences a read that completes AFTER the deadline: its records
    // must not be delivered into a session everyone has already finished
    // tearing down.
    const epoch = ++this.drainEpoch;
    try {
      const snapshot = await Promise.race([
        this.readSnapshot(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('final drain deadline reached')), Math.max(0, deadline - Date.now())).unref?.()
        )
      ]);
      if (epoch !== this.drainEpoch) return 'unobservable';
      if (
        this.cursor === undefined ||
        snapshot.commitIndex !== this.cursor.commitIndex ||
        !equalBytes(snapshot.commitHash, this.cursor.commitHash)
      ) {
        const result = eventsAfterMoorCursor(snapshot, this.cursor);
        const delivery = await this.deliver(result.events, 'live');
        if (delivery === 'terminal') {
          this.options.onTerminal?.();
          return 'unobservable';
        }
        if (delivery === 'retry') return 'unobservable';
        this.cursor = result.cursor;
      }
      return 'drained';
    } catch (error) {
      // The store could not be proved: report it and say so honestly. No
      // lifecycle is invented from an unreadable store.
      this.options.onDiagnostic(describe(error));
      return 'unobservable';
    } finally {
      this.polling = false;
      this.stop();
    }
  }

  // ---- internals ------------------------------------------------------------

  private async readSnapshot() {
    let selected;
    try {
      selected = await readMoorStoreSnapshot(
        this.options.directory,
        MoorStoreKind.Event,
        this.options.generation
      );
    } catch (error) {
      if (
        error instanceof MoorStoreError &&
        error.code === 'UNAVAILABLE' &&
        error.mismatchFingerprint !== undefined
      ) {
        const observedAt = performance.now();
        if (error.mismatchFingerprint === this.mismatchWitness?.fingerprint) {
          if (
            observedAt - this.mismatchWitness.firstObservedAt >=
            DEFAULT_MISMATCH_STABILITY_MS
          ) {
            throw new MoorStoreError(
              'CORRUPT',
              'Moor store commit/body mismatch remained unchanged beyond the stability window',
              { cause: error }
            );
          }
        } else {
          this.mismatchWitness = {
            fingerprint: error.mismatchFingerprint,
            firstObservedAt: observedAt
          };
        }
      } else {
        this.mismatchWitness = undefined;
      }
      throw error;
    }
    this.mismatchWitness = undefined;
    const snapshot = decodeMoorEventSnapshot(selected.bytes, selected.commit);
    const expected = this.options.identity;
    if (expected !== undefined && !identityEquals(snapshot.sessionIdentity, expected)) {
      throw new MoorStoreError(
        'GENERATION_MISMATCH',
        'event store belongs to a different canonical session identity'
      );
    }
    // The acknowledged frontier is the FULL portable selection — body slot,
    // commit index, committed length, and hash. The observed store may be
    // NEWER (higher index) but never older, and at the exact acknowledged
    // index every one of the four fields must match.
    const frontier = this.options.descriptor;
    if (frontier !== undefined) {
      if (snapshot.commitIndex < frontier.commitIndex) {
        throw new MoorStoreError(
          'GENERATION_MISMATCH',
          'event store is older than the holder-acknowledged frontier'
        );
      }
      if (
        snapshot.commitIndex === frontier.commitIndex &&
        (selected.commit.bodySlot !== frontier.bodySlot ||
          selected.commit.length !== frontier.bodyLength ||
          !identityEquals(snapshot.commitHash, frontier.bodyHash))
      ) {
        throw new MoorStoreError(
          'GENERATION_MISMATCH',
          'event store does not match the holder-acknowledged frontier selection'
        );
      }
    }
    return snapshot;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref?.(); // the observer must never keep the process alive
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      let snapshot;
      try {
        snapshot = await this.readSnapshot();
      } catch (error) {
        // A failed READ is a statement about reachability, not about committed
        // content — an interrupted syscall, a directory momentarily out of
        // reach, a store caught mid-commit. Retrying can genuinely succeed. A
        // bounded initial run is reported attempt-by-attempt; after that the
        // observer is explicitly unavailable and quietly probes for recovery.
        // Any authoritative content or trust-boundary decision stays terminal;
        // only the store reader's explicit unavailability result may retry.
        if (!(error instanceof MoorStoreError) || error.code !== 'UNAVAILABLE') throw error;
        const message = describe(error);
        const threshold =
          this.options.maxConsecutiveReadFailures ?? DEFAULT_MAX_CONSECUTIVE_READ_FAILURES;
        if (!this.unavailable) {
          this.options.onDiagnostic(message);
          this.readFailures += 1;
          if (this.readFailures >= threshold) {
            this.readFailures = threshold;
            this.unavailable = true;
            this.notifyAvailability({
              status: 'unavailable',
              consecutiveReadFailures: threshold,
              message
            });
          }
        }
        this.schedule();
        return;
      }
      this.readFailures = 0;
      if (this.unavailable) {
        this.unavailable = false;
        this.notifyAvailability({ status: 'available' });
      }
      if (
        this.cursor !== undefined &&
        snapshot.commitIndex === this.cursor.commitIndex &&
        equalBytes(snapshot.commitHash, this.cursor.commitHash)
      ) {
        this.schedule(); // no new commit — nothing to advance
        return;
      }
      const result = eventsAfterMoorCursor(snapshot, this.cursor);
      const delivery = await this.deliver(result.events, 'live');
      if (delivery === 'terminal') {
        this.stop();
        this.options.onTerminal?.();
        return;
      }
      if (delivery === 'retry') {
        this.schedule();
        return;
      }
      this.cursor = result.cursor;
      if (!result.streamExhausted) this.schedule();
    } catch (error) {
      // Terminal: a cursor gap/rollback or generation, identity, or frontier
      // contradiction is a COMPLETED decision about content that was read
      // successfully, and must never be skipped over. Report, stop, and signal
      // the owner; mere read unavailability never reaches this path.
      this.options.onDiagnostic(describe(error));
      this.stop();
      this.options.onTerminal?.();
    } finally {
      this.polling = false;
    }
  }

  private async deliver(
    records: readonly MoorEventRecord[],
    phase: 'replay' | 'live'
  ): Promise<'delivered' | 'retry' | 'terminal'> {
    for (const record of records) {
      const event = mapRecord(record);
      if (event === undefined) continue;
      try {
        await this.options.onEvent(event, { phase, kind: record.kind });
      } catch (error) {
        this.options.onDiagnostic(describe(error));
        const context = { phase, kind: record.kind } as const;
        const disposition = this.options.onEventError?.(error, event, context);
        if (disposition === 'retry' || disposition === 'terminal') return disposition;
      }
    }
    return 'delivered';
  }

  private notifyAvailability(availability: MoorEventObserverAvailability): void {
    try {
      this.options.onAvailabilityChange?.(availability);
    } catch (error) {
      this.options.onDiagnostic(`observer availability callback failed: ${describe(error)}`);
    }
  }
}

function identityEquals(a: Uint8Array, b: Uint8Array): boolean {
  return equalBytes(a, b);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function describe(error: unknown): string {
  if (error instanceof MoorStoreError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
