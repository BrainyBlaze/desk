import { describe, expect, it } from 'vitest';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import { MoorCodec } from '../src/shared/moorWire/codec.js';
import {
  MOOR_FIXED_PAYLOAD_LENGTHS,
  MOOR_HEADER_SIZE,
  MOOR_MAGIC,
  MOOR_MAX_FRAME_PAYLOAD,
  MOOR_MAX_KIND,
  MOOR_MAX_MESSAGE_PAYLOAD,
  MOOR_MIN_KIND,
  MOOR_VERSION,
  MoorWireError,
  assertMoorKind,
  assertMoorPayloadLength,
  assertMoorScope
} from '../src/shared/moorWire/schema.js';

describe('Moor controller wire schema', () => {
  it('matches the Castagnoli check value', () => {
    expect(crc32c(Buffer.from('123456789', 'ascii'))).toBe(0xe3069283);
  });

  it('exports the frozen controller profile constants', () => {
    expect(Buffer.from(MOOR_MAGIC).toString('ascii')).toBe('MOOR');
    expect(MOOR_VERSION).toBe(3);
    expect(MOOR_HEADER_SIZE).toBe(24);
    expect(MOOR_MAX_FRAME_PAYLOAD).toBe(1 << 20);
    expect(MOOR_MAX_MESSAGE_PAYLOAD).toBe(16 << 20);
    expect([MOOR_MIN_KIND, MOOR_MAX_KIND]).toEqual([1, 0x1a]);
  });

  it('accepts zero scope only for controller HELLO', () => {
    expect(() => assertMoorScope(0, 1)).not.toThrow();
    expect(() => assertMoorScope(0, 2)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'GENERATION_MISMATCH' })
    );
    expect(() => assertMoorScope(7, 2)).not.toThrow();
  });

  it('rejects unknown kinds', () => {
    expect(() => assertMoorKind(0)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'UNKNOWN_TYPE' })
    );
    expect(() => assertMoorKind(0x1b)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'UNKNOWN_TYPE' })
    );
    expect(() => assertMoorKind(1)).not.toThrow();
    expect(() => assertMoorKind(0x1a)).not.toThrow();
  });

  it('matches the frozen fixed-payload map', () => {
    expect([...MOOR_FIXED_PAYLOAD_LENGTHS]).toEqual([
      [10, 43],
      [0x11, 0],
      [0x15, 40],
      [0x16, 24],
      [0x17, 20],
      [0x18, 20],
      [0x19, 24],
      [0x1a, 32]
    ]);
  });

  it('enforces fixed sizes and the controller message limit', () => {
    expect(() => assertMoorPayloadLength(10, 43)).not.toThrow();
    expect(() => assertMoorPayloadLength(10, 42)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
    expect(() => assertMoorPayloadLength(1, MOOR_MAX_MESSAGE_PAYLOAD)).not.toThrow();
    expect(() => assertMoorPayloadLength(1, MOOR_MAX_MESSAGE_PAYLOAD + 1)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'OVERSIZED_MESSAGE' })
    );
  });
});

function headerAt(bytes: Uint8Array, offset = 0): {
  magic: string;
  version: number;
  kind: number;
  more: number;
  reserved: number;
  scope: number;
  sequence: number;
  length: number;
  checksum: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, MOOR_HEADER_SIZE);
  return {
    magic: Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii'),
    version: view.getUint8(4),
    kind: view.getUint8(5),
    more: view.getUint8(6),
    reserved: view.getUint8(7),
    scope: view.getUint32(8, true),
    sequence: view.getUint32(12, true),
    length: view.getUint32(16, true),
    checksum: view.getUint32(20, true)
  };
}

