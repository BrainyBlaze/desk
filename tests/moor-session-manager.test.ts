// #2b Step 2 witness: the REAL SessionManager drives the full supervised moor
// join through spawnAndAttachMoor against the GO'd fake-holder process —
// ledger-allocated generation over the fd-3 record, launcher exit-0 readiness,
// native §6 attach, replayed + live output fanned out to the browser, browser
// input round-tripped through the one-in-flight link, and a confirmed
// moor-shaped kill on retire.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { startTerminalDaemonServer } from '../src/server/runtime/terminalDaemon.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import {
  InMemoryGenerationLedger,
  MOOR_LIVENESS_REASON,
  MOOR_UNADOPTED_REASON
} from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor } from '../src/shared/runtime/workerSupervisor.js';
import { DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import { BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
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

function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('SessionManager × moor join (real orchestration over the GO harness)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('refuses a rendezvous past the platform sun_path ceiling before any launch, with a named cause', async () => {
    // Desk half of the Unix-socket address-capacity disposition. A holder can
    // bind a deep rendezvous relative to its parent (moor spec 2.2), but Desk's
    // absolute node:net connect truncates anything past sun_path and then fails
    // ENOENT on a spelling no holder published. spawnAndAttachMoor must refuse
    // such a path as a result, before any allocation or launch, and name the
    // cause. The path is a valid canonical rendezvous spelling -- absolute,
    // lexically resolved, valid session-id leaf -- whose only defect is length,
    // so it clears the identity guard and reaches the capacity guard. The named
    // console diagnostic is asserted so the refusal is attributable to THIS
    // guard rather than an unrelated spawn failure (removing the guard lets the
    // launch proceed and still fail, but without the diagnostic).
    const manager = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new ByteSinkEmu() },
      now: () => Date.now(),
      sendBrowser: () => undefined
    });
    const overlongSessionPath = `/tmp/${'d'.repeat(100)}/oversize-session`;
    expect(Buffer.byteLength(overlongSessionPath, 'utf8')).toBeGreaterThan(107);
    const killSpec = {
      binPath: process.execPath,
      args: [...NODE_IMPORT_ARGS, 'kill', overlongSessionPath],
      staleCleanupSpec: {
        binPath: process.execPath,
        args: [...NODE_IMPORT_ARGS, 'rm', overlongSessionPath]
      }
    };
    const diagnostics: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      diagnostics.push(args.map(String).join(' '));
    });
    let preallocationInvoked = false;
    try {
      const result = await manager.spawnAndAttachMoor('oversize-session', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath: overlongSessionPath,
        command: ['sh', '-c', 'true'],
        geometry: { rows: 24, cols: 80 },
        killSpec,
        preallocateSpawn: async () => {
          preallocationInvoked = true;
          return { ok: true };
        },
        readyTimeoutMs: 1_000
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('spawn-failed');
      expect(diagnostics.some((line) => /sun_path|unaddressable/.test(line))).toBe(true);
      // The refusal precedes every effect: the stateful preallocation hook was
      // never authorized and no generation or session was allocated.
      expect(preallocationInvoked).toBe(false);
      expect(manager.sessionCount).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it(
    'spawns supervised, attaches natively, fans output to the browser, round-trips input, and retires',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-sm-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 's1'); // moor rendezvous: no .sock suffix
      const storeDir = join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 's1.events');

      const browserOut: Array<{ sessionId: string; frame: BpFrame }> = [];
      const emu = new ByteSinkEmu();
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      const manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => emu },
        now: () => Date.now(),
        sendBrowser: (sessionId, _channelId, frame) => browserOut.push({ sessionId, frame })
      });
      cleanups.push(async () => {
        await manager.retireAwaited('s1', { reason: 'control-retire' }).catch(() => undefined);
      });

      const killSpec = {
        binPath: process.execPath,
        args: [...NODE_IMPORT_ARGS, 'kill', sessionPath],
        staleCleanupSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'rm', sessionPath]
        }
      };
      const result = await manager.spawnAndAttachMoor('s1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sh', '-c', 'printf hello-from-moor; cat'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        killSpec,
        prepareSpawn: () => ({ storeDir })
      });
      expect(result.ok).toBe(true);
      // OB-18: the fresh lineage's first supervised allocation is generation 2,
      // which the fd-3 launch record requires (>= 2) — proven by the join above.
      expect(ledger.current('s1')).toBe(2);
      expect(existsSync(sessionPath)).toBe(true);

      // Output reaches BOTH the authoritative emulator and the browser fan-out.
      const subscribed = manager.subscribe('s1', 'main', 24, 80);
      expect(subscribed).toBeDefined();
      await waitFor(
        () =>
          emu.written.some((bytes) => new TextDecoder().decode(bytes).includes('hello-from-moor')),
        'replayed child output through the native attach'
      );

      // Browser input round-trips through the one-in-flight moor link.
      manager.onBrowserInput('s1', subscribed!, false, new TextEncoder().encode('echo-me\n'));
      await waitFor(
        () => emu.written.some((bytes) => new TextDecoder().decode(bytes).includes('echo-me')),
        'input echoed back as child output'
      );
      const outputFrames = browserOut.filter((entry) => entry.frame.type === BpFrameType.OUTPUT);
      expect(outputFrames.length).toBeGreaterThan(0);

      // Retire runs the confirmed moor kill: the rendezvous must be GONE.
      const retired = await manager.retireAwaited('s1', { reason: 'control-retire' });
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    30_000
  );

  it('refuses to spawn over a live foreign holder and reclaims a dead tombstone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-sm-stale-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessionPath = join(root, 's2');

    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new ByteSinkEmu() },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
    cleanups.push(async () => {
      await manager.retireAwaited('s2', { reason: 'control-retire' }).catch(() => undefined);
    });

    const spawnOnce = () =>
      manager.spawnAndAttachMoor('s2', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });

    const first = await spawnOnce();
    expect(first.ok).toBe(true);
    const retired = await manager.retireAwaited('s2', { reason: 'control-retire' });
    expect(retired.ok).toBe(true);
    expect(existsSync(sessionPath)).toBe(false);

    // A fresh spawn after a clean retire allocates the NEXT generation and joins.
    const second = await spawnOnce();
    expect(second.ok).toBe(true);
    const secondRetire = await manager.retireAwaited('s2', { reason: 'control-retire' });
    expect(secondRetire.ok).toBe(true);
  }, 30_000);
});

