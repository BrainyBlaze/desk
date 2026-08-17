// DaemonCore composition (spec §3.2/§3.6). The multi-session registry ties the
// generation ledger, the fail-closed cap, per-session runtimes, and the lease
// into a callable daemon — tested with a fake emulator.

import { describe, expect, it, vi } from 'vitest';
import { BpFrameType } from '../src/shared/browserProtocol/index.js';
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
  disposed = false;
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
  dispose(): void {
    this.disposed = true;
  }
}

class BlockingFlushEmu extends FakeEmu {
  private drainResolve!: () => void;
  private readonly drain = new Promise<void>((resolve) => {
    this.drainResolve = resolve;
  });

  flush(): Promise<void> {
    return this.drain;
  }

  release(): void {
    this.drainResolve();
  }

  override serialize(): string {
    return new TextDecoder().decode(Uint8Array.from(this.written));
  }
}

class BlockingPreambleEmu extends FakeEmu {
  private rendered = 'old';
  private pending = '';
  private drainResolve!: () => void;
  private readonly drain = new Promise<void>((resolve) => {
    this.drainResolve = resolve;
  });

  override write(bytes: Uint8Array): void {
    this.pending += new TextDecoder().decode(bytes);
  }

  flush(): Promise<void> {
    return this.drain.then(() => {
      this.rendered += this.pending;
      this.pending = '';
    });
  }

  release(): void {
    this.drainResolve();
  }

  override serialize(): string {
    return this.rendered;
  }
}

