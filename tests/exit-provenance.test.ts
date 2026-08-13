// desk#59: an exit record must say WHO ended the session and WHY.
//
// Two distinct losses were observed on the live instance:
//   1. `retire()` wrote `{code:null, signal:null}` — indistinguishable from a
//      child that genuinely exited with no code and no signal, so nobody could
//      tell an operator teardown from a natural death after the fact.
//   2. Because `markExited` no-ops once lifecycle is `exited`, a retire that
//      lands FIRST permanently blocks the real, observed exit that arrives
//      milliseconds later — the truth is discarded, not merely delayed.
//
// The contract fixed here: a retire-authored exit is a PLACEHOLDER that an
// observed exit may still overwrite; an observed exit is final.

import { describe, expect, it } from 'vitest';
import {
  AgentStateAuthority,
  type SessionStateTransition
} from '../src/shared/controlPlane/index.js';

function authorityWithRunningSession(): {
  authority: AgentStateAuthority;
  transitions: SessionStateTransition[];
} {
  const transitions: SessionStateTransition[] = [];
  const authority = new AgentStateAuthority({
    openToolLeaseMs: 500,
    workingLeaseMs: 50,
    now: () => 1_000,
    onTransition: (transition) => transitions.push(transition)
  });
  authority.registerSession({
    sessionId: 's',
    generation: 1,
    lifecycle: 'running',
    subject: { kind: 'terminal' }
  });
  transitions.length = 0;
  return { authority, transitions };
}

describe('exit provenance (desk#59)', () => {
  it('records which call site retired the session, not anonymous nulls', () => {
    const { authority } = authorityWithRunningSession();

    authority.markExited(
      's',
      1,
      { code: null, signal: null, origin: 'retired', reason: 'operator-remove' },
      2_000
    );

    expect(authority.snapshot('s')?.exit).toMatchObject({
      origin: 'retired',
      reason: 'operator-remove'
    });
  });

  it('lets the real observed exit overwrite a retire placeholder', () => {
    const { authority, transitions } = authorityWithRunningSession();

    // Desk tears the session down and writes what it knows: nothing.
    authority.markExited(
      's',
      1,
      { code: null, signal: null, origin: 'retired', reason: 'moor-reconcile-failed' },
      2_000
    );
    // 28 ms later the holder's real exit arrives — SIGTERM, normalized to 143.
    const upgrade = authority.markExited(
      's',
      1,
      { code: 143, signal: 'SIGTERM', origin: 'observed', reason: null },
      2_028
    );

    expect(upgrade.kind).toBe('applied');
    expect(authority.snapshot('s')?.exit).toMatchObject({
      code: 143,
      signal: 'SIGTERM',
      origin: 'observed'
    });
    // The correction must be visible in the journal, not applied silently.
    expect(transitions.at(-1)?.cause).toBe('lifecycle-exited');
  });

  it('never lets a later retire erase an already observed exit', () => {
    const { authority } = authorityWithRunningSession();

    authority.markExited(
      's',
      1,
      { code: 143, signal: 'SIGTERM', origin: 'observed', reason: null },
      2_000
    );
    const clobber = authority.markExited(
      's',
      1,
      { code: null, signal: null, origin: 'retired', reason: 'cleanup' },
      2_500
    );

    expect(clobber.kind).toBe('noop');
    expect(authority.snapshot('s')?.exit).toMatchObject({
      code: 143,
      signal: 'SIGTERM',
      origin: 'observed'
    });
  });

  it('treats a second retire as settled rather than re-committing', () => {
    const { authority } = authorityWithRunningSession();

    authority.markExited(
      's',
      1,
      { code: null, signal: null, origin: 'retired', reason: 'first' },
      2_000
    );
    const again = authority.markExited(
      's',
      1,
      { code: null, signal: null, origin: 'retired', reason: 'second' },
      2_100
    );

    expect(again.kind).toBe('noop');
    expect(authority.snapshot('s')?.exit).toMatchObject({ reason: 'first' });
  });
});
