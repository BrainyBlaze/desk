// Conformance tests for the frozen atch v3 wire codec, and generator for the
// shared golden vectors (tests/fixtures/atch-wire/vectors.json) that the atch C
// fork validates against byte-for-byte. Run on node 22 (CI parity).

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  decodeFrame,
  encodeFrame,
  encodeHeader,
  FrameReassembler,
  WireError,
  type RawFrame
} from '../src/shared/atchWire/codec.js';
import { decodeBody, decodeRecord, encodeBody, encodeRecord, type Body } from '../src/shared/atchWire/messages.js';
import {
  ErrorCode,
  Flag,
  FrameType,
  HEADER_LEN,
  MAGIC,
  MAX_PAYLOAD,
  PROTO_VERSION,
  RecordType,
  crc32
} from '../src/shared/atchWire/frames.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const b16 = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);
const b32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const hdr = (type: FrameType, over: Partial<RawFrame> = {}): RawFrame => ({
  type,
  flags: 0,
  generation: 7,
  sequence: 3n,
  aux: 0n,
  payload: new Uint8Array(0),
  ...over
});

/** Canonical sample body per fixed-layout frame — covers every primitive kind. */
const SAMPLE: Partial<Record<FrameType, Body>> = {
  [FrameType.HELLO]: { client_version: 3, peer_role: 1, capabilities: 0x2f, incarnation: b16(0xa1) },
  [FrameType.ATTACH]: { role: 1, prev_generation: 6, last_seen_offset: 1234n, last_seen_record_seq: 56n, desired_rows: 40, desired_cols: 120, sessionId: 'agentdesk-x' },
  [FrameType.ATTACH_ACK]: {
    generation: 7, retained_start_offset: 0n, retained_start_record_seq: 0n, retained_end_offset: 9999n, retained_end_record_seq: 42n,
    controller_ack_offset: 1234n, controller_ack_record_seq: 56n, has_checkpoint: 1, checkpoint_set_id: 88n, checkpoint_offset: 900n,
    checkpoint_record_seq: 40n, tail_offset: 9999n, tail_record_seq: 42n, rows: 40, cols: 120, current_state_exact: 1,
    restart_recoverable: 1, main_exact: 1, alt_exact: 1, active_buffer: 0, caps: 0x2f
  },
  [FrameType.ERROR]: { code: ErrorCode.LEASE_DENIED, detail: 'lease held by conn 4' },
  [FrameType.HEARTBEAT]: {},
  [FrameType.OUTPUT_ACK]: { ack_offset: 65535n, ack_record_seq: 300n },
  [FrameType.INPUT]: { flags: 0, surface_id: 2, bytes: new Uint8Array([0x1b, 0x5b, 0x41]) },
  [FrameType.COMMAND]: { txnId: b16(0x11), step: 0, step_key: b16(0x22), generation: 7, payload_digest: b32(0x33), payload: new TextEncoder().encode('hello world\r') },
  [FrameType.COMMAND_ACK]: { txnId: b16(0x11), step: 0, result: 0 },
  [FrameType.RESIZE]: { lease_epoch: 2, surface_id: 1, generation: 7, rows: 50, cols: 200 },
  [FrameType.LEASE_GRANT]: { granted: 1, owner_conn: 4, lease_epoch: 2, ack_offset: 1234n, ack_record_seq: 56n },
  [FrameType.SIGNAL_REQUEST]: { opId: b16(0x44), signal: 1, escalate_ms: 2000 },
  [FrameType.STATE_UPDATE]: { state_record_seq: 100n, worker_incarnation: b16(0x55), current_state_exact: 0, restart_recoverable: 1, main_exact: 0, alt_exact: 1, active_buffer: 1 },
  [FrameType.CHECKPOINT_GET]: { at_or_before_offset: 18446744073709551615n, at_or_before_record_seq: 42n, snapshot_kind: 0, accepted_format_versions: 1, accepted_patch_versions: 'xterm-6.0+bb1' },
  [FrameType.TERMINAL_REPLY]: { query_id: 77n, generation: 7, lease_epoch: 2, source: 0, query_class: 4, reply: new TextEncoder().encode('\x1b[24;80R') },
  [FrameType.GAP]: { from_offset: 100n, from_record_seq: 10n, to_offset: 200n, to_record_seq: 20n, reason: 1, current_state_exact: 1, restart_recoverable: 0, main_exact: 1, alt_exact: 1, active_buffer: 0 },
  [FrameType.FENCE]: { at_offset: 9999n, at_record_seq: 42n, phase: 0 },
  [FrameType.REDRAW]: { method: 1, rows: 40, cols: 120 }
};

