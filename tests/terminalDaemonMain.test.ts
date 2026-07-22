// Reconcile semantics for the supervised daemon (cutover item 1): a daemon
// restart RE-ADOPTS surviving atch masters — durable generation, killSpec
// registration — and never ensures/spawns over them.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type EmulatorEvent,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';
import { startTerminalDaemonServer } from '../src/server/runtime/terminalDaemon.js';
import * as runner from '../src/core/runner.js';
import { manifestReconcileTargets, reconcileExistingSessions } from '../src/server/runtime/terminalDaemonMain.js';
import { encodeFrame } from '../src/shared/atchWire/codec.js';
import { FrameType } from '../src/shared/atchWire/frames.js';
import { encodeBody } from '../src/shared/atchWire/messages.js';
import { shellQuote } from '../src/shared/shell.js';

/** A valid ATTACH_ACK frame at the given generation (all offsets/flags zeroed). */
function attachAckFrame(generation: number): Uint8Array {
  const payload = encodeBody(FrameType.ATTACH_ACK, {
    generation,
    retained_start_offset: 0n,
    retained_start_record_seq: 0n,
    retained_end_offset: 0n,
    retained_end_record_seq: 0n,
    controller_ack_offset: 0n,
    controller_ack_record_seq: 0n,
    has_checkpoint: 0,
    checkpoint_set_id: 0n,
    checkpoint_offset: 0n,
    checkpoint_record_seq: 0n,
    tail_offset: 0n,
    tail_record_seq: 0n,
    rows: 24,
    cols: 80,
    current_state_exact: 1,
    restart_recoverable: 0,
    main_exact: 1,
    alt_exact: 1,
    active_buffer: 0,
    caps: 0
  });
  return encodeFrame({ type: FrameType.ATTACH_ACK, flags: 0, generation, sequence: 0n, aux: 0n, payload });
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

/** A minimal fake v3 master: on the first handshake bytes, reply ATTACH_ACK at `generation`. */
function listenAsMaster(sockPath: string, generation: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once('data', () => socket.write(attachAckFrame(generation)));
    });
    server.on('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
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
  it('targets only manifest sessions whose atch socket is live, keyed by sessionId', () => {
    vi.spyOn(runner, 'loadDesk').mockReturnValue({
      sessions: [
        { sessionId: 'shell', tmuxSession: 'agentdesk-g-shell-abc' },
        { tmuxSession: 'agentdesk-g-legacy-def' },
        { sessionId: 'gone', tmuxSession: 'agentdesk-g-gone-xyz' }
      ]
    } as never);
    const live = new Set(['/root/shell.sock', '/root/agentdesk-g-legacy-def.sock']);
    const targets = manifestReconcileTargets('/root', (path) => live.has(path));
    expect(targets).toEqual([
      { sessionId: 'shell', sockPath: '/root/shell.sock' },
      { sessionId: 'agentdesk-g-legacy-def', sockPath: '/root/agentdesk-g-legacy-def.sock' }
    ]);
  });
});

describe('SessionManager.restoreAndAttach', () => {
  it('adopts the durable generation, attaches on a VALIDATED ack, and registers the killSpec that retire runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-reattach-'));
    const sockPath = join(dir, 'shell.sock');
    const marker = join(dir, 'killed.marker');
    const server = await listenAsMaster(sockPath, 1); // the surviving master owns generation 1
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell'); // the original spawn owns generation 1
      const { manager, ledger } = makeManager(store);

      const restored = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/touch', args: [marker] }
      });

      expect(restored).toEqual({ ok: true, generation: 1 });
      expect(ledger.current('shell')).toBe(1); // adopted, never allocated
      expect(manager.state('shell')?.generation).toBe(1);

      // retire must run the registered kill command — the pin against orphaning
      // a surviving master after a daemon restart.
      manager.retire('shell');
      await waitFor(() => existsSync(marker));
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed and rolls back when the socket does not accept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-reattach-'));
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      const result = await manager.restoreAndAttach('shell', {
        sockPath: join(dir, 'nobody-listening.sock'),
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/true', args: [] }
      });
      expect(result).toEqual({ ok: false, reason: 'attach-failed' });
      expect(manager.state('shell')).toBeUndefined(); // rolled back, slot freed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an ACK whose generation differs from the restored one (fence-split pin) without killing the master', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-reattach-'));
    const sockPath = join(dir, 'shell.sock');
    const marker = join(dir, 'killed.marker');
    // The master answers with generation 2, but the durable ledger says 1.
    const server = await listenAsMaster(sockPath, 2);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell'); // durable current = 1
      const { manager } = makeManager(store);
      const result = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/touch', args: [marker] },
        ackTimeoutMs: 2000
      });
      expect(result).toEqual({ ok: false, reason: 'attach-failed' });
      expect(manager.state('shell')).toBeUndefined(); // rolled back
      await new Promise((r) => setTimeout(r, 150));
      expect(existsSync(marker)).toBe(false); // the healthy-but-mismatched master was NOT killed
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out (attach-failed) when the master never ACKs, without killing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-reattach-'));
    const sockPath = join(dir, 'shell.sock');
    const marker = join(dir, 'killed.marker');
    const server = await new Promise<Server>((resolve, reject) => {
      const srv = createServer(() => {
        /* accept and stay silent — no ACK ever */
      });
      srv.on('error', reject);
      srv.listen(sockPath, () => resolve(srv));
    });
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      const result = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/touch', args: [marker] },
        ackTimeoutMs: 200
      });
      expect(result).toEqual({ ok: false, reason: 'attach-failed' });
      await new Promise((r) => setTimeout(r, 150));
      expect(existsSync(marker)).toBe(false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when there is no durable generation for the socket', async () => {
    const { manager } = makeManager();
    const result = await manager.restoreAndAttach('unknown', {
      sockPath: '/tmp/never.sock',
      geometry: { rows: 24, cols: 80 },
      killSpec: { binPath: '/usr/bin/true', args: [] }
    });
    expect(result).toEqual({ ok: false, reason: 'no-generation' });
  });
});

