import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { MoorCodec, type MoorMessage } from '../src/shared/moorWire/codec.js';
import { MoorKind } from '../src/shared/moorWire/messages.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import { InMemoryGenerationLedger, MOOR_LIVENESS_REASON } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor } from '../src/shared/runtime/workerSupervisor.js';
import { DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

const GENERATION = 2;
const INCARNATION = new Uint8Array(16).fill(0xa1);

function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function integer(value: number | bigint, bytes: 2 | 4 | 8): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 2) view.setUint16(0, Number(value), true);
  else if (bytes === 4) view.setUint32(0, Number(value), true);
  else view.setBigUint64(0, BigInt(value), true);
  return out;
}

const wide = (bytes: Uint8Array): Uint8Array => joined(integer(bytes.length, 4), bytes);

function identityFor(path: string): Uint8Array {
  return joined(Uint8Array.of(1), new Uint8Array(Buffer.from(path)));
}

function helloAckPayload(identity: Uint8Array, incarnation = INCARNATION): Uint8Array {
  return joined(Uint8Array.of(3), integer(GENERATION, 4), incarnation, wide(identity));
}

function statusPayload(
  identity: Uint8Array,
  incarnation = INCARNATION,
  replay: { first: bigint; last: bigint; start: bigint; end: bigint } = {
    first: 0n,
    last: 0n,
    start: 0n,
    end: 0n
  }
): Uint8Array {
  const tail = new Uint8Array(69);
  const view = new DataView(tail.buffer);
  view.setBigUint64(0, replay.first, true);
  view.setBigUint64(8, replay.last, true);
  view.setBigUint64(16, replay.start, true);
  view.setBigUint64(24, replay.end, true);
  view.setUint8(32, (replay.first <= 1n && replay.start === 0n ? 0x01 : 0) | 0x10 | 0x20 | 0x40);
  view.setUint32(33, 1, true);
  return joined(
    wide(identity),
    integer(GENERATION, 4),
    incarnation,
    Uint8Array.of(0),
    wide(new Uint8Array()),
    Uint8Array.of(0xff),
    integer(0n, 8),
    integer(0n, 8),
    new Uint8Array(32),
    integer(1_000n, 8),
    integer(2_000n, 8),
    new Uint8Array(16).fill(0xb2),
    wide(new TextEncoder().encode('/tmp/controller-link-recovery-holder')),
    integer(4321, 4),
    integer(1, 4),
    new Uint8Array(16).fill(0xc3),
    tail
  );
}

function leaseGrantPayload(): Uint8Array {
  return joined(Uint8Array.of(0, 0, 0, 0), integer(1, 4), new Uint8Array(16).fill(0xd4));
}

function leaseResumedPayload(): Uint8Array {
  return joined(Uint8Array.of(1, 0, 0, 0), integer(1, 4), new Uint8Array(16).fill(0xe5));
}

class EmptyEmulator implements EmulatorPort {
  readonly writes: Uint8Array[] = [];
  write(bytes: Uint8Array): void { this.writes.push(bytes.slice()); }
  resize(): void {}
  readTailText(): string[] { return []; }
  serialize(): string { return ''; }
  cursor(): { row: number; col: number } { return { row: 0, col: 0 }; }
  onEvent(_cb: (event: EmulatorEvent) => void): () => void { return () => undefined; }
  dispose(): void {}
}

