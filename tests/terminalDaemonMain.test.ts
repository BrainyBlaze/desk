// Reconcile semantics for the supervised daemon: a daemon restart RE-ADOPTS
// surviving moor holders — durable generation, killSpec registration — and
// never ensures/spawns over them.

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  GenerationLedger,
  InMemoryGenerationLedger,
  type AgentStateEnvelope
} from '../src/shared/controlPlane/index.js';
import {
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type EmulatorEvent,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import {
  startTerminalDaemonServer,
  type TerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';
import { FileIntakeStore } from '../src/server/runtime/fileIntakeStore.js';
import * as runner from '../src/core/runner.js';
import {
  completeDaemonStartup,
  manifestReconcileTargets,
  reconcileExistingSessions,
  resolveDaemonConfig
} from '../src/server/runtime/terminalDaemonMain.js';
import { MOOR_STATUS_NO_LIVE_LINK_ERROR } from '../src/shared/daemonControlClient.js';
import { shellQuote } from '../src/shared/shell.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { FileSessionGeometryStore } from '../src/server/runtime/fileSessionGeometryStore.js';
import { fileURLToPath } from 'node:url';

const FAKE_MOOR = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
// node --import tsx keeps the loader IN-PROCESS: the tsx CLI shim re-spawns
// node and loses the inherited fd-3 launch channel.
const FAKE_MOOR_ARGS = ['--import', 'tsx', FAKE_MOOR];

/** Launch a detached fake moor holder and await its launcher's exit-0 readiness. */
async function spawnFakeMoorHolder(
  sessionPath: string,
  storeDir: string,
  generation: number,
  command: string[],
  tmpdirRoot: string
): Promise<void> {
  const { child } = spawnMoorMaster({
    binPath: process.execPath,
    args: [...FAKE_MOOR_ARGS, 'start', '-T', storeDir, sessionPath, ...command],
    generation,
    env: { ...process.env, TMPDIR: tmpdirRoot }
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`fake moor launcher exited ${code}`);
}

/** SIGTERM a detached fake holder through its pidfile and await the reap. */
async function killFakeMoorHolder(sessionPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [...FAKE_MOOR_ARGS, 'kill', sessionPath], {
      stdio: 'ignore'
    });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

class FakeEmu implements EmulatorPort {
  write(): void {}
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

function makeManager(store = new InMemoryGenerationLedger()) {
  const ledger = new GenerationLedger(store);
  const manager = new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1000,
    sendBrowser: () => {}
  });
  return { manager, ledger, store };
}

function makeManagerWithIntake(store: InMemoryGenerationLedger, intakePath: string) {
  const ledger = new GenerationLedger(store);
  let intakeStore: FileIntakeStore | undefined;
  const manager = new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1000,
    sendBrowser: () => {},
    createAgentStateIntakeStore: (dependencies) => {
      intakeStore = new FileIntakeStore(intakePath, dependencies);
      return intakeStore;
    }
  });
  return { manager, ledger, close: () => intakeStore?.close() };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('manifestReconcileTargets', () => {
  it('targets only manifest sessions whose moor socket is live, keyed by sessionId', () => {
    vi.spyOn(runner, 'loadDesk').mockReturnValue({
      sessions: [
        { sessionId: 'shell', agent: 'claude', uiMode: 'native' },
        { sessionId: 'other', agent: 'bash', uiMode: 'terminal' },
        { sessionId: 'gone', agent: 'codex', uiMode: 'terminal' }
      ]
    } as never);
    const live = new Set(['/root/shell', '/root/other']);
    const targets = manifestReconcileTargets('/root', (path) => live.has(path));
    expect(targets).toEqual([
      {
        sessionId: 'shell',
        sockPath: '/root/shell',
        subject: {
          kind: 'agent',
          provider: 'claude',
          mode: 'native',
          producer: 'claude-native'
        }
      },
      { sessionId: 'other', sockPath: '/root/other', subject: { kind: 'terminal' } }
    ]);
  });
});

describe('reconcile liveness (wedged sockets must not stall startup)', () => {
  it('several silent sockets and one healthy master reconcile inside ~one timeout window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-liveness-'));
    const healthySock = join(dir, 'healthy'); // moor rendezvous: no suffix
    await spawnFakeMoorHolder(
      healthySock,
      join(moorEventStoreRoot(process.execPath, { tmpdir: dir }), 'healthy.events'),
      2,
      ['sleep', '30'],
      dir
    );
    const silentServers: Server[] = [];
    const targets = [{ sessionId: 'healthy', sockPath: healthySock, subject: { kind: 'terminal' } as const }];
    for (let i = 0; i < 3; i += 1) {
      const sock = join(dir, `silent-${i}`);
      silentServers.push(
        await new Promise<Server>((resolve, reject) => {
          const srv = createServer(() => {
            /* connected but never adopts: the client's 2 s deadline must fire */
          });
          srv.on('error', reject);
          srv.listen(sock, () => resolve(srv));
        })
      );
      targets.push({ sessionId: `silent-${i}`, sockPath: sock, subject: { kind: 'terminal' } });
    }
    try {
      const store = new InMemoryGenerationLedger();
      const ledger = new GenerationLedger(store);
      for (const t of targets) ledger.allocate(t.sessionId); // all at generation 2 (OB-18)
      const { manager } = makeManager(store);
      const daemon = { router: { sessions: manager } } as never;
      const started = Date.now();
      const results = await reconcileExistingSessions(daemon, targets, '/usr/bin/true');
      const wall = Date.now() - started;
      expect(results.find((r) => r.sessionId === 'healthy')?.ok).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        expect(results.find((r) => r.sessionId === `silent-${i}`)?.ok).toBe(false);
      }
      // The property is CONCURRENCY, not absolute speed: sequential
      // reconciliation of 3 wedged sockets would take at least 3 x the 2 s
      // adoption deadline = 6 s before the healthy attach even starts. Any
      // wall below that floor proves the worker pool ran them in parallel;
      // the margin above the typical ~2-3 s absorbs full-suite load spikes
      // without weakening the proof.
      expect(wall).toBeLessThan(5900);
    } finally {
      // SIGTERM the detached holder directly: its close tears the adopted link
      // down, and the reap precedes the temp-root removal (no leaked process).
      for (const srv of silentServers) srv.close();
      await killFakeMoorHolder(healthySock);
      rmSync(dir, { recursive: true, force: true });
    }
    // Test budget must sit ABOVE the 5.9 s proof window (Vitest's default
    // 5 s would abort before the assertion could run under load).
  }, 8_000);
});

