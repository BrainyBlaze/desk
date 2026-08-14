import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import {
  GenerationLedger,
  InMemoryGenerationLedger
} from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor
} from '../src/shared/runtime/workerSupervisor.js';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';
import { MoorCodec, type MoorMessage } from '../src/shared/moorWire/codec.js';
import { MoorKind, type MoorStatus } from '../src/shared/moorWire/messages.js';
import { posixMoorIdentity } from '../src/server/runtime/moorMasterClient.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
const NODE_IMPORT_ARGS = ['--import', 'tsx', FAKE];
const LATE_FAKE = fileURLToPath(new URL('./helpers/late-publish-moor.ts', import.meta.url));
const LATE_NODE_IMPORT_ARGS = ['--import', 'tsx', LATE_FAKE];
const GENERATION = 2;
const INCARNATION = new Uint8Array(16).fill(0xa1);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function runFakeCommand(...args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...NODE_IMPORT_ARGS, ...args], { stdio: 'ignore' });
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
}

function runLateCommand(...args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...LATE_NODE_IMPORT_ARGS, ...args], { stdio: 'ignore' });
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
}

class RecordingEmu implements EmulatorPort {
  readonly written: Uint8Array[] = [];

  constructor(private readonly flushImpl?: () => Promise<void>) {}

  write(bytes: Uint8Array): void {
    this.written.push(bytes.slice());
  }

  flush(): Promise<void> {
    return this.flushImpl?.() ?? Promise.resolve();
  }

  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return '';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (event: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeManager(
  emulator: EmulatorPort = new RecordingEmu(),
  ledger = new GenerationLedger(new InMemoryGenerationLedger())
): SessionManager {
  return new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => emulator },
    now: () => Date.now(),
    sendBrowser: () => {}
  });
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
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

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const wide = (bytes: Uint8Array): Uint8Array => joined(integer(bytes.length, 4), bytes);

function helloAckPayload(identity: Uint8Array): Uint8Array {
  return joined(Uint8Array.of(3), integer(GENERATION, 4), INCARNATION, wide(identity));
}

function statusPayload(identity: Uint8Array): Uint8Array {
  const tail = new Uint8Array(69);
  const view = new DataView(tail.buffer);
  view.setUint8(32, 0x01 | 0x10 | 0x20 | 0x40);
  view.setUint32(33, 1, true);
  return joined(
    wide(identity),
    integer(GENERATION, 4),
    INCARNATION,
    Uint8Array.of(0),
    wide(new Uint8Array(0)),
    Uint8Array.of(0xff),
    integer(0n, 8),
    integer(0n, 8),
    new Uint8Array(32),
    integer(1_000n, 8),
    integer(2_000n, 8),
    new Uint8Array(16).fill(0xb2),
    wide(text('/tmp/moor-holder')),
    integer(4321, 4),
    integer(1, 4),
    new Uint8Array(16).fill(0xc3),
    tail
  );
}

function leaseResultPayload(): Uint8Array {
  return joined(
    Uint8Array.of(0, 0, 0, 0),
    integer(1, 4),
    new Uint8Array(16).fill(0xd4)
  );
}

class ProtocolHolder {
  readonly root = mkdtempSync(join(tmpdir(), 'moor-sm-review-holder-'));
  readonly sockPath = join(this.root, 'session');
  private readonly codec = new MoorCodec();
  private readonly inbox: MoorMessage[] = [];
  private server: Server | undefined;
  private connection: Socket | undefined;

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.connection = socket;
      socket.on('data', (chunk: Buffer) => {
        this.inbox.push(
          ...this.codec.feed(
            Date.now(),
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          )
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.sockPath, resolve));
  }

