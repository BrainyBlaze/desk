import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedPrompt } from './channelsProtocol.js';

/**
 * Channels delivery durability — the on-disk lifecycle for a single queued
 * prompt across the delivering → submitted / submit-stuck transitions.
 *
 * File extensions under `_engine/queue/<tmuxSession>/`:
 *   <seq>.json            — queued, drain candidate
 *   <seq>.delivering      — paste cycle in flight (claimed before sendText)
 *   <seq>.delivered       — submit confirmed (paste landed AND pane went working)
 *   <seq>.stuck-paste     — paste never landed (composer unchanged after N retries)
 *   <seq>.stuck-submit    — paste landed but submit failed (composer changed, pane never went working)
 *   <seq>.stuck-unobservable — submission unconfirmed (capture failed for all verify cycles); retryable
 *
 * All transitions are idempotent: re-firing a callback for a seq that is
 * already in the target state (or has already moved past it) is a no-op,
 * never a throw. This makes the lifecycle crash-safe at every transition —
 * a restart mid-flight leaves the file at its last-durable extension, the
 * restore pass classifies accordingly, and a re-fired callback no-ops.
 */

export const EXT_QUEUED = 'json';
export const EXT_DELIVERING = 'delivering';
export const EXT_DELIVERED = 'delivered';
export const EXT_STUCK_PASTE = 'stuck-paste';
export const EXT_STUCK_SUBMIT = 'stuck-submit';
export const EXT_STUCK_UNOBSERVABLE = 'stuck-unobservable';
/**
 * Transient tombstone for restoreQueues' atomicity claim (restore-atomicity safeguard): a
 * source file is renamed `<file>.consumed` BEFORE parse+push so a crash between
 * rename and read leaves the item re-enqueueable on the next restore pass
 * (classifyQueueFile treats it as a replay candidate alongside .json /
 * .delivering / .stuck-unobservable). restoreQueues removes the tombstone
 * after a successful push. NOT a durable extension — persistQueue's surgical
 * .json cleanup already leaves non-.json files alone, and the tombstone is
 * short-lived (one restore pass).
 */
export const EXT_CONSUMED = 'consumed';

/** Files with these extensions represent durable lifecycle states that
 *  persistQueue MUST NOT touch — they are owned by the per-item state machine
 *  via the rename helpers below, not by the runtime.queue snapshot. */
const DURABLE_EXTS = new Set([
  EXT_DELIVERING,
  EXT_DELIVERED,
  EXT_STUCK_PASTE,
  EXT_STUCK_SUBMIT,
  EXT_STUCK_UNOBSERVABLE
]);

/** All stuck-* extensions, in classify/scan order. */
const STUCK_EXTS = [EXT_STUCK_PASTE, EXT_STUCK_SUBMIT, EXT_STUCK_UNOBSERVABLE] as const;

/** Files older than this in the .delivered state are presumed safe to sweep
 *  (the dedupe set in memory already covers their effect). Keeps the queue
 *  dir from growing unbounded under heavy traffic. */
export const DELIVERED_TTL_MS = 5 * 60 * 1000;

/** Same pad width as channelsEngine.persistQueue — seq → 10-digit filename stem. */
function padSeq(seq: number): string {
  return String(seq).padStart(10, '0');
}

function fileWithExt(tmuxSession: string, seq: number, ext: string): string {
  return `${padSeq(seq)}.${ext}`;
}

/** Classifies a queue-dir filename into its lifecycle extension, or null when
 *  the file does not match any known extension (caller should ignore). */
export function classifyQueueFile(filename: string): string | null {
  for (const ext of [EXT_QUEUED, EXT_DELIVERING, EXT_DELIVERED, ...STUCK_EXTS, EXT_CONSUMED]) {
    if (filename.endsWith(`.${ext}`)) {
      return ext;
    }
  }
  return null;
}

/** True for any extension that persistQueue must preserve (.delivering / .delivered / .stuck-*). */
export function isDurableExt(ext: string): boolean {
  return DURABLE_EXTS.has(ext);
}