describe('spawnMaster ownership', () => {
  it('kills a child that stays alive without ever creating its socket (no leaked live child)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-spawn-'));
    const marker = `desk-leak-pin-${process.pid}`;
    try {
      let leaked: import('node:child_process').ChildProcess | undefined;
      const outcome = await spawnMaster({
        binPath: process.execPath,
        args: ['-e', `/* ${marker} */ setInterval(() => {}, 1000)`], // alive forever, no socket
        sockPath: join(dir, 'never.sock'),
        generation: 1,
        readyTimeoutMs: 250
      }).then(
        (r) => (leaked = r.child),
        (error: Error) => error
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toContain('timed out');
      expect(leaked).toBeUndefined();
      // the child this call created must not outlive the failure
      await new Promise((r) => setTimeout(r, 250));
      const { execFileSync } = await import('node:child_process');
      let alive = '';
      try {
        alive = execFileSync('pgrep', ['-f', marker]).toString().trim();
      } catch {
        // pgrep exits non-zero when nothing matches — exactly what we want
      }
      expect(alive).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unspawnable binary (ENOENT) as a controlled failure, not an unhandled error', async () => {
    await expect(
      spawnMaster({
        binPath: '/nonexistent/definitely-not-a-binary',
        args: [],
        sockPath: '/tmp/never-ever.sock',
        generation: 1,
        readyTimeoutMs: 500
      })
    ).rejects.toThrow(/spawn failed/);
  });
});

