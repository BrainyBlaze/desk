import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDaemonControlHandler,
  createTerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';
import {
  archiveMoorGenerationStores,
  MOOR_GENERATION_STORE_RETENTION,
  MoorGenerationStoreArchiveError,
  moorDescriptorDirectoryAlias,
  moorGenerationArchiveLockPath
} from '../src/server/runtime/moorGenerationStores.js';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import { FileLockBusyError, withFileLock } from '../src/shared/fileLock.js';

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

class FakeUpgradeServer {
  listeners: UpgradeListener[] = [];

  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }

  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }
}

function readTerminalObservation(
  daemon: ReturnType<typeof createTerminalDaemon>,
  sessionId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = createDaemonControlHandler(daemon);
  const request = new PassThrough() as IncomingMessage & PassThrough;
  request.method = 'GET';
  request.url = `/control/terminal-observation?sessionId=${encodeURIComponent(sessionId)}`;
  request.headers = {};
  return new Promise((resolve) => {
    let status = 0;
    const response = {
      set statusCode(value: number) {
        status = value;
      },
      setHeader() {},
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as Record<string, unknown> });
      }
    } as unknown as ServerResponse;
    handler(request, response);
    request.end();
  });
}

const encoder = new TextEncoder();

function sessionIdentity(sessionPath: string): Uint8Array {
  const path = Buffer.from(sessionPath);
  const identity = new Uint8Array(path.length + 1);
  identity[0] = 1;
  identity.set(path, 1);
  return identity;
}

function lifecycleBody(
  sessionPath: string,
  generation: number,
  exitCode = 1,
  method: 'none' | 'graceful' | 'forced' = 'none'
): Uint8Array {
  const identity = Buffer.from(sessionIdentity(sessionPath)).toString('base64');
  const nonce = Buffer.alloc(16).toString('base64');
  const allocatedGeneration = generation === 1 ? 'null' : String(generation);
  return encoder.encode(
    `{"v":2,"type":"lifecycle","phase":"exited","session":"${identity}","generation":${allocatedGeneration},"wire_generation":${generation},"incarnation":"${nonce}","start_wall_ms":"1","start_mono_ms":"1","boot_id":"${nonce}","path_encoding":"posix-bytes","event_path":null,"instrument_path":null,"end_wall_ms":"2","output_end":"0","ended":"exited","code":${exitCode},"method":"${method}"}\n`
  );
}

function signalledLifecycleBody(
  sessionPath: string,
  generation: number,
  signal = 15,
  method: 'none' | 'graceful' | 'forced' = 'forced'
): Uint8Array {
  const identity = Buffer.from(sessionIdentity(sessionPath)).toString('base64');
  const nonce = Buffer.alloc(16).toString('base64');
  const allocatedGeneration = generation === 1 ? 'null' : String(generation);
  return encoder.encode(
    `{"v":2,"type":"lifecycle","phase":"exited","session":"${identity}","generation":${allocatedGeneration},"wire_generation":${generation},"incarnation":"${nonce}","start_wall_ms":"1","start_mono_ms":"1","boot_id":"${nonce}","path_encoding":"posix-bytes","event_path":null,"instrument_path":null,"end_wall_ms":"2","output_end":"0","ended":"signalled","signal":${signal},"method":"${method}"}\n`
  );
}

function commitRecord(
  kind: 2 | 3,
  generation: number,
  bytes: Uint8Array
): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = 0;
  record[10] = 0;
  record[11] = kind;
  view.setUint32(12, generation, true);
  view.setUint32(16, 1, true);
  view.setBigUint64(24, kind === 3 ? 2n : 1n, true);
  view.setBigUint64(32, BigInt(bytes.length), true);
  view.setBigUint64(40, 0n, true);
  view.setBigUint64(48, kind === 3 ? 0n : BigInt(bytes.length), true);
  record.set(createHash('sha256').update(bytes).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

function writeStore(
  directory: string,
  kind: 2 | 3,
  generation: number,
  bytes: Uint8Array
): void {
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'body.0'), bytes, { mode: 0o600 });
  writeFileSync(join(directory, 'body.1'), new Uint8Array(), { mode: 0o600 });
  writeFileSync(join(directory, 'commit.0'), commitRecord(kind, generation, bytes), {
    mode: 0o600
  });
  writeFileSync(join(directory, 'commit.1'), new Uint8Array(), { mode: 0o600 });
}

const STORE_SLOTS = ['body.0', 'body.1', 'commit.0', 'commit.1'] as const;

function sameInode(left: string, right: string): boolean {
  const leftMetadata = lstatSync(left, { bigint: true });
  const rightMetadata = lstatSync(right, { bigint: true });
  return (
    leftMetadata.dev === rightMetadata.dev &&
    leftMetadata.ino === rightMetadata.ino
  );
}

function expectIndependentStoreCopies(left: string, right: string): void {
  for (const slot of STORE_SLOTS) {
    const source = lstatSync(join(left, slot), { bigint: true });
    const archive = lstatSync(join(right, slot), { bigint: true });
    expect(source.nlink).toBe(1n);
    expect(archive.nlink).toBe(1n);
    expect(source.dev === archive.dev && source.ino === archive.ino).toBe(false);
    expect(readFileSync(join(right, slot))).toEqual(readFileSync(join(left, slot)));
  }
}

function modelMoorStoreCleanup(directory: string): void {
  for (const slot of STORE_SLOTS) unlinkSync(join(directory, slot));
  rmdirSync(directory);
}

