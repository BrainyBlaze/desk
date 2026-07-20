// Identity migration — submitState REPAIR MAP (spec §10, round-5C/7A). Pure.
// Maps the legacy on-disk durability extension (channelsDurability.ts) to a new
// delivery phase. THE load-bearing rule: nothing legacy imports as `done`.
// Legacy `.delivered` conflated genuinely-submitted with delivery-ack-timeout
// (both produced `.delivered`), so it cannot be trusted as confirmation and
// imports as `semantic-unknown` (held, fail-closed) unless an independent
// durable correlated event proves it. Legacy seq files acquire a FRESH
// txnId/bodyKey/submitKey at migration.

import { type DeliveryPhase } from '../delivery/index.js';

/** The legacy on-disk durability extensions (channelsDurability.ts). */
export type LegacyDurabilityExt =
  | 'json' // queued, drain candidate
  | 'delivering' // paste cycle claimed before send
  | 'delivered' // CONFLATES true-submitted AND delivery-ack-timeout
  | 'stuck-paste'
  | 'stuck-submit'
  | 'stuck-unobservable'
  | 'delivery-ack-timeout';

export interface RepairOutcome {
  phase: DeliveryPhase;
  /** Mint a fresh txnId/bodyKey/submitKey (always true — legacy keys are dropped). */
  freshTxn: boolean;
  /** Re-deliver from the top (safe, at-most-once via the fresh keys). */
  reissue: boolean;
  reason: string;
}

/**
 * Repair one legacy durability record into a new delivery phase (§10). A record
 * with independent durable proof of confirmation may be passed `provenConfirmed`
 * to lift a `.delivered` to `submit-confirmed`; without it, `.delivered` is held
 * as `semantic-unknown` (never `done`).
 */
export function repairLegacySubmit(ext: LegacyDurabilityExt, provenConfirmed = false): RepairOutcome {
  switch (ext) {
    case 'json':
      return { phase: 'queued', freshTxn: true, reissue: false, reason: 'queued drain candidate → queued' };
    case 'delivering':
      return { phase: 'queued', freshTxn: true, reissue: true, reason: 'claimed-before-send → re-derive queued + re-deliver' };
    case 'stuck-paste':
      return { phase: 'queued', freshTxn: true, reissue: true, reason: 'paste never landed → queued + re-deliver' };
    case 'delivered':
      return provenConfirmed
        ? { phase: 'submit-confirmed', freshTxn: true, reissue: false, reason: 'independent durable proof of confirmation' }
        : { phase: 'semantic-unknown', freshTxn: true, reissue: false, reason: 'legacy .delivered conflates submitted + ack-timeout → held, never done' };
    case 'stuck-submit':
    case 'stuck-unobservable':
    case 'delivery-ack-timeout':
      return { phase: 'semantic-unknown', freshTxn: true, reissue: false, reason: 'unconfirmed → held, fail-closed, no auto-resubmit' };
  }
}

/**
 * Plan a queue's migration by drain outcome (§10 round-7A): a queue fully
 * drained during the quiesce has nothing to import; an incomplete drain imports
 * each remaining file under the repair map.
 */
export function planDrain(drainComplete: boolean): { action: 'skip-import' } | { action: 'import-per-file' } {
  return drainComplete ? { action: 'skip-import' } : { action: 'import-per-file' };
}

/** True iff a repaired phase is `done` — must NEVER happen for legacy input. */
export function importsAsDone(outcome: RepairOutcome): boolean {
  return outcome.phase === 'done';
}
