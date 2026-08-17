// Byte-integrity shipping gate for the BROWSER protocol (spec §7.8, §15).
// The OUTPUT byte stream is binary end-to-end — invalid UTF-8 and NUL are
// preserved to the renderer — and both INPUT channels pass every byte value
// 1:1. Transport-independent: these are the four browser-frame gates salvaged
// from the removed ATV3 byteIntegrity gate (#2b-4 slice 3), minus the ATV3
// wire-reassembler cases that died with that transport.

import { describe, expect, it } from 'vitest';
import {
  BpFrameType,
  decodeBpFrame,
  encodeBpFrame,
  type BpFrame
} from '../src/shared/browserProtocol/index.js';

// A torture body: all 256 byte values, plus a lone continuation byte, a lone
// lead byte, an overlong-looking sequence, and embedded NULs — none valid UTF-8.
function tortureBytes(): Uint8Array {
  const all = new Uint8Array(256 + 6);
  for (let i = 0; i < 256; i++) all[i] = i;
  all.set([0x00, 0x80, 0xc0, 0xff, 0x00, 0xf5], 256); // hostile tail
  return all;
}

describe('byte integrity gate — browser OUTPUT frame preserves all bytes (§7.8)', () => {
  it('round-trips 0x00..0xFF + hostile tail unchanged', () => {
    const body = tortureBytes();
    const enc = encodeBpFrame({
      type: BpFrameType.OUTPUT,
      channelId: 1,
      generation: 1,
      revision: 1,
      offset: 900n,
      bytes: body
    });
    const dec = decodeBpFrame(enc) as Extract<BpFrame, { type: BpFrameType.OUTPUT }>;
    expect(Array.from(dec.bytes)).toEqual(Array.from(body));
  });
});

describe('256-value INPUT gate — both channels preserve all bytes (§7.6, §15)', () => {
  // onBinary (raw mouse/binary channel) must pass 0x00..0xFF 1:1.
  it('onBinary INPUT frame preserves all 256 byte values', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const dec = decodeBpFrame(
      encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: true, bytes })
    ) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    expect(dec.binary).toBe(true);
    expect(Array.from(dec.bytes)).toEqual(Array.from(bytes));
  });

  // onData (UTF-8 text) round-trips arbitrary UTF-8 including multibyte + control.
  it('onData INPUT frame preserves UTF-8 text bytes incl control chars', () => {
    const text = 'ls -la\r\x1b[A\t§→\u{1f600}';
    const bytes = new TextEncoder().encode(text);
    const dec = decodeBpFrame(
      encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: false, bytes })
    ) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    expect(dec.binary).toBe(false);
    expect(new TextDecoder().decode(dec.bytes)).toBe(text);
  });

  // The binary flag itself is load-bearing: the same bytes on the other
  // channel must decode with the flag intact, never coerced.
  it('keeps the binary/text channel distinction intact', () => {
    const bytes = new TextEncoder().encode('plain');
    const asBinary = decodeBpFrame(
      encodeBpFrame({ type: BpFrameType.INPUT, channelId: 2, binary: true, bytes })
    ) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    const asText = decodeBpFrame(
      encodeBpFrame({ type: BpFrameType.INPUT, channelId: 2, binary: false, bytes })
    ) as Extract<BpFrame, { type: BpFrameType.INPUT }>;
    expect(asBinary.binary).toBe(true);
    expect(asText.binary).toBe(false);
    expect(Array.from(asBinary.bytes)).toEqual(Array.from(asText.bytes));
  });
});
