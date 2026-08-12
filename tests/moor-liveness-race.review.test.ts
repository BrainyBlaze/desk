import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import {
  AgentStateAuthority,
  GenerationLedger,
  InMemoryGenerationLedger
} from '../src/shared/controlPlane/index.js';
import type { EmulatorPort } from '../src/shared/runtime/emulatorPort.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor
} from '../src/shared/runtime/workerSupervisor.js';

type LivenessHandlers = {
  onLivenessLost?: () => void;
  onLivenessRestored?: () => void;
};

const harness = vi.hoisted(() => ({
  handlers: undefined as LivenessHandlers | undefined,
  probes: [] as Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>
}));

vi.mock('../src/server/runtime/moorMasterClient.js', () => ({
  MoorMasterClient: class {
    constructor(
      _sessionPath: string,
      _generation: number,
      handlers: LivenessHandlers = {}
    ) {
      if (handlers.onLivenessLost !== undefined) harness.handlers = handlers;
    }

    async connect(): Promise<void> {}

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
    close(): void {}
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

describe('SessionManager Moor liveness adversarial review', () => {
  afterEach(() => {
    harness.handlers = undefined;
    harness.probes = [];
  });

  it('requires authenticated recovery and fences an older probe result', async () => {
    const manager = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 2 }),
      emulatorFactory: { create: emulator },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
    expect(manager.ensure('s1', { rows: 24, cols: 80 })).toMatchObject({
      ok: true,
      generation: 2
    });
    await expect(
      manager.moorAttachMaster('s1', '/tmp/s1', { rows: 24, cols: 80 }, { generation: 2 })
    ).resolves.toBe(true);

    harness.handlers!.onLivenessLost!();
    await vi.waitFor(() => expect(harness.probes).toHaveLength(1));
    expect(manager.stateSnapshot('s1')?.health).toMatchObject({
      status: 'degraded',
      detail: 'probe-pending'
    });

    harness.handlers!.onLivenessRestored!();
    await vi.waitFor(() => expect(harness.probes).toHaveLength(2));
    expect(manager.stateSnapshot('s1')?.health).toMatchObject({
      status: 'degraded',
      detail: 'probe-pending'
    });

    harness.probes[1]!.resolve();
    await vi.waitFor(() => expect(manager.stateSnapshot('s1')?.health.status).toBe('healthy'));

    harness.probes[0]!.reject(new Error('older probe became indeterminate'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(manager.stateSnapshot('s1')?.health.status).toBe('healthy');

    manager.retire('s1');
  });

  it('treats already-empty log clear as a successful end-state assertion', async () => {
    const manager = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 2 }),
      emulatorFactory: { create: emulator },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
    expect(manager.ensure('s1', { rows: 24, cols: 80 })).toMatchObject({
      ok: true,
      generation: 2
    });
    await expect(
      manager.moorAttachMaster('s1', '/tmp/s1', { rows: 24, cols: 80 }, { generation: 2 })
    ).resolves.toBe(true);

    await expect(manager.clearHolderLog('s1')).resolves.toBe('already-clear');
    manager.retire('s1');
  });
});

describe('Moor liveness authority adversarial review', () => {
  it('preserves a producer degradation across a lost-and-restored liveness episode', () => {
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 10,
      workingLeaseMs: 50
    });
    authority.registerSession({
      sessionId: 'agent-1',
      generation: 2,
      lifecycle: 'running',
      subject: {
        kind: 'agent',
        provider: 'codex',
        mode: 'terminal',
        producer: 'codex-hooks'
      }
    });
    expect(authority.snapshot('agent-1')?.health).toMatchObject({
      status: 'degraded',
      reason: 'awaiting-reconciliation'
    });

    authority.observeHolderLiveness('agent-1', 2, false, 'probe-pending');
    authority.observeHolderLiveness('agent-1', 2, true);

    expect(authority.snapshot('agent-1')?.health).toMatchObject({
      status: 'degraded',
      reason: 'awaiting-reconciliation'
    });
  });
});