describe('atch v3 wire — header', () => {
  it('round-trips the 36-byte header byte-exactly', () => {
    const raw = hdr(FrameType.HEARTBEAT);
    const bytes = encodeFrame(raw);
    expect(bytes.length).toBe(HEADER_LEN);
    const dec = decodeFrame(bytes)!;
    expect(dec.consumed).toBe(HEADER_LEN);
    expect(dec.frame).toMatchObject({ type: FrameType.HEARTBEAT, generation: 7, sequence: 3n });
  });
  it('rejects bad magic / version / oversized payload_length before allocation', () => {
    const good = encodeFrame(hdr(FrameType.HEARTBEAT));
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => decodeFrame(badMagic)).toThrow(/BAD_MAGIC/);
    const badVer = good.slice();
    badVer[4] = 9;
    expect(() => decodeFrame(badVer)).toThrow(/BAD_VERSION/);
    const oversize = new ByteWriter().bytes(MAGIC).u16(PROTO_VERSION).u16(FrameType.RECORD).u32(0).u32(MAX_PAYLOAD + 1).u32(0).u64(0n).u64(0n).take();
    expect(() => decodeFrame(oversize)).toThrow(/PAYLOAD_TOO_LARGE/);
  });
  it('returns null when the frame is not fully present yet', () => {
    const full = encodeFrame(hdr(FrameType.OUTPUT_ACK, { payload: encodeBody(FrameType.OUTPUT_ACK, SAMPLE[FrameType.OUTPUT_ACK]!) }));
    expect(decodeFrame(full.subarray(0, HEADER_LEN - 1))).toBeNull();
    expect(decodeFrame(full.subarray(0, full.length - 1))).toBeNull();
  });
  it('rejects reserved flags only under STRICT', () => {
    const flags = (1 << 20) | Flag.STRICT;
    const strict = new ByteWriter().bytes(MAGIC).u16(PROTO_VERSION).u16(FrameType.HEARTBEAT).u32(flags).u32(0).u32(0).u64(0n).u64(0n).take();
    expect(() => decodeFrame(strict)).toThrow(/BAD_FLAGS/);
    const lax = new ByteWriter().bytes(MAGIC).u16(PROTO_VERSION).u16(FrameType.HEARTBEAT).u32(1 << 20).u32(0).u32(0).u64(0n).u64(0n).take();
    expect(decodeFrame(lax)).not.toBeNull();
  });
});

describe('atch v3 wire — fixed frame bodies round-trip', () => {
  for (const [t, body] of Object.entries(SAMPLE)) {
    const type = Number(t) as FrameType;
    it(`${FrameType[type]} encode→decode is identity`, () => {
      const payload = encodeBody(type, body);
      const round = decodeBody(type, payload);
      expect(normalize(round)).toEqual(normalize(body));
      // full-frame wrap round-trips too
      const frame = encodeFrame(hdr(type, { payload }));
      const dec = decodeFrame(frame)!.frame;
      expect(normalize(decodeBody(type, dec.payload))).toEqual(normalize(body));
    });
  }
});

describe('atch v3 wire — RECORD envelope', () => {
  it('round-trips an OUTPUT record with crc', () => {
    const rec = { record_type: RecordType.OUTPUT, record_seq: 42n, generation: 7, output_offset: 9999n, body: new TextEncoder().encode('ls -la\r\n') };
    const enc = encodeRecord(rec);
    expect(decodeRecord(enc)).toEqual(rec);
  });
  it('rejects a corrupted record (crc mismatch)', () => {
    const enc = encodeRecord({ record_type: RecordType.OUTPUT, record_seq: 1n, generation: 1, output_offset: 0n, body: Uint8Array.of(1, 2, 3) });
    enc[enc.length - 6] ^= 0xff; // flip a body byte, crc no longer matches
    expect(() => decodeRecord(enc)).toThrow(/crc/);
  });
});

