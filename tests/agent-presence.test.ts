import { describe, expect, it } from 'vitest';
import { AgentPresenceModel } from '../src/server/agentPresence.js';

describe('AgentPresenceModel', () => {
  it('transitions from session start to idle, prompt submit to working, and stop back to idle', () => {
    const model = new AgentPresenceModel({ staleAfterMs: 60_000 });

    model.apply({
      schemaVersion: 2,
      kind: 'session-start',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      ts: '2026-06-19T14:20:00.000Z'
    });
    expect(model.get('focus-codex-fedcba98')).toMatchObject({ color: 'yellow', status: 'idle' });

    model.apply({
      schemaVersion: 2,
      kind: 'prompt-submitted',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      notificationId: 'notif-001',
      ts: '2026-06-19T14:20:05.000Z'
    });
    expect(model.get('focus-codex-fedcba98')).toMatchObject({
      color: 'green',
      status: 'working',
      activeNotificationId: 'notif-001'
    });

    model.apply({
      schemaVersion: 2,
      kind: 'stop',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      ts: '2026-06-19T14:20:15.000Z'
    });
    expect(model.get('focus-codex-fedcba98')).toMatchObject({ color: 'yellow', status: 'idle' });
  });

  it('keeps approval and input requests as blocked working substates', () => {
    const model = new AgentPresenceModel();

    model.apply({
      schemaVersion: 2,
      kind: 'approval-requested',
      session: 'focus-claude-abcdef12',
      agent: 'claude',
      ts: '2026-06-19T14:21:00.000Z'
    });
    expect(model.get('focus-claude-abcdef12')).toMatchObject({
      color: 'green',
      status: 'blocked',
      blockedReason: 'approval'
    });

    model.apply({
      schemaVersion: 2,
      kind: 'input-requested',
      session: 'focus-claude-abcdef12',
      agent: 'claude',
      ts: '2026-06-19T14:21:05.000Z'
    });
    expect(model.get('focus-claude-abcdef12')).toMatchObject({
      color: 'green',
      status: 'blocked',
      blockedReason: 'input'
    });
  });

  it('records delivery acknowledgements without changing idle presence', () => {
    const model = new AgentPresenceModel();

    model.apply({
      schemaVersion: 2,
      kind: 'session-start',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      ts: '2026-06-19T14:22:00.000Z'
    });
    model.apply({
      schemaVersion: 2,
      kind: 'delivery-ack',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      notificationId: 'notif-001',
      ts: '2026-06-19T14:22:03.000Z'
    });

    expect(model.get('focus-codex-fedcba98')).toMatchObject({
      color: 'yellow',
      status: 'idle',
      lastAckedNotificationId: 'notif-001'
    });
  });

  it('marks sessions red when tmux liveness disappears', () => {
    const model = new AgentPresenceModel();
    model.apply({
      schemaVersion: 2,
      kind: 'session-start',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      ts: '2026-06-19T14:23:00.000Z'
    });

    model.reconcileLiveness(new Set(), new Date('2026-06-19T14:23:05.000Z'));

    expect(model.get('focus-codex-fedcba98')).toMatchObject({
      color: 'red',
      status: 'offline',
      degradedReason: 'tmux-missing'
    });
  });

  it('marks sessions red when the last hook event is stale', () => {
    const model = new AgentPresenceModel({ staleAfterMs: 10_000 });
    model.apply({
      schemaVersion: 2,
      kind: 'prompt-submitted',
      session: 'focus-codex-fedcba98',
      agent: 'codex',
      ts: '2026-06-19T12:00:00.000Z'
    });

    model.reconcileLiveness(new Set(['focus-codex-fedcba98']), new Date('2026-06-19T12:01:00.000Z'));

    expect(model.get('focus-codex-fedcba98')).toMatchObject({
      color: 'red',
      status: 'offline',
      degradedReason: 'hook-stale'
    });
  });

  it('marks sessions red after repeated acknowledgement failures', () => {
    const model = new AgentPresenceModel({ maxAckFailures: 2 });
    model.apply({
      schemaVersion: 2,
      kind: 'session-start',
      session: 'focus-claude-abcdef12',
      agent: 'claude',
      ts: '2026-06-19T14:25:00.000Z'
    });

    model.recordAckFailure('focus-claude-abcdef12', 'notif-001');
    expect(model.get('focus-claude-abcdef12')).toMatchObject({ color: 'yellow' });
    model.recordAckFailure('focus-claude-abcdef12', 'notif-001');

    expect(model.get('focus-claude-abcdef12')).toMatchObject({
      color: 'red',
      status: 'offline',
      degradedReason: 'ack-failed',
      failedNotificationId: 'notif-001'
    });
  });
});
