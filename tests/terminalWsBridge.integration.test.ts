// Binary terminal WS bridge integration (spec §7.4). Drives the bridge over a
// REAL ws socket + http upgrade: proves the transport layer wires
// TerminalWsRouter end-to-end (SUBSCRIBE → ACK+SNAPSHOT, RESIZE reaches the
// emulator, per-connection ownership rejection, unknown-session error, close
// cleanup) — the piece the in-process router unit test cannot cover.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { TerminalWsRouter } from '../src/server/runtime/terminalWsRouter.js';
import { installTerminalWsBridge } from '../src/server/terminalWsBridge.js';
import { BpError, BpFrameType, decodeBpFrame, encodeBpFrame, type BpFrame } from '../src/shared/browserProtocol/index.js';

const emus: FakeEmu[] = [];
class FakeEmu implements EmulatorPort {
  resizes: { rows: number; cols: number }[] = [];
  constructor() {
    emus.push(this);
  }
  write(): void {}
  resize(rows: number, cols: number): void {
    this.resizes.push({ rows, cols });
  }
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

/** A connected client that decodes every inbound binary frame and lets a test await one. */
class Client {
  readonly frames: BpFrame[] = [];
  private waiters: (() => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data: RawData) => {
      this.frames.push(decodeBpFrame(rawToBytes(data)));
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Client(ws);
  }
  send(frame: BpFrame): void {
    this.ws.send(encodeBpFrame(frame));
  }
  /** Resolve once a frame matching the predicate has arrived (or throw on timeout). */
  async waitFor(pred: (f: BpFrame) => boolean, ms = 1000): Promise<BpFrame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) {
        return hit;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for frame');
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }
  close(): void {
    this.ws.close();
  }
}

describe('terminal WS bridge integration (§7.4)', () => {
  let server: Server;
  let router: TerminalWsRouter;
  let dispose: () => void;
  let port: number;
  const clients: Client[] = [];

  beforeEach(async () => {
    emus.length = 0;
    router = new TerminalWsRouter({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000,
      // This bridge-only suite has no durable Moor store; acknowledge the
      // production-required recovery gate explicitly.
      onLateMoorAdoption: async () => true
    });
    router.sessions.ensure('s1', { rows: 40, cols: 120 });
    server = createServer();
    dispose = installTerminalWsBridge(server, router);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      c.close();
    }
    dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = async (): Promise<Client> => {
    const c = await Client.open(port);
    clients.push(c);
    return c;
  };

  it('routes SUBSCRIBE to ACK then current-screen baseline over the real socket', async () => {
    const c = await open();
    c.send({ type: BpFrameType.SUBSCRIBE, sessionId: 's1', surfaceId: 'main', rows: 40, cols: 120 });
    const ackFrame = await c.waitFor((f) => f.type === BpFrameType.SUBSCRIBE_ACK);
    expect(ackFrame).toMatchObject({
      type: BpFrameType.SUBSCRIBE_ACK,
      channelId: 1,
      offset: 0n
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(c.frames.map((frame) => frame.type)).toEqual([
      BpFrameType.SUBSCRIBE_ACK,
      BpFrameType.SNAPSHOT
    ]);
  });

  it('routes RESIZE through to the session emulator', async () => {
    const c = await open();
    c.send({ type: BpFrameType.SUBSCRIBE, sessionId: 's1', surfaceId: 'main', rows: 40, cols: 120 });
    const ackFrame = await c.waitFor((f) => f.type === BpFrameType.SUBSCRIBE_ACK);
    const channelId = (ackFrame as Extract<BpFrame, { type: BpFrameType.SUBSCRIBE_ACK }>).channelId;
    c.send({ type: BpFrameType.RESIZE, channelId, rows: 24, cols: 80 });
    // Poll the emulator (the resize round-trips through the socket asynchronously).
    await vi_poll(() => emus[0].resizes.some((r) => r.rows === 24 && r.cols === 80));
    expect(emus[0].resizes).toContainEqual({ rows: 24, cols: 80 });
  });

  it('rejects INPUT on a channel owned by a different connection', async () => {
    const a = await open();
    a.send({ type: BpFrameType.SUBSCRIBE, sessionId: 's1', surfaceId: 'main', rows: 40, cols: 120 });
    const ackFrame = await a.waitFor((f) => f.type === BpFrameType.SUBSCRIBE_ACK);
    const channelId = (ackFrame as Extract<BpFrame, { type: BpFrameType.SUBSCRIBE_ACK }>).channelId;
    const b = await open();
    b.send({ type: BpFrameType.INPUT, channelId, binary: false, bytes: Uint8Array.of(120) });
    const err = await b.waitFor((f) => f.type === BpFrameType.ERROR);
    expect((err as Extract<BpFrame, { type: BpFrameType.ERROR }>).code).toBe(BpError.BAD_CHANNEL);
  });

  it('returns an error for a SUBSCRIBE to an unknown session', async () => {
    const c = await open();
    c.send({ type: BpFrameType.SUBSCRIBE, sessionId: 'ghost', surfaceId: 'main', rows: 40, cols: 120 });
    const err = await c.waitFor((f) => f.type === BpFrameType.ERROR);
    expect((err as Extract<BpFrame, { type: BpFrameType.ERROR }>).code).toBe(BpError.BAD_CHANNEL);
  });

  it('cleans up a connection on close so its channel is released', async () => {
    const a = await open();
    a.send({ type: BpFrameType.SUBSCRIBE, sessionId: 's1', surfaceId: 'main', rows: 40, cols: 120 });
    await a.waitFor((f) => f.type === BpFrameType.SUBSCRIBE_ACK);
    a.close();
    await vi_poll(() => router.sessions.sessionOfChannel(1) === undefined);
    expect(router.sessions.sessionOfChannel(1)).toBeUndefined();
  });
});

/** Normalize a ws RawData payload (ArrayBuffer under binaryType 'arraybuffer', else Buffer) to bytes. */
function rawToBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data as Buffer);
}

/** Poll a predicate until true or a short deadline (async round-trips over the socket). */
async function vi_poll(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