/** Launch a detached fake holder OUTSIDE any manager — the surviving process a
 *  daemon restart finds — and await the launcher's exit-0 readiness. */
async function spawnSurvivingHolder(
  sessionPath: string,
  storeDir: string,
  generation: number,
  command: string[],
  tmpdirRoot: string
): Promise<void> {
  const { child } = spawnMoorMaster({
    binPath: process.execPath,
    args: [...NODE_IMPORT_ARGS, 'start', '-T', storeDir, sessionPath, ...command],
    generation,
    env: { ...process.env, TMPDIR: tmpdirRoot }
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`fake moor launcher exited ${code}`);
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

describe('SessionManager × moor session control (§8/§9/§7.4/§10.2.13 over the GO harness)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  function makeManager(ledger: GenerationLedger): SessionManager {
    return new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new ByteSinkEmu() },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
  }

  it(
    'retire terminates over the LIVE wire: the holder unlinks its own rendezvous (§9)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-term-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 't1');
      const manager = makeManager(new GenerationLedger(new InMemoryGenerationLedger()));

      const result = await manager.spawnAndAttachMoor('t1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        // The CLI kill is a DELIBERATE no-op: if the rendezvous disappears,
        // the §9 wire terminate over the live link did it — proof the wire
        // path, not the CLI, performed the termination.
        killSpec: { binPath: '/usr/bin/true', args: [] }
      });
      expect(result.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(true);

      const retired = await manager.retireAwaited('t1', { reason: 'control-retire' });
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    30_000
  );

  it(
    'answers a delegated cursor-position query from the authoritative emulator (§8)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-query-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'q1');
      cleanups.push(() => killSurvivingHolder(sessionPath));
      const manager = makeManager(new GenerationLedger(new InMemoryGenerationLedger()));
      cleanups.push(async () => {
        await manager.retireAwaited('q1', { reason: 'control-retire' }).catch(() => undefined);
      });

      const result = await manager.spawnAndAttachMoor('q1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root, FAKE_MOOR_QUERY: '5' },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });
      expect(result.ok).toBe(true);

      // The holder delegated a class-05 query; the lease-owning viewer must
      // answer CPR from the authoritative emulator (1-based row;col).
      const replyPath = `${sessionPath}.query-reply`;
      await waitFor(() => existsSync(replyPath), 'holder persisted the QUERY_REPLY');
      expect(readFileSync(replyPath).toString()).toBe('[1;1R');
    },
    30_000
  );

  it(
    'releases the lease gracefully (§7.4) and clears the holder log at the observed frontier (§10.2.13)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-lease-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'g1');
      cleanups.push(() => killSurvivingHolder(sessionPath));
      const manager = makeManager(new GenerationLedger(new InMemoryGenerationLedger()));

      const result = await manager.spawnAndAttachMoor('g1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });
      expect(result.ok).toBe(true);

      // Log clear first (it needs the lease-independent attached link). The
      // FULL §10.2.13 algebra reaches the caller — never a collapsed boolean.
      await expect(manager.clearHolderLog('g1')).resolves.toBe('cleared');
      // A session with no moor link is its own distinct outcome.
      await expect(manager.clearHolderLog('missing')).resolves.toBe('no-link');

      // Graceful §7.4 handover: AWAITED — by the time the promise resolves
      // the holder has already confirmed (and recorded) the exact-tuple
      // release; no polling needed.
      const handover = await manager.releaseAllLeases();
      expect(handover).toEqual([{ sessionId: 'g1', outcome: 'released' }]);
      expect(existsSync(`${sessionPath}.lease-released`)).toBe(true);
      // The holder stays published — release hands the lease back, it never
      // terminates anything.
      expect(existsSync(sessionPath)).toBe(true);
    },
    30_000
  );
});

