import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ByteWriter, encodeFrame, FrameReassembler, type RawFrame } from '../src/shared/atchWire/codec.js';
import { FrameType, RecordType } from '../src/shared/atchWire/frames.js';
import { decodeBody, encodeBody, encodeRecord, type Body } from '../src/shared/atchWire/messages.js';
import { BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  type EmulatorEvent,
  type EmulatorPort,
  WorkerSupervisor
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';

const TERMINAL_STATE = 84 as FrameType;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

class TerminalStateMaster {
  readonly server: Server;
  private conn: Socket | null = null;
  private readonly reassembler = new FrameReassembler();
  private readonly received: RawFrame[] = [];

  constructor(
    private readonly sockPath: string,
    private readonly preamble: Uint8Array,
    private readonly ackDelayMs = 0
  ) {
    this.server = createServer((sock) => {
      this.conn = sock;
      sock.on('data', (chunk: Buffer) => {
        for (const frame of this.reassembler.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          this.received.push(frame);
          if (frame.type !== FrameType.ATTACH) continue;

          const terminalState = encodeFrame({
            type: TERMINAL_STATE,
            flags: 0,
            generation: 0,
            sequence: 0n,
            aux: 0n,
            payload: new ByteWriter().blob32(this.preamble).take()
          });
          const attachAck = encodeFrame({
            type: FrameType.ATTACH_ACK,
            flags: 0,
            generation: 0,
            sequence: 1n,
            aux: 0n,
            payload: encodeBody(FrameType.ATTACH_ACK, ATTACH_ACK)
          });
          sock.write(terminalState);
          const sendAck = (): void => {
            if (!sock.destroyed) sock.write(attachAck);
          };
          if (this.ackDelayMs > 0) {
            setTimeout(sendAck, this.ackDelayMs);
          } else {
            sendAck();
          }
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.sockPath, resolve));
  }

  inputs(): Uint8Array[] {
    return this.received
      .filter((frame) => frame.type === FrameType.INPUT)
      .map((frame) => (decodeBody(FrameType.INPUT, frame.payload) as { bytes: Uint8Array }).bytes);
  }

  sendOutput(bytes: Uint8Array): void {
    this.conn?.write(encodeFrame({
      type: FrameType.RECORD,
      flags: 0,
      generation: 1,
      sequence: 2n,
      aux: 0n,
      payload: encodeRecord({
        record_type: RecordType.OUTPUT,
        record_seq: 1n,
        generation: 1,
        output_offset: 0n,
        body: bytes
      })
    }));
  }

  async close(): Promise<void> {
    this.conn?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

class DeferredTerminalEmulator implements EmulatorPort {
  flushCalls = 0;
  private readonly written: number[] = [];
  private pasteMode = false;
  private release: (() => void) | undefined;
  private readonly flushGate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  write(bytes: Uint8Array): void {
    this.written.push(...bytes);
  }

  async flush(): Promise<void> {
    this.flushCalls++;
    await this.flushGate;
    this.pasteMode = decoder.decode(Uint8Array.from(this.written)).includes('\x1b[?2004h');
  }

  releaseFlush(): void {
    this.release?.();
  }

  bracketedPaste(): boolean {
    return this.pasteMode;
  }

  resize(): void {}
  readTailText(): string[] { return []; }
  serialize(): string { return 'S'; }
  cursor(): { row: number; col: number } { return { row: 0, col: 0 }; }
  onEvent(_cb: (event: EmulatorEvent) => void): () => void { return () => {}; }
  dispose(): void {}
}

class RejectingTerminalEmulator extends DeferredTerminalEmulator {
  override async flush(): Promise<void> {
    this.flushCalls++;
    throw new Error('terminal parser flush failed');
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('terminal state during master attach', () => {
  let dir: string;
  let master: TerminalStateMaster;
  let emulator: DeferredTerminalEmulator;
  let manager: SessionManager;
  let browserOut: BpFrame[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'terminal-state-attach-'));
    master = new TerminalStateMaster(join(dir, 'session.sock'), encoder.encode('\x1b[?2004h'));
    await master.listen();
    emulator = new DeferredTerminalEmulator();
    browserOut = [];
    manager = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => emulator },
      now: () => 1_000,
      sendBrowser: (_sessionId, _channelId, frame) => browserOut.push(frame)
    });
  });

  afterEach(async () => {
    emulator.releaseFlush();
    await master.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores parser state before attach without entering the durable output stream', async () => {
    expect(manager.ensure('web-1', { rows: 40, cols: 120 }).ok).toBe(true);
    manager.subscribe('web-1', 'main', 40, 120);
    browserOut.length = 0;

    let attachSettled = false;
    const attach = manager.attachMaster('web-1', join(dir, 'session.sock'), { rows: 40, cols: 120 });
    void attach.then(() => {
      attachSettled = true;
    });
    await waitFor(() => emulator.flushCalls > 0 || attachSettled);
    const settledBeforeFlush = attachSettled;

    emulator.releaseFlush();
    expect(await attach).toBe(true);

    manager.injectInput('web-1', encoder.encode('hello\nworld'), true);
    await waitFor(() => master.inputs().length > 0);
    master.sendOutput(encoder.encode('x'));
    await waitFor(() => browserOut.some((frame) => frame.type === BpFrameType.OUTPUT));
    manager.subscribe('web-1', 'second', 40, 120);

    const pasted = decoder.decode(master.inputs().at(-1));
    const output = browserOut
      .filter((frame): frame is Extract<BpFrame, { type: BpFrameType.OUTPUT }> => frame.type === BpFrameType.OUTPUT)
      .map((frame) => decoder.decode(frame.bytes));
    const snapshot = [...browserOut]
      .reverse()
      .find((frame): frame is Extract<BpFrame, { type: BpFrameType.SNAPSHOT }> => frame.type === BpFrameType.SNAPSHOT);

    expect({
      settledBeforeFlush,
      flushCalls: emulator.flushCalls,
      pasted,
      output,
      snapshotOffset: snapshot?.offset
    }).toEqual({
      settledBeforeFlush: false,
      flushCalls: 1,
      pasted: '\x1b[200~hello\nworld\x1b[201~',
      output: ['x'],
      snapshotOffset: 1n
    });
  });

  it('fails attach cleanly when terminal-state parsing rejects before a delayed ACK', async () => {
    await master.close();
    master = new TerminalStateMaster(join(dir, 'session.sock'), encoder.encode('\x1b[?2004h'), 50);
    await master.listen();
    emulator = new RejectingTerminalEmulator();
    manager = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => emulator },
      now: () => 1_000,
      sendBrowser: () => undefined
    });
    expect(manager.ensure('web-1', { rows: 40, cols: 120 }).ok).toBe(true);

    await expect(
      manager.attachMaster('web-1', join(dir, 'session.sock'), { rows: 40, cols: 120 }, { ackTimeoutMs: 500 })
    ).resolves.toBe(false);
  });
});
