// Reconcile semantics for the supervised daemon: a daemon restart RE-ADOPTS
// surviving moor holders — durable generation, killSpec registration — and
// never ensures/spawns over them.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { shellQuote } from '../src/shared/shell.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
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
      const results = await reconcileExistingSessions(daemon, targets, '/usr/bin/true', { rows: 24, cols: 80 });
      const wall = Date.now() - started;
      expect(results.find((r) => r.sessionId === 'healthy')?.ok).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        expect(results.find((r) => r.sessionId === `silent-${i}`)?.ok).toBe(false);
      }
      // Concurrent workers: ~one 2 s adoption-deadline window, not one per wedged socket.
      expect(wall).toBeLessThan(5000);
    } finally {
      // SIGTERM the detached holder directly: its close tears the adopted link
      // down, and the reap precedes the temp-root removal (no leaked process).
      for (const srv of silentServers) srv.close();
      await killFakeMoorHolder(healthySock);
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    // Reading the variable raw used to fall back to a bare name, which hands the
    // exec to whatever PATH resolves first and defers the failure to the first
    // provision. Whatever the environment, the daemon must get an absolute path.
    const resolved = resolveDaemonConfig({} as NodeJS.ProcessEnv).moorBinPath;
    expect(resolved).not.toBe('moor');
    expect(isAbsolute(resolved)).toBe(true);
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
    expect(resolveDaemonConfig({ DESK_DAEMON_NONCE: 'n-123' } as NodeJS.ProcessEnv).healthNonce).toBe('n-123');
    expect(resolveDaemonConfig({} as NodeJS.ProcessEnv).healthNonce).toBeUndefined();
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
});
