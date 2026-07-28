// Terminal daemon assembly (cutover Phase 2 Step 3). Proves the durable daemon
// wires together and mounts/unmounts its ws bridge without any live atch or boot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createTerminalDaemon, provisionSessions, runTerminalDaemon, startTerminalDaemonServer } from '../src/server/runtime/terminalDaemon.js';
import {
  atchEventPath,
  prepareAtchEventSink
} from '../src/server/runtime/atchEvents.js';

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

class FakeUpgradeServer {
  listeners: UpgradeListener[] = [];
  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }
  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
}

describe('terminal daemon assembly (cutover Step 3)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-daemon-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('assembles a durable daemon, mounts the ws bridge, allocates from the fsync ledger, and disposes', () => {
    const server = new FakeUpgradeServer();
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/bin/false',
      atchSocketRoot: home,
      httpServer: server
    });
    // The binary WS bridge registered exactly one upgrade listener.
    expect(server.listeners).toHaveLength(1);

    // The durable generation ledger allocates a real generation on ensure.
    const ens = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
    expect(ens.ok).toBe(true);
    if (ens.ok) {
      expect(ens.generation).toBeGreaterThanOrEqual(1);
    }

    daemon.dispose();
    expect(server.listeners).toHaveLength(0); // bridge unmounted
  });

  it('starts the daemon in its OWN http server (separate-process entry) and closes cleanly', async () => {
    const d = await startTerminalDaemonServer({
      homeRoot: home,
      atchBinPath: '/bin/false',
      atchSocketRoot: home,
      host: '127.0.0.1',
      port: 0
    });
    try {
      expect(d.port).toBeGreaterThan(0); // OS-assigned port bound
      const ens = d.daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
      expect(ens.ok).toBe(true);
    } finally {
      await d.close();
    }
  });

  it('prepares a generation sink and passes -T after the atch start command', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/opt/atch',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttach').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({
          sessionId,
          generation: 7,
          args: options.args,
          env: {}
        });
        expect(prepared?.args).toEqual([
          'start',
          '-T',
          atchEventPath(home, 'sess-1', 7),
          join(home, 'sess-1.sock'),
          'bash'
        ]);
        return { ok: true, generation: 7, created: true };
      }
    );

    await expect(daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    })).resolves.toMatchObject({ ok: true, generation: 7 });

    const sink = atchEventPath(home, 'sess-1', 7);
    expect(statSync(sink).mode & 0o777).toBe(0o600);
    daemon.dispose();
    expect(existsSync(sink)).toBe(true);
  });

  it('removes only its prepared sink when spawn fails', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/opt/atch',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttach').mockImplementation(
      async (sessionId, options) => {
        await options.prepareSpawn?.({
          sessionId,
          generation: 3,
          args: options.args,
          env: {}
        });
        return { ok: false, reason: 'spawn-failed' };
      }
    );

    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    expect(existsSync(atchEventPath(home, 'sess-1', 3))).toBe(false);
    daemon.dispose();
  });

  it('preserves a sink after failed retire and removes it after confirmed retire', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/opt/atch',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttach').mockImplementation(
      async (sessionId, options) => {
        await options.prepareSpawn?.({
          sessionId,
          generation: 4,
          args: options.args,
          env: {}
        });
        return { ok: true, generation: 4, created: true };
      }
    );
    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    const sink = atchEventPath(home, 'sess-1', 4);
    const retire = vi.spyOn(daemon.router.sessions, 'retireAwaited');
    retire.mockResolvedValueOnce({ ok: false, error: 'still live' });
    await daemon.retire('sess-1');
    expect(existsSync(sink)).toBe(true);
    retire.mockResolvedValueOnce({ ok: true });
    await daemon.retire('sess-1');
    expect(existsSync(sink)).toBe(false);
    daemon.dispose();
  });

  it('replays an existing generation sink into terminal observations', () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/opt/atch',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const ensured = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('ensure failed');
    const sink = prepareAtchEventSink(home, 'sess-1', ensured.generation);
    appendFileSync(
      sink,
      `${JSON.stringify({
        ts: 1234,
        type: 'state',
        state: 'busy',
        title: 'Compiling'
      })}\n`
    );

    expect(daemon.reconcileAtchEvents('sess-1', ensured.generation)).toBe(true);
    expect(daemon.terminalObservation('sess-1')).toMatchObject({
      generation: ensured.generation,
      activity: 'working',
      activityAt: 1_234_000,
      title: 'Compiling'
    });
    daemon.dispose();
    expect(existsSync(sink)).toBe(true);
  });

  it('rejects an insecure sink during restart reconciliation', () => {
    const diagnostics: string[] = [];
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/opt/atch',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      onAtchEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.code)
    });
    const ensured = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('ensure failed');
    const sink = prepareAtchEventSink(home, 'sess-1', ensured.generation);
    chmodSync(sink, 0o644);

    expect(daemon.reconcileAtchEvents('sess-1', ensured.generation)).toBe(false);
    expect(diagnostics).toContain('tailer-io');
    daemon.dispose();
  });

  it('removes the current sink after an internal lifecycle exit', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/opt/atch',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const ensured = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('ensure failed');
    const sink = prepareAtchEventSink(home, 'sess-1', ensured.generation);
    expect(daemon.reconcileAtchEvents('sess-1', ensured.generation)).toBe(true);

    daemon.router.sessions.retire('sess-1');
    await Promise.resolve();
    expect(existsSync(sink)).toBe(false);
    daemon.dispose();
  });

  it('provisions sessions sequentially, isolating and reporting failures', async () => {
    const calls: string[] = [];
    const fakeDaemon = {
      provision: async (sessionId: string) => {
        calls.push(sessionId);
        if (sessionId === 'boom') {
          throw new Error('spawn failed');
        }
        return { ok: true as const, generation: 1, created: true };
      }
    };
    const results = await provisionSessions(fakeDaemon, [
      { sessionId: 'a', spec: { command: ['cat'], geometry: { rows: 24, cols: 80 } } },
      { sessionId: 'boom', spec: { command: ['cat'], geometry: { rows: 24, cols: 80 } } },
      { sessionId: 'b', spec: { command: ['cat'], geometry: { rows: 24, cols: 80 } } }
    ]);
    expect(calls).toEqual(['a', 'boom', 'b']); // sequential, boom did not abort the rest
    expect(results).toEqual([
      { sessionId: 'a', ok: true },
      { sessionId: 'boom', ok: false, error: 'spawn failed' },
      { sessionId: 'b', ok: true }
    ]);
  });

  it('runTerminalDaemon starts the server and returns provisioning results (no sessions ⇒ empty)', async () => {
    const running = await runTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/bin/false',
      atchSocketRoot: home,
      host: '127.0.0.1',
      port: 0,
      sessions: []
    });
    try {
      expect(running.port).toBeGreaterThan(0);
      expect(running.provisioned).toEqual([]);
    } finally {
      await running.close();
    }
  });
});
