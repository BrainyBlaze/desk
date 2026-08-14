// Does a RE-ADOPTED session publish the adopted status descriptor, and can the
// control plane still write to it?
//
// Measured on the live machine: after a daemon restart, seven of ten live
// sessions answered /control/moor-status with 404 "session has no live moor
// link" while their holders and children were alive and the state authority
// called them running/healthy. Reading their screens worked; input returned
// {"ok":true} and never reached the child.
//
// That observation was made against the build the machine happens to run
// (local 86b3b19). This file asks the same two questions of origin/main, in
// isolation, over a real fake holder — so the answer is about the code we are
// shipping rather than the code that happens to be installed.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GenerationLedger,
  InMemoryGenerationLedger
} from '../src/shared/controlPlane/index.js';
import {
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { reconcileExistingSessions } from '../src/server/runtime/terminalDaemonMain.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { fileURLToPath } from 'node:url';

const FAKE_MOOR = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
const FAKE_MOOR_ARGS = ['--import', 'tsx', FAKE_MOOR];

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition never held');
}

class FakeEmu implements EmulatorPort {
  write(): void {}
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
  onEvent(): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeManager(store: InMemoryGenerationLedger) {
  return new SessionManager({
    ledger: new GenerationLedger(store),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1000,
    sendBrowser: () => {}
  });
}

async function spawnFakeMoorHolder(
  sessionPath: string,
  storeDir: string,
  generation: number,
  command: string[],
  tmpdirRoot: string
): Promise<void> {
  const { child } = spawnMoorMaster({
    binPath: process.execPath,
    args: [...FAKE_MOOR_ARGS, 'start', '-T', storeDir, sessionPath, ...command],
    generation,
    env: { ...process.env, TMPDIR: tmpdirRoot }
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`fake moor launcher exited ${code}`);
}

async function killFakeMoorHolder(sessionPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [...FAKE_MOOR_ARGS, 'kill', sessionPath], {
      stdio: 'ignore'
    });
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}

describe('a re-adopted session is still addressable (desk#63 follow-up)', () => {
  it('publishes the adopted descriptor again and still accepts input after the daemon comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-readopt-'));
    const sock = join(dir, 'survivor');
    // The child writes whatever reaches its stdin to a file, so "input arrived"
    // is a fact on disk rather than an endpoint's opinion of its own success.
    const received = join(dir, 'received.txt');
    await spawnFakeMoorHolder(
      sock,
      join(moorEventStoreRoot(process.execPath, { tmpdir: dir }), 'survivor.events'),
      2,
      ['sh', '-c', `cat > ${received}`],
      dir
    );
    const targets = [
      { sessionId: 'survivor', sockPath: sock, subject: { kind: 'terminal' } as const }
    ];
    const store = new InMemoryGenerationLedger();
    new GenerationLedger(store).allocate('survivor');
    try {
      // --- incarnation 1 ----------------------------------------------------
      const one = makeManager(store);
      await reconcileExistingSessions(
        { router: { sessions: one } } as never,
        targets,
        '/usr/bin/true'
      );
      // The baseline the operator relies on: an adopted session is addressable.
      expect(one.moorStatus('survivor')).toBeDefined();
      one.closeAllLinks(); // the daemon departs; the holder survives

      // --- incarnation 2: the daemon comes back and re-adopts ---------------
      const two = makeManager(store);
      const results = await reconcileExistingSessions(
        { router: { sessions: two } } as never,
        targets,
        '/usr/bin/true'
      );
      expect(results).toEqual([{ sessionId: 'survivor', ok: true }]);

      // A session that survived the restart must be exactly as addressable as
      // one that did not. If this descriptor is missing, the control plane
      // reports "no live moor link" for a session that is alive — and every
      // caller that reads that as "no holder" is then wrong about it.
      expect(two.moorStatus('survivor')).toBeDefined();

      // And the half the live machine actually failed: input must REACH the
      // child. The control endpoint answers with `accepted`, which on the live
      // machine was true for bytes that never arrived — so acceptance is not
      // the assertion here; the child's own file is.
      expect(two.injectInput('survivor', new TextEncoder().encode('READOPTED-INPUT\n'))).toBe(
        true
      );
      await waitFor(() => existsSync(received) && readFileSync(received, 'utf8').includes('READOPTED-INPUT'));
    } finally {
      await killFakeMoorHolder(sock);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
