// Channels durability/queue store transform (spec §10). The per-session delivery
// queue (channelsDurability.ts, <home>/_engine/queue/<tmuxSession>/) is re-keyed
// to <home>/_engine/queue/<sessionId>/ and every remaining item's legacy
// durability extension is repaired to a new delivery phase via the submit-repair
// map — THE load-bearing rule: nothing legacy imports as `done`, and legacy
// `.delivered` (which conflates submitted with ack-timeout) is held as
// semantic-unknown unless independently proven.
//
// Pure PLAN only: the filesystem dir rename + per-file rewrite is the gated
// cutover application. This decides, per item, the target sessionId key and the
// repaired delivery phase (with a fresh txn), or that the whole queue drained
// during quiesce and imports nothing.

import { importsAsDone, planDrain, repairLegacySubmit, type LegacyDurabilityExt, type RepairOutcome } from './submitStateRepair.js';

/** A queue item as stored today: its tmux dir, sequence, and durability extension. */
export interface LegacyQueueItem {
  tmuxSession: string;
  seq: number;
  ext: LegacyDurabilityExt;
  /** Independent durable proof that a `.delivered` was truly confirmed (lifts it to submit-confirmed). */
  provenConfirmed?: boolean;
}

/** A migrated queue item: its sessionId key and the repaired delivery phase. */
export interface MigratedQueueItem {
  sessionId: string;
  seq: number;
  outcome: RepairOutcome;
}

export interface DurabilityMigration {
  items: MigratedQueueItem[];
  /** Items whose tmuxSession has no sessionId (session gone) — not imported. */
  dropped: LegacyQueueItem[];
  /** True when the queue fully drained during quiesce → nothing imported (§10 round-7A). */
  skippedByDrain: boolean;
}

/**
 * Plan the durability-queue migration. A fully-drained queue imports nothing; an
 * incomplete drain imports each remaining item under the repair map, re-keyed by
 * the manifest map. Enforces the §10 invariant that no legacy record imports as
 * `done` (repairLegacySubmit never yields it, so a violation is an internal bug).
 */
export function migrateDurabilityQueue(
  items: readonly LegacyQueueItem[],
  tmuxToSessionId: ReadonlyMap<string, string>,
  drainComplete: boolean
): DurabilityMigration {
  if (planDrain(drainComplete).action === 'skip-import') {
    return { items: [], dropped: [], skippedByDrain: true };
  }
  const migrated: MigratedQueueItem[] = [];
  const dropped: LegacyQueueItem[] = [];
  for (const item of items) {
    const sessionId = tmuxToSessionId.get(item.tmuxSession);
    if (sessionId === undefined) {
      dropped.push(item);
      continue;
    }
    const outcome = repairLegacySubmit(item.ext, item.provenConfirmed ?? false);
    if (importsAsDone(outcome)) {
      throw new Error(`§10 invariant violated: legacy '${item.ext}' repaired to done`);
    }
    migrated.push({ sessionId, seq: item.seq, outcome });
  }
  return { items: migrated, dropped, skippedByDrain: false };
}
