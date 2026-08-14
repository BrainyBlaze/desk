import type { MoorMessage } from './codec.js';
import { MOOR_MAX_MESSAGE_PAYLOAD, MoorWireError } from './schema.js';

export const MoorKind = {
  HELLO: 1,
  HELLO_ACK: 2,
  ATTACH: 3,
  ATTACH_ACK: 4,
  TERMINAL_STATE: 5,
  OUTPUT: 6,
  OUTPUT_ACK: 7,
  GAP: 8,
  INPUT: 9,
  INPUT_RECEIPT: 10,
  RESIZE: 11,
  QUERY_REPLY: 12,
  STATUS: 13,
  STATUS_REPLY: 14,
  TERMINATE: 15,
  TERMINATE_RESULT: 16,
  WAKEUP: 17,
  HEARTBEAT: 18,
  ERROR: 19,
  QUERY: 20,
  LEASE_REQUEST: 21,
  LEASE_RESULT: 22,
  LEASE_RELEASE: 23,
  LEASE_KEEPALIVE: 24,
  LOG_CLEAR: 25,
  LOG_CLEAR_RESULT: 26
} as const;

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const WIDE_MAX = 1 << 20;
const ZERO_16 = new Uint8Array(16);

export type MoorControllerRequest =
  | { readonly type: 'hello'; readonly identity: Uint8Array }
  | {
      readonly type: 'attach';
      readonly columns: number;
      readonly rows: number;
      readonly requestLease: boolean;
      readonly nonVt: boolean;
    }
  | { readonly type: 'output-ack'; readonly sequence: bigint }
  | {
      readonly type: 'input';
      readonly epoch: number;
      readonly requestId: bigint;
      readonly bytes: Uint8Array;
      readonly application?: {
        readonly id: Uint8Array;
        readonly source: Uint8Array;
      };
    }
  | { readonly type: 'resize'; readonly epoch: number; readonly columns: number; readonly rows: number }
  | {
      readonly type: 'query-reply';
      readonly correlation: bigint;
      readonly epoch: number;
      readonly class: number;
      readonly bytes: Uint8Array;
    }
  | { readonly type: 'status' }
  | {
      readonly type: 'terminate';
      readonly identity: Uint8Array;
      readonly generation: number;
      readonly incarnation: Uint8Array;
      readonly force: boolean;
    }
  | {
      readonly type: 'lease-request';
      readonly operation: 'fresh';
      readonly role: 'viewer' | 'input-only';
    }
  | {
      readonly type: 'lease-request';
      readonly operation: 'resume';
      readonly role: 'viewer' | 'input-only';
      readonly epoch: number;
      readonly incarnation: Uint8Array;
      readonly token: Uint8Array;
    }
  | { readonly type: 'lease-release'; readonly epoch: number; readonly token: Uint8Array }
  | { readonly type: 'lease-keepalive'; readonly epoch: number; readonly token: Uint8Array }
  | { readonly type: 'log-clear'; readonly incarnation: Uint8Array; readonly observed: bigint };

export interface EncodedMoorControllerRequest {
  readonly kind: number;
  readonly payload: Uint8Array;
}

export interface MoorFrameEncoder {
  encode(scope: number, kind: number, payload: Uint8Array): Uint8Array;
}

export interface MoorHolderDecodeContext {
  readonly identity?: Uint8Array;
  readonly generation?: number;
  readonly incarnation?: Uint8Array;
}

export interface MoorStatus {
  readonly identity: Uint8Array;
  readonly generation: number;
  readonly incarnation: Uint8Array;
  readonly layout: number;
  readonly eventIdentity: Uint8Array;
  readonly bodySlot: number;
  readonly commitIndex: bigint;
  readonly bodyLength: bigint;
  readonly bodyHash: Uint8Array;
  readonly wallStart: bigint;
  readonly monotonicStart: bigint;
  readonly bootIdentity: Uint8Array;
  readonly directory: Uint8Array;
  readonly pid: number;
  readonly containment: number;
  readonly birthToken: Uint8Array;
  readonly replay: {
    readonly first: bigint;
    readonly last: bigint;
    readonly start: bigint;
    readonly end: bigint;
    readonly complete: boolean;
    readonly modesExact: boolean;
  };
  readonly ownsLease: boolean;
  readonly viewers: boolean;
  readonly running: boolean;
  readonly eventWritable: boolean;
  readonly leaseEpoch: number;
  readonly semanticFlags: number;
  readonly semanticPending: number;
  readonly log: {
    readonly health: number;
    readonly epoch: number;
    readonly index: bigint;
    readonly retainedStart: bigint;
    readonly retainedEnd: bigint;
  };
}

