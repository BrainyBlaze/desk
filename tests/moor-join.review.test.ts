import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MoorMasterClient } from '../src/server/runtime/moorMasterClient.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import {
  decodeMoorEventSnapshot,
  MoorStoreKind,
  readMoorStoreSnapshot,
  type MoorCommit
} from '../src/server/runtime/moorStore.js';
import {
  DESK_MOOR_LAUNCH_CHANNEL,
  DESK_SESSION_GENERATION,
  encodeMoorLaunchRecord,
  moorGenerationEnvKey
} from '../src/server/runtime/moorLaunchChannel.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
const NODE_ARGS = ['--import', 'tsx', FAKE];
const GENERATION = 7;

function awaitExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function fakeStoreDir(root: string): string {
  return join(moorEventStoreRoot(process.execPath, { tmpdir: root }), 'events');
}

function fakeSpawnEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: root };
}

async function cleanupFake(sessionPath: string): Promise<void> {
  const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
  await awaitExit(kill);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rm = spawn(process.execPath, [...NODE_ARGS, 'rm', sessionPath], { stdio: 'ignore' });
  await awaitExit(rm);
}

function decodeCommitRecord(bytes: Uint8Array, slot: 0 | 1): MoorCommit {
  if (bytes.byteLength !== 92) throw new Error(`expected a 92-byte commit, got ${bytes.byteLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    slot,
    bodySlot: view.getUint8(10) as 0 | 1,
    kind: view.getUint8(11) as MoorStoreKind,
    generation: view.getUint32(12, true),
    epoch: view.getUint32(16, true),
    index: view.getBigUint64(24, true),
    length: view.getBigUint64(32, true),
    start: view.getBigUint64(40, true),
    end: view.getBigUint64(48, true),
    hash: bytes.slice(56, 88)
  };
}

function launchFakeWithRecord(
  sessionPath: string,
  record: Uint8Array,
  carrierKey = moorGenerationEnvKey(process.execPath)
): ReturnType<typeof spawn> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.endsWith('_GENERATION')) delete env[key];
  }
  env[DESK_MOOR_LAUNCH_CHANNEL] = '3';
  env[DESK_SESSION_GENERATION] = String(GENERATION);
  env[carrierKey] = String(GENERATION);
  const child = spawn(
    process.execPath,
    [...NODE_ARGS, 'start', sessionPath, 'sleep', '30'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env }
  );
  const channel = child.stdio[3] as Writable | null;
  if (channel === null) throw new Error('fake launch channel was not created');
  channel.end(Buffer.from(record));
  return child;
}

describe('fake Moor holder launch-gate fidelity', () => {
  it('commits the canonical empty event snapshot before publishing ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-initial-store-'));
    const sessionPath = join(root, 'session');
    const storeDir = fakeStoreDir(root);

    let launchExitCode = -1;
    let initialState: object | undefined;
    let readyState: object | undefined;
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', '-T', storeDir, sessionPath, 'sleep', '30'],
        generation: GENERATION,
        env: fakeSpawnEnv(root)
      });
      launchExitCode = await awaitExit(launch.child);
      const initialBody = readFileSync(join(storeDir, 'body.0'));
      const initialCommit = decodeCommitRecord(readFileSync(join(storeDir, 'commit.0')), 0);
      const initial = decodeMoorEventSnapshot(initialBody, initialCommit);
      initialState = {
        epoch: initial.epoch,
        firstRetained: initial.firstRetained,
        nextSequence: initial.nextSequence,
        commitIndex: initial.commitIndex,
        records: initial.records.length
      };

      const selected = await readMoorStoreSnapshot(storeDir, MoorStoreKind.Event, GENERATION);
      const ready = decodeMoorEventSnapshot(selected.bytes, selected.commit);
      readyState = {
        epoch: ready.epoch,
        firstRetained: ready.firstRetained,
        nextSequence: ready.nextSequence,
        commitIndex: ready.commitIndex,
        records: ready.records.map((record) => ({
          type: record.type,
          epoch: record.epoch,
          sequence: record.sequence
        }))
      };
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: launchExitCode === 0, initialState, readyState }).toEqual({
      launchSucceeded: true,
      initialState: {
        epoch: 0,
        firstRetained: 0n,
        nextSequence: 0n,
        commitIndex: 1n,
        records: 0
      },
      readyState: {
        epoch: 0,
        firstRetained: 0n,
        nextSequence: 1n,
        commitIndex: 2n,
        records: [{ type: 'ready', epoch: 0, sequence: 0n }]
      }
    });
  }, 15_000);

  it('rejects a pre-existing event-store slot without truncating it or publishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-store-'));
    const sessionPath = join(root, 'session');
    const storeDir = fakeStoreDir(root);
    const sentinelPath = join(storeDir, 'body.0');
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    writeFileSync(sentinelPath, 'do-not-overwrite', { mode: 0o600 });

    let exitCode = -1;
    let published = false;
    let sentinel = '';
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', '-T', storeDir, sessionPath, 'sleep', '30'],
        generation: GENERATION,
        env: fakeSpawnEnv(root)
      });
      exitCode = await awaitExit(launch.child);
      published = existsSync(sessionPath);
      sentinel = readFileSync(sentinelPath, 'utf8');
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: exitCode === 0, published, sentinel }).toEqual({
      launchSucceeded: false,
      published: false,
      sentinel: 'do-not-overwrite'
    });
  }, 15_000);

  it('rejects a nonempty event-store directory without publishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-nonempty-store-'));
    const sessionPath = join(root, 'session');
    const storeDir = fakeStoreDir(root);
    const sentinelPath = join(storeDir, 'unrelated-entry');
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    writeFileSync(sentinelPath, 'preserve-me', { mode: 0o600 });

    let exitCode = -1;
    let published = false;
    let sentinel = '';
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', '-T', storeDir, sessionPath, 'sleep', '30'],
        generation: GENERATION,
        env: fakeSpawnEnv(root)
      });
      exitCode = await awaitExit(launch.child);
      published = existsSync(sessionPath);
      sentinel = readFileSync(sentinelPath, 'utf8');
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: exitCode === 0, published, sentinel }).toEqual({
      launchSucceeded: false,
      published: false,
      sentinel: 'preserve-me'
    });
  }, 15_000);

  it('does not report ready when the requested child cannot be spawned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-child-'));
    const sessionPath = join(root, 'session');
    const missingCommand = join(root, 'definitely-not-an-executable');

    let exitCode = -1;
    let published = false;
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', sessionPath, missingCommand],
        generation: GENERATION,
        env: { ...process.env }
      });
      exitCode = await awaitExit(launch.child);
      published = existsSync(sessionPath);
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: exitCode === 0, published }).toEqual({
      launchSucceeded: false,
      published: false
    });
  }, 15_000);

  it('rejects nonzero reserved bytes in the fd-3 launch record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-record-'));
    const sessionPath = join(root, 'session');
    const record = encodeMoorLaunchRecord(GENERATION, new Uint8Array(16).fill(0x5a));
    record[9] = 1;

    let exitCode = -1;
    let published = false;
    try {
      exitCode = await awaitExit(launchFakeWithRecord(sessionPath, record));
      published = existsSync(sessionPath);
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: exitCode === 0, published }).toEqual({
      launchSucceeded: false,
      published: false
    });
  }, 15_000);

  it('requires the invocation-derived generation carrier rather than any matching suffix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-carrier-'));
    const sessionPath = join(root, 'session');
    const record = encodeMoorLaunchRecord(GENERATION, new Uint8Array(16).fill(0x6b));

    let exitCode = -1;
    let published = false;
    try {
      exitCode = await awaitExit(launchFakeWithRecord(sessionPath, record, 'WRONG_GENERATION'));
      published = existsSync(sessionPath);
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: exitCode === 0, published }).toEqual({
      launchSucceeded: false,
      published: false
    });
  }, 15_000);
});

describe('fake Moor lifecycle fidelity', () => {
  it('reports kill against a session that is not live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-kill-'));
    const sessionPath = join(root, 'missing-session');
    try {
      const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
      expect(await awaitExit(kill)).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to remove a live session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-rm-'));
    const sessionPath = join(root, 'session');

    let launchExitCode = -1;
    let rmExitCode = -1;
    let published = false;
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', sessionPath, 'sleep', '30'],
        generation: GENERATION,
        env: { ...process.env }
      });
      launchExitCode = await awaitExit(launch.child);

      const rm = spawn(process.execPath, [...NODE_ARGS, 'rm', sessionPath], { stdio: 'ignore' });
      rmExitCode = await awaitExit(rm);
      published = existsSync(sessionPath);
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: launchExitCode === 0, rmSucceeded: rmExitCode === 0, published }).toEqual({
      launchSucceeded: true,
      rmSucceeded: false,
      published: true
    });
  }, 15_000);

  it('commits the child exit transition before kill returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-exit-'));
    const sessionPath = join(root, 'session');
    const storeDir = fakeStoreDir(root);

    let launchExitCode = -1;
    let killExitCode = -1;
    let records: object[] = [];
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [...NODE_ARGS.slice(0, 2), FAKE, 'start', '-T', storeDir, sessionPath, 'sleep', '30'],
        generation: GENERATION,
        env: fakeSpawnEnv(root)
      });
      launchExitCode = await awaitExit(launch.child);

      const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', sessionPath], { stdio: 'ignore' });
      killExitCode = await awaitExit(kill);

      const deadline = Date.now() + 1_000;
      do {
        const selected = await readMoorStoreSnapshot(storeDir, MoorStoreKind.Event, GENERATION);
        const snapshot = decodeMoorEventSnapshot(selected.bytes, selected.commit);
        records = snapshot.records.map((record) => ({
          type: record.type,
          ended: record.value.ended,
          signal: record.value.signal
        }));
        if (records.some((record) => (record as { type?: string }).type === 'exit')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
    } finally {
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ launchSucceeded: launchExitCode === 0, killSucceeded: killExitCode === 0, records }).toEqual({
      launchSucceeded: true,
      killSucceeded: true,
      records: [
        { type: 'ready', ended: undefined, signal: undefined },
        { type: 'exit', ended: 'signalled', signal: 15 }
      ]
    });
  }, 15_000);

  it('force-kills and reaps a child that ignores SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-force-'));
    const sessionPath = join(root, 'session');
    const childPidPath = join(root, 'child.pid');
    const ignoreTerm = [
      "const fs = require('node:fs');",
      'fs.writeFileSync(process.argv[1], String(process.pid));',
      "process.on('SIGTERM', () => undefined);",
      'setInterval(() => undefined, 1000);'
    ].join(' ');

    let childPid: number | undefined;
    let forceKillExitCode = -1;
    let childAlive = false;
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [
          ...NODE_ARGS.slice(0, 2),
          FAKE,
          'start',
          sessionPath,
          process.execPath,
          '-e',
          ignoreTerm,
          childPidPath
        ],
        generation: GENERATION,
        env: { ...process.env }
      });
      expect(await awaitExit(launch.child)).toBe(0);
      await waitFor(() => existsSync(childPidPath), 'SIGTERM-resistant child pid file');
      childPid = Number(readFileSync(childPidPath, 'utf8'));

      const kill = spawn(process.execPath, [...NODE_ARGS, 'kill', '-f', sessionPath], {
        stdio: 'ignore'
      });
      forceKillExitCode = await awaitExit(kill);
      try {
        process.kill(childPid, 0);
        childAlive = true;
      } catch {
        childAlive = false;
      }
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      await cleanupFake(sessionPath);
      rmSync(root, { recursive: true, force: true });
    }

    expect({ killSucceeded: forceKillExitCode === 0, childAlive }).toEqual({
      killSucceeded: true,
      childAlive: false
    });
  }, 15_000);
});

describe('fake Moor input-receipt fidelity', () => {
  it('refuses input when the child has closed stdin instead of acknowledging queued bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-join-review-input-'));
    const sessionPath = join(root, 'session');
    const childPidPath = join(root, 'child.pid');
    const closeStdin = [
      "const fs = require('node:fs');",
      'fs.writeFileSync(process.argv[1], String(process.pid));',
      'fs.closeSync(0);',
      'setInterval(() => undefined, 1000);'
    ].join(' ');

    let childPid: number | undefined;
    let client: MoorMasterClient | undefined;
    const receipts: Array<{ written: bigint; status: number; result: number }> = [];
    try {
      const launch = spawnMoorMaster({
        binPath: process.execPath,
        args: [
          ...NODE_ARGS.slice(0, 2),
          FAKE,
          'start',
          sessionPath,
          process.execPath,
          '-e',
          closeStdin,
          childPidPath
        ],
        generation: GENERATION,
        env: { ...process.env }
      });
      expect(await awaitExit(launch.child)).toBe(0);
      await waitFor(() => existsSync(childPidPath), 'child pid file');
      childPid = Number(readFileSync(childPidPath, 'utf8'));

      client = new MoorMasterClient(sessionPath, GENERATION, {
        onInputReceipt: (receipt) => {
          receipts.push({ written: receipt.written, status: receipt.status, result: receipt.result });
        }
      });
      await client.connect();
      await client.attach({ columns: 80, rows: 24, requestLease: true });
      client.sendInput(new Uint8Array([1, 2, 3]));
      await waitFor(() => receipts.length > 0, 'input refusal', 1_000).catch(() => undefined);
    } finally {
      client?.close();
      await cleanupFake(sessionPath);
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({ written: 0n, status: 1, result: expect.any(Number) });
    expect(receipts[0]!.result).toBeGreaterThan(0);
  }, 15_000);
});
