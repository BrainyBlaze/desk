import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyManifest,
  readManifestFile,
  updateManifestFile,
  writeManifestFile
} from '../src/core/config.js';

const CONFIG_SOURCE = pathToFileURL(resolve(process.cwd(), 'src/core/config.ts')).href;

const UPDATE_WORKER_SOURCE = `
import { updateManifestFile, addSessionToManifest } from '${CONFIG_SOURCE}';
const manifestPath = process.argv[2];
const id = process.argv[3];
await updateManifestFile(manifestPath, async (manifest) => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return addSessionToManifest(manifest, {
    groupId: 'workers',
    session: { name: id, command: 'bash' }
  });
});
`;

const TEMP_WRITE_WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
Date.now = () => 1_700_000_000_000;
const { writeManifestFile } = await import('${CONFIG_SOURCE}');
const gate = new Int32Array(workerData.gate);
Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
while (Atomics.load(gate, 1) === 0) {
  Atomics.wait(gate, 1, 0);
}
try {
  writeManifestFile(workerData.manifestPath, {
    groups: [{
      id: 'worker-' + workerData.id,
      label: String(workerData.id).repeat(1_000_000),
      sessions: []
    }]
  });
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
`;

const homes = new Set<string>();

afterEach(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
  homes.clear();
});

function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.add(home);
  return home;
}

describe('manifest file transactions', () => {
  it('does not lose updates across concurrent processes', async () => {
    const home = tempHome('desk-manifest-race-');
    const manifestPath = join(home, 'desk.yml');
    const workerPath = join(home, 'update-worker.mjs');
    writeManifestFile(manifestPath, createEmptyManifest());
    writeFileSync(workerPath, UPDATE_WORKER_SOURCE);

    const workerCount = 12;
    const exits = await Promise.all(
      Array.from({ length: workerCount }, (_, index) =>
        new Promise<number | null>((resolveExit) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', workerPath, manifestPath, `session-${index}`],
            { stdio: 'pipe' }
          );
          child.on('exit', resolveExit);
        })
      )
    );

    expect(exits).toEqual(Array.from({ length: workerCount }, () => 0));
    const sessions = readManifestFile(manifestPath).groups.find((group) => group.id === 'workers')?.sessions ?? [];
    expect(sessions.map((session) => session.name).sort()).toEqual(
      Array.from({ length: workerCount }, (_, index) => `session-${index}`).sort()
    );
  }, 20_000);

  it('supports an async no-op update without rewriting the manifest', async () => {
    const home = tempHome('desk-manifest-noop-');
    const manifestPath = join(home, 'desk.yml');
    writeManifestFile(manifestPath, createEmptyManifest());
    const before = readManifestFile(manifestPath);

    const result = await updateManifestFile(manifestPath, async () => null);

    expect(result).toBeNull();
    expect(readManifestFile(manifestPath)).toEqual(before);
  });

  it.skipIf(process.versions.node.startsWith('22.'))('uses collision-proof temp files for concurrent writes in one process', async () => {
    const home = tempHome('desk-manifest-temp-');
    const manifestPath = join(home, 'desk.yml');
    const workerPath = join(home, 'temp-worker.mjs');
    writeFileSync(workerPath, TEMP_WRITE_WORKER_SOURCE);
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const state = new Int32Array(gate);
    const workerCount = 8;

    const workers = Array.from({ length: workerCount }, (_, id) =>
      new Worker(workerPath, {
        execArgv: ['--import', 'tsx'],
        workerData: { gate, id, manifestPath }
      })
    );
    while (Atomics.load(state, 0) < workerCount) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1, workerCount);

    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ ok: boolean; error?: string }>((resolveResult, reject) => {
            worker.once('message', resolveResult);
            worker.once('error', reject);
          })
      )
    );

    expect(results).toEqual(Array.from({ length: workerCount }, () => ({ ok: true })));
    expect(readManifestFile(manifestPath).groups[0]?.id).toMatch(/^worker-/);
    expect(readdirSync(home).filter((name) => name.startsWith('desk.yml.tmp-'))).toEqual([]);
  }, 60_000);
});