export type MoorHolderMessage =
  | {
      readonly type: 'hello-ack';
      readonly generation: number;
      readonly incarnation: Uint8Array;
      readonly identity: Uint8Array;
    }
  | { readonly type: 'attach-ack'; readonly status: MoorStatus }
  | { readonly type: 'status-reply'; readonly status: MoorStatus }
  | { readonly type: 'terminal-state'; readonly bytes: Uint8Array }
  | { readonly type: 'output'; readonly sequence: bigint; readonly offset: bigint; readonly bytes: Uint8Array }
  | { readonly type: 'gap'; readonly first: bigint; readonly last: bigint }
  | {
      readonly type: 'input-receipt';
      readonly epoch: number;
      readonly requestId: bigint;
      readonly generation: number;
      readonly incarnation: Uint8Array;
      readonly written: bigint;
      readonly status: number;
      readonly result: number;
    }
  | {
      readonly type: 'terminate-result';
      readonly outcome: number;
      readonly containment: number;
      readonly method: number;
      readonly diagnostic: Uint8Array;
    }
  | { readonly type: 'wakeup' }
  | { readonly type: 'heartbeat'; readonly monotonicMs: bigint; readonly flags: number }
  | { readonly type: 'error'; readonly code: number; readonly diagnostic: Uint8Array }
  | {
      readonly type: 'query';
      readonly correlation: bigint;
      readonly epoch: number;
      readonly class: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: 'lease-result';
      readonly outcome: number;
      readonly reason: number;
      readonly role: number;
      readonly epoch: number;
      readonly token: Uint8Array;
    }
  | {
      readonly type: 'log-clear-result';
      readonly outcome: number;
      readonly reason: number;
      readonly epoch: number;
      readonly prior: bigint;
      readonly resulting: bigint;
      readonly cleared: bigint;
    };

export function encodeMoorControllerRequest(
  request: MoorControllerRequest
): EncodedMoorControllerRequest {
  switch (request.type) {
    case 'hello':
      return frame(MoorKind.HELLO, join(ascii('MOOR'), Uint8Array.of(3, 0, 0), wide(request.identity)));
    case 'attach': {
      const flags = Number(request.requestLease) | (Number(request.nonVt) << 1);
      return frame(
        MoorKind.ATTACH,
        join(u16(request.columns), u16(request.rows), Uint8Array.of(flags))
      );
    }
    case 'output-ack':
      return frame(MoorKind.OUTPUT_ACK, u64(request.sequence));
    case 'input': {
      const head = [u32(request.epoch), u64(request.requestId)];
      if (request.application === undefined) {
        return frame(MoorKind.INPUT, join(...head, Uint8Array.of(0), request.bytes));
      }
      const applicationId = identifier(request.application.id, 'application id');
      if (!validSourceId(request.application.source)) malformed('invalid input source id');
      return frame(
        MoorKind.INPUT,
        join(
          ...head,
          Uint8Array.of(1),
          applicationId,
          compact(request.application.source),
          request.bytes
        )
      );
    }
    case 'resize':
      return frame(
        MoorKind.RESIZE,
        join(u32(request.epoch), u16(request.columns), u16(request.rows))
      );
    case 'query-reply':
      assertQuery(request.correlation, request.epoch, request.class, request.bytes);
      return frame(
        MoorKind.QUERY_REPLY,
        join(
          u64(request.correlation),
          u32(request.epoch),
          Uint8Array.of(request.class),
          compact(request.bytes)
        )
      );
    case 'status':
      return frame(MoorKind.STATUS, new Uint8Array());
    case 'terminate':
      return frame(
        MoorKind.TERMINATE,
        join(
          wide(request.identity),
          u32(request.generation),
          exact(request.incarnation, 16, 'incarnation'),
          Uint8Array.of(Number(request.force))
        )
      );
    case 'lease-request': {
      const role = request.role === 'viewer' ? 0 : 1;
      if (request.operation === 'fresh') {
        return frame(MoorKind.LEASE_REQUEST, join(Uint8Array.of(0, role, 0, 0), new Uint8Array(36)));
      }
      if (request.epoch === 0) malformed('resume lease epoch must be positive');
      const incarnation = identifier(request.incarnation, 'incarnation');
      const token = identifier(request.token, 'lease token');
      return frame(
        MoorKind.LEASE_REQUEST,
        join(Uint8Array.of(1, role, 0, 0), u32(request.epoch), incarnation, token)
      );
    }
    case 'lease-release':
      return frame(MoorKind.LEASE_RELEASE, leaseTokenPayload(request.epoch, request.token));
    case 'lease-keepalive':
      return frame(MoorKind.LEASE_KEEPALIVE, leaseTokenPayload(request.epoch, request.token));
    case 'log-clear':
      return frame(
        MoorKind.LOG_CLEAR,
        join(identifier(request.incarnation, 'incarnation'), u64(request.observed))
      );
  }
}

