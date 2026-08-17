import { describe, expect, it } from 'vitest';
import {
  canonicalAgentView,
  canonicalDeliveryDecision,
  type AgentStateBatch
} from '../src/server/channels/delivery/strategy.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AgentActivity,
  type SessionStateSnapshot,
  type WaitOwner
} from '../src/shared/controlPlane/index.js';

const NOW = 1_800_000_000_000;

function agentSnapshot(
  activity: AgentActivity,
  options: {
    lifecycle?: SessionStateSnapshot['lifecycle'];
    waitKind?: string;
    waitOwner?: WaitOwner;
    leaseExpiresAt?: number;
  } = {}
): SessionStateSnapshot {
  const lifecycle = options.lifecycle ?? 'running';
  const blocked = activity === 'blocked';
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    revision: 7,
    sessionId: 'session-a',
    generation: 3,
    lifecycle,
    lifecycleSince: NOW - 10_000,
    exit: lifecycle === 'exited' ? { at: NOW - 1_000, code: 0, signal: null } : null,
    health: { status: 'healthy', since: NOW - 10_000 },
    delivery: null,
    policy: { paused: false, since: NOW - 10_000 },
    subject: {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      activity,
      activitySince: NOW - 5_000,
      wait: blocked
        ? {
            kind: options.waitKind ?? 'approval',
            owner: options.waitOwner ?? 'operator',
            since: NOW - 5_000
          }
        : null,
      evidence:
        activity === 'unknown'
          ? null
          : {
              acceptanceId: 'accept-1',
              acceptedSeq: 1,
              acceptedAt: NOW - 5_000,
              producerInstanceId: 'producer-1',
              producerSeq: 1,
              eventId: 'event-1',
              invocationId: 'invocation-1',
              factKinds: ['activity'],
              occurredAt: NOW - 5_000,
              observedAt: NOW - 5_000,
              ...(activity === 'working'
                ? { leaseExpiresAt: options.leaseExpiresAt ?? NOW + 30_000 }
                : {})
            }
    },
    updatedAt: NOW - 5_000
  };
}

function batch(snapshot?: SessionStateSnapshot): AgentStateBatch {
  return {
    ok: true,
    revision: 42,
    snapshots: snapshot ? [snapshot] : []
  };
}

