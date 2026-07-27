import { describe, expect, it } from 'vitest';
import {
  EVENT_FILTER_ORDER,
  deskEventView,
  filterEvents,
  type EventFilter
} from '../../src/web/eventFeedModel.js';
import type { DeskEvent } from '../../src/shared/controlPlane/index.js';

const AT = '2026-07-27T12:00:00.000Z';

function agentBase(seq: number): { schemaVersion: 1; id: string; seq: number; at: string; read: boolean; sessionId: string; generation: number; authorityRevision: number } {
  return {
    schemaVersion: 1,
    id: `evt-${seq}`,
    seq,
    at: AT,
    read: false,
    sessionId: 'work-claude',
    generation: 3,
    authorityRevision: 12
  };
}

const blocked = (waitKind = 'approval', detail?: string): DeskEvent =>
  ({
    ...agentBase(1),
    kind: 'agent-blocked',
    wait: { kind: waitKind, owner: 'operator', since: 1, ...(detail ? { detail } : {}) }
  }) as DeskEvent;

const idle = (): DeskEvent => ({ ...agentBase(2), kind: 'agent-idle' }) as DeskEvent;

const errored = (): DeskEvent =>
  ({
    ...agentBase(3),
    kind: 'agent-error',
    health: { status: 'degraded', reason: 'provider-rate-limit', since: 1 }
  }) as DeskEvent;

const exited = (signal: string | null, code: number | null): DeskEvent =>
  ({ ...agentBase(4), kind: 'agent-exited', exit: { at: 1, code, signal } }) as DeskEvent;

const channel = (mentionsOperator: boolean): DeskEvent =>
  ({
    schemaVersion: 1,
    id: 'evt-5',
    seq: 5,
    at: AT,
    read: false,
    kind: 'channel-message',
    channel: 'desk',
    messageId: 'msg-1',
    author: 'codex',
    mentionsOperator,
    message: 'ready for review'
  }) as DeskEvent;

describe('an entry says who has to act', () => {
  it('marks a block on the operator as actionable and names the ask', () => {
    expect(deskEventView(blocked('approval', 'Bash(rm -rf)'))).toMatchObject({
      tone: 'error',
      label: 'NEEDS APPROVAL',
      detail: 'Bash(rm -rf)',
      actionable: true
    });
  });

  it('translates each operator wait kind into words, and passes an unknown one through', () => {
    const labelOf = (kind: string): string => deskEventView(blocked(kind)).label;
    expect(labelOf('input')).toBe('NEEDS INPUT');
    expect(labelOf('auth')).toBe('NEEDS SIGN-IN');
    expect(labelOf('billing')).toBe('NEEDS BILLING');
    expect(labelOf('quota')).toBe('NEEDS YOU: QUOTA');
  });

  it('does NOT make a degraded turn actionable — it is news, not a request', () => {
    expect(deskEventView(errored())).toMatchObject({
      tone: 'error',
      label: 'ERROR',
      detail: 'provider-rate-limit',
      actionable: false
    });
  });

  it('keeps a completed turn and a recovery quiet', () => {
    expect(deskEventView(idle())).toMatchObject({ tone: 'ok', label: 'TURN COMPLETE', actionable: false });
  });

  it('reports how a session exited', () => {
    expect(deskEventView(exited('SIGKILL', null)).detail).toBe('killed by SIGKILL');
    expect(deskEventView(exited(null, 0)).detail).toBe('exit 0');
    expect(deskEventView(exited(null, null)).detail).toBeUndefined();
  });
});

describe('a channel message is a ping only when it names the operator', () => {
  it('escalates a mention and leaves ambient traffic quiet', () => {
    expect(deskEventView(channel(true))).toMatchObject({ tone: 'warn', label: '@HUMAN PING', actionable: true });
    // Styling every message like a summons is how a feed becomes noise the
    // operator learns to scroll past.
    expect(deskEventView(channel(false))).toMatchObject({ tone: 'muted', label: 'MESSAGE', actionable: false });
  });

  it('carries the exact navigation anchor', () => {
    expect(deskEventView(channel(true)).target).toEqual({ kind: 'channel', channel: 'desk', messageId: 'msg-1' });
  });

  it('sends every agent entry to its session', () => {
    for (const event of [blocked(), idle(), errored(), exited(null, 1)]) {
      expect(deskEventView(event).target, event.kind).toEqual({ kind: 'session', sessionId: 'work-claude' });
    }
  });
});

describe('filters', () => {
  const events: DeskEvent[] = [
    blocked(),
    idle(),
    errored(),
    channel(true),
    { ...channel(false), id: 'evt-6', seq: 6, read: true } as DeskEvent
  ];

  it('returns everything, the unread subset, and the actionable subset', () => {
    expect(filterEvents(events, 'all')).toHaveLength(5);
    expect(filterEvents(events, 'unread')).toHaveLength(4);
    // needs-you is narrower than unread on purpose: an unread turn-complete is
    // something to see, not something to do.
    expect(filterEvents(events, 'needs-you').map((event) => event.kind)).toEqual([
      'agent-blocked',
      'channel-message'
    ]);
  });

  it('filters by kind', () => {
    expect(filterEvents(events, 'agent-idle')).toHaveLength(1);
    expect(filterEvents(events, 'agent-exited')).toHaveLength(0);
  });

  it('never mutates the input', () => {
    const before = [...events];
    filterEvents(events, 'all').push(idle());
    expect(events).toEqual(before);
  });

  it('offers a chip for every kind, most actionable first', () => {
    const kinds = EVENT_FILTER_ORDER.filter(
      (filter): filter is Exclude<EventFilter, 'all' | 'unread' | 'needs-you'> =>
        filter !== 'all' && filter !== 'unread' && filter !== 'needs-you'
    );
    expect(kinds).toEqual([
      'agent-blocked',
      'channel-message',
      'agent-error',
      'agent-idle',
      'agent-recovered',
      'agent-exited'
    ]);
    expect(EVENT_FILTER_ORDER.indexOf('needs-you')).toBeLessThan(EVENT_FILTER_ORDER.indexOf('agent-idle'));
  });
});

describe('the drawer distinguishes an empty feed from an unreachable one', () => {
  it('never says "no events" when the journal could not be read', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/web/App.tsx', import.meta.url), 'utf8');
    // Absence of evidence rendered as a positive statement is the same defect
    // as a silent agent reported idle. The drawer must say WHY it is empty.
    expect(source).toMatch(/feedError\s*\?\s*`Events unavailable/);
    expect(source).toMatch(/feedError\}=\{eventFeedError\}|feedError=\{eventFeedError\}/);
  });
});
