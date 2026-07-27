import type {
  AgentActivity,
  AgentWait,
  SessionLifecycle,
  SessionStateSnapshot
} from '../shared/controlPlane/index.js';
import type { DeliveryBlockReason } from './channelsProtocol.js';

export interface AgentStateBatch {
  ok: boolean;
  revision: number | null;
  snapshots: SessionStateSnapshot[];
}

export interface CanonicalAgentView {
  authorityRevision: number | null;
  lifecycle: SessionLifecycle | 'unknown';
  activity: AgentActivity;
  wait: AgentWait | null;
  actionable: boolean;
}

export type DeliveryDecision =
  | { deliver: true; view: CanonicalAgentView }
  | { deliver: false; reason: DeliveryBlockReason; view: CanonicalAgentView };

function unknownView(authorityRevision: number | null): CanonicalAgentView {
  return {
    authorityRevision,
    lifecycle: 'unknown',
    activity: 'unknown',
    wait: null,
    actionable: false
  };
}

function effectiveActivity(snapshot: SessionStateSnapshot, now: number): AgentActivity {
  if (snapshot.lifecycle !== 'running' || snapshot.subject.kind !== 'agent') {
    return 'unknown';
  }
  if (
    snapshot.subject.activity === 'working' &&
    (snapshot.subject.evidence?.leaseExpiresAt === undefined || snapshot.subject.evidence.leaseExpiresAt <= now)
  ) {
    return 'unknown';
  }
  return snapshot.subject.activity;
}

export function canonicalAgentView(
  batch: AgentStateBatch,
  sessionId: string,
  now = Date.now()
): CanonicalAgentView {
  if (!batch.ok || batch.revision === null) {
    return unknownView(null);
  }
  const snapshot = batch.snapshots.find((candidate) => candidate.sessionId === sessionId);
  if (!snapshot) {
    return unknownView(batch.revision);
  }
  const activity = effectiveActivity(snapshot, now);
  const wait =
    activity === 'blocked' && snapshot.subject.kind === 'agent'
      ? snapshot.subject.wait
      : null;
  return {
    authorityRevision: batch.revision,
    lifecycle: snapshot.lifecycle,
    activity,
    wait,
    actionable: activity === 'blocked' && wait?.owner === 'operator'
  };
}

function blockedReason(view: CanonicalAgentView): DeliveryBlockReason {
  if (view.wait?.owner === 'provider') {
    return 'provider-blocked';
  }
  if (view.wait?.owner === 'operator') {
    return view.wait.kind === 'input' || view.wait.kind.includes('input')
      ? 'input-requested'
      : 'operator-blocked';
  }
  return 'not-ready';
}

export function canonicalDeliveryDecision(
  batch: AgentStateBatch,
  sessionId: string,
  now = Date.now()
): DeliveryDecision {
  const view = canonicalAgentView(batch, sessionId, now);
  if (view.lifecycle === 'starting') {
    return { deliver: false, reason: 'booting', view };
  }
  if (view.lifecycle === 'exited') {
    return { deliver: false, reason: 'offline', view };
  }
  switch (view.activity) {
    case 'idle':
      return { deliver: true, view };
    case 'working':
      return { deliver: false, reason: 'busy', view };
    case 'blocked':
      return { deliver: false, reason: blockedReason(view), view };
    case 'unknown':
      return { deliver: false, reason: 'unobservable', view };
  }
}
