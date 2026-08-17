// NATIVE moor E2E (the authorized real-binary gate): the REAL Rust holder
// bundled by Desk from its provenance-pinned vendor snapshot and driven through the REAL
// Desk stack — daemon provision with full OB-39 descriptor authority, restart
// re-adoption + reconcile, §9 wire terminate, §7.4 lease release, §10.2.13
// log clear, and the binary's root/alias fences. Developer runs may skip when
// the binary is absent; required native lanes fail before collecting tests.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalDaemon } from '../src/server/runtime/terminalDaemon.js';
import { archiveMoorGenerationStores } from '../src/server/runtime/moorGenerationStores.js';
import {
  moorEventStoreDir,
  moorEventStoreRoot
} from '../src/server/runtime/moorEventObserver.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import {
  MoorStoreKind,
  readMoorStoreSnapshot
} from '../src/server/runtime/moorStore.js';
import {
  MoorCodec,
  crc32c,
  encodeMoorDiscoveryHello
} from '../src/shared/moorWire/index.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NATIVE_BIN = process.env.DESK_MOOR_NATIVE_BIN ?? join(ROOT, 'libexec', 'moor');
const HAVE_BINARY = existsSync(NATIVE_BIN);

if (process.env.RUN_REAL_JOIN === '1' && !HAVE_BINARY) {
  throw new Error(`RUN_REAL_JOIN=1 requires an executable Moor binary at ${NATIVE_BIN}`);
}

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

const STORE_SLOTS = ['body.0', 'body.1', 'commit.0', 'commit.1'] as const;

function compileInstrument(root: string): string {
  const source = join(root, 'instrument.c');
  const object = join(root, 'instrument.so');
  writeFileSync(
    source,
    `#include <stdint.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\n\nstatic unsigned char nibble(char value) {\n  if (value >= '0' && value <= '9') return (unsigned char)(value - '0');\n  if (value >= 'a' && value <= 'f') return (unsigned char)(value - 'a' + 10);\n  return 255;\n}\n\n__attribute__((constructor)) static void acknowledge(void) {\n  char *channel = getenv("MOOR_INSTRUMENT_CHANNEL");\n  char *nonce = getenv("MOOR_INSTRUMENT_NONCE");\n  char *generation = getenv("MOOR_SESSION_GENERATION");\n  if (!channel || !nonce || !generation || strlen(nonce) != 32) return;\n  int fd = (int)strtol(channel, 0, 10);\n  uint32_t gen = (uint32_t)strtoul(generation, 0, 10);\n  uint32_t pid = (uint32_t)getpid();\n  unsigned char record[36] = {0};\n  memcpy(record, "MOORINS3", 8);\n  record[8] = 1;\n  for (int at = 0; at < 4; ++at) {\n    record[12 + at] = (unsigned char)(gen >> (at * 8));\n    record[16 + at] = (unsigned char)(pid >> (at * 8));\n  }\n  for (int at = 0; at < 16; ++at) {\n    unsigned char high = nibble(nonce[at * 2]);\n    unsigned char low = nibble(nonce[at * 2 + 1]);\n    if (high > 15 || low > 15) return;\n    record[20 + at] = (unsigned char)((high << 4) | low);\n  }\n  unsetenv("MOOR_INSTRUMENT_CHANNEL");\n  unsetenv("MOOR_INSTRUMENT_NONCE");\n  size_t offset = 0;\n  while (offset < sizeof(record)) {\n    ssize_t written = write(fd, record + offset, sizeof(record) - offset);\n    if (written <= 0) break;\n    offset += (size_t)written;\n  }\n  close(fd);\n}\n`,
    { mode: 0o600 }
  );
  const built = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-o', object, source], {
    encoding: 'utf8'
  });
  if (built.status !== 0) {
    throw new Error(`could not compile native Moor instrument: ${built.stderr}`);
  }
  return object;
}

