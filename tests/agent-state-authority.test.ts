import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AcceptedAgentStateEvent,
  type AgentSemanticFact,
  type AgentStateEnvelope,
  parseSessionStateSnapshot
} from '../src/shared/controlPlane/contract.js';
import { AgentStateAuthority, MOOR_LIVENESS_REASON } from '../src/shared/controlPlane/authority.js';

const SESSION_ID = 'codex-2';
const GENERATION = 4;
const INSTANCE_ID = 'hooks-boot-a';

function accepted(
  producerSeq: number,
  facts: AgentSemanticFact[],
  overrides: Partial<AgentStateEnvelope> & { acceptedAt?: number } = {}
): AcceptedAgentStateEvent {
  const acceptedAt = overrides.acceptedAt ?? 1_000 + producerSeq;
  const envelope: AgentStateEnvelope = {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    generation: GENERATION,
    provider: 'codex',
    mode: 'terminal',
    producer: 'codex-hooks',
    producerInstanceId: INSTANCE_ID,
    producerSeq,
    eventId: `${INSTANCE_ID}:${producerSeq}`,
    invocationId: `turn-1`,
    occurredAt: 100,
    observedAt: 200,
    facts,
    ...overrides
  };
  delete (envelope as AgentStateEnvelope & { acceptedAt?: number }).acceptedAt;
  return {
    acceptanceId: `accepted:${producerSeq}`,
    acceptedSeq: producerSeq,
    acceptedAt,
    envelope
  };
}

function registerAgent(authority: AgentStateAuthority, producerInstanceId?: string): void {
  authority.registerSession({
    sessionId: SESSION_ID,
    generation: GENERATION,
    lifecycle: 'running',
    subject: {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      producerInstanceId
    }
  });
}

function applied(result: ReturnType<AgentStateAuthority['ingest']>) {
  expect(result.kind).toBe('applied');
  if (result.kind !== 'applied') {
    throw new Error(`expected applied, got ${result.kind}`);
  }
  return result;
}

