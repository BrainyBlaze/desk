import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  type SessionManagerDeps
} from '../src/server/runtime/sessionManager.js';
import { MoorCodec, type MoorMessage } from '../src/shared/moorWire/codec.js';
import { MoorKind } from '../src/shared/moorWire/messages.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import { InMemoryGenerationLedger, MOOR_LIVENESS_REASON } from '../src/shared/controlPlane/index.js';
import { BpError, BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
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
  return joined(Uint8Array.of(5), integer(GENERATION, 4), incarnation, wide(identity));
}

function statusPayload(
  identity: Uint8Array,
  incarnation = INCARNATION,
  replay: { first: bigint; last: bigint; start: bigint; end: bigint } = {
    first: 1n,
    last: 0n,
    start: 0n,
    end: 0n
  },
  running = true
): Uint8Array {
  const tail = new Uint8Array(69);
  const view = new DataView(tail.buffer);
  view.setBigUint64(0, replay.first, true);
  view.setBigUint64(8, replay.last, true);
  view.setBigUint64(16, replay.start, true);
  view.setBigUint64(24, replay.end, true);
  view.setUint8(
    32,
    (replay.first <= 1n && replay.start === 0n ? 0x01 : 0) |
      0x10 |
      0x20 |
      (running ? 0x40 : 0)
  );
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
    integer(80, 2),
    integer(24, 2),
    tail
  );
}

function leaseGrantPayload(epoch = 1): Uint8Array {
  return joined(Uint8Array.of(0, 0, 0, 0), integer(epoch, 4), new Uint8Array(16).fill(0xd4));
}

function leaseResumedPayload(): Uint8Array {
  return joined(Uint8Array.of(1, 0, 0, 0), integer(1, 4), new Uint8Array(16).fill(0xe5));
}

function leaseRefusedPayload(): Uint8Array {
  return joined(Uint8Array.of(3, 1, 0, 0), integer(1, 4), new Uint8Array(16));
}

function leaseResumeTerminalRefusedPayload(): Uint8Array {
  return joined(Uint8Array.of(3, 2, 0, 0), integer(1, 4), new Uint8Array(16));
}

