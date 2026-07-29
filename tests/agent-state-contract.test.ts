import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AgentStateEnvelope,
  type AgentSubjectSnapshot,
  type SessionStateSnapshot,
  type TerminalSubjectSnapshot,
  parseAgentStateEnvelope,
  parseSessionStateSnapshot
} from '../src/shared/controlPlane/contract.js';

const envelope = (overrides: Partial<AgentStateEnvelope> = {}): AgentStateEnvelope => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  sessionId: 'codex-2',
  generation: 4,
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks',
  producerInstanceId: 'hooks-boot-a',
  producerSeq: 7,
  eventId: 'hooks-boot-a:7',
  invocationId: 'invoke-7',
  occurredAt: 1_000,
  observedAt: 1_005,
  facts: [{ kind: 'activity', activity: 'working' }],
  ...overrides
});

const agentSnapshot = (): SessionStateSnapshot => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  revision: 0,
  sessionId: 'codex-2',
  generation: 4,
  lifecycle: 'running',
  lifecycleSince: 10,
  exit: null,
  health: {
    status: 'degraded',
    reason: 'awaiting-reconciliation',
    since: 10
  },
  delivery: null,
  policy: {
    paused: false,
    since: 10
  },
  subject: {
    kind: 'agent',
    provider: 'codex',
    mode: 'terminal',
    producer: 'codex-hooks',
    activity: 'unknown',
    activitySince: 10,
    wait: null,
    evidence: null
  },
  updatedAt: 10
});

