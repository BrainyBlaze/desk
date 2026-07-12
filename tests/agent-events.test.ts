import { describe, expect, it } from 'vitest';
import { ApiValidationError } from '../src/server/apiValidation.js';
import { normalizeAgentEventForApi, parseAgentEventV2 } from '../src/server/agentEvents.js';

describe('parseAgentEventV2', () => {
  it('accepts a versioned prompt-submitted event with delivery ack metadata', () => {
    expect(
      parseAgentEventV2({
        schemaVersion: 2,
        kind: 'prompt-submitted',
        session: 'focus-codex-fedcba98',
        agent: 'codex',
        turnId: 'turn-123',
        notificationId: 'notif-001',
        ts: '2026-06-19T14:20:00.000Z'
      })
    ).toEqual({
      schemaVersion: 2,
      kind: 'prompt-submitted',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      turnId: 'turn-123',
      notificationId: 'notif-001',
      ts: '2026-06-19T14:20:00.000Z'
    });
  });

  it('normalizes missing timestamps to the supplied clock value', () => {
    expect(
      parseAgentEventV2(
        {
          schemaVersion: 2,
          kind: 'stop',
          session: 'tmux-a',
          agent: 'claude'
        },
        new Date('2026-06-19T14:21:00.000Z')
      )
    ).toMatchObject({
      kind: 'stop',
      session: 'tmux-a',
      agent: 'claude',
      ts: '2026-06-19T14:21:00.000Z'
    });
  });

  it('rejects unversioned legacy-looking payloads instead of guessing', () => {
    expect(() => parseAgentEventV2({ session: 'tmux-a', kind: 'turn-complete' })).toThrow(ApiValidationError);
    expect(() => parseAgentEventV2({ session: 'tmux-a', kind: 'turn-complete' })).toThrow(/schemaVersion/);
  });

  it('rejects unknown event kinds', () => {
    expect(() =>
      parseAgentEventV2({
        schemaVersion: 2,
        kind: 'turn-complete',
        session: 'tmux-a',
        agent: 'claude'
      })
    ).toThrow(/unsupported agent event kind/);
  });

  it('requires full tmux session identity, not suffix-only identifiers', () => {
    expect(() =>
      parseAgentEventV2({
        schemaVersion: 2,
        kind: 'session-start',
        session: 'fedcba98',
        agent: 'codex'
      })
    ).toThrow(/full tmux session/);
  });
});

describe('normalizeAgentEventForApi', () => {
  it('keeps v2 delivery acknowledgements out of the legacy attention signal path', () => {
    expect(
      normalizeAgentEventForApi({
        schemaVersion: 2,
        kind: 'delivery-ack',
        session: 'focus-codex-fedcba98',
        agent: 'codex',
        notificationId: 'notif-001'
      })
    ).toMatchObject({
      event: {
        kind: 'delivery-ack',
        session: 'focus-codex-fedcba98',
        notificationId: 'notif-001'
      },
      attentionKind: undefined,
      signalKind: undefined,
      deliveryAckNotificationId: 'notif-001'
    });
  });

  it('treats prompt-submitted notification ids as delivery acknowledgements', () => {
    expect(
      normalizeAgentEventForApi({
        schemaVersion: 2,
        kind: 'prompt-submitted',
        session: 'focus-codex-fedcba98',
        agent: 'codex',
        notificationId: 'msg-ack-001'
      })
    ).toMatchObject({
      event: {
        kind: 'prompt-submitted',
        session: 'focus-codex-fedcba98',
        notificationId: 'msg-ack-001'
      },
      attentionKind: undefined,
      signalKind: undefined,
      deliveryAckNotificationId: 'msg-ack-001'
    });
  });

  it('maps v2 idle/stop events to the current release signal while preserving the v2 event', () => {
    expect(
      normalizeAgentEventForApi({
        schemaVersion: 2,
        kind: 'stop',
        session: 'focus-claude-abcdef12',
        agent: 'claude'
      })
    ).toMatchObject({
      event: { kind: 'stop', session: 'focus-claude-abcdef12' },
      attentionKind: 'turn-complete',
      signalKind: 'turn-complete'
    });
  });

  it('keeps legacy hook payloads compatible during migration', () => {
    expect(
      normalizeAgentEventForApi({
        session: 'focus-claude-abcdef12',
        kind: 'approval-requested',
        sessionId: 'abc123'
      })
    ).toMatchObject({
      event: {
        schemaVersion: 2,
        kind: 'approval-requested',
        session: 'focus-claude-abcdef12',
        agent: 'legacy'
      },
      attentionKind: 'approval-requested',
      signalKind: 'approval-requested',
      resumeSessionId: 'abc123'
    });
  });
});
