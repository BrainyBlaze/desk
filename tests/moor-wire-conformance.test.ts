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

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/moor-v4-vectors.json', import.meta.url), 'utf8')
) as Record<string, FrozenVector | Record<string, string>>;

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

describe('Moor v4 frozen wire conformance', () => {
  it('commits all 32 content-verified serialized vectors without truncation', () => {
    const names = Object.keys(corpus).filter((name) => /^V\d+$/u.test(name));
    expect(names).toHaveLength(32);
    for (const name of names) vector(name);
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
    payload[0] = 4;
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