  async next(timeoutMs = 2_000): Promise<MoorMessage | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (this.inbox.length === 0 && Date.now() <= deadline) await sleep(5);
    return this.inbox.shift();
  }

  send(kind: number, payload: Uint8Array): void {
    this.connection!.write(this.codec.encode(GENERATION, kind, payload));
  }

  sendBatch(...messages: Array<readonly [kind: number, payload: Uint8Array]>): void {
    this.connection!.write(
      joined(...messages.map(([kind, payload]) => this.codec.encode(GENERATION, kind, payload)))
    );
  }

  close(): void {
    this.connection?.destroy();
    this.server?.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

async function driveAttach(holder: ProtocolHolder, attaching: Promise<boolean>): Promise<boolean> {
  const identity = posixMoorIdentity(holder.sockPath);
  expect((await holder.next())?.kind).toBe(MoorKind.HELLO);
  holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
  expect((await holder.next())?.kind).toBe(MoorKind.ATTACH);
  holder.send(MoorKind.TERMINAL_STATE, joined(integer(1, 2), Uint8Array.of(0x0f)));
  holder.send(MoorKind.ATTACH_ACK, statusPayload(identity));
  holder.send(MoorKind.LEASE_RESULT, leaseResultPayload());
  return attaching;
}

describe('SessionManager Moor production-slice adversarial review', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('preallocates the same fresh generation that the durable ledger will allocate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-preallocate-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const manager = makeManager(new RecordingEmu(), ledger);
    const sessionPath = join(root, 's1');
    let seen: { currentGeneration: number; nextGeneration: number } | undefined;

    const result = await manager.spawnAndAttachMoor('s1', {
      binPath: process.execPath,
      sessionPath,
      command: [],
      geometry: { rows: 24, cols: 80 },
      killSpec: {
        binPath: process.execPath,
        args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
      },
      preallocateSpawn: (context) => {
        seen = context;
        return {
          ok: false,
          reason: 'provider-session-identity-missing',
          detail: 'not-authorized'
        };
      }
    });

    expect(result).toMatchObject({ ok: false });
    expect(seen).toMatchObject({ currentGeneration: 0, nextGeneration: 2 });
    expect(ledger.current('s1')).toBe(0);
  });

  it('does not consume the stateful preallocation fence without kill authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-preallocate-order-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const manager = makeManager(new RecordingEmu(), ledger);
    let preallocationCalled = false;

    const result = await manager.spawnAndAttachMoor('s1', {
      binPath: process.execPath,
      sessionPath: join(root, 's1'),
      command: [],
      geometry: { rows: 24, cols: 80 },
      preallocateSpawn: () => {
        preallocationCalled = true;
        return { ok: true };
      }
    });

    expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(preallocationCalled).toBe(false);
    expect(ledger.current('s1')).toBe(0);
  });

  it('refuses generation exhaustion without committing an out-of-range value', () => {
    const store = new InMemoryGenerationLedger();
    store.write('s1', 0xffff_ffff);
    const ledger = new GenerationLedger(store);

    expect(() => ledger.allocate('s1')).toThrow(/generation.*exhaust/i);
    expect(ledger.current('s1')).toBe(0xffff_ffff);
  });

  it('does not treat an arbitrary non-socket path as removable stale rendezvous', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-path-fence-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessionPath = join(root, 's1');
    writeFileSync(sessionPath, 'foreign-data');
    const manager = makeManager();

    const result = await manager.spawnAndAttachMoor('s1', {
      binPath: process.execPath,
      sessionPath,
      command: [],
      geometry: { rows: 24, cols: 80 },
      preallocateSpawn: () => ({
        ok: false,
        reason: 'provider-session-identity-missing',
        detail: 'not-authorized'
      })
    });

    expect(result).toMatchObject({ ok: false });
    expect(readFileSync(sessionPath, 'utf8')).toBe('foreign-data');
  });

  it('preserves a socket when its liveness probe is indeterminate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-indeterminate-'));
    const sessionPath = join(root, 's1');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(sessionPath, resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    chmodSync(sessionPath, 0);
    const manager = makeManager();

    const result = await manager.spawnAndAttachMoor('s1', {
      binPath: process.execPath,
      sessionPath,
      command: [],
      geometry: { rows: 24, cols: 80 },
      preallocateSpawn: () => ({
        ok: false,
        reason: 'provider-session-identity-missing',
        detail: 'not-authorized'
      })
    });

    expect(result).toMatchObject({ ok: false });
    expect(existsSync(sessionPath)).toBe(true);
  });

  it('rejects a noncanonical POSIX identity before allocation or launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-noncanonical-'));
    const actualSessionPath = join(root, 's1');
    const sessionPath = `${root}/../${basename(root)}/s1`;
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(async () => {
      await runFakeCommand('kill', sessionPath);
    });
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const manager = makeManager(new RecordingEmu(), ledger);

    let result: unknown;
    let thrown: unknown;
    try {
      result = await manager.spawnAndAttachMoor('s1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect.soft(ledger.current('s1')).toBe(0);
    expect.soft(existsSync(actualSessionPath)).toBe(false);
    expect.soft(thrown).toBeUndefined();
    expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
  }, 15_000);

  it('cannot report a clean retire for a spawned holder with no retained kill authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-no-kill-'));
    const sessionPath = join(root, 's1');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(async () => {
      await runFakeCommand('kill', sessionPath);
    });
    const manager = makeManager();

    const spawned = await manager.spawnAndAttachMoor('s1', {
      binPath: process.execPath,
      binArgs: NODE_IMPORT_ARGS,
      sessionPath,
      command: ['sleep', '30'],
      geometry: { rows: 24, cols: 80 },
      env: { ...process.env }
    });
    if (!spawned.ok) {
      expect(existsSync(sessionPath)).toBe(false);
      return;
    }

    const retired = await manager.retireAwaited('s1', { reason: 'control-retire' });
    expect(retired.ok).toBe(true);
    expect(existsSync(sessionPath)).toBe(false);
  }, 15_000);

  it('does not leak a detached holder that publishes after launcher timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-late-holder-'));
    const sessionPath = join(root, 's1');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(async () => {
      await runLateCommand('kill', sessionPath);
    });
    const manager = makeManager();

    const result = await manager.spawnAndAttachMoor('s1', {
      binPath: process.execPath,
      binArgs: LATE_NODE_IMPORT_ARGS,
      sessionPath,
      command: [],
      geometry: { rows: 24, cols: 80 },
      // Stabilized under full-suite parallel load (finding 5): the launcher
      // needs headroom to fork and write its spawned-proof before the ready
      // timeout SIGKILLs it, and the holder must still publish strictly
      // AFTER that timeout for the late-publication semantics to hold.
      readyTimeoutMs: 1500,
      env: { ...process.env, LATE_MOOR_DELAY_MS: '2500' },
      killSpec: {
        binPath: process.execPath,
        args: [...LATE_NODE_IMPORT_ARGS, 'kill', sessionPath]
      }
    });

    expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(existsSync(`${sessionPath}.spawned-proof`)).toBe(true);
    await sleep(2700);
    expect(existsSync(sessionPath)).toBe(false);
  }, 12_000);

  it('does not complete the adoption gate before terminal-state parser work drains', async () => {
    let releaseFlush!: () => void;
    let flushStarted = false;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const emulator = new RecordingEmu(() => {
      flushStarted = true;
      return flushGate;
    });
    const manager = makeManager(emulator);
    expect(manager.ensure('s1', { rows: 24, cols: 80 })).toMatchObject({
      ok: true,
      generation: GENERATION
    });
    const holder = new ProtocolHolder();
    await holder.listen();
    cleanups.push(() => holder.close());
    cleanups.push(() => manager.retire('s1'));
    cleanups.push(() => releaseFlush());

    const attaching = manager.moorAttachMaster('s1', holder.sockPath, { rows: 24, cols: 80 }, {
      generation: GENERATION
    });
    let settled = false;
    void attaching.finally(() => {
      settled = true;
    });
    const driven = driveAttach(holder, attaching);
    await waitFor(() => flushStarted, 'terminal-state flush to start');
    await sleep(50);

    expect(settled).toBe(false);
    releaseFlush();
    expect(await driven).toBe(true);
  });

  it('does not route output ahead of the terminal-state parser barrier', async () => {
    let releaseFlush!: () => void;
    let flushStarted = false;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const emulator = new RecordingEmu(() => {
      flushStarted = true;
      return flushGate;
    });
    const manager = makeManager(emulator);
    expect(manager.ensure('s1', { rows: 24, cols: 80 })).toMatchObject({
      ok: true,
      generation: GENERATION
    });
    const holder = new ProtocolHolder();
    await holder.listen();
    cleanups.push(() => holder.close());
    cleanups.push(() => manager.retire('s1'));
    cleanups.push(() => releaseFlush());

    const attaching = manager.moorAttachMaster('s1', holder.sockPath, { rows: 24, cols: 80 }, {
      generation: GENERATION
    });
    const identity = posixMoorIdentity(holder.sockPath);
    expect((await holder.next())?.kind).toBe(MoorKind.HELLO);
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    expect((await holder.next())?.kind).toBe(MoorKind.ATTACH);
    holder.sendBatch(
      [MoorKind.TERMINAL_STATE, joined(integer(1, 2), Uint8Array.of(0x0f))],
      [MoorKind.ATTACH_ACK, statusPayload(identity)],
      [MoorKind.LEASE_RESULT, leaseResultPayload()],
      [MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('output-one'))]
    );
    await waitFor(() => flushStarted, 'terminal-state flush to start');
    await sleep(50);

    expect(
      emulator.written.some((bytes) => new TextDecoder().decode(bytes).includes('output-one'))
    ).toBe(false);
    expect(await holder.next(100)).toBeUndefined();
    releaseFlush();
    expect(await attaching).toBe(true);
    await waitFor(
      () => emulator.written.some((bytes) => new TextDecoder().decode(bytes).includes('output-one')),
      'post-preamble output consumption'
    );
    const acknowledgement = await holder.next(500);
    expect(acknowledgement?.kind).toBe(MoorKind.OUTPUT_ACK);
    expect(
      new DataView(
        acknowledgement!.payload.buffer,
        acknowledgement!.payload.byteOffset
      ).getBigUint64(0, true)
    ).toBe(1n);
  });

  it('acknowledges output after the authoritative emulator consumes it', async () => {
    const emulator = new RecordingEmu();
    const manager = makeManager(emulator);
    expect(manager.ensure('s1', { rows: 24, cols: 80 })).toMatchObject({
      ok: true,
      generation: GENERATION
    });
    const holder = new ProtocolHolder();
    await holder.listen();
    cleanups.push(() => holder.close());
    cleanups.push(() => manager.retire('s1'));

    const attaching = manager.moorAttachMaster('s1', holder.sockPath, { rows: 24, cols: 80 }, {
      generation: GENERATION
    });
    expect(await driveAttach(holder, attaching)).toBe(true);
    holder.send(
      MoorKind.OUTPUT,
      joined(integer(1n, 8), integer(0n, 8), text('output-one'))
    );
    await waitFor(
      () => emulator.written.some((bytes) => new TextDecoder().decode(bytes).includes('output-one')),
      'output consumption'
    );

    const acknowledgement = await holder.next(500);
    expect(acknowledgement?.kind).toBe(MoorKind.OUTPUT_ACK);
    expect(new DataView(acknowledgement!.payload.buffer, acknowledgement!.payload.byteOffset).getBigUint64(0, true)).toBe(1n);
  });

  it('clears an adopted Moor status when restart adoption rolls back', async () => {
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate('s1')).toBe(GENERATION);
    const manager = makeManager(new RecordingEmu(), ledger);
    const adopted = {} as MoorStatus;
    vi.spyOn(manager, 'moorAttachMaster').mockImplementation(async (sessionId) => {
      (
        manager as unknown as {
          moorStatuses: Map<string, MoorStatus>;
        }
      ).moorStatuses.set(sessionId, adopted);
      return false;
    });

    await expect(
      manager.restoreAndAttachMoor('s1', {
        sessionPath: '/tmp/s1',
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/opt/moor', args: ['kill', '-f', '/tmp/s1'] }
      })
    ).resolves.toEqual({ ok: false, reason: 'attach-failed' });

    expect(manager.moorStatus('s1')).toBeUndefined();
    expect(manager.stateSnapshot('s1')).toMatchObject({
      generation: GENERATION,
      lifecycle: 'exited'
    });
    expect(manager.subscribe('s1', 'main', 24, 80)).toBeUndefined();
  });
});