export function encodeMoorSupervisedRequest(
  codec: MoorFrameEncoder,
  generation: number,
  request: MoorControllerRequest
): Uint8Array {
  if (!Number.isInteger(generation) || generation < 2 || generation > 0xffff_ffff) {
    throw new MoorWireError(
      'GENERATION_MISMATCH',
      'supervised Moor requests require generation 2 or greater'
    );
  }
  const encoded = encodeMoorControllerRequest(request);
  return codec.encode(generation, encoded.kind, encoded.payload);
}

export function encodeMoorDiscoveryHello(
  codec: MoorFrameEncoder,
  identity: Uint8Array
): Uint8Array {
  const encoded = encodeMoorControllerRequest({ type: 'hello', identity });
  return codec.encode(0, encoded.kind, encoded.payload);
}

export function decodeMoorHolderMessage(
  message: MoorMessage,
  context: MoorHolderDecodeContext = {}
): MoorHolderMessage {
  if (context.generation !== undefined && message.scope !== context.generation) {
    malformed('holder message scope does not match the expected generation');
  }
  switch (message.kind) {
    case MoorKind.HELLO_ACK:
      return decodeHelloAck(message, context);
    case MoorKind.ATTACH_ACK:
      return { type: 'attach-ack', status: decodeStatus(message.payload, context) };
    case MoorKind.STATUS_REPLY:
      return { type: 'status-reply', status: decodeStatus(message.payload, context) };
    case MoorKind.TERMINAL_STATE: {
      const input = new Reader(message.payload);
      const bytes = input.compact();
      if (bytes.length > 4096) malformed('terminal state exceeds 4096 bytes');
      input.end();
      return { type: 'terminal-state', bytes };
    }
    case MoorKind.OUTPUT: {
      const input = new Reader(message.payload);
      const sequence = input.u64();
      const offset = input.u64();
      const bytes = input.rest();
      if (bytes.length === 0 || bytes.length > 65_536 || offset + BigInt(bytes.length) > U64_MAX) {
        malformed('invalid output payload');
      }
      return { type: 'output', sequence, offset, bytes };
    }
    case MoorKind.GAP: {
      const input = new Reader(message.payload);
      const first = input.u64();
      const last = input.u64();
      input.end();
      if (first === 0n || first > last) malformed('invalid output gap');
      return { type: 'gap', first, last };
    }
    case MoorKind.INPUT_RECEIPT:
      return decodeInputReceipt(message.payload);
    case MoorKind.TERMINATE_RESULT:
      return decodeTerminateResult(message.payload);
    case MoorKind.WAKEUP:
      if (message.payload.length !== 0) malformed('WAKEUP payload must be empty');
      return { type: 'wakeup' };
    case MoorKind.HEARTBEAT: {
      const input = fixedReader(message.payload, 9, 'HEARTBEAT');
      const monotonicMs = input.u64();
      const flags = input.u8();
      if ((flags & ~0x1f) !== 0) malformed('invalid heartbeat flags');
      return { type: 'heartbeat', monotonicMs, flags };
    }
    case MoorKind.ERROR: {
      const input = new Reader(message.payload);
      const code = input.u16();
      const diagnostic = input.compact();
      input.end();
      if (diagnostic.length === 0) malformed('controller error diagnostic must be nonempty');
      return { type: 'error', code, diagnostic };
    }
    case MoorKind.QUERY: {
      const input = new Reader(message.payload);
      const correlation = input.u64();
      const epoch = input.u32();
      const queryClass = input.u8();
      const bytes = input.compact();
      input.end();
      assertQuery(correlation, epoch, queryClass, bytes);
      return { type: 'query', correlation, epoch, class: queryClass, bytes };
    }
    case MoorKind.LEASE_RESULT:
      return decodeLeaseResult(message.payload);
    case MoorKind.LOG_CLEAR_RESULT:
      return decodeLogClearResult(message.payload);
    default:
      throw new MoorWireError('UNKNOWN_TYPE', `unsupported holder message kind ${message.kind}`);
  }
}

