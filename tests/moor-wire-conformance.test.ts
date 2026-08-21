import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MoorCodec } from '../src/shared/moorWire/codec.js';
import {
  MoorKind,
  decodeMoorHolderMessage,
  encodeMoorDiscoveryHello,
  encodeMoorSupervisedRequest,
  encodeMoorControllerRequest
} from '../src/shared/moorWire/messages.js';
import { MOOR_HEADER_SIZE, MoorWireError } from '../src/shared/moorWire/schema.js';

interface FrozenVector {
  readonly description: string;
  readonly hex: string | readonly string[];
  readonly bytes: number;
}

interface FrozenEventCommitVector extends FrozenVector {
  readonly body: string;
  readonly body_bytes: number;
  readonly body_sha256: string;
}

interface FrozenV32 {
  readonly description: string;
  readonly geometry: readonly {
    readonly columns: number;
    readonly rows: number;
    readonly hex: string;
    readonly result: string;
  }[];
  readonly numeric_sizes: readonly {
    readonly operand: string;
    readonly surface: string;
    readonly result: string;
  }[];
  readonly same_size_redraw: {
    readonly columns: number;
    readonly rows: number;
    readonly lease_won: boolean;
    readonly winch_notifications: number;
    readonly none_notifications: number;
    readonly ctrl_l_hex: string;
  };
}

interface CorpusMeta {
  readonly source: string;
  readonly cross_checked: string;
  readonly note: string;
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/moor-v5-vectors.json', import.meta.url), 'utf8')
) as Record<string, FrozenVector | FrozenV32 | CorpusMeta>;

