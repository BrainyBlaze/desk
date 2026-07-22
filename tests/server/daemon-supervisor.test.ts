import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  daemonChildEnv,
  resolveAtchBinPath,
  resolveDaemonCommand,
  resolveReleaseRoot,
  startDaemonSupervisor
} from '../../src/server/runtime/daemonSupervisor.js';

class FakeChild extends EventEmitter {
  stdout = null;
  stderr = null;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills: string[] = [];
  constructor(public pid = 4242) {
    super();
  }
  get killed(): string | undefined {
    return this.kills[0];
  }
  kill(signal?: string): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }
  /** Emit exit AND set the fields the escalation guard checks. */
  exit(code: number | null, signal: string | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface Harness {
  spawns: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[];
  children: FakeChild[];
  timers: { fn: () => void; ms: number }[];
  logs: string[];
}

function makeSupervisor(options: { maxRestarts?: number; restartWindowMs?: number } = {}) {
  const h: Harness = { spawns: [], children: [], timers: [], logs: [] };
  const supervisor = startDaemonSupervisor({
    command: ['node', 'daemon.js'],
    env: { DESK_DAEMON_PORT: '5178' },
    maxRestarts: options.maxRestarts ?? 2,
    restartWindowMs: options.restartWindowMs ?? 60_000,
    backoffMs: () => 5,
    terminationGraceMs: 7777, // escalation timers are identifiable by this ms
    log: (message) => h.logs.push(message),
    spawnFn: ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      h.spawns.push({ bin, args, env: opts.env });
      h.children.push(child);
      return child;
    }) as never,
    setTimeoutFn: (fn, ms) => {
      h.timers.push({ fn, ms });
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }
  });
  return { supervisor, h };
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  vi.restoreAllMocks();
});