describe('generation-scoped Moor companion retention', () => {
  let root: string;

  beforeEach(() => {
    // Short /tmp base so a rendezvous <root>/<sessionId> stays within the macOS
    // 103-byte Unix-socket ceiling: os.tmpdir() on macOS is a ~50-byte
    // /var/folders path that would push the real-spawn case below past the
    // ceiling, tripping the capacity guard before archive preallocation and
    // hiding the archive-failure seam it exercises. That case asserts its
    // rendezvous is within the ceiling explicitly.
    root = mkdtempSync(join('/tmp', 'dmgs-'));
    mkdirSync(join(root, '_engine'), { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects supported POSIX descriptor aliases and keeps Darwin no-op archival available', async () => {
    expect(moorDescriptorDirectoryAlias(17, 'linux')).toBe('/proc/self/fd/17');
    expect(moorDescriptorDirectoryAlias(17, 'darwin')).toBe('/dev/fd/17');
    expect(() => moorDescriptorDirectoryAlias(17, 'sunos')).toThrow(
      'unsupported platform'
    );

    await expect(
      archiveMoorGenerationStores(join(root, 'darwin-empty'), 2, {
        platform: 'darwin'
      })
    ).resolves.toBeUndefined();
  });

  it('serializes publication with a stable cross-process session mutex', async () => {
    const sessionPath = join(root, 'codex-lock-contention');
    await withFileLock(moorGenerationArchiveLockPath(sessionPath), async () => {
      await expect(
        archiveMoorGenerationStores(sessionPath, 2, { lockTimeoutMs: 20 })
      ).rejects.toBeInstanceOf(FileLockBusyError);
    });
  });

  it('rejects a symlinked parent before inspecting or mutating companions', async () => {
    const realParent = join(root, 'real-parent');
    const linkedParent = join(root, 'linked-parent');
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent, 'dir');

    await expect(
      archiveMoorGenerationStores(join(linkedParent, 'session'), 2)
    ).rejects.toThrow('owner-private directory');
    expect(readdirSync(realParent)).toEqual([]);
  });

  it('requires the canonical parent to remain owner-private mode 0700', async () => {
    const sessionPath = join(root, 'codex-public-parent');
    chmodSync(root, 0o750);
    try {
      await expect(archiveMoorGenerationStores(sessionPath, 2)).rejects.toThrow(
        'owner-private directory'
      );
      expect(existsSync(moorGenerationArchiveLockPath(sessionPath))).toBe(false);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('rejects a parent replacement between bigint lstat and no-follow open', async () => {
    const sessionPath = join(root, 'codex-parent-replacement');
    const displaced = `${root}.original`;
    let swapped = false;
    try {
      await expect(
        archiveMoorGenerationStores(sessionPath, 2, {
          beforeParentOpen: () => {
            swapped = true;
            renameSync(root, displaced);
            symlinkSync(displaced, root, 'dir');
          }
        })
      ).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(readdirSync(displaced)).not.toContain('codex-parent-replacement.exit');
    } finally {
      if (existsSync(root) && lstatSync(root).isSymbolicLink()) unlinkSync(root);
      if (existsSync(displaced)) renameSync(displaced, root);
    }
  });

  it('hands stable independent copies to the Moor launcher, whose cleanup leaves archive evidence readable', async () => {
    const sessionId = 'codex-2';
    const sessionPath = join(root, sessionId);
    const priorExit = signalledLifecycleBody(sessionPath, 6);
    const priorLog = encoder.encode('generation-six-output\n');
    writeStore(`${sessionPath}.exit`, 3, 6, priorExit);
    writeStore(`${sessionPath}.log`, 2, 6, priorLog);

    const daemon = createTerminalDaemon({
      homeRoot: root,
      moorBinPath: '/opt/moor',
      moorSocketRoot: root,
      httpServer: new FakeUpgradeServer()
    });
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (observedSessionId, options) => {
        expect(observedSessionId).toBe(sessionId);
        expect(options.sessionPath).toBe(sessionPath);
        expect(options.killSpec).toEqual({
          binPath: '/opt/moor',
          args: ['kill', '-f', sessionPath],
          staleCleanupSpec: { binPath: '/opt/moor', args: ['rm', sessionPath] }
        });
        await options.prepareSpawn?.({ sessionId, generation: 7 });
        expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.6.exit`);
        expectIndependentStoreCopies(`${sessionPath}.log`, `${sessionPath}.6.log`);
        // Moor startup has already retained lifecycle-derived paths, then
        // removes stable .log/.events/.exit in that order before its external
        // artifact cleanup. This fixture has no .events or external artifacts.
        modelMoorStoreCleanup(`${sessionPath}.log`);
        modelMoorStoreCleanup(`${sessionPath}.exit`);
        return { ok: false, reason: 'spawn-failed' };
      }
    );

    await expect(
      daemon.provision(sessionId, {
        command: ['codex'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      })
    ).resolves.toEqual({ ok: false, reason: 'spawn-failed' });

    expect(existsSync(`${sessionPath}.exit`)).toBe(false);
    expect(existsSync(`${sessionPath}.log`)).toBe(false);
    expect(readFileSync(`${sessionPath}.6.exit/body.0`)).toEqual(Buffer.from(priorExit));
    expect(readFileSync(`${sessionPath}.6.log/body.0`)).toEqual(Buffer.from(priorLog));
    expect(`${sessionPath}.6.exit`).not.toBe(`${sessionPath}.7.exit`);
    daemon.markReady();
    const diagnostic = await readTerminalObservation(daemon, sessionId);
    expect(diagnostic.status).toBe(200);
    expect(diagnostic.body.exitEvidence).toEqual([
      {
        generation: 6,
        startWallMs: '1',
        endWallMs: '2',
        outputEnd: '0',
        outcome: { ended: 'signalled', signal: 15, method: 'forced' }
      }
    ]);
    daemon.dispose();
  });

  it('publishes independent nlink-one archives so Moor can still parse stable lifecycle cleanup', async () => {
    const sessionPath = join(root, 'codex-independent-copy');
    writeStore(`${sessionPath}.exit`, 3, 6, lifecycleBody(sessionPath, 6));
    writeStore(`${sessionPath}.log`, 2, 6, encoder.encode('copy publication\n'));

    await archiveMoorGenerationStores(sessionPath, 7);

    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.6.exit`);
    expectIndependentStoreCopies(`${sessionPath}.log`, `${sessionPath}.6.log`);
  });

  it.each([
    ['exit-only', false],
    ['exit-and-log', true]
  ] as const)(
    'rejects a stable lifecycle rollback behind a newer %s archive without mutation',
    async (_label, withArchivedLog) => {
      const sessionPath = join(root, `codex-rollback-${_label}`);
      const stableExit = lifecycleBody(sessionPath, 4);
      const stableLog = encoder.encode('stable generation four\n');
      const newerExit = lifecycleBody(sessionPath, 5);
      const newerLog = encoder.encode('archived generation five\n');
      writeStore(`${sessionPath}.exit`, 3, 4, stableExit);
      writeStore(`${sessionPath}.log`, 2, 4, stableLog);
      writeStore(`${sessionPath}.5.exit`, 3, 5, newerExit);
      if (withArchivedLog) writeStore(`${sessionPath}.5.log`, 2, 5, newerLog);
      const namesBefore = readdirSync(root).sort();

      await expect(archiveMoorGenerationStores(sessionPath, 6)).rejects.toThrow(
        'stable lifecycle generation is older than an existing archive'
      );

      expect(readdirSync(root).sort()).toEqual(namesBefore);
      expect(readFileSync(`${sessionPath}.exit/body.0`)).toEqual(Buffer.from(stableExit));
      expect(readFileSync(`${sessionPath}.log/body.0`)).toEqual(Buffer.from(stableLog));
      expect(readFileSync(`${sessionPath}.5.exit/body.0`)).toEqual(Buffer.from(newerExit));
      if (withArchivedLog) {
        expect(readFileSync(`${sessionPath}.5.log/body.0`)).toEqual(Buffer.from(newerLog));
      }
      expect(existsSync(`${sessionPath}.4.exit`)).toBe(false);
      expect(existsSync(`${sessionPath}.4.log`)).toBe(false);
      expect(existsSync(moorGenerationArchiveLockPath(sessionPath))).toBe(false);
    }
  );

  it('allows strictly older committed archives before publishing the stable frontier', async () => {
    const sessionPath = join(root, 'codex-forward-frontier');
    const olderExit = lifecycleBody(sessionPath, 3);
    const olderLog = encoder.encode('archived generation three\n');
    writeStore(`${sessionPath}.3.exit`, 3, 3, olderExit);
    writeStore(`${sessionPath}.3.log`, 2, 3, olderLog);
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('stable generation four\n'));

    await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();

    expect(readFileSync(`${sessionPath}.3.exit/body.0`)).toEqual(Buffer.from(olderExit));
    expect(readFileSync(`${sessionPath}.3.log/body.0`)).toEqual(Buffer.from(olderLog));
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    expectIndependentStoreCopies(`${sessionPath}.log`, `${sessionPath}.4.log`);
  });

  it('creates archive directories at exact owner-private mode despite a restrictive umask', async () => {
    const sessionPath = join(root, 'codex-archive-mode');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    const previousUmask = process.umask(0o777);
    let archiveMode: number | undefined;
    try {
      await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
      archiveMode = lstatSync(`${sessionPath}.4.exit`).mode & 0o777;
    } finally {
      process.umask(previousUmask);
      if (existsSync(`${sessionPath}.4.exit`)) chmodSync(`${sessionPath}.4.exit`, 0o700);
    }

    expect(archiveMode).toBe(0o700);
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
  });

  it('refuses an archive collision without changing either stable companion', async () => {
    const sessionPath = join(root, 'codex-3');
    const stableExit = lifecycleBody(sessionPath, 6, 1);
    const stableLog = encoder.encode('stable generation six\n');
    const archivedExit = lifecycleBody(sessionPath, 6, 2);
    writeStore(`${sessionPath}.exit`, 3, 6, stableExit);
    writeStore(`${sessionPath}.log`, 2, 6, stableLog);
    writeStore(`${sessionPath}.6.exit`, 3, 6, archivedExit);

    await expect(archiveMoorGenerationStores(sessionPath, 7)).rejects.toThrow(
      'archive collision'
    );

    expect(readFileSync(`${sessionPath}.exit/body.0`)).toEqual(Buffer.from(stableExit));
    expect(readFileSync(`${sessionPath}.log/body.0`)).toEqual(Buffer.from(stableLog));
    expect(readFileSync(`${sessionPath}.6.exit/body.0`)).toEqual(Buffer.from(archivedExit));
    expect(existsSync(`${sessionPath}.6.log`)).toBe(false);
  });

  it('fails closed on a symlink archive candidate before publishing either archive', async () => {
    const sessionPath = join(root, 'codex-4');
    const stableExit = lifecycleBody(sessionPath, 6);
    const stableLog = encoder.encode('stable generation six\n');
    writeStore(`${sessionPath}.exit`, 3, 6, stableExit);
    writeStore(`${sessionPath}.log`, 2, 6, stableLog);
    const target = join(root, 'foreign-target');
    writeStore(target, 3, 2, lifecycleBody(sessionPath, 2));
    symlinkSync(target, `${sessionPath}.2.exit`, 'dir');

    await expect(archiveMoorGenerationStores(sessionPath, 7)).rejects.toThrow(
      'not a directory'
    );

    expect(readFileSync(`${sessionPath}.exit/body.0`)).toEqual(Buffer.from(stableExit));
    expect(readFileSync(`${sessionPath}.log/body.0`)).toEqual(Buffer.from(stableLog));
    expect(lstatSync(`${sessionPath}.2.exit`).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, 'commit.0'))).toBe(true);
    expect(existsSync(`${sessionPath}.6.exit`)).toBe(false);
  });

  it('never lets predecessor archival mutate a successor generation store', async () => {
    const sessionPath = join(root, 'codex-5');
    const stableExit = lifecycleBody(sessionPath, 6);
    const stableLog = encoder.encode('stable generation six\n');
    const successorExit = lifecycleBody(sessionPath, 7, 9);
    writeStore(`${sessionPath}.exit`, 3, 6, stableExit);
    writeStore(`${sessionPath}.log`, 2, 6, stableLog);
    writeStore(`${sessionPath}.7.exit`, 3, 7, successorExit);

    await expect(archiveMoorGenerationStores(sessionPath, 7)).rejects.toThrow(
      'invalid Moor generation archive name'
    );

    expect(readFileSync(`${sessionPath}.exit/body.0`)).toEqual(Buffer.from(stableExit));
    expect(readFileSync(`${sessionPath}.log/body.0`)).toEqual(Buffer.from(stableLog));
    expect(readFileSync(`${sessionPath}.7.exit/body.0`)).toEqual(Buffer.from(successorExit));
    expect(existsSync(`${sessionPath}.6.exit`)).toBe(false);
  });

  it('treats absent companions as a pair: neither is a no-op, exit-only archives, and log-only refuses', async () => {
    const emptySession = join(root, 'codex-empty');
    await expect(archiveMoorGenerationStores(emptySession, 2)).resolves.toBeUndefined();

    const exitOnlySession = join(root, 'codex-exit-only');
    const exitOnlyBody = lifecycleBody(exitOnlySession, 1);
    writeStore(`${exitOnlySession}.exit`, 3, 1, exitOnlyBody);
    await expect(archiveMoorGenerationStores(exitOnlySession, 2)).resolves.toBeUndefined();
    expect(existsSync(`${exitOnlySession}.exit`)).toBe(true);
    expect(readFileSync(`${exitOnlySession}.1.exit/body.0`)).toEqual(
      Buffer.from(exitOnlyBody)
    );
    expectIndependentStoreCopies(`${exitOnlySession}.exit`, `${exitOnlySession}.1.exit`);
    expect(existsSync(`${exitOnlySession}.1.log`)).toBe(false);

    const logOnlySession = join(root, 'codex-log-only');
    const logOnlyBody = encoder.encode('unowned log\n');
    writeStore(`${logOnlySession}.log`, 2, 2, logOnlyBody);
    await expect(archiveMoorGenerationStores(logOnlySession, 3)).rejects.toThrow(
      'has no lifecycle owner'
    );
    expect(readFileSync(`${logOnlySession}.log/body.0`)).toEqual(
      Buffer.from(logOnlyBody)
    );
    expect(existsSync(`${logOnlySession}.2.log`)).toBe(false);
  });

  it('rejects foreign lifecycle identity and mismatched log generation without changing either companion', async () => {
    const foreignSession = join(root, 'codex-foreign');
    const foreignExit = lifecycleBody(join(root, 'another-session'), 4);
    const foreignLog = encoder.encode('foreign identity log\n');
    writeStore(`${foreignSession}.exit`, 3, 4, foreignExit);
    writeStore(`${foreignSession}.log`, 2, 4, foreignLog);
    await expect(archiveMoorGenerationStores(foreignSession, 5)).rejects.toThrow(
      'belongs to another session'
    );
    expect(readFileSync(`${foreignSession}.exit/body.0`)).toEqual(Buffer.from(foreignExit));
    expect(readFileSync(`${foreignSession}.log/body.0`)).toEqual(Buffer.from(foreignLog));

    const mismatchSession = join(root, 'codex-mismatch');
    const mismatchExit = lifecycleBody(mismatchSession, 4);
    const mismatchLog = encoder.encode('generation three log\n');
    writeStore(`${mismatchSession}.exit`, 3, 4, mismatchExit);
    writeStore(`${mismatchSession}.log`, 2, 3, mismatchLog);
    await expect(archiveMoorGenerationStores(mismatchSession, 5)).rejects.toThrow();
    expect(readFileSync(`${mismatchSession}.exit/body.0`)).toEqual(
      Buffer.from(mismatchExit)
    );
    expect(readFileSync(`${mismatchSession}.log/body.0`)).toEqual(Buffer.from(mismatchLog));
    expect(existsSync(`${mismatchSession}.4.exit`)).toBe(false);
  });

  it('rejects an arbitrary same-generation archived log without lifecycle ownership', async () => {
    const sessionPath = join(root, 'codex-partial');
    const exitBody = lifecycleBody(sessionPath, 4);
    const archivedLog = encoder.encode('already archived\n');
    writeStore(`${sessionPath}.exit`, 3, 4, exitBody);
    writeStore(`${sessionPath}.4.log`, 2, 4, archivedLog);

    await expect(archiveMoorGenerationStores(sessionPath, 5)).rejects.toThrow(
      'has no lifecycle owner'
    );

    expect(existsSync(`${sessionPath}.exit`)).toBe(true);
    expect(existsSync(`${sessionPath}.4.exit`)).toBe(false);
    expect(readFileSync(`${sessionPath}.4.log/body.0`)).toEqual(Buffer.from(archivedLog));
  });

  it('resumes only byte-exact independent partial exit publication and rejects wrong or extra state', async () => {
    const resumable = join(root, 'codex-partial-copied');
    const exitBody = lifecycleBody(resumable, 4);
    writeStore(`${resumable}.exit`, 3, 4, exitBody);
    mkdirSync(`${resumable}.4.exit`, { mode: 0o700 });
    copyFileSync(`${resumable}.exit/body.0`, `${resumable}.4.exit/body.0`);

    await expect(archiveMoorGenerationStores(resumable, 5)).resolves.toBeUndefined();
    expectIndependentStoreCopies(`${resumable}.exit`, `${resumable}.4.exit`);

    const wrong = join(root, 'codex-partial-wrong');
    writeStore(`${wrong}.exit`, 3, 4, lifecycleBody(wrong, 4));
    mkdirSync(`${wrong}.4.exit`, { mode: 0o700 });
    writeFileSync(`${wrong}.4.exit/body.0`, 'wrong-copy', { mode: 0o600 });
    await expect(archiveMoorGenerationStores(wrong, 5)).rejects.toThrow(
      'archive collision'
    );
    expect(readFileSync(`${wrong}.4.exit/body.0`, 'utf8')).toBe('wrong-copy');

    const extra = join(root, 'codex-partial-extra');
    writeStore(`${extra}.exit`, 3, 4, lifecycleBody(extra, 4));
    mkdirSync(`${extra}.4.exit`, { mode: 0o700 });
    copyFileSync(`${extra}.exit/body.0`, `${extra}.4.exit/body.0`);
    writeFileSync(`${extra}.4.exit/foreign`, 'keep', { mode: 0o600 });
    await expect(archiveMoorGenerationStores(extra, 5)).rejects.toThrow(
      'unexpected Moor store entry'
    );
    expect(readFileSync(`${extra}.4.exit/foreign`, 'utf8')).toBe('keep');
  });

  it('durably syncs every accepted preexisting slot before completing a partial archive', async () => {
    const sessionPath = join(root, 'codex-partial-resume-sync');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    mkdirSync(`${sessionPath}.4.exit`, { mode: 0o700 });
    copyFileSync(`${sessionPath}.exit/body.0`, `${sessionPath}.4.exit/body.0`);
    const before = lstatSync(`${sessionPath}.4.exit/body.0`, { bigint: true });
    const bytes = readFileSync(`${sessionPath}.4.exit/body.0`);
    const startingInode = { dev: before.dev, ino: before.ino };
    const beforeSync: string[] = [];
    const afterSync: string[] = [];

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        syncResumedArchiveSlot: async ({ kind, slot }, durableSync) => {
          beforeSync.push(`${kind}:${slot}`);
          await durableSync();
          afterSync.push(`${kind}:${slot}`);
        }
      })
    ).resolves.toBeUndefined();

    expect(beforeSync).toEqual(['exit:body.0']);
    expect(afterSync).toEqual(beforeSync);
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    const after = lstatSync(`${sessionPath}.4.exit/body.0`, { bigint: true });
    expect({
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
      mode: after.mode,
      nlink: after.nlink
    }).toEqual({
      ...startingInode,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      mode: before.mode,
      nlink: before.nlink
    });
    expect(readFileSync(`${sessionPath}.4.exit/body.0`)).toEqual(bytes);
  });

  it('durably syncs every slot when retrying already complete exact archives', async () => {
    const sessionPath = join(root, 'codex-complete-resume-sync');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('complete resume log\n'));
    const crash = new Error('crash after complete exit and log archives');

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        afterLogPublished: () => {
          throw crash;
        }
      })
    ).rejects.toBe(crash);

    const synced: string[] = [];
    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        syncResumedArchiveSlot: async ({ kind, slot }, durableSync) => {
          await durableSync();
          synced.push(`${kind}:${slot}`);
        }
      })
    ).resolves.toBeUndefined();

    expect(synced).toEqual([
      ...STORE_SLOTS.map((slot) => `exit:${slot}`),
      ...STORE_SLOTS.map((slot) => `log:${slot}`)
    ]);
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    expectIndependentStoreCopies(`${sessionPath}.log`, `${sessionPath}.4.log`);
  });

  it('fails closed with a typed error when a resumed archive slot cannot be synced', async () => {
    const sessionPath = join(root, 'codex-resume-sync-failure');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    mkdirSync(`${sessionPath}.4.exit`, { mode: 0o700 });
    copyFileSync(`${sessionPath}.exit/body.0`, `${sessionPath}.4.exit/body.0`);
    const archivedBody = readFileSync(`${sessionPath}.4.exit/body.0`);
    const injected = new Error('injected resumed archive fsync failure');
    let failure: unknown;
    let exitPublished = false;

    try {
      await archiveMoorGenerationStores(sessionPath, 5, {
        syncResumedArchiveSlot: async ({ kind, slot }) => {
          if (kind === 'exit' && slot === 'body.0') throw injected;
        },
        afterExitPublished: () => {
          exitPublished = true;
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MoorGenerationStoreArchiveError);
    expect(failure).toEqual(
      expect.objectContaining({
        name: 'MoorGenerationStoreArchiveError',
        code: 'ARCHIVE_SLOT_SYNC_FAILED',
        cause: injected
      })
    );
    expect(exitPublished).toBe(false);
    expect(readdirSync(`${sessionPath}.4.exit`)).toEqual(['body.0']);
    expect(readFileSync(`${sessionPath}.4.exit/body.0`)).toEqual(archivedBody);
    expect(readdirSync(`${sessionPath}.exit`).sort()).toEqual([...STORE_SLOTS].sort());

    const retrySyncs: string[] = [];
    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        syncResumedArchiveSlot: async ({ kind, slot }, durableSync) => {
          await durableSync();
          retrySyncs.push(`${kind}:${slot}`);
        }
      })
    ).resolves.toBeUndefined();
    expect(retrySyncs).toEqual(['exit:body.0']);
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
  });

  it('resumes an empty archive only with its exact complete stable source', async () => {
    const sessionPath = join(root, 'codex-empty-reservation');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    mkdirSync(`${sessionPath}.4.exit`, { mode: 0o700 });

    await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    expect(existsSync(`${sessionPath}.exit`)).toBe(true);

    const orphan = join(root, 'codex-empty-orphan');
    mkdirSync(`${orphan}.4.exit`, { mode: 0o700 });
    await expect(archiveMoorGenerationStores(orphan, 5)).rejects.toThrow(
      'manual recovery'
    );
    expect(readdirSync(`${orphan}.4.exit`)).toEqual([]);

    const unprovenStable = join(root, 'codex-empty-stable');
    mkdirSync(`${unprovenStable}.exit`, { mode: 0o700 });
    await expect(archiveMoorGenerationStores(unprovenStable, 5)).rejects.toThrow(
      'no complete archived transaction evidence'
    );
    expect(readdirSync(`${unprovenStable}.exit`)).toEqual([]);
  });

  it('requires manual recovery for orphan partial archives and preserves non-regular slots', async () => {
    const orphan = join(root, 'codex-partial-orphan');
    mkdirSync(`${orphan}.4.exit`, { mode: 0o700 });
    writeFileSync(`${orphan}.4.exit/body.0`, 'orphan-copy', { mode: 0o600 });
    await expect(archiveMoorGenerationStores(orphan, 5)).rejects.toThrow(
      'manual recovery'
    );
    expect(readFileSync(`${orphan}.4.exit/body.0`, 'utf8')).toBe('orphan-copy');

    const symlinked = join(root, 'codex-partial-symlink');
    writeStore(`${symlinked}.exit`, 3, 4, lifecycleBody(symlinked, 4));
    mkdirSync(`${symlinked}.4.exit`, { mode: 0o700 });
    symlinkSync(`${symlinked}.exit/body.0`, `${symlinked}.4.exit/body.0`);
    await expect(archiveMoorGenerationStores(symlinked, 5)).rejects.toThrow(
      'not an independent owner-private file'
    );
    expect(lstatSync(`${symlinked}.4.exit/body.0`).isSymbolicLink()).toBe(true);
  });

  it('never accepts a log archive before the exact lifecycle archive is complete', async () => {
    const sessionPath = join(root, 'codex-log-before-exit-complete');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('stable log\n'));
    mkdirSync(`${sessionPath}.4.exit`, { mode: 0o700 });
    copyFileSync(`${sessionPath}.exit/body.0`, `${sessionPath}.4.exit/body.0`);
    mkdirSync(`${sessionPath}.4.log`, { mode: 0o700 });
    for (const slot of STORE_SLOTS) {
      copyFileSync(`${sessionPath}.log/${slot}`, `${sessionPath}.4.log/${slot}`);
    }

    await expect(archiveMoorGenerationStores(sessionPath, 5)).rejects.toThrow(
      'has no lifecycle owner'
    );
    expect(readdirSync(`${sessionPath}.4.exit`)).toEqual(['body.0']);
    expectIndependentStoreCopies(`${sessionPath}.log`, `${sessionPath}.4.log`);
  });

  it('never clobbers a destination that appears after locked preflight', async () => {
    const sessionPath = join(root, 'codex-destination-race');
    const stable = lifecycleBody(sessionPath, 4, 1);
    const foreign = lifecycleBody(sessionPath, 4, 9);
    writeStore(`${sessionPath}.exit`, 3, 4, stable);

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        afterPreflight: () => writeStore(`${sessionPath}.4.exit`, 3, 4, foreign)
      })
    ).rejects.toThrow('archive reservation collision');

    expect(readFileSync(`${sessionPath}.exit/body.0`)).toEqual(Buffer.from(stable));
    expect(readFileSync(`${sessionPath}.4.exit/body.0`)).toEqual(Buffer.from(foreign));
  });

  it('preserves a foreign slot that appears at the exclusive copy seam', async () => {
    const sessionPath = join(root, 'codex-copy-slot-race');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    let raced = false;

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        beforeCopyAttempt: ({ kind, slot, destination }) => {
          if (raced || kind !== 'exit' || slot !== 'body.0') return;
          raced = true;
          writeFileSync(destination, 'foreign-copy-winner', { mode: 0o600 });
        }
      })
    ).rejects.toThrow(/archive.*changed/u);

    expect(readFileSync(`${sessionPath}.4.exit/body.0`, 'utf8')).toBe(
      'foreign-copy-winner'
    );
    expect(existsSync(`${sessionPath}.exit`)).toBe(true);
  });

  it('uses exclusive creation when a destination appears after final validation', async () => {
    const sessionPath = join(root, 'codex-exclusive-create-race');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    let raced = false;

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        beforeDestinationCreate: ({ kind, slot, destination }) => {
          if (raced || kind !== 'exit' || slot !== 'body.0') return;
          raced = true;
          writeFileSync(destination, 'foreign-exclusive-winner', { mode: 0o600 });
        }
      })
    ).rejects.toThrow('archive collision at slot');

    expect(raced).toBe(true);
    expect(readFileSync(`${sessionPath}.4.exit/body.0`, 'utf8')).toBe(
      'foreign-exclusive-winner'
    );
    expect(existsSync(`${sessionPath}.exit`)).toBe(true);
  });

  it('revalidates source and archive directory identities after the final copy seam', async () => {
    const sourceSession = join(root, 'codex-source-swap');
    const original = lifecycleBody(sourceSession, 4, 1);
    const replacement = lifecycleBody(sourceSession, 4, 9);
    writeStore(`${sourceSession}.exit`, 3, 4, original);
    let sourceSwapped = false;
    await expect(
      archiveMoorGenerationStores(sourceSession, 5, {
        beforeCopyAttempt: ({ kind, slot }) => {
          if (sourceSwapped || kind !== 'exit' || slot !== 'body.0') return;
          sourceSwapped = true;
          renameSync(`${sourceSession}.exit`, `${sourceSession}.exit.original`);
          writeStore(`${sourceSession}.exit`, 3, 4, replacement);
        }
      })
    ).rejects.toThrow(/source identity changed|store (?:directory )?identity changed/u);
    expect(readFileSync(`${sourceSession}.exit/body.0`)).toEqual(
      Buffer.from(replacement)
    );
    expect(readdirSync(`${sourceSession}.4.exit`)).toEqual([]);

    const archiveSession = join(root, 'codex-archive-swap');
    writeStore(`${archiveSession}.exit`, 3, 4, lifecycleBody(archiveSession, 4));
    let archiveSwapped = false;
    const displaced = `${archiveSession}.4.exit.displaced`;
    await expect(
      archiveMoorGenerationStores(archiveSession, 5, {
        beforeCopyAttempt: ({ kind, slot }) => {
          if (archiveSwapped || kind !== 'exit' || slot !== 'body.0') return;
          archiveSwapped = true;
          renameSync(`${archiveSession}.4.exit`, displaced);
          mkdirSync(`${archiveSession}.4.exit`, { mode: 0o700 });
        }
      })
    ).rejects.toThrow(/archive directory identity changed|store directory identity changed/u);
    expect(readdirSync(`${archiveSession}.4.exit`)).toEqual([]);
    expect(readdirSync(displaced)).toEqual([]);
  });

  it('detects a stable source slot replacement at the final copy seam', async () => {
    const sessionPath = join(root, 'codex-source-slot-swap');
    writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
    let swapped = false;

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        beforeCopyAttempt: ({ kind, slot, source }) => {
          if (swapped || kind !== 'exit' || slot !== 'body.0') return;
          swapped = true;
          renameSync(source, `${source}.original`);
          writeFileSync(source, 'foreign-source-winner', { mode: 0o600 });
        }
      })
    ).rejects.toThrow(/source identity changed|unexpected Moor store entry/u);

    expect(readFileSync(`${sessionPath}.exit/body.0`, 'utf8')).toBe(
      'foreign-source-winner'
    );
    expect(existsSync(`${sessionPath}.exit/body.0.original`)).toBe(true);
    expect(readdirSync(`${sessionPath}.4.exit`)).toEqual([]);
  });

  it('detects an in-place source mutation after the copy descriptors are open', async () => {
    const sessionPath = join(root, 'codex-source-mid-copy');
    const original = lifecycleBody(sessionPath, 4, 1);
    const replacement = lifecycleBody(sessionPath, 4, 9);
    expect(replacement).toHaveLength(original.length);
    writeStore(`${sessionPath}.exit`, 3, 4, original);
    let mutated = false;

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        afterCopyOpen: ({ kind, slot, source }) => {
          if (mutated || kind !== 'exit' || slot !== 'body.0') return;
          mutated = true;
          writeFileSync(source, replacement, { mode: 0o600 });
        }
      })
    ).rejects.toThrow(/copy identity changed|source (?:snapshot|identity) changed/u);

    expect(mutated).toBe(true);
    expect(readFileSync(`${sessionPath}.exit/body.0`)).toEqual(Buffer.from(replacement));
    expect(readFileSync(`${sessionPath}.4.exit/body.0`)).toEqual(
      Buffer.from(replacement)
    );
    expect(lstatSync(`${sessionPath}.4.exit/body.0`).nlink).toBe(1);
  });

  it('does not write into an archive-directory replacement after opening the copy target', async () => {
    const sessionPath = join(root, 'codex-archive-mid-copy');
    const body = lifecycleBody(sessionPath, 4);
    const displaced = `${sessionPath}.4.exit.displaced`;
    writeStore(`${sessionPath}.exit`, 3, 4, body);
    let swapped = false;

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        afterCopyOpen: ({ kind, slot }) => {
          if (swapped || kind !== 'exit' || slot !== 'body.0') return;
          swapped = true;
          renameSync(`${sessionPath}.4.exit`, displaced);
          mkdirSync(`${sessionPath}.4.exit`, { mode: 0o700 });
        }
      })
    ).rejects.toThrow(/manual recovery|identity changed/u);

    expect(swapped).toBe(true);
    expect(readdirSync(`${sessionPath}.4.exit`)).toEqual([]);
    expect(readFileSync(`${displaced}/body.0`)).toEqual(Buffer.from(body));
    expect(lstatSync(`${displaced}/body.0`).nlink).toBe(1);
  });

  it.each([
    ['exit publication', 'afterExitPublished'],
    ['both publications', 'afterLogPublished']
  ] as const)('retries a crash after %s using stable byte witnesses', async (_label, hook) => {
    const sessionPath = join(root, `codex-crash-${hook}`);
    const exitBody = lifecycleBody(sessionPath, 4);
    const logBody = encoder.encode('stable log\n');
    writeStore(`${sessionPath}.exit`, 3, 4, exitBody);
    writeStore(`${sessionPath}.log`, 2, 4, logBody);
    const crash = new Error(`crash:${hook}`);

    await expect(
      archiveMoorGenerationStores(sessionPath, 5, {
        [hook]: () => {
          throw crash;
        }
      })
    ).rejects.toBe(crash);
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    expect(existsSync(`${sessionPath}.exit`)).toBe(true);

    await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    expectIndependentStoreCopies(`${sessionPath}.log`, `${sessionPath}.4.log`);
    expect(readFileSync(`${sessionPath}.4.log/body.0`)).toEqual(Buffer.from(logBody));
  });

  it.each(['exit', 'log'] as const)(
    'resumes a crash after the first %s archive slot copy',
    async (crashKind) => {
      const sessionPath = join(root, `codex-slot-crash-${crashKind}`);
      writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
      writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('slot crash log\n'));
      const crash = new Error(`crash:${crashKind}:slot`);

      await expect(
        archiveMoorGenerationStores(sessionPath, 5, {
          beforeCopy: ({ kind, slot }) => {
            if (kind === crashKind && slot === 'body.1') throw crash;
          }
        })
      ).rejects.toBe(crash);
      expect(
        sameInode(
          `${sessionPath}.${crashKind}/body.0`,
          `${sessionPath}.4.${crashKind}/body.0`
        )
      ).toBe(false);
      expect(readFileSync(`${sessionPath}.4.${crashKind}/body.0`)).toEqual(
        readFileSync(`${sessionPath}.${crashKind}/body.0`)
      );

      await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
      expectIndependentStoreCopies(
        `${sessionPath}.${crashKind}`,
        `${sessionPath}.4.${crashKind}`
      );
    }
  );

  it('accepts Moor log-first cleanup only while the stable lifecycle still owns the archive', async () => {
    const sessionPath = join(root, 'codex-moor-partial-cleanup');
    const exitBody = lifecycleBody(sessionPath, 4);
    const logBody = encoder.encode('published log\n');
    writeStore(`${sessionPath}.exit`, 3, 4, exitBody);
    writeStore(`${sessionPath}.log`, 2, 4, logBody);
    await archiveMoorGenerationStores(sessionPath, 5);

    modelMoorStoreCleanup(`${sessionPath}.log`);
    await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
    expectIndependentStoreCopies(`${sessionPath}.exit`, `${sessionPath}.4.exit`);
    expect(readFileSync(`${sessionPath}.4.log/body.0`)).toEqual(Buffer.from(logBody));
  });

  it.each(['log', 'exit'] as const)(
    'retries while Moor has partially removed the stable %s store',
    async (kind) => {
      const sessionPath = join(root, `codex-moor-partial-${kind}`);
      writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
      writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('partial cleanup\n'));
      await archiveMoorGenerationStores(sessionPath, 5);
      if (kind === 'exit') modelMoorStoreCleanup(`${sessionPath}.log`);
      unlinkSync(`${sessionPath}.${kind}/body.1`);

      await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
      expect(existsSync(`${sessionPath}.${kind}`)).toBe(true);
      expect(existsSync(`${sessionPath}.4.${kind}/body.1`)).toBe(true);
      expect(sameInode(`${sessionPath}.exit/body.0`, `${sessionPath}.4.exit/body.0`)).toBe(
        false
      );
    }
  );

  it.each(['log', 'exit'] as const)(
    'retries after Moor removes every stable %s slot but crashes before rmdir',
    async (kind) => {
      const sessionPath = join(root, `codex-moor-empty-${kind}`);
      writeStore(`${sessionPath}.exit`, 3, 4, lifecycleBody(sessionPath, 4));
      writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('empty cleanup residue\n'));
      await archiveMoorGenerationStores(sessionPath, 5);
      if (kind === 'exit') modelMoorStoreCleanup(`${sessionPath}.log`);
      for (const slot of STORE_SLOTS) unlinkSync(`${sessionPath}.${kind}/${slot}`);

      await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();
      expect(readdirSync(`${sessionPath}.${kind}`)).toEqual([]);
      expect(readFileSync(`${sessionPath}.4.exit/body.0`)).toEqual(
        Buffer.from(lifecycleBody(sessionPath, 4))
      );
      expect(lstatSync(`${sessionPath}.4.${kind}/body.0`).nlink).toBe(1);
    }
  );

  it('recognizes the archive as committed after Moor removes stable lifecycle last', async () => {
    const sessionPath = join(root, 'codex-moor-cleanup-commit');
    const exitBody = lifecycleBody(sessionPath, 4);
    writeStore(`${sessionPath}.exit`, 3, 4, exitBody);
    writeStore(`${sessionPath}.log`, 2, 4, encoder.encode('committed log\n'));
    await archiveMoorGenerationStores(sessionPath, 5);

    modelMoorStoreCleanup(`${sessionPath}.log`);
    modelMoorStoreCleanup(`${sessionPath}.exit`);
    await expect(archiveMoorGenerationStores(sessionPath, 5)).resolves.toBeUndefined();

    expect(readFileSync(`${sessionPath}.4.exit/body.0`)).toEqual(Buffer.from(exitBody));
    expect(lstatSync(`${sessionPath}.4.exit/body.0`).nlink).toBe(1);
  });

  it('retains exactly the newest eight generations by numeric order', async () => {
    const sessionPath = join(root, 'codex-retention');
    const unrelated = `${sessionPath}.notes`;
    mkdirSync(unrelated, { mode: 0o700 });
    writeFileSync(join(unrelated, 'keep'), 'unrelated-name', { mode: 0o600 });
    for (let generation = 2; generation <= 10; generation += 1) {
      writeStore(
        `${sessionPath}.${generation}.exit`,
        3,
        generation,
        lifecycleBody(sessionPath, generation)
      );
      writeStore(
        `${sessionPath}.${generation}.log`,
        2,
        generation,
        encoder.encode(`generation ${generation}\n`)
      );
    }
    writeStore(`${sessionPath}.exit`, 3, 11, lifecycleBody(sessionPath, 11));
    writeStore(`${sessionPath}.log`, 2, 11, encoder.encode('generation 11\n'));

    await expect(archiveMoorGenerationStores(sessionPath, 12)).resolves.toBeUndefined();

    const generations = readdirSync(root)
      .flatMap((name) => {
        const match = /^codex-retention\.([1-9][0-9]*)\.exit$/u.exec(name);
        return match === null ? [] : [Number(match[1])];
      })
      .sort((left, right) => left - right);
    expect(generations).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(generations).toHaveLength(MOOR_GENERATION_STORE_RETENTION);
    expect(existsSync(`${sessionPath}.2.log`)).toBe(false);
    expect(existsSync(`${sessionPath}.3.log`)).toBe(false);
    expect(existsSync(`${sessionPath}.10.log`)).toBe(true);
    expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('unrelated-name');
  });

  it('rejects a rollback behind a full retention window before publishing or pruning', async () => {
    const sessionPath = join(root, 'codex-active-retention-conflict');
    writeStore(`${sessionPath}.exit`, 3, 2, lifecycleBody(sessionPath, 2));
    for (let generation = 3; generation <= 11; generation += 1) {
      writeStore(
        `${sessionPath}.${generation}.exit`,
        3,
        generation,
        lifecycleBody(sessionPath, generation)
      );
    }
    const namesBefore = readdirSync(root).sort();

    await expect(archiveMoorGenerationStores(sessionPath, 12)).rejects.toThrow(
      'stable lifecycle generation is older than an existing archive'
    );

    expect(readdirSync(root).sort()).toEqual(namesBefore);
    expect(existsSync(`${sessionPath}.3.exit`)).toBe(true);
    expect(existsSync(`${sessionPath}.2.exit`)).toBe(false);
  });

  it.each([
    '01.exit',
    '+1.exit',
    '-1.exit',
    '4294967296.exit',
    '2.trace',
    'exit.backup',
    'log.partial'
  ])(
    'rejects malformed claimed archive name %s before any publication or pruning',
    async (suffix) => {
      const sessionPath = join(root, `codex-malformed-${suffix.replaceAll('.', '-')}`);
      const claimed = `${sessionPath}.${suffix}`;
      mkdirSync(claimed, { mode: 0o700 });
      writeFileSync(join(claimed, 'keep'), suffix, { mode: 0o600 });
      writeStore(`${sessionPath}.exit`, 3, 3, lifecycleBody(sessionPath, 3));

      await expect(archiveMoorGenerationStores(sessionPath, 4)).rejects.toThrow(
        'invalid Moor generation archive name'
      );

      expect(readFileSync(join(claimed, 'keep'), 'utf8')).toBe(suffix);
      expect(existsSync(`${sessionPath}.3.exit`)).toBe(false);
      expect(existsSync(moorGenerationArchiveLockPath(sessionPath))).toBe(false);
    }
  );

  it('detects a prune leaf swap before unlinking the replacement', async () => {
    const sessionPath = join(root, 'codex-prune-leaf-race');
    for (let generation = 2; generation <= 10; generation += 1) {
      writeStore(
        `${sessionPath}.${generation}.exit`,
        3,
        generation,
        lifecycleBody(sessionPath, generation)
      );
      writeStore(
        `${sessionPath}.${generation}.log`,
        2,
        generation,
        encoder.encode(`log ${generation}\n`)
      );
    }
    let swapped = false;
    await expect(
      archiveMoorGenerationStores(sessionPath, 11, {
        beforePruneUnlink: ({ generation, kind, path }) => {
          if (swapped || generation !== 2 || kind !== 'log') return;
          swapped = true;
          renameSync(path, `${path}.original`);
          writeFileSync(path, 'foreign-prune-winner', { mode: 0o600 });
        }
      })
    ).rejects.toThrow(/archive identity changed|unexpected Moor store entry/u);

    expect(readFileSync(`${sessionPath}.2.log/body.1`, 'utf8')).toBe(
      'foreign-prune-winner'
    );
    expect(existsSync(`${sessionPath}.2.log/body.1.original`)).toBe(true);
    expect(existsSync(`${sessionPath}.2.exit`)).toBe(true);
  });

  it('detects a prune directory swap before rmdir and preserves the replacement', async () => {
    const sessionPath = join(root, 'codex-prune-directory-race');
    for (let generation = 2; generation <= 10; generation += 1) {
      writeStore(
        `${sessionPath}.${generation}.exit`,
        3,
        generation,
        lifecycleBody(sessionPath, generation)
      );
      writeStore(
        `${sessionPath}.${generation}.log`,
        2,
        generation,
        encoder.encode(`log ${generation}\n`)
      );
    }
    const displaced = `${sessionPath}.2.log.displaced`;
    let swapped = false;
    await expect(
      archiveMoorGenerationStores(sessionPath, 11, {
        beforePruneDirectoryRemove: ({ generation, kind, path }) => {
          if (swapped || generation !== 2 || kind !== 'log') return;
          swapped = true;
          renameSync(path, displaced);
          mkdirSync(path, { mode: 0o700 });
        }
      })
    ).rejects.toThrow(/identity changed/u);

    expect(existsSync(`${sessionPath}.2.log`)).toBe(true);
    expect(readdirSync(`${sessionPath}.2.log`)).toEqual([]);
    expect(readdirSync(displaced)).toEqual([]);
    expect(existsSync(`${sessionPath}.2.exit`)).toBe(true);
  });

  it('refuses a foreign archive before publishing or pruning any validated store', async () => {
    const sessionPath = join(root, 'codex-inventory');
    const foreignBody = lifecycleBody(join(root, 'foreign-owner'), 2);
    writeStore(`${sessionPath}.2.exit`, 3, 2, foreignBody);
    writeStore(`${sessionPath}.exit`, 3, 3, lifecycleBody(sessionPath, 3));
    writeStore(`${sessionPath}.log`, 2, 3, encoder.encode('generation three\n'));

    await expect(archiveMoorGenerationStores(sessionPath, 4)).rejects.toThrow(
      'belongs to another session'
    );

    expect(readFileSync(`${sessionPath}.2.exit/body.0`)).toEqual(Buffer.from(foreignBody));
    expect(existsSync(`${sessionPath}.exit`)).toBe(true);
    expect(existsSync(`${sessionPath}.log`)).toBe(true);
    expect(existsSync(`${sessionPath}.3.exit`)).toBe(false);
  });

  it('does not prune an archive with a non-exact commit slot', async () => {
    const sessionPath = join(root, 'codex-malformed-store');
    const malformedPath = `${sessionPath}.2.exit`;
    writeStore(malformedPath, 3, 2, lifecycleBody(sessionPath, 2));
    const malformedCommit = readFileSync(join(malformedPath, 'commit.0'));
    writeFileSync(
      join(malformedPath, 'commit.0'),
      Buffer.concat([malformedCommit, Buffer.from([0])])
    );
    writeStore(`${sessionPath}.exit`, 3, 3, lifecycleBody(sessionPath, 3));
    writeStore(`${sessionPath}.log`, 2, 3, encoder.encode('generation three\n'));

    await expect(archiveMoorGenerationStores(sessionPath, 4)).rejects.toThrow();

    expect(readFileSync(join(malformedPath, 'commit.0'))).toHaveLength(93);
    expect(existsSync(`${sessionPath}.exit`)).toBe(true);
    expect(existsSync(`${sessionPath}.log`)).toBe(true);
    expect(existsSync(`${sessionPath}.3.exit`)).toBe(false);
  });

  it('aborts the real spawn path on archive failure before invoking the Moor launcher', async () => {
    const sessionId = 'codex-launch-fence';
    const sessionPath = join(root, sessionId);
    // This case exercises a REAL spawn that must allocate generation 2 and then
    // abort at archival; the rendezvous therefore has to clear the absolute
    // sun_path ceiling so the capacity guard does not refuse it first. Assert
    // the fixture is within the macOS ceiling (103 bytes) so this stays the
    // archive-failure seam and never silently degrades into a capacity refusal.
    expect(Buffer.byteLength(sessionPath, 'utf8')).toBeLessThanOrEqual(103);
    const unownedLog = encoder.encode('must remain stable\n');
    writeStore(`${sessionPath}.log`, 2, 1, unownedLog);
    const launchMarker = join(root, 'launcher-was-invoked');
    const fakeMoor = join(root, 'fake-moor');
    writeFileSync(
      fakeMoor,
      `#!/bin/sh\nprintf invoked > '${launchMarker}'\nexit 1\n`,
      { mode: 0o700 }
    );
    chmodSync(fakeMoor, 0o700);
    const daemon = createTerminalDaemon({
      homeRoot: root,
      moorBinPath: fakeMoor,
      moorSocketRoot: root,
      httpServer: new FakeUpgradeServer()
    });

    await expect(
      daemon.provision(sessionId, {
        command: ['codex'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      })
    ).resolves.toEqual({ ok: false, reason: 'spawn-failed' });

    expect(existsSync(launchMarker)).toBe(false);
    expect(existsSync(sessionPath)).toBe(false);
    expect(readFileSync(`${sessionPath}.log/body.0`)).toEqual(Buffer.from(unownedLog));
    expect(
      readFileSync(join(root, '_engine', 'generation-ledger.json'), 'utf8')
    ).toContain(`{"s":"${sessionId}","g":2}\n`);
    daemon.dispose();
  });
});
