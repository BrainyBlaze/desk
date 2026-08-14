// desk#64 — a failed attach is not an ended session.
//
// Two daemon incarnations over ONE surviving fake-moor holder. The second
// incarnation's attach is refused by a holder that is demonstrably alive (it
// still answers HELLO). Before this witness existed, restoreAndAttachMoor
// retired the session as `restore-superseded`, which made it `exited`, which
// made channel delivery refuse it as `offline` forever while its child kept
// running: a live agent, deaf, with nothing reporting the condition.
//
// Everything under test is real: the real SessionManager, the real moor wire
// over a real unix socket, a real detached holder process with a real child.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  type SessionManagerDeps
} from '../src/server/runtime/sessionManager.js';
import { MoorMasterClient } from '../src/server/runtime/moorMasterClient.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { canonicalDeliveryDecision } from '../src/server/channelsDeliveryStrategy.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import {
  InMemoryGenerationLedger,
  MOOR_UNADOPTED_REASON,
  type SessionStateSnapshot
} from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
const NODE_IMPORT_ARGS = ['--import', 'tsx', FAKE];

class ByteSinkEmu implements EmulatorPort {
  readonly written: Uint8Array[] = [];
  write(bytes: Uint8Array): void {
    this.written.push(bytes.slice());
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
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function holderPid(sessionPath: string): number {
  return Number(readFileSync(`${sessionPath}.holder-pid`).toString().trim());
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killSurvivingHolder(sessionPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [...NODE_IMPORT_ARGS, 'kill', sessionPath], {
      stdio: 'ignore'
    });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

/** The PRIOR daemon incarnation: a detached holder carrying `generation`. */
async function spawnSurvivingHolder(input: {
  sessionPath: string;
  storeDir: string;
  generation: number;
  command: string[];
  tmpdirRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { child } = spawnMoorMaster({
    binPath: process.execPath,
    args: [...NODE_IMPORT_ARGS, 'start', '-T', input.storeDir, input.sessionPath, ...input.command],
    generation: input.generation,
    env: { ...process.env, TMPDIR: input.tmpdirRoot, ...input.env }
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`fake moor launcher exited ${code}`);
}

interface ManagerOptions {
  emulator?: ByteSinkEmu;
  onLateMoorAdoption?: SessionManagerDeps['onLateMoorAdoption'];
}

function makeManager(
  ledger: GenerationLedger,
  options: ManagerOptions = {}
): SessionManager {
  return new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => options.emulator ?? new ByteSinkEmu() },
    now: () => Date.now(),
    sendBrowser: () => {},
    ...(options.onLateMoorAdoption === undefined
      ? {}
      : { onLateMoorAdoption: options.onLateMoorAdoption })
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function textWritten(emulator: ByteSinkEmu): string {
  return emulator.written
    .map((bytes) => new TextDecoder().decode(bytes))
    .join('');
}

function geometryWitnessLines(sessionPath: string): string[] {
  const path = `${sessionPath}.geometry-witness`;
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    : [];
}

function viewerLeaseRequestCount(sessionPath: string): number {
  const path = `${sessionPath}.viewer-lease-requests`;
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0).length
    : 0;
}

/**
 * The recovery slot a manager actually holds for a session. Read directly
 * because "a retry is armed" is a FACT about the manager, and a test that
 * accepted the return value of the call that arms it would be trusting the
 * same statement the code under test is trusted not to trust.
 */
function recoveryFor(
  manager: SessionManager,
  sessionId: string
): {
  generation: number;
  episode: number;
  inputQueue: Array<{ queuedAt: number }>;
} | undefined {
  return (
    manager as unknown as {
      recoveries: Map<
        string,
        {
          generation: number;
          episode: number;
          inputQueue: Array<{ queuedAt: number }>;
        }
      >;
    }
  ).recoveries.get(sessionId);
}

function expireRecoveryInputNow(manager: SessionManager, sessionId: string): void {
  const internals = manager as unknown as {
    recoveries: Map<
      string,
      {
        generation: number;
        episode: number;
        inputQueue: Array<{ queuedAt: number }>;
      }
    >;
    armRecoveryInputExpiry(slot: {
      generation: number;
      episode: number;
      inputQueue: Array<{ queuedAt: number }>;
    }): void;
  };
  const slot = internals.recoveries.get(sessionId);
  const oldest = slot?.inputQueue[0];
  if (slot === undefined || oldest === undefined) {
    throw new Error(`missing queued recovery input for ${sessionId}`);
  }
  // Preserve the real expiry/timer path while moving only the test record's
  // age beyond every finite production retention window.
  oldest.queuedAt = 0;
  internals.armRecoveryInputExpiry(slot);
}

function retainedKillFor(
  manager: SessionManager,
  sessionId: string
): { generation: number } | undefined {
  return (
    manager as unknown as {
      detachedKills: Map<string, { generation: number }>;
    }
  ).detachedKills.get(sessionId);
}

function batchOf(snapshot: SessionStateSnapshot | undefined): {
  ok: boolean;
  revision: number | null;
  snapshots: SessionStateSnapshot[];
} {
  return {
    ok: true,
    revision: snapshot?.revision ?? 1,
    snapshots: snapshot === undefined ? [] : [snapshot]
  };
}

describe('desk#64 — restart attach failure retains the session', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    try {
      while (cleanups.length > 0) await cleanups.pop()!();
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * Build the shared world: one surviving holder at generation 2, a durable
   * ledger that outlives the first incarnation, and a refusal switch the test
   * flips to make the SECOND incarnation's attach fail against a holder that
   * is still alive and still answering HELLO.
   */
  async function twoIncarnations(
    id: string,
    command: string[] = ['sleep', '60'],
    options: {
      onLateMoorAdoption?: SessionManagerDeps['onLateMoorAdoption'];
      viewerLeaseBusy?: boolean;
      refuseTerminate?: boolean;
    } = {}
  ): Promise<{
    root: string;
    sessionPath: string;
    refuseFile: string;
    viewerLeaseBusyFile?: string;
    refuseTerminateFile?: string;
    ledger: GenerationLedger;
    second: SessionManager;
    emulator: ByteSinkEmu;
    pid: number;
    /**
     * The registered detached-holder teardown, deliberately INSTANT: if any
     * code path ever fires the retained kill record, the holder is gone within
     * milliseconds and the "still alive" assertions below fail immediately
     * rather than racing a node+tsx process launch.
     */
    killSpec: { binPath: string; args: string[] };
  }> {
    const root = mkdtempSync(join(tmpdir(), `desk64-${id}-`));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessionPath = join(root, id);
    const refuseFile = join(root, 'refuse-attach');
    const viewerLeaseBusyFile = options.viewerLeaseBusy
      ? join(root, 'viewer-lease-busy')
      : undefined;
    const refuseTerminateFile = options.refuseTerminate
      ? join(root, 'refuse-terminate')
      : undefined;
    cleanups.push(() => killSurvivingHolder(sessionPath));

    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate(id)).toBe(2);
    await spawnSurvivingHolder({
      sessionPath,
      storeDir: join(moorEventStoreRoot(process.execPath, { tmpdir: root }), `${id}.events`),
      generation: 2,
      command,
      tmpdirRoot: root,
      env: {
        FAKE_MOOR_REFUSE_ATTACH_FILE: refuseFile,
        ...(viewerLeaseBusyFile === undefined
          ? {}
          : { FAKE_MOOR_VIEWER_LEASE_BUSY_FILE: viewerLeaseBusyFile }),
        ...(refuseTerminateFile === undefined
          ? {}
          : { FAKE_MOOR_REFUSE_TERMINATE_FILE: refuseTerminateFile })
      }
    });
    const pid = holderPid(sessionPath);
    expect(processAlive(pid)).toBe(true);

    // Incarnation 1 adopts the holder, then departs WITHOUT killing it — the
    // ordinary daemon restart.
    const first = makeManager(ledger);
    const adopted = await first.restoreAndAttachMoor(id, {
      sessionPath,
      geometry: { rows: 24, cols: 80 },
      killSpec: { binPath: process.execPath, args: [...NODE_IMPORT_ARGS, 'kill', sessionPath] }
    });
    expect(adopted.ok).toBe(true);
    first.closeAllLinks();

    // The holder now refuses every ATTACH while still answering HELLO.
    writeFileSync(refuseFile, 'refuse');
    if (viewerLeaseBusyFile !== undefined) writeFileSync(viewerLeaseBusyFile, 'busy');
    if (refuseTerminateFile !== undefined) writeFileSync(refuseTerminateFile, 'refuse');

    const emulator = new ByteSinkEmu();
    const second = makeManager(ledger, {
      emulator,
      ...(options.onLateMoorAdoption === undefined
        ? {}
        : { onLateMoorAdoption: options.onLateMoorAdoption })
    });
    cleanups.push(() => second.closeAllLinks());
    return {
      root,
      sessionPath,
      refuseFile,
      ...(viewerLeaseBusyFile === undefined ? {} : { viewerLeaseBusyFile }),
      ...(refuseTerminateFile === undefined ? {} : { refuseTerminateFile }),
      ledger,
      second,
      emulator,
      pid,
      killSpec: { binPath: '/bin/sh', args: ['-c', `kill -9 ${pid}`] }
    };
  }

  it(
    'does not retire the session, and does not kill the holder, when the restart attach fails',
    async () => {
      const world = await twoIncarnations('r64a');

      const restored = await world.second.restoreAndAttachMoor('r64a', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(restored.ok).toBe(false);

      const snapshot = world.second.stateSnapshot('r64a');
      expect(snapshot).toBeDefined();
      // The defect: `exited` with {origin:'retired', reason:'restore-superseded'}.
      expect(snapshot!.lifecycle).not.toBe('exited');
      expect(snapshot!.exit).toBeNull();
      // Not merely non-terminal — legibly unadopted, on the health axis the
      // sidebar, the native surface and /control/agent-states all render.
      expect(snapshot!.health).toMatchObject({
        status: 'degraded',
        reason: MOOR_UNADOPTED_REASON
      });
      // No adopted descriptor may be published by a failed adoption.
      expect(world.second.moorStatus('r64a')).toBeUndefined();

      // The whole point: the holder and its child are untouched. Asserted
      // after a settle, because a kill fired here would be asynchronous — an
      // immediate check would pass while the holder was already dying.
      await sleep(500);
      expect(processAlive(world.pid)).toBe(true);
      expect(existsSync(world.sessionPath)).toBe(true);
      expect(world.second.stateSnapshot('r64a')?.lifecycle).not.toBe('exited');
    },
    60_000
  );

  it(
    'delivers channel messages to a session whose attach failed (it is not offline)',
    async () => {
      const world = await twoIncarnations('r64b');
      await world.second.restoreAndAttachMoor('r64b', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });

      // The link that made the defect invisible: channelsDeliveryStrategy
      // refuses `exited` as `offline` and `starting` as `booting`, and
      // channelsEngine HOLDS the queue on both — so an unreachable session
      // silently accumulated messages it could never receive.
      const decision = canonicalDeliveryDecision(
        batchOf(world.second.stateSnapshot('r64b')),
        'r64b',
        Date.now()
      );
      expect(decision.deliver).toBe(true);
      expect(processAlive(world.pid)).toBe(true);
    },
    60_000
  );

  it(
    'explicit observer-free low-level composition adopts when the holder accepts a later attach',
    async () => {
      const world = await twoIncarnations('r64c');
      const failed = await world.second.restoreAndAttachMoor('r64c', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);
      expect(world.second.moorStatus('r64c')).toBeUndefined();

      // This test composes SessionManager directly, outside TerminalWsRouter
      // and the daemon observer boundary. Omitting the callback is the explicit
      // observer-free low-level contract, not a production fallback.
      // The holder starts accepting attaches again; the registered retry — the
      // SAME generation/owner-fenced recovery slot the controller-link path
      // uses — must adopt without any further call from the daemon.
      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () => world.second.moorStatus('r64c') !== undefined,
        'the registered retry adopted the surviving holder'
      );

      const status = world.second.moorStatus('r64c');
      // The fence is intact: adoption happened at the restored generation.
      expect(status?.generation).toBe(2);
      expect(world.ledger.current('r64c')).toBe(2);
      const snapshot = world.second.stateSnapshot('r64c');
      expect(snapshot?.lifecycle).toBe('running');
      expect(snapshot?.generation).toBe(2);
      expect(snapshot?.health.status).toBe('healthy');
      expect(processAlive(world.pid)).toBe(true);
    },
    60_000
  );

  it(
    'desk#66 late adoption stays degraded and holds queued work until observer acceptance',
    async () => {
      const gate = deferred<boolean>();
      const onLateMoorAdoption = vi.fn(() => gate.promise);
      const world = await twoIncarnations('r66-gate', ['cat'], {
        onLateMoorAdoption
      });
      const failed = await world.second.restoreAndAttachMoor('r66-gate', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);

      const channelId = world.second.subscribe('r66-gate', 'main', 24, 80);
      expect(channelId).toBeDefined();
      expect(
        world.second.onBrowserInputByChannel(
          channelId!,
          false,
          new TextEncoder().encode('held-until-observed\n')
        )
      ).toBe(true);
      expect(world.second.onBrowserResizeByChannel(channelId!, 31, 101)).toBe(true);

      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () => onLateMoorAdoption.mock.calls.length === 1,
        'the late-adoption observer callback started',
        5_000
      );
      expect(onLateMoorAdoption).toHaveBeenCalledWith('r66-gate', 2);
      expect(world.second.moorStatus('r66-gate')?.generation).toBe(2);

      await sleep(300);
      expect(world.second.stateSnapshot('r66-gate')?.health).toMatchObject({
        status: 'degraded',
        reason: MOOR_UNADOPTED_REASON
      });
      expect(textWritten(world.emulator)).not.toContain('held-until-observed');
      const geometryWhilePending = geometryWitnessLines(world.sessionPath);

      gate.resolve(true);
      await waitFor(
        () => world.second.stateSnapshot('r66-gate')?.health.status === 'healthy',
        'observer acceptance completed recovery'
      );
      await waitFor(
        () => textWritten(world.emulator).includes('held-until-observed'),
        'queued input flushed only after observer acceptance'
      );
      await waitFor(
        () => geometryWitnessLines(world.sessionPath).includes('resize 101x31'),
        'queued resize flushed only after observer acceptance'
      );
      const finalGeometry = geometryWitnessLines(world.sessionPath);
      const nonPreservingAttachCount = finalGeometry.filter(
        (line) => line.startsWith('attach ') && line !== 'attach 0x0'
      ).length;
      const exactResizeCount = finalGeometry.filter(
        (line) => line === 'resize 101x31'
      ).length;

      expect.soft(geometryWhilePending).not.toContain('attach 101x31');
      expect.soft(geometryWhilePending).not.toContain('resize 101x31');
      expect(nonPreservingAttachCount).toBe(0);
      expect(exactResizeCount).toBe(1);
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
    },
    60_000
  );

  it(
    'desk#66 late adoption gates input, resize, and liveness arriving after attach publication',
    async () => {
      const livenessPrototype = MoorMasterClient.prototype as unknown as {
        livenessWindowMs: number;
        armLiveness(): void;
      };
      const armLiveness = livenessPrototype.armLiveness;
      const livenessSpy = vi
        .spyOn(livenessPrototype, 'armLiveness')
        .mockImplementation(function (this: typeof livenessPrototype): void {
          // Exercise the real liveness timer/probe path without paying the
          // production 15-second window in this focused transaction witness.
          this.livenessWindowMs = 50;
          armLiveness.call(this);
        });
      const gate = deferred<boolean>();
      try {
        const onLateMoorAdoption = vi.fn(() => gate.promise);
        const world = await twoIncarnations('r66-post-attach-gate', ['cat'], {
          onLateMoorAdoption
        });
        const failed = await world.second.restoreAndAttachMoor('r66-post-attach-gate', {
          sessionPath: world.sessionPath,
          geometry: { rows: 24, cols: 80 },
          killSpec: world.killSpec
        });
        expect(failed.ok).toBe(false);

        const channelId = world.second.subscribe('r66-post-attach-gate', 'main', 24, 80);
        expect(channelId).toBeDefined();
        rmSync(world.refuseFile, { force: true });
        await waitFor(
          () => onLateMoorAdoption.mock.calls.length === 1,
          'the post-attach transaction reached its observer gate',
          5_000
        );
        expect(world.second.moorStatus('r66-post-attach-gate')?.generation).toBe(2);

        // These arrive only AFTER the ATTACH_ACK authority is published and
        // the observer callback is pending. None may bypass that transaction.
        expect(
          world.second.onBrowserInputByChannel(
            channelId!,
            false,
            new TextEncoder().encode('post-attach-held\n')
          )
        ).toBe(true);
        expect(world.second.onBrowserResizeByChannel(channelId!, 37, 109)).toBe(true);

        const inputDeliveryCount = (): number =>
          textWritten(world.emulator).split('post-attach-held\n').length - 1;
        const resizeDeliveryCount = (): number =>
          geometryWitnessLines(world.sessionPath).filter(
            (line) => line === 'resize 109x37'
          ).length;

        // This is a timing witness by design: 300 ms spans six of the explicit
        // 50 ms liveness windows above, allowing the real authenticated probe
        // to complete while the adoption callback remains unresolved.
        await sleep(300);
        const healthWhilePending = world.second.stateSnapshot('r66-post-attach-gate')?.health;
        const outputWhilePending = textWritten(world.emulator);
        const geometryWhilePending = geometryWitnessLines(world.sessionPath);

        gate.resolve(true);
        await waitFor(
          () => world.second.stateSnapshot('r66-post-attach-gate')?.health.status === 'healthy',
          'observer acceptance completed the post-attach transaction'
        );
        await waitFor(
          () => inputDeliveryCount() >= 1,
          'post-attach input was released after observer acceptance'
        );
        await waitFor(
          () => resizeDeliveryCount() >= 1,
          'the latest commanded resize was released after observer acceptance'
        );

        expect.soft(healthWhilePending?.status).toBe('degraded');
        expect.soft(outputWhilePending).not.toContain('post-attach-held');
        expect.soft(geometryWhilePending).not.toContain('resize 109x37');
        expect(inputDeliveryCount()).toBe(1);
        expect(resizeDeliveryCount()).toBe(1);
      } finally {
        gate.resolve(true);
        livenessSpy.mockRestore();
      }
    },
    60_000
  );

  it(
    'desk#66 input expiry re-entry evaluates one late-adoption callback per recovery episode',
    async () => {
      const gate = deferred<boolean>();
      const onLateMoorAdoption = vi.fn(() => gate.promise);
      const world = await twoIncarnations('r66-callback-once', ['cat'], {
        onLateMoorAdoption
      });
      const failed = await world.second.restoreAndAttachMoor('r66-callback-once', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);

      const channelId = world.second.subscribe('r66-callback-once', 'main', 24, 80);
      expect(channelId).toBeDefined();
      expect(
        world.second.onBrowserInputByChannel(
          channelId!,
          false,
          new TextEncoder().encode('expires-while-observer-pending\n')
        )
      ).toBe(true);

      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () => onLateMoorAdoption.mock.calls.length === 1,
        'the first observer evaluation is pending',
        5_000
      );
      const episode = recoveryFor(world.second, 'r66-callback-once')?.episode;
      expect(episode).toBeDefined();

      expireRecoveryInputNow(world.second, 'r66-callback-once');
      await waitFor(
        () => recoveryFor(world.second, 'r66-callback-once')?.inputQueue.length === 0,
        'the real recovery input-expiry timer fired',
        5_000
      );
      // The retry attach has a documented two-second absolute deadline. This
      // 2.5-second bounded interval gives any prohibited timer re-entry its
      // full opportunity to reach the still-pending callback.
      await sleep(2_500);
      const evaluations = onLateMoorAdoption.mock.calls.length;

      gate.resolve(true);
      await waitFor(
        () => world.second.stateSnapshot('r66-callback-once')?.health.status === 'healthy',
        'the one observer evaluation completed recovery'
      );
      expect(recoveryFor(world.second, 'r66-callback-once')).toBeUndefined();
      expect(evaluations).toBe(1);
    },
    60_000
  );

  it.each([
    { outcome: 'false' as const },
    { outcome: 'throw' as const }
  ])(
    'desk#66 late adoption callback $outcome retires the exact generation',
    async ({ outcome }) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onLateMoorAdoption = vi.fn(async () => {
        if (outcome === 'throw') throw new Error('observer failed');
        return false;
      });
      const id = `r66-${outcome}`;
      const world = await twoIncarnations(id, ['sleep', '60'], {
        onLateMoorAdoption
      });
      const failed = await world.second.restoreAndAttachMoor(id, {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', world.sessionPath]
        }
      });
      expect(failed.ok).toBe(false);

      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () => world.second.stateSnapshot(id)?.lifecycle === 'exited',
        `callback ${outcome} retired the late adoption`,
        5_000
      );
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
      expect(onLateMoorAdoption).toHaveBeenCalledWith(id, 2);
      expect(world.second.stateSnapshot(id)?.exit).toMatchObject({
        origin: 'retired',
        reason: 'moor-reconcile-failed'
      });
      await waitFor(
        () => !existsSync(world.sessionPath),
        `callback ${outcome} retirement removed the holder`
      );
      if (outcome === 'throw') {
        expect(
          consoleError.mock.calls.some((args) => args.join(' ').includes('observer failed'))
        ).toBe(true);
      }
    },
    60_000
  );

  it(
    'desk#66 observer-only lease retries reuse one accepted late observer',
    async () => {
      const onLateMoorAdoption = vi.fn(async () => true);
      const world = await twoIncarnations('r66-observer-lease', ['cat'], {
        onLateMoorAdoption,
        viewerLeaseBusy: true
      });
      const failed = await world.second.restoreAndAttachMoor('r66-observer-lease', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);
      const channelId = world.second.subscribe('r66-observer-lease', 'main', 24, 80);
      expect(channelId).toBeDefined();
      expect(
        world.second.onBrowserInputByChannel(
          channelId!,
          false,
          new TextEncoder().encode('after-viewer-lease\n')
        )
      ).toBe(true);

      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () => onLateMoorAdoption.mock.calls.length === 1,
        'observer authority accepted the observer-only attachment',
        5_000
      );
      await waitFor(
        () => viewerLeaseRequestCount(world.sessionPath) >= 2,
        'at least two observer-only lease retries stayed busy',
        5_000
      );
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
      expect(world.second.stateSnapshot('r66-observer-lease')?.health.status).toBe(
        'degraded'
      );
      expect(textWritten(world.emulator)).not.toContain('after-viewer-lease');

      rmSync(world.viewerLeaseBusyFile!, { force: true });
      await waitFor(
        () =>
          world.second.stateSnapshot('r66-observer-lease')?.health.status ===
          'healthy',
        'the existing observer link acquired its viewer lease'
      );
      await waitFor(
        () => textWritten(world.emulator).includes('after-viewer-lease'),
        'queued input flushed after the observer link acquired its viewer lease'
      );
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
    },
    60_000
  );

  it(
    'desk#66 failed reconcile retirement stays retired with teardown retained and no queued release',
    async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onLateMoorAdoption = vi.fn(async () => false);
      const world = await twoIncarnations('r66-retire-failed', ['cat'], {
        onLateMoorAdoption,
        refuseTerminate: true
      });
      const failed = await world.second.restoreAndAttachMoor('r66-retire-failed', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/bin/false', args: [] }
      });
      expect(failed.ok).toBe(false);
      const channelId = world.second.subscribe('r66-retire-failed', 'main', 24, 80);
      expect(channelId).toBeDefined();
      expect(
        world.second.onBrowserInputByChannel(
          channelId!,
          false,
          new TextEncoder().encode('must-never-flush\n')
        )
      ).toBe(true);
      expect(world.second.onBrowserResizeByChannel(channelId!, 33, 99)).toBe(true);

      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () =>
          consoleError.mock.calls.some((args) =>
            args.join(' ').includes('could not retire unreconciled Moor adoption')
          ),
        'failed exact-generation retirement was reported',
        5_000
      );
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
      expect(world.second.stateSnapshot('r66-retire-failed')).toMatchObject({
        generation: 2,
        lifecycle: 'exited',
        exit: { origin: 'retired', reason: 'moor-reconcile-failed' }
      });
      expect(retainedKillFor(world.second, 'r66-retire-failed')?.generation).toBe(2);
      expect(recoveryFor(world.second, 'r66-retire-failed')).toBeUndefined();
      expect(existsSync(world.sessionPath)).toBe(true);
      expect(processAlive(world.pid)).toBe(true);

      await sleep(750);
      expect(onLateMoorAdoption).toHaveBeenCalledTimes(1);
      expect(recoveryFor(world.second, 'r66-retire-failed')).toBeUndefined();
      expect(world.second.stateSnapshot('r66-retire-failed')?.health.status).not.toBe(
        'healthy'
      );
      expect(textWritten(world.emulator)).not.toContain('must-never-flush');
      expect(geometryWitnessLines(world.sessionPath)).not.toContain('resize 99x33');
    },
    60_000
  );

  it.each([
    {
      outcome: 'true' as const,
      settle: (gate: Deferred<boolean>) => gate.resolve(true)
    },
    {
      outcome: 'false' as const,
      settle: (gate: Deferred<boolean>) => gate.resolve(false)
    },
    {
      outcome: 'throw' as const,
      settle: (gate: Deferred<boolean>) => gate.reject(new Error('stale observer failure'))
    }
  ])(
    'desk#66 stale late-adoption callback $outcome cannot touch a successor',
    async ({ outcome, settle }) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const gate = deferred<boolean>();
      const onLateMoorAdoption = vi.fn(() => gate.promise);
      const id = `r66-stale-${outcome}`;
      const world = await twoIncarnations(id, ['sleep', '60'], {
        onLateMoorAdoption
      });
      const failed = await world.second.restoreAndAttachMoor(id, {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', world.sessionPath]
        }
      });
      expect(failed.ok).toBe(false);

      rmSync(world.refuseFile, { force: true });
      await waitFor(
        () => onLateMoorAdoption.mock.calls.length === 1,
        `the stale ${outcome} callback is pending`,
        5_000
      );
      expect(recoveryFor(world.second, id)).toMatchObject({ generation: 2 });

      const retire = vi.spyOn(world.second, 'retireGenerationAwaited');
      await expect(
        world.second.retireGenerationAwaited(id, 2, { reason: 'control-retire' })
      ).resolves.toEqual({ ok: true });
      const successor = world.second.ensure(id, { rows: 24, cols: 80 });
      expect(successor).toMatchObject({ ok: true, generation: 3 });
      const before = world.second.stateSnapshot(id);
      retire.mockClear();

      settle(gate);
      await sleep(300);
      expect(retire).not.toHaveBeenCalled();
      expect(world.second.stateSnapshot(id)).toEqual(before);
      expect(world.second.stateSnapshot(id)).toMatchObject({
        generation: 3,
        lifecycle: 'starting'
      });
      expect(recoveryFor(world.second, id)).toBeUndefined();
      if (outcome === 'throw') {
        expect(
          consoleError.mock.calls.some((args) =>
            args.join(' ').includes('stale observer failure')
          )
        ).toBe(true);
      }
    },
    60_000
  );

  it(
    'OVER-CORRECTION GUARD: a stale-generation holder is still refused by the retry',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'desk64-fence-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'r64d');
      cleanups.push(() => killSurvivingHolder(sessionPath));

      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      expect(ledger.allocate('r64d')).toBe(2);
      await spawnSurvivingHolder({
        sessionPath,
        storeDir: join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 'r64d.events'),
        generation: 2,
        command: ['sleep', '60'],
        tmpdirRoot: root
      });
      const pid = holderPid(sessionPath);
      // The ledger moved past the holder (a crash between allocate and spawn).
      expect(ledger.allocate('r64d')).toBe(3);

      const manager = makeManager(ledger);
      cleanups.push(() => manager.closeAllLinks());
      const restored = await manager.restoreAndAttachMoor('r64d', {
        sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: process.execPath, args: [...NODE_IMPORT_ARGS, 'kill', sessionPath] }
      });
      expect(restored.ok).toBe(false);

      // Retention must not weaken the §3 fence: this holder carries generation
      // 2 and the session is generation 3. Several retry rounds must pass with
      // NO adoption — and the mismatched holder is never killed to tidy up.
      await sleep(3_000);
      expect(manager.moorStatus('r64d')).toBeUndefined();
      expect(manager.stateSnapshot('r64d')?.generation).toBe(3);
      expect(manager.stateSnapshot('r64d')?.health).toMatchObject({
        status: 'degraded',
        reason: MOOR_UNADOPTED_REASON
      });
      expect(processAlive(pid)).toBe(true);
      expect(existsSync(sessionPath)).toBe(true);
    },
    60_000
  );

  it(
    'still retires when holder absence is CONFIRMED after the failed attach',
    async () => {
      const world = await twoIncarnations('r64e');
      const failed = await world.second.restoreAndAttachMoor('r64e', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);
      expect(world.second.stateSnapshot('r64e')?.lifecycle).not.toBe('exited');

      // SIGKILL leaves the rendezvous node behind with no listener, so the
      // retry's connect gets ECONNREFUSED: the kernel positively states that
      // nobody is listening there. That — not a missing socket file — is the
      // confirmed absence that may end a session.
      process.kill(world.pid, 'SIGKILL');
      await waitFor(() => !processAlive(world.pid), 'the holder process is gone');

      await waitFor(
        () => world.second.stateSnapshot('r64e')?.lifecycle === 'exited',
        'the retry observed confirmed holder absence and retired the session'
      );
      expect(world.second.stateSnapshot('r64e')?.exit).toMatchObject({
        origin: 'retired',
        reason: 'confirmed-holder-absence'
      });
    },
    60_000
  );

  it(
    'never claims retention the authority refused: a rejected markRunning reports retained:false',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'desk64-refused-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      expect(ledger.allocate('r64g')).toBe(2);
      const manager = makeManager(ledger);
      cleanups.push(() => manager.closeAllLinks());

      // A concurrent retire lands while the attach is in flight — the window
      // is real: the attach awaits socket I/O. The authority then refuses the
      // starting→running transition with `lifecycle-exited`.
      vi.spyOn(manager, 'moorAttachMaster').mockImplementation(async () => {
        manager.retire('r64g', 'kill-switch');
        return false;
      });

      const result = await manager.restoreAndAttachMoor('r64g', {
        sessionPath: join(root, 'r64g'),
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/bin/true', args: [] }
      });

      expect(result.ok).toBe(false);
      // The claim the caller repeats to an operator ("retained, retrying")
      // must not be made for a session the authority says is over.
      expect(result).toEqual({
        ok: false,
        reason: 'attach-failed',
        retained: false,
        generation: 2
      });
      expect(manager.stateSnapshot('r64g')).toMatchObject({
        lifecycle: 'exited',
        exit: { origin: 'retired', reason: 'kill-switch' }
      });
    },
    30_000
  );

  it(
    'reads the authority answer itself: a refused markRunning alone blocks the retention claim',
    async () => {
      // The test above cannot attribute its outcome: every path that exits a
      // session also clears the operation's owner token, so the ownership
      // guard would report retained:false even if the authority's answer were
      // ignored. This one isolates the markRunning check by refusing ONLY that
      // transition, with ownership and lifecycle otherwise intact — the
      // `generation-mismatch` rejection, which a successor registration can
      // produce without touching the owner map.
      const root = mkdtempSync(join(tmpdir(), 'desk64-refused-authority-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      expect(ledger.allocate('r64h')).toBe(2);
      const manager = makeManager(ledger);
      cleanups.push(() => manager.closeAllLinks());

      const core = (manager as unknown as {
        core: { markRunning: (sessionId: string, generation: number) => unknown };
      }).core;
      const markRunning = vi
        .spyOn(core, 'markRunning')
        .mockReturnValue({ kind: 'rejected', reason: 'generation-mismatch' });
      vi.spyOn(manager, 'moorAttachMaster').mockResolvedValue(false);

      const result = await manager.restoreAndAttachMoor('r64h', {
        sessionPath: join(root, 'r64h'),
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/bin/true', args: [] }
      });

      expect(markRunning).toHaveBeenCalledWith('r64h', 2);
      expect(result).toEqual({
        ok: false,
        reason: 'attach-failed',
        retained: false,
        generation: 2
      });
      // The refusal must precede every effect that presumes retention: no
      // unadopted health written for a transition that did not happen.
      expect(manager.stateSnapshot('r64h')?.health.status).toBe('healthy');
    },
    30_000
  );

  it(
    'never claims a retry it did not arm: a re-entrant transition consumer that retires mid-flight',
    async () => {
      // The ONLY window in which the recovery slot's own guards can decline
      // after the caller has already decided to retain: committing the
      // unadopted health degradation calls the authority's `onTransition`
      // consumer SYNCHRONOUSLY, between the caller's checks and the slot
      // being installed. A consumer that re-enters the manager therefore
      // changes the world underneath it.
      const root = mkdtempSync(join(tmpdir(), 'desk64-reentrant-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      expect(ledger.allocate('r64k')).toBe(2);

      let manager: SessionManager;
      let reentered = false;
      manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => new ByteSinkEmu() },
        now: () => Date.now(),
        sendBrowser: () => {},
        onStateTransition: (transition) => {
          // React to the unadopted degradation exactly once, from inside the
          // commit that publishes it.
          if (reentered || transition.cause !== 'source-health') return;
          reentered = true;
          manager.retire('r64k', 'kill-switch');
        }
      });
      cleanups.push(() => manager.closeAllLinks());
      vi.spyOn(manager, 'moorAttachMaster').mockResolvedValue(false);

      const result = await manager.restoreAndAttachMoor('r64k', {
        sessionPath: join(root, 'r64k'),
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/bin/true', args: [] }
      });

      expect(reentered).toBe(true);
      // No slot was armed — so the caller must not say one was. This is the
      // claim an operator reads as "alive, being re-attached to".
      expect(result).toEqual({
        ok: false,
        reason: 'attach-failed',
        retained: false,
        generation: 2
      });
      // And the fact behind the claim: nothing is retrying this session.
      expect(recoveryFor(manager, 'r64k')).toBeUndefined();
      expect(manager.stateSnapshot('r64k')).toMatchObject({
        lifecycle: 'exited',
        exit: { origin: 'retired', reason: 'kill-switch' }
      });
    },
    30_000
  );

  it(
    'an owner change during the awaited attach never yields retained:true (absorbed by the authority check)',
    async () => {
      // What this pins and what it does NOT: every real path that replaces or
      // clears the owner token also moves the authority record (a retire exits
      // the session; a successor spawn registers a newer generation), and
      // `markRunning` is consulted first — so this returns at the authority
      // check and the ownership guard never runs. It pins the OUTCOME, not the
      // guard. The guard is pinned by the re-entrancy test above, which is the
      // only window that reaches it.
      const root = mkdtempSync(join(tmpdir(), 'desk64-owner-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      expect(ledger.allocate('r64l')).toBe(2);
      const manager = makeManager(ledger);
      cleanups.push(() => manager.closeAllLinks());

      // A successor takes the session while the attach is awaited — the real
      // sequence, through the public API: retire, then a new operation.
      vi.spyOn(manager, 'moorAttachMaster').mockImplementation(async () => {
        manager.retire('r64l', 'operator-reboot');
        expect(ledger.allocate('r64l')).toBe(3); // the successor's generation
        expect(manager.ensure('r64l', { rows: 24, cols: 80 }).ok).toBe(true);
        return false;
      });

      const result = await manager.restoreAndAttachMoor('r64l', {
        sessionPath: join(root, 'r64l'),
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/bin/true', args: [] }
      });

      expect(result).toMatchObject({ ok: false, reason: 'attach-failed', retained: false });
      expect(recoveryFor(manager, 'r64l')).toBeUndefined();
      // The successor's generation is untouched by the superseded operation.
      expect(manager.stateSnapshot('r64l')?.generation).toBe(4);
    },
    30_000
  );

  it(
    'THE DEAD END this fix prevents: a session retired while its holder still listens cannot be re-provisioned',
    async () => {
      const world = await twoIncarnations('r64i');
      // Reproduce the pre-fix state directly — retire the session while its
      // holder is alive and listening, which is exactly what the old rollback
      // did on a failed restart attach.
      const restored = await world.second.restoreAndAttachMoor('r64i', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(restored.ok).toBe(false);
      // The old path retired WITHOUT a kill record; `retire` here reaches the
      // same place through the public API, and the record it consumes is the
      // one thing that could have freed the rendezvous.
      const third = makeManager(world.ledger);
      cleanups.push(() => third.closeAllLinks());
      third.retire('r64i', 'restore-superseded'); // no kill record in THIS manager
      expect(third.stateSnapshot('r64i')?.lifecycle ?? 'absent').not.toBe('running');
      expect(processAlive(world.pid)).toBe(true);

      // The spawn preflight refuses a rendezvous with a live listener, and it
      // is right to: staleness must be POSITIVE. So a re-provision cannot
      // rescue the session — nothing frees the path while the holder lives.
      const reprovision = await third.spawnAndAttachMoor('r64i', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath: world.sessionPath,
        command: ['sleep', '60'],
        geometry: { rows: 24, cols: 80 },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', world.sessionPath]
        }
      });
      expect(reprovision).toEqual({ ok: false, reason: 'spawn-failed' });
      expect(processAlive(world.pid)).toBe(true);
      expect(existsSync(world.sessionPath)).toBe(true);
    },
    60_000
  );

  it(
    'THE ESCAPE HATCH that does work: a fresh daemon incarnation re-adopts a session an earlier one retired',
    async () => {
      const world = await twoIncarnations('r64j');
      const failed = await world.second.restoreAndAttachMoor('r64j', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);
      world.second.closeAllLinks(); // the daemon departs; the holder survives

      // The authority is per-process: nothing durable records `exited`, so a
      // NEW incarnation over the SAME durable ledger reconciles from scratch.
      // This is why an orphaned session is recoverable by restarting the
      // daemon — and why in-incarnation resurrection is not needed to rescue
      // one. The transient attach failure is gone by now.
      rmSync(world.refuseFile, { force: true });
      const third = makeManager(world.ledger);
      cleanups.push(() => third.closeAllLinks());
      const rescued = await third.restoreAndAttachMoor('r64j', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });

      expect(rescued.ok).toBe(true);
      expect(third.stateSnapshot('r64j')).toMatchObject({
        lifecycle: 'running',
        generation: 2 // the SAME generation the holder carries: the fence held
      });
      expect(third.moorStatus('r64j')?.generation).toBe(2);
      expect(processAlive(world.pid)).toBe(true);
    },
    60_000
  );

  it(
    'keeps the teardown for a retained session, so an operator retire still stops the holder',
    async () => {
      const world = await twoIncarnations('r64f');
      // The realistic teardown: the moor CLI kill, which stops the holder AND
      // unlinks its rendezvous — what `retireAwaited` confirms against.
      const cliKill = {
        binPath: process.execPath,
        args: [...NODE_IMPORT_ARGS, 'kill', world.sessionPath]
      };
      const failed = await world.second.restoreAndAttachMoor('r64f', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: cliKill
      });
      expect(failed.ok).toBe(false);
      expect(processAlive(world.pid)).toBe(true);

      // Retaining a session Desk cannot reach must not strand its holder: the
      // registered kill record survives the failed attach, so the operator's
      // deliberate retire is still able to end it. (The old rollback deleted
      // that record on the way to retiring the session — leaving a live holder
      // with no teardown, recorded as already gone.)
      const retired = await world.second.retireAwaited('r64f', { reason: 'control-retire' });
      expect(retired.ok).toBe(true);
      expect(existsSync(world.sessionPath)).toBe(false);
      await waitFor(() => !processAlive(world.pid), 'the operator retire stopped the holder');
      expect(world.second.stateSnapshot('r64f')).toMatchObject({
        lifecycle: 'exited',
        exit: { origin: 'retired', reason: 'control-retire' }
      });
    },
    60_000
  );
});
