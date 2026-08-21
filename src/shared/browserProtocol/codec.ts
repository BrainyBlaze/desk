// Loss-aware browser protocol — reference codec (spec §7.4). Encodes/decodes the
// 14 frame types byte-exactly. Owns its LE byte primitives (ByteWriter /
// ByteReader below); protocol-level validation surfaces as
// BrowserProtocolError with a BpError code the server can echo in an ERROR frame.
import type { MoorExitOutcome } from '../controlPlane/contract.js';
import {
  BP_HEADER_LEN,
  BP_MAX_FRAME_BYTES,
  BP_MAX_INPUT_BYTES,
  BP_MAX_QUERY_BYTES,
  BP_VERSION,
  BpError,
  BpExitKind,
  BpExitMethod,
  BpFrameType
} from './frames.js';

/** Low-level byte codec failure; decodeBpFrame folds it into TRUNCATED. */
class ByteCodecError extends Error {
  constructor(readonly code: 'TRUNCATED' | 'INTERNAL' | 'PAYLOAD_TOO_LARGE', message: string) {
    super(`${code}: ${message}`);
    this.name = 'ByteCodecError';
  }
}

const BYTE_MAX_STR16 = 0xffff;
const BYTE_MAX_BLOB32 = 16 << 20; // 16 MiB blob cap

