import type { AgentEventKindV2, AgentEventV2 } from './agentEvents.js';

export type PresenceColor = 'green' | 'yellow' | 'red';
export type PresenceStatus = 'working' | 'idle' | 'blocked' | 'offline';
export type BlockedReason = 'approval' | 'input';
export type DegradedReason = 'session-end' | 'stop-failure' | 'tmux-missing' | 'hook-stale' | 'ack-failed';

export interface PresenceSnapshot {
  session: string;
  agent: string;
  color: PresenceColor;
  status: PresenceStatus;
  lastEventAt: string;
  lastEventKind: AgentEventKindV2;
  blockedReason?: BlockedReason;
  degradedReason?: DegradedReason;
  activeNotificationId?: string;
  lastAckedNotificationId?: string;
  failedNotificationId?: string;
  ackFailures: number;
}

export interface AgentPresenceOptions {
  staleAfterMs?: number;
  maxAckFailures?: number;
}

export class AgentPresenceModel {
  private readonly staleAfterMs: number;
  private readonly maxAckFailures: number;
  private readonly sessions = new Map<string, PresenceSnapshot>();

  constructor(options: AgentPresenceOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.maxAckFailures = options.maxAckFailures ?? 3;
  }

  apply(event: AgentEventV2): PresenceSnapshot {
    const current = this.sessions.get(event.session);
    const base: PresenceSnapshot =
      current ?? {
        session: event.session,
        agent: event.agent,
        color: 'yellow',
        status: 'idle',
        lastEventAt: event.ts,
        lastEventKind: event.kind,
        ackFailures: 0
      };

    const next: PresenceSnapshot = {
      ...base,
      agent: event.agent,
      lastEventAt: event.ts,
      lastEventKind: event.kind,
      blockedReason: undefined,
      degradedReason: undefined,
      failedNotificationId: undefined
    };

    switch (event.kind) {
      case 'session-start':
      case 'session-idle':
      case 'stop':
        next.color = 'yellow';
        next.status = 'idle';
        next.activeNotificationId = undefined;
        break;
      case 'prompt-submitted':
        next.color = 'green';
        next.status = 'working';
        next.activeNotificationId = event.notificationId;
        break;
      case 'approval-requested':
        next.color = 'green';
        next.status = 'blocked';
        next.blockedReason = 'approval';
        break;
      case 'input-requested':
        next.color = 'green';
        next.status = 'blocked';
        next.blockedReason = 'input';
        break;
      case 'delivery-ack':
        next.lastAckedNotificationId = event.notificationId;
        next.ackFailures = 0;
        if (event.notificationId && next.activeNotificationId === event.notificationId) {
          next.activeNotificationId = undefined;
        }
        break;
      case 'session-end':
        next.color = 'red';
        next.status = 'offline';
        next.degradedReason = 'session-end';
        break;
      case 'stop-failure':
        next.color = 'red';
        next.status = 'offline';
        next.degradedReason = 'stop-failure';
        break;
      case 'heartbeat':
      case 'session-status':
        break;
    }

    this.sessions.set(event.session, next);
    return next;
  }

  get(session: string): PresenceSnapshot | undefined {
    return this.sessions.get(session);
  }

  list(): PresenceSnapshot[] {
    return [...this.sessions.values()];
  }

  reconcileLiveness(aliveSessions: Set<string>, now = new Date()): void {
    for (const snapshot of this.sessions.values()) {
      if (!aliveSessions.has(snapshot.session)) {
        this.markRed(snapshot, 'tmux-missing');
        continue;
      }
      const lastEventMs = Date.parse(snapshot.lastEventAt);
      if (Number.isFinite(lastEventMs) && now.getTime() - lastEventMs > this.staleAfterMs) {
        this.markRed(snapshot, 'hook-stale');
      }
    }
  }

  recordAckFailure(session: string, notificationId: string): PresenceSnapshot {
    const current =
      this.sessions.get(session) ??
      ({
        session,
        agent: 'unknown',
        color: 'yellow',
        status: 'idle',
        lastEventAt: new Date().toISOString(),
        lastEventKind: 'delivery-ack',
        ackFailures: 0
      } satisfies PresenceSnapshot);

    current.ackFailures += 1;
    current.failedNotificationId = notificationId;
    if (current.ackFailures >= this.maxAckFailures) {
      this.markRed(current, 'ack-failed');
    }
    this.sessions.set(session, current);
    return current;
  }

  private markRed(snapshot: PresenceSnapshot, reason: DegradedReason): void {
    snapshot.color = 'red';
    snapshot.status = 'offline';
    snapshot.blockedReason = undefined;
    snapshot.degradedReason = reason;
  }
}