function decodeHelloAck(
  message: MoorMessage,
  context: MoorHolderDecodeContext
): Extract<MoorHolderMessage, { type: 'hello-ack' }> {
  if (context.identity === undefined) malformed('HELLO_ACK requires an expected identity');
  const input = new Reader(message.payload);
  const accepted = input.u8();
  const generation = input.u32();
  const incarnation = input.identifier(16);
  const identity = input.wide();
  input.end();
  if (
    accepted !== 3 ||
    generation === 0 ||
    message.scope !== generation ||
    !equal(identity, context.identity) ||
    (context.generation !== undefined && generation !== context.generation)
  ) {
    malformed('HELLO_ACK does not match the requested session');
  }
  return { type: 'hello-ack', generation, incarnation, identity };
}

function decodeStatus(payload: Uint8Array, context: MoorHolderDecodeContext): MoorStatus {
  if (context.identity === undefined || context.generation === undefined || context.incarnation === undefined) {
    malformed('status response requires expected identity, generation, and incarnation');
  }
  const input = new Reader(payload);
  const identity = input.wide();
  const generation = input.u32();
  const incarnation = input.identifier(16);
  const layout = input.u8();
  const eventIdentity = input.wide();
  const bodySlot = input.u8();
  const commitIndex = input.u64();
  const bodyLength = input.u64();
  const bodyHash = input.exact(32);
  const wallStart = input.u64();
  const monotonicStart = input.u64();
  const bootIdentity = input.exact(16);
  const directory = input.wide();
  const pid = input.u32();
  const containment = input.u32();
  const birthToken = input.identifier(16);
  const tail = input.exact(69);
  input.end();

  const identityValid =
    (identity.length >= 2 && identity[0] === 1 && identity[1] === 0x2f) ||
    (identity.length === 25 && identity[0] === 2);
  const commitValid =
    layout === 2
      ? bodySlot <= 1 && commitIndex !== 0n && bodyLength !== 0n && !isZero(bodyHash)
      : bodySlot === 0xff && commitIndex === 0n && bodyLength === 0n && isZero(bodyHash);
  if (
    !identityValid ||
    !equal(identity, context.identity) ||
    generation === 0 ||
    generation !== context.generation ||
    !equal(incarnation, context.incarnation) ||
    layout > 2 ||
    (eventIdentity.length === 0) !== (layout === 0) ||
    !commitValid ||
    directory.length === 0 ||
    pid === 0 ||
    containment === 0
  ) {
    malformed('invalid status descriptor');
  }

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const first = view.getBigUint64(0, true);
  const last = view.getBigUint64(8, true);
  const start = view.getBigUint64(16, true);
  const end = view.getBigUint64(24, true);
  const flags = view.getUint8(32);
  const leaseEpoch = view.getUint32(33, true);
  const semanticFlags = view.getUint8(37);
  const semanticPending = view.getUint16(38, true);
  const health = view.getUint8(40);
  const logEpoch = view.getUint32(41, true);
  const logIndex = view.getBigUint64(45, true);
  const retainedStart = view.getBigUint64(53, true);
  const retainedEnd = view.getBigUint64(61, true);
  const complete = (flags & 1) !== 0;
  const rangeValid =
    (first === 0n && last === 0n && start === end) ||
    (first !== 0n && first <= last && start < end);
  const ownsLease = (flags & 0x10) !== 0;
  const logging = logEpoch !== 0 || logIndex !== 0n || retainedStart !== 0n || retainedEnd !== 0n;
  const extensionValid =
    (health & 0xf0) === 0 &&
    retainedStart <= retainedEnd &&
    (logging ? logEpoch !== 0 && logIndex !== 0n : (health & 1) === 0);
  if (
    (flags & 0x0c) !== 0 ||
    !rangeValid ||
    complete !== (first <= 1n && start === 0n) ||
    (semanticFlags & ~7) !== 0 ||
    semanticPending > 512 ||
    (ownsLease && leaseEpoch === 0) ||
    !extensionValid
  ) {
    malformed('invalid status tail');
  }

  return {
    identity,
    generation,
    incarnation,
    layout,
    eventIdentity,
    bodySlot,
    commitIndex,
    bodyLength,
    bodyHash,
    wallStart,
    monotonicStart,
    bootIdentity,
    directory,
    pid,
    containment,
    birthToken,
    replay: {
      first,
      last,
      start,
      end,
      complete,
      modesExact: (flags & 2) !== 0
    },
    ownsLease,
    viewers: (flags & 0x20) !== 0,
    running: (flags & 0x40) !== 0,
    eventWritable: (flags & 0x80) !== 0,
    leaseEpoch,
    semanticFlags,
    semanticPending,
    log: { health, epoch: logEpoch, index: logIndex, retainedStart, retainedEnd }
  };
}

