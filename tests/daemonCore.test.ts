// DaemonCore composition (spec §3.2/§3.6). The multi-session registry ties the
// generation ledger, the fail-closed cap, per-session runtimes, and the lease
// into a callable daemon — tested with a fake emulator.

import { describe, expect, it } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  DaemonCore,
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type BpFrame,
  type DaemonCoreDeps,
  type EmulatorPort,
  type EmulatorEvent
} from '../src/shared/runtime/index.js';
import { type RawFrame } from '../src/shared/atchWire/codec.js';
import { RecordType } from '../src/shared/atchWire/frames.js';
import { type RecordEnvelope } from '../src/shared/atchWire/messages.js';

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

function makeCore(over: Partial<{ maxLiveWorkers: number }> = {}) {
  const browserOut: { sessionId: string; channelId: number; frame: BpFrame }[] = [];
  const masterOut: { sessionId: string; frame: RawFrame }[] = [];
  const clock = { t: 1000 };
  const deps: DaemonCoreDeps = {
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: over.maxLiveWorkers ?? 256 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => clock.t,
    sendBrowser: (sessionId, channelId, frame) => browserOut.push({ sessionId, channelId, frame }),
    sendMaster: (sessionId, frame) => masterOut.push({ sessionId, frame })
  };
  return { core: new DaemonCore(deps), browserOut, masterOut, clock };
}

const output = (offset: bigint, seq: bigint, text: string): RecordEnvelope => ({
  record_type: RecordType.OUTPUT,
  record_seq: seq,
  generation: 1,
  output_offset: offset,
  body: new TextEncoder().encode(text)
});

