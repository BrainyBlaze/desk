import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MoorEventObserver,
  moorEventStoreDir,
  moorEventStoreRoot
} from '../src/server/runtime/moorEventObserver.js';
import {
  createTerminalDaemon,
  startTerminalDaemonServer
} from '../src/server/runtime/terminalDaemon.js';
import { reconcileExistingSessions } from '../src/server/runtime/terminalDaemonMain.js';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import type { MoorStatus } from '../src/shared/moorWire/messages.js';

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

class FakeUpgradeServer {
  on(_event: 'upgrade', _listener: UpgradeListener): void {}
  off(_event: 'upgrade', _listener: UpgradeListener): void {}
}

const encoder = new TextEncoder();

function pathIdentity(path: string): Uint8Array {
  const pathBytes = Buffer.from(path);
  const identity = new Uint8Array(1 + pathBytes.length);
  identity[0] = 1;
  identity.set(pathBytes, 1);
  return identity;
}

function lossyEquivalentPathIdentity(path: string): Uint8Array {
  const pathBytes = Buffer.from(path);
  const replacement = Buffer.from('\ufffd');
  const replacementOffset = pathBytes.indexOf(replacement);
  if (replacementOffset < 0) throw new Error('path has no replacement character');
  const lossy = new Uint8Array(pathBytes.length - replacement.length + 1);
  lossy.set(pathBytes.subarray(0, replacementOffset));
  lossy[replacementOffset] = 0xff;
  lossy.set(
    pathBytes.subarray(replacementOffset + replacement.length),
    replacementOffset + 1
  );
  return lossy;
}

function writeMoorStore(
  directory: string,
  generation: number,
  sessionPath: string,
  records: readonly string[] = []
): { commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array } {
  const identity = pathIdentity(sessionPath);
  const body = encoder.encode(
    `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(identity).toString('base64')}","generation":${generation},"epoch":0,"next_seq":${records.length},"first_retained":0}\n` +
      records.join('')
  );
  const commit = new Uint8Array(92);
  const view = new DataView(commit.buffer);
  commit.set(encoder.encode('MOORCMT1'), 0);
  commit[8] = 1;
  commit[9] = 0;
  commit[10] = 0;
  commit[11] = 1;
  view.setUint32(12, generation, true);
  view.setUint32(16, 0, true);
  view.setBigUint64(24, 1n, true);
  view.setBigUint64(32, BigInt(body.length), true);
  view.setBigUint64(40, 0n, true);
  view.setBigUint64(48, BigInt(records.length), true);
  const bodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  commit.set(bodyHash, 56);
  view.setUint32(88, crc32c(commit.subarray(0, 88)), true);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'body.0'), body, { mode: 0o600 });
  writeFileSync(join(directory, 'commit.0'), commit, { mode: 0o600 });
  writeFileSync(join(directory, 'body.1'), new Uint8Array(), { mode: 0o600 });
  writeFileSync(join(directory, 'commit.1'), new Uint8Array(), { mode: 0o600 });
  return { commitIndex: 1n, bodyLength: BigInt(body.length), bodyHash };
}

