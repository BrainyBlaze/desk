import { describe, expect, it } from 'vitest';
import { MoorCodec } from '../src/shared/moorWire/codec.js';
import {
  MoorKind,
  decodeMoorHolderMessage,
  encodeMoorDiscoveryHello,
  encodeMoorSupervisedRequest,
  encodeMoorControllerRequest
} from '../src/shared/moorWire/messages.js';
import { MoorWireError } from '../src/shared/moorWire/schema.js';

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.trim().split(/\s+/u), (byte) => Number.parseInt(byte, 16));

describe('Moor v3 frozen wire conformance', () => {
  it('matches the Moor HELLO frame byte-for-byte', () => {
    const identity = fromHex(
      '01 2F 74 6D 70 2F 2E 6D 6F 6F 72 2D 31 30 30 30 2F 62 75 69 6C 64'
    );
    const request = encodeMoorControllerRequest({ type: 'hello', identity });
    const encoded = new MoorCodec().encode(7, request.kind, request.payload);
    const frozen = fromHex(`
        4D 4F 4F 52 03 01 00 00 07 00 00 00 01 00 00 00
        21 00 00 00 26 04 0D F1 4D 4F 4F 52 03 00 00 16
        00 00 00 01 2F 74 6D 70 2F 2E 6D 6F 6F 72 2D 31
        30 30 30 2F 62 75 69 6C 64
      `);
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
    payload[0] = 3;
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

  it('rejects frozen-vector header corruption instead of resynchronizing', () => {
    const frame = fromHex(`
      4D 4F 4F 52 03 11 00 00 07 00 00 00 01 00 00 00
      00 00 00 00 23 5C EB 9F
    `);
    expect(new MoorCodec().feed(0, frame)).toEqual([
      { scope: 7, kind: MoorKind.WAKEUP, payload: new Uint8Array() }
    ]);

    const corrupted = frame.slice();
    corrupted[20] ^= 0x01;
    const codec = new MoorCodec();
    expect(() => codec.feed(0, corrupted)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
    expect(() => codec.feed(1, frame)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
  });
});
