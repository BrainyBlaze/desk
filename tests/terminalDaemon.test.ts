// Terminal daemon assembly (cutover Phase 2 Step 3). Proves the durable daemon
// wires together and mounts/unmounts its ws bridge without any live moor or boot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createTerminalDaemon, provisionSessions, runTerminalDaemon, startTerminalDaemonServer } from '../src/server/runtime/terminalDaemon.js';
import { FileDeskEventJournal } from '../src/server/runtime/fileDeskEventJournal.js';
import {
  MoorEventObserver,
  moorEventStoreDir,
  moorEventStoreRoot
} from '../src/server/runtime/moorEventObserver.js';
import { MoorStoreKind } from '../src/server/runtime/moorStore.js';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import { readProviderSessionBinding } from '../src/server/providerSessionBinding.js';

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * How many descriptors THIS process still holds on `path`, read out of the
 * kernel's own fd table. A disposal test that only asserts `close()` was
 * called proves the call, not the release — and a leaked append fd is a
 * kernel-side fact, so that is where it has to be checked.
 *
 * Portable: /dev/fd lists this process's open descriptors on both Linux (a
 * symlink to /proc/self/fd) and macOS (the fdesc filesystem). Identity is by
 * capability — fstat of each descriptor compared to the target's dev+ino —
 * rather than by resolving a /proc magic-symlink target, which does not exist
 * on macOS.
 */
function openDescriptorCount(path: string): number {
  const target = statSync(path);
  let count = 0;
  for (const entry of readdirSync('/dev/fd')) {
    const fd = Number(entry);
    if (!Number.isInteger(fd)) continue;
    try {
      const opened = fstatSync(fd);
      if (opened.dev === target.dev && opened.ino === target.ino) count += 1;
    } catch {
      // A descriptor readdir itself opened, or one already closed.
    }
  }
  return count;
}

class FakeUpgradeServer {
  listeners: UpgradeListener[] = [];
  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }
  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
}

// ---- committed moor event store fixture -------------------------------------
// Mirrors the byte rules of the real holder's four-slot committed store (the
// same rules tests/helpers/fake-moor-holder.ts enforces): body.N is canonical
// NDJSON (header + transition records), commit.N is the 92-byte MOORCMT1
// record carrying generation/epoch/index/range plus SHA-256(body) and CRC32C.

const encoder = new TextEncoder();

/** §1.2 posix identity: tag 0x01 followed by the absolute rendezvous path. */
function moorStoreIdentity(sessionPath: string): Uint8Array {
  const bytes = Buffer.from(sessionPath);
  const identity = new Uint8Array(1 + bytes.length);
  identity[0] = 1;
  identity.set(bytes, 1);
  return identity;
}

function moorStoreHeader(generation: number, next: number, identity: Uint8Array): string {
  return `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(identity).toString('base64')}","generation":${generation},"epoch":0,"next_seq":${next},"first_retained":0}\n`;
}

function moorCommitRecord(
  slot: 0 | 1,
  generation: number,
  index: bigint,
  end: bigint,
  body: Uint8Array,
  kind = MoorStoreKind.Event,
  epoch = 0,
  start = 0n
): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = slot;
  record[10] = slot;
  record[11] = kind;
  view.setUint32(12, generation, true);
  view.setUint32(16, epoch, true);
  view.setBigUint64(24, index, true);
  view.setBigUint64(32, BigInt(body.length), true);
  view.setBigUint64(40, start, true);
  view.setBigUint64(48, end, true); // end = next_seq
  record.set(createHash('sha256').update(body).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

function writeCurrentExitStore(
  sessionPath: string,
  generation: number,
  outcome:
    | { ended: 'exited'; code: number }
    | { ended: 'signalled'; signal: number },
  outputEnd = 0n,
  method: 'none' | 'graceful' | 'forced' = 'none'
): void {
  const identity = Buffer.from(moorStoreIdentity(sessionPath)).toString('base64');
  const nonce = Buffer.alloc(16).toString('base64');
  const encodedOutcome =
    outcome.ended === 'exited'
      ? `"ended":"exited","code":${outcome.code}`
      : `"ended":"signalled","signal":${outcome.signal}`;
  const body = encoder.encode(
    `{"v":2,"type":"lifecycle","phase":"exited","session":"${identity}",` +
      `"generation":${generation},"wire_generation":${generation},` +
      `"incarnation":"${nonce}","start_wall_ms":"1","start_mono_ms":"1",` +
      `"boot_id":"${nonce}","path_encoding":"posix-bytes",` +
      `"event_path":null,"instrument_path":null,"end_wall_ms":"2",` +
      `"output_end":"${outputEnd}",${encodedOutcome},"method":"${method}"}\n`
  );
  const directory = `${sessionPath}.exit`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'body.0'), body, { mode: 0o600 });
  writeFileSync(
    join(directory, 'commit.0'),
    moorCommitRecord(
      0,
      generation,
      2n,
      outputEnd,
      body,
      MoorStoreKind.Exit,
      1,
      outputEnd
    ),
    { mode: 0o600 }
  );
  writeFileSync(join(directory, 'body.1'), new Uint8Array(), { mode: 0o600 });
  writeFileSync(join(directory, 'commit.1'), new Uint8Array(), { mode: 0o600 });
}

