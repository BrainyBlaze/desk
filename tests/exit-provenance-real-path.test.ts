// desk#59 blockers 1+2 — the authority-level upgrade proved nothing about
// production.
//
// 1. `beginRetire` deletes the runtime entry, so `observeMoorEvent` bails at its
//    `hasLiveSession` guard and returns `session-not-found`. The holder's real
//    exit — which arrives milliseconds AFTER Desk tore the session down — never
//    reaches the authority, so the retired placeholder is what survives. The
//    upgrade was unreachable on the only path that matters.
//
// 2. The event feed carries its OWN strict exit schema and projects
//    `transition.to.exit` verbatim, so a provenance-bearing exit is rejected
//    before it can be journalled; and the exited→exited correction is filtered
//    out entirely, making the correction invisible to the operator.

import { describe, expect, it } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  WorkerSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { projectTransitionToDeskEvents } from '../src/shared/controlPlane/eventFeed.js';
import type { SessionStateTransition } from '../src/shared/controlPlane/index.js';

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

function manager(transitions: SessionStateTransition[] = []): SessionManager {
  return new SessionManager({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: { create: () => new NullEmu() },
    now: () => 1_000,
    sendBrowser: () => {},
    onStateTransition: (transition) => transitions.push(transition)
  });
}

describe('late holder exit after retire, on the real observer path (desk#59)', () => {
  it('strengthens the retired placeholder with the exit the holder actually reported', () => {
    const mgr = manager();
    const ens = mgr.ensure('sess', { rows: 24, cols: 80 }, { kind: 'agent', provider: 'codex', mode: 'terminal', producer: 'codex-hooks' });
    expect(ens.ok).toBe(true);
    const generation = ens.ok ? ens.generation : 0;

    // Desk tears the session down knowing nothing about the child.
    mgr.retire('sess', 'master-link-closed');
    expect(mgr.stateSnapshot('sess')?.exit).toMatchObject({ origin: 'retired' });

    // 28 ms later moor reports the truth for the EXACT retired generation.
    const observed = mgr.observeMoorEvent('sess', generation, {
      type: 'exit',
      code: 143,
      outcome: { kind: 'signalled', signal: 15, method: 'forced' },
      ts: 1.028
    } as never);

    expect(observed.ok).toBe(true);
    expect(mgr.stateSnapshot('sess')?.exit).toMatchObject({
      origin: 'observed',
      code: 143,
      signal: '15',
      // The record now names the ending itself, not just a number that could
      // equally have come from a child exiting 143 on its own.
      outcome: { kind: 'signalled', signal: 15, method: 'forced' }
    });
  });

  it('never lets a late event for another generation touch the retired one', () => {
    const mgr = manager();
    const ens = mgr.ensure('sess', { rows: 24, cols: 80 });
    const generation = ens.ok ? ens.generation : 0;
    mgr.retire('sess', 'master-link-closed');

    const stale = mgr.observeMoorEvent('sess', generation + 1, {
      type: 'exit',
      code: 7,
      outcome: { kind: 'exited', code: 7, method: 'none' },
      ts: 1.028
    } as never);

    expect(stale.ok).toBe(false);
    expect(mgr.stateSnapshot('sess')?.exit).toMatchObject({ origin: 'retired' });
  });
});