function fakeMoorStatus(
  sessionPath: string,
  generation: number,
  storeDir: string,
  frontier: { commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array }
): MoorStatus {
  return {
    identity: pathIdentity(sessionPath),
    generation,
    incarnation: new Uint8Array(16).fill(0xa1),
    layout: 2,
    eventIdentity: Buffer.from(storeDir),
    bodySlot: 0,
    commitIndex: frontier.commitIndex,
    bodyLength: frontier.bodyLength,
    bodyHash: frontier.bodyHash,
    wallStart: 1n,
    monotonicStart: 1n,
    bootIdentity: new Uint8Array(16).fill(0xb2),
    directory: Buffer.from(sessionPath),
    pid: 4321,
    containment: 1,
    birthToken: new Uint8Array(16).fill(0xc3),
    replay: {
      first: 0n,
      last: 0n,
      start: 0n,
      end: 0n,
      complete: true,
      modesExact: true
    },
    ownsLease: true,
    viewers: true,
    running: true,
    eventWritable: true,
    leaseEpoch: 1,
    semanticFlags: 0,
    semanticPending: 0,
    log: {
      health: 0,
      epoch: 0,
      index: 0n,
      retainedStart: 0n,
      retainedEnd: 0n
    }
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('terminal daemon Moor cutover adversarial review', () => {
  let home: string;
  let eventRoot: string;
  let priorTmpdir: string | undefined;

  beforeEach(() => {
    priorTmpdir = process.env.TMPDIR;
    home = mkdtempSync(join(tmpdir(), 'desk-moor-daemon-review-'));
    process.env.TMPDIR = home;
    eventRoot = moorEventStoreRoot('/opt/moor');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    rmSync(home, { recursive: true, force: true });
  });

  it('stops new provisioning before snapshotting graceful lease handover', async () => {
    const server = await startTerminalDaemonServer({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      host: '127.0.0.1',
      port: 0
    });
    server.daemon.markReady();

    let announceRelease!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      announceRelease = resolve;
    });
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    vi.spyOn(server.daemon.router.sessions, 'releaseAllLeases').mockImplementation(async () => {
      announceRelease();
      await releaseGate;
      return [];
    });
    const provision = vi.spyOn(server.daemon, 'provision').mockResolvedValue({
      ok: true,
      generation: 1,
      created: true
    });

    const closing = server.close();
    await releaseStarted;
    const response = await fetch(`http://127.0.0.1:${server.port}/control/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'late-owner',
        command: ['bash'],
        subject: { kind: 'terminal' }
      })
    }).catch(() => undefined);
    finishRelease();
    await closing;

    expect(response?.status).not.toBe(200);
    expect(provision).not.toHaveBeenCalled();
  });

  it('does not let an admitted provision mutate after the bounded barrier expires', async () => {
    const server = await startTerminalDaemonServer({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      host: '127.0.0.1',
      port: 0
    });
    server.daemon.markReady();

    let announceAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => {
      announceAdmission = resolve;
    });
    const enterMutation = server.daemon.enterMutation.bind(server.daemon);
    vi.spyOn(server.daemon, 'enterMutation').mockImplementation((abort) => {
      const release = enterMutation(abort);
      if (release !== undefined) announceAdmission();
      return release;
    });

    let announceRelease!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      announceRelease = resolve;
    });
    vi.spyOn(server.daemon.router.sessions, 'releaseAllLeases').mockImplementation(async () => {
      announceRelease();
      return [];
    });
    const provision = vi.spyOn(server.daemon, 'provision').mockResolvedValue({
      ok: true,
      generation: 1,
      created: true
    });

    let finishBody!: () => void;
    const responseStatus = new Promise<number | undefined>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/control/provision',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            connection: 'close'
          }
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode));
        }
      );
      req.once('error', () => resolve(undefined));
      req.write('{"sessionId":"pre-admitted"');
      finishBody = () => {
        req.end(',"command":["bash"],"subject":{"kind":"terminal"}}');
      };
    });

    await admitted;
    const closing = server.close();
    await releaseStarted;
    finishBody();
    const status = await responseStatus;
    await closing;

    expect(status).not.toBe(200);
    expect(provision).not.toHaveBeenCalled();
  }, 12_000);

  it('removes the new generation store after observer startup fails and teardown is confirmed', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const storeDir = moorEventStoreDir(eventRoot, 'sess-1', 2);
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 2 });
        mkdirSync(prepared!.storeDir!, { recursive: true });
        return {
          ok: true,
          generation: 2,
          created: true,
          moorStatus: fakeMoorStatus(options.sessionPath, 2, prepared!.storeDir!, {
            commitIndex: 1n,
            bodyLength: 1n,
            bodyHash: new Uint8Array(32).fill(1)
          })
        };
      }
    );
    const retire = vi
      .spyOn(daemon.router.sessions, 'retireGenerationAwaited')
      .mockImplementation(async () => {
        // Frozen Moor owns normal-retirement cleanup after publication.
        rmSync(storeDir, { recursive: true, force: true });
        return { ok: true };
      });

    await expect(
      daemon.provision('sess-1', {
        command: ['bash'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      })
    ).rejects.toThrow('moor event store could not be observed');

    expect(retire).toHaveBeenCalledWith('sess-1', 2);
    expect(existsSync(storeDir)).toBe(false);
    daemon.dispose();
  });

  it('preserves an owned-looking store when observer startup fails and teardown is indeterminate', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    let storeDir = '';
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 2 });
        storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, 2, options.sessionPath, ['not-json\n']);
        return {
          ok: true,
          generation: 2,
          created: true,
          moorStatus: fakeMoorStatus(options.sessionPath, 2, storeDir, frontier)
        };
      }
    );
    vi.spyOn(daemon.router.sessions, 'retireAwaited').mockResolvedValue({
      ok: false,
      error: 'retirement is indeterminate'
    });

    await expect(
      daemon.provision('sess-1', {
        command: ['bash'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      })
    ).rejects.toThrow();

    expect(existsSync(storeDir)).toBe(true);
    daemon.dispose();
  });

  it('does not report a restored session reconciled when its Moor event store cannot be observed', async () => {
    const restoreAndAttachMoor = vi.fn().mockResolvedValue({
      ok: true,
      generation: 9,
      created: true
    });
    const reconcileMoorEvents = vi.fn().mockResolvedValue(false);
    const retireGenerationAwaited = vi.fn().mockResolvedValue({ ok: true });
    const daemon = {
      router: { sessions: { restoreAndAttachMoor, retireGenerationAwaited } },
      reconcileMoorEvents
    } as unknown as Parameters<typeof reconcileExistingSessions>[0];

    const [result] = await reconcileExistingSessions(
      daemon,
      [
        {
          sessionId: 'sess-1',
          sockPath: join(home, 'sess-1'),
          subject: { kind: 'terminal' }
        }
      ],
      '/opt/moor'
    );

    expect(reconcileMoorEvents).toHaveBeenCalledWith('sess-1', 9);
    // desk#59: the retirement must carry WHY it happened, so the resulting
    // exit record names the reconcile failure instead of anonymous nulls.
    expect(retireGenerationAwaited).toHaveBeenCalledWith('sess-1', 9, {
      reason: 'moor-reconcile-failed'
    });
    expect(result).toMatchObject({ sessionId: 'sess-1', ok: false });
  });

  it('refuses a committed event store whose canonical identity belongs to another session', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 2 });
        const frontier = writeMoorStore(
          prepared!.storeDir!,
          2,
          join(home, 'different-session')
        );
        return {
          ok: true,
          generation: 2,
          created: true,
          moorStatus: fakeMoorStatus(options.sessionPath, 2, prepared!.storeDir!, frontier)
        };
      }
    );
    vi.spyOn(daemon.router.sessions, 'retireAwaited').mockResolvedValue({ ok: true });

    await expect(
      daemon.provision('sess-1', {
        command: ['bash'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      })
    ).rejects.toThrow();
    daemon.dispose();
  });

  it('stops replay-exited observation without deleting the Moor-owned store', async () => {
    const diagnostics: string[] = [];
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      moorEventPollIntervalMs: 10,
      onMoorEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.message)
    });
    let storeDir = '';
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath, [
          '{"type":"ready","ts":2,"epoch":0,"seq":0,"kind":"transition"}\n',
          '{"type":"exit","ts":3,"epoch":0,"seq":1,"kind":"transition","ended":"exited","code":0}\n'
        ]);
        return {
          ...ensured,
          moorStatus: fakeMoorStatus(
            options.sessionPath,
            ensured.generation,
            storeDir,
            frontier
          )
        };
      }
    );

    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    await Promise.resolve();

    expect(existsSync(storeDir)).toBe(true);
    writeFileSync(join(storeDir, 'body.0'), 'corrupt');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(diagnostics).toEqual([]);
    daemon.dispose();
  });

  it('retires a live session when its event observer stops on terminal store failure', async () => {
    const diagnostics: string[] = [];
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      moorEventPollIntervalMs: 10,
      onMoorEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.message)
    });
    let storeDir = '';
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath);
        return {
          ...ensured,
          moorStatus: fakeMoorStatus(
            options.sessionPath,
            ensured.generation,
            storeDir,
            frontier
          )
        };
      }
    );

    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    expect(daemon.router.sessions.stateSnapshot('sess-1')).toBeDefined();

    rmSync(storeDir, { recursive: true, force: true });
    await waitFor(() => diagnostics.length > 0, 'terminal observer diagnostic');
    await waitFor(() => {
      const snapshot = daemon.router.sessions.stateSnapshot('sess-1');
      return snapshot === undefined || snapshot.lifecycle === 'exited';
    }, 'session retirement');
    daemon.dispose();
  });

  it('preserves the event store when terminal observer failure cannot confirm retirement', async () => {
    const diagnostics: string[] = [];
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      moorEventPollIntervalMs: 10,
      onMoorEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.message)
    });
    let storeDir = '';
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath);
        return {
          ...ensured,
          moorStatus: fakeMoorStatus(
            options.sessionPath,
            ensured.generation,
            storeDir,
            frontier
          )
        };
      }
    );
    const retire = vi
      .spyOn(daemon.router.sessions, 'retireGenerationAwaited')
      .mockResolvedValue({
        ok: false,
        reason: 'retire-failed',
        expectedGeneration: 2,
        error: 'retirement is indeterminate'
      });

    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });

    writeFileSync(join(storeDir, 'body.0'), 'corrupt');
    await waitFor(() => diagnostics.length > 0, 'terminal observer diagnostic');
    await waitFor(() => retire.mock.calls.length > 0, 'retirement attempt');

    expect(retire).toHaveBeenCalledWith('sess-1', 2);
    expect(existsSync(storeDir)).toBe(true);
    daemon.dispose();
  });

  it('does not remove an unowned event path replacement after confirmed retirement', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    let storeDir = '';
    let observedGeneration = 0;
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        observedGeneration = ensured.generation;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath);
        return {
          ...ensured,
          moorStatus: fakeMoorStatus(
            options.sessionPath,
            ensured.generation,
            storeDir,
            frontier
          )
        };
      }
    );

    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });

    const replacement = join(storeDir, 'unowned-replacement');
    vi.spyOn(daemon.router.sessions, 'retireAwaited').mockImplementation(async () => {
      rmSync(storeDir, { recursive: true, force: true });
      writeMoorStore(storeDir, observedGeneration, join(home, 'sess-1'));
      writeFileSync(replacement, 'replacement');
      return { ok: true };
    });

    await expect(daemon.retire('sess-1')).resolves.toEqual({ ok: true });
    expect(existsSync(replacement)).toBe(true);
    daemon.dispose();
  });

  it('does not let a stale observer terminal callback retire a successor generation', async () => {
    const observers: MoorEventObserver[] = [];
    vi.spyOn(MoorEventObserver.prototype, 'start').mockImplementation(
      async function (this: MoorEventObserver) {
        observers.push(this);
        return true;
      }
    );
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        return {
          ...ensured,
          moorStatus: fakeMoorStatus(
            options.sessionPath,
            ensured.generation,
            prepared!.storeDir!,
            {
              commitIndex: 1n,
              bodyLength: 1n,
              bodyHash: new Uint8Array(32).fill(1)
            }
          )
        };
      }
    );

    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    const staleObserver = observers[0]!;

    daemon.router.sessions.retire('sess-1');
    await Promise.resolve();
    const successor = daemon.router.sessions.ensure(
      'sess-1',
      { rows: 24, cols: 80 },
      { kind: 'terminal' }
    );
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('successor allocation failed');
    const successorStore = moorEventStoreDir(eventRoot, 'sess-1', successor.generation);
    mkdirSync(successorStore, { recursive: true });
    vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
      fakeMoorStatus(join(home, 'sess-1'), successor.generation, successorStore, {
        commitIndex: 1n,
        bodyLength: 1n,
        bodyHash: new Uint8Array(32).fill(1)
      })
    );
    await expect(
      daemon.reconcileMoorEvents('sess-1', successor.generation)
    ).resolves.toBe(true);

    const retire = vi
      .spyOn(daemon.router.sessions, 'retireAwaited')
      .mockResolvedValue({ ok: true });
    const staleTerminal = (
      staleObserver as unknown as { options: { onTerminal?: () => void } }
    ).options.onTerminal;
    staleTerminal?.();
    await Promise.resolve();

    expect(retire).not.toHaveBeenCalled();
    expect(daemon.router.sessions.stateSnapshot('sess-1')?.generation).toBe(
      successor.generation
    );
    daemon.dispose();
  });

  it('rejects an acknowledged frontier whose selected body slot differs from the store', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        const storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath);
        return {
          ...ensured,
          moorStatus: {
            ...fakeMoorStatus(
              options.sessionPath,
              ensured.generation,
              storeDir,
              frontier
            ),
            bodySlot: 1
          }
        };
      }
    );

    try {
      await expect(
        daemon.provision('sess-1', {
          command: ['bash'],
          geometry: { rows: 24, cols: 80 },
          subject: { kind: 'terminal' }
        })
      ).rejects.toThrow('moor event store could not be observed');
    } finally {
      daemon.dispose();
    }
  });

  it('rejects an acknowledged frontier whose committed length differs from the store', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        const storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath);
        return {
          ...ensured,
          moorStatus: {
            ...fakeMoorStatus(
              options.sessionPath,
              ensured.generation,
              storeDir,
              frontier
            ),
            bodyLength: frontier.bodyLength + 1n
          }
        };
      }
    );

    try {
      await expect(
        daemon.provision('sess-1', {
          command: ['bash'],
          geometry: { rows: 24, cols: 80 },
          subject: { kind: 'terminal' }
        })
      ).rejects.toThrow('moor event store could not be observed');
    } finally {
      daemon.dispose();
    }
  });

  it('does not let stale descriptor rejection retire a successor generation', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    let rejectedGeneration = 0;
    let successorGeneration = 0;
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        rejectedGeneration = ensured.generation;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        const status = fakeMoorStatus(
          options.sessionPath,
          ensured.generation,
          prepared!.storeDir!,
          {
            commitIndex: 1n,
            bodyLength: 1n,
            bodyHash: new Uint8Array(32).fill(1)
          }
        );
        daemon.router.sessions.retire(sessionId);
        const successor = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!successor.ok) return successor;
        successorGeneration = successor.generation;
        return { ...ensured, moorStatus: { ...status, layout: 0 } };
      }
    );
    const sessionWideRetire = vi
      .spyOn(daemon.router.sessions, 'retireAwaited')
      .mockImplementation(async (sessionId) => {
        daemon.router.sessions.retire(sessionId);
        return { ok: true };
      });
    const exactGenerationRetire = vi.spyOn(
      daemon.router.sessions,
      'retireGenerationAwaited'
    );

    try {
      await expect(
        daemon.provision('sess-1', {
          command: ['bash'],
          geometry: { rows: 24, cols: 80 },
          subject: { kind: 'terminal' }
        })
      ).rejects.toThrow('moor attach descriptor is missing');

      expect(sessionWideRetire).not.toHaveBeenCalled();
      expect(exactGenerationRetire).toHaveBeenCalledWith(
        'sess-1',
        rejectedGeneration
      );
      expect(daemon.router.sessions.stateSnapshot('sess-1')).toMatchObject({
        generation: successorGeneration,
        lifecycle: 'starting'
      });
    } finally {
      daemon.dispose();
    }
  });

  it('compares the descriptor path identity as exact bytes rather than lossy text', async () => {
    const eventTmpRoot = join(home, '\ufffd');
    const socketRoot = join(home, 'socket');
    mkdirSync(eventTmpRoot, { recursive: true });
    mkdirSync(socketRoot, { recursive: true });
    process.env.TMPDIR = eventTmpRoot;
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: socketRoot,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ensured = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ensured.ok) return ensured;
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: ensured.generation
        });
        const storeDir = prepared!.storeDir!;
        const frontier = writeMoorStore(storeDir, ensured.generation, options.sessionPath);
        return {
          ...ensured,
          moorStatus: {
            ...fakeMoorStatus(
              options.sessionPath,
              ensured.generation,
              storeDir,
              frontier
            ),
            eventIdentity: lossyEquivalentPathIdentity(storeDir)
          }
        };
      }
    );

    try {
      await expect(
        daemon.provision('sess-1', {
          command: ['bash'],
          geometry: { rows: 24, cols: 80 },
          subject: { kind: 'terminal' }
        })
      ).rejects.toThrow('descriptor names a different directory');
    } finally {
      daemon.dispose();
    }
  });
});