function compileInstrumentedChild(root: string): string {
  // The instrumented predecessor is a locally compiled program, not `sh`:
  // §4.7 requires the instrument's architecture to match the initial child
  // and a loader that honours the preload variable. On macOS the system shell
  // is a SIP-protected arm64e/universal platform binary — inserting the test's
  // dylib into it aborts on Apple silicon and is not a supported shape on any
  // Mac — so the child that carries the instrument is built here, exactly like
  // Moor's own conformance suite does. It prints, lingers long enough to be
  // attached, and exits 7.
  const source = join(root, 'predecessor.c');
  const program = join(root, 'predecessor');
  writeFileSync(
    source,
    '#include <stdio.h>\n#include <unistd.h>\nint main(void) {\n  printf("predecessor-output\\n");\n  fflush(stdout);\n  sleep(1);\n  return 7;\n}\n',
    { mode: 0o600 }
  );
  const built = spawnSync('cc', ['-O2', '-o', program, source], { encoding: 'utf8' });
  if (built.status !== 0) {
    throw new Error(`could not compile the instrumented predecessor: ${built.stderr}`);
  }
  return program;
}

function decodeManifestPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('native lifecycle omitted an external path');
  return Buffer.from(value, 'base64').toString();
}

function expectIndependentCopies(stable: string, archive: string): void {
  for (const slot of STORE_SLOTS) {
    const stablePath = join(stable, slot);
    const archivePath = join(archive, slot);
    const left = lstatSync(stablePath, { bigint: true });
    const right = lstatSync(archivePath, { bigint: true });
    expect(left.nlink).toBe(1n);
    expect(right.nlink).toBe(1n);
    expect(left.dev === right.dev && left.ino === right.ino).toBe(false);
    expect(readFileSync(archivePath)).toEqual(readFileSync(stablePath));
  }
}