class ExpiringLeaseHolder {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  readonly identity: Uint8Array;
  connections = 0;
  terminateRequests = 0;
  childAlive = true;
  readonly inputs: string[] = [];
  leaseDeadline = 0;
  private firstRefusedResolve!: () => void;
  readonly firstRefused = new Promise<void>((resolve) => { this.firstRefusedResolve = resolve; });
  private firstConnectionClosedResolve!: () => void;
  readonly firstConnectionClosed = new Promise<void>((resolve) => {
    this.firstConnectionClosedResolve = resolve;
  });
  private recoveryConnectionClosedResolve!: () => void;
  readonly recoveryConnectionClosed = new Promise<void>((resolve) => {
    this.recoveryConnectionClosedResolve = resolve;
  });
  private recoveryConnectedResolve!: () => void;
  readonly recoveryConnected = new Promise<void>((resolve) => {
    this.recoveryConnectedResolve = resolve;
  });
  private recoveryAttemptConnectedResolve!: () => void;
  readonly recoveryAttemptConnected = new Promise<void>((resolve) => {
    this.recoveryAttemptConnectedResolve = resolve;
  });
  private recoveryAttemptClosedResolve!: () => void;
  readonly recoveryAttemptClosed = new Promise<void>((resolve) => {
    this.recoveryAttemptClosedResolve = resolve;
  });
  private postFailureRetryConnectedResolve!: () => void;
  readonly postFailureRetryConnected = new Promise<void>((resolve) => {
    this.postFailureRetryConnectedResolve = resolve;
  });
  private recoveryHello: (() => void) | undefined;
  private recoveryHelloSeenResolve!: () => void;
  readonly recoveryHelloSeen = new Promise<void>((resolve) => {
    this.recoveryHelloSeenResolve = resolve;
  });
  private recoveryAttachedResolve!: () => void;
  readonly recoveryAttached = new Promise<void>((resolve) => {
    this.recoveryAttachedResolve = resolve;
  });
  private disappearedResolve!: () => void;
  readonly disappeared = new Promise<void>((resolve) => { this.disappearedResolve = resolve; });
  private inputReceivedResolve!: () => void;
  readonly inputReceived = new Promise<void>((resolve) => { this.inputReceivedResolve = resolve; });

  constructor(
    readonly sessionPath: string,
    private readonly disappearOnRefusal = false,
    private readonly recoveryIncarnation = INCARNATION,
    private readonly unsafeRecoveryGap = false
  ) {
    this.identity = identityFor(sessionPath);
  }

