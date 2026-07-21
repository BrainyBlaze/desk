// Terminal daemon assembly (cutover Phase 2 Step 3). Proves the durable daemon
// wires together and mounts/unmounts its ws bridge without any live atch or boot.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createTerminalDaemon, startTerminalDaemonServer } from '../src/server/runtime/terminalDaemon.js';

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
});
