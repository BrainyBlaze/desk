// Checkpoint recovery-strategy select (spec §8.1, C3 / R-xterm-patch). Pure
// decision. Authoritative WORKER recovery must be EXACT, so this picks — in
// priority order — the exact pinned-patch checkpoint, else full journal replay,
// else a fail-closed degrade to approximate recovery (§8.2). A kind-1 DISPLAY
// checkpoint (lossy SerializeAddon framebuffer) is NEVER used for authoritative
// recovery — it is the browser baseline only.

import { SnapshotKind } from '../atchWire/frames.js';

/** A stored checkpoint's versioned envelope (§8.1 restore precondition). */
export interface CheckpointEnvelope {
  kind: SnapshotKind;
  outputOffset: bigint;
  formatVersion: number;
  xtermVersion: string;
  /** The pinned-patch version the complete-state blob was captured under. */
  patchVersion: string;
  byteLength: number;
}

/** The current worker's versions the checkpoint must match to be exact-usable. */
export interface WorkerVersions {
  formatVersion: number;
  xtermVersion: string;
  patchVersion: string;
}

/** The retained journal range + integrity, relative to the current tail. */
export interface JournalRange {
  retainedStart: bigint;
  tail: bigint;
  /** crc-verified contiguous typed records over the range needed for restore. */
  contiguousCrcOk: boolean;
  /** true iff the journal is retained from process start (full-replay-capable). */
  fromProcessStart: boolean;
}

export type RecoveryPlan =
  | { strategy: 'exact-checkpoint'; replayFrom: bigint; replayTo: bigint }
  | { strategy: 'full-replay'; replayFrom: bigint; replayTo: bigint }
  | { strategy: 'degrade'; reason: string };

/**
 * Choose the recovery strategy (§8.1). Order:
 * 1. EXACT checkpoint — a kind-0 AUTHORITATIVE checkpoint whose format/xterm/patch
 *    versions MATCH the worker, that sits within the retained journal
 *    (`retainedStart ≤ offset ≤ tail`) with a contiguous crc-verified
 *    checkpoint→tail range, and is within `maxCheckpoint`. Restore = apply the
 *    complete-state blob, replay typed records offset→tail.
 * 2. FULL REPLAY — no usable checkpoint, but the journal is retained from process
 *    start and contiguous: exact by construction, replay start→tail.
 * 3. DEGRADE — otherwise fail closed to approximate recovery + resync (§8.2);
 *    the caller marks recovery_lost. Never fabricate an exact restore.
 */
export function selectRecovery(
  checkpoint: CheckpointEnvelope | null,
  worker: WorkerVersions,
  journal: JournalRange,
  maxCheckpoint: number
): RecoveryPlan {
  if (checkpoint !== null && checkpoint.kind === SnapshotKind.AUTHORITATIVE_STATE) {
    const reason = exactUsability(checkpoint, worker, journal, maxCheckpoint);
    if (reason === null) {
      return { strategy: 'exact-checkpoint', replayFrom: checkpoint.outputOffset, replayTo: journal.tail };
    }
    // an unusable authoritative checkpoint falls through to replay/degrade.
  }
  if (journal.fromProcessStart && journal.contiguousCrcOk) {
    return { strategy: 'full-replay', replayFrom: journal.retainedStart, replayTo: journal.tail };
  }
  return { strategy: 'degrade', reason: degradeReason(checkpoint, journal) };
}

/** null iff the checkpoint is exact-usable; else the disqualifying reason. */
function exactUsability(c: CheckpointEnvelope, w: WorkerVersions, j: JournalRange, maxCheckpoint: number): string | null {
  if (c.formatVersion !== w.formatVersion || c.xtermVersion !== w.xtermVersion || c.patchVersion !== w.patchVersion) {
    return 'version-mismatch';
  }
  if (c.byteLength > maxCheckpoint) return 'oversize';
  if (c.outputOffset < j.retainedStart || c.outputOffset > j.tail) return 'offset-outside-retained';
  if (!j.contiguousCrcOk) return 'non-contiguous-or-torn';
  return null;
}

function degradeReason(checkpoint: CheckpointEnvelope | null, journal: JournalRange): string {
  if (checkpoint !== null && checkpoint.kind === SnapshotKind.TERMINAL_DISPLAY) {
    return 'only-display-checkpoint (not authoritative); journal not full/contiguous';
  }
  if (!journal.fromProcessStart) return 'journal truncated below process start; no usable checkpoint';
  return 'journal non-contiguous/torn; no usable checkpoint';
}
