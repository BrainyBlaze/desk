// #2b-1 join witness: the REAL production modules chained end to end against a
// REAL child-process holder speaking the frozen MOOR wire over a REAL unix
// socket — spawnMoorMaster (fd-3 launch record, readiness = launcher exit 0),
// MoorMasterClient (supervised §6 attach prefix), MoorEventObserver (committed
// -T store), and the moor-shaped kill/rm teardown. This is the orchestration
// contract sessionManager/terminalDaemon adopt in the seam rewire.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { MoorMasterClient } from '../src/server/runtime/moorMasterClient.js';
import { MoorEventObserver, moorEventStoreRoot, type MoorSessionEvent } from '../src/server/runtime/moorEventObserver.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
// node --import tsx keeps the loader IN-PROCESS: the tsx CLI shim re-spawns
// node and loses inherited fds, which would sever the fd-3 launch channel.
const NODE_ARGS = ['--import', 'tsx', FAKE];
const GENERATION = 7;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

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

function awaitExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

describe('moor join path (real modules, real fake-holder process)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    // LIFO and AWAITED: the fallback kill must fully complete (pidfile read,
    // holder reaped) BEFORE the temp root is deleted, or the detached holder
    // leaks past the test run.
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it(
    'spawns supervised, attaches, streams output, round-trips input, observes the store, and kills',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-join-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const sessionPath = join(root, 'session');
      const leaseBusyFile = join(root, 'lease-busy');
      // The holder fences -T inside temp_dir()/.{invoked}-{euid}; the spawn
      // TMPDIR points at the per-test root so the store dies with it.
      const storeDir = join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 'events');

      // ---- spawn: fd-3 launch record; readiness = launcher exit 0 ----------
      const { child: launcher } = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', '-T', storeDir, sessionPath, 'sh', '-c', 'printf hello; cat'],
        generation: GENERATION,
        env: {
          ...process.env,
          TMPDIR: root,
          FAKE_MOOR_VIEWER_LEASE_BUSY_FILE: leaseBusyFile
        }
      });
      expect(await awaitExit(launcher)).toBe(0);
      expect(existsSync(sessionPath)).toBe(true);
      cleanups.push(async () => {
        const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
        await awaitExit(kill).catch(() => undefined); // idempotent: exit 1 when already gone
      });

      // ---- attach: supervised §6 prefix through the frozen client ----------
      const outputs: string[] = [];
      const receipts: Array<{ requestId: bigint; written: bigint }> = [];
      let closed = false;
      const client = new MoorMasterClient(sessionPath, GENERATION, {
        onOutput: (output) => outputs.push(new TextDecoder().decode(output.bytes)),
        onInputReceipt: (receipt) =>
          receipts.push({ requestId: receipt.requestId, written: receipt.written }),
        onClose: () => {
          closed = true;
        }
      });
      cleanups.push(() => client.close());
      await client.connect();
      const status = await client.attach({ columns: 80, rows: 24, requestLease: true });
      expect(status.generation).toBe(GENERATION);
      expect(status.ownsLease).toBe(true);
      expect(status.columns).toBe(80);
      expect(status.rows).toBe(24);
      expect(client.verifiedLive).toBe(true);

      // A second fresh viewer may request its preferred size, but a busy
      // lease makes it an observer: the ACK must retain the owner's geometry.
      writeFileSync(leaseBusyFile, 'busy');
      const observer = new MoorMasterClient(sessionPath, GENERATION);
      cleanups.push(() => observer.close());
      await observer.connect();
      const observerStatus = await observer.attach({
        columns: 100,
        rows: 30,
        requestLease: true
      });
      expect(observerStatus).toMatchObject({ ownsLease: false, columns: 80, rows: 24 });

      // ---- output + input round trip ---------------------------------------
      await waitFor(() => outputs.join('').includes('hello'), 'initial child output');
      client.sendInput(text('world\n'));
      await waitFor(() => receipts.length === 1, 'input receipt');
      expect(receipts[0]).toEqual({ requestId: 1n, written: 6n });
      await waitFor(() => outputs.join('').includes('world'), 'echoed input');

      // ---- committed event store through the real observer -----------------
      const events: MoorSessionEvent[] = [];
      const eventObserver = new MoorEventObserver({
        directory: storeDir,
        generation: GENERATION,
        pollIntervalMs: 50,
        onEvent: (event) => events.push(event),
        onDiagnostic: () => undefined
      });
      cleanups.push(() => eventObserver.stop());
      expect(await eventObserver.start()).toBe(true);
      expect(events.map((event) => event.type)).toEqual(['ready']);

      // ---- teardown: moor-shaped kill removes the published socket ---------
      const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
      expect(await awaitExit(kill)).toBe(0);
      expect(existsSync(sessionPath)).toBe(false);
      await waitFor(() => closed, 'client observed the holder close');
    },
    30_000
  );

  it('refuses to launch over an existing session and cleans stale nodes via rm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-stale-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessionPath = join(root, 'session');

    const first = spawnMoorMaster({
      binPath: process.execPath,
      args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', sessionPath, 'sleep', '30'],
      generation: GENERATION,
      env: { ...process.env, TMPDIR: root }
    });
    expect(await awaitExit(first.child)).toBe(0);
    cleanups.push(async () => {
      const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
      await awaitExit(kill).catch(() => undefined); // idempotent: exit 1 when already gone
    });

    // A second supervised launch over the live session must fail (exit != 0).
    const second = spawnMoorMaster({
      binPath: process.execPath,
      args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', sessionPath, 'sleep', '30'],
      generation: GENERATION,
      env: { ...process.env, TMPDIR: root }
    });
    expect(await awaitExit(second.child)).not.toBe(0);

    // Kill, then rm is idempotent over the already-removed node.
    const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
    expect(await awaitExit(kill)).toBe(0);
    const rm = spawn(process.execPath, [...NODE_ARGS, 'rm', sessionPath], { stdio: 'ignore' });
    expect(await awaitExit(rm)).toBe(0);
    expect(existsSync(sessionPath)).toBe(false);
  }, 30_000);
});
