// Checkpoint recovery-strategy select conformance (spec §8.1, C3 / R-xterm-patch).

import { describe, expect, it } from 'vitest';
import { SnapshotKind } from '../src/shared/atchWire/frames.js';
import {
  selectRecovery,
  type CheckpointEnvelope,
  type JournalRange,
  type WorkerVersions
} from '../src/shared/recovery/index.js';

const WORKER: WorkerVersions = { formatVersion: 1, xtermVersion: '6.0.0', patchVersion: 'bb1' };
const MAX = 4 << 20;

const exactCkpt = (over: Partial<CheckpointEnvelope> = {}): CheckpointEnvelope => ({
  kind: SnapshotKind.AUTHORITATIVE_STATE,
  outputOffset: 500n,
  formatVersion: 1,
  xtermVersion: '6.0.0',
  patchVersion: 'bb1',
  byteLength: 1024,
  ...over
});
const journal = (over: Partial<JournalRange> = {}): JournalRange => ({
  retainedStart: 0n,
  tail: 1000n,
  contiguousCrcOk: true,
  fromProcessStart: true,
  ...over
});

describe('checkpoint select — exact restore (§8.1)', () => {
  it('uses an exact authoritative checkpoint when versions + range + crc all hold', () => {
    const plan = selectRecovery(exactCkpt(), WORKER, journal(), MAX);
    expect(plan).toEqual({ strategy: 'exact-checkpoint', replayFrom: 500n, replayTo: 1000n });
  });
});

describe('checkpoint select — fall back to full replay (§8.1)', () => {
  it('falls back when the checkpoint version mismatches the worker', () => {
    const plan = selectRecovery(exactCkpt({ patchVersion: 'bb2' }), WORKER, journal(), MAX);
    expect(plan.strategy).toBe('full-replay'); // exact by construction from start
  });

  it('falls back when the checkpoint offset is outside the retained journal', () => {
    const plan = selectRecovery(exactCkpt({ outputOffset: 5000n }), WORKER, journal(), MAX);
    expect(plan.strategy).toBe('full-replay');
  });

  it('falls back when the checkpoint is oversize', () => {
    const plan = selectRecovery(exactCkpt({ byteLength: MAX + 1 }), WORKER, journal(), MAX);
    expect(plan.strategy).toBe('full-replay');
  });

  it('uses full replay when there is no checkpoint but the journal is whole', () => {
    const plan = selectRecovery(null, WORKER, journal(), MAX);
    expect(plan).toEqual({ strategy: 'full-replay', replayFrom: 0n, replayTo: 1000n });
  });
});

describe('checkpoint select — fail-closed degrade (§8.1 → §8.2)', () => {
  it('degrades when versions mismatch AND the journal is truncated', () => {
    const plan = selectRecovery(exactCkpt({ patchVersion: 'bb2' }), WORKER, journal({ fromProcessStart: false, retainedStart: 400n }), MAX);
    expect(plan.strategy).toBe('degrade');
  });

  it('degrades on a non-contiguous/torn checkpoint→tail range with no full journal', () => {
    const plan = selectRecovery(exactCkpt(), WORKER, journal({ contiguousCrcOk: false, fromProcessStart: false, retainedStart: 400n }), MAX);
    expect(plan.strategy).toBe('degrade');
    if (plan.strategy === 'degrade') expect(plan.reason).toContain('no usable checkpoint');
  });

  it('never uses a kind-1 DISPLAY checkpoint for authoritative recovery', () => {
    const display: CheckpointEnvelope = exactCkpt({ kind: SnapshotKind.TERMINAL_DISPLAY });
    const plan = selectRecovery(display, WORKER, journal({ fromProcessStart: false, retainedStart: 400n }), MAX);
    expect(plan.strategy).toBe('degrade'); // display checkpoint is browser-baseline only
  });

  it('a kind-1 display checkpoint still allows full replay when the journal is whole', () => {
    const display: CheckpointEnvelope = exactCkpt({ kind: SnapshotKind.TERMINAL_DISPLAY });
    const plan = selectRecovery(display, WORKER, journal(), MAX);
    expect(plan.strategy).toBe('full-replay');
  });
});
