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
  // Delivery is refused only on POSITIVE knowledge that it is unsafe. `unknown`
  // is not "busy" — it is "no evidence", and that is the ordinary state of any
  // session whose producer has not reported yet: every session started before
  // hooks existed, every session on a machine where the operator declined to
  // install them, and every session between spawn and its first typed event.
  //
  // Refusing there made the product unusable in its default state: messages
  // queued as `unobservable` forever and the operator's agents simply never
  // answered. The two failures are not symmetric. Delivering into a session
  // that turns out to be mid-turn interleaves text — visible and recoverable.
  // Never delivering is silent and total.
  //
  // `working` DELIVERS. An agent mid-turn is not unreachable: every provider
  // Desk drives buffers typed input and consumes it when the turn ends, which
  // is exactly what an operator does when they type a follow-up without
  // waiting. Holding messages back there bought no safety and cost the thing
  // the channel exists for — a busy agent looked unreachable, and the operator
  // had to watch the lamp before daring to speak.
  //
  // `blocked` is the one activity that still refuses, and for a different
  // reason than "busy": a blocked session is sitting on a prompt that CONSUMES
  // the next input — an approval dialog answers itself with whatever arrives.
  // There the refusal prevents a message from being read as a decision the
  // operator never made.
  switch (view.activity) {
    case 'idle':
    case 'unknown':
    case 'working':
      return { deliver: true, view };
    case 'blocked':
      return { deliver: false, reason: blockedReason(view), view };
  }
}
