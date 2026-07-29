// Control plane — exactly-once consumer (spec §6.5). Pure logic over a durable
// PORT. Turns an at-least-once journal replay into exactly-once side effects
// using a durable receipt set keyed by acceptanceId, plus a durable cursor.
//
// Correctness rests on ORDER + a RECEIPT GUARD, not on cursor/effect atomicity:
//   apply-effect-and-write-receipt (ATOMIC, outbox) → advance cursor (separate).
// Crash in the gap → replay from the cursor re-hits the entry, the receipt says
// "already applied", the effect is skipped. The ONLY thing that must be atomic
// is effect+receipt together; that is what makes this implementable over fsync.

import { type AcceptedAgentStateEvent } from './contract.js';

/** One journaled control event, addressed by its monotonic journal `seq`. */
export interface JournalEntry {
  seq: number;
  event: AcceptedAgentStateEvent;
}

/**
 * Durable consumer state (the daemon's fsync'd backing).
 *  - `cursor` / `setCursor` — the last journal seq whose processing is COMMITTED.
 *  - `hasReceipt` — is this acceptanceId's effect already applied? (durable set)
 *  - `applyAndReceipt` — ATOMIC (outbox): run `effect` and record `acceptanceId`'s
 *    receipt in ONE write, all-or-nothing. Required for non-idempotent effects
 *    (e.g. "post a message"); harmless for idempotent ones.
 */
export interface ConsumerStore {
  cursor(): number;
  setCursor(seq: number): void;
  hasReceipt(eventId: string): boolean;
  applyAndReceipt(eventId: string, effect: () => void): void;
}

/**
 * Apply each entry's effect exactly once, in `seq` order, resuming from the
 * durable cursor. Entries at or before the cursor are skipped (already
 * committed). An entry whose acceptanceId already has a receipt (a replay, or an
 * intake `duplicate` re-journaled) runs NO effect but still advances the cursor
 * past it. New entries apply-and-receipt atomically, then advance the cursor.
 *
 * `entries` need not start at the cursor and may include already-processed
 * seqs (a full replay is safe); they MUST be in ascending `seq` order.
 * Returns the number of effects actually applied this call.
 */
export function consume(
  entries: readonly JournalEntry[],
  store: ConsumerStore,
  effect: (event: AcceptedAgentStateEvent) => void
): number {
  const start = store.cursor();
  let applied = 0;
  for (const { seq, event } of entries) {
    if (seq <= start) continue; // already committed
    if (store.hasReceipt(event.acceptanceId)) {
      store.setCursor(seq); // dedupe — advance over the duplicate, no effect
      continue;
    }
    store.applyAndReceipt(event.acceptanceId, () => effect(event));
    store.setCursor(seq);
    applied++;
  }
  return applied;
}

/**
 * In-memory reference ConsumerStore — the executable spec for §6.5. The
   * receipt set is unbounded here; the daemon prunes it per generation / retry
   * horizon (a receipt is only needed while its acceptanceId can still be replayed).
 */
export class InMemoryConsumerStore implements ConsumerStore {
  private cur = 0;
  private receipts = new Set<string>();

  cursor(): number {
    return this.cur;
  }
  setCursor(seq: number): void {
    if (seq > this.cur) this.cur = seq;
  }
  hasReceipt(eventId: string): boolean {
    return this.receipts.has(eventId);
  }
  applyAndReceipt(eventId: string, effect: () => void): void {
    // Atomic in the reference impl (single-threaded): the effect runs and the
    // receipt is recorded together, so a re-entry can never see one without the
    // other.
    effect();
    this.receipts.add(eventId);
  }
  /** Prune receipts no longer replayable (daemon calls this on generation change). */
  prune(keep: (acceptanceId: string) => boolean): void {
    for (const id of this.receipts) if (!keep(id)) this.receipts.delete(id);
  }
}