describe('DaemonCore — ensure / registry (§3.2)', () => {
  it('ensure creates a session at ledger-allocated generation 1, idempotently', () => {
    const { core } = makeCore();
    const a = core.ensure('s1', { rows: 40, cols: 120 });
    expect(a).toEqual({ ok: true, generation: 1, created: true });
    const b = core.ensure('s1', { rows: 40, cols: 120 });
    expect(b).toEqual({ ok: true, generation: 1, created: false }); // idempotent
    expect(core.sessionCount).toBe(1);
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
    expect(core.ensure('s1', { rows: 1, cols: 1 }).generation).toBe(1);
    core.retire('s1'); // session ends — registry gone, ledger tombstone kept
    const recreated = core.ensure('s1', { rows: 1, cols: 1 });
    expect(recreated).toEqual({ ok: true, generation: 2, created: true }); // NOT reset to 1
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
  it('routes master output to the session and out to its subscribers', () => {
    const { core, browserOut } = makeCore();
    core.ensure('s1', { rows: 40, cols: 120 });
    const ch = core.subscribe('s1', 'main', 40, 120);
    browserOut.length = 0;
    core.onMasterRecord('s1', output(0n, 1n, 'hi'));
    expect(browserOut).toHaveLength(1);
    expect(browserOut[0]).toMatchObject({ sessionId: 's1', channelId: ch });
  });

  it('a typed hook drives the session state; list + state reflect it', () => {
    const { core } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 }); // generation 1
    core.ingestHook('s1', { source: 'typed-hook', carriedGeneration: 1, invocationId: 'i1', state: 'working' });
    expect(core.state('s1')?.state).toBe('working');
    expect(core.list()).toEqual([{ sessionId: 's1', generation: 1, state: 'working', source: 'typed-hook' }]);
  });

  it('routes browser input to the session master', () => {
    const { core, masterOut } = makeCore();
    core.ensure('s1', { rows: 1, cols: 1 });
    const ch = core.subscribe('s1', 'main', 1, 1)!;
    core.onBrowserInput('s1', ch, false, new TextEncoder().encode('x'));
    expect(masterOut).toHaveLength(1);
    expect(masterOut[0].sessionId).toBe('s1');
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

describe('DaemonCore — semantic attention events (bell/OSC9 → onSemanticEvent)', () => {
  class EmittingEmu extends FakeEmu {
    cb: ((e: EmulatorEvent) => void) | undefined;
    onEvent(cb: (e: EmulatorEvent) => void): () => void {
      this.cb = cb;
      return () => {
        this.cb = undefined;
      };
    }
  }

  it('forwards bell + OSC9 (with data) and filters every other event kind', () => {
    const emu = new EmittingEmu();
    const seen: { sessionId: string; event: EmulatorEvent }[] = [];
    const core = new DaemonCore({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => emu },
      now: () => 1000,
      sendBrowser: () => {},
      sendMaster: () => {},
      onSemanticEvent: (sessionId, event) => seen.push({ sessionId, event })
    });
    expect(core.ensure('s1', { rows: 24, cols: 80 }).ok).toBe(true);
    expect(emu.cb).toBeDefined();

    emu.cb?.({ kind: 'bell' });
    emu.cb?.({ kind: 'osc', code: 9, data: 'Turn complete' });
    emu.cb?.({ kind: 'osc', code: 0, data: 'a title write' }); // filtered
    emu.cb?.({ kind: 'title', data: 'ignored' }); // filtered
    emu.cb?.({ kind: 'link', data: 'ignored' }); // filtered

    expect(seen).toEqual([
      { sessionId: 's1', event: { kind: 'bell' } },
      { sessionId: 's1', event: { kind: 'osc', code: 9, data: 'Turn complete' } }
    ]);
  });

  it('does not subscribe at all when no consumer is wired', () => {
    const emu = new EmittingEmu();
    const core = new DaemonCore({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => emu },
      now: () => 1000,
      sendBrowser: () => {},
      sendMaster: () => {}
    });
    expect(core.ensure('s1', { rows: 24, cols: 80 }).ok).toBe(true);
    expect(emu.cb).toBeUndefined();
  });
});

describe('DaemonCore — restore (re-adopt a surviving master after daemon restart)', () => {
  function coreOverLedger(ledger: GenerationLedger) {
    const masterOut: { sessionId: string; frame: RawFrame }[] = [];
    const core = new DaemonCore({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000,
      sendBrowser: () => {},
      sendMaster: (sessionId, frame) => masterOut.push({ sessionId, frame })
    });
    return { core, masterOut };
  }

  it('adopts the durable CURRENT generation without allocating (ensure would fence the master out)', () => {
    const store = new InMemoryGenerationLedger();
    // The ORIGINAL daemon spawned the master at generation 1.
    new GenerationLedger(store).allocate('s1');

    // A RESTARTED daemon over the same durable store re-adopts, never allocates.
    const ledger = new GenerationLedger(store);
    const { core, masterOut } = coreOverLedger(ledger);
    const restored = core.restore('s1', { rows: 24, cols: 80 });
    expect(restored).toEqual({ ok: true, generation: 1 });
    expect(ledger.current('s1')).toBe(1); // NOT bumped — the surviving master owns 1

    // Frames the runtime sends to the master carry the ADOPTED generation, so
    // the master's fence accepts them; an ensure() would have stamped 2.
    core.injectInput('s1', new TextEncoder().encode('hi'));
    expect(masterOut).toHaveLength(1);
    expect(masterOut[0].frame.generation).toBe(1);
  });

  it('fails closed when the ledger has no durable generation for the socket', () => {
    const { core } = coreOverLedger(new GenerationLedger(new InMemoryGenerationLedger()));
    expect(core.restore('ghost', { rows: 24, cols: 80 })).toEqual({ ok: false, reason: 'no-generation' });
  });

  it('refuses to restore over an already-live session', () => {
    const store = new InMemoryGenerationLedger();
    const { core } = coreOverLedger(new GenerationLedger(store));
    expect(core.ensure('s1', { rows: 24, cols: 80 }).ok).toBe(true);
    expect(core.restore('s1', { rows: 24, cols: 80 })).toEqual({ ok: false, reason: 'already-live' });
  });

  it('ensure AFTER a retire still allocates a HIGHER generation than the restored one', () => {
    const store = new InMemoryGenerationLedger();
    new GenerationLedger(store).allocate('s1'); // original spawn: 1
    const ledger = new GenerationLedger(store);
    const { core } = coreOverLedger(ledger);
    expect(core.restore('s1', { rows: 24, cols: 80 }).ok).toBe(true);
    core.retire('s1');
    const recreated = core.ensure('s1', { rows: 24, cols: 80 });
    expect(recreated.ok).toBe(true);
    if (recreated.ok) {
      expect(recreated.generation).toBe(2); // the tombstone still advances (§4.8.1)
    }
  });
});
