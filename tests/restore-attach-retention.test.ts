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
import { SessionManager } from '../src/server/runtime/sessionManager.js';
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

function makeManager(ledger: GenerationLedger): SessionManager {
  return new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => new ByteSinkEmu() },
    now: () => Date.now(),
    sendBrowser: () => {}
  });
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
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  /**
   * Build the shared world: one surviving holder at generation 2, a durable
   * ledger that outlives the first incarnation, and a refusal switch the test
   * flips to make the SECOND incarnation's attach fail against a holder that
   * is still alive and still answering HELLO.
   */
  async function twoIncarnations(id: string, command: string[] = ['sleep', '60']): Promise<{
    sessionPath: string;
    refuseFile: string;
    ledger: GenerationLedger;
    second: SessionManager;
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
    cleanups.push(() => killSurvivingHolder(sessionPath));

    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    expect(ledger.allocate(id)).toBe(2);
    await spawnSurvivingHolder({
      sessionPath,
      storeDir: join(moorEventStoreRoot(process.execPath, { tmpdir: root }), `${id}.events`),
      generation: 2,
      command,
      tmpdirRoot: root,
      env: { FAKE_MOOR_REFUSE_ATTACH_FILE: refuseFile }
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

    const second = makeManager(ledger);
    cleanups.push(() => second.closeAllLinks());
    return {
      sessionPath,
      refuseFile,
      ledger,
      second,
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
    'registers a retry that adopts the session when the holder accepts a later attach',
    async () => {
      const world = await twoIncarnations('r64c');
      const failed = await world.second.restoreAndAttachMoor('r64c', {
        sessionPath: world.sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: world.killSpec
      });
      expect(failed.ok).toBe(false);
      expect(world.second.moorStatus('r64c')).toBeUndefined();

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