describe('Moor controller frame encoder', () => {
  it('writes the exact 24-byte little-endian header and CRC', () => {
    const codec = new MoorCodec();
    const payload = Uint8Array.of(0xaa, 0xbb, 0xcc);
    const encoded = codec.encode(7, 1, payload);
    const header = headerAt(encoded);

    expect(header).toEqual({
      magic: 'MOOR',
      version: 3,
      kind: 1,
      more: 0,
      reserved: 0,
      scope: 7,
      sequence: 1,
      length: 3,
      checksum: crc32c(encoded.subarray(0, 20))
    });
    expect(encoded.subarray(MOOR_HEADER_SIZE)).toEqual(payload);
  });

  it('owns an outbound sequence that starts at one and advances per frame', () => {
    const codec = new MoorCodec();
    expect(headerAt(codec.encode(7, 1, Uint8Array.of(1))).sequence).toBe(1);
    expect(headerAt(codec.encode(7, 2, Uint8Array.of(2))).sequence).toBe(2);
  });

  it('encodes an empty payload as one frame', () => {
    const encoded = new MoorCodec().encode(7, 0x11, new Uint8Array());
    expect(encoded).toHaveLength(MOOR_HEADER_SIZE);
    expect(headerAt(encoded)).toMatchObject({ kind: 0x11, more: 0, length: 0 });
  });

  it('fragments payloads larger than one frame with one sequence per fragment', () => {
    const payload = new Uint8Array(MOOR_MAX_FRAME_PAYLOAD + 3).fill(0x5a);
    const encoded = new MoorCodec().encode(7, 1, payload);
    const first = headerAt(encoded);
    const secondOffset = MOOR_HEADER_SIZE + MOOR_MAX_FRAME_PAYLOAD;
    const second = headerAt(encoded, secondOffset);

    expect(first).toMatchObject({ kind: 1, more: 1, scope: 7, sequence: 1, length: MOOR_MAX_FRAME_PAYLOAD });
    expect(second).toMatchObject({ kind: 1, more: 0, scope: 7, sequence: 2, length: 3 });
    expect(encoded.subarray(MOOR_HEADER_SIZE, secondOffset)).toEqual(payload.subarray(0, MOOR_MAX_FRAME_PAYLOAD));
    expect(encoded.subarray(secondOffset + MOOR_HEADER_SIZE)).toEqual(payload.subarray(MOOR_MAX_FRAME_PAYLOAD));
  });

  it('rejects invalid scope, kind, size, fixed-size fragmentation, and sequence exhaustion', () => {
    const codec = new MoorCodec();
    expect(() => codec.encode(0, 2, new Uint8Array())).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'GENERATION_MISMATCH' })
    );
    expect(() => codec.encode(7, 0x1b, new Uint8Array())).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'UNKNOWN_TYPE' })
    );
    expect(() => codec.encode(7, 1, new Uint8Array(MOOR_MAX_MESSAGE_PAYLOAD + 1))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'OVERSIZED_MESSAGE' })
    );
    expect(() => codec.encode(7, 10, new Uint8Array(MOOR_MAX_FRAME_PAYLOAD + 1))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );

    (codec as unknown as { nextOutboundSequence: number }).nextOutboundSequence = 0xffffffff;
    expect(() => codec.encode(7, 1, new Uint8Array())).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'RESOURCE_EXHAUSTED' })
    );
  });
});

