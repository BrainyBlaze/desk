import { describe, expect, it } from 'vitest';
import { TerminalOutputRing } from '../src/server/terminalOutputRing';

describe('TerminalOutputRing', () => {
  it('replays appended chunks in order', () => {
    const ring = new TerminalOutputRing(100);

    ring.append('one');
    ring.append('two');
    ring.append('three');

    expect(ring.snapshot()).toBe('onetwothree');
    expect(ring.bytes).toBe(Buffer.byteLength('onetwothree'));
  });

  it('trims the oldest chunks when the byte cap is exceeded', () => {
    const ring = new TerminalOutputRing(6);

    ring.append('ab');
    ring.append('cd');
    ring.append('ef');
    ring.append('gh');

    expect(ring.snapshot()).toBe('cdefgh');
    expect(ring.bytes).toBe(6);
  });

  it('keeps only the capped suffix of an oversized chunk', () => {
    const ring = new TerminalOutputRing(5);

    ring.append('123456789');

    expect(ring.snapshot()).toBe('56789');
    expect(ring.bytes).toBe(5);
  });

  it('clears replay data', () => {
    const ring = new TerminalOutputRing(100);
    ring.append('data');

    ring.clear();

    expect(ring.snapshot()).toBe('');
    expect(ring.bytes).toBe(0);
  });
});