async function sendV3Hello(sessionPath: string): Promise<Uint8Array> {
  const frame = encodeMoorDiscoveryHello(
    new MoorCodec(),
    new TextEncoder().encode(sessionPath)
  );
  frame[4] = 3;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(
    20,
    crc32c(frame.subarray(0, 20)),
    true
  );

  return await new Promise<Uint8Array>((resolve, reject) => {
    const socket = createConnection({ path: sessionPath });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for native v3 refusal'));
    }, 5_000);
    socket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once('connect', () => socket.write(frame));
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });
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
    'refuses a CRC-valid v3 client before attach while the v4 owner remains live',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'moor-native-v3-refusal-'));
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

      const provisioned = await daemon.provision('native-v3', {
        command: ['sh', '-c', 'cat'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      });
      expect(provisioned).toMatchObject({ ok: true, generation: 2 });
      const sessionPath = join(root, 'native-v3');
      cleanups.push(async () => {
        await daemon.retire('native-v3').catch(() => undefined);
      });

      const refusal = await sendV3Hello(sessionPath);
      const messages = new MoorCodec().feed(Date.now(), refusal);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ scope: 2, kind: 0x13 });
      expect(
        new DataView(messages[0]!.payload.buffer, messages[0]!.payload.byteOffset).getUint16(
          0,
          true
        )
      ).toBe(1);

      expect(daemon.input('native-v3', new TextEncoder().encode('printf v4-still-live\n'))).toBe(
        true
      );
      await waitFor(
        () => (daemon.tail('native-v3', 24)?.lines ?? []).join('\n').includes('v4-still-live'),
        'v4 owner after v3 refusal'
      );
    },
    30_000
  );

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
        geometry: { rows: 48, cols: 100 },
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
      cleanups.push(async () => {
        await second.retire('native-r').catch(() => undefined);
      });
      const restored = await second.router.sessions.restoreAndAttachMoor('native-r', {
        sessionPath,
        killSpec: { binPath: NATIVE_BIN, args: ['kill', '-f', sessionPath] }
      });
      expect(restored).toMatchObject({ ok: true, generation: 2 });
      if (!restored.ok) return;
      expect(restored.moorStatus).toMatchObject({ layout: 2, columns: 100, rows: 48 });
      await expect(second.reconcileMoorEvents('native-r', 2)).resolves.toBe(true);

      // The re-adopted link is FUNCTIONAL: input round-trips.
      expect(second.input('native-r', new TextEncoder().encode('printf back-again\n'))).toBe(
        true
      );
      await waitFor(
        () => (second.tail('native-r', 48)?.lines ?? []).join('\n').includes('back-again'),
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
    'successor cleanup parses copied predecessor lifecycle, removes external artifacts, and preserves archives',
    async () => {
      // A short private base keeps the rendezvous <root>/<sessionId> within the
      // macOS sun_path ceiling (103 bytes). os.tmpdir() on macOS is a ~50-byte
      // /var/folders path that would push this session's longer id past the
      // ceiling and make the holder unaddressable by Desk -- the same reason
      // production uses a short /tmp socket root on Darwin. The capacity refusal
      // itself is witnessed separately, not by this fixture's length.
      const root = mkdtempSync(join('/tmp', 'mn-gc-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      pinTmpdir(root);
      mkdirSync(join(root, '_engine'), { recursive: true, mode: 0o700 });
      const instrument = compileInstrument(root);
      const daemon = createTerminalDaemon({
        homeRoot: root,
        moorBinPath: NATIVE_BIN,
        moorSocketRoot: root,
        httpServer: new FakeUpgradeServer()
      });
      cleanups.push(() => daemon.dispose());
      const sessionId = 'native-generation-copy';
      const sessionPath = join(root, sessionId);

      const predecessor = await daemon.provision(sessionId, {
        command: ['-S', instrument, compileInstrumentedChild(root)],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      });
      expect(predecessor).toMatchObject({ ok: true, generation: 2 });
      // Holder unlink and committed lifecycle bytes can precede Desk finishing
      // controller recovery. The exited state is published after that slot clears.
      await waitFor(
        () =>
          !existsSync(sessionPath) &&
          existsSync(`${sessionPath}.exit/body.0`) &&
          daemon.router.sessions.stateSnapshot(sessionId)?.lifecycle === 'exited',
        'real predecessor exit companions'
      );

      const lifecycle = await readMoorStoreSnapshot(
        `${sessionPath}.exit`,
        MoorStoreKind.Exit,
        2
      );
      const manifest = JSON.parse(new TextDecoder().decode(lifecycle.bytes)) as {
        v?: unknown;
        type?: unknown;
        ended?: unknown;
        code?: unknown;
        method?: unknown;
        event_path?: unknown;
        instrument_path?: unknown;
      };
      expect(manifest).toMatchObject({
        v: 2,
        type: 'lifecycle',
        ended: 'exited',
        code: 7,
        method: 'none'
      });
      const priorEvent = decodeManifestPath(manifest.event_path);
      const priorInstrument = decodeManifestPath(manifest.instrument_path);
      expect(existsSync(priorEvent)).toBe(true);
      expect(existsSync(priorInstrument)).toBe(true);

      await archiveMoorGenerationStores(sessionPath, 3);
      expectIndependentCopies(`${sessionPath}.exit`, `${sessionPath}.2.exit`);
      expectIndependentCopies(`${sessionPath}.log`, `${sessionPath}.2.log`);

      const successor = await daemon.provision(sessionId, {
        command: ['sh', '-c', 'printf successor-ready; cat'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      });
      expect(successor).toMatchObject({ ok: true, generation: 3 });
      cleanups.push(async () => {
        await daemon.retire(sessionId).catch(() => undefined);
      });

      expect(existsSync(priorEvent)).toBe(false);
      expect(existsSync(priorInstrument)).toBe(false);
      await expect(
        readMoorStoreSnapshot(`${sessionPath}.exit`, MoorStoreKind.Exit, 3)
      ).resolves.toBeDefined();
      await expect(
        readMoorStoreSnapshot(`${sessionPath}.2.exit`, MoorStoreKind.Exit, 2)
      ).resolves.toBeDefined();
      await expect(
        readMoorStoreSnapshot(`${sessionPath}.2.log`, MoorStoreKind.Log, 2)
      ).resolves.toBeDefined();
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