function rawFrame(options: {
  scope?: number;
  kind?: number;
  more?: number;
  reserved?: number;
  sequence?: number;
  payload?: Uint8Array;
  length?: number;
  magic?: Uint8Array;
  version?: number;
} = {}): Uint8Array {
  const payload = options.payload ?? new Uint8Array();
  const frame = new Uint8Array(MOOR_HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer);
  frame.set(options.magic ?? MOOR_MAGIC, 0);
  view.setUint8(4, options.version ?? MOOR_VERSION);
  view.setUint8(5, options.kind ?? 1);
  view.setUint8(6, options.more ?? 0);
  view.setUint8(7, options.reserved ?? 0);
  view.setUint32(8, options.scope ?? 7, true);
  view.setUint32(12, options.sequence ?? 1, true);
  view.setUint32(16, options.length ?? payload.length, true);
  view.setUint32(20, crc32c(frame.subarray(0, 20)), true);
  frame.set(payload, MOOR_HEADER_SIZE);
  return frame;
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe('Moor controller streaming decoder', () => {
  it('decodes arbitrary chunk boundaries and multiple messages per feed', () => {
    const sender = new MoorCodec();
    const wire = joined(
      sender.encode(7, 1, Uint8Array.of(0xaa)),
      sender.encode(7, 2, Uint8Array.of(0xbb, 0xcc))
    );
    const bytewise = new MoorCodec();
    const messages = [];
    for (let index = 0; index < wire.length; index += 1) {
      messages.push(...bytewise.feed(10, wire.subarray(index, index + 1)));
    }
    expect(messages).toEqual([
      { scope: 7, kind: 1, payload: Uint8Array.of(0xaa) },
      { scope: 7, kind: 2, payload: Uint8Array.of(0xbb, 0xcc) }
    ]);

    expect(new MoorCodec().feed(10, wire)).toEqual(messages);
  });

  it('requires an exact inbound sequence beginning at one', () => {
    expect(() => new MoorCodec().feed(0, rawFrame({ sequence: 2 }))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'BAD_SEQUENCE' })
    );
    expect(() => new MoorCodec().feed(0, rawFrame({ sequence: 0 }))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'BAD_SEQUENCE' })
    );
  });

  it('checksums only the first 20 header bytes', () => {
    const frame = rawFrame({ payload: Uint8Array.of(0x10, 0x20) });
    frame[MOOR_HEADER_SIZE] = 0xff;
    expect(new MoorCodec().feed(0, frame)).toEqual([
      { scope: 7, kind: 1, payload: Uint8Array.of(0xff, 0x20) }
    ]);
  });

  it('reassembles matching fragments into one message', () => {
    const frame1 = rawFrame({ more: 1, sequence: 1, payload: Uint8Array.of(1, 2) });
    const frame2 = rawFrame({ sequence: 2, payload: Uint8Array.of(3, 4) });
    const codec = new MoorCodec();
    expect(codec.feed(0, frame1)).toEqual([]);
    expect(codec.feed(1, frame2)).toEqual([
      { scope: 7, kind: 1, payload: Uint8Array.of(1, 2, 3, 4) }
    ]);
  });

  it('does not refresh the five-second incomplete-frame deadline', () => {
    const frame = rawFrame({ payload: Uint8Array.of(1, 2, 3) });
    const codec = new MoorCodec();
    expect(codec.feed(100, frame.subarray(0, 10))).toEqual([]);
    expect(codec.feed(4_000, frame.subarray(10, 11))).toEqual([]);
    expect(() => codec.expire(5_099)).not.toThrow();
    expect(() => codec.expire(5_100)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'REASSEMBLY_TIMEOUT' })
    );
  });

  it('applies the same five-second deadline to an incomplete fragment run', () => {
    const codec = new MoorCodec();
    expect(codec.feed(50, rawFrame({ more: 1, payload: Uint8Array.of(1) }))).toEqual([]);
    expect(() => codec.expire(5_049)).not.toThrow();
    expect(() => codec.expire(5_050)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'REASSEMBLY_TIMEOUT' })
    );
  });

  it.each([
    ['bad magic', rawFrame({ magic: Uint8Array.of(0, 0, 0, 0) }), 'MALFORMED'],
    ['bad version', rawFrame({ version: 4 }), 'UNKNOWN_VERSION'],
    ['bad reserved byte', rawFrame({ reserved: 1 }), 'MALFORMED'],
    ['bad MORE byte', rawFrame({ more: 2 }), 'MALFORMED'],
    ['zero scope outside HELLO', rawFrame({ scope: 0, kind: 2 }), 'GENERATION_MISMATCH'],
    ['unknown kind', rawFrame({ kind: 0x1b }), 'UNKNOWN_TYPE'],
    [
      'oversized frame declaration',
      rawFrame({ length: MOOR_MAX_FRAME_PAYLOAD + 1 }),
      'OVERSIZED_FRAME'
    ],
    ['fixed-size fragmentation', rawFrame({ kind: 10, more: 1, payload: new Uint8Array(43) }), 'MALFORMED']
  ] as const)('rejects %s', (_name, frame, code) => {
    expect(() => new MoorCodec().feed(0, frame)).toThrowError(
      expect.objectContaining<MoorWireError>({ code })
    );
  });

  it('rejects a bad header CRC', () => {
    const frame = rawFrame();
    frame[20] ^= 0xff;
    expect(() => new MoorCodec().feed(0, frame)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
  });

  it('aborts reassembly when kind or scope changes', () => {
    const changedKind = new MoorCodec();
    changedKind.feed(0, rawFrame({ more: 1, sequence: 1 }));
    expect(() => changedKind.feed(1, rawFrame({ kind: 2, sequence: 2 }))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'REASSEMBLY_ABORTED' })
    );

    const changedScope = new MoorCodec();
    changedScope.feed(0, rawFrame({ more: 1, sequence: 1 }));
    expect(() => changedScope.feed(1, rawFrame({ scope: 8, sequence: 2 }))).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'REASSEMBLY_ABORTED' })
    );
  });

  it('rejects a reassembled message beyond 16 MiB', () => {
    const codec = new MoorCodec();
    const chunk = new Uint8Array(MOOR_MAX_FRAME_PAYLOAD);
    for (let sequence = 1; sequence <= 16; sequence += 1) {
      expect(codec.feed(sequence, rawFrame({ more: 1, sequence, payload: chunk }))).toEqual([]);
    }
    expect(() =>
      codec.feed(17, rawFrame({ sequence: 17, payload: Uint8Array.of(1) }))
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'OVERSIZED_MESSAGE' }));
  });

  it('reports inbound sequence exhaustion', () => {
    const codec = new MoorCodec();
    (codec as unknown as { nextInboundSequence: number }).nextInboundSequence = 0xffffffff;
    expect(() => codec.feed(0, rawFrame())).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'RESOURCE_EXHAUSTED' })
    );
  });

  it('makes a decoder failure terminal instead of resynchronizing', () => {
    const codec = new MoorCodec();
    const frame = rawFrame();
    frame[20] ^= 0xff;
    expect(() => codec.feed(0, frame)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
    expect(() => codec.feed(1, rawFrame())).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
  });
});
