// SessionManager integration (spec §3.2/§7.1) — the complete daemon-side session
// pipe: ensure a session, attach to a (fake v3) master over a real socket, and
// verify master OUTPUT → browser frame and browser INPUT → master, end to end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameReassembler, encodeFrame, type RawFrame } from '../src/shared/atchWire/codec.js';
import { FrameType, RecordType } from '../src/shared/atchWire/frames.js';
import { decodeBody, encodeBody, encodeRecord, type Body } from '../src/shared/atchWire/messages.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent, type BpFrame } from '../src/shared/runtime/index.js';
import { BpFrameType } from '../src/shared/browserProtocol/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';

const ATTACH_ACK: Body = {
  generation: 1, retained_start_offset: 0n, retained_start_record_seq: 0n, retained_end_offset: 0n, retained_end_record_seq: 0n,
  controller_ack_offset: 0n, controller_ack_record_seq: 0n, has_checkpoint: 0, checkpoint_set_id: 0n, checkpoint_offset: 0n,
  checkpoint_record_seq: 0n, tail_offset: 0n, tail_record_seq: 0n, rows: 40, cols: 120,
  current_state_exact: 1, restart_recoverable: 1, main_exact: 1, alt_exact: 1, active_buffer: 0, caps: 0x3f
};

class FakeMaster {
  server: Server;
  conn: Socket | null = null;
  private ra = new FrameReassembler();
  received: RawFrame[] = [];
  constructor(private sockPath: string) {
    this.server = createServer((sock) => {
      this.conn = sock;
      sock.on('data', (c: Buffer) => {
        for (const f of this.ra.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength))) {
          this.received.push(f);
          if (f.type === FrameType.ATTACH) this.conn!.write(encodeFrame({ type: FrameType.ATTACH_ACK, flags: 0, generation: 1, sequence: 0n, aux: 0n, payload: encodeBody(FrameType.ATTACH_ACK, ATTACH_ACK) }));
        }
      });
    });
  }
  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(this.sockPath, () => r()));
  }
  sendOutput(offset: bigint, seq: bigint, bytes: Uint8Array): void {
    this.conn?.write(encodeFrame({ type: FrameType.RECORD, flags: 0, generation: 1, sequence: seq, aux: offset, payload: encodeRecord({ record_type: RecordType.OUTPUT, record_seq: seq, generation: 1, output_offset: offset, body: bytes }) }));
  }
  inputs(): { bytes: Uint8Array; flags: number }[] {
    return this.received.filter((f) => f.type === FrameType.INPUT).map((f) => decodeBody(FrameType.INPUT, f.payload) as { bytes: Uint8Array; flags: number });
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
    return 'S';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(): () => void {
    return () => {};
  }
  dispose(): void {}
}

const settle = () => new Promise<void>((r) => setTimeout(r, 25));

describe('SessionManager — full daemon-side pipe against a fake master (§7.1)', () => {
  let dir: string;
  let sockPath: string;
  let master: FakeMaster;
  let browserOut: { sessionId: string; channelId: number; frame: BpFrame }[];
  let mgr: SessionManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sm-'));
    sockPath = join(dir, 'session.sock');
    master = new FakeMaster(sockPath);
    await master.listen();
    browserOut = [];
    mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000,
      sendBrowser: (sessionId, channelId, frame) => browserOut.push({ sessionId, channelId, frame })
    });
  });
  afterEach(async () => {
    await master.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensure + attach → master OUTPUT reaches the browser, byte-exact', async () => {
    expect(mgr.ensure('web-1', { rows: 40, cols: 120 }).ok).toBe(true);
    expect(await mgr.attachMaster('web-1', sockPath, { rows: 40, cols: 120 })).toBe(true);
    const ch = mgr.subscribe('web-1', 'main', 40, 120)!;
    browserOut.length = 0;
    await settle();

    master.sendOutput(0n, 1n, new TextEncoder().encode('hi'));
    await settle();
    const out = browserOut.find((x) => x.frame.type === BpFrameType.OUTPUT);
    expect(out?.sessionId).toBe('web-1');
    expect(out?.channelId).toBe(ch);
    expect(new TextDecoder().decode((out!.frame as Extract<BpFrame, { type: BpFrameType.OUTPUT }>).bytes)).toBe('hi');
  });

  it('browser INPUT reaches the master', async () => {
    mgr.ensure('web-1', { rows: 40, cols: 120 });
    await mgr.attachMaster('web-1', sockPath, { rows: 40, cols: 120 });
    const ch = mgr.subscribe('web-1', 'main', 40, 120)!;
    await settle();
    mgr.onBrowserInput('web-1', ch, false, new TextEncoder().encode('ls\r'));
    await settle();
    const inputs = master.inputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(new TextDecoder().decode(inputs[inputs.length - 1].bytes)).toBe('ls\r');
  });

  it('attachMaster refuses an un-ensured session', async () => {
    expect(await mgr.attachMaster('ghost', sockPath, { rows: 1, cols: 1 })).toBe(false);
  });

  it('a validated attach advances an agent from starting/unknown to running/unknown', async () => {
    mgr.ensure('web-1', { rows: 1, cols: 1 }, {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks'
    });
    expect(mgr.stateSnapshot('web-1')).toMatchObject({
      lifecycle: 'starting',
      subject: { kind: 'agent', activity: 'unknown' }
    });

    expect(await mgr.attachMaster('web-1', sockPath, { rows: 1, cols: 1 })).toBe(true);
    expect(mgr.stateSnapshot('web-1')).toMatchObject({
      lifecycle: 'running',
      subject: { kind: 'agent', activity: 'unknown' }
    });
  });
});
