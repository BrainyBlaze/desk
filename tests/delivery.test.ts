// Delivery-phase engine conformance (spec §6.10, H1). Covers the phase FSM
// (transport vs semantic separation, lost-ACK rescue, fail-closed unmarked
// confirm, crash recovery) and the CMD_CACHE retry horizon.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CMD_CACHE_CONFIG,
  InMemoryCmdCache,
  type DeliveryPhase,
  type DeliveryTxn,
  applyDelivery,
  isTerminal,
  recoverAction
} from '../src/shared/delivery/index.js';

const T0 = 1_000_000;
const txn = (phase: DeliveryPhase = 'queued'): DeliveryTxn => ({
  txnId: 'txn-1',
  sessionId: 's1',
  generation: 1,
  bodyKey: 's1:1:txn-1:body',
  submitKey: 's1:1:txn-1:submit',
  phase,
  phaseSince: T0
});

// ---- phase FSM (§6.10) -------------------------------------------------------
describe('delivery — phase FSM (§6.10)', () => {
  it('happy path: queued → body → submit → confirmed → done', () => {
    const t = txn();
    expect(applyDelivery(t, { kind: 'body-ack' }, T0 + 1).changed).toBe(true);
    expect(t.phase).toBe('body-accepted');
    applyDelivery(t, { kind: 'submit-ack' }, T0 + 2);
    expect(t.phase).toBe('submit-accepted');
    applyDelivery(t, { kind: 'confirm', marked: false }, T0 + 3); // pane went working
    expect(t.phase).toBe('submit-confirmed');
    applyDelivery(t, { kind: 'finalize' }, T0 + 4);
    expect(t.phase).toBe('done');
  });

  it('accepted != delivered: submit-accepted is NOT confirmed', () => {
    const t = txn('body-accepted');
    applyDelivery(t, { kind: 'submit-ack' }, T0 + 1);
    expect(t.phase).toBe('submit-accepted');
    expect(isTerminal(t.phase)).toBe(false); // transport-accepted, semantics pending
  });

  it('a MARKED confirm is authoritative — confirms even with lost transport ACKs', () => {
    const t = txn('body-accepted'); // submit-ack never arrived
    applyDelivery(t, { kind: 'confirm', marked: true }, T0 + 5); // hook echoed our txnId
    expect(t.phase).toBe('submit-confirmed');
  });

  it('an UNMARKED confirm only applies from submit-accepted (concurrency-safe)', () => {
    const early = txn('body-accepted');
    expect(applyDelivery(early, { kind: 'confirm', marked: false }, T0 + 1).changed).toBe(false);
    expect(early.phase).toBe('body-accepted'); // pane-working before we submitted → ignore
  });

  it('no semantic evidence in window → semantic-unknown (held, fail-closed)', () => {
    const t = txn('submit-accepted');
    applyDelivery(t, { kind: 'semantic-window-elapsed' }, T0 + 10);
    expect(t.phase).toBe('semantic-unknown');
  });

  it('a MARKED confirm rescues semantic-unknown; an UNMARKED one does NOT', () => {
    const unmarked = txn('semantic-unknown');
    expect(applyDelivery(unmarked, { kind: 'confirm', marked: false }, T0 + 20).changed).toBe(false);
    expect(unmarked.phase).toBe('semantic-unknown'); // mis-correlated hook never auto-confirms

    const marked = txn('semantic-unknown');
    applyDelivery(marked, { kind: 'confirm', marked: true }, T0 + 20);
    expect(marked.phase).toBe('submit-confirmed'); // txnId echo rescues it
  });

  it('fail → stuck carries the reason; terminal phases are idempotent', () => {
    const t = txn('submit-accepted');
    applyDelivery(t, { kind: 'fail', reason: 'semantic-horizon-exhausted' }, T0 + 30);
    expect(t.phase).toBe('stuck');
    expect(t.stuckReason).toBe('semantic-horizon-exhausted');
    // further inputs are absorbed (terminal)
    expect(applyDelivery(t, { kind: 'confirm', marked: true }, T0 + 40).changed).toBe(false);
    expect(applyDelivery(t, { kind: 'body-ack' }, T0 + 41).changed).toBe(false);
  });

  it('duplicate/out-of-order ACKs are absorbed (idempotent engine)', () => {
    const t = txn('submit-accepted');
    expect(applyDelivery(t, { kind: 'body-ack' }, T0 + 1).changed).toBe(false); // late body-ack
    expect(applyDelivery(t, { kind: 'submit-ack' }, T0 + 2).changed).toBe(false); // dup submit-ack
    expect(t.phase).toBe('submit-accepted');
  });
});