function makeCore(
  over: Partial<{
    maxLiveWorkers: number;
    initialAgentHealth: NonNullable<DaemonCoreDeps['initialAgentHealth']>;
    onStateTransition: (transition: SessionStateTransition) => void;
    onStateTransitionError: (error: unknown, transition: SessionStateTransition) => void;
    createEmulator: () => EmulatorPort;
  }> = {}
) {
  const browserOut: { sessionId: string; channelId: number; frame: BpFrame }[] = [];
  const masterOut: { sessionId: string; bytes: Uint8Array; binary: boolean; surfaceId: number }[] = [];
  const masterResizes: { sessionId: string; rows: number; cols: number; surfaceId: number }[] = [];
  const clock = { t: 1000 };
  const deps: DaemonCoreDeps = {
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: over.maxLiveWorkers ?? 256 }),
    emulatorFactory: { create: over.createEmulator ?? (() => new FakeEmu()) },
    now: () => clock.t,
    sendBrowser: (sessionId, channelId, frame) => browserOut.push({ sessionId, channelId, frame }),
    sendMasterInput: (sessionId, bytes, binary, surfaceId) =>
      masterOut.push({ sessionId, bytes, binary, surfaceId }),
    sendMasterResize: (sessionId, rows, cols, surfaceId) =>
      masterResizes.push({ sessionId, rows, cols, surfaceId }),
    ...(over.initialAgentHealth === undefined
      ? {}
      : { initialAgentHealth: over.initialAgentHealth }),
    ...(over.onStateTransition === undefined
      ? {}
      : { onStateTransition: over.onStateTransition }),
    ...(over.onStateTransitionError === undefined
      ? {}
      : { onStateTransitionError: over.onStateTransitionError })
  };
  return { core: new DaemonCore(deps), browserOut, masterOut, masterResizes, clock };
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
    const ch = core.subscribe('s1', 'main', 40, 120)!.channelId;
    browserOut.length = 0;
    core.onMoorOutput('s1', new TextEncoder().encode('hi'), 0n);
    expect(browserOut).toHaveLength(1);
    expect(browserOut[0]).toMatchObject({ sessionId: 's1', channelId: ch });
  });

  it('delays a subscription snapshot until terminal-state parser work drains', async () => {
    const emulator = new BlockingPreambleEmu();
    const { core, browserOut } = makeCore({ createEmulator: () => emulator });
    core.ensure('s1', { rows: 40, cols: 120 });

    const preamble = core.onMasterTerminalState('s1', new TextEncoder().encode('-new'));
    const channelId = core.subscribe('s1', 'preamble-viewer', 40, 120)!.channelId;
    expect(
      browserOut
        .filter((entry) => entry.channelId === channelId)
        .map((entry) => entry.frame.type)
    ).toEqual([BpFrameType.SUBSCRIBE_ACK]);

    emulator.release();
    await expect(preamble).resolves.toBe(true);
    const frames = browserOut
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => entry.frame);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      type: BpFrameType.SNAPSHOT,
      offset: 0n,
      text: 'old-new'
    });
  });

  it('coalesces an identical replay retry while the first parser drain is pending', async () => {
    const emulator = new BlockingFlushEmu();
    const { core, browserOut } = makeCore({ createEmulator: () => emulator });
    core.ensure('s1', { rows: 40, cols: 120 });
    const bytes = new TextEncoder().encode('x');

    const first = core.onMoorOutput('s1', bytes, 0n);
    const retry = core.onMoorOutput('s1', bytes, 0n);
    expect(new TextDecoder().decode(Uint8Array.from(emulator.written))).toBe('x');

    const channelId = core.subscribe('s1', 'retry-viewer', 40, 120)!.channelId;
    expect(
      browserOut
        .filter((entry) => entry.channelId === channelId)
        .map((entry) => entry.frame.type)
    ).toEqual([BpFrameType.SUBSCRIBE_ACK]);

    emulator.release();
    await Promise.all([first, retry]);

    const frames = browserOut
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => entry.frame);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      type: BpFrameType.SNAPSHOT,
      offset: 1n,
      text: 'x'
    });
    expect(frames.some((frame) => frame.type === BpFrameType.OUTPUT)).toBe(false);
  });

  it('waits for the holder final-output boundary before emitting and fencing EXIT', async () => {
    const emulator = new BlockingFlushEmu();
    const { core, browserOut, masterOut, masterResizes } = makeCore({
      createEmulator: () => emulator
    });
    core.ensure('s1', { rows: 40, cols: 120 });
    const channelId = core.subscribe('s1', 'main', 40, 120)!.channelId;
    browserOut.length = 0;
    masterResizes.length = 0;

    const output = core.onMoorOutput('s1', new TextEncoder().encode('x'), 0n);
    const exit = core.emitExit('s1', { kind: 'exited', code: 7, method: 'none' }, 2n);
    expect(browserOut).toEqual([]);
    expect(
      core.onBrowserInputByChannel(channelId, false, new TextEncoder().encode('after-exit'))
    ).toBe(false);
    const resizeOutcome = core.onBrowserResizeByChannel(channelId, 50, 130);
    expect(masterOut).toEqual([]);
    expect(masterResizes).toEqual([]);
    const finalOutput = core.onMoorOutput('s1', new TextEncoder().encode('y'), 1n);

    emulator.release();
    await Promise.all([output, finalOutput, exit]);
    expect(resizeOutcome).toEqual({ routed: true, accepted: false });
    expect(browserOut.map(({ frame }) => frame.type)).toEqual([
      BpFrameType.OUTPUT,
      BpFrameType.OUTPUT,
      BpFrameType.EXIT
    ]);
    expect(new TextDecoder().decode(Uint8Array.from(emulator.written))).toBe('xy');
    expect(() => core.onMoorOutput('s1', new TextEncoder().encode('z'), 2n)).toThrow(
      /after session exit/
    );
  });

  it('orders an already-admitted delayed snapshot before terminal EXIT', async () => {
    const emulator = new BlockingFlushEmu();
    const { core, browserOut } = makeCore({ createEmulator: () => emulator });
    core.ensure('s1', { rows: 40, cols: 120 });

    const output = core.onMoorOutput('s1', new TextEncoder().encode('x'), 0n);
    const channelId = core.subscribe('s1', 'late-before-exit', 40, 120)!.channelId;
    expect(
      browserOut
        .filter((entry) => entry.channelId === channelId)
        .map((entry) => entry.frame.type)
    ).toEqual([BpFrameType.SUBSCRIBE_ACK]);
    const exit = core.emitExit('s1', { kind: 'exited', code: 7, method: 'none' }, 1n);

    emulator.release();
    await Promise.all([output, exit]);

    const frames = browserOut
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => entry.frame);
    expect(frames.map((frame) => frame.type)).toEqual([
      BpFrameType.SUBSCRIBE_ACK,
      BpFrameType.SNAPSHOT,
      BpFrameType.EXIT
    ]);
    expect(frames[1]).toMatchObject({
      type: BpFrameType.SNAPSHOT,
      offset: 1n,
      text: 'x'
    });
  });

  it('rejects subscriptions during final drain and after the exit fence', async () => {
    const emulator = new BlockingFlushEmu();
    const { core, browserOut } = makeCore({ createEmulator: () => emulator });
    core.ensure('s1', { rows: 40, cols: 120 });

    const output = core.onMoorOutput('s1', new TextEncoder().encode('x'), 0n);
    const exit = core.emitExit('s1', { kind: 'exited', code: 7, method: 'none' }, 1n);
    expect(core.subscribe('s1', 'during-final-drain', 40, 120)).toBeUndefined();

    emulator.release();
    await Promise.all([output, exit]);
    expect(core.subscribe('s1', 'after-exit-fence', 40, 120)).toBeUndefined();
    expect(browserOut).toEqual([]);
  });

  it('fences a late output drain after retirement from the successor generation', async () => {
    const retiredEmulator = new BlockingFlushEmu();
    const successorEmulator = new FakeEmu();
    const emulators: EmulatorPort[] = [retiredEmulator, successorEmulator];
    const { core, browserOut } = makeCore({
      createEmulator: () => emulators.shift() ?? new FakeEmu()
    });
    core.ensure('s1', { rows: 40, cols: 120 });
    core.subscribe('s1', 'retired-viewer', 40, 120);
    browserOut.length = 0;

    const late = core.onMoorOutput('s1', new TextEncoder().encode('x'), 0n);
    core.retire('s1', 'control-retire');
    expect(retiredEmulator.disposed).toBe(true);
    expect(core.ensure('s1', { rows: 40, cols: 120 })).toMatchObject({
      ok: true,
      generation: 3,
      created: true
    });
    const successorChannel = core.subscribe('s1', 'successor-viewer', 40, 120)!.channelId;
    browserOut.length = 0;

    retiredEmulator.release();
    await late;
    expect(browserOut).toEqual([]);

    core.onMoorOutput('s1', new TextEncoder().encode('y'), 0n);
    expect(browserOut).toHaveLength(1);
    expect(browserOut[0]).toMatchObject({
      sessionId: 's1',
      channelId: successorChannel,
      frame: { type: BpFrameType.OUTPUT, generation: 3, offset: 0n }
    });
    expect(new TextDecoder().decode(Uint8Array.from(successorEmulator.written))).toBe('y');
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

  it('contains and reports transition sink failures after committing state', () => {
    const failure = new Error('journal rejected transition');
    const onStateTransitionError = vi.fn();
    const { core } = makeCore({
      onStateTransition: () => {
        throw failure;
      },
      onStateTransitionError
    });

    expect(() => core.ensure('s1', { rows: 1, cols: 1 }, agentSubject)).not.toThrow();
    expect(core.stateSnapshot('s1')).toMatchObject({ sessionId: 's1', generation: 2 });
    expect(onStateTransitionError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ sessionId: 's1', generation: 2 })
    );
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
    const ch = core.subscribe('s1', 'main', 1, 1)!.channelId;
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
