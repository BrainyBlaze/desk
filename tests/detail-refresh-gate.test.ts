import { describe, expect, it } from 'vitest';
import { createDetailRefreshGate } from '../src/web/channels/detailRefreshGate.js';

describe('createDetailRefreshGate', () => {
  it('dedupes reconcile refetches: two revision ticks during one pending refetch launch only one request', () => {
    const gate = createDetailRefreshGate();
    // Tick 1: the poll sees a revision diff and launches a reconcile refetch.
    const first = gate.begin('desk', true);
    expect(first).not.toBeNull();
    // Tick 2 fires while the first is still pending (not yet end()ed).
    const second = gate.begin('desk', true);
    expect(second).toBeNull(); // deduped — the caller must NOT launch a request
    // Only after the first completes may a fresh reconcile launch.
    gate.end('desk', first as number);
    const third = gate.begin('desk', true);
    expect(third).not.toBeNull();
  });

  it('sequences responses so a slow OLDER response cannot overwrite a newer one', () => {
    const gate = createDetailRefreshGate();
    // An explicit reload (dedupe=false, e.g. a channel switch) starts...
    const older = gate.begin('desk', false) as number;
    // ...and before it resolves, a newer explicit reload starts and supersedes.
    const newer = gate.begin('desk', false) as number;
    expect(newer).toBeGreaterThan(older);
    // The newer one is current; the older one must not be applied.
    expect(gate.isCurrent('desk', newer)).toBe(true);
    expect(gate.isCurrent('desk', older)).toBe(false); // stale response cannot win
    // Even after the (stale) older resolves and ends, the newer stays current.
    gate.end('desk', older);
    expect(gate.isCurrent('desk', newer)).toBe(true);
  });

  it('ending an OLDER request cannot free the slot held by a newer pending one (token ownership)', () => {
    // Codex's exact repro of the end(token) ownership bug.
    const gate = createDetailRefreshGate();
    const reconcile1 = gate.begin('desk', true) as number; // reconcile, in flight
    const explicit2 = gate.begin('desk', false) as number; // explicit reload, also in flight
    expect(explicit2).not.toBeNull();
    gate.end('desk', reconcile1); // the OLDER reconcile settles first
    // explicit2 is still pending, so a fresh reconcile must STILL be blocked.
    expect(gate.begin('desk', true)).toBeNull();
    // Only once the newer explicit reload ends is a reconcile allowed again.
    gate.end('desk', explicit2);
    expect(gate.begin('desk', true)).not.toBeNull();
  });

  it('ending the stale older request leaves the newer request the current owner', () => {
    const gate = createDetailRefreshGate();
    const older = gate.begin('desk', false) as number;
    const newer = gate.begin('desk', false) as number;
    gate.end('desk', older); // stale older resolves and ends
    expect(gate.isCurrent('desk', newer)).toBe(true); // newer still owns the apply
    expect(gate.isCurrent('desk', older)).toBe(false);
  });

  it('lets an explicit reload run even while a reconcile is in flight, and it wins', () => {
    const gate = createDetailRefreshGate();
    const reconcile = gate.begin('desk', true) as number; // poll reconcile, in flight
    // A user channel-switch/jump reload (dedupe=false) must NOT be dropped.
    const reload = gate.begin('desk', false) as number;
    expect(reload).not.toBeNull();
    // The later reload supersedes the in-flight reconcile.
    expect(gate.isCurrent('desk', reconcile)).toBe(false);
    expect(gate.isCurrent('desk', reload)).toBe(true);
  });

  it('isolates per channel: an in-flight refetch on one channel never blocks another', () => {
    const gate = createDetailRefreshGate();
    const a = gate.begin('alpha', true);
    const b = gate.begin('beta', true);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // A second reconcile on alpha is deduped, but beta is unaffected.
    expect(gate.begin('alpha', true)).toBeNull();
    gate.end('beta', b as number);
    expect(gate.begin('beta', true)).not.toBeNull();
  });

  it('after end, the next reconcile refetch is allowed again (single-flight, not one-shot)', () => {
    const gate = createDetailRefreshGate();
    const t1 = gate.begin('desk', true) as number;
    gate.end('desk', t1);
    const t2 = gate.begin('desk', true) as number;
    expect(t2).toBeGreaterThan(t1);
    // A completed refetch that is no longer current must not apply (a newer one
    // started), but a completed-and-current one may.
    expect(gate.isCurrent('desk', t1)).toBe(false);
    expect(gate.isCurrent('desk', t2)).toBe(true);
  });
});
