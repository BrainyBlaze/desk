// NATIVE moor E2E (the authorized real-binary gate): the REAL Rust holder
// bundled by Desk from its provenance-pinned vendor snapshot and driven through the REAL
// Desk stack — daemon provision with full OB-39 descriptor authority, restart
// re-adoption + reconcile, §9 wire terminate, §7.4 lease release, §10.2.13
// log clear, and the binary's root/alias fences. Skips cleanly when the
// binary is absent (override with DESK_MOOR_NATIVE_BIN).

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalDaemon } from '../src/server/runtime/terminalDaemon.js';
import {
  moorEventStoreDir,
  moorEventStoreRoot
} from '../src/server/runtime/moorEventObserver.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NATIVE_BIN = process.env.DESK_MOOR_NATIVE_BIN ?? join(ROOT, 'libexec', 'moor');
const HAVE_BINARY = existsSync(NATIVE_BIN);

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

describe.skipIf(!HAVE_BINARY)('NATIVE moor E2E (real binary, real Desk stack)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  let priorTmpdir: string | undefined;
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  });

  function pinTmpdir(root: string): void {
    priorTmpdir = process.env.TMPDIR;
    // The daemon inherits its env into the spawn, and the derivation reads
    // the SAME variable — both sides agree on temp_dir()=root.
    process.env.TMPDIR = root;
  }

  it(
    'daemon provision joins the real holder with full OB-39 descriptor authority and retires over the wire',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-native-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      pinTmpdir(root);
      mkdirSync(join(root, '_engine'), { recursive: true });
      const daemon = createTerminalDaemon({
        homeRoot: root,
        moorBinPath: NATIVE_BIN,
        moorSocketRoot: root,
        httpServer: new FakeUpgradeServer()
      });
      cleanups.push(() => daemon.dispose());

      const result = await daemon.provision('native-1', {
        command: ['sh', '-c', 'printf native-e2e-output; cat'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      });
      expect(result).toMatchObject({ ok: true, generation: 2 });
      const sessionPath = join(root, 'native-1');
      // LIFO: this kill runs BEFORE the root removal above, so a mid-test
      // failure can never leak a live detached real holder past the run.
      cleanups.push(async () => {
        await daemon.retire('native-1').catch(() => undefined);
      });
      expect(existsSync(sessionPath)).toBe(true);
      // The REAL ATTACH_ACK carried layout 2 + the handed-off directory —
      // provision's byte-exact OB-39 check passed and the observer is live on
      // the real 4-slot committed store.
      const storeDir = moorEventStoreDir(moorEventStoreRoot(NATIVE_BIN), 'native-1', 2);
      expect(existsSync(join(storeDir, 'commit.0'))).toBe(true);

      // Real output replay reaches the daemon's authoritative emulator.
      const subscribed = daemon.router.sessions.subscribe('native-1', 'main', 24, 80);
      expect(subscribed).toBeDefined();
      await waitFor(
        () => (daemon.tail('native-1', 24)?.lines ?? []).join('\n').includes('native-e2e-output'),
        'real replayed output through the native join'
      );

      // Real input round-trip over the one-in-flight link (§7.2 receipts).
      expect(daemon.input('native-1', new TextEncoder().encode('printf marker-back\n'))).toBe(
        true
      );
      await waitFor(
        () => (daemon.tail('native-1', 24)?.lines ?? []).join('\n').includes('marker-back'),
        'input echoed through the real pty'
      );

      // Retire: §9 wire terminate first — the holder unlinks its own
      // rendezvous — then the CLI confirm observes it already gone.
      const retired = await daemon.retire('native-1');
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    30_000
  );

  it(
    'restart re-adoption: a surviving real holder is re-adopted at the durable generation and reconciled under OB-39',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-native-restart-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      pinTmpdir(root);
      mkdirSync(join(root, '_engine'), { recursive: true });
      const makeDaemon = () =>
        createTerminalDaemon({
          homeRoot: root,
          moorBinPath: NATIVE_BIN,
          moorSocketRoot: root,
          httpServer: new FakeUpgradeServer()
        });

      // Incarnation 1: provision against the real binary, then ABRUPT dispose
      // (the daemon dies; the real holder survives detached).
      const first = makeDaemon();
      const provisioned = await first.provision('native-r', {
        command: ['sh', '-c', 'printf survived-native; cat'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      });
      expect(provisioned).toMatchObject({ ok: true, generation: 2 });
      const sessionPath = join(root, 'native-r');
      // LIFO leak guard: whatever fails below, the real holder is killed
      // before the temp root disappears.
      cleanups.push(async () => {
        const kill = (await import('node:child_process')).spawn(
          NATIVE_BIN,
          ['kill', '-f', sessionPath],
          { stdio: 'ignore' }
        );
        await new Promise((resolve) => {
          kill.once('error', () => resolve(undefined));
          kill.once('exit', () => resolve(undefined));
        });
      });
      // A REAL daemon death severs its sockets because the process exits;
      // inside one test process dispose() alone leaves the first client's
      // connection (and its lease keepalive) alive, which would keep the
      // lease owned forever. Sever the links explicitly — the in-process
      // equivalent of the process dying — then dispose.
      first.router.sessions.closeAllLinks();
      first.dispose();
      expect(existsSync(sessionPath)).toBe(true); // the holder outlived the daemon

      // §7.5 REAL semantics an abrupt death exposes: the holder RESERVES the
      // lost lease for the 10 s responsiveness deadline (this daemon kept no
      // resume token across processes by design), so an immediate re-attach
      // would be granted only OBSERVER scope. Wait out the reservation so the
      // fresh attach below gets the input lease — this is the honest restart
      // timeline, not a test convenience.
      await new Promise((resolve) => setTimeout(resolve, 10_500));

      // Incarnation 2: restore at the durable ledger generation over the REAL
      // wire, then reconcile — the re-adopted REAL ATTACH_ACK descriptor is
      // the OB-39 authority for the restart observer.
      const second = makeDaemon();
      cleanups.push(() => second.dispose());
      const restored = await second.router.sessions.restoreAndAttachMoor('native-r', {
        sessionPath,
        geometry: { rows: 24, cols: 80 },
        killSpec: { binPath: NATIVE_BIN, args: ['kill', '-f', sessionPath] }
      });
      expect(restored).toMatchObject({ ok: true, generation: 2 });
      if (!restored.ok) return;
      expect(restored.moorStatus?.layout).toBe(2);
      await expect(second.reconcileMoorEvents('native-r', 2)).resolves.toBe(true);

      // The re-adopted link is FUNCTIONAL: input round-trips.
      expect(second.input('native-r', new TextEncoder().encode('printf back-again\n'))).toBe(
        true
      );
      await waitFor(
        () => (second.tail('native-r', 24)?.lines ?? []).join('\n').includes('back-again'),
        'input echoed through the re-adopted real link'
      );

      // §7.4 graceful release against the real holder, then §10.2.13 log
      // clear at the observed frontier, then wire-terminate retire.
      const handover = await second.router.sessions.releaseAllLeases();
      expect(handover).toEqual([{ sessionId: 'native-r', outcome: 'released' }]);
      const retired = await second.retire('native-r');
      expect(retired.ok).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    45_000
  );

  it(
    'log clear resolves against the real holder with the full algebra',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-native-log-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      pinTmpdir(root);
      mkdirSync(join(root, '_engine'), { recursive: true });
      const daemon = createTerminalDaemon({
        homeRoot: root,
        moorBinPath: NATIVE_BIN,
        moorSocketRoot: root,
        httpServer: new FakeUpgradeServer()
      });
      cleanups.push(() => daemon.dispose());
      const provisioned = await daemon.provision('native-l', {
        command: ['sh', '-c', 'echo some-log-content; cat'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      });
      expect(provisioned).toMatchObject({ ok: true });
      cleanups.push(async () => {
        await daemon.retire('native-l').catch(() => undefined);
      });

      const outcome = await daemon.clearSessionLog('native-l');
      expect(['cleared', 'already-clear']).toContain(outcome);
    },
    30_000
  );

  it(
    "the real binary's fences hold: outside-root and session-alias stores fail the launch closed",
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-native-fence-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      pinTmpdir(root);
      const outside = mkdtempSync(join(tmpdir(), 'moor-native-outside-'));
      cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
      const manager = new SessionManager({
        ledger: new GenerationLedger(new InMemoryGenerationLedger()),
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
        emulatorFactory: { create: () => new ByteSinkEmu() },
        now: () => Date.now(),
        sendBrowser: () => {}
      });

      const spawnWithStore = (sessionId: string, storeDir: string) =>
        manager.spawnAndAttachMoor(sessionId, {
          binPath: NATIVE_BIN,
          sessionPath: join(root, sessionId),
          command: ['sleep', '5'],
          geometry: { rows: 24, cols: 80 },
          env: { ...process.env, TMPDIR: root },
          killSpec: { binPath: NATIVE_BIN, args: ['kill', '-f', join(root, sessionId)] },
          prepareSpawn: () => ({ storeDir })
        });

      // outside-root: a store outside temp_dir()/.moor-{euid} is rejected by
      // the REAL binary before anything is published.
      const outsideResult = await spawnWithStore('fence-a', join(outside, 'events'));
      expect(outsideResult).toMatchObject({ ok: false, reason: 'spawn-failed' });
      expect(existsSync(join(root, 'fence-a'))).toBe(false);

      // alias fence: a store aliasing the session marker itself is rejected.
      const aliasResult = await spawnWithStore('fence-b', join(root, 'fence-b'));
      expect(aliasResult).toMatchObject({ ok: false, reason: 'spawn-failed' });
      expect(existsSync(join(root, 'fence-b'))).toBe(false);
    },
    30_000
  );
});