describe('canonical agent-state contract', () => {
  it('accepts the exact versioned producer envelope', () => {
    expect(parseAgentStateEnvelope(envelope())).toEqual(envelope());
    expect(
      parseAgentStateEnvelope(
        envelope({
          facts: [
            {
              kind: 'blocked',
              wait: {
                kind: 'approval',
                owner: 'operator',
                detail: 'Allow shell command?'
              }
            },
            {
              kind: 'health',
              health: {
                status: 'degraded',
                reason: 'permission-wait'
              }
            }
          ],
          correlation: {
            turnId: 'turn-1',
            toolUseId: 'tool-2',
            permissionId: 'permission-3',
            deliveryId: 'delivery-4'
          }
        })
      )
    ).toMatchObject({
      facts: [
        { kind: 'blocked', wait: { owner: 'operator' } },
        { kind: 'health', health: { status: 'degraded' } }
      ]
    });
  });

  it('keeps push and live-poll observations in explicit independent transport domains', () => {
    expect(
      parseAgentStateEnvelope(
        envelope({
          transport: 'poll',
          producerSeq: 1,
          eventId: 'poll:hooks-boot-a:1'
        })
      )
    ).toMatchObject({
      transport: 'poll',
      producerSeq: 1
    });
    expect(() =>
      parseAgentStateEnvelope({
        ...envelope(),
        transport: 'terminal-scrape'
      })
    ).toThrow();
  });

  it.each([
    ['unknown schema', { schemaVersion: 2 }],
    ['zero generation', { generation: 0 }],
    ['negative generation', { generation: -1 }],
    ['zero producer sequence', { producerSeq: 0 }],
    ['fractional producer sequence', { producerSeq: 1.5 }],
    ['empty event ID', { eventId: '' }],
    ['missing invocation ID', { invocationId: undefined }],
    ['mismatched provider', { provider: 'claude' }],
    ['mismatched mode', { mode: 'native' }]
  ])('rejects %s', (_label, overrides) => {
    expect(() =>
      parseAgentStateEnvelope({
        ...envelope(),
        ...overrides
      })
    ).toThrow();
  });

  it('rejects incomplete blocked facts and legacy/conflated fields', () => {
    expect(() =>
      parseAgentStateEnvelope({
        ...envelope(),
        facts: [
          {
            kind: 'blocked',
            wait: {
              kind: 'approval'
            }
          }
        ]
      })
    ).toThrow();

    expect(() =>
      parseAgentStateEnvelope({
        ...envelope(),
        state: 'awaiting-approval',
        source: 'worker-rendered'
      })
    ).toThrow();
  });

  it('keeps heartbeat and unblocked as explicit non-promoting facts', () => {
    expect(parseAgentStateEnvelope(envelope({ facts: [{ kind: 'heartbeat' }] })).facts).toEqual([
      { kind: 'heartbeat' }
    ]);
    expect(parseAgentStateEnvelope(envelope({ facts: [{ kind: 'unblocked' }] })).facts).toEqual([
      { kind: 'unblocked' }
    ]);
    expect(() =>
      parseAgentStateEnvelope(
        envelope({
          facts: [
            {
              kind: 'heartbeat',
              activity: 'working'
            } as never
          ]
        })
      )
    ).toThrow();
  });

  it('requires a correlated tool identity for typed tool interval edges', () => {
    expect(
      parseAgentStateEnvelope(
        envelope({
          facts: [{ kind: 'tool', phase: 'start' }],
          correlation: { toolUseId: 'tool-2' }
        })
      ).facts
    ).toEqual([{ kind: 'tool', phase: 'start' }]);
    expect(
      parseAgentStateEnvelope(
        envelope({
          facts: [{ kind: 'tool', phase: 'end' }],
          correlation: { toolUseId: 'tool-2' }
        })
      ).facts
    ).toEqual([{ kind: 'tool', phase: 'end' }]);
    expect(() =>
      parseAgentStateEnvelope(
        envelope({
          facts: [{ kind: 'tool', phase: 'start' }]
        })
      )
    ).toThrow();
    expect(() =>
      parseAgentStateEnvelope(
        envelope({
          facts: [
            { kind: 'tool', phase: 'start' },
            { kind: 'tool', phase: 'end' }
          ],
          correlation: { toolUseId: 'tool-2' }
        })
      )
    ).toThrow();
  });

  it('requires a non-empty bounded fact batch', () => {
    expect(() => parseAgentStateEnvelope(envelope({ facts: [] }))).toThrow();
    expect(() =>
      parseAgentStateEnvelope(
        envelope({
          facts: Array.from({ length: 9 }, () => ({ kind: 'heartbeat' }) as const)
        })
      )
    ).toThrow();
  });

  it('rejects contradictory facts within one observation batch', () => {
    expect(() =>
      parseAgentStateEnvelope(
        envelope({
          facts: [
            { kind: 'blocked', wait: { kind: 'approval', owner: 'operator' } },
            { kind: 'activity', activity: 'idle' }
          ]
        })
      )
    ).toThrow();
    expect(() =>
      parseAgentStateEnvelope(
        envelope({
          facts: [
            { kind: 'health', health: { status: 'healthy' } },
            { kind: 'health', health: { status: 'degraded', reason: 'provider-error' } }
          ]
        })
      )
    ).toThrow();
  });

  it('accepts an agent snapshot with lifecycle, health, delivery, and policy axes', () => {
    expect(parseSessionStateSnapshot(agentSnapshot())).toEqual(agentSnapshot());
  });

  it('uses a terminal union member with no agent-activity axis', () => {
    expectTypeOf<TerminalSubjectSnapshot>().not.toHaveProperty('activity');
    expectTypeOf<TerminalSubjectSnapshot>().not.toHaveProperty('wait');
    expectTypeOf<TerminalSubjectSnapshot>().not.toHaveProperty('producer');
    expectTypeOf<AgentSubjectSnapshot>().toHaveProperty('activity');

    const terminal: SessionStateSnapshot = {
      ...agentSnapshot(),
      sessionId: 'shell',
      subject: { kind: 'terminal' }
    };
    expect(parseSessionStateSnapshot(terminal)).toEqual(terminal);

    expect(() =>
      parseSessionStateSnapshot({
        ...terminal,
        subject: {
          kind: 'terminal',
          activity: 'unknown'
        }
      })
    ).toThrow();
  });

  it('rejects contradictory snapshot axes', () => {
    expect(() =>
      parseSessionStateSnapshot({
        ...agentSnapshot(),
        subject: {
          ...(agentSnapshot().subject as AgentSubjectSnapshot),
          activity: 'blocked',
          wait: null
        }
      })
    ).toThrow();

    expect(() =>
      parseSessionStateSnapshot({
        ...agentSnapshot(),
        lifecycle: 'exited',
        exit: null
      })
    ).toThrow();
  });
});