describe('AgentStateAuthority', () => {
  it('registers agents unknown/degraded and terminals without an activity axis', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority);
    authority.registerSession({
      sessionId: 'shell',
      generation: 1,
      lifecycle: 'running',
      subject: { kind: 'terminal' }
    });

    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      lifecycle: 'running',
      health: { status: 'degraded', reason: 'awaiting-reconciliation' },
      subject: {
        kind: 'agent',
        activity: 'unknown',
        wait: null,
        evidence: null
      }
    });
    expect(authority.snapshot('shell')?.subject).toEqual({ kind: 'terminal' });
    expect(authority.snapshot('shell')?.subject).not.toHaveProperty('activity');
  });

  it('returns one atomic snapshot view under a shared authority revision', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority);
    authority.registerSession({
      sessionId: 'shell',
      generation: 1,
      lifecycle: 'running',
      subject: { kind: 'terminal' }
    });

    const view = authority.snapshotView();
    expect(view.revision).toBe(2);
    expect(view.snapshots.map((snapshot) => snapshot.sessionId).sort()).toEqual([SESSION_ID, 'shell'].sort());
    expect(view.snapshots.every((snapshot) => snapshot.revision <= view.revision)).toBe(true);
  });

  it('rejects the wrong generation and producer without mutating the snapshot', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority);
    const before = authority.snapshot(SESSION_ID);

    expect(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }], { generation: 3 }))).toMatchObject({
      kind: 'rejected',
      reason: 'generation-mismatch'
    });
    expect(
      authority.ingest(
        accepted(1, [{ kind: 'activity', activity: 'working' }], {
          provider: 'claude',
          producer: 'claude-hooks'
        })
      )
    ).toMatchObject({
      kind: 'rejected',
      reason: 'producer-mismatch'
    });
    expect(authority.snapshot(SESSION_ID)).toEqual(before);
  });

  it('binds one producer instance and requires explicit reconciliation to replace it', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority);
    applied(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }])));

    expect(
      authority.ingest(
        accepted(1, [{ kind: 'activity', activity: 'idle' }], {
          producerInstanceId: 'hooks-boot-b',
          eventId: 'hooks-boot-b:1'
        })
      )
    ).toMatchObject({ kind: 'rejected', reason: 'producer-instance-mismatch' });

    authority.reconcileProducer(SESSION_ID, GENERATION, 'hooks-boot-b');
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'awaiting-reconciliation' },
      subject: { kind: 'agent', activity: 'unknown', evidence: null }
    });
    expect(
      authority.ingest(
        accepted(1, [{ kind: 'activity', activity: 'idle' }], {
          producerInstanceId: 'hooks-boot-b',
          eventId: 'hooks-boot-b:1'
        })
      )
    ).toMatchObject({ kind: 'applied' });
  });

  it('applies generation-fenced source health without changing agent activity or evidence', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({
      now: () => now,
      workingLeaseMs: 50,
      openToolLeaseMs: 500
    });
    registerAgent(authority, INSTANCE_ID);
    applied(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }], { acceptedAt: now })));
    const before = authority.snapshot(SESSION_ID)!;

    expect(
      authority.assessAgentHealth(SESSION_ID, GENERATION - 1, {
        status: 'degraded',
        reason: 'hook-not-installed'
      })
    ).toMatchObject({ kind: 'rejected', reason: 'generation-mismatch' });
    expect(authority.snapshot(SESSION_ID)).toEqual(before);

    now = 1_010;
    const degraded = authority.assessAgentHealth(SESSION_ID, GENERATION, {
      status: 'degraded',
      reason: 'hook-not-installed',
      detail: 'Desk hook config is absent'
    });
    expect(degraded).toMatchObject({
      kind: 'applied',
      transition: { cause: 'source-health' },
      snapshot: {
        health: {
          status: 'degraded',
          reason: 'hook-not-installed',
          detail: 'Desk hook config is absent',
          since: now
        },
        subject: before.subject
      }
    });
    const revision = degraded.kind === 'applied' ? degraded.snapshot.revision : -1;

    now = 1_020;
    expect(
      authority.assessAgentHealth(SESSION_ID, GENERATION, {
        status: 'degraded',
        reason: 'hook-not-installed',
        detail: 'Desk hook config is absent'
      })
    ).toMatchObject({ kind: 'noop', snapshot: { revision } });

    now = 1_030;
    expect(authority.assessAgentHealth(SESSION_ID, GENERATION, { status: 'healthy' })).toMatchObject({
      kind: 'applied',
      transition: { cause: 'source-health' },
      snapshot: {
        health: { status: 'healthy', since: now },
        subject: before.subject
      }
    });
  });

  it('rejects duplicate and lower producer sequences without regression', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    applied(authority.ingest(accepted(2, [{ kind: 'activity', activity: 'working' }])));
    const working = authority.snapshot(SESSION_ID);

    expect(authority.ingest(accepted(2, [{ kind: 'activity', activity: 'idle' }]))).toMatchObject({
      kind: 'rejected',
      reason: 'producer-order'
    });
    expect(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'idle' }]))).toMatchObject({
      kind: 'rejected',
      reason: 'producer-order'
    });
    expect(authority.snapshot(SESSION_ID)).toEqual(working);
  });

  it('orders live-poll evidence separately without consuming the push sequence', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    applied(authority.ingest(accepted(8, [{ kind: 'activity', activity: 'working' }])));

    const poll = accepted(1, [{ kind: 'activity', activity: 'idle' }], {
      transport: 'poll',
      eventId: `${INSTANCE_ID}:poll:1`,
      acceptedAt: 2_000
    });
    poll.acceptedSeq = 9;
    poll.acceptanceId = 'accepted:poll:9';
    applied(authority.ingest(poll));

    const nextPush = accepted(9, [{ kind: 'activity', activity: 'working' }], {
      acceptedAt: 2_001
    });
    nextPush.acceptedSeq = 10;
    nextPush.acceptanceId = 'accepted:push:10';
    applied(authority.ingest(nextPush));
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({
      activity: 'working',
      evidence: { producerSeq: 9, transport: 'push' }
    });
  });

  it('uses daemon acceptance time for working leases and renews only with heartbeat', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => now, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.ingest(
        accepted(1, [{ kind: 'activity', activity: 'working' }], {
          occurredAt: 9_999_999,
          observedAt: 9_999_999,
          acceptedAt: now
        })
      )
    );
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      subject: {
        kind: 'agent',
        activity: 'working',
        evidence: { leaseExpiresAt: 1_050 }
      }
    });

    now = 1_040;
    applied(authority.ingest(accepted(2, [{ kind: 'heartbeat' }], { acceptedAt: now })));
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      subject: {
        kind: 'agent',
        activity: 'working',
        evidence: { leaseExpiresAt: 1_090 }
      }
    });
  });

  it('never promotes idle, blocked, or unknown from a heartbeat', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 1_000, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);

    applied(authority.ingest(accepted(1, [{ kind: 'heartbeat' }], { acceptedAt: 1_000 })));
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'unknown' });

    applied(authority.ingest(accepted(2, [{ kind: 'activity', activity: 'idle' }], { acceptedAt: 1_001 })));
    applied(authority.ingest(accepted(3, [{ kind: 'heartbeat' }], { acceptedAt: 1_002 })));
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'idle' });

    applied(
      authority.ingest(
        accepted(
          4,
          [{ kind: 'blocked', wait: { kind: 'rate-limit', owner: 'provider' } }],
          { acceptedAt: 1_003 }
        )
      )
    );
    applied(authority.ingest(accepted(5, [{ kind: 'heartbeat' }], { acceptedAt: 1_004 })));
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({
      activity: 'blocked',
      wait: { owner: 'provider' }
    });
  });

  it('lets accepted heartbeat evidence restore source health without promoting activity', () => {
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 1_000,
      workingLeaseMs: 50
    });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.assessAgentHealth(SESSION_ID, GENERATION, {
        status: 'degraded',
        reason: 'hook-not-installed'
      })
    );

    applied(
      authority.ingest(
        accepted(1, [{ kind: 'heartbeat' }], { acceptedAt: 1_001 })
      )
    );
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'healthy', since: 1_001 },
      subject: {
        activity: 'unknown',
        evidence: { factKinds: ['heartbeat'] }
      }
    });
  });

  it('expires working to unknown/source-stale, never idle', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => now, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    applied(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }], { acceptedAt: now })));

    now = 1_050;
    authority.refresh(SESSION_ID);
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'source-stale' },
      subject: { kind: 'agent', activity: 'unknown' }
    });

    applied(authority.ingest(accepted(2, [{ kind: 'heartbeat' }], { acceptedAt: 1_051 })));
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'unknown' });
  });

  it('keeps a typed open tool working past the short lease but not past its bounded ceiling', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({
      now: () => now,
      workingLeaseMs: 50,
      openToolLeaseMs: 500
    });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.ingest(
        accepted(1, [{ kind: 'tool', phase: 'start' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-1' }
        })
      )
    );
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'healthy' },
      subject: {
        kind: 'agent',
        activity: 'working',
        evidence: {
          factKinds: ['tool'],
          leaseExpiresAt: 1_500
        }
      }
    });

    now = 1_050;
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'working' });
    now = 1_499;
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'working' });
    now = 1_500;
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'source-stale' },
      subject: { kind: 'agent', activity: 'unknown' }
    });
  });

  it('closes only the matching tool interval and resumes the short working lease', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({
      now: () => now,
      workingLeaseMs: 50,
      openToolLeaseMs: 500
    });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.ingest(
        accepted(1, [{ kind: 'tool', phase: 'start' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-1' }
        })
      )
    );
    now = 1_010;
    applied(
      authority.ingest(
        accepted(2, [{ kind: 'tool', phase: 'start' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-2' }
        })
      )
    );
    now = 1_100;
    applied(
      authority.ingest(
        accepted(3, [{ kind: 'tool', phase: 'end' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-1' }
        })
      )
    );
    now = 1_150;
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'working' });

    now = 1_200;
    applied(
      authority.ingest(
        accepted(4, [{ kind: 'tool', phase: 'end' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-2' }
        })
      )
    );
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({
      activity: 'working',
      evidence: { leaseExpiresAt: 1_250 }
    });
    now = 1_250;
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'source-stale' },
      subject: { kind: 'agent', activity: 'unknown' }
    });
  });

  it('lets a fresh heartbeat outlive an older open-tool ceiling by only the short lease', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({
      now: () => now,
      workingLeaseMs: 50,
      openToolLeaseMs: 500
    });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.ingest(
        accepted(1, [{ kind: 'tool', phase: 'start' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-1' }
        })
      )
    );

    now = 1_490;
    applied(authority.ingest(accepted(2, [{ kind: 'heartbeat' }], { acceptedAt: now })));
    now = 1_500;
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({
      activity: 'working',
      evidence: { leaseExpiresAt: 1_540 }
    });
    now = 1_540;
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'source-stale' },
      subject: { kind: 'agent', activity: 'unknown' }
    });
  });

  it('does not promote an unknown agent from an unmatched tool end', () => {
    const authority = new AgentStateAuthority({
      now: () => 1_000,
      workingLeaseMs: 50,
      openToolLeaseMs: 500
    });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.ingest(
        accepted(1, [{ kind: 'tool', phase: 'end' }], {
          acceptedAt: 1_000,
          correlation: { toolUseId: 'missing-tool' }
        })
      )
    );
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'healthy', since: 1_000 },
      subject: {
        activity: 'unknown',
        evidence: { factKinds: ['tool'] }
      }
    });
  });

  it('does not let an old tool interval survive an explicit non-working state', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({
      now: () => now,
      workingLeaseMs: 50,
      openToolLeaseMs: 500
    });
    registerAgent(authority, INSTANCE_ID);
    applied(
      authority.ingest(
        accepted(1, [{ kind: 'tool', phase: 'start' }], {
          acceptedAt: now,
          correlation: { toolUseId: 'tool-1' }
        })
      )
    );
    now = 1_010;
    applied(authority.ingest(accepted(2, [{ kind: 'activity', activity: 'idle' }], { acceptedAt: now })));
    now = 1_020;
    applied(authority.ingest(accepted(3, [{ kind: 'activity', activity: 'working' }], { acceptedAt: now })));

    now = 1_070;
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'source-stale' },
      subject: { kind: 'agent', activity: 'unknown' }
    });
  });

  it('keeps explicit idle and blocked stable until an explicit typed change', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => now, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    applied(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'idle' }], { acceptedAt: now })));
    now = 1_000_000;
    authority.refresh(SESSION_ID);
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({ activity: 'idle' });

    applied(
      authority.ingest(
        accepted(2, [{ kind: 'blocked', wait: { kind: 'approval', owner: 'operator' } }], {
          acceptedAt: now
        })
      )
    );
    now += 1_000_000;
    authority.refresh(SESSION_ID);
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({
      activity: 'blocked',
      wait: { owner: 'operator' }
    });

    applied(authority.ingest(accepted(3, [{ kind: 'unblocked' }], { acceptedAt: now + 1 })));
    expect(authority.snapshot(SESSION_ID)?.subject).toMatchObject({
      activity: 'unknown',
      wait: null
    });
  });

  it('marks only transitions into operator waits actionable', () => {
    const transitions = vi.fn();
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 1_000, workingLeaseMs: 50, onTransition: transitions });
    registerAgent(authority, INSTANCE_ID);
    transitions.mockClear();

    const provider = applied(
      authority.ingest(
        accepted(1, [{ kind: 'blocked', wait: { kind: 'rate-limit', owner: 'provider' } }], {
          acceptedAt: 1_000
        })
      )
    );
    expect(provider.transition.actionable).toBe(false);

    const operator = applied(
      authority.ingest(
        accepted(2, [{ kind: 'blocked', wait: { kind: 'approval', owner: 'operator' } }], {
          acceptedAt: 1_001
        })
      )
    );
    expect(operator.transition.actionable).toBe(true);
  });

  it('applies multi-axis fact batches atomically at one revision', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 1_000, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    const result = applied(
      authority.ingest(
        accepted(
          1,
          [
            { kind: 'activity', activity: 'idle' },
            {
              kind: 'health',
              health: { status: 'degraded', reason: 'output-length', detail: 'Output limit reached' }
            }
          ],
          { acceptedAt: 1_000 }
        )
      )
    );

    expect(result.snapshot).toMatchObject({
      revision: result.transition.revision,
      health: { status: 'degraded', reason: 'output-length' },
      subject: {
        kind: 'agent',
        activity: 'idle',
        evidence: { factKinds: ['activity', 'health'] }
      }
    });
    expect(result.transition.to).toEqual(result.snapshot);
  });

  it('process exit is immediate and removes activity evidence', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 1_000, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    applied(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }], { acceptedAt: 1_000 })));

    authority.markExited(SESSION_ID, GENERATION, { code: null, signal: 'SIGKILL' });
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      lifecycle: 'exited',
      exit: { code: null, signal: 'SIGKILL', at: 1_000 },
      subject: {
        kind: 'agent',
        activity: 'unknown',
        wait: null,
        evidence: null
      }
    });
    expect(authority.ingest(accepted(2, [{ kind: 'activity', activity: 'idle' }]))).toMatchObject({
      kind: 'rejected',
      reason: 'lifecycle-exited'
    });
  });

  it('restored live generations start unknown and cannot replay historical activity', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 2_000, workingLeaseMs: 50 });
    const restored = authority.registerSession({
      sessionId: SESSION_ID,
      generation: GENERATION,
      lifecycle: 'running',
      subject: {
        kind: 'agent',
        provider: 'codex',
        mode: 'terminal',
        producer: 'codex-hooks'
      }
    });

    expect(restored).toMatchObject({
      lifecycle: 'running',
      health: { status: 'degraded', reason: 'awaiting-reconciliation' },
      subject: { kind: 'agent', activity: 'unknown', evidence: null }
    });
    expect(authority).not.toHaveProperty('replay');
    expect(authority).not.toHaveProperty('restoreActivity');
  });

  it('increments revisions only for accepted mutations and returns defensive snapshots', () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 1_000, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);
    const registeredRevision = authority.snapshot(SESSION_ID)!.revision;
    const first = applied(authority.ingest(accepted(1, [{ kind: 'activity', activity: 'idle' }])));
    expect(first.snapshot.revision).toBeGreaterThan(registeredRevision);
    expect(first.transition.revision).toBe(first.snapshot.revision);

    const external = authority.snapshot(SESSION_ID)!;
    external.health = { status: 'degraded', reason: 'mutated-copy', since: 0 };
    expect(authority.snapshot(SESSION_ID)?.health).not.toMatchObject({ reason: 'mutated-copy' });

    authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }]));
    expect(authority.snapshot(SESSION_ID)?.revision).toBe(first.snapshot.revision);
  });

  it('projects an initial title observation as explicitly degraded fallback state', () => {
    const transitions = vi.fn();
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 1_000,
      workingLeaseMs: 50,
      onTransition: transitions
    });
    registerAgent(authority, INSTANCE_ID);

    const result = authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', 1_001);
    expect(result).toMatchObject({
      kind: 'applied',
      snapshot: {
        health: { status: 'degraded', reason: 'title-fallback', since: 1_001 },
        subject: {
          kind: 'agent',
          activity: 'working',
          activitySince: 1_001,
          evidence: { source: 'terminal-title', observedAt: 1_001 }
        }
      },
      transition: { cause: 'title-fallback' }
    });
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(parseSessionStateSnapshot(result.snapshot)).toEqual(result.snapshot);
    expect(transitions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cause: 'title-fallback' })
    );
  });

  it('keeps title-derived working state stable without a semantic lease', () => {
    let now = 1_000;
    const transitions = vi.fn();
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => now,
      workingLeaseMs: 50,
      onTransition: transitions
    });
    registerAgent(authority, INSTANCE_ID);
    transitions.mockClear();
    const projected = authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', now);
    expect(projected.kind).toBe('applied');
    if (projected.kind !== 'applied') {
      throw new Error(`expected applied, got ${projected.kind}`);
    }
    const projectedRevision = projected.snapshot.revision;

    now = 10_000;
    const first = authority.snapshot(SESSION_ID);
    const second = authority.snapshot(SESSION_ID);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      revision: projectedRevision,
      health: { status: 'degraded', reason: 'title-fallback', since: 1_000 },
      subject: {
        kind: 'agent',
        activity: 'working',
        activitySince: 1_000,
        evidence: { source: 'terminal-title', observedAt: 1_000 }
      }
    });
    expect(transitions).toHaveBeenCalledTimes(1);
  });

  it('lets semantic activity override and suppress later title observations', () => {
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 1_000,
      workingLeaseMs: 50
    });
    registerAgent(authority, INSTANCE_ID);
    authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', 1_000);
    const semantic = applied(
      authority.ingest(accepted(1, [{ kind: 'activity', activity: 'idle' }], { acceptedAt: 1_010 }))
    );

    const fallback = authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', 1_020);
    expect(fallback).toMatchObject({ kind: 'noop' });
    expect(fallback.snapshot).toEqual(semantic.snapshot);
    expect(fallback.snapshot).toMatchObject({
      health: { status: 'healthy' },
      subject: { kind: 'agent', activity: 'idle', evidence: { acceptanceId: 'accepted:1' } }
    });
  });

  it('keeps title fallback active across heartbeat-only producer events', () => {
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 1_000,
      workingLeaseMs: 50
    });
    registerAgent(authority, INSTANCE_ID);
    authority.observeTitleActivity(SESSION_ID, GENERATION, 'idle', 1_000);

    const heartbeat = applied(
      authority.ingest(accepted(1, [{ kind: 'heartbeat' }], { acceptedAt: 1_010 }))
    );
    expect(heartbeat.snapshot).toMatchObject({
      health: { status: 'degraded', reason: 'title-fallback', since: 1_000 },
      subject: {
        kind: 'agent',
        activity: 'idle',
        activitySince: 1_000,
        evidence: { source: 'terminal-title', observedAt: 1_000 }
      }
    });

    expect(
      authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', 1_020)
    ).toMatchObject({
      kind: 'applied',
      snapshot: {
        health: { status: 'degraded', reason: 'title-fallback', since: 1_020 },
        subject: {
          kind: 'agent',
          activity: 'working',
          activitySince: 1_020,
          evidence: { source: 'terminal-title', observedAt: 1_020 }
        }
      }
    });
  });

  it('suppresses title fallback for producer-reported unknown', () => {
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 1_000,
      workingLeaseMs: 50
    });
    registerAgent(authority, INSTANCE_ID);
    const semantic = applied(
      authority.ingest(accepted(1, [{ kind: 'activity', activity: 'unknown' }]))
    );

    const fallback = authority.observeTitleActivity(SESSION_ID, GENERATION, 'idle', 1_010);
    expect(fallback).toMatchObject({ kind: 'noop' });
    expect(fallback.snapshot).toEqual(semantic.snapshot);
    expect(fallback.snapshot).toMatchObject({
      health: { status: 'degraded', reason: 'producer-reported-unknown' },
      subject: { kind: 'agent', activity: 'unknown', evidence: { acceptanceId: 'accepted:1' } }
    });
  });

  it('reapplies the latest title fallback after a semantic working lease expires', () => {
    let now = 1_000;
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => now,
      workingLeaseMs: 50
    });
    registerAgent(authority, INSTANCE_ID);
    authority.observeTitleActivity(SESSION_ID, GENERATION, 'idle', 1_000);
    applied(
      authority.ingest(accepted(1, [{ kind: 'activity', activity: 'working' }], { acceptedAt: 1_010 }))
    );
    authority.observeTitleActivity(SESSION_ID, GENERATION, 'idle', 1_020);

    now = 1_061;
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      health: { status: 'degraded', reason: 'title-fallback', since: 1_061 },
      subject: {
        kind: 'agent',
        activity: 'idle',
        activitySince: 1_061,
        evidence: { source: 'terminal-title', observedAt: 1_020 }
      }
    });
  });

  it('rejects stale generations and clears fallback state on generation replacement and exit', () => {
    const authority = new AgentStateAuthority({
      openToolLeaseMs: 500,
      now: () => 1_000,
      workingLeaseMs: 50
    });
    registerAgent(authority, INSTANCE_ID);
    authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', 1_000);

    expect(
      authority.observeTitleActivity(SESSION_ID, GENERATION - 1, 'idle', 1_001)
    ).toMatchObject({ kind: 'rejected', reason: 'generation-mismatch' });
    authority.markExited(SESSION_ID, GENERATION, { code: 0, signal: null });
    expect(
      authority.observeTitleActivity(SESSION_ID, GENERATION, 'working', 1_002)
    ).toMatchObject({ kind: 'rejected', reason: 'lifecycle-exited' });

    authority.registerSession({
      sessionId: SESSION_ID,
      generation: GENERATION + 1,
      lifecycle: 'running',
      subject: {
        kind: 'agent',
        provider: 'codex',
        mode: 'terminal',
        producer: 'codex-hooks'
      }
    });
    expect(authority.snapshot(SESSION_ID)).toMatchObject({
      generation: GENERATION + 1,
      subject: { kind: 'agent', activity: 'unknown', evidence: null }
    });
  });
});