/**
 * A REAL committed store the holder would leave behind: the canonical EMPTY
 * snapshot in slot 0 at initialization, every append re-committing the full
 * body into the alternate slot with a monotonically increasing commit index.
 */
class MoorStoreFixture {
  private readonly lines: string[] = [];
  private index = 1n;
  private slot: 0 | 1 = 0;
  private lastBodyLength = 0n;
  private lastBodyHash = new Uint8Array(32);

  frontier(): { bodySlot: 0 | 1; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array } {
    return {
      bodySlot: this.slot,
      commitIndex: this.index,
      bodyLength: this.lastBodyLength,
      bodyHash: this.lastBodyHash.slice()
    };
  }

  constructor(
    private readonly directory: string,
    private readonly generation: number,
    private readonly identity: Uint8Array
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const body = encoder.encode(moorStoreHeader(generation, 0, identity));
    writeFileSync(join(directory, 'body.0'), body, { mode: 0o600 });
    writeFileSync(join(directory, 'commit.0'), moorCommitRecord(0, generation, 1n, 0n, body), {
      mode: 0o600
    });
    writeFileSync(join(directory, 'body.1'), new Uint8Array(), { mode: 0o600 });
    writeFileSync(join(directory, 'commit.1'), new Uint8Array(), { mode: 0o600 });
    this.lastBodyLength = BigInt(body.length);
    this.lastBodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  }

  append(type: string, ts: number | string, tail = ''): void {
    const seq = this.lines.length; // sequences are consumed from 0
    this.lines.push(`{"type":"${type}","ts":${ts},"epoch":0,"seq":${seq},"kind":"transition"${tail}}\n`);
    const next = this.lines.length;
    const body = encoder.encode(
      moorStoreHeader(this.generation, next, this.identity) + this.lines.join('')
    );
    this.index += 1n;
    this.slot = this.slot === 0 ? 1 : 0;
    writeFileSync(join(this.directory, `body.${this.slot}`), body, { mode: 0o600 });
    writeFileSync(
      join(this.directory, `commit.${this.slot}`),
      moorCommitRecord(this.slot, this.generation, this.index, BigInt(next), body),
      { mode: 0o600 }
    );
    this.lastBodyLength = BigInt(body.length);
    this.lastBodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  }
}