describe('atch v3 wire — MORE reassembly', () => {
  it('reassembles a 2-fragment blob message', () => {
    const p1 = Uint8Array.of(1, 2, 3);
    const p2 = Uint8Array.of(4, 5);
    const fr1 = encodeFrame(hdr(FrameType.RECORD, { flags: Flag.MORE, sequence: 10n, payload: p1 }));
    const fr2 = encodeFrame(hdr(FrameType.RECORD, { flags: 0, sequence: 11n, payload: p2 }));
    const ra = new FrameReassembler();
    expect(ra.push(fr1)).toHaveLength(0);
    const out = ra.push(fr2);
    expect(out).toHaveLength(1);
    expect(hex(out[0].payload)).toBe('0102030405');
  });
  it('aborts on a MORE sequence gap', () => {
    const fr1 = encodeFrame(hdr(FrameType.RECORD, { flags: Flag.MORE, sequence: 10n, payload: Uint8Array.of(1) }));
    const fr2 = encodeFrame(hdr(FrameType.RECORD, { flags: 0, sequence: 12n, payload: Uint8Array.of(2) }));
    const ra = new FrameReassembler();
    ra.push(fr1);
    expect(() => ra.push(fr2)).toThrow(/BAD_SEQUENCE/);
  });
  it('aborts on a MORE type change', () => {
    const fr1 = encodeFrame(hdr(FrameType.RECORD, { flags: Flag.MORE, sequence: 10n, payload: Uint8Array.of(1) }));
    const fr2 = encodeFrame(hdr(FrameType.INPUT, { flags: 0, sequence: 11n, payload: Uint8Array.of(2) }));
    const ra = new FrameReassembler();
    ra.push(fr1);
    expect(() => ra.push(fr2)).toThrow(/type change/);
  });
});

describe('atch v3 wire — u64 boundary (BigInt) fidelity', () => {
  for (const v of [0n, 1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 64n - 1n]) {
    it(`preserves u64 ${v}`, () => {
      const enc = new ByteWriter().u64(v).take();
      expect(new ByteReader(enc).u64()).toBe(v);
    });
  }
  it('crc32 matches a known vector', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });
});

// ---- Golden-vector fixture generation ---------------------------------------
describe('golden vectors', () => {
  it('emits tests/fixtures/atch-wire/vectors.json for cross-lane (C) conformance', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'atch-wire');
    mkdirSync(dir, { recursive: true });
    const valid = Object.entries(SAMPLE).map(([t, body]) => {
      const type = Number(t) as FrameType;
      const frame = encodeFrame(hdr(type, { payload: encodeBody(type, body) }));
      return { name: FrameType[type], type, generation: 7, sequence: '3', body: jsonBody(body), frameHex: hex(frame) };
    });
    const invalid = [
      { name: 'bad_magic', hex: hex(flip(encodeFrame(hdr(FrameType.HEARTBEAT)), 0)), expectCode: ErrorCode.BAD_MAGIC },
      { name: 'bad_version', hex: hex(setByte(encodeFrame(hdr(FrameType.HEARTBEAT)), 4, 9)), expectCode: ErrorCode.BAD_VERSION }
    ];
    writeFileSync(join(dir, 'vectors.json'), JSON.stringify({ contract: 'atch-wire-v3', proto_version: PROTO_VERSION, header_len: HEADER_LEN, valid, invalid }, null, 2) + '\n');
    expect(valid.length).toBeGreaterThanOrEqual(18);
  });
});

// helpers
function normalize(b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) out[k] = v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? v.toString() : v;
  return out;
}
function jsonBody(b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) out[k] = v instanceof Uint8Array ? { $hex: hex(v) } : typeof v === 'bigint' ? { $u64: v.toString() } : v;
  return out;
}
function flip(b: Uint8Array, i: number): Uint8Array {
  const c = b.slice();
  c[i] ^= 0xff;
  return c;
}
function setByte(b: Uint8Array, i: number, v: number): Uint8Array {
  const c = b.slice();
  c[i] = v;
  return c;
}
