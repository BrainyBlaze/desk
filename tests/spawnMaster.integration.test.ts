// Daemon-side spawn contract (spec §4.8.1 / §5.3). The daemon spawns the atch
// master injecting ATCH_GENERATION = the durable-ledger generation. This proves
// the ledger value reaches the master's env AND survives retire+respawn (never
// reset), plus that spawn→attach completes over a real socket. Uses a codec-free
// fake atch (fixtures/fake-atch.mjs) run under node.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('spawns atch with ATCH_GENERATION = the ledger generation, and survives respawn', async () => {
    const sock1 = join(dir, 's1a.sock');
    const gen1 = join(dir, 'gen1.txt');
    const ens1 = await mgr.spawnAndAttach('s1', { binPath: process.execPath, args: [FAKE_ATCH, sock1, gen1], sockPath: sock1, geometry: { rows: 40, cols: 120 }, readyTimeoutMs: 4000 });
    expect(ens1.ok).toBe(true);
    if (ens1.ok) expect(ens1.generation).toBe(1);
    expect(readFileSync(gen1, 'utf8')).toBe('1'); // ledger generation injected into the master env

    // retire + respawn the SAME sessionId → the ledger tombstone gives generation 2,
    // and that (not a reset to 1) is what the daemon injects.
    mgr.retire('s1');
    const sock2 = join(dir, 's1b.sock');
    const gen2 = join(dir, 'gen2.txt');
    const ens2 = await mgr.spawnAndAttach('s1', { binPath: process.execPath, args: [FAKE_ATCH, sock2, gen2], sockPath: sock2, geometry: { rows: 40, cols: 120 }, readyTimeoutMs: 4000 });
    expect(ens2.ok).toBe(true);
    if (ens2.ok) expect(ens2.generation).toBe(2);
    expect(readFileSync(gen2, 'utf8')).toBe('2'); // NOT reset to 1 — the fence stays sound across the join
  });

  it('spawnMaster rejects if the binary exits before the socket appears', async () => {
    await expect(
      spawnMaster({ binPath: process.execPath, args: ['-e', 'process.exit(3)'], sockPath: join(dir, 'never.sock'), generation: 1, readyTimeoutMs: 2000 })
    ).rejects.toThrow(/exited before/);
  });
});