// ---- LE byte writer ----------------------------------------------------------
class ByteWriter {
  private buf = new Uint8Array(64);
  private len = 0;
  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number): this {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.grow(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    return this;
  }
  u32(v: number): this {
    this.grow(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
    return this;
  }
  u64(v: bigint): this {
    this.grow(8);
    let x = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) {
      this.buf[this.len++] = Number(x & 0xffn);
      x >>= 8n;
    }
    return this;
  }
  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  /** fixed-width binary field (e.g. bytes[16], bytes[32]). */
  fixed(b: Uint8Array, width: number): this {
    if (b.length !== width) throw new ByteCodecError('INTERNAL', `fixed[${width}] got ${b.length}`);
    return this.bytes(b);
  }
  str16(s: string): this {
    const enc = new TextEncoder().encode(s);
    if (enc.length > BYTE_MAX_STR16) throw new ByteCodecError('INTERNAL', `str16 len ${enc.length} > ${BYTE_MAX_STR16}`);
    return this.u16(enc.length).bytes(enc);
  }
  blob32(b: Uint8Array): this {
    return this.u32(b.length).bytes(b);
  }
  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---- LE byte reader ----------------------------------------------------------
class ByteReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number): void {
    if (this.remaining < n) throw new ByteCodecError('TRUNCATED', `need ${n}, have ${this.remaining}`);
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  u16(): number {
    this.need(2);
    return this.buf[this.pos++] | (this.buf[this.pos++] << 8);
  }
  u32(): number {
    this.need(4);
    const v = (this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    let x = 0n;
    for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += 8;
    return x;
  }
  fixed(width: number): Uint8Array {
    this.need(width);
    const out = this.buf.slice(this.pos, this.pos + width);
    this.pos += width;
    return out;
  }
  str16(): string {
    const n = this.u16();
    this.need(n);
    const s = new TextDecoder('utf-8', { fatal: false }).decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  blob32(): Uint8Array {
    const n = this.u32();
    if (n > BYTE_MAX_BLOB32) throw new ByteCodecError('PAYLOAD_TOO_LARGE', `blob32 len ${n} > cap`);
    this.need(n);
    const b = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  rest(): Uint8Array {
    const b = this.buf.slice(this.pos);
    this.pos = this.buf.length;
    return b;
  }
  end(): void {
    if (this.remaining !== 0) throw new ByteCodecError('TRUNCATED', `${this.remaining} trailing bytes`);
  }
}

export class BrowserProtocolError extends Error {
  constructor(readonly code: BpError, message: string) {
    super(`${BpError[code]}: ${message}`);
    this.name = 'BrowserProtocolError';
  }
}

// ---- Typed frame bodies ------------------------------------------------------
export interface Subscribe {
  type: BpFrameType.SUBSCRIBE;
  sessionId: string;
  surfaceId: string;
  rows: number;
  cols: number;
}
export interface Unsubscribe {
  type: BpFrameType.UNSUBSCRIBE;
  channelId: number;
}
export interface Input {
  type: BpFrameType.INPUT;
  channelId: number;
  /** true = onBinary raw bytes; false = onData UTF-8 (§7.6). */
  binary: boolean;
  bytes: Uint8Array;
}
export interface Resize {
  type: BpFrameType.RESIZE;
  channelId: number;
  rows: number;
  cols: number;
}
export interface QueryReply {
  type: BpFrameType.QUERY_REPLY;
  channelId: number;
  queryOffset: bigint;
  leaseEpoch: number;
  bytes: Uint8Array;
}
export interface SubscribeAck {
  type: BpFrameType.SUBSCRIBE_ACK;
  channelId: number;
  generation: number;
  revision: number;
  /** Live output frontier at acknowledgement time. */
  offset: bigint;
}
export interface Snapshot {
  type: BpFrameType.SNAPSHOT;
  channelId: number;
  generation: number;
  revision: number;
  /** Output frontier represented by this current-screen serialization. */
  offset: bigint;
  /** Restorable current screen only; never Moor history or emulator scrollback. */
  text: string;
}
export interface Output {
  type: BpFrameType.OUTPUT;
  channelId: number;
  generation: number;
  revision: number;
  offset: bigint;
  /** Raw output bytes — binary end-to-end, no premature string decode (§7.8). */
  bytes: Uint8Array;
}
export interface Gap {
  type: BpFrameType.GAP;
  channelId: number;
  from: bigint;
  to: bigint;
}
export interface Exit {
  type: BpFrameType.EXIT;
  channelId: number;
  /**
   * The holder's ending exactly as moor reported it — the durable record's own
   * tagged type, carried whole: u8 BpExitKind, then exited -> u32 code + u8
   * method; signalled -> u32 signal + u8 method; unknown -> nothing. An
   * unprovable ending crosses this wire as `unknown`; the frame never folds it
   * into a number.
   */
  outcome: MoorExitOutcome;
}
export interface Heartbeat {
  type: BpFrameType.HEARTBEAT;
}
export interface ErrorFrame {
  type: BpFrameType.ERROR;
  /** channelId 0 = connection-level error. */
  channelId: number;
  code: number;
}
export interface QueryRequest {
  type: BpFrameType.QUERY_REQUEST;
  channelId: number;
  queryOffset: bigint;
  leaseEpoch: number;
  queryBytes: Uint8Array;
}

export type BpFrame =
  | Subscribe
  | Unsubscribe
  | Input
  | Resize
  | QueryReply
  | SubscribeAck
  | Snapshot
  | Output
  | Gap
  | Exit
  | Heartbeat
  | ErrorFrame
  | QueryRequest;

function checkLen(n: number, max: number, what: string): void {
  if (n > max) throw new BrowserProtocolError(BpError.PAYLOAD_TOO_LARGE, `${what} ${n} > ${max}`);
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/** Encode one frame to a single WS binary message (header + payload). */
export function encodeBpFrame(f: BpFrame): Uint8Array {
  const w = new ByteWriter().u8(BP_VERSION).u8(f.type);
  switch (f.type) {
    case BpFrameType.SUBSCRIBE:
      w.str16(f.sessionId).str16(f.surfaceId).u16(f.rows).u16(f.cols);
      break;
    case BpFrameType.UNSUBSCRIBE:
      w.u32(f.channelId);
      break;
    case BpFrameType.INPUT:
      checkLen(f.bytes.length, BP_MAX_INPUT_BYTES, 'input');
      w.u32(f.channelId).u8(f.binary ? 1 : 0).blob32(f.bytes);
      break;
    case BpFrameType.RESIZE:
      w.u32(f.channelId).u16(f.rows).u16(f.cols);
      break;
    case BpFrameType.QUERY_REPLY:
      checkLen(f.bytes.length, BP_MAX_QUERY_BYTES, 'query_reply');
      w.u32(f.channelId).u64(f.queryOffset).u32(f.leaseEpoch).blob32(f.bytes);
      break;
    case BpFrameType.SUBSCRIBE_ACK:
      w.u32(f.channelId).u32(f.generation).u32(f.revision).u64(f.offset);
      break;
    case BpFrameType.SNAPSHOT: {
      const bytes = TEXT_ENCODER.encode(f.text);
      checkLen(bytes.length, BP_MAX_FRAME_BYTES, 'snapshot');
      w.u32(f.channelId).u32(f.generation).u32(f.revision).u64(f.offset).blob32(bytes);
      break;
    }
    case BpFrameType.OUTPUT:
      checkLen(f.bytes.length, BP_MAX_FRAME_BYTES, 'output');
      w.u32(f.channelId).u32(f.generation).u32(f.revision).u64(f.offset).blob32(f.bytes);
      break;
    case BpFrameType.GAP:
      w.u32(f.channelId).u64(f.from).u64(f.to);
      break;
    case BpFrameType.EXIT:
      w.u32(f.channelId);
      encodeExitOutcome(w, f.outcome);
      break;
    case BpFrameType.HEARTBEAT:
      break;
    case BpFrameType.ERROR:
      w.u32(f.channelId).u16(f.code);
      break;
    case BpFrameType.QUERY_REQUEST:
      checkLen(f.queryBytes.length, BP_MAX_QUERY_BYTES, 'query_request');
      w.u32(f.channelId).u64(f.queryOffset).u32(f.leaseEpoch).blob32(f.queryBytes);
      break;
    default: {
      const _exhaustive: never = f;
      throw new BrowserProtocolError(BpError.UNKNOWN_TYPE, `type ${(_exhaustive as { type: number }).type}`);
    }
  }
  return w.take();
}

/** Decode one WS binary message into a typed frame. Validates version/type/bounds. */
export function decodeBpFrame(buf: Uint8Array): BpFrame {
  if (buf.length < BP_HEADER_LEN) throw new BrowserProtocolError(BpError.TRUNCATED, 'header');
  const version = buf[0];
  if (version !== BP_VERSION) throw new BrowserProtocolError(BpError.BAD_VERSION, `version ${version}`);
  const type = buf[1] as BpFrameType;
  const r = new ByteReader(buf.subarray(BP_HEADER_LEN));
  try {
    return decodeBody(type, r);
  } catch (e) {
    if (e instanceof BrowserProtocolError) throw e;
    // ByteReader underflow / low-level errors → uniform TRUNCATED at this layer.
    throw new BrowserProtocolError(BpError.TRUNCATED, (e as Error).message);
  }
}

function decodeBody(type: BpFrameType, r: ByteReader): BpFrame {
  switch (type) {
    case BpFrameType.SUBSCRIBE:
      return { type, sessionId: r.str16(), surfaceId: r.str16(), rows: r.u16(), cols: r.u16() };
    case BpFrameType.UNSUBSCRIBE:
      return { type, channelId: r.u32() };
    case BpFrameType.INPUT: {
      const channelId = r.u32();
      const binary = (r.u8() & 1) !== 0;
      const bytes = r.blob32();
      checkLen(bytes.length, BP_MAX_INPUT_BYTES, 'input');
      return { type, channelId, binary, bytes };
    }
    case BpFrameType.RESIZE:
      return { type, channelId: r.u32(), rows: r.u16(), cols: r.u16() };
    case BpFrameType.QUERY_REPLY: {
      const channelId = r.u32();
      const queryOffset = r.u64();
      const leaseEpoch = r.u32();
      const bytes = r.blob32();
      checkLen(bytes.length, BP_MAX_QUERY_BYTES, 'query_reply');
      return { type, channelId, queryOffset, leaseEpoch, bytes };
    }
    case BpFrameType.SUBSCRIBE_ACK:
      return {
        type,
        channelId: r.u32(),
        generation: r.u32(),
        revision: r.u32(),
        offset: r.u64()
      };
    case BpFrameType.SNAPSHOT: {
      const channelId = r.u32();
      const generation = r.u32();
      const revision = r.u32();
      const offset = r.u64();
      const bytes = r.blob32();
      checkLen(bytes.length, BP_MAX_FRAME_BYTES, 'snapshot');
      return { type, channelId, generation, revision, offset, text: TEXT_DECODER.decode(bytes) };
    }
    case BpFrameType.OUTPUT: {
      const channelId = r.u32();
      const generation = r.u32();
      const revision = r.u32();
      const offset = r.u64();
      const bytes = r.blob32();
      checkLen(bytes.length, BP_MAX_FRAME_BYTES, 'output');
      return { type, channelId, generation, revision, offset, bytes };
    }
    case BpFrameType.GAP:
      return { type, channelId: r.u32(), from: r.u64(), to: r.u64() };
    case BpFrameType.EXIT: {
      const channelId = r.u32();
      return { type, channelId, outcome: decodeExitOutcome(r) };
    }
    case BpFrameType.HEARTBEAT:
      return { type };
    case BpFrameType.ERROR:
      return { type, channelId: r.u32(), code: r.u16() };
    case BpFrameType.QUERY_REQUEST: {
      const channelId = r.u32();
      const queryOffset = r.u64();
      const leaseEpoch = r.u32();
      const queryBytes = r.blob32();
      checkLen(queryBytes.length, BP_MAX_QUERY_BYTES, 'query_request');
      return { type, channelId, queryOffset, leaseEpoch, queryBytes };
    }
    default:
      throw new BrowserProtocolError(BpError.UNKNOWN_TYPE, `type ${type}`);
  }
}

// ---- EXIT outcome (tag + per-kind payload) -----------------------------------
/**
 * moor states `code` and `signal` as u32. A value outside that range is a
 * caller bug and is refused — silently wrapping it would put a DIFFERENT
 * number on the wire, which is the one thing this frame must never do. (POSIX
 * exit codes are 0..255 and signals small positives; the u32 bound is the
 * defensive outer edge, not an invitation to a wider value.)
 */
function checkU32(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new BrowserProtocolError(BpError.INTERNAL, `${what} ${v} is not a u32`);
  }
  return v;
}

function methodByte(method: 'none' | 'graceful' | 'forced'): number {
  switch (method) {
    case 'none':
      return BpExitMethod.NONE;
    case 'graceful':
      return BpExitMethod.GRACEFUL;
    case 'forced':
      return BpExitMethod.FORCED;
  }
}

function encodeExitOutcome(w: ByteWriter, outcome: MoorExitOutcome): void {
  switch (outcome.kind) {
    case 'exited':
      w.u8(BpExitKind.EXITED).u32(checkU32(outcome.code, 'exit code')).u8(methodByte(outcome.method));
      break;
    case 'signalled':
      w.u8(BpExitKind.SIGNALLED).u32(checkU32(outcome.signal, 'exit signal')).u8(methodByte(outcome.method));
      break;
    case 'unknown':
      w.u8(BpExitKind.UNKNOWN);
      break;
    default: {
      const _exhaustive: never = outcome;
      throw new BrowserProtocolError(BpError.INTERNAL, `exit kind ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}

/**
 * A method byte the decoder does not know is refused, never defaulted onto
 * `none` — mapping an unknown method onto "the child ended on its own" would
 * fabricate the holder-intent axis the tag exists to preserve.
 */
function decodeMethod(byte: number): 'none' | 'graceful' | 'forced' {
  switch (byte) {
    case BpExitMethod.NONE:
      return 'none';
    case BpExitMethod.GRACEFUL:
      return 'graceful';
    case BpExitMethod.FORCED:
      return 'forced';
    default:
      throw new BrowserProtocolError(BpError.UNKNOWN_TYPE, `exit method ${byte}`);
  }
}

/** A tag the decoder does not know is refused, never mapped onto some ending. */
function decodeExitOutcome(r: ByteReader): MoorExitOutcome {
  const kind = r.u8();
  switch (kind) {
    case BpExitKind.EXITED:
      return { kind: 'exited', code: r.u32(), method: decodeMethod(r.u8()) };
    case BpExitKind.SIGNALLED:
      return { kind: 'signalled', signal: r.u32(), method: decodeMethod(r.u8()) };
    case BpExitKind.UNKNOWN:
      return { kind: 'unknown' };
    default:
      throw new BrowserProtocolError(BpError.UNKNOWN_TYPE, `exit kind ${kind}`);
  }
}