describe('startDaemonSupervisor', () => {
  it('spawns the command with the extra env and SCRUBS leaked agent-session vars', () => {
    setEnv('DESK_AGENT', 'codex');
    setEnv('DESK_TMUX_SESSION', 'agentdesk-leaked');
    setEnv('DESK_SESSION_ID', 'leaked-durable-id');
    const { supervisor, h } = makeSupervisor();
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].bin).toBe('node');
    expect(h.spawns[0].args).toEqual(['daemon.js']);
    expect(h.spawns[0].env.DESK_DAEMON_PORT).toBe('5178');
    expect(h.spawns[0].env.DESK_AGENT).toBeUndefined();
    expect(h.spawns[0].env.DESK_TMUX_SESSION).toBeUndefined();
    expect(h.spawns[0].env.DESK_SESSION_ID).toBeUndefined();
    expect(supervisor.status()).toMatchObject({ state: 'running', pid: 4242 });
    supervisor.dispose();
  });

  it('restarts after an unexpected exit, with backoff', () => {
    const { supervisor, h } = makeSupervisor();
    h.children[0].emit('exit', 1, null);
    expect(supervisor.status().state).toBe('restarting');
    expect(h.timers).toHaveLength(1);
    h.timers[0].fn();
    expect(h.spawns).toHaveLength(2);
    expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 1 });
    supervisor.dispose();
  });

  it('gives up (fail closed) past the restart cap inside the window', () => {
    const { supervisor, h } = makeSupervisor({ maxRestarts: 2 });
    for (let i = 0; i < 2; i += 1) {
      h.children[h.children.length - 1].emit('exit', 1, null);
      h.timers[h.timers.length - 1].fn();
    }
    // third crash inside the window exceeds the cap
    h.children[h.children.length - 1].emit('exit', 1, null);
    expect(supervisor.status().state).toBe('gave-up');
    expect(h.spawns).toHaveLength(3); // no further spawn
    expect(h.logs.some((line) => line.includes('giving up'))).toBe(true);
    supervisor.dispose();
  });

  it('dispose SIGTERMs the child, escalates a WEDGED child to SIGKILL, and suppresses any restart', () => {
    const { supervisor, h } = makeSupervisor();
    supervisor.dispose();
    expect(h.children[0].killed).toBe('SIGTERM');
    // the only scheduled timer is the SIGKILL escalation, not a restart
    expect(h.timers).toHaveLength(1);
    // the child is wedged (never exits): the escalation fires SIGKILL
    h.timers.shift()?.fn();
    expect(h.children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(supervisor.status().state).toBe('disposed');
  });

  it('does NOT escalate a child that exited within the grace period', () => {
    const { supervisor, h } = makeSupervisor();
    supervisor.dispose();
    h.children[0].exit(null, 'SIGTERM'); // graceful exit before the grace elapses
    h.timers.shift()?.fn(); // escalation timer fires — must be a no-op
    expect(h.children[0].kills).toEqual(['SIGTERM']);
    expect(supervisor.status().state).toBe('disposed');
  });

  it('routes a spawn error (ENOENT) through the same bounded-restart accounting', () => {
    const { supervisor, h } = makeSupervisor();
    h.children[0].emit('error', new Error('spawn ENOENT'));
    expect(h.logs.some((line) => line.includes('spawn failed'))).toBe(true);
    expect(supervisor.status().state).toBe('restarting');
    supervisor.dispose();
  });

  it('a late exit from an OLD child neither clears the live child nor spawns a third daemon', () => {
    const { supervisor, h } = makeSupervisor();
    const childA = h.children[0];
    // A errors → accounted once → restart timer fires → B is live.
    childA.emit('error', new Error('crash'));
    h.timers[0].fn();
    expect(h.spawns).toHaveLength(2);
    const pidB = h.children[1].pid;
    // A's LATE exit (error and exit both fire for one child) must be a no-op:
    childA.emit('exit', 1, null);
    expect(supervisor.status()).toMatchObject({ state: 'running', pid: pidB });
    expect(h.timers).toHaveLength(1); // no second restart scheduled
    expect(h.spawns).toHaveLength(2); // and no concurrent third daemon
    supervisor.dispose();
  });

  it('probes health per child: readiness is NONCE-bound, resets on relaunch, and an old daemon on the shared port cannot mark the new child ready', async () => {
    const h: { spawns: number; children: FakeChild[]; timers: { fn: () => void; ms: number }[]; spawnedEnvs: NodeJS.ProcessEnv[] } = {
      spawns: 0,
      children: [],
      timers: [],
      spawnedEnvs: []
    };
    // the daemon currently ANSWERING on the shared port (may be the OLD one)
    let serving: { healthy: boolean; nonce?: string } = { healthy: false };
    const nonces = ['nonce-A', 'nonce-B'];
    let minted = 0;
    const supervisor = startDaemonSupervisor({
      command: ['node', 'daemon.js'],
      healthUrl: 'http://127.0.0.1:5178/control/health',
      probeFn: async () => serving,
      mintNonce: () => nonces[minted++],
      healthProbe: { attempts: 5, intervalMs: 1 },
      backoffMs: () => 1,
      log: () => undefined,
      spawnFn: ((_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        h.spawns += 1;
        h.spawnedEnvs.push(opts.env);
        const child = new FakeChild(1000 + h.spawns);
        h.children.push(child);
        return child;
      }) as never,
      setTimeoutFn: (fn, ms) => {
        h.timers.push({ fn, ms });
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }
    });
    // the child received ITS nonce in env
    expect(h.spawnedEnvs[0].DESK_DAEMON_NONCE).toBe('nonce-A');
    await new Promise((r) => setImmediate(r));
    expect(supervisor.status().ready).toBe(false); // nothing serving yet
    serving = { healthy: true, nonce: 'nonce-A' };
    h.timers.shift()?.fn();
    await new Promise((r) => setImmediate(r));
    expect(supervisor.status().ready).toBe(true);

    // crash → relaunch as child B (nonce-B) while the OLD daemon still answers
    // with nonce-A on the shared port: B must NOT become ready from it.
    h.children[0].emit('exit', 1, null);
    h.timers.shift()?.fn(); // restart timer → child B
    expect(h.spawnedEnvs[1].DESK_DAEMON_NONCE).toBe('nonce-B');
    await new Promise((r) => setImmediate(r));
    expect(supervisor.status()).toMatchObject({ state: 'running', ready: false });
    h.timers.shift()?.fn(); // B's probe retry — old daemon STILL answering nonce-A
    await new Promise((r) => setImmediate(r));
    expect(supervisor.status().ready).toBe(false); // the pin: no readiness from A's response
    serving = { healthy: true, nonce: 'nonce-B' }; // the new daemon finally binds
    h.timers.shift()?.fn();
    await new Promise((r) => setImmediate(r));
    expect(supervisor.status().ready).toBe(true);
    supervisor.dispose();
  });
});

