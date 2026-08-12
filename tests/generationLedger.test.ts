// Durable generation / tombstone ledger conformance (spec §4.8.1, H8). The
// fence-critical property: generation survives delete+recreate and is never
// reissued or reset.

import { describe, expect, it } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';

describe('generation ledger — monotonic allocation (§4.8.1)', () => {
  it('allocates 2 for a fresh sessionId (OB-18: 1 is reserved for unsupervised), then increments', () => {
    const led = new GenerationLedger(new InMemoryGenerationLedger());
    expect(led.allocate('s1')).toBe(2);
    expect(led.allocate('s1')).toBe(3);
    expect(led.allocate('s1')).toBe(4);
    expect(led.current('s1')).toBe(4);
  });

  it('tracks generations per sessionId independently', () => {
    const led = new GenerationLedger(new InMemoryGenerationLedger());
    expect(led.allocate('a')).toBe(2);
    expect(led.allocate('b')).toBe(2);
    expect(led.allocate('a')).toBe(3);
    expect(led.current('b')).toBe(2);
  });

  it('THE fence-critical property: generation survives delete+recreate (tombstone)', () => {
    const backing = new InMemoryGenerationLedger();
    const led = new GenerationLedger(backing);
    expect(led.allocate('s1')).toBe(2); // session created at gen 2 (OB-18: 1 reserved for unsupervised)
    backing.tombstoneOnDelete('s1'); // session `rm`'d — registry gone, ledger kept
    // recreate the SAME sessionId — must NOT reset to the fresh-lineage value (2):
    expect(led.allocate('s1')).toBe(3);
    expect(led.current('s1')).toBe(3);
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