const fromHex = (value: string): Uint8Array => {
  const compact = value.replace(/\s+/gu, '');
  if (compact.length % 2 !== 0) throw new Error('hex fixture must contain whole bytes');
  return Uint8Array.from(compact.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
};

function vector(name: string): Uint8Array {
  const entry = corpus[name];
  if (entry === undefined || !('hex' in entry) || !('bytes' in entry)) {
    throw new Error(`missing Moor vector ${name}`);
  }
  const bytes = fromHex(Array.isArray(entry.hex) ? entry.hex.join('') : entry.hex);
  expect(bytes).toHaveLength(entry.bytes);
  return bytes;
}

function v32(): FrozenV32 {
  const entry = corpus.V32;
  if (entry === undefined || !('geometry' in entry)) {
    throw new Error('missing structured Moor vector V32');
  }
  return entry;
}

describe('Moor v5 frozen wire conformance', () => {
  it('commits all 32 content-verified normative vectors without truncation', () => {
    const names = Object.keys(corpus).filter((name) => /^V\d+$/u.test(name));
    expect(names).toHaveLength(32);
    for (const name of names) {
      if (name === 'V32') v32();
      else vector(name);
    }
  });

  it('freezes the portable POSIX V13 event commit byte-for-byte', () => {
    const entry = corpus.V13;
    if (entry === undefined || !('body' in entry)) {
      throw new Error('missing event-commit details for Moor vector V13');
    }
    const eventCommit = entry as FrozenEventCommitVector;
    const body = Buffer.from(eventCommit.body, 'utf8');

    expect(body).toHaveLength(eventCommit.body_bytes);
    expect(createHash('sha256').update(body).digest('hex')).toBe(eventCommit.body_sha256);
    expect(vector('V13')).toEqual(
      fromHex(
        '4D 4F 4F 52 43 4D 54 31 01 00 00 01 07 00 00 00 ' +
          '00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 ' +
          '85 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
          '00 00 00 00 00 00 00 00 2B BE EF B6 37 54 66 12 ' +
          'D6 A3 A6 BD 7C BD B7 BE 29 42 D6 DA DD C7 33 39 ' +
          '54 45 F9 ED D7 88 B6 4B C9 B4 ED 03'
      )
    );
  });

  it('freezes every V32 geometry, numeric-size, and redraw fixture', () => {
    const entry = v32();
    expect(entry).toEqual({
      description: 'exact geometry, numeric-size, and same-size-redraw fixtures',
      geometry: [
        { columns: 0, rows: 0, hex: '00000000', result: 'preserve-both' },
        { columns: 0, rows: 1, hex: '00000100', result: 'HALF_SPECIFIED_GEOMETRY' },
        { columns: 1, rows: 0, hex: '01000000', result: 'HALF_SPECIFIED_GEOMETRY' },
        { columns: 1, rows: 1, hex: '01000100', result: 'valid' },
        { columns: 2000, rows: 1000, hex: 'd007e803', result: 'valid' },
        { columns: 2001, rows: 1000, hex: 'd107e803', result: 'malformed-product' },
        { columns: 32767, rows: 61, hex: 'ff7f3d00', result: 'valid' },
        { columns: 32767, rows: 62, hex: 'ff7f3e00', result: 'malformed-product' },
        { columns: 32768, rows: 1, hex: '00800100', result: 'malformed-dimension' }
      ],
      numeric_sizes: [
        { operand: '0', surface: '-C', result: '0' },
        { operand: '1k', surface: '-C', result: '1024' },
        { operand: '1K', surface: '-C', result: '1024' },
        { operand: '2m', surface: '-C', result: '2097152' },
        { operand: '2M', surface: '-C', result: '2097152' },
        { operand: '3g', surface: '-C', result: '3221225472' },
        { operand: '3G', surface: '-C', result: '3221225472' },
        { operand: '18446744073709551615', surface: '-C', result: '18446744073709551615' },
        { operand: '18014398509481983k', surface: '-C', result: '18446744073709550592' },
        { operand: '18014398509481984k', surface: '-C', result: 'invalid-overflow' },
        { operand: '01k', surface: '-C', result: 'invalid-spelling' },
        { operand: '1kb', surface: '-C', result: 'invalid-spelling' },
        { operand: '1k', surface: 'tail -n', result: 'invalid-unsuffixed-u32' }
      ],
      same_size_redraw: {
        columns: 80,
        rows: 24,
        lease_won: true,
        winch_notifications: 1,
        none_notifications: 0,
        ctrl_l_hex: '0c'
      }
    });
    for (const geometry of entry.geometry) {
      const bytes = fromHex(geometry.hex);
      expect(bytes).toHaveLength(4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getUint16(0, true)).toBe(geometry.columns);
      expect(view.getUint16(2, true)).toBe(geometry.rows);
    }
  });

  it('matches the Moor HELLO frame byte-for-byte', () => {
    const identity = fromHex(
      '01 2F 74 6D 70 2F 2E 6D 6F 6F 72 2D 31 30 30 30 2F 62 75 69 6C 64'
    );
    const request = encodeMoorControllerRequest({ type: 'hello', identity });
    const encoded = new MoorCodec().encode(7, request.kind, request.payload);
    const frozen = vector('V1');
    expect(encoded).toEqual(frozen);
    expect(new MoorCodec().feed(0, frozen)).toEqual([
      { scope: 7, kind: MoorKind.HELLO, payload: request.payload }
    ]);
  });

  it('allows scope zero only for discovery and adopts the acknowledged generation', () => {
    const identity = new TextEncoder().encode('session');
    expect(() =>
      encodeMoorSupervisedRequest(new MoorCodec(), 0, { type: 'hello', identity })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'GENERATION_MISMATCH' }));
    expect(() =>
      encodeMoorSupervisedRequest(new MoorCodec(), 1, { type: 'hello', identity })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'GENERATION_MISMATCH' }));
    expect(() =>
      encodeMoorSupervisedRequest(new MoorCodec(), 2, { type: 'hello', identity })
    ).not.toThrow();
    expect(() => encodeMoorDiscoveryHello(new MoorCodec(), identity)).not.toThrow();

    const incarnation = new Uint8Array(16).fill(1);
    const payload = new Uint8Array(1 + 4 + 16 + 4 + identity.length);
    const view = new DataView(payload.buffer);
    payload[0] = 5;
    view.setUint32(1, 7, true);
    payload.set(incarnation, 5);
    view.setUint32(21, identity.length, true);
    payload.set(identity, 25);
    expect(
      decodeMoorHolderMessage(
        { scope: 7, kind: MoorKind.HELLO_ACK, payload },
        { identity }
      )
    ).toMatchObject({ type: 'hello-ack', generation: 7 });
  });

  it('decodes V25 status geometry from holder truth', () => {
    const [message] = new MoorCodec().feed(0, vector('V25'));
    const identity = fromHex('012f746d702f2e6d6f6f722d313030302f6275696c64');
    const incarnation = fromHex('000102030405060708090a0b0c0d0e0f');

    expect(message).toBeDefined();
    expect(
      decodeMoorHolderMessage(message!, { identity, generation: 7, incarnation })
    ).toMatchObject({
      type: 'status-reply',
      status: { layout: 2, columns: 80, rows: 24 }
    });
  });

  it('rejects frozen-vector header corruption instead of resynchronizing', () => {
    const frame = vector('V33');
    const valid = new MoorCodec();
    (valid as unknown as { nextInboundSequence: number }).nextInboundSequence = 2;
    expect(valid.feed(0, frame)).toEqual([
      { scope: 7, kind: MoorKind.WAKEUP, payload: new Uint8Array() }
    ]);

    const corrupted = frame.slice();
    corrupted[20] ^= 0x01;
    const codec = new MoorCodec();
    (codec as unknown as { nextInboundSequence: number }).nextInboundSequence = 2;
    expect(() => codec.feed(0, corrupted)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
    expect(() => codec.feed(1, frame.subarray(0, MOOR_HEADER_SIZE))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
  });
});