describe('the daemon resolves its moor binary instead of trusting the variable', () => {
  it('refuses a DESK_MOOR_BIN that is not an executable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-moorbin-'));
    const notExecutable = join(dir, 'moor');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });

    expect(() => resolveDaemonConfig({ DESK_MOOR_BIN: notExecutable } as NodeJS.ProcessEnv)).toThrow(
      /not an executable file/
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('never yields the bare name "moor" for the daemon to exec', () => {
    // Reading the variable raw used to fall back to a bare name, which hands
    // the exec to whatever PATH resolves first and defers the failure to the
    // first provision. Today the resolver goes further: with no attested
    // binary anywhere (fresh checkout, empty PATH) it THROWS fail-closed —
    // an absolute attested path or nothing, never a bare name.
    const dir = mkdtempSync(join(tmpdir(), 'desk-moorbin-'));
    try {
      const attested = join(dir, 'moor');
      writeFileSync(
        attested,
        '#!/bin/sh\n[ "$1" = --version ] && { echo "moor 0.1.0"; exit 0; }\nexit 0\n',
        { mode: 0o755 }
      );
      const resolved = resolveDaemonConfig({ PATH: dir } as NodeJS.ProcessEnv).moorBinPath;
      expect(resolved).not.toBe('moor');
      expect(isAbsolute(resolved)).toBe(true);
      // With an empty environment the resolver either finds the bundled
      // release binary (an absolute attested path — present on developer
      // machines) or refuses outright (fresh checkout/CI). BOTH outcomes
      // prove the invariant: a bare name is never yielded.
      try {
        const bare = resolveDaemonConfig({ PATH: join(dir, 'empty') } as NodeJS.ProcessEnv).moorBinPath;
        expect(bare).not.toBe('moor');
        expect(isAbsolute(bare)).toBe(true);
      } catch (error) {
        expect(String(error)).toMatch(/no attested moor binary/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an executable override and passes it through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-moorbin-'));
    const executable = join(dir, 'moor');
    writeFileSync(executable, '#!/bin/sh\n[ "$1" = --version ] && { echo "moor 0.1.0"; exit 0; }\nexit 0\n', { mode: 0o755 });

    expect(resolveDaemonConfig({ DESK_MOOR_BIN: executable } as NodeJS.ProcessEnv).moorBinPath).toBe(executable);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('nonce plumbing (child identity end to end)', () => {
  it('resolveDaemonConfig reads DESK_DAEMON_NONCE into healthNonce', () => {
    // An attested fixture keeps the resolver satisfied on a fresh checkout —
    // this test is about the UNRELATED nonce field, not bin resolution.
    const dir = mkdtempSync(join(tmpdir(), 'desk-nonce-bin-'));
    try {
      const fixture = join(dir, 'moor');
      writeFileSync(
        fixture,
        '#!/bin/sh\n[ "$1" = --version ] && { echo "moor 0.1.0"; exit 0; }\nexit 0\n',
        { mode: 0o755 }
      );
      const env = { DESK_MOOR_BIN: fixture } as NodeJS.ProcessEnv;
      expect(resolveDaemonConfig({ ...env, DESK_DAEMON_NONCE: 'n-123' }).healthNonce).toBe('n-123');
      expect(resolveDaemonConfig(env).healthNonce).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real health endpoint echoes the nonce once ready', async () => {
    const base = mkdtempSync(join(tmpdir(), 'desk-nonce-'));
    const { mkdirSync: mk } = await import('node:fs');
    mk(join(base, 'home', '_engine'), { recursive: true });
    const server = await startTerminalDaemonServer({
      homeRoot: join(base, 'home'),
      moorBinPath: '/usr/bin/true',
      moorSocketRoot: join(base, 'moor'),
      host: '127.0.0.1',
      port: 0,
      healthNonce: 'n-echo-1'
    });
    try {
      // pre-ready: 503 starting, no readiness lie
      const notReady = await fetch(`http://127.0.0.1:${server.port}/control/health`);
      expect(notReady.status).toBe(503);
      server.daemon.markReady();
      const ready = await fetch(`http://127.0.0.1:${server.port}/control/health`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true, nonce: 'n-echo-1' });
    } finally {
      await server.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('provider recovery readiness gate', () => {
  it('does not mark ready until provider reconciliation settles', async () => {
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const order: string[] = [];
    const daemon = {
      router: {} as TerminalDaemon['router'],
      reconcileAgentProviders: vi.fn(async () => {
        order.push('poll-start');
        await pollGate;
        order.push('poll-end');
        return [];
      }),
      markReady: vi.fn(() => {
        order.push('ready');
      })
    };

    const startup = completeDaemonStartup(daemon, [], '/bin/false');
    await vi.waitFor(() => {
      expect(daemon.reconcileAgentProviders).toHaveBeenCalledWith([]);
    });
    expect(daemon.markReady).not.toHaveBeenCalled();

    releasePoll();
    await expect(startup).resolves.toEqual({
      reconciled: [],
      providerRecovery: []
    });
    expect(order).toEqual(['poll-start', 'poll-end', 'ready']);
  });
});

describe('fatal post-listen startup (a malformed manifest must not leave a zombie server)', () => {
  function withMalformedHome(): { home: string; restore: () => void } {
    const home = mkdtempSync(join(tmpdir(), 'desk-badmanifest-'));
    mkdirSync(join(home, '.config', 'desk'), { recursive: true });
    writeFileSync(join(home, '.config', 'desk', 'desk.yml'), 'groups: [ {{{ not yaml');
    const saved = process.env.HOME;
    process.env.HOME = home;
    return {
      home,
      restore: () => {
        if (saved === undefined) delete process.env.HOME;
        else process.env.HOME = saved;
        rmSync(home, { recursive: true, force: true });
      }
    };
  }

  it('closes the bound server and rethrows (the port is released)', async () => {
    const { runTerminalDaemonMain } = await import('../src/server/runtime/terminalDaemonMain.js');
    const ctx = withMalformedHome();
    const base = mkdtempSync(join(tmpdir(), 'desk-fatal-'));
    const port = 42000 + (process.pid % 10000);
    try {
      const { mkdirSync: mk } = await import('node:fs');
      mk(join(base, 'home', '_engine'), { recursive: true });
      await expect(
        runTerminalDaemonMain({
          homeRoot: join(base, 'home'),
          moorBinPath: '/usr/bin/true',
          moorSocketRoot: join(base, 'moor'),
          host: '127.0.0.1',
          port
        })
      ).rejects.toThrow();
      // the port must be free again — a leaked server would EADDRINUSE here
      const { createServer: mkHttp } = await import('node:http');
      await new Promise<void>((resolve, reject) => {
        const probe = mkHttp();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    } finally {
      ctx.restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('the CLI child process exits non-zero (never a live zombie)', async () => {
    const ctx = withMalformedHome();
    const base = mkdtempSync(join(tmpdir(), 'desk-fatalchild-'));
    try {
      const { mkdirSync: mk } = await import('node:fs');
      mk(join(base, 'home', '_engine'), { recursive: true });
      const { spawn: sp } = await import('node:child_process');
      const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const entry = join(process.cwd(), 'src', 'server', 'runtime', 'terminalDaemonMain.ts');
      const child = sp(tsxBin, [entry], {
        env: {
          ...process.env,
          HOME: ctx.home,
          DESK_DAEMON_HOME: join(base, 'home'),
          DESK_MOOR_SOCKET_ROOT: join(base, 'moor'),
          DESK_MOOR_BIN: '/usr/bin/true',
          DESK_DAEMON_PORT: String(43000 + (process.pid % 10000))
        },
        stdio: 'ignore'
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('daemon child did not exit — zombie server'));
        }, 20_000);
        child.on('exit', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
    } finally {
      ctx.restore();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('startTerminalDaemonServer socket root', () => {
  it('creates an absent nested socket root (0700) before anything can provision', async () => {
    const base = mkdtempSync(join(tmpdir(), 'desk-root-'));
    const home = join(base, 'home');
    const socketRoot = join(base, 'nested', 'moor'); // does not exist yet
    const { mkdirSync: mk } = await import('node:fs');
    mk(join(home, '_engine'), { recursive: true });
    const server = await startTerminalDaemonServer({
      homeRoot: home,
      moorBinPath: '/usr/bin/true',
      moorSocketRoot: socketRoot,
      host: '127.0.0.1',
      port: 0
    });
    try {
      const { statSync: st } = await import('node:fs');
      const stat = st(socketRoot);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    } finally {
      await server.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// desk#62 — a daemon restart must not write a geometry no session has onto a
// live child. The daemon cannot ask the holder how big the child's pty is (the
// moor status descriptor, wire schema §5, carries no rows/cols), so the only
// honest sources are the journal of the last geometry Desk COMMANDED and the
// wire's own "preserve both" encoding (§4/OB-19: columns and rows both zero).
// ---------------------------------------------------------------------------

/** Mirrors the fake holder's witness path (the helper is a script, not importable). */
const geometryWitness = (sessionPath: string): string => `${sessionPath}.geometry-witness`;

const witnessLines = (sessionPath: string): string[] => {
  const path = geometryWitness(sessionPath);
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    : [];
};

function makeManagerWithGeometry(
  store: InMemoryGenerationLedger,
  geometryStore: FileSessionGeometryStore
): { manager: SessionManager; created: Array<{ rows: number; cols: number }> } {
  const created: Array<{ rows: number; cols: number }> = [];
  const manager = new SessionManager({
    ledger: new GenerationLedger(store),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: {
      create: (opts) => {
        created.push({ rows: opts.rows, cols: opts.cols });
        return new FakeEmu();
      }
    },
    now: () => 1000,
    sendBrowser: () => {},
    sessionGeometry: geometryStore
  });
  return { manager, created };
}

describe('re-adoption never invents a geometry (desk#62)', () => {
  it('the reconcile pass hands restoreAndAttachMoor no geometry at all', async () => {
    const restoreAndAttachMoor = vi.fn().mockResolvedValue({ ok: true, generation: 2 });
    const daemon = { router: { sessions: { restoreAndAttachMoor } } } as never;

    await reconcileExistingSessions(
      daemon,
      [{ sessionId: 'a', sockPath: '/r/a', subject: { kind: 'terminal' } }],
      '/opt/moor'
    );

    // Not "a better default" — NO geometry. The reconcile pass has no
    // knowledge of any session's size, so it must assert none.
    const opts = restoreAndAttachMoor.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(opts)).not.toContain('geometry');
  });

  it('a session with a COMMANDED size comes back at that size, and the ATTACH still asserts nothing on the live child', async () => {
    // CASE 1 of 2: geometry WAS known before the restart. This is the defect —
    // the daemon discarded knowledge it already had and wrote 24x80 over it.
    const dir = mkdtempSync(join(tmpdir(), 'desk-geo-known-'));
    const sock = join(dir, 'measured');
    const geometryPath = join(dir, '_engine', 'session-geometry.ndjson');
    await spawnFakeMoorHolder(
      sock,
      join(moorEventStoreRoot(process.execPath, { tmpdir: dir }), 'measured.events'),
      2,
      ['sleep', '30'],
      dir
    );
    const targets = [
      { sessionId: 'measured', sockPath: sock, subject: { kind: 'terminal' } as const }
    ];
    const ledgerStore = new InMemoryGenerationLedger();
    new GenerationLedger(ledgerStore).allocate('measured'); // durable generation 2
    try {
      // --- daemon incarnation 1: a real surface measures 100x48 -------------
      const first = new FileSessionGeometryStore(geometryPath);
      const one = makeManagerWithGeometry(ledgerStore, first);
      await reconcileExistingSessions(
        { router: { sessions: one.manager } } as never,
        targets,
        '/usr/bin/true'
      );
      const channelId = one.manager.subscribe('measured', 'surface-1', 48, 100);
      expect(channelId).not.toBeUndefined();
      expect(one.manager.onBrowserResizeByChannel(channelId!, 48, 100)).toBe(true);
      await waitFor(() => witnessLines(sock).includes('resize 100x48'));
      one.manager.closeAllLinks(); // the daemon departs; the holder survives
      first.close();

      // --- daemon incarnation 2: it comes back ------------------------------
      const second = new FileSessionGeometryStore(geometryPath);
      const two = makeManagerWithGeometry(ledgerStore, second);
      const results = await reconcileExistingSessions(
        { router: { sessions: two.manager } } as never,
        targets,
        '/usr/bin/true'
      );
      expect(results).toEqual([{ sessionId: 'measured', ok: true }]);

      // The restored session is the last size Desk commanded (the subscribe
      // acquisition journaled 48x100) — NOT the 24x80 the daemon used to invent.
      expect(two.created).toEqual([{ rows: 48, cols: 100 }]);
      // And nothing was written onto the live child: both re-adopting ATTACHes
      // carry moor's preserve pair, so the pty keeps the size it already has.
      expect(witnessLines(sock).filter((line) => line.startsWith('attach '))).toEqual([
        'attach 0x0',
        'attach 0x0'
      ]);
      second.close();
    } finally {
      await killFakeMoorHolder(sock);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('a session Desk never commanded a size for is re-adopted with preserve geometry, so its child keeps the size it has', async () => {
    // CASE 2 of 2: geometry was NEVER known — no browser has ever rendered
    // this session, and none is attached at restart. Nothing can know better,
    // so the daemon must assert nothing rather than resize the child to a
    // value it made up. This is the case no client-side mitigation can reach.
    const dir = mkdtempSync(join(tmpdir(), 'desk-geo-unknown-'));
    const sock = join(dir, 'unmeasured');
    await spawnFakeMoorHolder(
      sock,
      join(moorEventStoreRoot(process.execPath, { tmpdir: dir }), 'unmeasured.events'),
      2,
      ['sleep', '30'],
      dir
    );
    const ledgerStore = new InMemoryGenerationLedger();
    new GenerationLedger(ledgerStore).allocate('unmeasured');
    try {
      const geometryStore = new FileSessionGeometryStore(
        join(dir, '_engine', 'session-geometry.ndjson')
      );
      const { manager } = makeManagerWithGeometry(ledgerStore, geometryStore);
      const results = await reconcileExistingSessions(
        { router: { sessions: manager } } as never,
        [{ sessionId: 'unmeasured', sockPath: sock, subject: { kind: 'terminal' } }],
        '/usr/bin/true'
      );
      expect(results).toEqual([{ sessionId: 'unmeasured', ok: true }]);
      expect(witnessLines(sock)).toEqual(['attach 0x0']);
      manager.closeAllLinks();
      geometryStore.close();
    } finally {
      await killFakeMoorHolder(sock);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('reconcileExistingSessions', () => {
  it('isolates per-session failures and reports each outcome', async () => {
    const restoreAndAttachMoor = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, generation: 2 })
      .mockResolvedValueOnce({ ok: false, reason: 'no-generation' })
      .mockRejectedValueOnce(new Error('socket exploded'));
    const reconcileMoorEvents = vi.fn();
    const daemon = {
      router: { sessions: { restoreAndAttachMoor } },
      reconcileMoorEvents
    } as never;
    const results = await reconcileExistingSessions(
      daemon,
      [
        {
          sessionId: 'a',
          sockPath: '/r/a',
          subject: {
            kind: 'agent',
            provider: 'codex',
            mode: 'terminal',
            producer: 'codex-hooks'
          }
        },
        { sessionId: 'b', sockPath: '/r/b', subject: { kind: 'terminal' } },
        { sessionId: 'c', sockPath: '/r/c', subject: { kind: 'terminal' } }
      ],
      '/opt/moor'
    );
    expect(results).toEqual([
      { sessionId: 'a', ok: true },
      { sessionId: 'b', ok: false, error: 'no-generation' },
      { sessionId: 'c', ok: false, error: 'socket exploded' }
    ]);
    expect(reconcileMoorEvents).toHaveBeenCalledTimes(1);
    expect(reconcileMoorEvents).toHaveBeenCalledWith('a', 2);
    // Teardown uses the resolved moor binary for both live kill and safe stale
    // cleanup, and the restore adopts over the BARE rendezvous path.
    expect(restoreAndAttachMoor.mock.calls[0][1].sessionPath).toBe('/r/a');
    expect(restoreAndAttachMoor.mock.calls[0][1].killSpec).toEqual({
      binPath: '/opt/moor',
      args: ['kill', '-f', '/r/a'],
      staleCleanupSpec: { binPath: '/opt/moor', args: ['rm', '/r/a'] }
    });
    expect(restoreAndAttachMoor.mock.calls[0][1].subject).toEqual({
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks'
    });
  });

  it('desk#64: reports a retained unadopted session as not re-attached, and says it is retrying', async () => {
    const restoreAndAttachMoor = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'attach-failed',
      retained: true,
      generation: 7
    });
    const reconcileMoorEvents = vi.fn();
    const daemon = {
      router: { sessions: { restoreAndAttachMoor } },
      reconcileMoorEvents
    } as never;
    const results = await reconcileExistingSessions(
      daemon,
      [{ sessionId: 'd', sockPath: '/r/d', subject: { kind: 'terminal' } }],
      '/opt/moor'
    );
    // Honest on both counts: nothing was adopted (ok:false, no event-store
    // reconcile), and the session was NOT ended — the startup log an operator
    // reads must not imply the agent is gone.
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain('retained');
    expect(results[0]!.error).toContain('retrying');
    expect(results[0]!.error).toContain('generation 7');
    expect(reconcileMoorEvents).not.toHaveBeenCalled();
  });
});

describe('/control/moor-status separates the LINK from the HOLDER (desk#50b)', () => {
  // The 404 means "this daemon holds no adopted link", which is true of every
  // surviving session between daemon start and re-adoption. It must therefore
  // also answer the separable question — is a holder nevertheless there? —
  // and it must answer it by PROBING the rendezvous, not by stat()ing a node.
  it('reports a present holder for a live but never-adopted session', async () => {
    const base = mkdtempSync(join(tmpdir(), 'desk-holder-'));
    const socketRoot = join(base, 'moor');
    mkdirSync(join(base, 'home', '_engine'), { recursive: true });
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    const survivingSock = join(socketRoot, 'surviving'); // moor rendezvous: no suffix
    await spawnFakeMoorHolder(
      survivingSock,
      join(moorEventStoreRoot(process.execPath, { tmpdir: base }), 'surviving.events'),
      2,
      ['sleep', '30'],
      base
    );
    const server = await startTerminalDaemonServer({
      homeRoot: join(base, 'home'),
      moorBinPath: '/usr/bin/true',
      moorSocketRoot: socketRoot,
      host: '127.0.0.1',
      port: 0
    });
    try {
      server.daemon.markReady();
      // Nothing provisioned or reconciled this holder: there is no adopted
      // ATTACH_ACK descriptor, exactly as during the re-adoption window.
      expect(server.daemon.moorSessionStatus('surviving')).toBeUndefined();

      const alive = await fetch(
        `http://127.0.0.1:${server.port}/control/moor-status?sessionId=surviving`
      );
      expect(alive.status).toBe(404);
      expect(await alive.json()).toEqual({
        ok: false,
        error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
        holder: 'present'
      });

      // A session that never published a rendezvous at all: proven absent, so
      // `desk up` can still start genuinely dead sessions.
      const gone = await fetch(
        `http://127.0.0.1:${server.port}/control/moor-status?sessionId=never-started`
      );
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({
        ok: false,
        error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
        holder: 'absent'
      });

      // desk#42: the probe observes; it never unlinks. The rendezvous node of
      // a live holder must survive being asked about.
      expect(existsSync(survivingSock)).toBe(true);
    } finally {
      await server.close();
      await killFakeMoorHolder(survivingSock);
      rmSync(base, { recursive: true, force: true });
    }
  }, 20_000);

  it('answers unknown for a holder it cannot REACH, with the namespace intact', async () => {
    // The namespace-gone test below exits at the socket-root guard and never
    // reaches the probe, so on its own it pins only half of this. Here the
    // root is a healthy private directory and the rendezvous for the session
    // really exists — the probe runs, and comes back unable to decide.
    //
    // This is the branch the whole change exists for: an unreachable holder
    // must not round down to a dead one. Collapsing it to `absent` reports
    // `stale`, which authorises a start over a live holder — and it would do
    // so only under permission trouble or load, exactly when a duplicate
    // holder does the most damage.
    const base = mkdtempSync(join(tmpdir(), 'desk-holder-unreachable-'));
    const socketRoot = join(base, 'moor');
    mkdirSync(join(base, 'home', '_engine'), { recursive: true });
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });

    // A live listener the probe has no permission to connect to (EACCES).
    // Root bypasses that check by design, so the uid-independent ELOOP case
    // below carries the same branch where this one cannot exist.
    const unreachable = join(socketRoot, 'unreachable-holder');
    const held = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      held.once('error', reject);
      held.listen(unreachable, resolve);
    });
    const canTestEacces = typeof process.getuid !== 'function' || process.getuid() !== 0;
    if (canTestEacces) chmodSync(unreachable, 0o000);

    // A rendezvous name that cannot be resolved at all (ELOOP) — path
    // resolution, not permissions, so this holds at every uid.
    const looping = join(socketRoot, 'looping-holder');
    symlinkSync(join(socketRoot, 'looping-other'), looping);
    symlinkSync(looping, join(socketRoot, 'looping-other'));

    const server = await startTerminalDaemonServer({
      homeRoot: join(base, 'home'),
      moorBinPath: '/usr/bin/true',
      moorSocketRoot: socketRoot,
      host: '127.0.0.1',
      port: 0
    });
    try {
      server.daemon.markReady();
      const ask = async (sessionId: string): Promise<unknown> => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/control/moor-status?sessionId=${sessionId}`
        );
        expect(response.status).toBe(404);
        return response.json();
      };
      const unknownBody = {
        ok: false,
        error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
        holder: 'unknown'
      };

      expect(await ask('looping-holder')).toEqual(unknownBody);
      if (canTestEacces) {
        expect(await ask('unreachable-holder')).toEqual(unknownBody);
      }

      // desk#42 again, from the route: an indeterminate probe unlinks nothing.
      expect(existsSync(unreachable)).toBe(true);
    } finally {
      await server.close();
      if (canTestEacces) chmodSync(unreachable, 0o700);
      await new Promise<void>((resolve) => held.close(() => resolve()));
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('answers unknown — never absent — when the rendezvous namespace is gone', async () => {
    // Absence is a claim about the SESSION, and it can only be made inside the
    // namespace where that session's holder would publish. With the socket
    // root itself missing, a failed connect says the root is misconfigured or
    // was swept, not that the holder died — so nothing may be claimed.
    const base = mkdtempSync(join(tmpdir(), 'desk-holder-root-'));
    const socketRoot = join(base, 'moor');
    mkdirSync(join(base, 'home', '_engine'), { recursive: true });
    const server = await startTerminalDaemonServer({
      homeRoot: join(base, 'home'),
      moorBinPath: '/usr/bin/true',
      moorSocketRoot: socketRoot,
      host: '127.0.0.1',
      port: 0
    });
    try {
      server.daemon.markReady();
      rmSync(socketRoot, { recursive: true, force: true });
      const answer = await fetch(
        `http://127.0.0.1:${server.port}/control/moor-status?sessionId=whoever`
      );
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({
        ok: false,
        error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
        holder: 'unknown'
      });
    } finally {
      await server.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
