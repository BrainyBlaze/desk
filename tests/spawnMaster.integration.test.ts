// Daemon-side spawn contract (spec §4.8.1 / §5.3). The daemon spawns the atch
// master injecting ATCH_GENERATION = the durable-ledger generation. This proves
// the ledger value reaches the master's env AND survives retire+respawn (never
// reset), plus that spawn→attach completes over a real socket. Uses a codec-free
// fake atch (fixtures/fake-atch.mjs) run under node.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';

const FAKE_ATCH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-atch.mjs');

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
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

describe('daemon spawn contract — ATCH_GENERATION from the ledger (§4.8.1)', () => {
  let dir: string;
  let mgr: SessionManager;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spawn-'));
    mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000,
      sendBrowser: () => {}
    });
  });
  afterEach(() => {
    mgr.retire('s1');
    mgr.retire('s-fail');
    rmSync(dir, { recursive: true, force: true });
  });

  it('spawns atch with matching wire and semantic generations, and survives respawn', async () => {
    const sock1 = join(dir, 's1a.sock');
    const gen1 = join(dir, 'gen1.txt');
    const ens1 = await mgr.spawnAndAttach('s1', { binPath: process.execPath, args: [FAKE_ATCH, sock1, gen1], sockPath: sock1, geometry: { rows: 40, cols: 120 }, readyTimeoutMs: 4000 });
    expect(ens1.ok).toBe(true);
    if (ens1.ok) expect(ens1.generation).toBe(1);
    expect(readFileSync(gen1, 'utf8')).toBe('1:1'); // one ledger value fences wire + semantic producers

    // retire + respawn the SAME sessionId → the ledger tombstone gives generation 2,
    // and that (not a reset to 1) is what the daemon injects.
    mgr.retire('s1');
    const sock2 = join(dir, 's1b.sock');
    const gen2 = join(dir, 'gen2.txt');
    const ens2 = await mgr.spawnAndAttach('s1', { binPath: process.execPath, args: [FAKE_ATCH, sock2, gen2], sockPath: sock2, geometry: { rows: 40, cols: 120 }, readyTimeoutMs: 4000 });
    expect(ens2.ok).toBe(true);
    if (ens2.ok) expect(ens2.generation).toBe(2);
    expect(readFileSync(gen2, 'utf8')).toBe('2:2'); // NOT reset to 1 — both fences stay aligned
  });

  it('spawnMaster rejects if the binary exits before the socket appears', async () => {
    await expect(
      spawnMaster({ binPath: process.execPath, args: ['-e', 'process.exit(3)'], sockPath: join(dir, 'never.sock'), generation: 1, readyTimeoutMs: 2000 })
    ).rejects.toThrow(/exited before/);
  });

  it('runs generation-aware preparation before spawn and uses its args and env', async () => {
    const sock = join(dir, 'prepared.sock');
    const genOut = join(dir, 'prepared-generation.txt');
    const prepOut = join(dir, 'prepared-values.json');
    let observedGeneration = 0;

    const result = await mgr.spawnAndAttach('s1', {
      binPath: process.execPath,
      args: [FAKE_ATCH, sock, genOut],
      sockPath: sock,
      geometry: { rows: 24, cols: 80 },
      readyTimeoutMs: 4_000,
      prepareSpawn: async ({ generation, args }) => {
        observedGeneration = generation;
        expect(mgr.stateSnapshot('s1')?.generation).toBe(generation);
        expect(existsSync(genOut)).toBe(false);
        return {
          args: [...args, 'prepared-arg'],
          env: { FAKE_ATCH_PREP_OUT: prepOut, PREPARED_MARKER: 'prepared-env' }
        };
      }
    });

    expect(result).toMatchObject({ ok: true, generation: 1 });
    expect(observedGeneration).toBe(1);
    expect(JSON.parse(readFileSync(prepOut, 'utf8'))).toEqual({
      marker: 'prepared-env',
      extraArg: 'prepared-arg'
    });
  });

  it('does not spawn and releases a newly allocated slot when preparation fails', async () => {
    const sock = join(dir, 'must-not-exist.sock');
    const genOut = join(dir, 'must-not-exist.txt');

    const result = await mgr.spawnAndAttach('s-fail', {
      binPath: process.execPath,
      args: [FAKE_ATCH, sock, genOut],
      sockPath: sock,
      geometry: { rows: 24, cols: 80 },
      prepareSpawn: async () => {
        throw new Error('sink preparation failed');
      }
    });

    expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(genOut)).toBe(false);
    expect(mgr.sessionCount).toBe(0);
  });
});
