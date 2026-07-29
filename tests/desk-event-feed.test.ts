import { describe, expect, it } from 'vitest';
import {
  DESK_EVENT_SCHEMA_VERSION,
  parseChannelMessageDeskEventInput,
  parseDeskEvent,
  projectTransitionToDeskEvents,
  type SessionStateSnapshot,
  type SessionStateTransition
} from '../src/shared/controlPlane/index.js';
import { canonicalAgentSnapshot } from './helpers/canonicalAgentState.js';

function transition(
  from: SessionStateSnapshot | null,
  to: SessionStateSnapshot,
  overrides: Partial<SessionStateTransition> = {}
): SessionStateTransition {
  return {
    schemaVersion: to.schemaVersion,
    revision: to.revision,
    sessionId: to.sessionId,
    generation: to.generation,
    at: to.updatedAt,
    cause: 'agent-event',
    actionable: false,
    from,
    to,
    ...overrides
  };
}

describe('Desk event feed contract', () => {
  it('projects only an actionable operator block as agent-blocked', () => {
    const from = canonicalAgentSnapshot('agent-a', {
      activity: 'working',
      now: 1_000,
      revision: 4
    });
    const blocked = canonicalAgentSnapshot('agent-a', {
      activity: 'blocked',
      waitOwner: 'operator',
      waitKind: 'approval',
      now: 2_000,
      revision: 5
    });

    expect(
      projectTransitionToDeskEvents(
        transition(from, blocked, { actionable: true })
      )
    ).toEqual([
      {
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        kind: 'agent-blocked',
        at: new Date(blocked.updatedAt).toISOString(),
        sessionId: 'agent-a',
        generation: 1,
        authorityRevision: 5,
        wait: blocked.subject.kind === 'agent' ? blocked.subject.wait : null
      }
    ]);

    const providerBlocked = canonicalAgentSnapshot('agent-a', {
      activity: 'blocked',
      waitOwner: 'provider',
      waitKind: 'rate-limit',
      now: 3_000,
      revision: 6
    });
    expect(
      projectTransitionToDeskEvents(
        transition(blocked, providerBlocked, { actionable: false })
      )
    ).toEqual([]);

    const stillBlocked = canonicalAgentSnapshot('agent-a', {
      activity: 'blocked',
      waitOwner: 'operator',
      waitKind: 'approval',
      now: 4_000,
      revision: 7
    });
    expect(
      projectTransitionToDeskEvents(
        transition(blocked, stillBlocked, { actionable: true })
      )
    ).toEqual([]);
  });

  it('projects idle, health, recovery, and exit transitions without initial-state noise', () => {
    const working = canonicalAgentSnapshot('agent-a', {
      activity: 'working',
      now: 1_000,
      revision: 1
    });
    const idle = canonicalAgentSnapshot('agent-a', {
      activity: 'idle',
      now: 2_000,
      revision: 2
    });
    expect(projectTransitionToDeskEvents(transition(working, idle))).toMatchObject([
      {
        kind: 'agent-idle',
        authorityRevision: 2,
        sessionId: 'agent-a',
        generation: 1
      }
    ]);
    expect(
      projectTransitionToDeskEvents(
        transition(null, idle, { cause: 'registered' })
      )
    ).toEqual([]);

    const degraded: SessionStateSnapshot = {
      ...idle,
      revision: 3,
      health: {
        status: 'degraded',
        reason: 'producer-lost',
        since: 3_000,
        detail: 'heartbeat expired'
      },
      updatedAt: 3_000
    };
    expect(projectTransitionToDeskEvents(transition(idle, degraded))).toEqual([
      {
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        kind: 'agent-error',
        at: new Date(3_000).toISOString(),
        sessionId: 'agent-a',
        generation: 1,
        authorityRevision: 3,
        health: degraded.health
      }
    ]);

    const recovered: SessionStateSnapshot = {
      ...degraded,
      revision: 4,
      health: { status: 'healthy', since: 4_000 },
      updatedAt: 4_000
    };
    expect(projectTransitionToDeskEvents(transition(degraded, recovered))).toEqual([
      {
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        kind: 'agent-recovered',
        at: new Date(4_000).toISOString(),
        sessionId: 'agent-a',
        generation: 1,
        authorityRevision: 4,
        health: recovered.health
      }
    ]);

    const exited: SessionStateSnapshot = {
      ...recovered,
      revision: 5,
      lifecycle: 'exited',
      lifecycleSince: 5_000,
      exit: { at: 5_000, code: 0, signal: null },
      subject:
        recovered.subject.kind === 'agent'
          ? {
              ...recovered.subject,
              activity: 'unknown',
              activitySince: 5_000,
              wait: null,
              evidence: null
            }
          : recovered.subject,
      updatedAt: 5_000
    };
    expect(
      projectTransitionToDeskEvents(
        transition(recovered, exited, { cause: 'lifecycle-exited' })
      )
    ).toEqual([
      {
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        kind: 'agent-exited',
        at: new Date(5_000).toISOString(),
        sessionId: 'agent-a',
        generation: 1,
        authorityRevision: 5,
        exit: exited.exit
      }
    ]);
  });

  it('strictly validates persisted events and channel-message submissions', () => {
    expect(
      parseDeskEvent({
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        id: 'desk-event-11',
        seq: 11,
        at: '2026-07-27T12:00:00.000Z',
        read: false,
        kind: 'channel-message',
        channel: 'desk',
        messageId: 'msg-11',
        author: 'human',
        mentionsOperator: true,
        message: 'Please check this'
      })
    ).toMatchObject({ kind: 'channel-message', seq: 11 });

    expect(() =>
      parseDeskEvent({
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        id: 'desk-event-0',
        seq: 0,
        at: 'not-a-date',
        read: false,
        kind: 'agent-idle',
        sessionId: 'agent-a',
        generation: 1,
        authorityRevision: 4
      })
    ).toThrow();

    expect(
      parseChannelMessageDeskEventInput({
        sessionId: 'agent-a',
        channel: 'desk',
        messageId: 'msg-12',
        thread: 'msg-root',
        author: 'claude-1',
        mentionsOperator: false,
        message: 'Status update'
      })
    ).toEqual({
      sessionId: 'agent-a',
      channel: 'desk',
      messageId: 'msg-12',
      thread: 'msg-root',
      author: 'claude-1',
      mentionsOperator: false,
      message: 'Status update'
    });

    expect(() =>
      parseChannelMessageDeskEventInput({
        channel: 'desk',
        messageId: 'msg-13',
        author: 'claude-1',
        mentionsOperator: false,
        message: 'Status update',
        extraAuthority: true
      })
    ).toThrow();
  });
});
