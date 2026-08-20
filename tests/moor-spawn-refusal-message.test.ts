import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import { InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor
} from '../src/shared/runtime/workerSupervisor.js';
import type { EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

function emulator(): EmulatorPort {
  return {
    write: () => {},
    flush: () => Promise.resolve(),
    resize: () => {},
    readTailText: () => [],
    serialize: () => '',
    cursor: () => ({ row: 0, col: 0 }),
    onEvent: () => () => {},
    dispose: () => {}
  };
}

function makeManager(): SessionManager {
  return new SessionManager({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: emulator },
    now: () => Date.now(),
    sendBrowser: () => {}
  });
}

function spawnAt(manager: SessionManager, sessionId: string, sessionPath: string) {
  return manager.spawnAndAttachMoor(sessionId, {
    binPath: '/usr/bin/false',
    binArgs: [],
    sessionPath,
    command: ['sleep', '30'],
    geometry: { rows: 24, cols: 80 },
    env: { ...process.env },
    killSpec: { binPath: '/usr/bin/true', args: [] }
  });
}

describe('spawn refusal carries the cause, not just spawn-failed', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('names the live holder occupying the rendezvous', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-refusal-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessionPath = join(root, 'busy');
    const listener: Server = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(sessionPath, resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));

    await expect(spawnAt(makeManager(), 'busy', sessionPath)).resolves.toEqual({
      ok: false,
      reason: 'spawn-failed',
      error: 'a live terminal holder already occupies this session name; use another name or stop that holder first'
    });
  });

  it('names a foreign non-socket object at the rendezvous', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-refusal-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessionPath = join(root, 'foreign');
    writeFileSync(sessionPath, '');

    await expect(spawnAt(makeManager(), 'foreign', sessionPath)).resolves.toEqual({
      ok: false,
      reason: 'spawn-failed',
      error: 'a foreign non-socket object occupies this session name; remove it manually or use another name'
    });
  });
});
