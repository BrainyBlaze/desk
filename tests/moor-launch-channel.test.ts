import { describe, expect, it } from 'vitest';
import {
  DESK_SESSION_GENERATION,
  MOOR_SESSION_GENERATION,
  MoorLaunchChannelError,
  MoorLaunchResultDecoder,
  decodeMoorLaunchRecord,
  decodeMoorLaunchResult,
  encodeMoorLaunchRecord,
  moorGenerationEnvKey,
  moorLaunchChannelEnvKey
} from '../src/server/runtime/moorLaunchChannel.js';

const nonzero = (length: number, value: number): Uint8Array => new Uint8Array(length).fill(value);

function resultRecord(state: number, result: number, generation: number): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('MORR'), 0);
  bytes[4] = 1;
  bytes[5] = state;
  view.setUint16(6, result, true);
  view.setUint32(8, generation, true);
  return bytes;
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe('Moor private launch record', () => {
  it('encodes and decodes the exact 32-byte supervised record', () => {
    const nonce = nonzero(16, 0xa5);
    const encoded = encodeMoorLaunchRecord(0x1234_5678, nonce);
    expect(encoded).toHaveLength(32);
    expect(Buffer.from(encoded.subarray(0, 9)).toString('hex')).toBe('4d4f4f524c43483301');
    expect(encoded.subarray(9, 12)).toEqual(new Uint8Array(3));
    expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(12, true)).toBe(0x1234_5678);
    expect(encoded.subarray(16)).toEqual(nonce);
    expect(decodeMoorLaunchRecord(encoded)).toEqual({ generation: 0x1234_5678, nonce });
  });

  it.each([
    [1, nonzero(16, 1)],
    [0x1_0000_0000, nonzero(16, 1)],
    [2, new Uint8Array(16)],
    [2, new Uint8Array(15)]
  ] as const)('rejects invalid generation/nonce pair %#', (generation, nonce) => {
    expect(() => encodeMoorLaunchRecord(generation, nonce)).toThrowError(
      expect.objectContaining<MoorLaunchChannelError>({ code: 'MALFORMED_RECORD' })
    );
  });

  it('fails closed on wrong length, magic, version, reserved bytes, generation, or nonce', () => {
    const valid = encodeMoorLaunchRecord(2, nonzero(16, 7));
    for (const invalid of [
      valid.subarray(0, 31),
      Object.assign(valid.slice(), { 0: 0 }),
      Object.assign(valid.slice(), { 8: 2 }),
      Object.assign(valid.slice(), { 9: 1 }),
      (() => {
        const bytes = valid.slice();
        new DataView(bytes.buffer).setUint32(12, 1, true);
        return bytes;
      })(),
      (() => {
        const bytes = valid.slice();
        bytes.fill(0, 16);
        return bytes;
      })()
    ]) {
      expect(() => decodeMoorLaunchRecord(invalid)).toThrowError(
        expect.objectContaining<MoorLaunchChannelError>({ code: 'MALFORMED_RECORD' })
      );
    }
  });
});

describe('Moor launch result records', () => {
  it.each([
    [1, 0, 1, 'adopted'],
    [2, 0, 7, 'ready'],
    [3, 1, 9, 'failed'],
    [3, 0xffff, 0xffff_ffff, 'failed']
  ] as const)('decodes (%s,%s,%s) as %s', (state, result, generation, type) => {
    expect(decodeMoorLaunchResult(resultRecord(state, result, generation))).toEqual({
      type,
      result,
      generation
    });
  });

  it('accepts generation one in results even though requests start at generation two', () => {
    expect(decodeMoorLaunchResult(resultRecord(1, 0, 1))).toMatchObject({ generation: 1 });
    expect(() => encodeMoorLaunchRecord(1, nonzero(16, 1))).toThrow();
  });

  it.each([
    new Uint8Array(11),
    Object.assign(resultRecord(1, 0, 2), { 0: 0 }),
    Object.assign(resultRecord(1, 0, 2), { 4: 2 }),
    resultRecord(0, 0, 2),
    resultRecord(1, 1, 2),
    resultRecord(2, 1, 2),
    resultRecord(3, 0, 2),
    resultRecord(3, 1, 0)
  ])('rejects malformed result %#', (bytes) => {
    expect(() => decodeMoorLaunchResult(bytes)).toThrowError(
      expect.objectContaining<MoorLaunchChannelError>({ code: 'MALFORMED_RESULT' })
    );
  });
});