function decodeInputReceipt(
  payload: Uint8Array
): Extract<MoorHolderMessage, { type: 'input-receipt' }> {
  const input = fixedReader(payload, 43, 'INPUT_RECEIPT');
  const epoch = input.u32();
  const requestId = input.u64();
  const generation = input.u32();
  const incarnation = input.identifier(16);
  const written = input.u64();
  const status = input.u8();
  const result = input.u16();
  if (
    epoch === 0 ||
    requestId === 0n ||
    generation === 0 ||
    !((status === 0 && result === 0) || (status === 1 && result >= 1 && result <= 20))
  ) {
    malformed('invalid input receipt');
  }
  return { type: 'input-receipt', epoch, requestId, generation, incarnation, written, status, result };
}

function decodeTerminateResult(
  payload: Uint8Array
): Extract<MoorHolderMessage, { type: 'terminate-result' }> {
  const input = new Reader(payload);
  const outcome = input.u8();
  const containment = input.u8();
  const method = input.u8();
  const diagnostic = input.compact();
  input.end();
  if (
    outcome > 4 ||
    (containment & ~0x0f) !== 0 ||
    method > 2 ||
    (diagnostic.length === 0) !== (outcome <= 1)
  ) {
    malformed('invalid terminate result');
  }
  return { type: 'terminate-result', outcome, containment, method, diagnostic };
}

function decodeLeaseResult(
  payload: Uint8Array
): Extract<MoorHolderMessage, { type: 'lease-result' }> {
  const input = fixedReader(payload, 24, 'LEASE_RESULT');
  const outcome = input.u8();
  const reason = input.u8();
  const role = input.u8();
  const reserved = input.u8();
  const epoch = input.u32();
  const token = input.exact(16);
  const tokenPresent = !isZero(token);
  const valid =
    outcome <= 3 &&
    reason <= 8 &&
    role <= 1 &&
    reserved === 0 &&
    ((outcome <= 1 && reason === 0 && epoch !== 0 && tokenPresent) ||
      (outcome === 2 && reason === 0 && epoch !== 0 && !tokenPresent) ||
      (outcome === 3 && reason >= 1 && reason <= 7 && !tokenPresent));
  if (!valid) malformed('invalid lease result');
  return { type: 'lease-result', outcome, reason, role, epoch, token };
}