/** Reads a queue-item file (any extension) and parses it as a QueuedPrompt.
 *  Returns null on read/parse failure. */
export function readQueueItem(dir: string, filename: string): QueuedPrompt | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, filename), 'utf8')) as Partial<QueuedPrompt>;
    if (parsed && typeof parsed.prompt === 'string') {
      return parsed as QueuedPrompt;
    }
  } catch {
    // unreadable / unparseable — caller treats as drop
  }
  return null;
}

/**
 * Idempotent .json → .delivering claim. The delivering callback fires this
 * before sendText under the per-session draining lock, so within a session
 * there is no concurrent claim for the same seq. Outside that lock (e.g. a
 * re-fired callback after restart), an already-.delivering source is success,
 * not an error.
 */
export function claimDelivering(home: string, tmuxSession: string, seq: number): void {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  const fromPath = join(dir, fileWithExt(tmuxSession, seq, EXT_QUEUED));
  const toPath = join(dir, fileWithExt(tmuxSession, seq, EXT_DELIVERING));
  if (existsSync(toPath)) {
    return; // already claimed — idempotent
  }
  if (!existsSync(fromPath)) {
    return; // already finalized (.delivered / .stuck-*) or already reverted — nothing to claim
  }
  try {
    renameSync(fromPath, toPath);
  } catch {
    // race with another transition — best-effort, restore will reconcile
  }
}

/**
 * Idempotent .delivering → .delivered transition. Fired by the 'submitted'
 * callback after verifySubmitted observes the pane going working.
 */
export function confirmDelivered(home: string, tmuxSession: string, seq: number): void {
  transitionFromDelivering(home, tmuxSession, seq, EXT_DELIVERED);
}

/**
 * Idempotent .delivering → .stuck-<kind> transition. Fired by the matching
 * callback after verifySubmitted exhausts its retry budget.
 */
export function markStuck(
  home: string,
  tmuxSession: string,
  seq: number,
  kind: 'paste' | 'submit' | 'unobservable'
): void {
  const ext =
    kind === 'paste' ? EXT_STUCK_PASTE : kind === 'submit' ? EXT_STUCK_SUBMIT : EXT_STUCK_UNOBSERVABLE;
  transitionFromDelivering(home, tmuxSession, seq, ext);
}

function transitionFromDelivering(home: string, tmuxSession: string, seq: number, targetExt: string): void {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  const fromPath = join(dir, fileWithExt(tmuxSession, seq, EXT_DELIVERING));
  const toPath = join(dir, fileWithExt(tmuxSession, seq, targetExt));
  if (existsSync(toPath)) {
    return; // already transitioned — idempotent
  }
  if (!existsSync(fromPath)) {
    return; // already reverted to .json (sendText false-return) or already finalized — no-op
  }
  try {
    renameSync(fromPath, toPath);
  } catch {
    // race — best-effort
  }
}

/**
 * Idempotent .stuck-* → .json revert for ONE seq. Two triggers: the operator
 * force-deliver action, and the live auto-retry of a .stuck-unobservable
 * delivery (Option B — rename back to .json first, then the engine re-enqueues
 * and the normal claim path applies). Returns true if the item is queued after
 * the call (already .json, or a stuck file was reverted), false if none found.
 */
export function retryStuckItem(home: string, tmuxSession: string, seq: number): boolean {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  const toPath = join(dir, fileWithExt(tmuxSession, seq, EXT_QUEUED));
  if (existsSync(toPath)) {
    return true; // already queued — idempotent (the live re-enqueue may double-fire)
  }
  for (const ext of STUCK_EXTS) {
    const fromPath = join(dir, fileWithExt(tmuxSession, seq, ext));
    if (existsSync(fromPath)) {
      try {
        renameSync(fromPath, toPath);
        return true;
      } catch {
        return false; // race — another transition moved it
      }
    }
  }
  return false; // no stuck file for this seq
}

/**
 * Idempotent unlink of a seq's .stuck-* file (the operator drop action over a
 * durable stuck item). Returns true if a stuck file was removed.
 */