describe('Moor launch result sequence', () => {
  it('streams arbitrary chunks and keeps adoption nonterminal until ready', () => {
    const decoder = new MoorLaunchResultDecoder();
    const wire = joined(resultRecord(1, 0, 7), resultRecord(2, 0, 7));
    expect(decoder.feed(wire.subarray(0, 5))).toEqual([]);
    expect(decoder.feed(wire.subarray(5, 12))).toEqual([
      { type: 'adopted', result: 0, generation: 7 }
    ]);
    expect(decoder.terminal).toBe(false);
    expect(decoder.feed(wire.subarray(12))).toEqual([
      { type: 'ready', result: 0, generation: 7 }
    ]);
    expect(decoder.terminal).toBe(true);
    expect(decoder.end()).toEqual({ type: 'terminal-eof' });
  });

  it('accepts adopted-then-failed and failed-before-adoption', () => {
    const afterAdoption = new MoorLaunchResultDecoder();
    expect(
      afterAdoption.feed(joined(resultRecord(1, 0, 7), resultRecord(3, 5, 7)))
    ).toEqual([
      { type: 'adopted', result: 0, generation: 7 },
      { type: 'failed', result: 5, generation: 7 }
    ]);

    const direct = new MoorLaunchResultDecoder();
    expect(direct.feed(resultRecord(3, 1, 1))).toEqual([
      { type: 'failed', result: 1, generation: 1 }
    ]);
  });

  it('surfaces adopted-then-EOF for the integration publication probe', () => {
    const decoder = new MoorLaunchResultDecoder();
    decoder.feed(resultRecord(1, 0, 12));
    expect(decoder.end()).toEqual({ type: 'adopted-eof', generation: 12 });
  });

  it.each([
    resultRecord(2, 0, 7),
    joined(resultRecord(1, 0, 7), resultRecord(1, 0, 7)),
    joined(resultRecord(1, 0, 7), resultRecord(2, 0, 8)),
    joined(resultRecord(3, 1, 7), resultRecord(3, 1, 7))
  ])('rejects invalid ordering or bytes after a terminal result %#', (wire) => {
    expect(() => new MoorLaunchResultDecoder().feed(wire)).toThrowError(
      expect.objectContaining<MoorLaunchChannelError>({ code: 'INVALID_SEQUENCE' })
    );
  });

  it('rejects early and partial EOF', () => {
    expect(() => new MoorLaunchResultDecoder().end()).toThrowError(
      expect.objectContaining<MoorLaunchChannelError>({ code: 'INCOMPLETE' })
    );
    const partial = new MoorLaunchResultDecoder();
    partial.feed(resultRecord(1, 0, 7).subarray(0, 11));
    expect(() => partial.end()).toThrowError(
      expect.objectContaining<MoorLaunchChannelError>({ code: 'INCOMPLETE' })
    );
  });
});

describe('Moor generation environment carriers', () => {
  it('exports the fixed moor carrier and the distinct Desk application key', () => {
    // The moor child-visible carrier is a FIXED literal (spec §10.1) — never
    // derived — and the Desk application variable is a genuinely different
    // name that moor treats as opaque environment.
    expect(MOOR_SESSION_GENERATION).toBe('MOOR_SESSION_GENERATION');
    expect(DESK_SESSION_GENERATION).toBe('DESK_SESSION_GENERATION');
    expect(MOOR_SESSION_GENERATION).not.toBe(DESK_SESSION_GENERATION);
  });

  it.each([
    ['/usr/local/bin/moor', 'MOOR_LAUNCH_CHANNEL'],
    ['moor-copy', 'MOOR_COPY_LAUNCH_CHANNEL'],
    ['', 'MOOR_LAUNCH_CHANNEL']
  ])('derives the launch selector for %s as %s', (invoked, expected) => {
    expect(moorLaunchChannelEnvKey(invoked)).toBe(expected);
  });

  it('caps the launch-selector basename at 112 transformed bytes (spec §10.1.1)', () => {
    const long = new Uint8Array(200).fill(0x61);
    const key = moorLaunchChannelEnvKey(long);
    expect(key).toHaveLength(127);
    expect(key).toBe(`${'A'.repeat(112)}_LAUNCH_CHANNEL`);
  });

  it.each([
    ['/usr/local/bin/moor', 'MOOR_GENERATION'],
    ['/tmp/My atch!', 'MY_ATCH__GENERATION'],
    ['atch', 'ATCH_GENERATION'],
    ['', 'MOOR_GENERATION'],
    ['/', 'MOOR_GENERATION'],
    ['.', 'MOOR_GENERATION'],
    ['..', 'MOOR_GENERATION']
  ])('derives %s as %s', (invoked, expected) => {
    expect(moorGenerationEnvKey(invoked)).toBe(expected);
  });

  it('normalizes raw encoded bytes and truncates before the suffix', () => {
    expect(moorGenerationEnvKey(Uint8Array.of(0x2f, 0xff, 0xc3, 0xa9, 0x2d, 0x61))).toBe(
      '____A_GENERATION'
    );
    const long = new Uint8Array(200).fill(0x61);
    const key = moorGenerationEnvKey(long);
    expect(key).toHaveLength(127);
    expect(key).toBe(`${'A'.repeat(116)}_GENERATION`);
  });
});
