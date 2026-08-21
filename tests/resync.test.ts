// Bounded-screen browser subscription continuity (§7.4).

import { describe, expect, it } from 'vitest';
import { SubscriptionResync, type FrameMeta } from '../src/shared/browserProtocol/index.js';

const baseline = (offset: bigint, generation = 1, revision = 0): FrameMeta => ({
  generation,
  revision,
  offset,
  length: 0
});
const output = (offset: bigint, length: number, generation = 1, revision = 0): FrameMeta => ({
  generation,
  revision,
  offset,
  length
});

describe('live subscription baseline', () => {
  it('ignores output until SNAPSHOT establishes the live frontier', () => {
    const r = new SubscriptionResync();
    expect(r.phase).toBe('awaiting-baseline');
    expect(r.onOutput(output(0n, 5))).toBe('ignore');

    expect(r.onSnapshot(baseline(100n))).toBe('apply');

    expect(r.phase).toBe('live');
    expect(r.expectedOffset).toBe(100n);
    expect(r.onOutput(output(100n, 5))).toBe('apply');
    expect(r.expectedOffset).toBe(105n);
  });

  it('discards already-seen output without moving the frontier', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(baseline(0n));
    expect(r.onOutput(output(0n, 10))).toBe('apply');
    expect(r.onOutput(output(0n, 10))).toBe('discard');
    expect(r.expectedOffset).toBe(10n);
  });
});

describe('live subscription replacement', () => {
  it('marks a gapped channel dirty and lets a replacement SNAPSHOT establish a new frontier', () => {
    const old = new SubscriptionResync();
    old.onSnapshot(baseline(0n));
    expect(old.onOutput(output(0n, 10))).toBe('apply');
    expect(old.onOutput(output(20n, 5))).toBe('dirty');
    expect(old.phase).toBe('dirty');
    expect(old.onOutput(output(25n, 5))).toBe('ignore');

    const replacement = new SubscriptionResync();
    replacement.onSnapshot(baseline(30n));
    expect(replacement.phase).toBe('live');
    expect(replacement.onOutput(output(30n, 5))).toBe('apply');
  });

  it('marks explicit loss and local backpressure dirty', () => {
    const gap = new SubscriptionResync();
    gap.onSnapshot(baseline(0n));
    expect(gap.onGap()).toBe('dirty');

    const backpressure = new SubscriptionResync();
    backpressure.onSnapshot(baseline(0n));
    expect(backpressure.onBackpressure()).toBe('dirty');
  });
});

describe('generation and revision boundaries', () => {
  it('discards stale generation and revision output', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(baseline(0n, 5, 3));
    expect(r.onOutput(output(0n, 5, 4, 3))).toBe('discard');
    expect(r.onOutput(output(0n, 5, 5, 2))).toBe('discard');
    expect(r.phase).toBe('live');
  });

  it('marks a newer generation dirty', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(baseline(0n, 1, 0));
    expect(r.onOutput(output(0n, 5, 2, 0))).toBe('dirty');
    expect(r.phase).toBe('dirty');
  });

  it('accepts contiguous live output across a newer geometry revision', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(baseline(40n, 1, 0));
    expect(r.onOutput(output(40n, 5, 1, 1))).toBe('apply');
    expect(r.expectedOffset).toBe(45n);
    expect(r.phase).toBe('live');
    expect(r.onOutput(output(45n, 3, 1, 1))).toBe('apply');
    expect(r.expectedOffset).toBe(48n);
  });

  it('marks a newer revision with a non-contiguous offset dirty', () => {
    const r = new SubscriptionResync();
    r.onSnapshot(baseline(40n, 1, 0));
    expect(r.onOutput(output(50n, 5, 1, 1))).toBe('dirty');
    expect(r.phase).toBe('dirty');
  });
});
