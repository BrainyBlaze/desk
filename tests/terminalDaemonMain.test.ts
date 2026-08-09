// Reconcile semantics for the supervised daemon (cutover item 1): a daemon
// restart RE-ADOPTS surviving atch masters — durable generation, killSpec
// registration — and never ensures/spawns over them.

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
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';
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
        { sessionId: 'shell', agent: 'claude', uiMode: 'native' },
        { sessionId: 'other', agent: 'bash', uiMode: 'terminal' },
        { sessionId: 'gone', agent: 'codex', uiMode: 'terminal' }
      ]
    } as never);
    const live = new Set(['/root/shell.sock', '/root/other.sock']);
    const targets = manifestReconcileTargets('/root', (path) => live.has(path));
    expect(targets).toEqual([
      {
        sessionId: 'shell',
        sockPath: '/root/shell.sock',
        subject: {
          kind: 'agent',
          provider: 'claude',
          mode: 'native',
          producer: 'claude-native'
        }
      },
      { sessionId: 'other', sockPath: '/root/other.sock', subject: { kind: 'terminal' } }
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

  it('restores lifecycle but not stale activity, while retaining the original durable duplicate receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-agent-reattach-'));
    const sockPath = join(dir, 'agent.sock');
    const intakePath = join(dir, 'agent-state-intake.ndjson');
    const store = new InMemoryGenerationLedger();
    const subject = {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks'
    } as const;
    const event: AgentStateEnvelope = {
      schemaVersion: AGENT_STATE_SCHEMA_VERSION,
      sessionId: 'agent',
      generation: 1,
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      producerInstanceId: 'hooks-a',
      producerSeq: 1,
      eventId: 'hooks-a:1',
      invocationId: 'turn-1',
      occurredAt: 900,
      observedAt: 950,
      facts: [{ kind: 'activity', activity: 'working' }]
    };
    const first = makeManagerWithIntake(store, intakePath);
    const ensured = first.manager.ensure('agent', { rows: 24, cols: 80 }, subject);
    expect(ensured).toEqual({ ok: true, generation: 1, created: true });
    const accepted = first.manager.ingestAgentState(event);
    expect(accepted.kind).toBe('accepted');
    expect(first.manager.stateSnapshot('agent')?.subject).toMatchObject({ activity: 'working' });
    first.close();

    const server = await listenAsMaster(sockPath, 1);
    const second = makeManagerWithIntake(store, intakePath);
    try {
      const restored = await second.manager.restoreAndAttach('agent', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: '/usr/bin/true', args: [] },
        subject
      });
      expect(restored).toEqual({ ok: true, generation: 1 });
      expect(second.manager.stateSnapshot('agent')).toMatchObject({
        lifecycle: 'running',
        subject: { kind: 'agent', activity: 'unknown', evidence: null }
      });

      const duplicate = second.manager.ingestAgentState(event);
      expect(duplicate).toMatchObject({
        kind: 'duplicate',
        event: {
          acceptanceId:
            accepted.kind === 'accepted' ? accepted.event.acceptanceId : 'unreachable'
        }
      });
      expect(second.manager.stateSnapshot('agent')?.subject).toMatchObject({
        activity: 'unknown',
        evidence: null
      });
    } finally {
      second.close();
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
      expect(manager.state('shell')).toMatchObject({ lifecycle: 'exited' });
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
      expect(manager.state('shell')).toMatchObject({ lifecycle: 'exited' });
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
  it('runs the provider fence before generation allocation or process execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provider-fence-'));
    const marker = join(dir, 'spawned.marker');
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager, ledger } = makeManager(store);
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/usr/bin/touch',
        args: [marker],
        sockPath: join(dir, 'shell.sock'),
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 200,
        detached: true,
        preallocateSpawn: (context) => {
          expect(context).toMatchObject({
            sessionId: 'shell',
            currentGeneration: 1,
            nextGeneration: 2
          });
          return {
            ok: false,
            reason: 'provider-session-identity-missing',
            detail: 'not-authorized'
          };
        }
      });

      expect(result).toEqual({
        ok: false,
        reason: 'provider-session-identity-missing',
        detail: 'not-authorized'
      });
      expect(ledger.current('shell')).toBe(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a dead socket tombstone before running the provider fence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provider-fence-'));
    const sockPath = join(dir, 'shell.sock');
    writeFileSync(sockPath, 'stale');
    try {
      const { manager, ledger } = makeManager();
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/false',
        args: [],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        detached: true,
        preallocateSpawn: () => {
          expect(existsSync(sockPath)).toBe(false);
          return {
            ok: false,
            reason: 'provider-session-identity-missing',
            detail: 'reset-incomplete'
          };
        }
      });

      expect(result).toEqual({
        ok: false,
        reason: 'provider-session-identity-missing',
        detail: 'reset-incomplete'
      });
      expect(ledger.current('shell')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bypasses the provider fence when provision returns an attached live session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provider-fence-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    try {
      const { manager } = makeManager();
      expect(manager.ensure('shell', { rows: 24, cols: 80 }).ok).toBe(true);
      expect(
        await manager.attachMaster('shell', sockPath, { rows: 24, cols: 80 })
      ).toBe(true);
      const fence = vi.fn(() => ({
        ok: false as const,
        reason: 'provider-session-identity-missing' as const,
        detail: 'not-authorized' as const
      }));

      await expect(
        manager.spawnAndAttach('shell', {
          binPath: '/bin/false',
          args: [],
          sockPath,
          geometry: { rows: 24, cols: 80 },
          preallocateSpawn: fence
        })
      ).resolves.toMatchObject({ ok: true, generation: 1, created: false });
      expect(fence).not.toHaveBeenCalled();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      expect(manager.state('shell')).toMatchObject({ lifecycle: 'exited' });
      expect(ledger.current('shell')).toBe(1); // the allocation itself stays durable (tombstone)
      // capacity is actually free again: a fresh ensure succeeds at the next generation
      const again = manager.ensure('shell', { rows: 24, cols: 80 });
      expect(again.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a NONZERO launcher exit never establishes ownership: fails without running the killSpec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provision-'));
    const marker = join(dir, 'killspec.marker');
    try {
      const { manager } = makeManager();
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/false', // atch start failing (e.g. EADDRINUSE) forks nothing
        args: [],
        sockPath: join(dir, 'never.sock'),
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 300,
        detached: true,
        killSpec: { binPath: '/usr/bin/touch', args: [marker] }
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false); // no ownership → no kill
      expect(manager.state('shell')).toMatchObject({ lifecycle: 'exited' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a CLEAN launcher exit with no socket (timeout) is ownership-possible: the killSpec runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provision-'));
    const marker = join(dir, 'killspec.marker');
    try {
      const { manager } = makeManager();
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/sh',
        args: ['-c', 'exit 0'], // launcher claims success; a fork may exist half-started
        sockPath: join(dir, 'never.sock'),
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 300,
        detached: true,
        killSpec: { binPath: '/usr/bin/touch', args: [marker] }
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      await waitFor(() => existsSync(marker)); // this op's kill ran (socket-path-targeted, harmless if nothing forked)
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

  it('serializes provider reset behind an in-flight provision before touching identity state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provider-reset-'));
    const sockPath = join(dir, 'shell.sock');
    let releasePreparation: (() => void) | undefined;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const transaction = vi.fn(async (generation: number) => generation);
    try {
      const { manager } = makeManager();
      const provision = manager.spawnAndAttach('shell', {
        binPath: '/bin/false',
        args: [],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        prepareSpawn: async () => {
          await preparationGate;
          throw new Error('stop before spawn');
        }
      });
      await waitFor(() => manager.stateSnapshot('shell') !== undefined);

      const reset = manager.resetForProviderSession(
        'shell',
        sockPath,
        transaction
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(transaction).not.toHaveBeenCalled();

      releasePreparation?.();
      await expect(provision).resolves.toEqual({
        ok: false,
        reason: 'spawn-failed'
      });
      await expect(reset).resolves.toEqual({
        ok: true,
        generation: 1,
        value: 1
      });
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses provider reset while an unowned socket still has a live listener', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-provider-reset-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    const transaction = vi.fn(async () => undefined);
    try {
      const { manager } = makeManager();

      await expect(
        manager.resetForProviderSession('shell', sockPath, transaction)
      ).resolves.toEqual({
        ok: false,
        reason: 'session-live',
        error: 'session shell still has a listening master'
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(existsSync(sockPath)).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionManager.retireAwaited (the restart-race pin)', () => {
  it('does not retire a newer generation for a stale exact-generation request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-generation-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 2);
    try {
      const store = new InMemoryGenerationLedger();
      const ledger = new GenerationLedger(store);
      ledger.allocate('shell');
      ledger.allocate('shell');
      const { manager } = makeManager(store);
      const restored = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: {
          binPath: '/bin/sh',
          args: ['-c', `rm -f ${shellQuote(sockPath)}`]
        }
      });
      expect(restored).toMatchObject({ ok: true, generation: 2 });

      const result = await manager.retireGenerationAwaited('shell', 1);

      expect(result).toEqual({
        ok: false,
        reason: 'generation-mismatch',
        expectedGeneration: 1,
        currentGeneration: 2,
        error: 'session shell is generation 2, not 1'
      });
      expect(manager.stateSnapshot('shell')).toMatchObject({ generation: 2 });
      expect(existsSync(sockPath)).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retires only the exact requested generation to confirmed completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-generation-'));
    const sockPath = join(dir, 'shell.sock');
    const server = await listenAsMaster(sockPath, 1);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      expect(
        (
          await manager.restoreAndAttach('shell', {
            sockPath,
            geometry: { rows: 24, cols: 80 },
            killSpec: {
              binPath: '/bin/sh',
              args: ['-c', `rm -f ${shellQuote(sockPath)}`]
            }
          })
        ).ok
      ).toBe(true);

      const result = await manager.retireGenerationAwaited('shell', 1, {
        timeoutMs: 4_000
      });

      expect(result).toEqual({ ok: true });
      expect(manager.stateSnapshot('shell')).toMatchObject({
        generation: 1,
        lifecycle: 'exited'
      });
      expect(existsSync(sockPath)).toBe(false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('cleans a stale socket after a known attached master has already died', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-retire-stale-'));
    const sockPath = join(dir, 'shell.sock');
    const genFile = join(dir, 'generation');
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-atch.mjs');
    const child = spawn(process.execPath, [fixture, sockPath, genFile], {
      env: { ...process.env, ATCH_GENERATION: '1' },
      stdio: 'ignore'
    });
    try {
      await waitFor(() => existsSync(sockPath));
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      const restored = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: {
          binPath: '/bin/false',
          args: [],
          staleCleanupSpec: {
            binPath: '/bin/sh',
            args: ['-c', `test -S ${shellQuote(sockPath)} && rm -f ${shellQuote(sockPath)}`]
          }
        }
      });
      expect(restored.ok).toBe(true);

      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(existsSync(sockPath)).toBe(true);

      const result = await manager.retireAwaited('shell');
      expect(result).toEqual({ ok: true });
      expect(existsSync(sockPath)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
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

describe('spawnAndAttach foreign-socket preflight (ownership invariant)', () => {
  it('a Boot over a surviving master neither kills it nor advances its durable generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-foreign-'));
    const sockPath = join(dir, 'shell.sock');
    const marker = join(dir, 'killed.marker');
    // A surviving generation-1 master owns the socket. This operation did not
    // spawn it — provision must fail WITHOUT touching it: no kill, no ledger
    // advance (an allocate to 2 would fence it out of every future reconcile).
    const server = await listenAsMaster(sockPath, 1);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell'); // durable current = the master's 1
      const { manager, ledger } = makeManager(store);
      const fence = vi.fn(() => ({
        ok: false as const,
        reason: 'provider-session-identity-missing' as const,
        detail: 'not-authorized' as const
      }));
      const result = await manager.spawnAndAttach('shell', {
        binPath: '/bin/true',
        args: [],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 2000,
        detached: true,
        preallocateSpawn: fence,
        killSpec: { binPath: '/usr/bin/touch', args: [marker] }
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      expect(manager.state('shell')).toBeUndefined(); // no session admitted
      expect(ledger.current('shell')).toBe(1); // NOT advanced — reconcile can still adopt it
      expect(fence).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false); // the foreign master was NOT killed
      // and it still accepts connections (alive + adoptable)
      const { connect } = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const probe = connect(sockPath);
        probe.once('connect', () => {
          probe.destroy();
          resolve();
        });
        probe.once('error', reject);
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spawnMaster detached ownership', () => {
  it('resolves only on clean launcher exit AND socket presence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-own-'));
    const sockPath = join(dir, 'ours.sock');
    try {
      const { child } = await spawnMaster({
        binPath: '/bin/sh',
        args: ['-c', `sleep 0.1; : > ${shellQuote(sockPath)}`],
        sockPath,
        generation: 1,
        readyTimeoutMs: 3000,
        detached: true
      });
      expect(child).toBeDefined();
      expect(existsSync(sockPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a pre-existing socket before launching anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-own-'));
    const sockPath = join(dir, 'foreign.sock');
    const { writeFileSync: wf } = await import('node:fs');
    wf(sockPath, '');
    try {
      await expect(
        spawnMaster({ binPath: '/bin/true', args: [], sockPath, generation: 1, readyTimeoutMs: 500, detached: true })
      ).rejects.toThrow(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('malformed master frames (protocol robustness)', () => {
  it('a garbage ATTACH_ACK fails the attach without crashing the daemon process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-garbage-'));
    const sockPath = join(dir, 'shell.sock');
    // header claims ATTACH_ACK but the payload is 2 bytes — decode throws WireError
    const garbage = encodeFrame({ type: FrameType.ATTACH_ACK, flags: 0, generation: 1, sequence: 0n, aux: 0n, payload: new Uint8Array([1, 2]) });
    const server = await new Promise<Server>((resolve, reject) => {
      const srv = createServer((socket) => {
        socket.once('data', () => socket.write(garbage));
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
        killSpec: { binPath: '/usr/bin/true', args: [] },
        ackTimeoutMs: 1500
      });
      expect(result).toEqual({ ok: false, reason: 'attach-failed' }); // failed closed, process alive
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reconcile liveness (wedged sockets must not stall startup)', () => {
  it('several silent sockets and one healthy master reconcile inside ~one timeout window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-liveness-'));
    const healthySock = join(dir, 'healthy.sock');
    const healthyServer = await listenAsMaster(healthySock, 1);
    const silentServers: Server[] = [];
    const targets = [{ sessionId: 'healthy', sockPath: healthySock, subject: { kind: 'terminal' } as const }];
    for (let i = 0; i < 3; i += 1) {
      const sock = join(dir, `silent-${i}.sock`);
      silentServers.push(
        await new Promise<Server>((resolve, reject) => {
          const srv = createServer(() => {
            /* connected but never ACKs */
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
      for (const t of targets) ledger.allocate(t.sessionId); // all at generation 1
      const { manager } = makeManager(store);
      const daemon = { router: { sessions: manager } } as never;
      const started = Date.now();
      const results = await reconcileExistingSessions(daemon, targets, '/usr/bin/true', { rows: 24, cols: 80 }, { ackTimeoutMs: 500 });
      const wall = Date.now() - started;
      expect(results.find((r) => r.sessionId === 'healthy')?.ok).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        expect(results.find((r) => r.sessionId === `silent-${i}`)?.ok).toBe(false);
      }
      expect(wall).toBeLessThan(2500); // concurrent: ~one ACK window, not one per wedged socket
    } finally {
      healthyServer.close();
      for (const srv of silentServers) srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retire vs in-flight provision (sequencing)', () => {
  it('a control retire orders behind the provision and yields one deterministic retired end state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-race2-'));
    const sockPath = join(dir, 'shell.sock');
    const genFile = join(dir, 'gen.txt');
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-atch.mjs');
    const savedDelay = process.env.FAKE_ATCH_ACK_DELAY_MS;
    process.env.FAKE_ATCH_ACK_DELAY_MS = '300';
    try {
      const { manager } = makeManager();
      const provision = manager.spawnAndAttach('shell', {
        binPath: process.execPath,
        args: [fixture, sockPath, genFile],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 4000
      });
      await new Promise((r) => setTimeout(r, 50)); // provision in flight, ACK pending
      const retire = manager.retireAwaited('shell', { timeoutMs: 4000 });
      const [provisioned, retired] = await Promise.all([provision, retire]);
      expect(provisioned.ok).toBe(true); // the provision settled deterministically first
      expect(retired.ok).toBe(true); // then the retire tore it down
      expect(manager.state('shell')).toMatchObject({ lifecycle: 'exited' });
    } finally {
      if (savedDelay === undefined) delete process.env.FAKE_ATCH_ACK_DELAY_MS;
      else process.env.FAKE_ATCH_ACK_DELAY_MS = savedDelay;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a SYNC retire mid-provision makes the ACK continuation stand down (no client against a retired core)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-race2-'));
    const sockPath = join(dir, 'shell.sock');
    const genFile = join(dir, 'gen.txt');
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-atch.mjs');
    const savedDelay = process.env.FAKE_ATCH_ACK_DELAY_MS;
    process.env.FAKE_ATCH_ACK_DELAY_MS = '300';
    try {
      const { manager } = makeManager();
      const provision = manager.spawnAndAttach('shell', {
        binPath: process.execPath,
        args: [fixture, sockPath, genFile],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 4000
      });
      await waitFor(() => existsSync(sockPath)); // master up, ACK still pending
      manager.retire('shell'); // internal teardown (socket-close semantics)
      const provisioned = await provision;
      expect(provisioned.ok).toBe(false); // never success against a retired core
      expect(manager.state('shell')).toMatchObject({ lifecycle: 'exited' });
    } finally {
      if (savedDelay === undefined) delete process.env.FAKE_ATCH_ACK_DELAY_MS;
      else process.env.FAKE_ATCH_ACK_DELAY_MS = savedDelay;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the daemon resolves its atch binary instead of trusting the variable', () => {
  it('refuses a DESK_ATCH_BIN that is not an executable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-atchbin-'));
    const notExecutable = join(dir, 'atch');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });

    expect(() => resolveDaemonConfig({ DESK_ATCH_BIN: notExecutable } as NodeJS.ProcessEnv)).toThrow(
      /not an executable file/
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('never yields the bare name "atch" for the daemon to exec', () => {
    // Reading the variable raw used to fall back to "atch", which hands the
    // exec to whatever PATH resolves first and defers the failure to the first
    // provision. Whatever the environment, the daemon must get an absolute path.
    const resolved = resolveDaemonConfig({} as NodeJS.ProcessEnv).atchBinPath;
    expect(resolved).not.toBe('atch');
    expect(isAbsolute(resolved)).toBe(true);
  });

  it('accepts an executable override and passes it through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-atchbin-'));
    const executable = join(dir, 'atch');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(resolveDaemonConfig({ DESK_ATCH_BIN: executable } as NodeJS.ProcessEnv).atchBinPath).toBe(executable);
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
      atchBinPath: '/usr/bin/true',
      atchSocketRoot: join(base, 'atch'),
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

describe('failed owned teardown keeps the kill record (retriable)', () => {
  it('an attach failure with a failing kill leaves the record for a later control retire to retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-strand-'));
    const sockPath = join(dir, 'shell.sock');
    const attempts = join(dir, 'kill-attempts');
    // The master ACKs the WRONG generation → attach fails after a real spawn…
    const server = await listenAsMaster(sockPath, 99);
    try {
      const store = new InMemoryGenerationLedger();
      new GenerationLedger(store).allocate('shell');
      const { manager } = makeManager(store);
      // restore path: expectGeneration=1 vs ACK 99 → attach-failed; restore
      // rollback never kills (not ours to kill), so use the RETRY property on
      // the spawn path instead: a kill that records each attempt and FAILS.
      const failingKill = { binPath: '/bin/sh', args: ['-c', `date +%s%N >> ${shellQuote(attempts)}; exit 1`] };
      const restored = await manager.restoreAndAttach('shell', {
        sockPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: failingKill,
        ackTimeoutMs: 1500
      });
      expect(restored).toEqual({ ok: false, reason: 'attach-failed' });
      // A restore rollback deliberately does NOT kill (foreign-master safety),
      // and it clears its own record — retire finds nothing to kill:
      expect(await manager.retireAwaited('shell')).toEqual({ ok: true });
      expect(existsSync(attempts)).toBe(false);

      // Now the SPAWN-owned case: an owned master whose kill FAILS FIRST and
      // SUCCEEDS SECOND — the record must survive the failure and the retry
      // must execute the SAME retained record to confirmed completion.
      const store2 = new InMemoryGenerationLedger();
      new GenerationLedger(store2).allocate('owned');
      const { manager: manager2 } = makeManager(store2);
      const sock2 = join(dir, 'owned.sock');
      const flag = join(dir, 'second-attempt.flag');
      const server2 = await listenAsMaster(sock2, 1);
      const flakyKill = {
        binPath: '/bin/sh',
        args: [
          '-c',
          `date +%s%N >> ${shellQuote(attempts)}; if [ -f ${shellQuote(flag)} ]; then rm -f ${shellQuote(sock2)}; exit 0; else : > ${shellQuote(flag)}; exit 1; fi`
        ]
      };
      try {
        expect(
          (
            await manager2.restoreAndAttach('owned', {
              sockPath: sock2,
              geometry: { rows: 24, cols: 80 },
              killSpec: flakyKill
            })
          ).ok
        ).toBe(true);
        // 1st retire: kill exits 1 → non-ok, record RETAINED
        const first = await manager2.retireAwaited('owned');
        expect(first.ok).toBe(false);
        expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(1);
        // 2nd retire: the SAME record runs again, kill succeeds + socket gone
        const second = await manager2.retireAwaited('owned', { timeoutMs: 4000 });
        expect(second).toEqual({ ok: true });
        expect(existsSync(sock2)).toBe(false);
        expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(2);
        // 3rd retire: idempotent — record consumed, nothing runs
        expect(await manager2.retireAwaited('owned')).toEqual({ ok: true });
        expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(2);
      } finally {
        server2.close();
      }
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an uncertain record is never dropped by the socket-absent shortcut: retire stays non-ok until the LATE master surfaces and is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-lateuncertain-'));
    const sockPath = join(dir, 'late.sock');
    const attempts = join(dir, 'attempts');
    const staleCleanupAttempts = join(dir, 'stale-cleanup-attempts');
    try {
      const { manager } = makeManager();
      // Kill semantics like real atch kill -f: succeeds (and removes the
      // socket) only when the socket exists; exits 1 otherwise.
      const atchLikeKill = {
        binPath: '/bin/sh',
        args: [
          '-c',
          `date +%s%N >> ${shellQuote(attempts)}; if [ -e ${shellQuote(sockPath)} ]; then rm -f ${shellQuote(sockPath)}; exit 0; else exit 1; fi`
        ],
        staleCleanupSpec: {
          binPath: '/bin/sh',
          args: ['-c', `date +%s%N >> ${shellQuote(staleCleanupAttempts)}; rm -f ${shellQuote(sockPath)}`]
        }
      };
      // ownership-possible spawn timeout: clean launcher exit, no socket yet →
      // the first cleanup kill runs and FAILS (socket absent), record retained.
      const result = await manager.spawnAndAttach('late', {
        binPath: '/bin/sh',
        args: ['-c', 'exit 0'],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 300,
        detached: true,
        killSpec: atchLikeKill
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(1);

      // THE MUTANT: control retire while the socket is STILL ABSENT must stay
      // non-ok with the record retained — the old socket-absent shortcut read
      // this as clean, deleted the record, and stranded the late master.
      const early = await manager.retireAwaited('late', { timeoutMs: 2000 });
      expect(early.ok).toBe(false);
      expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(2); // the kill RAN (and failed)
      expect(existsSync(staleCleanupAttempts)).toBe(false); // uncertain ownership forbids stale cleanup

      // the half-forked master finally surfaces its socket…
      const { writeFileSync: wf } = await import('node:fs');
      wf(sockPath, '');
      // …and the retained record kills it to confirmed completion.
      const late = await manager.retireAwaited('late', { timeoutMs: 4000 });
      expect(late).toEqual({ ok: true });
      expect(existsSync(sockPath)).toBe(false);
      expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(3);
      // consumed: a further retire is idempotent, no fourth kill run
      expect(await manager.retireAwaited('late')).toEqual({ ok: true });
      expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(3);
      expect(existsSync(staleCleanupAttempts)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ownership-possible spawn timeout registers the kill record; a later control retire retries it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-strand2-'));
    const sockPath = join(dir, 'late.sock');
    const attempts = join(dir, 'attempts');
    const flag = join(dir, 'flag');
    try {
      const { manager } = makeManager();
      // clean-exit launcher, socket never appears in time → ownership-possible
      // spawn failure; the FIRST cleanup kill fails → record must be registered
      // and retained.
      const flakyKill = {
        binPath: '/bin/sh',
        args: [
          '-c',
          `date +%s%N >> ${shellQuote(attempts)}; if [ -f ${shellQuote(flag)} ]; then rm -f ${shellQuote(sockPath)}; exit 0; else : > ${shellQuote(flag)}; exit 1; fi`
        ]
      };
      const result = await manager.spawnAndAttach('late', {
        binPath: '/bin/sh',
        args: ['-c', 'exit 0'],
        sockPath,
        geometry: { rows: 24, cols: 80 },
        readyTimeoutMs: 300,
        detached: true,
        killSpec: flakyKill
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
      expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(1); // first (failed) attempt ran
      // the half-started master creates its socket LATE:
      const { writeFileSync: wf } = await import('node:fs');
      wf(sockPath, '');
      // the retained record lets a control retire finish the job
      const retired = await manager.retireAwaited('late', { timeoutMs: 4000 });
      expect(retired).toEqual({ ok: true });
      expect(existsSync(sockPath)).toBe(false);
      expect(readFileSync(attempts, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
          atchBinPath: '/usr/bin/true',
          atchSocketRoot: join(base, 'atch'),
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
          DESK_ATCH_SOCKET_ROOT: join(base, 'atch'),
          DESK_ATCH_BIN: '/usr/bin/true',
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
    const reconcileAtchEvents = vi.fn();
    const daemon = {
      router: { sessions: { restoreAndAttach } },
      reconcileAtchEvents
    } as never;
    const results = await reconcileExistingSessions(
      daemon,
      [
        {
          sessionId: 'a',
          sockPath: '/r/a.sock',
          subject: {
            kind: 'agent',
            provider: 'codex',
            mode: 'terminal',
            producer: 'codex-hooks'
          }
        },
        { sessionId: 'b', sockPath: '/r/b.sock', subject: { kind: 'terminal' } },
        { sessionId: 'c', sockPath: '/r/c.sock', subject: { kind: 'terminal' } }
      ],
      '/opt/atch'
    );
    expect(results).toEqual([
      { sessionId: 'a', ok: true },
      { sessionId: 'b', ok: false, error: 'no-generation' },
      { sessionId: 'c', ok: false, error: 'socket exploded' }
    ]);
    expect(reconcileAtchEvents).toHaveBeenCalledTimes(1);
    expect(reconcileAtchEvents).toHaveBeenCalledWith('a', 1);
    // Teardown uses the resolved atch binary for both live kill and safe stale cleanup.
    expect(restoreAndAttach.mock.calls[0][1].killSpec).toEqual({
      binPath: '/opt/atch',
      args: ['kill', '-f', '/r/a.sock'],
      staleCleanupSpec: { binPath: '/opt/atch', args: ['rm', '/r/a.sock'] }
    });
    expect(restoreAndAttach.mock.calls[0][1].subject).toEqual({
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks'
    });
  });
});