/** A full OB-39 MoorStatus descriptor for a stubbed moor join. */
function fakeMoorStatus(
  sessionPath: string,
  generation: number,
  storeDir: string,
  frontier: { bodySlot: 0 | 1; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array }
) {
  return {
    identity: moorStoreIdentity(sessionPath),
    generation,
    incarnation: new Uint8Array(16).fill(0xa1),
    layout: 2,
    eventIdentity: new Uint8Array(Buffer.from(storeDir)), // raw posix bytes — no tag (real-binary form)
    bodySlot: frontier.bodySlot,
    commitIndex: frontier.commitIndex,
    bodyLength: frontier.bodyLength,
    bodyHash: frontier.bodyHash,
    wallStart: 1n,
    monotonicStart: 1n,
    bootIdentity: new Uint8Array(16).fill(0xb2),
    directory: new Uint8Array(0),
    pid: 4321,
    containment: 1,
    birthToken: new Uint8Array(16).fill(0xc3),
    replay: { first: 0n, last: 0n, start: 0n, end: 0n, complete: true, modesExact: true },
    ownsLease: true,
    viewers: true,
    running: true,
    eventWritable: true,
    leaseEpoch: 1,
    semanticFlags: 0,
    semanticPending: 0,
    log: { health: 0, epoch: 0, index: 0n, retainedStart: 0n, retainedEnd: 0n }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('terminal daemon assembly (cutover Step 3)', () => {
  let home: string;
  let priorTmpdir: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-daemon-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
    // The event-store root derives from the spawn environment's TMPDIR
    // (Rust std::env::temp_dir semantics) — point it at the per-test home so
    // every derived store stays isolated and dies with the temp dir.
    priorTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = home;
  });
  afterEach(() => {
    try {
      if (priorTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmpdir;
      rmSync(home, { recursive: true, force: true });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('assembles a durable daemon, mounts the ws bridge, allocates from the fsync ledger, and disposes', () => {
    const server = new FakeUpgradeServer();
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
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

  it('releases the durable geometry store’s append descriptor on dispose (desk#62)', () => {
    const geometryPath = join(home, '_engine', 'session-geometry.ndjson');
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    // Substance before shape: the store really is holding one append fd open,
    // so the count below is measuring a release and not an absent file.
    expect(openDescriptorCount(geometryPath)).toBe(1);

    daemon.dispose();

    // Every in-process daemon reconstruction used to leak exactly this one.
    expect(openDescriptorCount(geometryPath)).toBe(0);
  });

  it('owns provider reset authorization and completion in the durable daemon', async () => {
    const manifestPath = join(home, 'desk.yml');
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - name: alpha\n        cwd: ${home}\n        agent: codex\n        resume: 11111111-1111-4111-8111-111111111111\n        uiMode: terminal\n        sessionId: alpha\n`
    );
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      manifestPath,
      homeDir: home
    });
    try {
      const first = await daemon.resetProviderSession('alpha');
      expect(first).toMatchObject({
        ok: true,
        generation: 0,
        state: 'authorized'
      });
      expect(
        readProviderSessionBinding({
          deskSessionId: 'alpha',
          manifestPath,
          homeDir: home
        })
      ).toMatchObject({ ok: true, providerSessionId: null });

      const second = await daemon.resetProviderSession('alpha');
      expect(second).toMatchObject({
        ok: true,
        generation: 0,
        state: 'authorized'
      });
      if (first.ok && second.ok) {
        expect(second.authorizationId).not.toBe(first.authorizationId);
      }
      expect(
        daemon.completeProviderSessionLaunch({
          deskSessionId: 'alpha',
          provider: 'codex',
          providerSessionId: '22222222-2222-4222-8222-222222222222',
          generation: 1
        })
      ).toEqual({ ok: false, reason: 'authorization-unclaimed' });
    } finally {
      daemon.dispose();
    }
  });

  it('starts the daemon in its OWN http server (separate-process entry) and closes cleanly', async () => {
    const d = await startTerminalDaemonServer({
      homeRoot: home,
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
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

  it('names the per-generation store dir and passes the moor spawn contract to spawnAndAttachMoor', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const sessionPath = join(home, 'sess-1'); // moor rendezvous: no .sock suffix
    const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 7);
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        expect(options.binPath).toBe('/opt/moor');
        expect(options.sessionPath).toBe(sessionPath);
        expect(options.command).toEqual(['bash']); // no 'start'/'-T' — composed in sessionManager
        expect(options.geometry).toEqual({ rows: 24, cols: 80 });
        expect(options.subject).toEqual({ kind: 'terminal' });
        expect(typeof options.preallocateSpawn).toBe('function');
        expect(options.killSpec).toEqual({
          binPath: '/opt/moor',
          args: ['kill', '-f', sessionPath],
          staleCleanupSpec: { binPath: '/opt/moor', args: ['rm', sessionPath] }
        });
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 7 });
        expect(prepared).toEqual({ storeDir });
        // The holder materializes the committed store during launch and the
        // ATTACH_ACK descriptor is the OB-39 authority provision consumes.
        const store = new MoorStoreFixture(storeDir, 7, moorStoreIdentity(sessionPath));
        return {
          ok: true,
          generation: 7,
          created: true,
          moorStatus: fakeMoorStatus(sessionPath, 7, storeDir, store.frontier())
        };
      }
    );

    await expect(daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    })).resolves.toMatchObject({ ok: true, generation: 7 });

    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(storeDir, 'body.0')).mode & 0o777).toBe(0o600);
    expect(statSync(join(storeDir, 'commit.0')).mode & 0o777).toBe(0o600);
    daemon.dispose();
    expect(existsSync(storeDir)).toBe(true); // dispose never deletes the store
  });

  it('leaves no store behind when spawn fails (prepareSpawn only NAMES the directory)', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        await options.prepareSpawn?.({ sessionId, generation: 3 });
        return { ok: false, reason: 'spawn-failed' };
      }
    );

    await expect(daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    })).resolves.toEqual({ ok: false, reason: 'spawn-failed' });
    expect(existsSync(moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 3))).toBe(false);
    daemon.dispose();
  });

  it('preserves the event store after failed retire; holder-owned retirement removes it', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 4 });
        const store = new MoorStoreFixture(prepared!.storeDir!, 4, moorStoreIdentity(options.sessionPath));
        return {
          ok: true,
          generation: 4,
          created: true,
          moorStatus: fakeMoorStatus(options.sessionPath, 4, prepared!.storeDir!, store.frontier())
        };
      }
    );
    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 4);
    expect(existsSync(storeDir)).toBe(true);
    const retire = vi.spyOn(daemon.router.sessions, 'retireAwaited');
    retire.mockResolvedValueOnce({ ok: false, error: 'still live' });
    await daemon.retire('sess-1');
    expect(existsSync(storeDir)).toBe(true);
    // §11.6: the HOLDER's own retirement removes the published store; Desk
    // only stops observing and deletes nothing itself.
    retire.mockImplementationOnce(async () => {
      rmSync(storeDir, { recursive: true, force: true });
      return { ok: true };
    });
    await daemon.retire('sess-1');
    expect(existsSync(storeDir)).toBe(false);
    daemon.dispose();
  });

  it('keeps a newer event store when exact-generation retirement is stale', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 4 });
        const store = new MoorStoreFixture(prepared!.storeDir!, 4, moorStoreIdentity(options.sessionPath));
        return {
          ok: true,
          generation: 4,
          created: true,
          moorStatus: fakeMoorStatus(options.sessionPath, 4, prepared!.storeDir!, store.frontier())
        };
      }
    );
    await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 4);
    const retire = vi.spyOn(
      daemon.router.sessions,
      'retireGenerationAwaited'
    );
    retire.mockResolvedValueOnce({
      ok: false,
      reason: 'generation-mismatch',
      expectedGeneration: 3,
      currentGeneration: 4,
      error: 'session sess-1 is generation 4, not 3'
    });

    await daemon.retireGeneration('sess-1', 3);

    expect(existsSync(storeDir)).toBe(true);
    retire.mockImplementationOnce(async () => {
      rmSync(storeDir, { recursive: true, force: true }); // holder-owned cleanup
      return { ok: true };
    });
    await daemon.retireGeneration('sess-1', 4);
    expect(existsSync(storeDir)).toBe(false);
    daemon.dispose();
  });

  it('replays an existing generation store into terminal observations', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ens = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ens.ok) return ens;
        const prepared = await options.prepareSpawn?.({ sessionId, generation: ens.generation });
        const store = new MoorStoreFixture(
          prepared!.storeDir!,
          ens.generation,
          moorStoreIdentity(options.sessionPath)
        );
        store.append('state', 1234, ',"state":"busy","title":"Compiling","truncated":false');
        return {
          ...ens,
          moorStatus: fakeMoorStatus(options.sessionPath, ens.generation, prepared!.storeDir!, store.frontier())
        };
      }
    );

    const result = await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('provision failed');

    expect(daemon.terminalObservation('sess-1')).toMatchObject({
      generation: result.generation,
      activity: 'working',
      activityAt: 1_234_000,
      title: 'Compiling'
    });
    const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', result.generation);
    daemon.dispose();
    expect(existsSync(storeDir)).toBe(true);
  });

  it('fails provision closed when the committed store is unreadable (insecure slot)', async () => {
    const diagnostics: string[] = [];
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      onMoorEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.code)
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const prepared = await options.prepareSpawn?.({ sessionId, generation: 5 });
        const store = new MoorStoreFixture(prepared!.storeDir!, 5, moorStoreIdentity(options.sessionPath));
        chmodSync(join(prepared!.storeDir!, 'commit.0'), 0o644); // not owner-private
        return {
          ok: true,
          generation: 5,
          created: true,
          moorStatus: fakeMoorStatus(options.sessionPath, 5, prepared!.storeDir!, store.frontier())
        };
      }
    );

    await expect(daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    })).rejects.toThrow('moor event store could not be observed');
    expect(diagnostics).toContain('tailer-io');
    daemon.dispose();
  });

  it('stops observing on an internal lifecycle exit even when the transition journal rejects it', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const ens = daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
        if (!ens.ok) return ens;
        const prepared = await options.prepareSpawn?.({ sessionId, generation: ens.generation });
        const store = new MoorStoreFixture(prepared!.storeDir!, ens.generation, moorStoreIdentity(options.sessionPath));
        return {
          ...ens,
          moorStatus: fakeMoorStatus(options.sessionPath, ens.generation, prepared!.storeDir!, store.frontier())
        };
      }
    );
    const result = await daemon.provision('sess-1', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('provision failed');
    const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', result.generation);
    expect(existsSync(storeDir)).toBe(true);

    const stop = vi.spyOn(MoorEventObserver.prototype, 'stop');
    vi.spyOn(FileDeskEventJournal.prototype, 'appendTransition').mockImplementation(() => {
      throw new Error('journal rejected transition');
    });
    daemon.router.sessions.retire('sess-1');
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    // §11.6: observation is torn down, but the published store is the
    // holder's to remove — Desk leaves it in place.
    expect(existsSync(storeDir)).toBe(true);
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
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
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

  it('reconcileMoorEvents refuses a restore that carries no adopted descriptor', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const diagnostics: string[] = [];
    daemon.router.sessions.onMoorEventDiagnostic?.((_id, diag) => diagnostics.push(diag.message));
    try {
      // A committed store EXISTS on disk, but no re-adopted status descriptor
      // vouches for it — OB-39: the supervisor never observes from the
      // filesystem alone.
      const sessionPath = join(home, 'sess-1');
      const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 2);
      new MoorStoreFixture(storeDir, 2, moorStoreIdentity(sessionPath));
      expect(daemon.router.sessions.moorStatus('sess-1')).toBeUndefined();
      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(false);
    } finally {
      daemon.dispose();
    }
  });

  it('publishes ONE summary transition for state changes replayed across a restart (downtime catch-up)', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    try {
      const ens = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
      expect(ens).toMatchObject({ ok: true, generation: 2 });
      const sessionPath = join(home, 'sess-1');
      const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 2);
      // The store the surviving holder committed WHILE the daemon was down:
      // activity churn and, crucially, the child's exit.
      const store = new MoorStoreFixture(storeDir, 2, moorStoreIdentity(sessionPath));
      store.append('ready', 1);
      store.append('state', 2, ',"state":"busy","title":"work","truncated":false');
      store.append('state', 3, ',"state":"idle","title":"done","truncated":false');
      store.append('exit', 4, ',"ended":"exited","code":0,"method":"none"');
      writeCurrentExitStore(sessionPath, 2, { ended: 'exited', code: 0 });
      vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
        fakeMoorStatus(sessionPath, 2, storeDir, store.frontier())
      );

      // The durable journal file is the observable contract: transition
      // records for this session, written outside any replay suppression.
      const journalPath = join(home, '_engine', 'desk-events.ndjson');
      const journalTransitions = (): Array<{ cause: string; generation: number }> =>
        readFileSync(journalPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as {
            type: string;
            transition?: { sessionId: string; cause: string; generation: number };
          })
          .filter(
            (record) =>
              record.type === 'transition' && record.transition?.sessionId === 'sess-1'
          )
          .map((record) => ({
            cause: record.transition!.cause,
            generation: record.transition!.generation
          }));
      const before = journalTransitions().length;
      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(true);

      // Exactly ONE summary record — the final caught-up state (the exit) —
      // never the full replayed history, never zero (the completion that
      // happened during downtime must not be lost).
      const after = journalTransitions();
      expect(after.length).toBe(before + 1);
      expect(after[after.length - 1]).toEqual({ cause: 'lifecycle-exited', generation: 2 });
    } finally {
      daemon.dispose();
    }
  });

  it('rejects lifecycle/event agreement when only the exit method differs', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    try {
      const ensured = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
      expect(ensured).toMatchObject({ ok: true, generation: 2 });
      const sessionPath = join(home, 'sess-1');
      const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 2);
      const store = new MoorStoreFixture(storeDir, 2, moorStoreIdentity(sessionPath));
      store.append('exit', 1, ',"ended":"exited","code":0,"method":"forced"');
      writeCurrentExitStore(sessionPath, 2, { ended: 'exited', code: 0 }, 0n, 'none');
      vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
        fakeMoorStatus(sessionPath, 2, storeDir, store.frontier())
      );

      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(false);
      expect(daemon.router.sessions.stateSnapshot('sess-1')?.exit?.origin).not.toBe('observed');
    } finally {
      daemon.dispose();
    }
  });

  it('rejects signalled lifecycle/event agreement when only the exit method differs', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    try {
      const ensured = daemon.router.sessions.ensure('sess-1', { rows: 24, cols: 80 });
      expect(ensured).toMatchObject({ ok: true, generation: 2 });
      const sessionPath = join(home, 'sess-1');
      const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 2);
      const store = new MoorStoreFixture(storeDir, 2, moorStoreIdentity(sessionPath));
      store.append('exit', 1, ',"ended":"signalled","signal":15,"method":"none"');
      writeCurrentExitStore(
        sessionPath,
        2,
        { ended: 'signalled', signal: 15 },
        0n,
        'forced'
      );
      vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
        fakeMoorStatus(sessionPath, 2, storeDir, store.frontier())
      );

      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(false);
      expect(daemon.router.sessions.stateSnapshot('sess-1')?.exit?.origin).not.toBe('observed');
    } finally {
      daemon.dispose();
    }
  });

  it.each(['false', 'throw', 'true'] as const)(
    'desk#66 concurrent reconcile calls share a pending observer start that ends in %s',
    async (outcome) => {
      const daemon = createTerminalDaemon({
        homeRoot: home,
        moorBinPath: '/opt/moor',
        moorSocketRoot: home,
        httpServer: new FakeUpgradeServer()
      });
      const gate = deferred<boolean>();
      const start = vi
        .spyOn(MoorEventObserver.prototype, 'start')
        .mockImplementation(() => gate.promise);
      try {
        const sessionPath = join(home, 'sess-1');
        const storeDir = moorEventStoreDir(
          moorEventStoreRoot('/opt/moor'),
          'sess-1',
          2
        );
        const store = new MoorStoreFixture(
          storeDir,
          2,
          moorStoreIdentity(sessionPath)
        );
        vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
          fakeMoorStatus(sessionPath, 2, storeDir, store.frontier())
        );

        const first = daemon.reconcileMoorEvents('sess-1', 2);
        expect(start).toHaveBeenCalledTimes(1);
        let secondSettled = false;
        const second = daemon.reconcileMoorEvents('sess-1', 2).finally(() => {
          secondSettled = true;
        });

        // Drain every eager async-function continuation without settling the
        // controlled start. A follower that returns the registered object
        // instead of its readiness reaches `finally` within these microtasks.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect.soft(secondSettled).toBe(false);

        if (outcome === 'throw') {
          gate.reject(new Error('deferred observer start failed'));
        } else {
          gate.resolve(outcome === 'true');
        }

        await expect(Promise.all([first, second])).resolves.toEqual(
          outcome === 'true' ? [true, true] : [false, false]
        );
        expect(start).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve(false);
        start.mockRestore();
        daemon.dispose();
      }
    }
  );

  it('desk#66 exact duplicate joins a failed observer start during cleanup', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const sessionPath = join(home, 'sess-1');
    const storeDir = moorEventStoreDir(
      moorEventStoreRoot('/opt/moor'),
      'sess-1',
      2
    );
    const store = new MoorStoreFixture(
      storeDir,
      2,
      moorStoreIdentity(sessionPath)
    );
    const status = vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
      fakeMoorStatus(sessionPath, 2, storeDir, store.frontier())
    );
    const start = vi
      .spyOn(MoorEventObserver.prototype, 'start')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const cleanupReached = deferred<void>();
    const originalStop = MoorEventObserver.prototype.stop;
    let second: Promise<boolean> | undefined;
    let triggerDuplicate = true;
    const stop = vi
      .spyOn(MoorEventObserver.prototype, 'stop')
      .mockImplementation(function (this: MoorEventObserver): void {
        originalStop.call(this);
        if (!triggerDuplicate) return;
        triggerDuplicate = false;
        second = daemon.reconcileMoorEvents('sess-1', 2);
        cleanupReached.resolve(undefined);
      });
    try {
      const first = daemon.reconcileMoorEvents('sess-1', 2);
      await cleanupReached.promise;
      expect(second).toBeDefined();

      const results = await Promise.all([first, second!]);
      expect.soft(results).toEqual([false, false]);
      expect(start).toHaveBeenCalledTimes(1);

      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(true);
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      daemon.dispose();
      stop.mockRestore();
      start.mockRestore();
      status.mockRestore();
    }
  });

  it('desk#66 replay-terminal duplicate joins the observer start failure before return', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    const sessionPath = join(home, 'sess-1');
    const storeDir = moorEventStoreDir(
      moorEventStoreRoot('/opt/moor'),
      'sess-1',
      2
    );
    const store = new MoorStoreFixture(
      storeDir,
      2,
      moorStoreIdentity(sessionPath)
    );
    const status = vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue(
      fakeMoorStatus(sessionPath, 2, storeDir, store.frontier())
    );
    const duplicateLaunched = deferred<void>();
    let second: Promise<boolean> | undefined;
    const start = vi
      .spyOn(MoorEventObserver.prototype, 'start')
      .mockImplementationOnce(function (this: MoorEventObserver): Promise<boolean> {
        const onTerminal = (
          this as unknown as { options: { onTerminal: () => void } }
        ).options.onTerminal;
        onTerminal();
        second = daemon.reconcileMoorEvents('sess-1', 2);
        duplicateLaunched.resolve(undefined);
        return Promise.resolve(false);
      })
      .mockResolvedValue(true);
    try {
      const first = daemon.reconcileMoorEvents('sess-1', 2);
      await duplicateLaunched.promise;
      expect(second).toBeDefined();

      const results = await Promise.all([first, second!]);
      expect.soft(results).toEqual([false, false]);
      expect.soft(start).toHaveBeenCalledTimes(1);

      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(true);
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      daemon.dispose();
      start.mockRestore();
      status.mockRestore();
    }
  });

  it('reconcileMoorEvents observes from the re-adopted descriptor and refuses a generation mismatch', async () => {
    const daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/opt/moor',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer()
    });
    try {
      const sessionPath = join(home, 'sess-1');
      const storeDir = moorEventStoreDir(moorEventStoreRoot('/opt/moor'), 'sess-1', 2);
      const store = new MoorStoreFixture(storeDir, 2, moorStoreIdentity(sessionPath));
      store.append('ready', 1);
      // The restore path adopted this status: it is the reconcile authority.
      const adopted = fakeMoorStatus(sessionPath, 2, storeDir, store.frontier());
      const status = vi
        .spyOn(daemon.router.sessions, 'moorStatus')
        .mockReturnValue(adopted);
      const start = vi.spyOn(MoorEventObserver.prototype, 'start');
      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(true);
      await expect(daemon.reconcileMoorEvents('sess-1', 2)).resolves.toBe(true);
      // Startup and late adoption share this idempotent installer: repeating
      // one exact generation/path authority reuses its sole observer.
      expect(start).toHaveBeenCalledTimes(1);

      // A stale adopted status from ANOTHER generation must never authorize
      // this generation's observation.
      status.mockReturnValue({ ...adopted, generation: 3 });
      await expect(daemon.reconcileMoorEvents('sess-2', 2)).resolves.toBe(false);
    } finally {
      daemon.dispose();
    }
  });
});