// ---- crash recovery (§6.10) --------------------------------------------------
describe('delivery — crash recovery action', () => {
  it('maps each persisted phase to the safe next transport action', () => {
    expect(recoverAction('queued')).toBe('send-body');
    expect(recoverAction('body-accepted')).toBe('reissue-submit');
    expect(recoverAction('submit-accepted')).toBe('await-semantic');
    expect(recoverAction('semantic-unknown')).toBe('await-semantic');
    expect(recoverAction('submit-confirmed')).toBe('finalize');
    expect(recoverAction('done')).toBe('none');
    expect(recoverAction('stuck')).toBe('none');
  });
});

// ---- CMD_CACHE (§6.10 / §4.4) -----------------------------------------------
describe('delivery — CMD_CACHE idempotency + horizon', () => {
  it('prepare → written → acked, and prepare is idempotent', () => {
    const c = new InMemoryCmdCache();
    const first = c.prepare('s1', 1, 'k1', 'txn-1', 'submit', T0);
    expect(first.existed).toBe(false);
    expect(first.record.phase).toBe('PREPARED');
    c.markWritten('s1', 1, 'k1');
    expect(c.get('s1', 1, 'k1')?.phase).toBe('WRITTEN');
    c.markAcked('s1', 1, 'k1', 'ok:accepted');
    expect(c.get('s1', 1, 'k1')?.phase).toBe('ACKED');
    const again = c.prepare('s1', 1, 'k1', 'txn-1', 'submit', T0 + 5);
    expect(again.existed).toBe(true);
    expect(again.record.phase).toBe('ACKED'); // not reset to PREPARED
  });

  it('retry of an ACKED step returns the cached result (dedupe, no re-submit)', () => {
    const c = new InMemoryCmdCache();
    c.prepare('s1', 1, 'k1', 'txn-1', 'submit', T0);
    c.markAcked('s1', 1, 'k1', 'ok:accepted');
    expect(c.retry('s1', 1, 'k1')).toEqual({ action: 'return-cached', result: 'ok:accepted' });
  });

  it('retry of a PREPARED/WRITTEN step re-issues (safe, idempotent by key)', () => {
    const c = new InMemoryCmdCache();
    c.prepare('s1', 1, 'k1', 'txn-1', 'submit', T0);
    expect(c.retry('s1', 1, 'k1')).toEqual({ action: 'reissue', phase: 'PREPARED' });
    c.markWritten('s1', 1, 'k1');
    expect(c.retry('s1', 1, 'k1')).toEqual({ action: 'reissue', phase: 'WRITTEN' });
  });

  it('retry past the horizon is REFUSED (fail-closed — dedupe proof gone)', () => {
    const c = new InMemoryCmdCache({ horizonMs: 1000, maxEntries: 512 });
    c.prepare('s1', 1, 'k1', 'txn-1', 'submit', T0);
    c.markAcked('s1', 1, 'k1', 'ok');
    c.evict(T0 + 1001); // entry ages out
    expect(c.retry('s1', 1, 'k1')).toEqual({ action: 'refuse', reason: 'horizon-exhausted' });
  });

  it('dropGeneration clears a partition; a later retry refuses', () => {
    const c = new InMemoryCmdCache();
    c.prepare('s1', 1, 'k1', 'txn-1', 'submit', T0);
    c.markAcked('s1', 1, 'k1', 'ok');
    c.dropGeneration('s1', 1);
    expect(c.retry('s1', 1, 'k1')).toEqual({ action: 'refuse', reason: 'horizon-exhausted' });
    // a different generation is an independent partition
    expect(c.get('s1', 2, 'k1')).toBeUndefined();
  });

  it('maxEntries trims oldest first', () => {
    const c = new InMemoryCmdCache({ horizonMs: 1_000_000, maxEntries: 2 });
    c.prepare('s1', 1, 'old', 'txn-a', 'body', T0);
    c.prepare('s1', 1, 'mid', 'txn-b', 'body', T0 + 10);
    c.prepare('s1', 1, 'new', 'txn-c', 'body', T0 + 20);
    c.evict(T0 + 21); // over cap by 1 → drop oldest ('old')
    expect(c.get('s1', 1, 'old')).toBeUndefined();
    expect(c.get('s1', 1, 'mid')).toBeDefined();
    expect(c.get('s1', 1, 'new')).toBeDefined();
  });

  it('default config is 10 min / 512 entries', () => {
    expect(DEFAULT_CMD_CACHE_CONFIG.horizonMs).toBe(600_000);
    expect(DEFAULT_CMD_CACHE_CONFIG.maxEntries).toBe(512);
  });
});
