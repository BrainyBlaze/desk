// DaemonCore composition (spec §3.2/§3.6). The multi-session registry ties the
// generation ledger, the fail-closed cap, per-session runtimes, and the lease
// into a callable daemon — tested with a fake emulator.

import { describe, expect, it } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  GenerationLedger,
  InMemoryGenerationLedger,
  type AgentStateEnvelope,
  type SessionStateTransition
} from '../src/shared/controlPlane/index.js';
import {
  DaemonCore,
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type BpFrame,
  type DaemonCoreDeps,
  type EmulatorPort,
  type EmulatorEvent
} from '../src/shared/runtime/index.js';

class FakeEmu implements EmulatorPort {
  written: number[] = [];
  write(b: Uint8Array): void {
    this.written.push(...b);
  }
  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return 'SCREEN';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeCore(
  over: Partial<{
    maxLiveWorkers: number;
    initialAgentHealth: NonNullable<DaemonCoreDeps['initialAgentHealth']>;
    onStateTransition: (transition: SessionStateTransition) => void;
  }> = {}
) {
  const browserOut: { sessionId: string; channelId: number; frame: BpFrame }[] = [];
  const masterOut: { sessionId: string; bytes: Uint8Array; binary: boolean; surfaceId: number }[] = [];
  const clock = { t: 1000 };
  const deps: DaemonCoreDeps = {
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: over.maxLiveWorkers ?? 256 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => clock.t,
    sendBrowser: (sessionId, channelId, frame) => browserOut.push({ sessionId, channelId, frame }),
    sendMasterInput: (sessionId, bytes, binary, surfaceId) =>
      masterOut.push({ sessionId, bytes, binary, surfaceId }),
    sendMasterResize: () => {},
    ...(over.initialAgentHealth === undefined
      ? {}
      : { initialAgentHealth: over.initialAgentHealth }),
    ...(over.onStateTransition === undefined
      ? {}
      : { onStateTransition: over.onStateTransition })
  };
  return { core: new DaemonCore(deps), browserOut, masterOut, clock };
}

const agentSubject = {
  kind: 'agent',
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks'
} as const;

const agentEvent = (overrides: Partial<AgentStateEnvelope> = {}): AgentStateEnvelope => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  sessionId: 's1',
  generation: 2,
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks',
  producerInstanceId: 'hooks-a',
  producerSeq: 1,
  eventId: 'hooks-a:1',
  invocationId: 'turn-1',
  occurredAt: 900,
  observedAt: 950,
  facts: [{ kind: 'activity', activity: 'working' }],
  ...overrides
});

describe('DaemonCore — ensure / registry (§3.2)', () => {
  it('ensure creates a session at ledger-allocated generation 2 (OB-18: 1 is reserved for unsupervised), idempotently', () => {
    const { core } = makeCore();
    const a = core.ensure('s1', { rows: 40, cols: 120 });
    expect(a).toEqual({ ok: true, generation: 2, created: true });
    const b = core.ensure('s1', { rows: 40, cols: 120 });
    expect(b).toEqual({ ok: true, generation: 2, created: false }); // idempotent
    expect(core.sessionCount).toBe(1);
  });

  it('runs initial health preflight only for a newly admitted agent generation', () => {
    const preflightSubjects: unknown[] = [];
    const { core } = makeCore({
      initialAgentHealth: (subject) => {
        preflightSubjects.push(subject);
        return {
          status: 'degraded',
          reason: 'hook-not-installed',
          detail: 'desk hook config is absent'
        };
      }
    });

    core.ensure('s1', { rows: 1, cols: 1 }, agentSubject);
    expect(core.stateSnapshot('s1')).toMatchObject({
      health: {
        status: 'degraded',
        reason: 'hook-not-installed',
        detail: 'desk hook config is absent'
      },
      subject: {
        kind: 'agent',
        activity: 'unknown',
        evidence: null
      }
    });

    core.ensure('s1', { rows: 1, cols: 1 }, agentSubject);
    core.ensure('terminal-1', { rows: 1, cols: 1 });
    expect(preflightSubjects).toEqual([agentSubject]);
  });

  it('contains a failed health probe without failing session admission', () => {
    const { core } = makeCore({
      initialAgentHealth: () => {
        throw new Error('probe failed');
      }
    });

    expect(core.ensure('s1', { rows: 1, cols: 1 }, agentSubject)).toEqual({
      ok: true,
      generation: 2,
      created: true
    });
    expect(core.stateSnapshot('s1')).toMatchObject({
      health: {
        status: 'degraded',
        reason: 'hook-preflight-failed',
        detail: 'probe failed'
      },
      subject: { kind: 'agent', activity: 'unknown', evidence: null }
    });
  });

  it('fails closed past the worker cap (§3.3)', () => {
    const { core } = makeCore({ maxLiveWorkers: 2 });
    expect(core.ensure('a', { rows: 1, cols: 1 }).ok).toBe(true);
    expect(core.ensure('b', { rows: 1, cols: 1 }).ok).toBe(true);
    const over = core.ensure('c', { rows: 1, cols: 1 });
    expect(over).toEqual({ ok: false, reason: 'cap-exceeded' });
  });

  it('THE fence property end-to-end: recreate after retire gets a higher generation', () => {
    const { core } = makeCore();
    expect(core.ensure('s1', { rows: 1, cols: 1 }).generation).toBe(2);
    core.retire('s1'); // session ends — registry gone, ledger tombstone kept
    const recreated = core.ensure('s1', { rows: 1, cols: 1 });
    expect(recreated).toEqual({ ok: true, generation: 3, created: true }); // NOT reset to the fresh-lineage 2
  });

  it('retire frees a slot so a capped-out session can be admitted', () => {
    const { core } = makeCore({ maxLiveWorkers: 1 });
    core.ensure('a', { rows: 1, cols: 1 });
    expect(core.ensure('b', { rows: 1, cols: 1 }).ok).toBe(false);
    core.retire('a');
    expect(core.ensure('b', { rows: 1, cols: 1 }).ok).toBe(true);
  });
});

