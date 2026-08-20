import { describe, expect, it } from 'vitest';
import { TerminalOutputRing } from '../src/shared/runtime/terminalOutputRing.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('TerminalOutputRing', () => {
  it('returns one contiguous byte packet across appended chunks', () => {
    const ring = new TerminalOutputRing(100);

    ring.append(10n, encoder.encode('one'));
    ring.append(13n, encoder.encode('two'));
    ring.append(16n, encoder.encode('three'));

    expect(decoder.decode(ring.read(10n, 21n))).toBe('onetwothree');
    expect(ring.bytes).toBe(11);
  });

  it('retains an exact capped suffix and rejects a cursor before it', () => {
    const ring = new TerminalOutputRing(5);

    ring.append(20n, encoder.encode('123456789'));

    expect(ring.read(20n, 29n)).toBeUndefined();
    expect(decoder.decode(ring.read(24n, 29n))).toBe('56789');
    expect(ring.bytes).toBe(5);
  });

  it('resets continuity when the next chunk starts at a different offset', () => {
    const ring = new TerminalOutputRing(100);
    ring.append(0n, encoder.encode('old'));

    ring.append(10n, encoder.encode('new'));

    expect(ring.read(0n, 13n)).toBeUndefined();
    expect(decoder.decode(ring.read(10n, 13n))).toBe('new');
  });

  it('returns an empty packet when the cursor is already current', () => {
    const ring = new TerminalOutputRing(100);
    ring.append(5n, encoder.encode('data'));

    expect(ring.read(9n, 9n)).toEqual(new Uint8Array());
  });
});