describe('canonical channel delivery decisions', () => {
  it('delivers only when the supplied authority batch says the agent is idle', () => {
    const decision = canonicalDeliveryDecision(batch(agentSnapshot('idle')), 'session-a', NOW);

    expect(decision).toMatchObject({
      deliver: true,
      view: {
        authorityRevision: 42,
        lifecycle: 'running',
        activity: 'idle',
        wait: null,
        actionable: false
      }
    });
  });

  // A mid-turn agent is not unreachable. Every provider Desk drives buffers
  // typed input and consumes it when the turn ends — the same thing that
  // happens when an operator types a follow-up without waiting. Refusing here
  // made a busy agent look unreachable and forced the operator to watch the
  // lamp before daring to speak.
  it('DELIVERS to an agent that is mid-turn — the provider queues the input', () => {
    expect(canonicalDeliveryDecision(batch(agentSnapshot('working')), 'session-a', NOW)).toMatchObject({
      deliver: true,
      view: { activity: 'working', actionable: false }
    });
  });

  it('downgrades an expired working lease to unknown so it cannot suppress forever', () => {
    const state = batch(agentSnapshot('working', { leaseExpiresAt: NOW - 1 }));

    expect(canonicalAgentView(state, 'session-a', NOW)).toMatchObject({
      authorityRevision: 42,
      activity: 'unknown',
      wait: null,
      actionable: false
    });
    // "so it cannot suppress forever" is the whole point: an expired lease is
    // the absence of evidence, and delivery must resume rather than wait for a
    // producer that may never speak again.
    expect(canonicalDeliveryDecision(state, 'session-a', NOW)).toMatchObject({
      deliver: true,
      view: { activity: 'unknown' }
    });
  });

  it('DELIVERS when there is no evidence — absence of evidence is not "busy"', () => {
    // Every session started before hooks existed reads `unknown`, as does any
    // session on a machine where the operator declined to install them.
    // Refusing here made the product unusable in its default state: the
    // operator wrote to their agents and nothing was ever delivered.
    const noSnapshot: AgentStateBatch = { ok: true, revision: 42, snapshots: [] };
    expect(canonicalDeliveryDecision(noSnapshot, 'session-a', NOW)).toMatchObject({
      deliver: true,
      view: { activity: 'unknown' }
    });
    const terminalSubject = batch({ ...agentSnapshot('idle'), subject: { kind: 'terminal' as const } } as never);
    expect(canonicalDeliveryDecision(terminalSubject, 'session-a', NOW)).toMatchObject({ deliver: true });
  });

  it('marks operator waits actionable without treating provider waits as operator work', () => {
    const operator = canonicalDeliveryDecision(
      batch(agentSnapshot('blocked', { waitKind: 'input', waitOwner: 'operator' })),
      'session-a',
      NOW
    );
    const provider = canonicalDeliveryDecision(
      batch(agentSnapshot('blocked', { waitKind: 'rate-limit', waitOwner: 'provider' })),
      'session-a',
      NOW
    );

    // `actionable` still separates "the operator has to do something" from
    // "the provider does" — the lamp and the status dot read it. What it no
    // longer does is gate delivery: both cases DELIVER.
    expect(operator).toMatchObject({
      deliver: true,
      view: { activity: 'blocked', actionable: true, wait: { owner: 'operator' } }
    });
    expect(provider).toMatchObject({
      deliver: true,
      view: { activity: 'blocked', actionable: false, wait: { owner: 'provider' } }
    });
  });

  it('never defaults missing, terminal-only, starting, or exited sessions to idle', () => {
    const terminal = {
      ...agentSnapshot('idle'),
      subject: { kind: 'terminal' as const }
    };

    expect(canonicalAgentView(batch(), 'session-a', NOW).activity).toBe('unknown');
    expect(canonicalAgentView(batch(terminal), 'session-a', NOW).activity).toBe('unknown');
    expect(canonicalAgentView(batch(agentSnapshot('idle', { lifecycle: 'starting' })), 'session-a', NOW).activity).toBe(
      'unknown'
    );
    expect(canonicalAgentView(batch(agentSnapshot('idle', { lifecycle: 'exited' })), 'session-a', NOW).activity).toBe(
      'unknown'
    );
  });

  it('does not accept screen text as an activity input', () => {
    const supplied = batch(agentSnapshot('idle'));
    const misleadingPane = '✻ Working… (esc to interrupt)\n\u0007\nAllow command?\n› Yes\n  No';

    expect(canonicalAgentView(supplied, 'session-a', NOW)).toMatchObject({ activity: 'idle' });
    expect(canonicalDeliveryDecision(supplied, 'session-a', NOW)).toMatchObject({ deliver: true });
    expect(misleadingPane).toContain('Working');
  });

  it('keeps delivering when the authority read itself failed', () => {
    // A daemon hiccup must not silently sever the operator from every agent.
    // Blocking on an unreadable authority is the same silent-total failure as
    // blocking on a session that never reported.
    const failed: AgentStateBatch = { ok: false, revision: null, snapshots: [] };

    expect(canonicalDeliveryDecision(failed, 'session-a', NOW)).toMatchObject({
      deliver: true,
      view: { authorityRevision: null, lifecycle: 'unknown', activity: 'unknown' }
    });
  });

  // NO activity refuses. The operator's rule is that the engine never withholds
  // a message, and that includes the case with the strongest argument against
  // it: a session sitting on an approval prompt, where the arriving text can be
  // read as the answer. That risk is visible when it happens and recoverable;
  // a channel that silently keeps messages is neither.
  it.each([
    ['an approval prompt the operator must answer', 'approval', 'operator'],
    ['a provider-side wait', 'retry', 'provider']
  ])('delivers even while blocked on %s', (_case, waitKind, waitOwner) => {
    expect(
      canonicalDeliveryDecision(
        batch(agentSnapshot('blocked', { waitKind, waitOwner: waitOwner as 'operator' | 'provider' })),
        'session-a',
        NOW
      )
    ).toMatchObject({ deliver: true });
  });

  // A live working lease no longer suppresses delivery, and this is the test
  // that would fail if someone reinstated the old `busy` refusal.
  it('delivers even when the working lease is fresh and far from expiry', () => {
    expect(
      canonicalDeliveryDecision(
        batch(agentSnapshot('working', { leaseExpiresAt: NOW + 60_000 })),
        'session-a',
        NOW
      )
    ).toMatchObject({ deliver: true, view: { activity: 'working' } });
  });
});
