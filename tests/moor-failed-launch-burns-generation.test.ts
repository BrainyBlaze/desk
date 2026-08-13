/**
 * A failed launch BURNS its generation — the retry never gets it back.
 *
 * moor#9 requires the ledger to fsync an allocation BEFORE the spawn, so that
 * a crash between the two can never reissue a generation (§4.8.1). The
 * consequence that matters operationally is the one this file pins: when a
 * launch fails, the generation it consumed is spent. A retry must climb to the
 * next one, because the failed attempt may have left a holder that published
 * late, and a reused generation would let that straggler answer for its
 * successor — exactly the fencing the supervised range exists to prevent.
 *
 * Until now this was asserted nowhere. The only trace of it was a parenthetical
 * in the coalescing test ("a second spawn would have burned generation 3"),
 * which describes a spawn that deliberately never happened. A comment about a
 * path not taken is not coverage, so moor#9 stays open on the strength of it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import { InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor
} from '../src/shared/runtime/workerSupervisor.js';
import type { EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
const NODE_IMPORT_ARGS = ['--import', 'tsx', FAKE];

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

function makeManager(ledger: GenerationLedger): SessionManager {
  return new SessionManager({
    ledger,
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: emulator },
    now: () => Date.now(),
    sendBrowser: () => {}
  });
}

/** A launcher that cannot possibly come up: it exits nonzero immediately. */
const DOOMED_LAUNCHER = '/usr/bin/false';

describe('moor#9: a failed launch burns its generation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  it('spends the allocation on failure and hands the retry a HIGHER generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-burn-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const manager = makeManager(ledger);

    // Nothing has ever been allocated for this lineage, so the first
    // supervised generation is 2 (1 is reserved for unsupervised holders).
    expect(ledger.current('b1')).toBe(0);

    const failed = await manager
      .spawnAndAttachMoor('b1', {
        binPath: DOOMED_LAUNCHER,
        binArgs: [],
        sessionPath: join(root, 'b1'),
        command: ['sleep', '30'],
        geometry: { rows: 24, cols: 80 },
        env: { ...process.env, TMPDIR: root },
        killSpec: { binPath: '/usr/bin/true', args: [] }
      })
      .catch(() => ({ ok: false as const }));
    expect(failed.ok).toBe(false);

    // The allocation was committed BEFORE the spawn, so it survives the
    // failure. This is the whole point: a generation the ledger has issued is
    // gone whether or not anything came up on it.
    expect(ledger.current('b1')).toBe(2);
    // And the next attempt must be handed 3 — never the 2 that just failed.
    expect(ledger.next('b1')).toBe(3);

    const retried = await manager.spawnAndAttachMoor('b1', {
      binPath: process.execPath,
      binArgs: NODE_IMPORT_ARGS,
      sessionPath: join(root, 'b1'),
      command: ['sleep', '30'],
      geometry: { rows: 24, cols: 80 },
      env: { ...process.env, TMPDIR: root },
      killSpec: { binPath: '/usr/bin/true', args: [] }
    });
    expect(retried.ok).toBe(true);
    // The literal is pinned deliberately: asserting against ledger.current()
    // would agree with itself no matter which generation the retry took.
    expect(ledger.current('b1')).toBe(3);

    const retired = await manager.retireAwaited('b1');
    expect(retired.ok).toBe(true);
  }, 30_000);

  it('burns one generation per failure, so repeated failures never plateau', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moor-burn-repeat-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const manager = makeManager(ledger);

    for (const expected of [2, 3, 4]) {
      const attempt = await manager
        .spawnAndAttachMoor('b2', {
          binPath: DOOMED_LAUNCHER,
          binArgs: [],
          sessionPath: join(root, 'b2'),
          command: ['sleep', '30'],
          geometry: { rows: 24, cols: 80 },
          env: { ...process.env, TMPDIR: root },
          killSpec: { binPath: '/usr/bin/true', args: [] }
        })
        .catch(() => ({ ok: false as const }));
      expect(attempt.ok).toBe(false);
      expect(ledger.current('b2')).toBe(expected);
    }
  }, 30_000);
});
