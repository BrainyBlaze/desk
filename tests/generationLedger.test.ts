// Durable generation / tombstone ledger conformance (spec §4.8.1, H8). The
// fence-critical property: generation survives delete+recreate and is never
// reissued or reset.

import { describe, expect, it } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger, intake, InMemoryIntakeStore } from '../src/shared/controlPlane/index.js';

describe('generation ledger — monotonic allocation (§4.8.1)', () => {
  it('allocates 1 for a fresh sessionId, then increments', () => {
    const led = new GenerationLedger(new InMemoryGenerationLedger());
    expect(led.allocate('s1')).toBe(1);
    expect(led.allocate('s1')).toBe(2);
    expect(led.allocate('s1')).toBe(3);
    expect(led.current('s1')).toBe(3);
  });

  it('tracks generations per sessionId independently', () => {
    const led = new GenerationLedger(new InMemoryGenerationLedger());
    expect(led.allocate('a')).toBe(1);
    expect(led.allocate('b')).toBe(1);
    expect(led.allocate('a')).toBe(2);
    expect(led.current('b')).toBe(1);
  });

  it('THE fence-critical property: generation survives delete+recreate (tombstone)', () => {
    const backing = new InMemoryGenerationLedger();
    const led = new GenerationLedger(backing);
    expect(led.allocate('s1')).toBe(1); // session created at gen 1
    backing.tombstoneOnDelete('s1'); // session `rm`'d — registry gone, ledger kept
    // recreate the SAME sessionId — must NOT reset to 1:
    expect(led.allocate('s1')).toBe(2);
    expect(led.current('s1')).toBe(2);
  });

  it('a lowering write is refused (compaction/replay never reissues a generation)', () => {
    const backing = new InMemoryGenerationLedger();
    backing.write('s1', 5);
    backing.write('s1', 3); // stale/replayed lower value — must be ignored
    expect(backing.read('s1')).toBe(5);
    backing.write('s1', 6); // a genuine raise still applies
    expect(backing.read('s1')).toBe(6);
  });
});

describe('generation ledger — backs the §6.3 fence end-to-end', () => {
  it('a delayed old-generation hook is fenced after delete+recreate', () => {
    // The ledger is the source of truth for the fence's currentGeneration.
    const led = new GenerationLedger(new InMemoryGenerationLedger());
    const store = new InMemoryIntakeStore();

    const g1 = led.allocate('s1'); // gen 1
    store.setGeneration('s1', g1);
    const accepted = intake({ sessionId: 's1', carriedGeneration: g1, source: 'typed-hook', invocationId: 'i1', state: 'working', ts: 1 }, store);
    expect(accepted.kind).toBe('accepted');

    // session deleted + recreated — ledger tombstone bumps to gen 2:
    const g2 = led.allocate('s1');
    expect(g2).toBe(2);
    store.setGeneration('s1', g2);

    // a delayed hook from the OLD generation (carrying g1) is fenced:
    const stale = intake({ sessionId: 's1', carriedGeneration: g1, source: 'typed-hook', invocationId: 'i2', state: 'working', ts: 2 }, store);
    expect(stale.kind).toBe('rejected');
  });
});
