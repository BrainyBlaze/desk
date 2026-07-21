// BINARY PATH END-TO-END (spec §7.4) — the real browser client protocol through
// the real socket against the real atch binary. Exercises the ACTUAL
// BinaryTerminalBrokerClient (a node `ws` socket adapted to its transport) over
// installTerminalWsBridge → TerminalWsRouter → daemon → the real @xterm/headless
// emulator → a real atch master. Proves a binary INPUT reaches the real shell
// and its echo returns as binary OUTPUT frames the client applies through its
// resync FSM. Opt-in (RUN_REAL_JOIN=1) like the other real-binary tests.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/index.js';
import { XtermEmulatorFactory } from '../src/server/runtime/xtermEmulator.js';
import { TerminalWsRouter } from '../src/server/runtime/terminalWsRouter.js';
import { installTerminalWsBridge } from '../src/server/terminalWsBridge.js';
import { BinaryTerminalBrokerClient, type BinaryBrokerSocket } from '../src/web/binaryTerminalBrokerClient.js';

const ATCH_BIN = process.env.ATCH_BIN ?? '/home/dev/.config/superpowers/worktrees/atch/phase-a-implementation/atch';
const AVAILABLE = existsSync(ATCH_BIN) && process.env.RUN_REAL_JOIN === '1';
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
const SOCK_DIR = `/tmp/.atch-${UID}`;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, stepMs = 30): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(stepMs);
  }
  return pred();
}
function killSession(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const k = spawn(ATCH_BIN, ['kill', '-f', name], { stdio: 'ignore' });
      k.once('exit', () => {
        rmSync(join(SOCK_DIR, name), { force: true });
        resolve();
      });
      k.once('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

describe.skipIf(!AVAILABLE)('BINARY end-to-end — real client ↔ bridge ↔ daemon ↔ real atch (§7.4)', () => {
  const sessions: string[] = [];
  let server: Server | undefined;
  let dispose: (() => void) | undefined;
  afterEach(async () => {
    dispose?.();
    dispose = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await Promise.all(sessions.splice(0).map(killSession));
    await wait(150);
  });

  it('a binary INPUT reaches the real shell and its echo returns as OUTPUT the client applies', { timeout: 30000 }, async () => {
    const name = `deskbin${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    sessions.push(name);
    const sockPath = join(SOCK_DIR, name);

    const router = new TerminalWsRouter({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: new XtermEmulatorFactory(), // the REAL headless emulator
      now: () => Date.now()
    });
    // Provision the daemon session: spawn a real atch master running `cat`, attach.
    const ens = await router.sessions.spawnAndAttach(name, {
      binPath: ATCH_BIN,
      args: ['start', name, 'cat'],
      sockPath,
      geometry: { rows: 24, cols: 80 },
      detached: true,
      killSpec: { binPath: ATCH_BIN, args: ['kill', '-f', name] },
      readyTimeoutMs: 6000
    });
    expect(ens.ok).toBe(true);

    server = createServer();
    dispose = installTerminalWsBridge(server, router);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // The ACTUAL browser client, driven over a real node ws socket.
    const client = new BinaryTerminalBrokerClient(
      (url) => new WebSocket(url) as unknown as BinaryBrokerSocket,
      `ws://127.0.0.1:${port}/ws/terminal`
    );
    const output: number[] = [];
    let lastSnapshot = '';
    let gotSnapshot = false;
    client.subscribe('surface-1', name, 24, 80, true, {
      onOutput: (bytes) => output.push(...bytes),
      onSnapshot: (text) => {
        lastSnapshot = text;
        gotSnapshot = true;
      },
      onExit: () => {},
      onError: () => {},
      onConnectionChange: () => {}
    });

    try {
      // Connection + ACK + baseline snapshot must land before input has a channel.
      expect(await until(() => gotSnapshot, 6000), 'baseline snapshot').toBe(true);
      await wait(150);
      client.sendInput('surface-1', 'via-bridge\n');
      // The echoed text arrives either as an applied OUTPUT delta or, if a resync
      // re-baselined, inside a fresh snapshot — either proves the round-trip.
      const seen = () => {
        const asOutput = new TextDecoder().decode(Uint8Array.from(output));
        return asOutput.includes('via-bridge') || lastSnapshot.includes('via-bridge');
      };
      expect(await until(seen, 6000), `output=${JSON.stringify(new TextDecoder().decode(Uint8Array.from(output)))} snap=${JSON.stringify(lastSnapshot)}`).toBe(true);
    } finally {
      client.unsubscribe('surface-1'); // teardown clears the client's timers + socket
      router.sessions.retire(name);
    }
  });
});