describe('observeHolderLiveness (§10 indeterminate state)', () => {
  function makeTerminal(now: () => number): AgentStateAuthority {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now, workingLeaseMs: 50 });
    authority.registerSession({
      sessionId: 'shell',
      generation: 2,
      lifecycle: 'running',
      subject: { kind: 'terminal' }
    });
    return authority;
  }

  it('degrades ANY subject kind on lost liveness, refines detail, and restores only its own reason', () => {
    let at = 10;
    const authority = makeTerminal(() => at);

    at = 20;
    const lost = authority.observeHolderLiveness('shell', 2, false, 'probe-pending');
    expect(lost.kind).toBe('applied');
    expect(authority.snapshot('shell')?.health).toEqual({
      status: 'degraded',
      reason: MOOR_LIVENESS_REASON,
      since: 20,
      detail: 'probe-pending'
    });

    // The bounded probe refines the SAME degradation in place.
    at = 30;
    const refined = authority.observeHolderLiveness('shell', 2, false, 'rendezvous-live');
    expect(refined.kind).toBe('applied');
    expect(authority.snapshot('shell')?.health).toMatchObject({
      status: 'degraded',
      reason: MOOR_LIVENESS_REASON,
      detail: 'rendezvous-live'
    });

    // Identical repeat carries no information.
    expect(authority.observeHolderLiveness('shell', 2, false, 'rendezvous-live').kind).toBe('noop');

    at = 40;
    const restored = authority.observeHolderLiveness('shell', 2, true);
    expect(restored.kind).toBe('applied');
    // The EXACT overlaid health returns — the session was healthy since 10
    // and the false alarm does not break that continuity.
    expect(authority.snapshot('shell')?.health).toEqual({ status: 'healthy', since: 10 });
    // Restoring an already-healthy session is a no-op, not a health churn.
    expect(authority.observeHolderLiveness('shell', 2, true).kind).toBe('noop');
  });

  it("restores a producer's own degradation verbatim after a liveness round-trip", () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority); // degraded 'awaiting-reconciliation' since 10

    authority.observeHolderLiveness(SESSION_ID, GENERATION, false, 'probe-pending');
    expect(authority.snapshot(SESSION_ID)?.health).toMatchObject({
      status: 'degraded',
      reason: MOOR_LIVENESS_REASON
    });
    const restored = authority.observeHolderLiveness(SESSION_ID, GENERATION, true);
    expect(restored.kind).toBe('applied');
    expect(authority.snapshot(SESSION_ID)?.health).toMatchObject({
      status: 'degraded',
      reason: 'awaiting-reconciliation'
    });
  });

  it("a producer statement DURING the episode supersedes the saved overlay", () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority, INSTANCE_ID);

    authority.observeHolderLiveness(SESSION_ID, GENERATION, false, 'probe-pending');
    // The producer speaks while the liveness overlay is active: ITS statement
    // wins over anything the overlay saved.
    expect(
      authority.assessAgentHealth(SESSION_ID, GENERATION, { status: 'healthy' }).kind
    ).toBe('applied');
    // Restoration finds a foreign (healthy) health — nothing ours to clear,
    // and the stale saved overlay must not resurrect the old degradation.
    expect(authority.observeHolderLiveness(SESSION_ID, GENERATION, true).kind).toBe('noop');
    expect(authority.snapshot(SESSION_ID)?.health).toMatchObject({ status: 'healthy' });
  });

  it("never clears another source's degradation on restoration", () => {
    const authority = new AgentStateAuthority({ openToolLeaseMs: 500, now: () => 10, workingLeaseMs: 50 });
    registerAgent(authority); // registers degraded 'awaiting-reconciliation'
    expect(authority.snapshot(SESSION_ID)?.health).toMatchObject({
      status: 'degraded',
      reason: 'awaiting-reconciliation'
    });
    const restored = authority.observeHolderLiveness(SESSION_ID, GENERATION, true);
    expect(restored.kind).toBe('noop');
    expect(authority.snapshot(SESSION_ID)?.health).toMatchObject({
      status: 'degraded',
      reason: 'awaiting-reconciliation'
    });
  });

  it('rejects a stale generation and an exited lifecycle', () => {
    let at = 10;
    const authority = makeTerminal(() => at);
    expect(authority.observeHolderLiveness('shell', 1, false, 'probe-pending').kind).toBe('rejected');
    expect(authority.observeHolderLiveness('missing', 2, false).kind).toBe('rejected');

    at = 20;
    authority.markExited('shell', 2, { code: 0, signal: null });
    const afterExit = authority.observeHolderLiveness('shell', 2, false, 'probe-pending');
    expect(afterExit.kind).toBe('rejected');
    expect(authority.snapshot('shell')?.health).not.toMatchObject({
      reason: MOOR_LIVENESS_REASON
    });
  });
});
