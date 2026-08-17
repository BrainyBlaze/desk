import { describe, expect, it } from 'vitest';
import {
  MoorKind,
  decodeMoorHolderMessage,
  encodeMoorControllerRequest
} from '../src/shared/moorWire/messages.js';
import { MoorWireError } from '../src/shared/moorWire/schema.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const nonzero = (length: number, value: number): Uint8Array => new Uint8Array(length).fill(value);

function joined(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function integer(value: number | bigint, bytes: 2 | 4 | 8): Uint8Array {
  const result = new Uint8Array(bytes);
  const view = new DataView(result.buffer);
  if (bytes === 2) view.setUint16(0, Number(value), true);
  if (bytes === 4) view.setUint32(0, Number(value), true);
  if (bytes === 8) view.setBigUint64(0, BigInt(value), true);
  return result;
}

const wide = (bytes: Uint8Array): Uint8Array => joined(integer(bytes.length, 4), bytes);
const compact = (bytes: Uint8Array): Uint8Array => joined(integer(bytes.length, 2), bytes);

function validStatusPayload(): {
  payload: Uint8Array;
  identity: Uint8Array;
  incarnation: Uint8Array;
  layoutOffset: number;
  geometryOffset: number;
} {
  const identity = joined(Uint8Array.of(1, 0x2f), text('tmp/session'));
  const eventIdentity = joined(Uint8Array.of(1, 0x2f), text('tmp/session/events'));
  const incarnation = nonzero(16, 0x11);
  const bodyHash = nonzero(32, 0x22);
  const bootIdentity = nonzero(16, 0x33);
  const birthToken = nonzero(16, 0x44);
  const tail = joined(
    integer(1n, 8),
    integer(2n, 8),
    integer(0n, 8),
    integer(12n, 8),
    Uint8Array.of(0xf3),
    integer(3, 4),
    Uint8Array.of(5),
    integer(2, 2),
    Uint8Array.of(1),
    integer(4, 4),
    integer(5n, 8),
    integer(0n, 8),
    integer(12n, 8)
  );
  expect(tail).toHaveLength(69);

  const layoutOffset = 4 + identity.length + 4 + incarnation.length;
  const head = joined(
    wide(identity),
    integer(7, 4),
    incarnation,
    Uint8Array.of(2),
    wide(eventIdentity),
    Uint8Array.of(1),
    integer(9n, 8),
    integer(12n, 8),
    bodyHash,
    integer(100n, 8),
    integer(50n, 8),
    bootIdentity,
    wide(text('/tmp/session')),
    integer(1234, 4),
    integer(5678, 4),
    birthToken
  );
  const geometryOffset = head.length;

  return {
    identity,
    incarnation,
    layoutOffset,
    geometryOffset,
    payload: joined(
      head,
      integer(80, 2),
      integer(24, 2),
      tail
    )
  };
}

describe('Moor controller payload encoder', () => {
  it('encodes the discovery handshake, attach, acknowledgements, and ordinary input', () => {
    const identity = text('session-id');
    expect(encodeMoorControllerRequest({ type: 'hello', identity })).toEqual({
      kind: MoorKind.HELLO,
      payload: joined(text('MOOR'), Uint8Array.of(4, 0, 0), wide(identity))
    });
    expect(
      encodeMoorControllerRequest({
        type: 'attach',
        columns: 80,
        rows: 24,
        requestLease: true,
        nonVt: true
      })
    ).toEqual({ kind: MoorKind.ATTACH, payload: Uint8Array.of(80, 0, 24, 0, 3) });
    expect(encodeMoorControllerRequest({ type: 'output-ack', sequence: 2n ** 60n })).toEqual({
      kind: MoorKind.OUTPUT_ACK,
      payload: integer(2n ** 60n, 8)
    });
    expect(
      encodeMoorControllerRequest({
        type: 'input',
        epoch: 9,
        requestId: 2n ** 61n,
        bytes: Uint8Array.of(0x61, 0x62)
      })
    ).toEqual({
      kind: MoorKind.INPUT,
      payload: joined(integer(9, 4), integer(2n ** 61n, 8), Uint8Array.of(0), Uint8Array.of(0x61, 0x62))
    });
  });

  it('encodes resize, query reply, status, terminate, and log clear byte-for-byte', () => {
    const incarnation = nonzero(16, 0x44);
    expect(
      encodeMoorControllerRequest({ type: 'resize', epoch: 3, columns: 120, rows: 40 })
    ).toEqual({
      kind: MoorKind.RESIZE,
      payload: joined(integer(3, 4), integer(120, 2), integer(40, 2))
    });
    expect(
      encodeMoorControllerRequest({
        type: 'query-reply',
        correlation: 10n,
        epoch: 3,
        class: 5,
        bytes: text('\u001b[1;2R')
      })
    ).toEqual({
      kind: MoorKind.QUERY_REPLY,
      payload: joined(integer(10n, 8), integer(3, 4), Uint8Array.of(5), compact(text('\u001b[1;2R')))
    });
    expect(encodeMoorControllerRequest({ type: 'status' })).toEqual({
      kind: MoorKind.STATUS,
      payload: new Uint8Array()
    });
    expect(
      encodeMoorControllerRequest({
        type: 'terminate',
        identity: text('id'),
        generation: 7,
        incarnation,
        force: true
      })
    ).toEqual({
      kind: MoorKind.TERMINATE,
      payload: joined(wide(text('id')), integer(7, 4), incarnation, Uint8Array.of(1))
    });
    expect(
      encodeMoorControllerRequest({ type: 'log-clear', incarnation, observed: 2n ** 62n })
    ).toEqual({
      kind: MoorKind.LOG_CLEAR,
      payload: joined(incarnation, integer(2n ** 62n, 8))
    });
  });

  it('encodes fresh/resumed lease requests and token operations with exact fixed sizes', () => {
    const incarnation = nonzero(16, 0x51);
    const token = nonzero(16, 0x52);
    const fresh = encodeMoorControllerRequest({
      type: 'lease-request',
      operation: 'fresh',
      role: 'viewer'
    });
    expect(fresh.kind).toBe(MoorKind.LEASE_REQUEST);
    expect(fresh.payload).toEqual(new Uint8Array(40));

    const resumed = encodeMoorControllerRequest({
      type: 'lease-request',
      operation: 'resume',
      role: 'input-only',
      epoch: 8,
      incarnation,
      token
    });
    expect(resumed.payload).toEqual(
      joined(Uint8Array.of(1, 1, 0, 0), integer(8, 4), incarnation, token)
    );
    expect(
      encodeMoorControllerRequest({ type: 'lease-release', epoch: 8, token })
    ).toEqual({ kind: MoorKind.LEASE_RELEASE, payload: joined(integer(8, 4), token) });
    expect(
      encodeMoorControllerRequest({ type: 'lease-keepalive', epoch: 8, token })
    ).toEqual({ kind: MoorKind.LEASE_KEEPALIVE, payload: joined(integer(8, 4), token) });
  });

  it('fails closed on invalid controller payload fields', () => {
    expect(() =>
      encodeMoorControllerRequest({ type: 'resize', epoch: 0, columns: 70_000, rows: 24 })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
    expect(() =>
      encodeMoorControllerRequest({
        type: 'attach',
        columns: 100,
        rows: 30,
        requestLease: false,
        nonVt: false
      })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
    expect(() =>
      encodeMoorControllerRequest({
        type: 'attach',
        columns: 0,
        rows: 0,
        requestLease: false,
        nonVt: false
      })
    ).not.toThrow();
    expect(() =>
      encodeMoorControllerRequest({
        type: 'lease-request',
        operation: 'resume',
        role: 'viewer',
        epoch: 0,
        incarnation: new Uint8Array(16),
        token: new Uint8Array(16)
      })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
  });

  it.each([
    [2000, 1000],
    [32767, 61]
  ] as const)('accepts bounded controller geometry %sx%s', (columns, rows) => {
    expect(() =>
      encodeMoorControllerRequest({
        type: 'attach',
        columns,
        rows,
        requestLease: true,
        nonVt: false
      })
    ).not.toThrow();
    expect(() =>
      encodeMoorControllerRequest({ type: 'resize', epoch: 1, columns, rows })
    ).not.toThrow();
  });

  it.each([
    [2001, 1000],
    [32767, 62],
    [32768, 1],
    [80, 0]
  ] as const)('rejects controller geometry outside the Moor bound: %sx%s', (columns, rows) => {
    expect(() =>
      encodeMoorControllerRequest({
        type: 'attach',
        columns,
        rows,
        requestLease: false,
        nonVt: false
      })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
    expect(() =>
      encodeMoorControllerRequest({ type: 'resize', epoch: 1, columns, rows })
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
  });

  it('preserves the explicit zero-by-zero controller geometry', () => {
    expect(
      encodeMoorControllerRequest({
        type: 'attach',
        columns: 0,
        rows: 0,
        requestLease: false,
        nonVt: false
      }).payload
    ).toEqual(Uint8Array.of(0, 0, 0, 0, 0));
    expect(
      encodeMoorControllerRequest({ type: 'resize', epoch: 1, columns: 0, rows: 0 }).payload
    ).toEqual(joined(integer(1, 4), new Uint8Array(4)));
  });
});

describe('Moor holder payload decoder', () => {
  it('adopts a HELLO_ACK generation only when scope and identity agree', () => {
    const identity = text('session-id');
    const incarnation = nonzero(16, 0x61);
    const payload = joined(Uint8Array.of(4), integer(7, 4), incarnation, wide(identity));
    expect(
      decodeMoorHolderMessage(
        { scope: 7, kind: MoorKind.HELLO_ACK, payload },
        { identity, generation: 7 }
      )
    ).toEqual({ type: 'hello-ack', generation: 7, incarnation, identity });

    const retired = payload.slice();
    retired[0] = 3;
    expect(() =>
      decodeMoorHolderMessage(
        { scope: 7, kind: MoorKind.HELLO_ACK, payload: retired },
        { identity, generation: 7 }
      )
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
    expect(() =>
      decodeMoorHolderMessage(
        { scope: 8, kind: MoorKind.HELLO_ACK, payload },
        { identity, generation: 7 }
      )
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
  });

  it.each([
    [MoorKind.ATTACH_ACK, 'attach-ack'],
    [MoorKind.STATUS_REPLY, 'status-reply']
  ] as const)('routes kind %s through the same exact status decoder', (kind, type) => {
    const { payload, identity, incarnation } = validStatusPayload();
    const decoded = decodeMoorHolderMessage(
      { scope: 7, kind, payload },
      { identity, generation: 7, incarnation }
    );
    expect(decoded).toMatchObject({
      type,
      status: {
        identity,
        generation: 7,
        incarnation,
        layout: 2,
        columns: 80,
        rows: 24,
        bodySlot: 1,
        commitIndex: 9n,
        bodyLength: 12n,
        pid: 1234,
        containment: 5678,
        replay: { first: 1n, last: 2n, start: 0n, end: 12n, complete: true },
        ownsLease: true,
        leaseEpoch: 3,
        log: { health: 1, epoch: 4, index: 5n, retainedStart: 0n, retainedEnd: 12n }
      }
    });
  });

  it('rejects zero status geometry and the retired layout 1 descriptor', () => {
    const { payload, identity, incarnation, geometryOffset, layoutOffset } = validStatusPayload();
    const decode = (candidate: Uint8Array): unknown =>
      decodeMoorHolderMessage(
        { scope: 7, kind: MoorKind.STATUS_REPLY, payload: candidate },
        { identity, generation: 7, incarnation }
      );

    for (const offset of [geometryOffset, geometryOffset + 2]) {
      const zeroed = payload.slice();
      zeroed.fill(0, offset, offset + 2);
      expect(() => decode(zeroed)).toThrowError(
        expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
      );
    }

    const retired = payload.slice();
    retired[layoutOffset] = 1;
    expect(() => decode(retired)).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
  });

  it.each([
    [2001, 1000],
    [32767, 62],
    [32768, 1]
  ] as const)('rejects impossible holder status geometry %sx%s', (columns, rows) => {
    const { payload, identity, incarnation, geometryOffset } = validStatusPayload();
    const invalid = payload.slice();
    const view = new DataView(invalid.buffer, invalid.byteOffset);
    view.setUint16(geometryOffset, columns, true);
    view.setUint16(geometryOffset + 2, rows, true);

    expect(() =>
      decodeMoorHolderMessage(
        { scope: 7, kind: MoorKind.STATUS_REPLY, payload: invalid },
        { identity, generation: 7, incarnation }
      )
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
  });

  it('decodes the complete holder response surface with bigint u64 fields', () => {
    const incarnation = nonzero(16, 0x71);
    const receipt = joined(
      integer(3, 4),
      integer(2n ** 60n, 8),
      integer(7, 4),
      incarnation,
      integer(2n ** 61n, 8),
      Uint8Array.of(0),
      integer(0, 2)
    );
    expect(decodeMoorHolderMessage({ scope: 7, kind: MoorKind.INPUT_RECEIPT, payload: receipt })).toEqual({
      type: 'input-receipt',
      epoch: 3,
      requestId: 2n ** 60n,
      generation: 7,
      incarnation,
      written: 2n ** 61n,
      status: 0,
      result: 0
    });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.TERMINATE_RESULT,
        payload: joined(Uint8Array.of(2, 3, 1), compact(text('failed')))
      })
    ).toEqual({ type: 'terminate-result', outcome: 2, containment: 3, method: 1, diagnostic: text('failed') });
    expect(
      decodeMoorHolderMessage({ scope: 7, kind: MoorKind.WAKEUP, payload: new Uint8Array() })
    ).toEqual({ type: 'wakeup' });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.HEARTBEAT,
        payload: joined(integer(2n ** 62n, 8), Uint8Array.of(0x1f))
      })
    ).toEqual({ type: 'heartbeat', monotonicMs: 2n ** 62n, flags: 0x1f });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.ERROR,
        payload: joined(integer(9, 2), compact(text('lease not held')))
      })
    ).toEqual({ type: 'error', code: 9, diagnostic: text('lease not held') });
  });

  it('decodes terminal, output, gap, query, lease, and log-clear messages', () => {
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.TERMINAL_STATE,
        payload: compact(text('terminal'))
      })
    ).toEqual({ type: 'terminal-state', bytes: text('terminal') });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.OUTPUT,
        payload: joined(integer(2n ** 60n, 8), integer(9n, 8), text('out'))
      })
    ).toEqual({ type: 'output', sequence: 2n ** 60n, offset: 9n, bytes: text('out') });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.GAP,
        payload: joined(integer(1n, 8), integer(4n, 8))
      })
    ).toEqual({ type: 'gap', first: 1n, last: 4n });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.QUERY,
        payload: joined(integer(2n ** 59n, 8), integer(3, 4), Uint8Array.of(1), compact(text('\u001b[c')))
      })
    ).toEqual({ type: 'query', correlation: 2n ** 59n, epoch: 3, class: 1, bytes: text('\u001b[c') });

    const token = nonzero(16, 0x81);
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.LEASE_RESULT,
        payload: joined(Uint8Array.of(0, 0, 1, 0), integer(3, 4), token)
      })
    ).toEqual({ type: 'lease-result', outcome: 0, reason: 0, role: 1, epoch: 3, token });
    expect(
      decodeMoorHolderMessage({
        scope: 7,
        kind: MoorKind.LOG_CLEAR_RESULT,
        payload: joined(
          Uint8Array.of(0, 0, 0, 0),
          integer(3, 4),
          integer(8n, 8),
          integer(9n, 8),
          integer(1n, 8)
        )
      })
    ).toEqual({
      type: 'log-clear-result',
      outcome: 0,
      reason: 0,
      epoch: 3,
      prior: 8n,
      resulting: 9n,
      cleared: 1n
    });
  });

  it.each([
    [MoorKind.WAKEUP, Uint8Array.of(1)],
    [MoorKind.HEARTBEAT, joined(integer(1n, 8), Uint8Array.of(0x20))],
    [MoorKind.ERROR, joined(integer(1, 2), compact(new Uint8Array()))],
    [MoorKind.TERMINATE_RESULT, joined(Uint8Array.of(0, 0, 0), compact(text('unexpected')))],
    [MoorKind.LEASE_RESULT, joined(Uint8Array.of(3, 8, 0, 0), integer(0, 4), new Uint8Array(16))]
  ] as const)('rejects malformed kind %s payloads', (kind, payload) => {
    expect(() => decodeMoorHolderMessage({ scope: 7, kind, payload })).toThrowError(
      expect.objectContaining<MoorWireError>({ code: 'MALFORMED' })
    );
  });
});
