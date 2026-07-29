// Loss-aware browser protocol — reference codec (spec §7.4). Encodes/decodes the
// 14 frame types byte-exactly. Reuses the tested LE primitives (ByteWriter /
// ByteReader) from the atch-wire codec; protocol-level validation surfaces as
// BrowserProtocolError with a BpError code the server can echo in an ERROR frame.

import { ByteReader, ByteWriter } from '../atchWire/codec.js';
import {
  BP_HEADER_LEN,
  BP_MAX_FRAME_BYTES,
  BP_MAX_INPUT_BYTES,
  BP_MAX_QUERY_BYTES,
  BP_VERSION,
  BpError,
  BpFrameType
} from './frames.js';

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
export interface Visibility {
  type: BpFrameType.VISIBILITY;
  channelId: number;
  visible: boolean;
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
}
export interface Snapshot {
  type: BpFrameType.SNAPSHOT;
  channelId: number;
  generation: number;
  revision: number;
  offset: bigint;
  /** SerializeAddon restorable string (§7.3); carried UTF-8 on the wire. */
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
  /** i32 exit code (-1 when signal-terminated). */
  code: number;
  signal: number;
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
  | Visibility
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

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function checkLen(n: number, max: number, what: string): void {
  if (n > max) throw new BrowserProtocolError(BpError.PAYLOAD_TOO_LARGE, `${what} ${n} > ${max}`);
}

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
    case BpFrameType.VISIBILITY:
      w.u32(f.channelId).u8(f.visible ? 1 : 0);
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
      w.u32(f.channelId).u32(f.generation).u32(f.revision);
      break;
    case BpFrameType.SNAPSHOT: {
      const enc = TEXT_ENCODER.encode(f.text);
      checkLen(enc.length, BP_MAX_FRAME_BYTES, 'snapshot');
      w.u32(f.channelId).u32(f.generation).u32(f.revision).u64(f.offset).blob32(enc);
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
      w.u32(f.channelId).u32(f.code >>> 0).u16(f.signal);
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
    case BpFrameType.VISIBILITY:
      return { type, channelId: r.u32(), visible: r.u8() !== 0 };
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
      return { type, channelId: r.u32(), generation: r.u32(), revision: r.u32() };
    case BpFrameType.SNAPSHOT: {
      const channelId = r.u32();
      const generation = r.u32();
      const revision = r.u32();
      const offset = r.u64();
      const text = TEXT_DECODER.decode(r.blob32());
      return { type, channelId, generation, revision, offset, text };
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
    case BpFrameType.EXIT:
      return { type, channelId: r.u32(), code: r.u32() | 0, signal: r.u16() };
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
