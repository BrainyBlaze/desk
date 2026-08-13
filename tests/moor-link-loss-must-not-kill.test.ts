/**
 * Losing the controller link is not evidence that the holder died.
 *
 * On 2026-08-13 at 21:26:53 thirteen healthy agents were killed in one second.
 * A ~7 s pause in event processing (measured: one event observed at
 * 21:26:46.466 was accepted only at 21:26:53.600, against a 0.4 s norm) let the
 * 10 s lease lapse; moor refused the overdue keepalive with LEASE_NOT_HELD and
 * closed its side; Desk read that close as the session's death, recorded an
 * exit it knew nothing about, and force-killed a child that was still running.
 *
 * The holders' own records prove the children were alive until that moment:
 * every one ends `signalled` with signal 9, delivered by the holder on Desk's
 * order, while Desk's transition carries a null code and a null signal.
 *
 * So a close may retire a session ONLY when a bounded identity probe has
 * positively established that nothing is listening. Every other close means
 * detach and re-probe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import {
  GenerationLedger,
  InMemoryGenerationLedger
} from '../src/shared/controlPlane/index.js';
import type { EmulatorPort } from '../src/shared/runtime/emulatorPort.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor
} from '../src/shared/runtime/workerSupervisor.js';

type Handlers = {
  onClose?: () => void;
  onLivenessLost?: () => void;
  onLivenessRestored?: () => void;
};

const harness = vi.hoisted(() => ({
  handlers: undefined as Handlers | undefined,
  /** Resolvers for the bounded identity probe the manager arms on liveness loss. */
  probes: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
  /** Set before arming a probe to make the holder's socket refuse it. */
  probeConnect: 'ok' as 'ok' | 'refused',
  /** Closes of the ADOPTED link only — probe clients close themselves. */
  adoptionClosed: 0
}));

vi.mock('../src/server/runtime/moorMasterClient.js', () => ({
  MoorMasterClient: class {
    private readonly isProbe: boolean;

    constructor(_sessionPath: string, _generation: number, handlers: Handlers = {}) {
      // The adoption path installs the full handler set; the bounded identity
      // probe constructs a bare client, which is how the two are told apart.
      this.isProbe = handlers.onClose === undefined;
      if (handlers.onClose !== undefined) harness.handlers = handlers;
    }

    async connect(): Promise<void> {
      if (this.isProbe && harness.probeConnect === 'refused') {
        // Exactly what a vanished holder leaves behind: a bound path with
        // nobody accepting. This is the ONLY evidence that proves absence.
        const refused: NodeJS.ErrnoException = new Error('connect ECONNREFUSED');
        refused.code = 'ECONNREFUSED';
        throw refused;
      }
    }

    async attach(): Promise<{ generation: number }> {
      return { generation: 2 };
    }

    authenticate(): Promise<void> {
      return new Promise((resolve, reject) => {
        harness.probes.push({ resolve, reject });
      });
    }

    async clearLog(): Promise<{ outcome: number }> {
      return { outcome: 1 };
    }

    ackOutput(): void {}
    sendInput(): void {}
    sendResize(): void {}
    close(): void {
      if (!this.isProbe) harness.adoptionClosed += 1;
    }
  },
  posixMoorIdentity: () => new Uint8Array()
}));

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

async function adopted(): Promise<SessionManager> {
  const manager = new SessionManager({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 2 }),
    emulatorFactory: { create: emulator },
    now: () => Date.now(),
    sendBrowser: () => {}
  });
  expect(manager.ensure('s1', { rows: 24, cols: 80 })).toMatchObject({ ok: true, generation: 2 });
  await expect(
    manager.moorAttachMaster('s1', '/tmp/s1', { rows: 24, cols: 80 }, { generation: 2 })
  ).resolves.toBe(true);
  return manager;
}

describe('a lost controller link must not kill a live holder (desk#59)', () => {
  afterEach(() => {
    harness.handlers = undefined;
    harness.probes = [];
    harness.probeConnect = 'ok';
    harness.adoptionClosed = 0;
  });

  it('detaches instead of retiring when the link closes with no proof of absence', async () => {
    const manager = await adopted();

    // The exact production sequence of 21:26: the link closes on its own —
    // moor refused a keepalive that went overdue while Desk was paused. No
    // probe ran, so nothing established that the holder is gone.
    harness.handlers!.onClose!();

    const state = manager.stateSnapshot('s1');
    // The session MUST still be alive. A retire here records an exit whose
    // cause nobody knows and force-kills a running child.
    expect(state?.lifecycle).not.toBe('exited');
    expect(state?.exit ?? null).toBeNull();
    // Its holder is now of unknown liveness — that is what a lost link proves,
    // and it is all it proves.
    expect(state?.health).toMatchObject({ detail: 'controller-link-closed' });
  });

  it('retires only after a probe positively establishes that nothing listens', async () => {
    const manager = await adopted();

    // The holder's socket now refuses connections — it is gone.
    harness.probeConnect = 'refused';

    // Liveness lapses; the manager arms its bounded identity probe, which
    // reaches nothing and so PROVES absence. The manager then closes the link
    // itself, and that close — and only that one — ends the session.
    harness.handlers!.onLivenessLost!();
    await vi.waitFor(() => expect(harness.adoptionClosed).toBeGreaterThan(0));
    harness.handlers!.onClose!();

    expect(manager.stateSnapshot('s1')?.lifecycle).toBe('exited');
  });

  it('keeps a second, unproven close from ending a session it already detached', async () => {
    const manager = await adopted();

    harness.handlers!.onClose!();
    expect(manager.stateSnapshot('s1')?.lifecycle).not.toBe('exited');

    // A late duplicate close — the same transport reporting itself gone twice
    // — must stay just as harmless as the first.
    harness.handlers!.onClose!();
    expect(manager.stateSnapshot('s1')?.lifecycle).not.toBe('exited');
  });
});
