// Moor committed-store event observer (#3) — replaced the legacy NDJSON
// tailer in the atomic cutover to moor. Reads the four-slot
// committed store via readMoorStoreSnapshot/eventsAfterMoorCursor: the initial
// snapshot read is the replay phase (retained records, snapshots first), each
// poll re-runs commit selection and advances the cursor for live records.
// Cursor state is in-memory only: replay-vs-live is derived from the read
// itself, so no sidecar offset file survives restarts. Any gap/corruption is
// terminal for this observer — report a diagnostic and stop, never resync.

import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  MoorStoreError,
  MoorStoreKind,
  decodeMoorEventSnapshot,
  eventsAfterMoorCursor,
  readMoorStoreSnapshot,
  type MoorEventCursor,
  type MoorEventRecord
} from './moorStore.js';

/** Desk-facing session event — the discriminated shape the router consumes. */
export type MoorSessionEvent =
  | { ts: number; type: 'ready' }
  | { ts: number; type: 'state'; state: 'busy' | 'idle'; title: string }
  | { ts: number; type: 'link'; uri: string }
  | { ts: number; type: 'exit'; code: number };


export type MoorEventDiagnosticCode =
  | 'invalid-json'
  | 'invalid-record'
  | 'invalid-utf8'
  | 'line-too-long'
  | 'unterminated-line'
  | 'tailer-io'
  | 'consumer-error';

export interface MoorEventDiagnostic {
  code: MoorEventDiagnosticCode;
  message: string;
}

export interface MoorEventContext {
  phase: 'replay' | 'live';
  kind: 'transition' | 'snapshot';
}

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
  onEvent: (event: MoorSessionEvent, context: MoorEventContext) => void;
  onDiagnostic: (diagnostic: string) => void;
  /** The observer stopped TERMINALLY (gap/corruption/identity) after start. */
  onTerminal?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 200;

/**
 * The moor binary's OWN event-store root (unix.rs `root(invoked)`):
 * `temp_dir()/.{invoked-basename}-{euid}`. The holder REJECTS any `-T`
 * outside this directory (`outside-root`), so Desk must derive its handed-off
 * store paths from the SAME rule — never from its own socket root. Fidelity
 * to the binary (moor @93d593a):
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
  opts: { tmpdir?: string; euid?: number; platform?: NodeJS.Platform } = {}
): string {
  if ((opts.platform ?? process.platform) === 'win32') {
    // The Windows launcher seam ships with the moor #4 conformance lane.
    throw new Error('MOOR_WINDOWS_LAUNCH_UNSUPPORTED: no event-store root derivation yet');
  }
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
    case 'exit': {
      // exited → code as-is; signalled → 128+signal (POSIX shell convention);
      // terminated → the holder-reported code.
      const code =
        value.ended === 'signalled'
          ? 128 + (typeof value.signal === 'number' ? value.signal : 0)
          : typeof value.code === 'number'
            ? value.code
            : 0;
      return { ts, type: 'exit', code };
    }
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

  constructor(options: MoorEventObserverOptions) {
    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0)
    ) {
      // A zero/negative interval is a hot poll loop, not a configuration.
      throw new Error('moor event observer poll interval must be a positive integer');
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
      this.started = true;
      this.cursor = result.cursor;
      this.deliver(result.events, 'replay');
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

  // ---- internals ------------------------------------------------------------

  private async readSnapshot() {
    const selected = await readMoorStoreSnapshot(
      this.options.directory,
      MoorStoreKind.Event,
      this.options.generation
    );
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
      const snapshot = await this.readSnapshot();
      if (
        this.cursor !== undefined &&
        snapshot.commitIndex === this.cursor.commitIndex &&
        equalBytes(snapshot.commitHash, this.cursor.commitHash)
      ) {
        this.schedule(); // no new commit — nothing to advance
        return;
      }
      const result = eventsAfterMoorCursor(snapshot, this.cursor);
      this.cursor = result.cursor;
      this.deliver(result.events, 'live');
      if (!result.streamExhausted) this.schedule();
    } catch (error) {
      // Terminal: a gap, rollback, generation change, or corrupt store must
      // never be skipped over. Report, stop, and SIGNAL the owner — a live
      // session with no lifecycle observer is not an operable state.
      this.options.onDiagnostic(describe(error));
      this.stop();
      this.options.onTerminal?.();
    } finally {
      this.polling = false;
    }
  }

  private deliver(records: readonly MoorEventRecord[], phase: 'replay' | 'live'): void {
    for (const record of records) {
      const event = mapRecord(record);
      if (event === undefined) continue;
      try {
        this.options.onEvent(event, { phase, kind: record.kind });
      } catch (error) {
        // A consumer failure is the consumer's bug, never a store gap: report
        // it and keep delivering the remaining committed records.
        this.options.onDiagnostic(describe(error));
      }
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