describe('DaemonCore — routing + projections (§7.1/§6.7)', () => {
  it('routes moor child output to the session and out to its subscribers', () => {
    const { core, browserOut } = makeCore();
    core.ensure('s1', { rows: 40, cols: 120 });
    const ch = core.subscribe('s1', 'main', 40, 120);
    browserOut.length = 0;
    core.onMoorOutput('s1', new TextEncoder().encode('hi'), 0n);
    expect(browserOut).toHaveLength(1);
    expect(browserOut[0]).toMatchObject({ sessionId: 's1', channelId: ch });
  });

  it('accepts one canonical agent event and never reapplies its duplicate', () => {
    const { core } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 }, agentSubject);
    core.markRunning('s1', 2);
    expect(core.stateSnapshot('s1')?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });

    const accepted = core.ingestAgentState(agentEvent());
    expect(accepted).toMatchObject({ kind: 'accepted', mutation: { kind: 'applied' } });
    expect(core.stateSnapshot('s1')?.subject).toMatchObject({
      kind: 'agent',
      activity: 'working'
    });
    const view = core.stateSnapshots();
    expect(view.revision).toBe(view.snapshots[0]?.revision);
    expect(view.snapshots).toHaveLength(1);
    const revision = core.stateSnapshot('s1')?.revision;

    const duplicate = core.ingestAgentState(agentEvent());
    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      event: { acceptanceId: accepted.kind === 'accepted' ? accepted.event.acceptanceId : '' }
    });
    expect(core.stateSnapshot('s1')?.revision).toBe(revision);
  });

  it('applies a generation-fenced health assessment without changing agent state', () => {
    const transitions: SessionStateTransition[] = [];
    const { core } = makeCore({
      onStateTransition: (transition) => transitions.push(transition)
    });
    core.ensure('s1', { rows: 1, cols: 1 }, agentSubject);
    core.markRunning('s1', 2);
    core.ingestAgentState(agentEvent());
    const before = core.stateSnapshot('s1')!;

    expect(
      core.assessAgentHealth('s1', 0, {
        status: 'degraded',
        reason: 'hook-not-installed'
      })
    ).toMatchObject({ kind: 'rejected', reason: 'generation-mismatch' });
    expect(core.stateSnapshot('s1')).toEqual(before);

    expect(
      core.assessAgentHealth('s1', 2, {
        status: 'degraded',
        reason: 'hook-not-installed',
        detail: 'desk hook config is absent'
      })
    ).toMatchObject({ kind: 'applied' });
    const after = core.stateSnapshot('s1')!;
    expect(after.subject).toEqual(before.subject);
    expect(after.lifecycle).toBe(before.lifecycle);
    expect(after.health).toMatchObject({
      status: 'degraded',
      reason: 'hook-not-installed',
      detail: 'desk hook config is absent'
    });
    expect(transitions.at(-1)?.cause).toBe('source-health');
  });

  it('routes browser input to the session master', () => {
    const { core, masterOut } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 });
    const ch = core.subscribe('s1', 'main', 1, 1)!;
    core.onBrowserInput('s1', ch, false, new TextEncoder().encode('x'));
    expect(masterOut).toHaveLength(1);
    expect(masterOut[0].sessionId).toBe('s1');
  });

  it('projects process EXIT immediately and clears agent activity evidence', () => {
    const { core } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 }, agentSubject);
    core.markRunning('s1', 2);
    core.ingestAgentState(agentEvent());

    core.markExited('s1', 2, { code: 23, signal: '15' });

    expect(core.stateSnapshot('s1')).toMatchObject({
      lifecycle: 'exited',
      exit: { code: 23, signal: '15' },
      subject: { kind: 'agent', activity: 'unknown', evidence: null }
    });
  });
});

