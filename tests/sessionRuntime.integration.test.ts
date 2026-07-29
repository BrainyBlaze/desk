// End-to-end integration (spec §7.1): drive REAL atch-wire records and REAL
// browser-protocol frames through SessionRuntime with a fake emulator, proving
// the five layers compose — master output reaches the browser byte-exact,
// subscribe yields a snapshot, exit propagates, input reaches the master, and a
// typed hook drives BOTH the control-plane state and the delivery confirmation.

import { describe, expect, it } from 'vitest';
import { ByteWriter, type RawFrame } from '../src/shared/atchWire/codec.js';
import { EventType, FrameType, RecordType } from '../src/shared/atchWire/frames.js';
import { type RecordEnvelope, decodeBody } from '../src/shared/atchWire/messages.js';
import { BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
import { InMemoryCmdCache } from '../src/shared/delivery/index.js';
import { SessionRuntime, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';

// A fake emulator that just accumulates written bytes and exposes them as the
// "screen" — enough to prove routing without @xterm/headless.
class FakeEmulator implements EmulatorPort {
  written: number[] = [];
  rows = 24;
  cols = 80;
  write(bytes: Uint8Array): void {
    this.written.push(...bytes);
  }
  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
  }
  readTailText(): string[] {
    return [new TextDecoder().decode(Uint8Array.from(this.written))];
  }
  serialize(): string {
    return `SCREEN[${this.rows}x${this.cols}]:` + new TextDecoder().decode(Uint8Array.from(this.written));
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

interface Harness {
  rt: SessionRuntime;
  emu: FakeEmulator;
  browserOut: { channelId: number; frame: BpFrame }[];
  masterOut: RawFrame[];
  clock: { t: number };
}

function makeHarness(generation = 1): Harness {
  const emu = new FakeEmulator();
  const browserOut: { channelId: number; frame: BpFrame }[] = [];
  const masterOut: RawFrame[] = [];
  const clock = { t: 1_000_000 };
  const rt = new SessionRuntime({
    sessionId: 's1',
    generation,
    emulator: emu,
    cmdCache: new InMemoryCmdCache(),
    now: () => clock.t,
    sendBrowser: (channelId, frame) => browserOut.push({ channelId, frame }),
    sendMaster: (frame) => masterOut.push(frame)
  });
  return { rt, emu, browserOut, masterOut, clock };
}

const outputRecord = (offset: bigint, seq: bigint, bytes: Uint8Array, generation = 1): RecordEnvelope => ({
  record_type: RecordType.OUTPUT,
  record_seq: seq,
  generation,
  output_offset: offset,
  body: bytes
});

describe('SessionRuntime — data plane (master → browser)', () => {
  it('output record reaches the emulator AND every subscriber, byte-exact', () => {
    const h = makeHarness();
    const ch = h.rt.subscribe('main', 40, 120);
    h.browserOut.length = 0; // drop the subscribe ACK+snapshot
    const payload = Uint8Array.of(0x00, 0xff, 0x1b, 0x5b, 0x41); // incl NUL + high byte + ESC
    h.rt.onMasterRecord(outputRecord(900n, 10n, payload));
    // emulator got the raw bytes
    expect(h.emu.written).toEqual([0x00, 0xff, 0x1b, 0x5b, 0x41]);
    // the subscriber got an OUTPUT frame with the SAME bytes + provenance
    expect(h.browserOut).toHaveLength(1);
    const f = h.browserOut[0].frame as Extract<BpFrame, { type: BpFrameType.OUTPUT }>;
    expect(f.type).toBe(BpFrameType.OUTPUT);
    expect(f.channelId).toBe(ch);
    expect(f.generation).toBe(1);
    expect(f.offset).toBe(900n);
    expect(Array.from(f.bytes)).toEqual([0x00, 0xff, 0x1b, 0x5b, 0x41]);
  });

  it('subscribe emits SUBSCRIBE_ACK then a SNAPSHOT at the current offset', () => {
    const h = makeHarness();
    h.rt.onMasterRecord(outputRecord(0n, 1n, new TextEncoder().encode('hello')));
    const ch = h.rt.subscribe('main', 40, 120);
    const [ack, snap] = h.browserOut.map((x) => x.frame);
    expect(ack.type).toBe(BpFrameType.SUBSCRIBE_ACK);
    expect(snap.type).toBe(BpFrameType.SNAPSHOT);
    const s = snap as Extract<BpFrame, { type: BpFrameType.SNAPSHOT }>;
    expect(s.channelId).toBe(ch);
    expect(s.offset).toBe(5n); // 'hello' = 5 bytes emitted before subscribe
    expect(s.text).toContain('hello');
  });

  it('resize record retunes the emulator and bumps the revision', () => {
    const h = makeHarness();
    const body = new ByteWriter().u16(50).u16(200).u32(7).take(); // rows, cols, geometryRev
    h.rt.onMasterRecord({ record_type: RecordType.RESIZE, record_seq: 2n, generation: 1, output_offset: 0n, body });
    expect(h.emu.rows).toBe(50);
    expect(h.emu.cols).toBe(200);
    const ch = h.rt.subscribe('main', 50, 200);
    const ack = h.browserOut.find((x) => x.frame.type === BpFrameType.SUBSCRIBE_ACK)!.frame as Extract<BpFrame, { type: BpFrameType.SUBSCRIBE_ACK }>;
    expect(ack.revision).toBe(7);
    expect(ch).toBe(1);
  });

  it('exit event propagates a browser EXIT frame with signed code', () => {
    const h = makeHarness();
    h.rt.subscribe('main', 40, 120);
    h.browserOut.length = 0;
    const body = new ByteWriter().u8(EventType.EXIT).u32(0xffffffff).u16(15).take(); // code -1, signal 15
    h.rt.onMasterRecord({ record_type: RecordType.EVENT, record_seq: 3n, generation: 1, output_offset: 0n, body });
    const exit = h.browserOut[0].frame as Extract<BpFrame, { type: BpFrameType.EXIT }>;
    expect(exit.type).toBe(BpFrameType.EXIT);
    expect(exit.code).toBe(-1);
    expect(exit.signal).toBe(15);
  });
});

describe('SessionRuntime — browser → master', () => {
  it('browser input becomes a decodable INPUT frame to the master', () => {
    const h = makeHarness();
    const ch = h.rt.subscribe('main', 40, 120);
    h.rt.onBrowserInput(ch, false, new TextEncoder().encode('ls\r'));
    expect(h.masterOut).toHaveLength(1);
    const frame = h.masterOut[0];
    expect(frame.type).toBe(FrameType.INPUT);
    const body = decodeBody(FrameType.INPUT, frame.payload) as { flags: number; surface_id: number; bytes: Uint8Array };
    expect(body.surface_id).toBe(ch);
    expect(body.flags).toBe(0);
    expect(new TextDecoder().decode(body.bytes)).toBe('ls\r');
  });
});

describe('SessionRuntime — delivery confirmation', () => {
  it('confirms an accepted delivery correlation without owning agent state', () => {
    const h = makeHarness();
    // A delivery is in flight: body + submit accepted, awaiting semantic proof.
    const txn = h.rt.openTxn('txn-42', 's1:1:txn-42:body', 's1:1:txn-42:submit');
    h.rt.onBodyAck('txn-42', 'ok');
    h.rt.onSubmitAck('txn-42', 'ok');
    expect(txn.phase).toBe('submit-accepted'); // accepted != delivered

    h.rt.confirmDelivery('txn-42');
    expect(h.rt.txnPhase('txn-42')?.phase).toBe('submit-confirmed'); // delivery
  });
});

describe('SessionRuntime — control-plane input injection + tail (channels delivery)', () => {
  it('injectInput sends an INPUT frame under the reserved surface id 0, byte-exact', () => {
    const h = makeHarness();
    h.rt.injectInput(new TextEncoder().encode('hello channel'));
    expect(h.masterOut).toHaveLength(1);
    expect(h.masterOut[0].type).toBe(FrameType.INPUT);
    const body = decodeBody(FrameType.INPUT, h.masterOut[0].payload) as { surface_id: number; bytes: Uint8Array };
    expect(body.surface_id).toBe(0);
    expect(new TextDecoder().decode(body.bytes)).toBe('hello channel');
  });

  it('paste input stays unwrapped when the app never enabled bracketed paste', () => {
    const h = makeHarness();
    h.rt.injectInput(new TextEncoder().encode('line1\nline2'), true);
    const body = decodeBody(FrameType.INPUT, h.masterOut[0].payload) as { bytes: Uint8Array };
    expect(new TextDecoder().decode(body.bytes)).toBe('line1\nline2');
  });

  it('paste input is bracketed-paste-wrapped when the app enabled the mode', () => {
    class PasteEmulator extends FakeEmulator {
      bracketedPaste(): boolean {
        return true;
      }
    }
    const emu = new PasteEmulator();
    const masterOut: RawFrame[] = [];
    const rt = new SessionRuntime({
      sessionId: 's1',
      generation: 1,
      emulator: emu,
      cmdCache: new InMemoryCmdCache(),
      now: () => 1,
      sendBrowser: () => {},
      sendMaster: (frame) => masterOut.push(frame)
    });
    rt.injectInput(new TextEncoder().encode('line1\nline2'), true);
    const body = decodeBody(FrameType.INPUT, masterOut[0].payload) as { bytes: Uint8Array };
    expect(new TextDecoder().decode(body.bytes)).toBe('\x1b[200~line1\nline2\x1b[201~');
  });

  it('tailText exposes the emulator tail (the capture-pane equivalent)', () => {
    const h = makeHarness();
    h.emu.write(new TextEncoder().encode('screen-tail'));
    expect(h.rt.tailText(5)).toEqual(['screen-tail']);
  });
});