describe('SessionManager × moor lifecycle concurrency (coalesce + serialized retire)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it(
    'coalesces concurrent same-session spawns into ONE spawn with one shared result',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-coalesce-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'c1');
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      const manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => new ByteSinkEmu() },
        now: () => Date.now(),
        sendBrowser: () => {}
      });
      cleanups.push(async () => {
        await manager.retireAwaited('c1', { reason: 'control-retire' }).catch(() => undefined);
      });

      const spawnOnce = () =>
        manager.spawnAndAttachMoor('c1', {
          binPath: process.execPath,
          binArgs: NODE_IMPORT_ARGS,
          sessionPath,
          command: ['sleep', '30'],
          geometry: { rows: 24, cols: 80 },
          env: { ...process.env, TMPDIR: root },
          killSpec: {
            binPath: process.execPath,
            args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
          }
        });

      const [first, second] = await Promise.all([spawnOnce(), spawnOnce()]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      // ONE spawn: the second call joined the in-flight operation — the ledger
      // allocated exactly one supervised generation (a second spawn would have
      // burned generation 3), and both callers share the SAME result object.
      expect(ledger.current('c1')).toBe(2);
      expect(second).toBe(first);
    },
    30_000
  );

  it(
    'orders a retire submitted DURING an in-flight spawn behind it deterministically',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-serialize-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'r1');
      const manager = new SessionManager({
        ledger: new GenerationLedger(new InMemoryGenerationLedger()),
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => new ByteSinkEmu() },
        now: () => Date.now(),
        sendBrowser: () => {}
      });

      const spawning = manager.spawnAndAttachMoor('r1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });
      // Submitted while the spawn is still in flight: runSerializedLifecycle
      // must order it BEHIND the spawn — never against a half-built session.
      const retiring = manager.retireAwaited('r1', { reason: 'control-retire' });

      const [spawned, retired] = await Promise.all([spawning, retiring]);
      // Deterministic end state: the spawn fully completed first (it holds the
      // serialization lock), then the retire tore the attached session down to
      // a CONFIRMED kill — the rendezvous is gone and nothing is live.
      expect(spawned.ok).toBe(true);
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
      expect(manager.stateSnapshot('r1')?.lifecycle).toBe('exited');
    },
    30_000
  );
});

