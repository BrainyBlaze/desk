// What one feed entry looks like to the operator.
//
// Pure and total, like the status model: the drawer renders through this and
// nothing else, so a card, its filter chip, and its click target can never
// describe the entry differently.
//
// The feed is a JOURNAL. Reading an entry acknowledges the entry — it never
// changes what an agent is doing, and it never clears a session lamp. A lamp
// reports the authority's current wait; an unread badge reports what the
// operator has not looked at. Conflating them is what made the old lamp mean
// "have you glanced at this" while presenting itself as "does this need you".

import type { DeskEvent, DeskEventKind } from '../shared/controlPlane/index.js';

export type EventTone = 'ok' | 'warn' | 'error' | 'muted';

export type EventTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'channel'; channel: string; messageId: string; thread?: string };

export interface DeskEventView {
  tone: EventTone;
  /** Short all-caps card label. */
  label: string;
  /** The specifics: what is being approved, why it degraded, the message text. */
  detail?: string;
  /** Present for every agent event; optional for a channel message. */
  sessionId?: string;
  /** Where clicking takes the operator, or null when there is nowhere to go. */
  target: EventTarget | null;
  /**
   * This entry is the operator's to act on. Drives card emphasis and the
   * "needs you" filter — NOT the unread badge, which the journal owns.
   */
  actionable: boolean;
}

export function deskEventView(event: DeskEvent): DeskEventView {
  switch (event.kind) {
    case 'agent-blocked':
      return {
        tone: 'error',
        label: blockedLabel(event.wait.kind),
        detail: event.wait.detail,
        sessionId: event.sessionId,
        target: { kind: 'session', sessionId: event.sessionId },
        actionable: true
      };
    case 'agent-idle':
      return {
        tone: 'ok',
        label: 'TURN COMPLETE',
        sessionId: event.sessionId,
        target: { kind: 'session', sessionId: event.sessionId },
        actionable: false
      };
    case 'agent-error':
      return {
        tone: 'error',
        label: 'ERROR',
        detail: event.health.detail ?? event.health.reason,
        sessionId: event.sessionId,
        target: { kind: 'session', sessionId: event.sessionId },
        // A degraded turn is worth telling the operator about, but it is not a
        // request: nothing is waiting on them to clear it.
        actionable: false
      };
    case 'agent-recovered':
      return {
        tone: 'ok',
        label: 'RECOVERED',
        sessionId: event.sessionId,
        target: { kind: 'session', sessionId: event.sessionId },
        actionable: false
      };
    case 'agent-exited':
      return {
        tone: 'muted',
        label: 'EXITED',
        detail: exitDetail(event.exit),
        sessionId: event.sessionId,
        target: { kind: 'session', sessionId: event.sessionId },
        actionable: false
      };
    case 'channel-message':
      return {
        // A message that names the operator is a request; one that does not is
        // ambient traffic, and styling both alike is how a feed becomes noise.
        tone: event.mentionsOperator ? 'warn' : 'muted',
        label: event.mentionsOperator ? '@HUMAN PING' : event.thread === undefined ? 'MESSAGE' : 'THREAD REPLY',
        detail: event.message,
        sessionId: event.sessionId,
        target: {
          kind: 'channel',
          channel: event.channel,
          messageId: event.messageId,
          ...(event.thread === undefined ? {} : { thread: event.thread })
        },
        actionable: event.mentionsOperator
      };
  }
}

function blockedLabel(waitKind: string): string {
  switch (waitKind) {
    case 'approval':
      return 'NEEDS APPROVAL';
    case 'input':
      return 'NEEDS INPUT';
    case 'auth':
      return 'NEEDS SIGN-IN';
    case 'billing':
      return 'NEEDS BILLING';
    default:
      return `NEEDS YOU: ${waitKind.toUpperCase()}`;
  }
}

function exitDetail(exit: { code: number | null; signal: string | null }): string | undefined {
  if (exit.signal) {
    return `killed by ${exit.signal}`;
  }
  return typeof exit.code === 'number' ? `exit ${exit.code}` : undefined;
}

/** The drawer's filter axis. `needs-you` is the actionable subset; `threads`
    is the channel messages posted as a thread reply. */
export type EventFilter = 'all' | 'unread' | 'needs-you' | 'threads' | DeskEventKind;

export function filterEvents(events: readonly DeskEvent[], filter: EventFilter): DeskEvent[] {
  switch (filter) {
    case 'all':
      return [...events];
    case 'unread':
      return events.filter((event) => !event.read);
    case 'needs-you':
      return events.filter((event) => deskEventView(event).actionable);
    case 'threads':
      return events.filter((event) => event.kind === 'channel-message' && event.thread !== undefined && !event.read);
    default:
      return events.filter((event) => event.kind === filter);
  }
}

export const EVENT_FILTER_LABELS: Record<EventFilter, string> = {
  all: 'all',
  unread: 'unread',
  'needs-you': 'needs you',
  threads: 'threads',
  'agent-blocked': 'blocked',
  'agent-idle': 'turns',
  'agent-error': 'errors',
  'agent-recovered': 'recovered',
  'agent-exited': 'exited',
  'channel-message': 'channels'
};

/** Chip order, most actionable first — the operator reads left to right. */
export const EVENT_FILTER_ORDER: EventFilter[] = [
  'all',
  'unread',
  'needs-you',
  'agent-blocked',
  'channel-message',
  'threads',
  'agent-error',
  'agent-idle',
  'agent-recovered',
  'agent-exited'
];
