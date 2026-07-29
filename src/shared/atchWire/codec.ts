// atch v3 wire — reference codec (encode/decode + MORE reassembly).
// Implements docs/atch-wire-v3.md byte-exactly. u64 fields use BigInt end-to-end
// (the contract flags the u64/JSON/BigInt boundary, 8C#7). Pure module.

import {
  ErrorCode,
  Flag,
  FrameType,
  HEADER_LEN,
  MAGIC,
  MAX_MSG,
  MAX_PAYLOAD,
  MAX_STR16,
  PROTO_VERSION,
  RESERVED_FLAG_MASK
} from './frames.js';

/** A decode failure carrying the wire ErrorCode the peer would send. */
export class WireError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(`${ErrorCode[code]}: ${message}`);
    this.name = 'WireError';
  }
}

// ---- LE byte writer ----------------------------------------------------------
export class ByteWriter {
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
    if (b.length !== width) throw new WireError(ErrorCode.INTERNAL, `fixed[${width}] got ${b.length}`);
    return this.bytes(b);
  }
  str16(s: string): this {
    const enc = new TextEncoder().encode(s);
    if (enc.length > MAX_STR16) throw new WireError(ErrorCode.INTERNAL, `str16 len ${enc.length} > ${MAX_STR16}`);
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
export class ByteReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number): void {
    if (this.remaining < n) throw new WireError(ErrorCode.TRUNCATED, `need ${n}, have ${this.remaining}`);
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
    if (n > MAX_MSG) throw new WireError(ErrorCode.PAYLOAD_TOO_LARGE, `blob32 len ${n} > MAX_MSG`);
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
    if (this.remaining !== 0) throw new WireError(ErrorCode.TRUNCATED, `${this.remaining} trailing bytes`);
  }
}

// ---- Frame header ------------------------------------------------------------
export interface FrameHeader {
  type: FrameType;
  flags: number;
  generation: number;
  sequence: bigint;
  aux: bigint;
}

export interface RawFrame extends FrameHeader {
  payload: Uint8Array;
}

export function encodeHeader(h: FrameHeader, payloadLength: number): Uint8Array {
  if (payloadLength > MAX_PAYLOAD) throw new WireError(ErrorCode.PAYLOAD_TOO_LARGE, `payload ${payloadLength}`);
  return new ByteWriter()
    .bytes(MAGIC)
    .u16(PROTO_VERSION)
    .u16(h.type)
    .u32(h.flags >>> 0)
    .u32(payloadLength)
    .u32(h.generation >>> 0)
    .u64(h.sequence)
    .u64(h.aux)
    .take();
}

/** Encode one raw frame (header + payload). */
export function encodeFrame(f: RawFrame): Uint8Array {
  const head = encodeHeader(f, f.payload.length);
  const out = new Uint8Array(head.length + f.payload.length);
  out.set(head, 0);
  out.set(f.payload, head.length);
  return out;
}

/**
 * Decode exactly one frame from `buf`, returning the frame plus bytes consumed,
 * or `null` if the header/payload is not yet fully present (need more bytes).
 * Validates magic/version/payload-length/reserved-flags before allocation.
 */
export function decodeFrame(buf: Uint8Array, strictReserved = false): { frame: RawFrame; consumed: number } | null {
  if (buf.length < HEADER_LEN) return null;
  for (let i = 0; i < 4; i++) if (buf[i] !== MAGIC[i]) throw new WireError(ErrorCode.BAD_MAGIC, 'magic');
  const r = new ByteReader(buf.subarray(4, HEADER_LEN));
  const version = r.u16();
  if (version !== PROTO_VERSION) throw new WireError(ErrorCode.BAD_VERSION, `version ${version}`);
  const type = r.u16() as FrameType;
  const flags = r.u32();
  const payloadLength = r.u32();
  if (payloadLength > MAX_PAYLOAD) throw new WireError(ErrorCode.PAYLOAD_TOO_LARGE, `payload_length ${payloadLength}`);
  if ((flags & RESERVED_FLAG_MASK) !== 0 && (strictReserved || (flags & Flag.STRICT) !== 0)) {
    throw new WireError(ErrorCode.BAD_FLAGS, `reserved flags ${(flags & RESERVED_FLAG_MASK) >>> 0}`);
  }
  const generation = r.u32();
  const sequence = r.u64();
  const aux = r.u64();
  if (buf.length < HEADER_LEN + payloadLength) return null; // need more bytes
  const payload = buf.slice(HEADER_LEN, HEADER_LEN + payloadLength);
  return { frame: { type, flags, generation, sequence, aux, payload }, consumed: HEADER_LEN + payloadLength };
}

/**
 * Stream reassembler: accepts raw bytes, yields whole raw frames, and reassembles
 * MORE-chained same-type runs into one logical frame (contiguous sequence, ≤ MAX_MSG).
 * Aborts a MORE run on sequence gap, type change, or size overflow (WireError TRUNCATED).
 */
export class FrameReassembler {
  private acc = new Uint8Array(0);
  private more: { type: FrameType; parts: Uint8Array[]; total: number; nextSeq: bigint; header: FrameHeader } | null = null;
  constructor(private readonly strictReserved = false) {}

  push(chunk: Uint8Array): RawFrame[] {
    const merged = new Uint8Array(this.acc.length + chunk.length);
    merged.set(this.acc, 0);
    merged.set(chunk, this.acc.length);
    this.acc = merged;
    const out: RawFrame[] = [];
    for (;;) {
      const dec = decodeFrame(this.acc, this.strictReserved);
      if (!dec) break;
      this.acc = this.acc.slice(dec.consumed);
      const f = dec.frame;
      const isMore = (f.flags & Flag.MORE) !== 0;
      if (this.more) {
        if (f.type !== this.more.type) throw new WireError(ErrorCode.TRUNCATED, 'MORE type change');
        if (f.sequence !== this.more.nextSeq) throw new WireError(ErrorCode.BAD_SEQUENCE, 'MORE sequence gap');
        this.more.total += f.payload.length;
        if (this.more.total > MAX_MSG) throw new WireError(ErrorCode.PAYLOAD_TOO_LARGE, 'MORE > MAX_MSG');
        this.more.parts.push(f.payload);
        this.more.nextSeq = f.sequence + 1n;
        if (!isMore) {
          out.push({ ...this.more.header, flags: this.more.header.flags & ~Flag.MORE, payload: concat(this.more.parts) });
          this.more = null;
        }
      } else if (isMore) {
        this.more = { type: f.type, parts: [f.payload], total: f.payload.length, nextSeq: f.sequence + 1n, header: f };
      } else {
        out.push(f);
      }
    }
    return out;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
