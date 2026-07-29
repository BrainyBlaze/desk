// Byte-integrity shipping gate (spec §7.8, §15). The OUTPUT byte stream is
// binary end-to-end — invalid UTF-8 and NUL are preserved to the renderer, and
// no chunk boundary (WS/socket fragmentation) may corrupt or drop a byte. This
// gate feeds a frame carrying all 256 byte values through the reassembler at
// EVERY split boundary and asserts byte-exact reassembly, plus the browser
// OUTPUT frame path.

import { describe, expect, it } from 'vitest';
import { FrameReassembler, encodeFrame, type RawFrame } from '../src/shared/atchWire/codec.js';
import { FrameType } from '../src/shared/atchWire/frames.js';
import { decodeRecord, encodeRecord } from '../src/shared/atchWire/messages.js';
import { BpFrameType, decodeBpFrame, encodeBpFrame, type BpFrame } from '../src/shared/browserProtocol/index.js';

// A torture body: all 256 byte values, plus a lone continuation byte, a lone
// lead byte, an overlong-looking sequence, and embedded NULs — none valid UTF-8.
function tortureBytes(): Uint8Array {
  const all = new Uint8Array(256 + 6);
  for (let i = 0; i < 256; i++) all[i] = i;
  all.set([0x00, 0x80, 0xc0, 0xff, 0x00, 0xf5], 256); // hostile tail
  return all;
}

const outputFrame = (body: Uint8Array): RawFrame => ({
  type: FrameType.RECORD,
  flags: 0,
  generation: 7,
  sequence: 3n,
  aux: 900n,
  payload: encodeRecord({ record_type: 1, record_seq: 40n, generation: 7, output_offset: 900n, body })
});

describe('byte integrity gate — wire reassembler across EVERY split boundary (§7.8)', () => {
  const body = tortureBytes();
  const frame = encodeFrame(outputFrame(body));

  it('reassembles byte-exactly at every 1-byte split boundary', () => {
    for (let split = 0; split <= frame.length; split++) {
      const ra = new FrameReassembler();
      const frames = [...ra.push(frame.subarray(0, split)), ...ra.push(frame.subarray(split))];
      expect(frames, `split@${split}`).toHaveLength(1);
      const rec = decodeRecord(frames[0].payload);
      expect(Array.from(rec.body), `split@${split}`).toEqual(Array.from(body));
    }
  });

  it('reassembles byte-exactly when fed ONE byte at a time (worst case)', () => {
    const ra = new FrameReassembler();
    const out: RawFrame[] = [];
    for (let i = 0; i < frame.length; i++) out.push(...ra.push(frame.subarray(i, i + 1)));
    expect(out).toHaveLength(1);
    expect(Array.from(decodeRecord(out[0].payload).body)).toEqual(Array.from(body));
  });
});

describe('byte integrity gate — browser OUTPUT frame preserves all bytes (§7.8)', () => {
  it('round-trips 0x00..0xFF + hostile tail unchanged', () => {
    const body = tortureBytes();
    const enc = encodeBpFrame({ type: BpFrameType.OUTPUT, channelId: 1, generation: 1, revision: 1, offset: 900n, bytes: body });
    const dec = decodeBpFrame(enc) as Extract<BpFrame, { type: BpFrameType.OUTPUT }>;
    expect(Array.from(dec.bytes)).toEqual(Array.from(body));
  });
});

describe('256-value INPUT gate — both channels preserve all bytes (§7.6, §15)', () => {
  // onBinary (raw mouse/binary channel) must pass 0x00..0xFF 1:1.
  it('onBinary INPUT frame preserves all 256 byte values', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const dec = decodeBpFrame(encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: true, bytes })) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    expect(dec.binary).toBe(true);
    expect(Array.from(dec.bytes)).toEqual(Array.from(bytes));
  });

  // onData (UTF-8 text) round-trips arbitrary UTF-8 including multibyte + control.
  it('onData INPUT frame preserves UTF-8 text bytes incl control chars', () => {
    const text = 'ls -la\r\x1b[A\t§→\u{1f600}';
    const bytes = new TextEncoder().encode(text);
    const dec = decodeBpFrame(encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: false, bytes })) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    expect(dec.binary).toBe(false);
    expect(new TextDecoder().decode(dec.bytes)).toBe(text);
  });

  // The binary flag distinguishes the two channels so provenance is not lost.
  it('the binary flag distinguishes onBinary from onData for identical bytes', () => {
    const bytes = Uint8Array.of(0x1b, 0x5b, 0x41);
    const asBinary = decodeBpFrame(encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: true, bytes })) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    const asData = decodeBpFrame(encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: false, bytes })) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    expect(asBinary.binary).toBe(true);
    expect(asData.binary).toBe(false);
    expect(Array.from(asBinary.bytes)).toEqual(Array.from(asData.bytes));
  });
});