describe('terminal daemon × moor session control (real shutdown + control route)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it(
    'daemon close AWAITS the §7.4 released results and /control/log-clear exposes the full algebra',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-daemon-close-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'd1');
      cleanups.push(() => killSurvivingHolder(sessionPath));

      const server = await startTerminalDaemonServer({
        homeRoot: root,
        moorBinPath: '/opt/moor',
        moorSocketRoot: root,
        host: '127.0.0.1',
        port: 0
      });
      let closed = false;
      cleanups.push(async () => {
        if (!closed) await server.close();
      });
      server.daemon.markReady(); // control routes 503 until reconcile declares readiness

      const result = await server.daemon.router.sessions.spawnAndAttachMoor('d1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });
      expect(result.ok).toBe(true);

      // The REAL control-plane consumer: the route reports the full result
      // algebra, never a collapsed boolean.
      const cleared = await fetch(`http://127.0.0.1:${server.port}/control/log-clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'd1' })
      });
      expect(cleared.status).toBe(200);
      await expect(cleared.json()).resolves.toEqual({ ok: true, outcome: 'cleared' });
      const noLink = await fetch(`http://127.0.0.1:${server.port}/control/log-clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'missing' })
      });
      expect(noLink.status).toBe(404);
      await expect(noLink.json()).resolves.toMatchObject({ ok: false, outcome: 'no-link' });

      // The REAL shutdown path: close() drains SYNCHRONOUSLY at its first
      // instruction — a provision racing the handover window is refused (503
      // draining) or cannot even connect (listener already closed). Repeated
      // close calls join the same shutdown promise.
      const closing = server.close();
      const second = server.close();
      const raced = await fetch(`http://127.0.0.1:${server.port}/control/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'late',
          command: ['bash'],
          geometry: { rows: 24, cols: 80 }
        })
      }).then(
        (response) => ({ kind: 'response' as const, status: response.status }),
        () => ({ kind: 'refused-connection' as const })
      );
      if (raced.kind === 'response') {
        expect(raced.status).toBe(503);
      }
      await closing;
      await second; // joined, not re-run
      closed = true;
      // close() resolved only after the holder confirmed the exact-tuple
      // release — the marker exists at resolution time with no polling, and
      // the surviving holder stays published.
      expect(existsSync(`${sessionPath}.lease-released`)).toBe(true);
      expect(existsSync(sessionPath)).toBe(true);
    },
    30_000
  );
});

describe('terminal daemon shutdown escalation (stuck admitted mutation)', () => {
  it(
    'severs a stuck admitted mutation at the drain deadline instead of proceeding past the barrier',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-sever-'));
      const server = await startTerminalDaemonServer({
        homeRoot: root,
        moorBinPath: '/opt/moor',
        moorSocketRoot: root,
        host: '127.0.0.1',
        port: 0
      });
      server.daemon.markReady();
      const provision = vi
        .spyOn(server.daemon, 'provision')
        .mockResolvedValue({ ok: true, generation: 2, created: true });
      try {
        // An admitted-before-drain mutation whose body NEVER completes.
        const outcome = new Promise<number | 'aborted'>((resolve) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: server.port,
              path: '/control/provision',
              method: 'POST',
              headers: { 'content-type': 'application/json' }
            },
            (res) => {
              res.resume();
              res.once('end', () => resolve(res.statusCode ?? 0));
            }
          );
          req.once('error', () => resolve('aborted'));
          req.write('{"sessionId":"stuck"'); // body intentionally unfinished
        });
        // Give the request time to be admitted (barrier acquired), then close.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const closedAt = Date.now();
        await server.close();
        // close() waited for the barrier — emptied by ESCALATION at the 5 s
        // deadline (the stuck connection is severed), never by walking past
        // a live mutation.
        expect(Date.now() - closedAt).toBeGreaterThanOrEqual(4_500);
        await expect(outcome).resolves.toBe('aborted'); // no 200 behind the snapshot
        expect(provision).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000
  );
});

describe('SessionManager × moor liveness (§10 indeterminate over the GO harness)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it(
    'degrades to indeterminate when heartbeats stop and restores health when they resume',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-live-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'l1');
      const storeDir = join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 'l1.events');

      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      const manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => new ByteSinkEmu() },
        now: () => Date.now(),
        sendBrowser: () => {}
      });
      cleanups.push(async () => {
        await manager.retireAwaited('l1', { reason: 'control-retire' }).catch(() => undefined);
      });

      const result = await manager.spawnAndAttachMoor('l1', {
        binPath: process.execPath,
        binArgs: NODE_IMPORT_ARGS,
        sessionPath,
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        // Fast §10 clock for the test: 100 ms heartbeats, 500 ms window.
        env: { ...process.env, TMPDIR: root, FAKE_MOOR_HEARTBEAT_MS: '100' },
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        },
        livenessWindowMs: 500
      });
      expect(result.ok).toBe(true);
      expect(manager.stateSnapshot('l1')?.health.status).toBe('healthy');

      // Freeze the holder: heartbeats stop, the rendezvous socket stays
      // published — exactly the "silent but maybe alive" §10 case. The
      // session must become INDETERMINATE (degraded with the liveness
      // reason), never torn down.
      const holderPid = Number(readFileSync(`${sessionPath}.holder-pid`, 'utf8'));
      process.kill(holderPid, 'SIGSTOP');
      try {
        await waitFor(() => {
          const health = manager.stateSnapshot('l1')?.health;
          return health?.status === 'degraded' && health.reason === MOOR_LIVENESS_REASON;
        }, 'liveness lapse degrades the session');
        expect(existsSync(sessionPath)).toBe(true); // no teardown on lapse

        // Thaw: the next heartbeat restores verified-live evidence and ONLY
        // the liveness degradation is cleared back to healthy.
        process.kill(holderPid, 'SIGCONT');
        await waitFor(
          () => manager.stateSnapshot('l1')?.health.status === 'healthy',
          'heartbeat resumption restores health'
        );
      } finally {
        try {
          process.kill(holderPid, 'SIGCONT');
        } catch {
          /* already resumed or gone */
        }
      }

      const retired = await manager.retireAwaited('l1', { reason: 'control-retire' });
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    30_000
  );
});

describe('SessionManager × moor restore (daemon restart re-adoption over the GO harness)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it(
    're-adopts a surviving holder at the ledger generation, streams, round-trips, and retires',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-restore-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'r1');
      const storeDir = join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 'r1.events');
      cleanups.push(() => killSurvivingHolder(sessionPath));

      // The PRIOR daemon's life: a durable generation-2 allocation and a live
      // detached holder carrying exactly that generation.
      const store = new InMemoryGenerationLedger();
      const ledger = new GenerationLedger(store);
      expect(ledger.allocate('r1')).toBe(2);
      await spawnSurvivingHolder(
        sessionPath,
        storeDir,
        2,
        ['sh', '-c', 'printf survived-restart; cat'],
        root
      );

      // The NEW daemon incarnation: same durable ledger, fresh manager.
      const browserOut: Array<{ sessionId: string; frame: BpFrame }> = [];
      const emu = new ByteSinkEmu();
      const manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => emu },
        now: () => Date.now(),
        sendBrowser: (sessionId, _channelId, frame) => browserOut.push({ sessionId, frame })
      });
      cleanups.push(async () => {
        await manager.retireAwaited('r1', { reason: 'control-retire' }).catch(() => undefined);
      });

      const restored = await manager.restoreAndAttachMoor('r1', {
        sessionPath,
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath],
          staleCleanupSpec: {
            binPath: process.execPath,
            args: [...NODE_IMPORT_ARGS, 'rm', sessionPath]
          }
        }
      });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.generation).toBe(2);
      // OB-39: the re-adopted ATTACH_ACK descriptor rides on the result — the
      // restart path carries the same event-store authority as provision.
      expect(restored.moorStatus).toBeDefined();
      expect(restored.moorStatus?.layout).toBe(2);
      expect(restored.moorStatus?.generation).toBe(2);

      // Replayed output reaches the fresh emulator; input round-trips.
      const subscribed = manager.subscribe('r1', 'main', 24, 80);
      expect(subscribed).toBeDefined();
      await waitFor(
        () =>
          emu.written.some((bytes) =>
            new TextDecoder().decode(bytes).includes('survived-restart')
          ),
        'replayed output through the native re-adoption'
      );
      manager.onBrowserInput('r1', subscribed!, false, new TextEncoder().encode('back\n'));
      await waitFor(
        () => emu.written.some((bytes) => new TextDecoder().decode(bytes).includes('back')),
        'input echoed back through the re-adopted link'
      );

      // Retire runs the registered moor kill: the rendezvous must be GONE.
      const retired = await manager.retireAwaited('r1', { reason: 'control-retire' });
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    30_000
  );

  it(
    'refuses a holder carrying a different generation without killing it or ending the session',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-restore-fence-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'r2');
      cleanups.push(() => killSurvivingHolder(sessionPath));

      const store = new InMemoryGenerationLedger();
      const ledger = new GenerationLedger(store);
      expect(ledger.allocate('r2')).toBe(2);
      await spawnSurvivingHolder(
        sessionPath,
        join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 'r2.events'),
        2,
        ['sleep', '30'],
        root
      );
      // The ledger moved past the holder (e.g. a later allocation committed
      // before the crash): the §3 fence must refuse the stale holder.
      expect(ledger.allocate('r2')).toBe(3);

      const manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => new ByteSinkEmu() },
        now: () => Date.now(),
        sendBrowser: () => {}
      });

      const restored = await manager.restoreAndAttachMoor('r2', {
        sessionPath,
        killSpec: {
          binPath: process.execPath,
          args: [...NODE_IMPORT_ARGS, 'kill', sessionPath]
        }
      });
      expect(restored).toEqual({
        ok: false,
        reason: 'attach-failed',
        retained: true,
        generation: 3
      });
      // The fence held: no adoption at generation 3 against a generation-2
      // holder, and the mismatched holder is NEVER killed — it may belong to
      // someone else's lifecycle.
      expect(existsSync(sessionPath)).toBe(true);
      expect(manager.moorStatus('r2')).toBeUndefined();
      // desk#64 — this used to assert the session was rolled back out of the
      // live set. A refused attach is not a proof that generation 3's holder
      // ended, so the session is retained (unadopted, retrying) instead of
      // being recorded as exited on evidence nobody has.
      expect(manager.stateSnapshot('r2')).toMatchObject({
        generation: 3,
        lifecycle: 'running',
        exit: null,
        health: { status: 'degraded', reason: MOOR_UNADOPTED_REASON }
      });
      manager.closeAllLinks(); // stop the retry before the holder is torn down
    },
    30_000
  );
});
