// Loss-aware browser protocol conformance (spec §7.4). Round-trips all 14 frame
// types and asserts version/type/bounds validation and the signed/BigInt edges.

import { describe, expect, it } from 'vitest';
import {
  BP_MAX_INPUT_BYTES,
  BP_MAX_QUERY_BYTES,
  BP_VERSION,
  BpError,
  BpFrameType,
  BrowserProtocolError,
  type BpFrame,
  decodeBpFrame,
  encodeBpFrame,
  isClientFrame,
  isServerFrame
} from '../src/shared/browserProtocol/index.js';

const bytes = (...v: number[]) => Uint8Array.of(...v);

const SAMPLES: Record<string, BpFrame> = {
  SUBSCRIBE: { type: BpFrameType.SUBSCRIBE, sessionId: 'sess-α', surfaceId: 'main', rows: 40, cols: 120 },
  UNSUBSCRIBE: { type: BpFrameType.UNSUBSCRIBE, channelId: 7 },
  VISIBILITY: { type: BpFrameType.VISIBILITY, channelId: 7, visible: true },
  INPUT: { type: BpFrameType.INPUT, channelId: 7, binary: false, bytes: new TextEncoder().encode('ls -la\r') },
  INPUT_BINARY: { type: BpFrameType.INPUT, channelId: 7, binary: true, bytes: bytes(0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21) },
  RESIZE: { type: BpFrameType.RESIZE, channelId: 7, rows: 50, cols: 200 },
  QUERY_REPLY: { type: BpFrameType.QUERY_REPLY, channelId: 7, queryOffset: 123456789012345n, leaseEpoch: 3, bytes: bytes(0x1b, 0x5b, 0x49) },
  SUBSCRIBE_ACK: { type: BpFrameType.SUBSCRIBE_ACK, channelId: 7, generation: 4, revision: 9 },
  SNAPSHOT: { type: BpFrameType.SNAPSHOT, channelId: 7, generation: 4, revision: 9, offset: 900n, text: '\x1b[H\x1b[2J restored — ★' },
  OUTPUT: { type: BpFrameType.OUTPUT, channelId: 7, generation: 4, revision: 9, offset: 902n, bytes: bytes(0x00, 0xff, 0x1b, 0x5b, 0x41) },
  GAP: { type: BpFrameType.GAP, channelId: 7, from: 902n, to: 1500n },
  EXIT: { type: BpFrameType.EXIT, channelId: 7, code: -1, signal: 15 },
  EXIT_CLEAN: { type: BpFrameType.EXIT, channelId: 7, code: 0, signal: 0 },
  HEARTBEAT: { type: BpFrameType.HEARTBEAT },
  ERROR: { type: BpFrameType.ERROR, channelId: 0, code: BpError.STALE_GENERATION },
  QUERY_REQUEST: { type: BpFrameType.QUERY_REQUEST, channelId: 7, queryOffset: 900n, leaseEpoch: 3, queryBytes: bytes(0x1b, 0x5b, 0x63) }
};

describe('browser protocol — frame round-trip (§7.4)', () => {
  for (const [name, frame] of Object.entries(SAMPLES)) {
    it(`${name} round-trips byte-exactly`, () => {
      const enc = encodeBpFrame(frame);
      expect(enc[0]).toBe(BP_VERSION);
      const dec = decodeBpFrame(enc);
      expect(dec).toEqual(frame);
    });
  }

  it('exit code -1 survives as a signed i32', () => {
    const dec = decodeBpFrame(encodeBpFrame(SAMPLES.EXIT)) as Extract<BpFrame, { type: BpFrameType.EXIT }>;
    expect(dec.code).toBe(-1);
    expect(dec.signal).toBe(15);
  });

  it('u64 offsets survive as BigInt beyond 2^53', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const dec = decodeBpFrame(encodeBpFrame({ type: BpFrameType.OUTPUT, channelId: 1, generation: 1, revision: 1, offset: big, bytes: bytes(1) })) as Extract<BpFrame, { type: BpFrameType.OUTPUT }>;
    expect(dec.offset).toBe(big);
  });
});

describe('browser protocol — direction helpers', () => {
  it('classifies client vs server frame ids', () => {
    expect(isClientFrame(BpFrameType.SUBSCRIBE)).toBe(true);
    expect(isServerFrame(BpFrameType.SUBSCRIBE)).toBe(false);
    expect(isServerFrame(BpFrameType.OUTPUT)).toBe(true);
    expect(isClientFrame(BpFrameType.OUTPUT)).toBe(false);
  });
});

describe('browser protocol — validation', () => {
  it('rejects a bad version', () => {
    const enc = encodeBpFrame(SAMPLES.HEARTBEAT);
    enc[0] = 99;
    expect(() => decodeBpFrame(enc)).toThrow(BrowserProtocolError);
    try {
      decodeBpFrame(enc);
    } catch (e) {
      expect((e as BrowserProtocolError).code).toBe(BpError.BAD_VERSION);
    }
  });

  it('rejects an unknown frame type', () => {
    const enc = Uint8Array.of(BP_VERSION, 200);
    try {
      decodeBpFrame(enc);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserProtocolError);
      expect((e as BrowserProtocolError).code).toBe(BpError.UNKNOWN_TYPE);
    }
  });

  it('rejects a truncated payload', () => {
    const full = encodeBpFrame(SAMPLES.SUBSCRIBE_ACK);
    try {
      decodeBpFrame(full.subarray(0, full.length - 4));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserProtocolError);
      expect((e as BrowserProtocolError).code).toBe(BpError.TRUNCATED);
    }
  });

  it('rejects oversize input on encode', () => {
    const big = new Uint8Array(BP_MAX_INPUT_BYTES + 1);
    expect(() => encodeBpFrame({ type: BpFrameType.INPUT, channelId: 1, binary: true, bytes: big })).toThrow(BrowserProtocolError);
  });

  it('rejects oversize query bytes on encode', () => {
    const big = new Uint8Array(BP_MAX_QUERY_BYTES + 1);
    expect(() => encodeBpFrame({ type: BpFrameType.QUERY_REQUEST, channelId: 1, queryOffset: 0n, leaseEpoch: 0, queryBytes: big })).toThrow(BrowserProtocolError);
  });

  it('preserves 0x00..0xFF output bytes (byte-integrity, §7.8)', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const dec = decodeBpFrame(encodeBpFrame({ type: BpFrameType.OUTPUT, channelId: 1, generation: 1, revision: 1, offset: 0n, bytes: all })) as Extract<BpFrame, { type: BpFrameType.OUTPUT }>;
    expect(Array.from(dec.bytes)).toEqual(Array.from(all));
  });
});