describe('SessionManager.spawnAndAttach (provision rollback)', () => {
  it('frees the allocated slot when the master never comes up (no capacity leak)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provision-'));
    try {
      const { manager, ledger } = makeManager();
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/false', // exits immediately; the socket never appears
        args: [],
        sockPath: join(dir, 'never.sock'),
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 300,
        detached: true,
        killSpec: { binPath: '/usr/bin/true', args: [] }
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      expect(manager.state('shell')).toBeUndefined(); // slot rolled back
      expect(ledger.current('shell')).toBe(1); // the allocation itself stays durable (tombstone)
      // capacity is actually free again: a fresh ensure succeeds at the next generation
      const again = manager.ensure('shell', { rows: 24, cols: 80 });
      expect(again.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the killSpec on a detached spawn timeout (a forked master must not be stranded)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provision-'));
    const marker = join(dir, 'killspec.marker');
    try {
      const { manager } = makeManager();
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/false',
        args: [],
        sockPath: join(dir, 'never.sock'),
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 300,
        detached: true,
        killSpec: { binPath: '/usr/bin/touch', args: [marker] }
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      await waitFor(() => existsSync(marker)); // the failure invoked THIS op's kill command
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('coalesces concurrent provisions for one session into ONE spawn with one shared result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provision-'));
    const sockPath = join(dir, 'shell.sock');
    const countFile = join(dir, 'spawn-count');
    const genFile = join(dir, 'gen.txt');
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-atch.mjs');
    try {
      const { manager } = makeManager();
      const opts = {
        // each real spawn appends one line before starting the fake master
        binPath: '/bin/sh',
        args: [
          '-c',
          `echo x >> ${shellQuote(countFile)}; exec ${shellQuote(process.execPath)} ${shellQuote(fixture)} ${shellQuote(sockPath)} ${shellQuote(genFile)}`
        ],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 4000
      };
      const [a, b] = await Promise.all([manager.spawnAndAttach('shell', opts), manager.spawnAndAttach('shell', opts)]);
      expect(a.ok).toBe(true);
      expect(b).toEqual(a); // both callers observe the one operation's result
      const spawns = readFileSync(countFile, 'utf8').trim().split('\n').length;
      expect(spawns).toBe(1);
      manager.retire('shell');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionManager.retireAwaited (the restart-race pin)', () => {
  it('resolves only after the kill completed AND the socket disappeared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      const restored = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        // a DELAYED kill, like the real atch kill: the socket vanishes ~300ms later
        killSpec: { binPath: '/bin/sh', args: ['-c', `sleep 0.3; rm -f ${shellQuote(sockPath)}`] }
      });
      expect(restored.ok).toBe(true);

      const started = Date.now();
      const result = await manager.retireAwaited('shell', { timeoutMs: 4000 });
      expect(result).toEqual({ ok: true });
      // the pin: at resolution the stale socket is ALREADY gone — a reprovision
      // starting now can never adopt it at the old generation
      expect(existsSync(sockPath)).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a failing kill command as an error, not success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      const restored = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/bin/false', args: [] }
      });
      expect(restored.ok).toBe(true);
      const result = await manager.retireAwaited('shell');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('kill command exited');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unspawnable kill command (ENOENT) as an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      expect((await manager.restoreAndAttach('shell', { sockPath, geometry: { rows: 24, cols: 80 }, killSpec: { binPath: '/nonexistent/atch', args: [] } })).ok).toBe(true);
      const result = await manager.retireAwaited('shell');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('kill spawn failed');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds a HUNG kill command instead of blocking retire forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      expect((await manager.restoreAndAttach('shell', { sockPath, geometry: { rows: 24, cols: 80 }, killSpec: { binPath: '/bin/sh', args: ['-c', 'sleep 60'] } })).ok).toBe(true);
      const started = Date.now();
      const result = await manager.retireAwaited('shell', { timeoutMs: 400 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('timed out');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spawnAndAttach detached ACK mismatch (foreign master)', () => {
  it('kills what THIS op targeted exactly once and leaves no stale teardown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-mismatch-'));
    const sockPath = join(dir, 'shell.sock');
    const marker = join(dir, 'killed.marker');
    // A FOREIGN master already owns the socket and ACKs generation 99; the
    // provision (ens generation 1) must reject it, run its kill exactly once,
    // and leave no stale detachedKills entry behind.
    const server = await listenAsMaster(sockPath, 99);
    try {
      const { manager } = makeManager();
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/true', // detached launcher no-op; the socket already exists
        args: [],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 2000,
        detached: true,
        // like the real atch kill: stop the master AND remove its socket
        killSpec: { binPath: '/bin/sh', args: ['-c', `date +%s%N >> ${shellQuote(marker)}; rm -f ${shellQuote(sockPath)}`] }
      });
      expect(result).toEqual({ ok: false, reason: 'attach-failed' });
      expect(manager.state('shell')).toBeUndefined(); // slot freed
      await waitFor(() => existsSync(marker));
      const killRuns = readFileSync(marker, 'utf8').trim().split('\n').length;
      expect(killRuns).toBe(1); // killed once — not zero, not twice
      // no stale teardown: a follow-up control retire has nothing to kill
      expect(await manager.retireAwaited('shell')).toEqual({ ok: true });
      expect(readFileSync(marker, 'utf8').trim().split('\n').length).toBe(1);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startTerminalDaemonServer socket root', () => {
  it('creates an absent nested socket root (0700) before anything can provision', async () => {
    const base = mkdtempSync(join(tmpdir(), 'desk-root-'));
    const home = join(base, 'home');
    const socketRoot = join(base, 'nested', 'atch'); // does not exist yet
    const { mkdirSync: mk } = await import('node:fs');
    mk(join(home, '_engine'), { recursive: true });
    const server = await startTerminalDaemonServer({
      homeRoot: home,
      atchBinPath: '/usr/bin/true',
      atchSocketRoot: socketRoot,
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
    const restoreAndAttach = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, generation: 1 })
      .mockResolvedValueOnce({ ok: false, reason: 'no-generation' })
      .mockRejectedValueOnce(new Error('socket exploded'));
    const daemon = { router: { sessions: { restoreAndAttach } } } as never;
    const results = await reconcileExistingSessions(
      daemon,
      [
        { sessionId: 'a', sockPath: '/r/a.sock' },
        { sessionId: 'b', sockPath: '/r/b.sock' },
        { sessionId: 'c', sockPath: '/r/c.sock' }
      ],
      '/opt/atch'
    );
    expect(results).toEqual([
      { sessionId: 'a', ok: true },
      { sessionId: 'b', ok: false, error: 'no-generation' },
      { sessionId: 'c', ok: false, error: 'socket exploded' }
    ]);
    // the killSpec carries the resolved atch binary + the exact socket path
    expect(restoreAndAttach.mock.calls[0][1].killSpec).toEqual({ binPath: '/opt/atch', args: ['kill', '-f', '/r/a.sock'] });
  });
});