function leaseReleasedPayload(epoch: number): Uint8Array {
  return joined(Uint8Array.of(2, 0, 0, 0), integer(epoch, 4), new Uint8Array(16));
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

class BlockingRecoveryEmulator extends EmptyEmulator {
  private flushCount = 0;
  private recoveryFlushStartedResolve!: () => void;
  readonly recoveryFlushStarted = new Promise<void>((resolve) => {
    this.recoveryFlushStartedResolve = resolve;
  });
  private recoveryDrainResolve!: () => void;
  private readonly recoveryDrain = new Promise<void>((resolve) => {
    this.recoveryDrainResolve = resolve;
  });

  flush(): Promise<void> {
    this.flushCount += 1;
    if (this.flushCount === 1) return Promise.resolve();
    this.recoveryFlushStartedResolve();
    return this.recoveryDrain;
  }

  releaseRecoveryFlush(): void {
    this.recoveryDrainResolve();
  }
}

class RejectingOutputEmulator extends EmptyEmulator {
  private flushCount = 0;

  flush(): Promise<void> {
    this.flushCount += 1;
    return this.flushCount === 1
      ? Promise.resolve()
      : Promise.reject(new Error('flush boom'));
  }
}

class BlockingRecoveryReplayEmulator extends EmptyEmulator {
  private flushCount = 0;
  private replayFlushStartedResolve!: () => void;
  readonly replayFlushStarted = new Promise<void>((resolve) => {
    this.replayFlushStartedResolve = resolve;
  });
  private replayDrainResolve!: () => void;
  private readonly replayDrain = new Promise<void>((resolve) => {
    this.replayDrainResolve = resolve;
  });

  flush(): Promise<void> {
    this.flushCount += 1;
    if (this.flushCount <= 2) return Promise.resolve();
    this.replayFlushStartedResolve();
    return this.replayDrain;
  }

  releaseReplayFlush(): void {
    this.replayDrainResolve();
  }
}

class BlockingOutputEmulator extends EmptyEmulator {
  flushCount = 0;
  failNextSerialize = false;
  private readonly outputFlushResolvers: Array<() => void> = [];
  private firstOutputFlushStartedResolve!: () => void;
  readonly firstOutputFlushStarted = new Promise<void>((resolve) => {
    this.firstOutputFlushStartedResolve = resolve;
  });

  flush(): Promise<void> {
    this.flushCount += 1;
    if (this.flushCount === 1) return Promise.resolve();
    if (this.flushCount === 2) this.firstOutputFlushStartedResolve();
    return new Promise<void>((resolve) => {
      this.outputFlushResolvers.push(resolve);
    });
  }

  releaseOutputFlush(): void {
    const resolve = this.outputFlushResolvers.shift();
    if (resolve === undefined) throw new Error('no output flush is pending');
    resolve();
  }

  override serialize(): string {
    if (this.failNextSerialize) {
      this.failNextSerialize = false;
      throw new Error('serialize boom');
    }
    return new TextDecoder().decode(joined(...this.writes));
  }
}

class ExpiringLeaseHolder {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly connectionState = new Map<number, { socket: Socket; codec: MoorCodec }>();
  readonly identity: Uint8Array;
  connections = 0;
  terminateRequests = 0;
  childAlive = true;
  readonly inputs: string[] = [];
  readonly outputAcks: bigint[] = [];
  readonly inputRequests: Array<{
    connection: number;
    epoch: number;
    requestId: bigint;
    bytes: number;
  }> = [];
  readonly resizes: Array<{ connection: number; columns: number; rows: number }> = [];
  readonly redraws: Array<{ connection: number; columns: number; rows: number }> = [];
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
  private postFailureRetryAttachedResolve!: () => void;
  readonly postFailureRetryAttached = new Promise<void>((resolve) => {
    this.postFailureRetryAttachedResolve = resolve;
  });
  private secondRecoveryAttemptConnectedResolve!: () => void;
  readonly secondRecoveryAttemptConnected = new Promise<void>((resolve) => {
    this.secondRecoveryAttemptConnectedResolve = resolve;
  });
  private secondResumeRefusedResolve!: () => void;
  readonly secondResumeRefused = new Promise<void>((resolve) => {
    this.secondResumeRefusedResolve = resolve;
  });
  private resumeRefusals = 0;
  private nextFreshLeaseEpoch = 2;
  private recoveryHello: (() => void) | undefined;
  private recoveryHelloSeenResolve!: () => void;
  readonly recoveryHelloSeen = new Promise<void>((resolve) => {
    this.recoveryHelloSeenResolve = resolve;
  });
  private recoveryAttachedResolve!: () => void;
  readonly recoveryAttached = new Promise<void>((resolve) => {
    this.recoveryAttachedResolve = resolve;
  });
  private initialAttachedResolve!: () => void;
  readonly initialAttached = new Promise<void>((resolve) => {
    this.initialAttachedResolve = resolve;
  });
  private holdRecoveryAttach = false;
  private releaseRecoveryAttach: (() => void) | undefined;
  private recoveryAttachSeenResolve!: () => void;
  readonly recoveryAttachSeen = new Promise<void>((resolve) => {
    this.recoveryAttachSeenResolve = resolve;
  });
  private disappearedResolve!: () => void;
  readonly disappeared = new Promise<void>((resolve) => { this.disappearedResolve = resolve; });
  private inputReceivedResolve!: () => void;
  readonly inputReceived = new Promise<void>((resolve) => { this.inputReceivedResolve = resolve; });

  constructor(
    readonly sessionPath: string,
    private readonly disappearOnRefusal = false,
    private readonly recoveryIncarnation = INCARNATION,
    private readonly unsafeRecoveryGap = false,
    private readonly refuseLeaseResume = false,
    private readonly attachReplayBurst = false,
    private readonly recoveryReplayBurst = false,
    private readonly refuseLeaseRelease = false
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
    if (connection === 5) this.secondRecoveryAttemptConnectedResolve();
    this.sockets.add(socket);
    const inbound = new MoorCodec();
    const outbound = new MoorCodec();
    this.connectionState.set(connection, { socket, codec: outbound });
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.connectionState.delete(connection);
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
        const liveOnly = (message.payload[4]! & 0b0000_0100) !== 0;
        if (connection >= 3 && this.holdRecoveryAttach) {
          this.holdRecoveryAttach = false;
          this.releaseRecoveryAttach = () => this.route(socket, codec, connection, message);
          this.recoveryAttachSeenResolve();
          return;
        }
        if (
          (connection === 1 && this.attachReplayBurst) ||
          (connection >= 3 && this.recoveryReplayBurst)
        ) {
          const replayBytes =
            connection === 1
              ? [new TextEncoder().encode('a'), new TextEncoder().encode('b')]
              : [new TextEncoder().encode('r')];
          const frames = [
            codec.encode(
              GENERATION,
              MoorKind.ATTACH_ACK,
              statusPayload(
                this.identity,
                connection === 1 ? INCARNATION : this.recoveryIncarnation,
                {
                first: 1n,
                last: BigInt(replayBytes.length),
                start: 0n,
                  end: BigInt(replayBytes.length)
                }
              )
            ),
            codec.encode(GENERATION, MoorKind.TERMINAL_STATE, integer(0, 2)),
            ...(message.payload[4]! & 1
              ? [codec.encode(GENERATION, MoorKind.LEASE_RESULT, leaseGrantPayload())]
              : []),
            ...(liveOnly
              ? []
              : replayBytes.map((bytes, index) =>
                  codec.encode(
                    GENERATION,
                    MoorKind.OUTPUT,
                    joined(integer(BigInt(index + 1), 8), integer(BigInt(index), 8), bytes)
                  )
                ))
          ];
          socket.write(joined(...frames));
          if (connection === 1) {
            this.leaseDeadline = Date.now() + 1_000;
            this.initialAttachedResolve();
          }
          else {
            this.recoveryAttachedResolve();
            if (connection === 5) this.postFailureRetryAttachedResolve();
          }
          return;
        }
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
        this.send(socket, codec, MoorKind.TERMINAL_STATE, integer(0, 2));
        if ((message.payload[4]! & 1) === 1) {
          this.send(socket, codec, MoorKind.LEASE_RESULT, leaseGrantPayload());
        }
        if (connection === 1) {
          this.leaseDeadline = Date.now() + 1_000;
          this.initialAttachedResolve();
          if (this.unsafeRecoveryGap && !liveOnly) {
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
          if (this.unsafeRecoveryGap && !liveOnly) {
            this.send(socket, codec, MoorKind.GAP, joined(integer(1n, 8), integer(4n, 8)));
          }
        }
        return;
      case MoorKind.LEASE_REQUEST:
        if (message.payload[0] === 1) {
          if (this.refuseLeaseResume) this.resumeRefusals += 1;
          this.send(
            socket,
            codec,
            MoorKind.LEASE_RESULT,
            this.refuseLeaseResume ? leaseResumeTerminalRefusedPayload() : leaseResumedPayload()
          );
          if (this.resumeRefusals === 2) this.secondResumeRefusedResolve();
        } else {
          this.send(
            socket,
            codec,
            MoorKind.LEASE_RESULT,
            leaseGrantPayload(this.nextFreshLeaseEpoch++)
          );
        }
        return;
      case MoorKind.LEASE_RELEASE: {
        const epoch = new DataView(
          message.payload.buffer,
          message.payload.byteOffset,
          message.payload.byteLength
        ).getUint32(0, true);
        this.send(
          socket,
          codec,
          MoorKind.LEASE_RESULT,
          this.refuseLeaseRelease ? leaseRefusedPayload() : leaseReleasedPayload(epoch)
        );
        return;
      }
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
      case MoorKind.OUTPUT_ACK:
        this.outputAcks.push(
          new DataView(
            message.payload.buffer,
            message.payload.byteOffset,
            message.payload.byteLength
          ).getBigUint64(0, true)
        );
        return;
      case MoorKind.INPUT:
        {
          const view = new DataView(
            message.payload.buffer,
            message.payload.byteOffset,
            message.payload.byteLength
          );
          const bytes = message.payload.subarray(13);
          this.inputs.push(new TextDecoder().decode(bytes));
          this.inputRequests.push({
            connection,
            epoch: view.getUint32(0, true),
            requestId: view.getBigUint64(4, true),
            bytes: bytes.length
          });
        }
        this.inputReceivedResolve();
        return;
      case MoorKind.RESIZE: {
        const view = new DataView(
          message.payload.buffer,
          message.payload.byteOffset,
          message.payload.byteLength
        );
        this.resizes.push({
          connection,
          columns: view.getUint16(4, true),
          rows: view.getUint16(6, true)
        });
        return;
      }
      case MoorKind.REDRAW: {
        const view = new DataView(
          message.payload.buffer,
          message.payload.byteOffset,
          message.payload.byteLength
        );
        this.redraws.push({
          connection,
          columns: view.getUint16(4, true),
          rows: view.getUint16(6, true)
        });
        return;
      }
    }
  }

  acknowledgeLatestInput(connection: number): void {
    let input: (typeof this.inputRequests)[number] | undefined;
    for (let index = this.inputRequests.length - 1; index >= 0; index -= 1) {
      if (this.inputRequests[index]!.connection === connection) {
        input = this.inputRequests[index];
        break;
      }
    }
    const state = this.connectionState.get(connection);
    if (input === undefined || state === undefined) throw new Error('no input to acknowledge');
    this.send(
      state.socket,
      state.codec,
      MoorKind.INPUT_RECEIPT,
      joined(
        integer(input.epoch, 4),
        integer(input.requestId, 8),
        integer(GENERATION, 4),
        connection === 1 ? INCARNATION : this.recoveryIncarnation,
        integer(BigInt(input.bytes), 8),
        Uint8Array.of(0),
        integer(0, 2)
      )
    );
  }

  sendOutput(
    connection: number,
    sequence: bigint,
    offset: bigint,
    bytes: Uint8Array
  ): void {
    const state = this.connectionState.get(connection);
    if (state === undefined) throw new Error('connection is not open');
    this.send(
      state.socket,
      state.codec,
      MoorKind.OUTPUT,
      joined(integer(sequence, 8), integer(offset, 8), bytes)
    );
  }

  allowRecovery(): void {
    this.recoveryHello?.();
  }

  holdNextRecoveryAttach(): void {
    this.holdRecoveryAttach = true;
  }

  allowRecoveryAttach(): void {
    const release = this.releaseRecoveryAttach;
    if (release === undefined) throw new Error('no recovery attach is pending');
    this.releaseRecoveryAttach = undefined;
    release();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

async function settleSocketIo(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForSocketCondition(
  predicate: () => boolean,
  description: string,
  turns = 50
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startRecoveryHarness(
  createEmulator: () => EmulatorPort = () => new EmptyEmulator(),
  createHolder: (sessionPath: string) => ExpiringLeaseHolder = (sessionPath) =>
    new ExpiringLeaseHolder(sessionPath),
  duringRestore?: (holder: ExpiringLeaseHolder) => Promise<void>,
  options: {
    onLateMoorAdoption?: SessionManagerDeps['onLateMoorAdoption'];
  } = {}
): Promise<{
  holder: ExpiringLeaseHolder;
  manager: SessionManager;
  channelId: number;
  browserErrors: number[];
  browserFrames: Array<{ channelId: number; frame: BpFrame }>;
  failBrowserChannel: (channelId: number) => void;
  enterRecovery: () => Promise<void>;
  close: () => Promise<void>;
}> {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const root = mkdtempSync(join(tmpdir(), 'desk-link-handoff-'));
  const sessionPath = join(root, 'session');
  const holder = createHolder(sessionPath);
  await holder.listen();
  const ledger = new GenerationLedger(new InMemoryGenerationLedger());
  expect(ledger.allocate('session')).toBe(GENERATION);
  const browserErrors: number[] = [];
  const browserFrames: Array<{ channelId: number; frame: BpFrame }> = [];
  const failingBrowserChannels = new Set<number>();
  const manager = new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: createEmulator },
    now: () => Date.now(),
    ...(options.onLateMoorAdoption === undefined
      ? {}
      : { onLateMoorAdoption: options.onLateMoorAdoption }),
    sendBrowser: (_sessionId, _channelId, frame) => {
      if (failingBrowserChannels.has(_channelId)) throw new Error('browser send boom');
      browserFrames.push({ channelId: _channelId, frame });
      if (frame.type === BpFrameType.ERROR) browserErrors.push(frame.code);
    }
  });
  const restoring = manager.restoreAndAttachMoor('session', {
    sessionPath,
    killSpec: { binPath: '/usr/bin/true', args: [] }
  });
  if (duringRestore !== undefined) await duringRestore(holder);
  const restored = await restoring;
  expect(restored.ok).toBe(true);
  const channelId = manager.subscribe('session', 'main', 24, 80)!;
  return {
    holder,
    manager,
    channelId,
    browserErrors,
    browserFrames,
    failBrowserChannel: (failedChannelId) => failingBrowserChannels.add(failedChannelId),
    enterRecovery: async () => {
      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstRefused;
      await holder.firstConnectionClosed;
      await holder.recoveryConnected;
      await holder.recoveryHelloSeen;
    },
    close: async () => {
      manager.closeAllLinks();
      await holder.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('SessionManager controller-link recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('does not strand future input when hide revokes a retained request before recovery attach completes', async () => {
    const harness = await startRecoveryHarness();
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      harness.holder.holdNextRecoveryAttach();
      await harness.enterRecovery();
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttachSeen;
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, false)).toBe(true);
      harness.holder.allowRecoveryAttach();

      await waitForSocketCondition(
        () => harness.manager.stateSnapshot('session')?.health.status === 'healthy',
        'recovery health after pre-attach retained input revocation'
      );
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, true)).toBe(true);
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('after-pre-attach-revoke')
        )
      ).toBe(true);

      await waitForSocketCondition(
        () => harness.holder.inputs.includes('after-pre-attach-revoke'),
        'post-reveal input after pre-attach retained request revocation'
      );
      expect(harness.holder.inputs).toEqual(['ambiguous', 'after-pre-attach-revoke']);
      expect(harness.holder.inputRequests.at(-1)).toMatchObject({
        connection: 3,
        epoch: 2,
        requestId: 1n
      });
      expect(harness.browserErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('desk#66 gates ambiguous input retransmission on late observer acceptance', async () => {
    const acceptance = deferred<boolean>();
    const callbackStarted = deferred<void>();
    const onLateMoorAdoption = vi.fn(() => {
      callbackStarted.resolve(undefined);
      return acceptance.promise;
    });
    const harness = await startRecoveryHarness(
      undefined,
      undefined,
      undefined,
      { onLateMoorAdoption }
    );
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);
      expect(harness.holder.inputRequests).toHaveLength(1);
      const original = { ...harness.holder.inputRequests[0]! };

      await harness.enterRecovery();
      harness.holder.allowRecovery();
      await callbackStarted.promise;
      await settleSocketIo();
      const inputsWhilePending = [...harness.holder.inputs];
      const requestsWhilePending = harness.holder.inputRequests.map((request) => ({
        ...request
      }));
      const healthWhilePending = harness.manager.stateSnapshot('session')?.health;

      acceptance.resolve(true);
      await waitForSocketCondition(
        () => harness.holder.inputRequests.length === 2,
        'the exact retained input retransmission'
      );
      await waitForSocketCondition(
        () => harness.manager.stateSnapshot('session')?.health.status === 'healthy',
        'observer-accepted recovery health'
      );

      expect.soft(inputsWhilePending).toEqual(['ambiguous']);
      expect.soft(requestsWhilePending).toHaveLength(1);
      expect.soft(healthWhilePending?.status).toBe('degraded');
      expect(harness.holder.inputs).toEqual(['ambiguous', 'ambiguous']);
      expect(harness.holder.inputRequests).toEqual([
        original,
        { ...original, connection: 3 }
      ]);
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
      expect(onLateMoorAdoption).toHaveBeenCalledWith('session', GENERATION);
    } finally {
      acceptance.resolve(true);
      await harness.close();
    }
  });

  it('does not strand future input when hide revokes a retained request during late acceptance', async () => {
    const acceptance = deferred<boolean>();
    const callbackStarted = deferred<void>();
    const onLateMoorAdoption = vi.fn(() => {
      callbackStarted.resolve(undefined);
      return acceptance.promise;
    });
    const harness = await startRecoveryHarness(
      undefined,
      undefined,
      undefined,
      { onLateMoorAdoption }
    );
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      await harness.enterRecovery();
      harness.holder.allowRecovery();
      await callbackStarted.promise;
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, false)).toBe(true);

      acceptance.resolve(true);
      await waitForSocketCondition(
        () => harness.manager.stateSnapshot('session')?.health.status === 'healthy',
        'observer-accepted recovery health'
      );
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, true)).toBe(true);
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('after-reveal')
        )
      ).toBe(true);

      await waitForSocketCondition(
        () => harness.holder.inputs.includes('after-reveal'),
        'post-reveal input after retained request revocation'
      );
      expect(harness.holder.inputs).toEqual(['ambiguous', 'after-reveal']);
      expect(harness.holder.inputRequests.at(-1)).toMatchObject({
        connection: 3,
        epoch: 2,
        requestId: 1n
      });
      expect(harness.browserErrors).toEqual([]);
    } finally {
      acceptance.resolve(true);
      await harness.close();
    }
  });

  it('recovers without revoked lease continuity when release is refused after unsubscribe', async () => {
    const acceptance = deferred<boolean>();
    const callbackStarted = deferred<void>();
    const onLateMoorAdoption = vi.fn(() => {
      callbackStarted.resolve(undefined);
      return acceptance.promise;
    });
    const harness = await startRecoveryHarness(
      undefined,
      (sessionPath) =>
        new ExpiringLeaseHolder(
          sessionPath,
          false,
          INCARNATION,
          false,
          false,
          false,
          false,
          true
        ),
      undefined,
      { onLateMoorAdoption }
    );
    let replacement: number | undefined;
    let transferInputAccepted: boolean | undefined;
    let transferResizeAccepted: boolean | undefined;
    const errorLog = vi.spyOn(console, 'error').mockImplementation((message) => {
      const replacementChannel = replacement;
      if (
        replacementChannel === undefined ||
        !String(message).includes('revoked retained input lease reset failed')
      ) {
        return;
      }
      queueMicrotask(() => {
        transferInputAccepted = harness.manager.onBrowserInputByChannel(
          replacementChannel,
          false,
          new TextEncoder().encode('during-transfer')
        );
        transferResizeAccepted = harness.manager.onBrowserResizeByChannel(
          replacementChannel,
          44,
          132
        );
      });
    });
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      await harness.enterRecovery();
      harness.holder.allowRecovery();
      await callbackStarted.promise;
      harness.manager.unsubscribeChannel(harness.channelId);
      replacement = harness.manager.subscribe('session', 'replacement', 31, 101)!;

      acceptance.resolve(true);
      await waitForSocketCondition(
        () => transferInputAccepted !== undefined && transferResizeAccepted !== undefined,
        'authorized work during failed-reset ownership transfer'
      );
      await harness.holder.secondRecoveryAttemptConnected;
      await settleSocketIo();
      await waitForSocketCondition(
        () => harness.manager.stateSnapshot('session')?.health.status === 'healthy',
        'fresh recovery after refused revoked-lease release'
      );
      await waitForSocketCondition(
        () => harness.holder.inputs.includes('during-transfer'),
        'authorized input transferred through refused revoked-lease release'
      );
      expect(
        harness.manager.onBrowserInputByChannel(
          replacement,
          false,
          new TextEncoder().encode('after-unsubscribe')
        )
      ).toBe(true);
      harness.holder.acknowledgeLatestInput(5);
      await waitForSocketCondition(
        () => harness.holder.inputs.includes('after-unsubscribe'),
        'replacement-channel input after output-only recovery'
      );

      expect(transferInputAccepted).toBe(true);
      expect(transferResizeAccepted).toBe(true);
      expect(harness.holder.inputs).toEqual([
        'ambiguous',
        'during-transfer',
        'after-unsubscribe'
      ]);
      expect(
        harness.holder.inputRequests
          .filter((request) => request.connection === 5)
          .map((request) => request.requestId)
      ).toEqual([1n, 2n]);
      expect(harness.holder.resizes.at(-1)).toMatchObject({
        connection: 5,
        columns: 132,
        rows: 44
      });
      expect(harness.browserErrors).toEqual([]);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('revoked retained input lease reset failed')
      );
    } finally {
      acceptance.resolve(true);
      errorLog.mockRestore();
      await harness.close();
    }
  });

  it('bounds recovery while the authoritative emulator is not draining', async () => {
    const emulator = new BlockingRecoveryEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      await harness.enterRecovery();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('must-expire')
        )
      ).toBe(true);
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttemptConnected;
      await emulator.recoveryFlushStarted;
      let recoveryAttemptClosed = false;
      void harness.holder.recoveryAttemptClosed.then(() => {
        recoveryAttemptClosed = true;
      });

      await vi.advanceTimersByTimeAsync(2_001);
      await settleSocketIo();

      expect(recoveryAttemptClosed).toBe(true);
      expect(harness.holder.inputs).toEqual(['ambiguous']);
      expect(harness.browserErrors).toEqual([]);

      await vi.advanceTimersByTimeAsync(20_000);
      await settleSocketIo(8);
      expect(harness.holder.connections).toBe(3);
      expect(emulator.writes).toHaveLength(2);
      expect(harness.browserErrors).toHaveLength(2);

      emulator.releaseRecoveryFlush();
      await harness.holder.postFailureRetryConnected;
      await harness.holder.secondRecoveryAttemptConnected;
      await settleSocketIo(12);
      expect(harness.holder.connections).toBe(5);
      expect(emulator.writes).toHaveLength(3);
      expect(harness.holder.inputs).toEqual(['ambiguous']);
    } finally {
      await harness.close();
    }
  });

  it('recovers at the advertised live frontier without replaying retained output or delaying input', async () => {
    const emulator = new EmptyEmulator();
    const harness = await startRecoveryHarness(
      () => emulator,
      (sessionPath) =>
        new ExpiringLeaseHolder(
          sessionPath,
          false,
          INCARNATION,
          false,
          false,
          false,
          true
        )
    );
    try {
      await harness.enterRecovery();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('must-stay-queued')
        )
      ).toBe(true);
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttemptConnected;
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual(['must-stay-queued']);
      expect(joined(...emulator.writes)).toEqual(new Uint8Array());
      expect(harness.holder.outputAcks).toEqual([]);
      expect(harness.manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        health: { status: 'healthy' }
      });

      await vi.advanceTimersByTimeAsync(2_001);
      await settleSocketIo(4);
      expect(harness.holder.connections).toBe(3);
      expect(harness.browserErrors).toEqual([]);
      expect(harness.manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        health: { status: 'healthy' }
      });

      const lateChannel = harness.manager.subscribe('session', 'late', 24, 80)!;
      const frames = harness.browserFrames
        .filter(({ channelId }) => channelId === lateChannel)
        .map(({ frame }) => frame);
      expect(frames).toEqual([
        expect.objectContaining({ type: BpFrameType.SUBSCRIBE_ACK, offset: 1n })
      ]);
    } finally {
      await harness.close();
    }
  });

  it('reports a retained input continuity loss only once across recovery retries', async () => {
    const emulator = new BlockingRecoveryEmulator();
    const harness = await startRecoveryHarness(
      () => emulator,
      (sessionPath) => new ExpiringLeaseHolder(sessionPath, false, INCARNATION, false, true)
    );
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      await harness.enterRecovery();
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttemptConnected;
      await emulator.recoveryFlushStarted;
      await settleSocketIo();
      expect(harness.browserErrors).toEqual([BpError.INPUT_UNAVAILABLE]);

      await vi.advanceTimersByTimeAsync(2_001);
      await harness.holder.recoveryAttemptClosed;
      await vi.advanceTimersByTimeAsync(101);
      emulator.releaseRecoveryFlush();
      await harness.holder.postFailureRetryConnected;
      await harness.holder.secondRecoveryAttemptConnected;
      await harness.holder.secondResumeRefused;
      await settleSocketIo();

      expect(harness.browserErrors).toEqual([BpError.INPUT_UNAVAILABLE]);
      expect(harness.holder.inputs).toEqual(['ambiguous']);
    } finally {
      await harness.close();
    }
  });

  it('keeps a rejecting output frontier indeterminate without an unhandled rejection', async () => {
    const emulator = new RejectingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.on('unhandledRejection', onUnhandled);
    try {
      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('rejected'));
      await harness.holder.firstConnectionClosed;
      await vi.advanceTimersByTimeAsync(20_000);
      await settleSocketIo(8);

      expect(harness.holder.outputAcks).toEqual([]);
      expect(harness.holder.connections).toBe(1);
      expect(unhandled).toEqual([]);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        '[desk] moor async message handler failed: flush boom'
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errorLog.mockRestore();
      await harness.close();
    }
  });

  it('parses later output immediately but acknowledges only after emulator drain', async () => {
    const emulator = new BlockingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('a'));
      harness.holder.sendOutput(1, 2n, 1n, new TextEncoder().encode('b'));
      await settleSocketIo();

      expect(new TextDecoder().decode(joined(...emulator.writes))).toBe('ab');
      expect(harness.holder.outputAcks).toEqual([]);

      emulator.releaseOutputFlush();
      await settleSocketIo();
      expect(harness.holder.outputAcks).toEqual([1n]);

      emulator.releaseOutputFlush();
      await settleSocketIo();
      expect(harness.holder.outputAcks).toEqual([1n, 2n]);
    } finally {
      await harness.close();
    }
  });

  it('does not let output parsing head-of-line block an input receipt', async () => {
    const emulator = new BlockingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('first')
        )
      ).toBe(true);
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('second')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['first']);

      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('first'));
      harness.holder.acknowledgeLatestInput(1);
      await emulator.firstOutputFlushStarted;
      await settleSocketIo(8);

      expect(harness.holder.inputs).toEqual(['first', 'second']);
      expect(harness.holder.outputAcks).toEqual([]);
      emulator.releaseOutputFlush();
      await settleSocketIo();
      expect(harness.holder.outputAcks).toEqual([1n]);
    } finally {
      await harness.close();
    }
  });

  it('isolates a throwing browser subscriber from output consumption and healthy fanout', async () => {
    const emulator = new BlockingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      const healthyChannel = harness.manager.subscribe('session', 'healthy', 24, 80)!;
      harness.failBrowserChannel(harness.channelId);

      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('x'));
      await emulator.firstOutputFlushStarted;
      emulator.releaseOutputFlush();
      await settleSocketIo(8);
      expect(harness.holder.outputAcks).toEqual([1n]);
      expect(harness.manager.sessionOfChannel(harness.channelId)).toBeUndefined();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('blind-input')
        )
      ).toBe(false);
      expect(
        harness.manager.onBrowserInputByChannel(
          healthyChannel,
          false,
          new TextEncoder().encode('healthy-input')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['healthy-input']);

      harness.holder.sendOutput(1, 2n, 1n, new TextEncoder().encode('y'));
      await settleSocketIo();
      emulator.releaseOutputFlush();
      await settleSocketIo(8);

      expect(harness.holder.outputAcks).toEqual([1n, 2n]);
      const healthyText = harness.browserFrames
        .filter(
          ({ channelId, frame }) =>
            channelId === healthyChannel && frame.type === BpFrameType.OUTPUT
        )
        .map(({ frame }) =>
          frame.type === BpFrameType.OUTPUT ? new TextDecoder().decode(frame.bytes) : ''
        )
        .join('');
      expect(healthyText).toBe('xy');
    } finally {
      await harness.close();
    }
  });

  it('does not serialize a snapshot while opening a live-baselined channel', async () => {
    const emulator = new BlockingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('x'));
      await emulator.firstOutputFlushStarted;

      const failedChannel = harness.manager.subscribe('session', 'failed-snapshot', 24, 80)!;
      emulator.failNextSerialize = true;
      emulator.releaseOutputFlush();
      await settleSocketIo(8);

      expect(harness.holder.outputAcks).toEqual([1n]);
      expect(harness.manager.sessionOfChannel(failedChannel)).toBe('session');

      harness.holder.sendOutput(1, 2n, 1n, new TextEncoder().encode('y'));
      await settleSocketIo();
      emulator.releaseOutputFlush();
      await settleSocketIo(8);

      expect(harness.holder.outputAcks).toEqual([1n, 2n]);
      const healthyText = harness.browserFrames
        .filter(
          ({ channelId, frame }) =>
            channelId === harness.channelId && frame.type === BpFrameType.OUTPUT
        )
        .map(({ frame }) =>
          frame.type === BpFrameType.OUTPUT ? new TextDecoder().decode(frame.bytes) : ''
        )
        .join('');
      expect(healthyText).toBe('xy');
    } finally {
      await harness.close();
    }
  });

  it('seals queued child input when a validated exit boundary begins final output drain', async () => {
    const emulator = new BlockingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('A')
        )
      ).toBe(true);
      await harness.holder.inputReceived;
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('B')
        )
      ).toBe(true);

      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('x'));
      await emulator.firstOutputFlushStarted;
      expect(
        harness.manager.observeMoorEvent('session', GENERATION, {
          ts: Date.now() / 1_000,
          type: 'exit',
          code: 0,
          outcome: { kind: 'exited', code: 0, method: 'none' },
          outputEnd: 1n
        })
      ).toMatchObject({ ok: true, authority: { kind: 'applied' } });

      expect(harness.browserErrors).toEqual([BpError.INPUT_UNAVAILABLE]);
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('after-exit')
        )
      ).toBe(false);
      const resizeCount = harness.holder.resizes.length;
      expect(harness.manager.onBrowserResizeByChannel(harness.channelId, 30, 100)).toBe(false);

      harness.holder.acknowledgeLatestInput(1);
      await settleSocketIo(8);
      expect(harness.holder.inputs).toEqual(['A']);
      expect(harness.holder.resizes).toHaveLength(resizeCount);

      emulator.releaseOutputFlush();
      await settleSocketIo(8);
      expect(
        harness.browserFrames
          .filter(({ channelId }) => channelId === harness.channelId)
          .map(({ frame }) => frame.type)
      ).toContain(BpFrameType.EXIT);
    } finally {
      await harness.close();
    }
  });

  it('opens a subscriber at the live frontier while output parser drain is pending', async () => {
    const emulator = new BlockingOutputEmulator();
    const harness = await startRecoveryHarness(() => emulator);
    try {
      harness.holder.sendOutput(1, 1n, 0n, new TextEncoder().encode('x'));
      await emulator.firstOutputFlushStarted;

      const lateChannel = harness.manager.subscribe('session', 'late', 24, 80)!;
      const lateFrames = (): BpFrame[] =>
        harness.browserFrames
          .filter(({ channelId }) => channelId === lateChannel)
          .map(({ frame }) => frame);
      expect(lateFrames().map((frame) => frame.type)).toEqual([BpFrameType.SUBSCRIBE_ACK]);
      expect(lateFrames()[0]).toMatchObject({ type: BpFrameType.SUBSCRIBE_ACK, offset: 1n });

      emulator.releaseOutputFlush();
      await settleSocketIo(8);

      expect(lateFrames().map((frame) => frame.type)).toEqual([BpFrameType.SUBSCRIBE_ACK]);

      harness.holder.sendOutput(1, 2n, 1n, new TextEncoder().encode('y'));
      await settleSocketIo();
      emulator.releaseOutputFlush();
      await settleSocketIo(8);

      const output = lateFrames().find((frame) => frame.type === BpFrameType.OUTPUT);
      expect(output).toMatchObject({
        type: BpFrameType.OUTPUT,
        offset: 1n,
        bytes: new TextEncoder().encode('y')
      });
      if (output?.type !== BpFrameType.OUTPUT) {
        throw new Error('expected one live output frame after the ACK baseline');
      }
      expect(new TextDecoder().decode(output.bytes)).toBe('y');
    } finally {
      await harness.close();
    }
  });

  it('skips retained attach output and delivers the first later live record once', async () => {
    const emulator = new BlockingOutputEmulator();
    const observations: Array<{ text: string; acks: bigint[] }> = [];
    const observe = (holder: ExpiringLeaseHolder): void => {
      observations.push({
        text: new TextDecoder().decode(joined(...emulator.writes)),
        acks: [...holder.outputAcks]
      });
    };
    const harness = await startRecoveryHarness(
      () => emulator,
      (sessionPath) =>
        new ExpiringLeaseHolder(sessionPath, false, INCARNATION, false, false, true),
      async (holder) => {
        await holder.initialAttached;
        observe(holder);
        holder.sendOutput(1, 3n, 2n, new TextEncoder().encode('c'));
        await emulator.firstOutputFlushStarted;
        await settleSocketIo();
        observe(holder);
        emulator.releaseOutputFlush();
        await settleSocketIo();
        observe(holder);
      }
    );
    try {
      expect(observations).toEqual([
        { text: '', acks: [] },
        { text: 'c', acks: [] },
        { text: 'c', acks: [3n] }
      ]);
    } finally {
      await harness.close();
    }
  });

  it('preserves recovery input age after transfer to the attached client queue', async () => {
    const harness = await startRecoveryHarness();
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      await harness.enterRecovery();
      const queuedAt = Date.now();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('must-expire-from-original-age')
        )
      ).toBe(true);
      vi.setSystemTime(queuedAt + 9_000);
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous', 'ambiguous']);

      vi.setSystemTime(queuedAt + 10_001);
      harness.holder.acknowledgeLatestInput(3);
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual(['ambiguous', 'ambiguous']);
      expect(harness.browserErrors).toEqual([BpError.INPUT_UNAVAILABLE]);
    } finally {
      await harness.close();
    }
  });

  it('hide removes input already transferred to the live client queue', async () => {
    const harness = await startRecoveryHarness();
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('in-flight')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['in-flight']);

      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('cancel-after-hide')
        )
      ).toBe(true);
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, false)).toBe(true);

      harness.holder.acknowledgeLatestInput(1);
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual(['in-flight']);
    } finally {
      await harness.close();
    }
  });

  it('hide removes input waiting in the recovery queue', async () => {
    const harness = await startRecoveryHarness();
    try {
      await harness.enterRecovery();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('cancel-during-recovery')
        )
      ).toBe(true);
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, false)).toBe(true);

      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('hide cancels a retained lease tuple before recovery can replay it', async () => {
    const harness = await startRecoveryHarness();
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous']);

      await harness.enterRecovery();
      expect(harness.manager.onBrowserVisibilityByChannel(harness.channelId, false)).toBe(true);
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual(['ambiguous']);
    } finally {
      await harness.close();
    }
  });

  it('unsubscribe removes input already transferred to the attached client queue', async () => {
    const harness = await startRecoveryHarness();
    try {
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('ambiguous')
        )
      ).toBe(true);
      await settleSocketIo();
      await harness.enterRecovery();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('cancel-before-delivery')
        )
      ).toBe(true);

      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();
      expect(harness.holder.inputs).toEqual(['ambiguous', 'ambiguous']);

      harness.manager.unsubscribeChannel(harness.channelId);
      harness.holder.acknowledgeLatestInput(3);
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual(['ambiguous', 'ambiguous']);
    } finally {
      await harness.close();
    }
  });

  it('expires recovery input at the exact ten-second boundary before install', async () => {
    const harness = await startRecoveryHarness();
    try {
      await harness.enterRecovery();
      const queuedAt = Date.now();
      expect(
        harness.manager.onBrowserInputByChannel(
          harness.channelId,
          false,
          new TextEncoder().encode('exact-boundary')
        )
      ).toBe(true);

      vi.setSystemTime(queuedAt + 10_000);
      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.inputs).toEqual([]);
      expect(harness.browserErrors).toEqual([BpError.INPUT_UNAVAILABLE]);
    } finally {
      await harness.close();
    }
  });

  it('applies only the newest recovery resize after viewer lease acquisition', async () => {
    const harness = await startRecoveryHarness();
    try {
      await harness.enterRecovery();
      expect(harness.manager.onBrowserResizeByChannel(harness.channelId, 30, 100)).toBe(true);
      expect(harness.manager.onBrowserResizeByChannel(harness.channelId, 40, 120)).toBe(true);

      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.resizes).toEqual([
        // The harness subscribe ACQUIRED ownership, which commands the
        // subscriber's geometry on the live pre-recovery link (desk#68).
        { connection: 1, columns: 80, rows: 24 },
        // The recovery replay carries only the NEWEST commanded resize.
        { connection: 3, columns: 120, rows: 40 }
      ]);
    } finally {
      await harness.close();
    }
  });

  // desk#68: an observer's resize is never commanded, so it must not be queued
  // for the recovered link either — replaying it would send the very size the
  // runtime refused the moment the link came back.
  it('replays only the OWNING surface resize to the recovered link', async () => {
    const harness = await startRecoveryHarness();
    try {
      const observer = harness.manager.subscribe('session', 'second', 41, 137)!;
      expect(observer).not.toBe(harness.channelId);
      await harness.enterRecovery();
      expect(harness.manager.onBrowserResizeByChannel(harness.channelId, 48, 95)).toBe(true);
      // Reported LAST, and still ignored: ownership decides, not arrival order.
      expect(harness.manager.onBrowserResizeByChannel(observer, 41, 137)).toBe(true);

      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.resizes).toEqual([
        // The acquisition command from the harness subscribe (desk#68).
        { connection: 1, columns: 80, rows: 24 },
        { connection: 3, columns: 95, rows: 48 }
      ]);
      expect(harness.holder.redraws).toEqual([
        // The observer's subscribe asks the owner geometry to redraw, exactly
        // like atch ATTACH + MSG_REDRAW. Its requested 41x137 never becomes a
        // geometry command.
        { connection: 1, columns: 80, rows: 24 },
        // Recovery requests a repaint only after the fresh lease is attached.
        { connection: 3, columns: 95, rows: 48 }
      ]);
    } finally {
      await harness.close();
    }
  });

  // desk#68: a surface that subscribes during a link outage — the tab was
  // closed while the link was down and reopened — ACQUIRES ownership, and the
  // acquisition's commanded geometry must reach the recovered link. No RESIZE
  // frame will follow it (the client's reveal dedupe suppresses an unchanged
  // size), so if the subscribe path did not queue it, the child would come back
  // at whatever size the recovery remembered.
  it('a subscribe that acquires ownership during recovery replays its geometry to the recovered link', async () => {
    const harness = await startRecoveryHarness();
    try {
      await harness.enterRecovery();
      // The only surface leaves mid-outage: no owner remains, nothing commands.
      harness.manager.unsubscribeChannel(harness.channelId);
      // A new tab subscribes at its own measured size and acquires ownership.
      const reopened = harness.manager.subscribe('session', 'reopened', 41, 137)!;
      expect(reopened).not.toBe(harness.channelId);

      harness.holder.allowRecovery();
      await harness.holder.recoveryAttached;
      await settleSocketIo();

      expect(harness.holder.resizes).toEqual([
        // The original harness subscribe's acquisition on the live link.
        { connection: 1, columns: 80, rows: 24 },
        // The mid-outage acquisition, replayed on the recovered link.
        { connection: 3, columns: 137, rows: 41 }
      ]);
    } finally {
      await harness.close();
    }
  });

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

  it('fails closed when the final output boundary cannot be recovered from an absent holder', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const root = mkdtempSync(join(tmpdir(), 'desk-link-final-output-absence-'));
    const sessionPath = join(root, 'session');
    const detachedKillWitness = join(root, 'detached-kill-ran');
    const holder = new ExpiringLeaseHolder(sessionPath, true);
    await holder.listen();
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('session')).toBe(GENERATION);
    const browserFrames: BpFrame[] = [];
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new EmptyEmulator() },
      now: () => Date.now(),
      sendBrowser: (_sessionId, _channelId, frame) => browserFrames.push(frame)
    });
    try {
      expect((await manager.restoreAndAttachMoor('session', {
        sessionPath,
        killSpec: { binPath: '/usr/bin/touch', args: [detachedKillWitness] }
      })).ok).toBe(true);
      const channelId = manager.subscribe('session', 'surface', 24, 80)!;

      expect(
        manager.observeMoorEvent('session', GENERATION, {
          ts: Date.now() / 1_000,
          type: 'exit',
          code: 0,
          outcome: { kind: 'exited', code: 0, method: 'none' },
          outputEnd: 1n
        })
      ).toMatchObject({ ok: true, authority: { kind: 'applied' } });
      expect(browserFrames.filter((frame) => frame.type === BpFrameType.EXIT)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstConnectionClosed;
      await holder.disappeared;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(browserFrames.filter((frame) => frame.type === BpFrameType.EXIT)).toHaveLength(1);
      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'exited',
        exit: {
          origin: 'observed',
          diagnostic: {
            code: 'moor-final-output-truncated',
            detail: 'holder unavailable at output offset 0; expected 1'
          }
        }
      });
      expect(manager.sessionOfChannel(channelId)).toBeUndefined();
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
        sessionPath
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

  it('adopts retained frontiers on live-only recovery without requesting a GAP or applying a tail', async () => {
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
        sessionPath
      })).ok).toBe(true);
      const writesBeforeRecovery = emulator.writes.map((bytes) => bytes.slice());
      expect(joined(...writesBeforeRecovery)).toEqual(new Uint8Array());

      await vi.advanceTimersByTimeAsync(3_001);
      await holder.firstConnectionClosed;
      await holder.recoveryHelloSeen;
      holder.allowRecovery();
      await holder.recoveryAttemptConnected;
      await holder.recoveryAttached;
      await settleSocketIo();

      expect(manager.stateSnapshot('session')).toMatchObject({
        generation: GENERATION,
        lifecycle: 'running',
        health: { status: 'healthy' }
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
