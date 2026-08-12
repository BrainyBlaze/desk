// desk#42 regression: a liveness probe that TIMES OUT (no connect, no error —
// a live-but-slow master under host load) must NEVER be treated as "no
// listener". The spawn path's tombstone reclaim used to unlink the rendezvous
// socket of a possibly-live session on exactly this signal; a deleted unix
// socket path cannot be re-linked, so the session became permanently
// unattachable. This drives the REAL production path (spawnAndAttach with an
// existing socket node) and mocks ONLY node:net.createConnection so the probe
// deterministically times out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createConnection: () => {
      // A socket that never connects and never errors: only its own timeout
      // fires — the exact signature of a live master too slow to accept().
      const timers: NodeJS.Timeout[] = [];
      const socket = {
        setTimeout(ms: number, cb: () => void) {
          timers.push(setTimeout(cb, 5));
          return socket;
        },
        once() {
          return socket;
        },
        on() {
          return socket;
        },
        removeAllListeners() {
          return socket;
        },
        destroy() {
          for (const t of timers) clearTimeout(t);
        }
      };
      return socket as unknown as import('node:net').Socket;
    }
  };
});

import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';

class NullEmu implements EmulatorPort {
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

describe('spawnAndAttach × indeterminate liveness probe (desk#42)', () => {
  let dir: string;
  let sockPath: string;
  let mgr: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sm-probe-'));
    sockPath = join(dir, 'victim.sock');
    // An existing rendezvous node whose owner cannot be reached in time. The
    // node KIND is irrelevant to the code under test (existsSync + probe).
    writeFileSync(sockPath, '');
    mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new NullEmu() },
      now: () => 1000,
      sendBrowser: () => {}
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the spawn and PRESERVES the socket node when the probe times out', async () => {
    expect(mgr.ensure('victim', { rows: 24, cols: 80 }).ok).toBe(true);
    const result = await mgr.spawnAndAttach('victim', {
      binPath: join(dir, 'no-such-binary'),
      args: [],
      sockPath,
      geometry: { rows: 24, cols: 80 },
      // The production reality for atch sessions: a detached launcher — the
      // ONLY path that owns the tombstone-reclaim branch.
      detached: true
    });
    expect(result).toMatchObject({ ok: false, reason: 'spawn-failed' });
    // The heart of desk#42: silence is not death — the rendezvous node of a
    // possibly-live master MUST survive an indeterminate probe.
    expect(existsSync(sockPath)).toBe(true);
  });
});