describe('DaemonCore — lease + stop (§7.9/§11.4)', () => {
  it('claims and releases a per-session controller lease', () => {
    const { core } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 });
    const c = core.claimLease('s1', 'connA', false, 100n);
    expect(c?.granted).toBe(true);
    const denied = core.claimLease('s1', 'connB', false, 100n);
    expect(denied?.granted).toBe(false);
    expect(core.releaseLease('s1', 'connA')).toBe(true);
  });

  it('stop refuses while sessions live unless forced', () => {
    const { core } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 });
    expect(core.canStop(false)).toEqual({ action: 'refuse', liveSessions: 1 });
    expect(core.canStop(true)).toEqual({ action: 'stop' });
    core.retire('s1');
    expect(core.canStop(false)).toEqual({ action: 'stop' });
  });
});

describe('DaemonCore — terminal output is never agent-state evidence', () => {
  class EmittingEmu extends FakeEmu {
    cb: ((e: EmulatorEvent) => void) | undefined;
    onEvent(cb: (e: EmulatorEvent) => void): () => void {
      this.cb = cb;
      return () => {
        this.cb = undefined;
      };
    }
  }

  it('does not subscribe to BEL/OSC9 even when a stale caller supplies the retired callback', () => {
    const emu = new EmittingEmu();
    const seen: { sessionId: string; event: EmulatorEvent }[] = [];
    const core = new DaemonCore({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => emu },
      now: () => 1000,
      sendBrowser: () => {},
      sendMasterInput: () => {},
      sendMasterResize: () => {},
      onSemanticEvent: (sessionId, event) => seen.push({ sessionId, event })
    } as DaemonCoreDeps);
    expect(core.ensure('s1', { rows: 24, cols: 80 }, agentSubject).ok).toBe(true);
    core.markRunning('s1', 2);
    core.ingestAgentState(agentEvent({ facts: [{ kind: 'activity', activity: 'idle' }] }));
    const before = core.stateSnapshot('s1');

    expect(emu.cb).toBeUndefined();
    expect(seen).toEqual([]);
    expect(core.stateSnapshot('s1')).toEqual(before);
  });
});

describe('DaemonCore — restore (re-adopt a surviving master after daemon restart)', () => {
  function coreOverLedger(ledger: GenerationLedger) {
    const masterOut: { sessionId: string; bytes: Uint8Array; binary: boolean; surfaceId: number }[] = [];
    const core = new DaemonCore({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000,
      sendBrowser: () => {},
      sendMasterInput: (sessionId, bytes, binary, surfaceId) =>
        masterOut.push({ sessionId, bytes, binary, surfaceId }),
      sendMasterResize: () => {}
    });
    return { core, masterOut };
  }

  it('adopts the durable CURRENT generation without allocating (ensure would fence the master out)', () => {
    const store = new InMemoryGenerationLedger();
    // The ORIGINAL daemon spawned the master at generation 2 (OB-18: 1 reserved for unsupervised).
    new GenerationLedger(store).allocate('s1');

    // A RESTARTED daemon over the same durable store re-adopts, never allocates.
    const ledger = new GenerationLedger(store);
    const { core, masterOut } = coreOverLedger(ledger);
    const restored = core.restore('s1');
    expect(restored).toEqual({ ok: true, generation: 2 });
    expect(ledger.current('s1')).toBe(2); // NOT bumped — the surviving master owns 2

    // Master-bound sends route through the installed link, which the manager
    // constructs at the ADOPTED generation — the wire fence lives there; the
    // core's job is exact routing of the typed send.
    core.injectInput('s1', new TextEncoder().encode('hi'));
    expect(masterOut).toHaveLength(1);
    expect(masterOut[0].sessionId).toBe('s1');
    expect(new TextDecoder().decode(masterOut[0].bytes)).toBe('hi');
    expect(masterOut[0].surfaceId).toBe(0);
  });

  it('fails closed when the ledger has no durable generation for the socket', () => {
    const { core } = coreOverLedger(new GenerationLedger(new InMemoryGenerationLedger()));
    expect(core.restore('ghost')).toEqual({ ok: false, reason: 'no-generation' });
  });

  it('refuses to restore over an already-live session', () => {
    const store = new InMemoryGenerationLedger();
    const { core } = coreOverLedger(new GenerationLedger(store));
    expect(core.ensure('s1', { rows: 24, cols: 80 }).ok).toBe(true);
    expect(core.restore('s1')).toEqual({ ok: false, reason: 'already-live' });
  });

  it('ensure AFTER a retire still allocates a HIGHER generation than the restored one', () => {
    const store = new InMemoryGenerationLedger();
    new GenerationLedger(store).allocate('s1'); // original spawn: 2 (OB-18)
    const ledger = new GenerationLedger(store);
    const { core } = coreOverLedger(ledger);
    expect(core.restore('s1').ok).toBe(true);
    core.retire('s1');
    const recreated = core.ensure('s1', { rows: 24, cols: 80 });
    expect(recreated.ok).toBe(true);
    if (recreated.ok) {
      expect(recreated.generation).toBe(3); // the tombstone still advances (§4.8.1)
    }
  });
});