function decodeLogClearResult(
  payload: Uint8Array
): Extract<MoorHolderMessage, { type: 'log-clear-result' }> {
  const input = fixedReader(payload, 32, 'LOG_CLEAR_RESULT');
  const outcome = input.u8();
  const reason = input.u8();
  const reserved = input.u16();
  const epoch = input.u32();
  const prior = input.u64();
  const resulting = input.u64();
  const cleared = input.u64();
  const valid =
    reserved === 0 &&
    ((outcome === 0 && reason === 0 && epoch !== 0) ||
      (outcome === 1 && reason === 0) ||
      (outcome === 2 && reason >= 1 && reason <= 3));
  if (!valid) malformed('invalid log clear result');
  return { type: 'log-clear-result', outcome, reason, epoch, prior, resulting, cleared };
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length > MOOR_MAX_MESSAGE_PAYLOAD) malformed('message payload exceeds controller limit');
  }

  u8(): number {
    return this.exact(1)[0]!;
  }

  u16(): number {
    const bytes = this.exact(2);
    return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true);
  }

  u32(): number {
    const bytes = this.exact(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  u64(): bigint {
    const bytes = this.exact(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }

  exact(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      malformed('truncated payload');
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  identifier(length: number): Uint8Array {
    const value = this.exact(length);
    if (isZero(value)) malformed('identifier must be nonzero');
    return value;
  }

  wide(): Uint8Array {
    const length = this.u32();
    if (length > WIDE_MAX) {
      throw new MoorWireError('OVERSIZED_MESSAGE', 'wide field exceeds 1 MiB');
    }
    return this.exact(length);
  }

  compact(): Uint8Array {
    const length = this.u16();
    if (length > 4096) malformed('compact field exceeds 4096 bytes');
    return this.exact(length);
  }

  rest(): Uint8Array {
    return this.exact(this.bytes.length - this.offset);
  }

  end(): void {
    if (this.offset !== this.bytes.length) malformed('trailing payload bytes');
  }
}

function fixedReader(payload: Uint8Array, length: number, name: string): Reader {
  if (payload.length !== length) malformed(`${name} payload must be exactly ${length} bytes`);
  return new Reader(payload);
}

function frame(kind: number, payload: Uint8Array): EncodedMoorControllerRequest {
  return { kind, payload };
}

function malformed(message: string): never {
  throw new MoorWireError('MALFORMED', message);
}

function numberInRange(value: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) malformed(`${label} is out of range`);
  return value;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, numberInRange(value, 0xffff, 'u16'), true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, numberInRange(value, 0xffff_ffff, 'u32'), true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) malformed('u64 is out of range');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function wide(bytes: Uint8Array): Uint8Array {
  if (bytes.length > WIDE_MAX) {
    throw new MoorWireError('OVERSIZED_MESSAGE', 'wide field exceeds 1 MiB');
  }
  return join(u32(bytes.length), bytes);
}

function compact(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 4096) malformed('compact field exceeds 4096 bytes');
  return join(u16(bytes.length), bytes);
}

function exact(bytes: Uint8Array, length: number, label: string): Uint8Array {
  if (bytes.length !== length) malformed(`${label} must be exactly ${length} bytes`);
  return bytes.slice();
}

function identifier(bytes: Uint8Array, label: string): Uint8Array {
  const value = exact(bytes, 16, label);
  if (isZero(value)) malformed(`${label} must be nonzero`);
  return value;
}

function leaseTokenPayload(epoch: number, token: Uint8Array): Uint8Array {
  if (epoch === 0) malformed('lease epoch must be positive');
  return join(u32(epoch), identifier(token, 'lease token'));
}

function assertQuery(correlation: bigint, epoch: number, queryClass: number, bytes: Uint8Array): void {
  u64(correlation);
  u32(epoch);
  if (correlation === 0n || epoch === 0 || queryClass < 1 || queryClass > 5 || bytes.length > 4096) {
    malformed('invalid query payload');
  }
}

function validSourceId(source: Uint8Array): boolean {
  return (
    source.length > 0 &&
    source.length <= 128 &&
    source.every(
      (byte) =>
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        byte === 0x2e ||
        byte === 0x5f ||
        byte === 0x2d
    )
  );
}

function join(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (!Number.isSafeInteger(length) || length > MOOR_MAX_MESSAGE_PAYLOAD) {
    throw new MoorWireError('OVERSIZED_MESSAGE', 'payload exceeds controller limit');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isZero(bytes: Uint8Array): boolean {
  return equal(bytes, bytes.length === 16 ? ZERO_16 : new Uint8Array(bytes.length));
}
