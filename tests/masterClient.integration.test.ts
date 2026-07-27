// Daemon master-client integration (spec §7.1/§4). Drives the real MasterClient
// over a unix socket against a FAKE v3 master, proving the handshake + RECORD
// intake + INPUT egress, and the full master→daemon→browser path when wired to a
// SessionRuntime. The real atch binary drops in behind the same socket path once
// its master speaks v3 (@codex's C adapter lane).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameReassembler, encodeFrame, type RawFrame } from '../src/shared/atchWire/codec.js';
import { FrameType, RecordType, Role } from '../src/shared/atchWire/frames.js';
import { decodeBody, encodeBody, encodeRecord, type Body } from '../src/shared/atchWire/messages.js';
import { MasterClient } from '../src/server/runtime/masterClient.js';
import { InMemoryCmdCache } from '../src/shared/delivery/index.js';
import { SessionRuntime, type BpFrame, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { BpFrameType } from '../src/shared/browserProtocol/index.js';

const ATTACH_ACK: Body = {
  generation: 1,
  retained_start_offset: 0n,
  retained_start_record_seq: 0n,
  retained_end_offset: 0n,
  retained_end_record_seq: 0n,
  controller_ack_offset: 0n,
  controller_ack_record_seq: 0n,
  has_checkpoint: 0,
  checkpoint_set_id: 0n,
  checkpoint_offset: 0n,
  checkpoint_record_seq: 0n,
  tail_offset: 0n,
  tail_record_seq: 0n,
  rows: 40,
  cols: 120,
  current_state_exact: 1,
  restart_recoverable: 1,
  main_exact: 1,
  alt_exact: 1,
  active_buffer: 0,
  caps: 0x3f
};

/** A minimal fake atch master speaking v3 over a unix socket. */
class FakeMaster {
  server: Server;
  conn: Socket | null = null;
  received: RawFrame[] = [];
  private ra = new FrameReassembler();
  constructor(private sockPath: string) {
    this.server = createServer((sock) => {
      this.conn = sock;
      sock.on('data', (chunk: Buffer) => {
        for (const f of this.ra.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          this.received.push(f);
          if (f.type === FrameType.ATTACH) this.write({ type: FrameType.ATTACH_ACK, flags: 0, generation: 1, sequence: 0n, aux: 0n, payload: encodeBody(FrameType.ATTACH_ACK, ATTACH_ACK) });
        }
      });
    });
  }
  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(this.sockPath, () => r()));
  }
  write(frame: RawFrame): void {
    this.conn?.write(encodeFrame(frame));
  }
  sendOutput(offset: bigint, seq: bigint, bytes: Uint8Array): void {
    this.write({ type: FrameType.RECORD, flags: 0, generation: 1, sequence: seq, aux: offset, payload: encodeRecord({ record_type: RecordType.OUTPUT, record_seq: seq, generation: 1, output_offset: offset, body: bytes }) });
  }
  inputBodies(): { flags: number; surface_id: number; bytes: Uint8Array }[] {
    return this.received.filter((f) => f.type === FrameType.INPUT).map((f) => decodeBody(FrameType.INPUT, f.payload) as { flags: number; surface_id: number; bytes: Uint8Array });
  }
  async close(): Promise<void> {
    this.conn?.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

class FakeEmu implements EmulatorPort {
  written: number[] = [];
  write(b: Uint8Array): void {
    this.written.push(...b);
  }
  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return 'SCREEN';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

const settle = () => new Promise<void>((r) => setTimeout(r, 20));

describe('master client — v3 handshake + record intake over a real socket (§7.1)', () => {
  let dir: string;
  let sockPath: string;
  let master: FakeMaster;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mc-'));
    sockPath = join(dir, 'session.sock');
    master = new FakeMaster(sockPath);
    await master.listen();
  });
  afterEach(async () => {
    await master.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('handshakes (HELLO+ATTACH → ATTACH_ACK) and receives OUTPUT records', async () => {
    const records: { seq: bigint; bytes: number[] }[] = [];
    let acked: Body | null = null;
    const client = new MasterClient(sockPath, {
      onAttachAck: (ack) => (acked = ack),
      onRecord: (rec) => records.push({ seq: rec.record_seq, bytes: Array.from(rec.body) })
    });
    await client.connect();
    client.handshake({ role: Role.CONTROLLER, sessionId: 'web-1', rows: 40, cols: 120 });
    await settle();
    expect(acked).not.toBeNull();
    expect((acked as unknown as { generation: number }).generation).toBe(1);
    // the fake master received HELLO + ATTACH:
    expect(master.received.map((f) => f.type)).toEqual([FrameType.HELLO, FrameType.ATTACH]);

    master.sendOutput(0n, 1n, Uint8Array.of(0x00, 0xff, 0x41));
    await settle();
    expect(records).toEqual([{ seq: 1n, bytes: [0x00, 0xff, 0x41] }]);
    client.close();
  });

  it('sends INPUT that the master decodes, and preserves the binary flag', async () => {
    const client = new MasterClient(sockPath, {});
    await client.connect();
    client.handshake({ role: Role.CONTROLLER, sessionId: 'web-1', rows: 40, cols: 120 });
    await settle();
    client.sendInput(new TextEncoder().encode('ls\r'), false, 7);
    client.sendInput(Uint8Array.of(0x1b, 0x5b, 0x4d), true, 7);
    await settle();
    const inputs = master.inputBodies();
    expect(inputs).toHaveLength(2);
    expect(new TextDecoder().decode(inputs[0].bytes)).toBe('ls\r');
    expect(inputs[0].flags).toBe(0);
    expect(inputs[1].flags).toBe(1); // binary channel
    client.close();
  });

  it('full path: master OUTPUT → SessionRuntime → browser OUTPUT frame', async () => {
    const emu = new FakeEmu();
    const browserOut: BpFrame[] = [];
    const runtime = new SessionRuntime({
      sessionId: 'web-1',
      generation: 1,
      emulator: emu,
      cmdCache: new InMemoryCmdCache(),
      now: () => 1000,
      sendBrowser: (_ch, frame) => browserOut.push(frame),
      sendMaster: () => {}
    });
    const ch = runtime.subscribe('main', 40, 120);
    browserOut.length = 0;

    const client = new MasterClient(sockPath, { onRecord: (rec) => runtime.onMasterRecord(rec) });
    await client.connect();
    client.handshake({ role: Role.CONTROLLER, sessionId: 'web-1', rows: 40, cols: 120 });
    await settle();

    master.sendOutput(0n, 1n, new TextEncoder().encode('hello'));
    await settle();
    expect(emu.written).toEqual(Array.from(new TextEncoder().encode('hello')));
    const out = browserOut.find((f) => f.type === BpFrameType.OUTPUT) as Extract<BpFrame, { type: BpFrameType.OUTPUT }>;
    expect(out.channelId).toBe(ch);
    expect(new TextDecoder().decode(out.bytes)).toBe('hello');
    client.close();
  });
});