describe('provenance survives the event feed (desk#59)', () => {
  const base = {
    schemaVersion: 1 as const,
    revision: 2,
    sessionId: 'sess',
    generation: 1,
    at: 2_000,
    actionable: true
  };

  const runningSnapshot = {
    schemaVersion: 1 as const,
    revision: 1,
    sessionId: 'sess',
    generation: 1,
    lifecycle: 'running' as const,
    lifecycleSince: 1_000,
    exit: null,
    health: { status: 'healthy' as const },
    delivery: null,
    policy: { autoRestart: false },
    subject: {
      kind: 'agent' as const,
      provider: 'codex' as const,
      mode: 'terminal' as const,
      producer: 'codex-hooks' as const,
      activity: 'unknown' as const,
      activitySince: 1_000,
      wait: null,
      evidence: null
    },
    updatedAt: 1_000
  };

  function exitedSnapshot(exit: Record<string, unknown>, revision: number) {
    return {
      ...runningSnapshot,
      revision,
      lifecycle: 'exited' as const,
      lifecycleSince: 2_000,
      exit,
      updatedAt: 2_000
    };
  }

  it('projects a retired exit without rejecting its provenance', () => {
    const retired = { at: 2_000, code: null, signal: null, origin: 'retired', reason: 'master-link-closed' };
    const events = projectTransitionToDeskEvents({
      ...base,
      cause: 'lifecycle-exited',
      from: runningSnapshot,
      to: exitedSnapshot(retired, 2)
    } as never);

    const exited = events.find((event) => event.kind === 'agent-exited');
    expect(exited).toBeDefined();
    expect((exited as { exit: Record<string, unknown> }).exit).toMatchObject({
      origin: 'retired',
      reason: 'master-link-closed'
    });
  });

  it('makes the exited→exited correction visible instead of swallowing it', () => {
    // The operator must SEE that a death first recorded as a teardown was later
    // corrected by the holder's real exit; a silent overwrite is how the cause
    // of death got lost in the first place.
    const retired = { at: 2_000, code: null, signal: null, origin: 'retired', reason: 'master-link-closed' };
    const observed = { at: 2_028, code: 143, signal: 'SIGTERM', origin: 'observed', reason: null };
    const events = projectTransitionToDeskEvents({
      ...base,
      revision: 3,
      at: 2_028,
      cause: 'lifecycle-exited',
      from: exitedSnapshot(retired, 2),
      to: exitedSnapshot(observed, 3)
    } as never);

    const exited = events.find((event) => event.kind === 'agent-exited');
    expect(exited).toBeDefined();
    expect((exited as { exit: Record<string, unknown> }).exit).toMatchObject({
      origin: 'observed',
      code: 143,
      signal: 'SIGTERM'
    });
  });
});

describe('an unprovable ending is never persisted as a clean exit (desk#59)', () => {
  it('records no code at all rather than a fabricated zero', () => {
    const mgr = manager();
    const ens = mgr.ensure('sess', { rows: 24, cols: 80 });
    const generation = ens.ok ? ens.generation : 0;

    mgr.observeMoorEvent('sess', generation, {
      type: 'exit',
      // The legacy numeric view of an unprovable ending is 0, which in the
      // durable record would be indistinguishable from a child that exited
      // cleanly. The record must say "no code", not "code zero".
      code: 0,
      outcome: { kind: 'unknown' },
      ts: 1.028
    } as never);

    expect(mgr.stateSnapshot('sess')?.exit).toMatchObject({
      code: null,
      outcome: { kind: 'unknown' }
    });
  });
});

describe('the legacy EXIT frame stays live-only (desk#59)', () => {
  it('does not announce a strengthening to surfaces that are already gone', () => {
    const frames: Array<{ sessionId: string; frame: unknown }> = [];
    const mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new NullEmu() },
      now: () => 1_000,
      sendBrowser: (sessionId, _channelId, frame) => frames.push({ sessionId, frame })
    });
    const ens = mgr.ensure('sess', { rows: 24, cols: 80 });
    const generation = ens.ok ? ens.generation : 0;
    mgr.retire('sess', 'master-link-closed');
    frames.length = 0;

    mgr.observeMoorEvent('sess', generation, {
      type: 'exit',
      code: 143,
      outcome: { kind: 'signalled', signal: 15, method: 'forced' },
      ts: 1.028
    } as never);

    // The durable record IS corrected...
    expect(mgr.stateSnapshot('sess')?.exit).toMatchObject({ origin: 'observed' });
    // ...but nothing is pushed to surfaces that no longer exist.
    expect(frames).toHaveLength(0);
  });
});

describe('daemon departure does not end sessions (desk#59)', () => {
  it('detaches without retiring, so no exit provenance is written at all', () => {
    // Holders survive the daemon by design: that is what makes re-adoption
    // possible. A 'daemon-shutdown' retire reason is therefore deliberately
    // absent from the vocabulary, and this pins the behaviour so its absence
    // is never mistaken for an oversight.
    const mgr = manager();
    const ens = mgr.ensure('sess', { rows: 24, cols: 80 });
    expect(ens.ok).toBe(true);

    mgr.closeAllLinks();

    expect(mgr.stateSnapshot('sess')?.lifecycle).not.toBe('exited');
    expect(mgr.stateSnapshot('sess')?.exit ?? null).toBeNull();
  });

  it('does not let a staged close cause outlive the close that never happened', () => {
    // The probe stages a cause just before closing a link. If the daemon
    // departs instead, that cause must not be inherited by a later link for
    // the same session id.
    const mgr = manager();
    mgr.ensure('sess', { rows: 24, cols: 80 });
    mgr.closeAllLinks();
    mgr.retire('sess', 'control-retire');

    expect(mgr.stateSnapshot('sess')?.exit).toMatchObject({ reason: 'control-retire' });
  });
});