export function dropStuckItem(home: string, tmuxSession: string, seq: number): boolean {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  for (const ext of STUCK_EXTS) {
    const path = join(dir, fileWithExt(tmuxSession, seq, ext));
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false; // raced unlink
      }
    }
  }
  return false;
}

/**
 * Set-revert for the sendText-returns-false path. A digest delivery fires
 * 'delivering' for ALL N coalesced seqs before sendText, so a failed digest
 * send leaves N .delivering files (not one). This helper reverts the whole
 * set for a session back to .json so the pump re-drains them when the
 * session is reachable again.
 *
 * Returns the seqs that were reverted (useful for logging / tests).
 */
export function revertAllDeliveringToJson(home: string, tmuxSession: string): number[] {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  if (!existsSync(dir)) {
    return [];
  }
  const reverted: number[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(`.${EXT_DELIVERING}`)) {
      continue;
    }
    const stem = file.slice(0, -`.`.length - EXT_DELIVERING.length);
    const seq = Number(stem);
    if (!Number.isFinite(seq)) {
      continue;
    }
    const fromPath = join(dir, file);
    const toPath = join(dir, fileWithExt(tmuxSession, seq, EXT_QUEUED));
    try {
      renameSync(fromPath, toPath);
      reverted.push(seq);
    } catch {
      // race — another transition already moved this file
    }
  }
  return reverted;
}

/** Sweep for .delivered files older than DELIVERED_TTL_MS. Called on restore
 *  and periodically to keep the dir from growing unbounded. Returns the count
 *  swept (informational). */
export function sweepDeliveredTtl(home: string, tmuxSession: string, now = Date.now()): number {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  if (!existsSync(dir)) {
    return 0;
  }
  let swept = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(`.${EXT_DELIVERED}`)) {
      continue;
    }
    try {
      const mtime = statSync(join(dir, file)).mtimeMs;
      if (now - mtime > DELIVERED_TTL_MS) {
        unlinkSync(join(dir, file));
        swept += 1;
      }
    } catch {
      // raced unlink — skip
    }
  }
  return swept;
}

/** Lists stuck items (.stuck-paste + .stuck-submit) for a session, parsed as
 *  QueuedPrompt with a `stuckKind` discriminator. Surfaced in the ops console
 *  via SessionDiagnostic so the operator can force-deliver or drop. */
export interface StuckItem {
  seq: number;
  kind: 'paste' | 'submit' | 'unobservable';
  item: QueuedPrompt;
}

export function listStuckItems(home: string, tmuxSession: string): StuckItem[] {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  if (!existsSync(dir)) {
    return [];
  }
  const stuck: StuckItem[] = [];
  for (const file of readdirSync(dir)) {
    const kind: StuckItem['kind'] | null = file.endsWith(`.${EXT_STUCK_PASTE}`)
      ? 'paste'
      : file.endsWith(`.${EXT_STUCK_SUBMIT}`)
        ? 'submit'
        : file.endsWith(`.${EXT_STUCK_UNOBSERVABLE}`)
          ? 'unobservable'
          : null;
    if (!kind) {
      continue;
    }
    const ext =
      kind === 'paste' ? EXT_STUCK_PASTE : kind === 'submit' ? EXT_STUCK_SUBMIT : EXT_STUCK_UNOBSERVABLE;
    const stem = file.slice(0, -(ext.length + 1));
    const seq = Number(stem);
    if (!Number.isFinite(seq)) {
      continue;
    }
    const item = readQueueItem(dir, file);
    if (item) {
      stuck.push({ seq, kind, item });
    }
  }
  return stuck.sort((a, b) => a.seq - b.seq);
}

/** Ensures the queue dir exists. Mirrors channelsEngine.queueDir's layout. */
export function ensureQueueDir(home: string, tmuxSession: string): string {
  const dir = join(home, '_engine', 'queue', tmuxSession);
  mkdirSync(dir, { recursive: true });
  return dir;
}
