// Loss-aware subscription resync conformance (spec §7.4).

import { describe, expect, it } from 'vitest';
import { SubscriptionResync, type FrameMeta } from '../src/shared/browserProtocol/index.js';

const snap = (offset: bigint, generation = 1, revision = 0): FrameMeta => ({ generation, revision, offset, length: 0 });
const out = (offset: bigint, length: number, generation = 1, revision = 0): FrameMeta => ({ generation, revision, offset, length });

describe('resync — baseline + contiguous live (§7.4)', () => {
  it('awaits a snapshot, then applies contiguous deltas', () => {
    const r = new SubscriptionResync();
    expect(r.phase).toBe('awaiting-snapshot');
    expect(r.onOutput(out(0n, 5))).toBe('ignore'); // no baseline yet
    expect(r.onSnapshot(snap(100n))).toBe('apply');
    expect(r.phase).toBe('live');
    expect(r.expectedOffset).toBe(100n);
    expect(r.onOutput(out(100n, 5))).toBe('apply');
    expect(r.expectedOffset).toBe(105n);
    expect(r.onOutput(out(105n, 3))).toBe('apply');
    expect(r.expectedOffset).toBe(108n);
  });

  it('discards an already-seen (overlapping) delta', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n));
    r.onOutput(out(0n, 10)); // expected now 10
    expect(r.onOutput(out(0n, 10))).toBe('discard'); // replay of an applied delta
    expect(r.expectedOffset).toBe(10n);
  });
});

describe('resync — gap detection → dirty → snapshot (§7.4)', () => {
  it('an offset gap drops to dirty and owes a snapshot', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n));
    r.onOutput(out(0n, 10)); // expected 10
    expect(r.onOutput(out(20n, 5))).toBe('dirty'); // gap: expected 10, got 20
    expect(r.phase).toBe('dirty');
    expect(r.needsSnapshot()).toBe(true);
    // deltas ignored while dirty
    expect(r.onOutput(out(25n, 5))).toBe('ignore');
    r.requestedSnapshot();
    expect(r.phase).toBe('resyncing');
    // a fresh snapshot re-baselines and resumes
    expect(r.onSnapshot(snap(30n))).toBe('apply');
    expect(r.phase).toBe('live');
    expect(r.expectedOffset).toBe(30n);
  });

  it('an explicit GAP frame and backpressure both drop to dirty', () => {
    const r1 = new SubscriptionResync();
    r1.onSnapshot(snap(0n));
    expect(r1.onGap()).toBe('dirty');
    const r2 = new SubscriptionResync();
    r2.onSnapshot(snap(0n));
    expect(r2.onBackpressure()).toBe('dirty');
  });
});

describe('resync — stale vs advanced generation/revision (§7.4)', () => {
  it('discards a stale older-generation straggler', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n, 5, 2));
    expect(r.onOutput(out(0n, 5, 4, 2))).toBe('discard'); // gen 4 < 5
    expect(r.phase).toBe('live');
  });

  it('discards a stale older-revision straggler after a resize', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n, 1, 3));
    expect(r.onOutput(out(0n, 5, 1, 2))).toBe('discard'); // rev 2 < 3
  });

  it('a newer generation (session recreated) drops to dirty', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n, 1, 0));
    expect(r.onOutput(out(0n, 5, 2, 0))).toBe('dirty'); // gen 2 > 1
    expect(r.needsSnapshot()).toBe(true);
  });

  it('a newer revision (geometry advanced) drops to dirty', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n, 1, 0));
    expect(r.onOutput(out(0n, 5, 1, 1))).toBe('dirty'); // rev 1 > 0
  });

  it('a stale snapshot behind the current baseline is discarded', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(50n, 3, 1));
    expect(r.onSnapshot(snap(10n, 2, 1))).toBe('discard'); // older generation snapshot
    expect(r.expectedOffset).toBe(50n); // baseline unchanged
  });

  it('a stale snapshot arriving DURING resync does not regress the baseline (@codex review)', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(100n, 2, 1)); // baseline gen2 rev1 @100
    r.onOutput(out(200n, 5, 2, 1)); // gap: expected 100, got 200 → dirty
    expect(r.phase).toBe('dirty');
    r.requestedSnapshot();
    expect(r.phase).toBe('resyncing');
    // an out-of-order STALE snapshot (older generation) arrives during resync:
    expect(r.onSnapshot(snap(50n, 1, 0))).toBe('discard');
    expect(r.expectedOffset).toBe(100n); // baseline NOT regressed
    expect(r.phase).toBe('resyncing'); // still awaiting the fresh snapshot
    // the genuine current-or-newer fresh snapshot re-baselines and resumes:
    expect(r.onSnapshot(snap(210n, 2, 1))).toBe('apply');
    expect(r.phase).toBe('live');
    expect(r.expectedOffset).toBe(210n);
  });

  it('a stale-revision snapshot during dirty is also discarded', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(snap(0n, 2, 5)); // baseline gen2 rev5
    r.onGap(); // → dirty
    expect(r.onSnapshot(snap(0n, 2, 3))).toBe('discard'); // rev3 < rev5
    expect(r.phase).toBe('dirty');
  });
});
