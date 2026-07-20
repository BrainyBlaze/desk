// Recovery trust-state conformance (spec §8.2, C4). The two axes move
// independently and trust clears only via a valid hidden-state oracle.

import { describe, expect, it } from 'vitest';
import {
  canDisplayExact,
  canRebuildAfterRestart,
  createRecoveryState,
  onEmulatorLoss,
  onRetentionTruncation,
  onTruncatedRestore,
  reestablish
} from '../src/shared/recovery/index.js';

describe('recovery — the two axes move independently (§8.2)', () => {
  it('a pristine session is fully trusted', () => {
    const s = createRecoveryState();
    expect(canDisplayExact(s, 'main')).toBe(true);
    expect(canRebuildAfterRestart(s)).toBe(true);
    expect(s.recoveryLost).toBe(false);
  });

  it('retention truncation while ALIVE kills restart-recovery but NOT the live screen', () => {
    const s = onRetentionTruncation(createRecoveryState());
    expect(s.currentStateExact).toBe(true); // live emulator unaffected
    expect(canDisplayExact(s, 'main')).toBe(true); // screen still exact
    expect(s.restartRecoverable).toBe(false); // but bytes to rebuild are gone
    expect(s.recoveryLost).toBe(false); // screen is NOT marked unknown
  });

  it('emulator loss kills the live screen and sets sticky recovery_lost', () => {
    const s = onEmulatorLoss(createRecoveryState());
    expect(s.currentStateExact).toBe(false);
    expect(s.recoveryLost).toBe(true);
    expect(canDisplayExact(s, 'main')).toBe(false);
  });

  it('the axes are not collapsed: one false does not force the other', () => {
    const truncated = onRetentionTruncation(createRecoveryState());
    expect(truncated.currentStateExact).toBe(true);
    expect(truncated.restartRecoverable).toBe(false);
    const lost = onEmulatorLoss(createRecoveryState());
    expect(lost.currentStateExact).toBe(false);
    expect(lost.restartRecoverable).toBe(true); // journal may still allow rebuild
  });
});

describe('recovery — per-buffer provenance (§8.2)', () => {
  it('a truncated restore marks only that buffer inexact', () => {
    const s = onTruncatedRestore(createRecoveryState(), 'main');
    expect(s.bufferExact.main).toBe(false);
    expect(s.bufferExact.alt).toBe(true);
    expect(canDisplayExact(s, 'main')).toBe(false);
    expect(canDisplayExact(s, 'alt')).toBe(true);
    expect(s.recoveryLost).toBe(true);
  });
});

describe('recovery — re-establishment requires a hidden-state oracle (§8.2)', () => {
  it('RIS-reset re-establishes a buffer', () => {
    const s = onTruncatedRestore(createRecoveryState(), 'main');
    const r = reestablish(s, 'main', 'ris-reset');
    expect(r.ok).toBe(true);
    expect(s.bufferExact.main).toBe(true);
    expect(s.recoveryLost).toBe(false); // both buffers exact again
    expect(s.currentStateExact).toBe(true);
  });

  it('an app-declared exact snapshot re-establishes', () => {
    const s = onTruncatedRestore(createRecoveryState(), 'alt');
    expect(reestablish(s, 'alt', 'app-snapshot').ok).toBe(true);
    expect(s.bufferExact.alt).toBe(true);
  });

  it('process-restart re-establishes everything', () => {
    const s = onEmulatorLoss(onTruncatedRestore(createRecoveryState(), 'main'));
    const r = reestablish(s, 'main', 'process-restart');
    expect(r.ok).toBe(true);
    expect(s.currentStateExact).toBe(true);
    expect(s.restartRecoverable).toBe(true);
    expect(s.recoveryLost).toBe(false);
  });

  it('INVALID oracles never re-establish (resize, alt-cycle, later-checkpoint, visual repaint)', () => {
    for (const bad of ['resize', 'alt-cycle', 'later-checkpoint', 'visual-repaint'] as const) {
      const s = onTruncatedRestore(createRecoveryState(), 'main');
      const r = reestablish(s, 'main', bad);
      expect(r.ok).toBe(false);
      expect(s.bufferExact.main).toBe(false); // still inexact
      expect(s.recoveryLost).toBe(true);
    }
  });

  it('alt-cycle does not rescue an incomplete main buffer', () => {
    const s = onTruncatedRestore(createRecoveryState(), 'main');
    expect(reestablish(s, 'main', 'alt-cycle').ok).toBe(false);
    expect(canDisplayExact(s, 'main')).toBe(false);
  });
});