describe('resolveReleaseRoot + production shape', () => {
  it('falls back to a release-shaped cwd when the module URL is not on a release filesystem (compiled standalone)', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(root, 'dist', 'cli', 'main.js'), '');
      expect(resolveReleaseRoot('file:///$bunfs/root/desk-standalone', root)).toBe(root);
      expect(() => resolveReleaseRoot('file:///$bunfs/root/desk-standalone', '/nonexistent-cwd')).toThrow(/DESK_DAEMON_CMD/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the release runtime/node over process.execPath (installed layout)', () => {
    setEnv('DESK_DAEMON_CMD', undefined);
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(root, 'dist', 'cli', 'main.js'), '');
      mkdirSync(join(root, 'runtime'), { recursive: true });
      writeFileSync(join(root, 'runtime', 'node'), '#!/bin/sh\n');
      chmodSync(join(root, 'runtime', 'node'), 0o755);
      mkdirSync(join(root, 'src'), { recursive: true });
      const fromUrl = pathToFileURL(join(root, 'src', 'module.js')).href;
      expect(resolveDaemonCommand(fromUrl, process.env, '/opt/desk/libexec/desk-standalone')).toEqual([
        join(root, 'runtime', 'node'),
        join(root, 'dist', 'cli', 'main.js'),
        'terminal-daemon'
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when execPath is the Bun standalone and no runtime/node ships (never recurse the HTTP entrypoint)', () => {
    setEnv('DESK_DAEMON_CMD', undefined);
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(root, 'dist', 'cli', 'main.js'), '');
      mkdirSync(join(root, 'src'), { recursive: true });
      const fromUrl = pathToFileURL(join(root, 'src', 'module.js')).href;
      expect(() => resolveDaemonCommand(fromUrl, process.env, '/opt/desk/libexec/desk-standalone')).toThrow(/not node/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveDaemonCommand', () => {
  it('honors the explicit DESK_DAEMON_CMD override', () => {
    setEnv('DESK_DAEMON_CMD', 'node /tmp/daemon.cjs');
    expect(resolveDaemonCommand('file:///nowhere/module.js')).toEqual(['node', '/tmp/daemon.cjs']);
  });

  it('derives the same-release node + dist CLI entry, never PATH desk', () => {
    setEnv('DESK_DAEMON_CMD', undefined);
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(root, 'dist', 'cli', 'main.js'), '');
      mkdirSync(join(root, 'src'), { recursive: true });
      const fromUrl = pathToFileURL(join(root, 'src', 'module.js')).href;
      expect(resolveDaemonCommand(fromUrl)).toEqual([process.execPath, join(root, 'dist', 'cli', 'main.js'), 'terminal-daemon']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the release has no built CLI entry', () => {
    setEnv('DESK_DAEMON_CMD', undefined);
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'vite.config.ts'), '');
      mkdirSync(join(root, 'src'), { recursive: true });
      const fromUrl = pathToFileURL(join(root, 'src', 'module.js')).href;
      expect(() => resolveDaemonCommand(fromUrl)).toThrow(/dist\/cli\/main\.js|DESK_DAEMON_CMD/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveAtchBinPath', () => {
  it('preflights DESK_ATCH_BIN, then release libexec/atch, then an ABSOLUTE PATH hit, else throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    const pathDir = mkdtempSync(join(tmpdir(), 'desk-path-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'vite.config.ts'), '');
      mkdirSync(join(root, 'src'), { recursive: true });
      const fromUrl = pathToFileURL(join(root, 'src', 'module.js')).href;

      // an explicit-but-unusable DESK_ATCH_BIN fails BEFORE launch, not at first provision
      setEnv('DESK_ATCH_BIN', '/opt/custom/atch');
      expect(() => resolveAtchBinPath(fromUrl)).toThrow(/not an executable/);

      const custom = join(pathDir, 'custom-atch');
      writeFileSync(custom, '#!/bin/sh\n');
      chmodSync(custom, 0o755);
      setEnv('DESK_ATCH_BIN', custom);
      expect(resolveAtchBinPath(fromUrl)).toBe(custom);

      // no explicit, no bundled, nothing on PATH → fail closed
      setEnv('DESK_ATCH_BIN', undefined);
      setEnv('PATH', '/nonexistent-dir');
      expect(() => resolveAtchBinPath(fromUrl)).toThrow(/no atch binary/);

      // a PATH hit resolves to the ABSOLUTE preflighted path, never the bare name
      writeFileSync(join(pathDir, 'atch'), '#!/bin/sh\n');
      chmodSync(join(pathDir, 'atch'), 0o755);
      setEnv('PATH', pathDir);
      expect(resolveAtchBinPath(fromUrl)).toBe(join(pathDir, 'atch'));

      // the same-release bundled binary outranks PATH
      mkdirSync(join(root, 'libexec'), { recursive: true });
      writeFileSync(join(root, 'libexec', 'atch'), '#!/bin/sh\n');
      chmodSync(join(root, 'libexec', 'atch'), 0o755);
      expect(resolveAtchBinPath(fromUrl)).toBe(join(root, 'libexec', 'atch'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it('rejects a DIRECTORY at every preflight site (X_OK alone passes for directories)', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-release-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(root, 'dist', 'cli', 'main.js'), '');
      mkdirSync(join(root, 'src'), { recursive: true });
      const fromUrl = pathToFileURL(join(root, 'src', 'module.js')).href;

      // libexec/atch as a DIRECTORY must not preflight as the atch binary
      mkdirSync(join(root, 'libexec', 'atch'), { recursive: true });
      setEnv('DESK_ATCH_BIN', undefined);
      setEnv('PATH', '/nonexistent-dir');
      expect(() => resolveAtchBinPath(fromUrl)).toThrow(/no atch binary/);

      // an explicit DESK_ATCH_BIN naming a directory fails the preflight too
      setEnv('DESK_ATCH_BIN', join(root, 'libexec', 'atch'));
      expect(() => resolveAtchBinPath(fromUrl)).toThrow(/not an executable/);

      // runtime/node as a DIRECTORY must not be picked as the release runtime
      setEnv('DESK_ATCH_BIN', undefined);
      setEnv('DESK_DAEMON_CMD', undefined);
      mkdirSync(join(root, 'runtime', 'node'), { recursive: true });
      expect(resolveDaemonCommand(fromUrl, process.env, '/usr/local/bin/node')).toEqual([
        '/usr/local/bin/node', // falls through to the node execPath, never the directory
        join(root, 'dist', 'cli', 'main.js'),
        'terminal-daemon'
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('never-ready hard cap (immune to the rolling window)', () => {
  it('gives up after maxRestarts consecutive pre-ready failures even when every exit ages out of the window', async () => {
    const children: FakeChild[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];
    const supervisor = startDaemonSupervisor({
      command: ['node', 'daemon.js'],
      healthUrl: 'http://127.0.0.1:5178/control/health',
      probeFn: async () => ({ healthy: false }), // never ready
      healthProbe: { attempts: 1, intervalMs: 1 }, // exhaust instantly
      maxRestarts: 2,
      restartWindowMs: 1, // every exit ages out immediately — the OLD logic never trips
      backoffMs: () => 1,
      terminationGraceMs: 7777,
      log: (message) => logs.push(message),
      spawnFn: (() => {
        const child = new FakeChild(3000 + children.length);
        children.push(child);
        return child;
      }) as never,
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }
    });
    // each cycle: probe exhausts → SIGTERM → we emit exit → restart timer → next child
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await new Promise((r) => setImmediate(r)); // probe attempt → exhaustion kill
      const current = children[children.length - 1];
      expect(current.killed).toBe('SIGTERM');
      current.exit(null, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 3)); // let the window age the exit out
      const restartIndex = timers.findIndex((t) => t.ms !== 7777);
      const restart = restartIndex >= 0 ? timers.splice(restartIndex, 1)[0] : undefined;
      if (supervisor.status().state === 'gave-up') break;
      restart?.fn();
    }
    expect(supervisor.status().state).toBe('gave-up'); // hard cap despite the aged-out window
    expect(children.length).toBe(3); // 1 initial + 2 restarts, never a 4th
    expect(logs.some((line) => line.includes('failed to become ready'))).toBe(true);
    supervisor.dispose();
  });
});

describe('probe exhaustion', () => {
  it('terminates a never-ready child so bounded-restart accounting decides', async () => {
    const children: FakeChild[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const logs: string[] = [];
    const supervisor = startDaemonSupervisor({
      command: ['node', 'daemon.js'],
      healthUrl: 'http://127.0.0.1:5178/control/health',
      probeFn: async () => ({ healthy: false }),
      healthProbe: { attempts: 2, intervalMs: 1 },
      terminationGraceMs: 7777,
      backoffMs: () => 1,
      log: (message) => logs.push(message),
      spawnFn: (() => {
        const child = new FakeChild(2000 + children.length);
        children.push(child);
        return child;
      }) as never,
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }
    });
    await new Promise((r) => setImmediate(r)); // probe attempt 1 (unhealthy)
    timers.shift()?.fn(); // probe retry tick → attempt 2 = exhaustion
    await new Promise((r) => setImmediate(r));
    expect(children[0].killed).toBe('SIGTERM');
    expect(logs.some((line) => line.includes('terminating it for restart accounting'))).toBe(true);

    // the child is WEDGED (ignores SIGTERM): the grace escalation SIGKILLs it,
    // and its eventual exit enters restart accounting EXACTLY once.
    const escalation = timers.findIndex((t) => t.ms === 7777);
    expect(escalation).toBeGreaterThanOrEqual(0);
    timers.splice(escalation, 1)[0].fn();
    expect(children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    children[0].exit(null, 'SIGKILL');
    const restarts = timers.filter((t) => t.ms !== 7777);
    expect(restarts).toHaveLength(1); // one restart scheduled — never double-accounted
    supervisor.dispose();
  });
});

describe('daemonChildEnv', () => {
  it('derives host and port from DESK_DAEMON_URL so proxy and daemon stay in lockstep', () => {
    setEnv('DESK_DAEMON_URL', 'ws://10.0.0.5:6001');
    expect(daemonChildEnv()).toEqual({ DESK_DAEMON_HOST: '10.0.0.5', DESK_DAEMON_PORT: '6001' });
    setEnv('DESK_DAEMON_URL', undefined);
    expect(daemonChildEnv()).toEqual({ DESK_DAEMON_HOST: '127.0.0.1', DESK_DAEMON_PORT: '5178' });
    setEnv('DESK_DAEMON_URL', 'not a url');
    expect(daemonChildEnv()).toEqual({ DESK_DAEMON_HOST: '127.0.0.1', DESK_DAEMON_PORT: '5178' });
  });
});
