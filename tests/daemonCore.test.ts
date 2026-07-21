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