  async listen(): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(this.sessionPath, resolve));
  }

  private accept(socket: Socket): void {
    this.connections += 1;
    const connection = this.connections;
    if (connection === 2) this.recoveryConnectedResolve();
    if (connection === 3) this.recoveryAttemptConnectedResolve();
    if (connection === 4) this.postFailureRetryConnectedResolve();
    this.sockets.add(socket);
    const inbound = new MoorCodec();
    const outbound = new MoorCodec();
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (connection === 1) this.firstConnectionClosedResolve();
      if (connection === 2) this.recoveryConnectionClosedResolve();
      if (connection === 3) this.recoveryAttemptClosedResolve();
    });
    socket.on('data', (chunk: Buffer) => {
      const messages = inbound.feed(
        Date.now(),
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      );
      for (const message of messages) this.route(socket, outbound, connection, message);
    });
  }

  private send(socket: Socket, codec: MoorCodec, kind: number, payload: Uint8Array): void {
    socket.write(codec.encode(GENERATION, kind, payload));
  }

  private route(socket: Socket, codec: MoorCodec, connection: number, message: MoorMessage): void {
    switch (message.kind) {
      case MoorKind.HELLO:
        if (connection === 1 || connection >= 3) {
          this.send(
            socket,
            codec,
            MoorKind.HELLO_ACK,
            helloAckPayload(
              this.identity,
              connection === 1 ? INCARNATION : this.recoveryIncarnation
            )
          );
        } else {
          this.recoveryHello = () => {
            this.send(
              socket,
              codec,
              MoorKind.HELLO_ACK,
              helloAckPayload(this.identity, this.recoveryIncarnation)
            );
          };
          this.recoveryHelloSeenResolve();
        }
        return;
      case MoorKind.ATTACH:
        this.send(socket, codec, MoorKind.TERMINAL_STATE, integer(0, 2));
        this.send(
          socket,
          codec,
          MoorKind.ATTACH_ACK,
          statusPayload(
            this.identity,
            connection === 1 ? INCARNATION : this.recoveryIncarnation,
            this.unsafeRecoveryGap
              ? connection === 1
                ? { first: 1n, last: 3n, start: 0n, end: 3n }
                : { first: 5n, last: 5n, start: 4n, end: 5n }
              : undefined
          )
        );
        if ((message.payload[4]! & 1) === 1) {
          this.send(socket, codec, MoorKind.LEASE_RESULT, leaseGrantPayload());
        }
        if (connection === 1) {
          this.leaseDeadline = Date.now() + 1_000;
          if (this.unsafeRecoveryGap) {
            for (let sequence = 1; sequence <= 3; sequence += 1) {
              this.send(
                socket,
                codec,
                MoorKind.OUTPUT,
                joined(
                  integer(BigInt(sequence), 8),
                  integer(BigInt(sequence - 1), 8),
                  Uint8Array.of(0x60 + sequence)
                )
              );
            }
          }
        } else {
          this.recoveryAttachedResolve();
          if (this.unsafeRecoveryGap) {
            this.send(socket, codec, MoorKind.GAP, joined(integer(1n, 8), integer(4n, 8)));
          }
        }
        return;
      case MoorKind.LEASE_REQUEST:
        if (message.payload[0] === 1) {
          this.send(socket, codec, MoorKind.LEASE_RESULT, leaseResumedPayload());
        }
        return;
      case MoorKind.LEASE_KEEPALIVE:
        if (connection === 1 && Date.now() > this.leaseDeadline) {
          this.send(
            socket,
            codec,
            MoorKind.ERROR,
            joined(integer(15, 2), integer(14, 2), new TextEncoder().encode('lease not held'))
          );
          this.firstRefusedResolve();
          if (this.disappearOnRefusal) {
            this.server?.close(() => this.disappearedResolve());
          }
          socket.end();
        }
        return;
      case MoorKind.TERMINATE:
        this.terminateRequests += 1;
        this.childAlive = false;
        return;
      case MoorKind.INPUT:
        this.inputs.push(new TextDecoder().decode(message.payload.subarray(13)));
        this.inputReceivedResolve();
        return;
    }
  }

  allowRecovery(): void {
    this.recoveryHello?.();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

describe('SessionManager controller-link recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('survives a granted viewer lease expiring during an event-loop gap and re-adopts the exact generation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const root = mkdtempSync(join(tmpdir(), 'desk-link-recovery-'));
    const sessionPath = join(root, 'session');
    const detachedKillWitness = join(root, 'detached-kill-ran');
    const holder = new ExpiringLeaseHolder(sessionPath);
    await holder.listen();
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('session')).toBe(GENERATION);
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new EmptyEmulator() },
      now: () => Date.now(),
      sendBrowser: () => undefined
    });

    try {
      const restored = await manager.restoreAndAttachMoor('session', {
        sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/touch', args: [detachedKillWitness] }
      });
      expect(restored.ok).toBe(true);
      expect(manager.stateSnapshot('session')?.generation).toBe(GENERATION);
      const channelId = manager.subscribe('session', 'main', 24, 80)!;

      // One deterministic event-loop gap: the holder's 1 s grant expires
      // before Desk's overdue 3 s keepalive reaches it. Moor answers ERROR 15
      // and closes this controller connection, not the holder or child.
      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstRefused;
      await holder.firstConnectionClosed;
      await holder.recoveryConnected;
      await holder.recoveryHelloSeen;

      const provisionDuringRecovery = await manager.spawnAndAttachMoor('session', {
        binPath: '/usr/bin/true',
        sessionPath,
        command: ['true'],
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/true', args: [] }
      });
      expect(provisionDuringRecovery).toEqual({ ok: false, reason: 'attach-failed' });
      expect(ledger.current('session')).toBe(GENERATION);
      expect(
        manager.onBrowserInputByChannel(
          channelId,
          false,
          new TextEncoder().encode('queued-during-recovery')
        )
      ).toBe(true);
      expect(manager.injectInput('session', new TextEncoder().encode('control-must-refuse'))).toBe(false);

      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'running',
        health: { status: 'degraded', reason: MOOR_LIVENESS_REASON }
      });
      expect(holder.childAlive).toBe(true);
      expect(holder.terminateRequests).toBe(0);
      expect(existsSync(detachedKillWitness)).toBe(false);

      holder.allowRecovery();
      await holder.recoveryAttached;
      await holder.inputReceived;
      expect(holder.connections).toBe(3);
      expect(holder.inputs).toEqual(['queued-during-recovery']);
      expect(manager.stateSnapshot('session')?.generation).toBe(GENERATION);
      expect(ledger.current('session')).toBe(GENERATION);
    } finally {
      manager.closeAllLinks();
      await holder.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ends exact-generation authority on positive listener absence without terminating or running the detached kill', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const root = mkdtempSync(join(tmpdir(), 'desk-link-absence-'));
    const sessionPath = join(root, 'session');
    const detachedKillWitness = join(root, 'detached-kill-ran');
    const holder = new ExpiringLeaseHolder(sessionPath, true);
    await holder.listen();
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('session')).toBe(GENERATION);
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new EmptyEmulator() },
      now: () => Date.now(),
      sendBrowser: () => undefined
    });
    try {
      expect((await manager.restoreAndAttachMoor('session', {
        sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/touch', args: [detachedKillWitness] }
      })).ok).toBe(true);

      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstConnectionClosed;
      await holder.disappeared;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'exited',
        exit: { origin: 'retired', reason: 'confirmed-holder-absence' }
      });
      expect(holder.terminateRequests).toBe(0);
      expect(existsSync(detachedKillWitness)).toBe(false);
    } finally {
      manager.closeAllLinks();
      await holder.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a changed holder incarnation indeterminate and never writes it into the preserved emulator', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const root = mkdtempSync(join(tmpdir(), 'desk-link-incarnation-'));
    const sessionPath = join(root, 'session');
    const holder = new ExpiringLeaseHolder(
      sessionPath,
      false,
      new Uint8Array(16).fill(0xf6)
    );
    await holder.listen();
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('session')).toBe(GENERATION);
    const emulator = new EmptyEmulator();
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => emulator },
      now: () => Date.now(),
      sendBrowser: () => undefined
    });
    try {
      expect((await manager.restoreAndAttachMoor('session', {
        sessionPath,
        geometry: { rows: 24, cols: 80 }
      })).ok).toBe(true);
      const writesBeforeRecovery = emulator.writes.map((bytes) => bytes.slice());
      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstConnectionClosed;
      await holder.recoveryHelloSeen;
      holder.allowRecovery();
      await holder.recoveryAttemptConnected;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'running',
        health: { status: 'degraded', reason: MOOR_LIVENESS_REASON }
      });
      expect(joined(...emulator.writes)).toEqual(joined(...writesBeforeRecovery));
      expect(holder.childAlive).toBe(true);
      expect(holder.terminateRequests).toBe(0);
    } finally {
      manager.closeAllLinks();
      await holder.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a retained-output GAP beyond the saved cursor visibly indeterminate without applying its tail', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const root = mkdtempSync(join(tmpdir(), 'desk-link-gap-'));
    const sessionPath = join(root, 'session');
    const holder = new ExpiringLeaseHolder(sessionPath, false, INCARNATION, true);
    await holder.listen();
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('session')).toBe(GENERATION);
    const emulator = new EmptyEmulator();
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => emulator },
      now: () => Date.now(),
      sendBrowser: () => undefined
    });
    try {
      expect((await manager.restoreAndAttachMoor('session', {
        sessionPath,
        geometry: { rows: 24, cols: 80 }
      })).ok).toBe(true);
      const writesBeforeRecovery = emulator.writes.map((bytes) => bytes.slice());
      expect(new TextDecoder().decode(joined(...writesBeforeRecovery))).toContain('abc');

      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstConnectionClosed;
      await holder.recoveryHelloSeen;
      holder.allowRecovery();
      await holder.recoveryAttemptConnected;
      await holder.recoveryAttemptClosed;
      await vi.advanceTimersByTimeAsync(101);
      await holder.postFailureRetryConnected;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'running',
        health: { status: 'degraded', reason: MOOR_LIVENESS_REASON }
      });
      expect(joined(...emulator.writes)).toEqual(joined(...writesBeforeRecovery));
      expect(holder.childAlive).toBe(true);
      expect(holder.terminateRequests).toBe(0);
    } finally {
      manager.closeAllLinks();
      await holder.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shutdown synchronously fences and closes an in-flight recovery candidate', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const root = mkdtempSync(join(tmpdir(), 'desk-link-shutdown-'));
    const sessionPath = join(root, 'session');
    const detachedKillWitness = join(root, 'detached-kill-ran');
    const holder = new ExpiringLeaseHolder(sessionPath);
    await holder.listen();
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('session')).toBe(GENERATION);
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new EmptyEmulator() },
      now: () => Date.now(),
      sendBrowser: () => undefined
    });
    try {
      expect((await manager.restoreAndAttachMoor('session', {
        sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/touch', args: [detachedKillWitness] }
      })).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstConnectionClosed;
      await holder.recoveryConnected;
      await holder.recoveryHelloSeen;

      manager.closeAllLinks();
      await holder.recoveryConnectionClosed;
      await vi.advanceTimersByTimeAsync(10_000);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(holder.connections).toBe(2);
      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'running'
      });
      expect(holder.terminateRequests).toBe(0);
      expect(existsSync(detachedKillWitness)).toBe(false);
    } finally {
      manager.closeAllLinks();
      await holder.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
