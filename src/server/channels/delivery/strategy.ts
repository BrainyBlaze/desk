import type {
  AgentActivity,
  AgentWait,
  SessionLifecycle,
  SessionStateSnapshot
} from '../../../shared/controlPlane/index.js';
import type { DeliveryBlockReason } from '../protocol/delivery.js';

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
  // ACTIVITY NEVER BLOCKS DELIVERY. Not `working`, not `blocked`, not
  // `unknown`. Every provider Desk drives buffers typed input, so a message
  // sent mid-turn is read when the turn ends — the same thing that happens
  // when the operator types a follow-up without waiting.
  //
  // The argument for holding on `blocked` was that a waiting prompt consumes
  // the next input, so a message could answer a dialog nobody read. That risk
  // is real and it is the operator's to take: it is visible the moment it
  // happens and recoverable, while a channel that silently withholds is
  // neither. A messaging surface whose messages sometimes do not arrive is not
  // a messaging surface, and every state this switch used to refuse on was a
  // state the operator could see and reason about themselves.
  //
  // What remains below this function is lifecycle, and lifecycle is not a
  // judgement about the agent — it is whether a process exists to receive at
  // all. Those cases queue rather than drop, which is the opposite of
  // withholding.
  return { deliver: true, view };
}
