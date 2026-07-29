// What the operator sees, derived from one canonical snapshot.
//
// Every surface — sidebar row, multiplexer cell, channels footer — renders
// through this one function, so two views of the same session cannot disagree.
// It is pure and total: no fetching, no time, no defaults invented on the way
// to the screen.
//
// The rule that matters most here is which state may INTERRUPT the operator.
// A session blocked on a rate limit and a session blocked on an approval are
// both blocked, and only the second one is the operator's to clear — lighting
// the lamp for the first trains people to ignore the lamp, which is how a
// notification system dies.

import type { AgentWait, SessionStateSnapshot } from '../shared/controlPlane/index.js';

export type AgentTone =
  /** the agent is generating right now */
  | 'working'
  /** stopped, and only the operator can clear it */
  | 'attention'
  /** stopped on something the operator cannot clear (provider, Desk) */
  | 'waiting'
  /** a finished turn, nothing pending */
  | 'idle'
  /** no evidence: not a claim that the agent is doing nothing */
  | 'unknown';

export interface AgentStatusView {
  tone: AgentTone;
  /** Short label for a dense row. */
  label: string;
  /** Operator-facing specifics: what is being approved, which provider failed. */
  detail?: string;
  /** True only when the operator personally has to act. Drives the lamp. */
  actionable: boolean;
}

export interface SessionStatusView {
  lifecycle: 'starting' | 'running' | 'exited';
  /**
   * null for a session that is not an agent (a shell, an editor, a custom
   * command). Such a session has no activity axis at all — reporting `unknown`
   * for it would fill the sidebar with badges that mean nothing and teach the
   * operator to stop reading them.
   */
  agent: AgentStatusView | null;
  /** Health rides alongside the state; it never replaces it. */
  degradedReason: string | null;
  /** True when the process is gone. Dominates every activity reading. */
  exited: boolean;
}

export const UNKNOWN_AGENT: AgentStatusView = {
  tone: 'unknown',
  label: 'unknown',
  detail: undefined,
  actionable: false
};

/**
 * The view for a session Desk has NO snapshot for.
 *
 * Deliberately `unknown` rather than idle: the authority not knowing a session
 * is a fact about Desk, not about the agent, and the honest rendering of "we
 * have no evidence" is what sends an operator looking instead of trusting a
 * confident wrong answer.
 */
export const NO_SNAPSHOT_VIEW: SessionStatusView = {
  lifecycle: 'starting',
  agent: UNKNOWN_AGENT,
  degradedReason: null,
  exited: false
};

export function sessionStatusView(snapshot: SessionStateSnapshot | undefined): SessionStatusView {
  if (!snapshot) {
    return NO_SNAPSHOT_VIEW;
  }
  const exited = snapshot.lifecycle === 'exited';
  const degradedReason = snapshot.health.status === 'degraded' ? snapshot.health.reason : null;
  if (snapshot.subject.kind !== 'agent') {
    return { lifecycle: snapshot.lifecycle, agent: null, degradedReason, exited };
  }
  return {
    lifecycle: snapshot.lifecycle,
    agent: agentView(snapshot, exited),
    degradedReason,
    exited
  };
}

function agentView(snapshot: SessionStateSnapshot, exited: boolean): AgentStatusView {
  // A dead process cannot be working, blocked, or idle. Whatever the last
  // accepted fact said, the lifecycle is the stronger evidence — this is the
  // case that used to leave a killed agent lit green forever.
  if (exited) {
    return { tone: 'unknown', label: 'exited', detail: exitDetail(snapshot), actionable: false };
  }
  const subject = snapshot.subject;
  if (subject.kind !== 'agent') {
    return UNKNOWN_AGENT;
  }
  switch (subject.activity) {
    case 'working':
      return { tone: 'working', label: 'working', actionable: false };
    case 'idle':
      return { tone: 'idle', label: 'idle', actionable: false };
    case 'blocked':
      return blockedView(subject.wait);
    case 'unknown':
      return { ...UNKNOWN_AGENT, detail: degradedDetail(snapshot) };
  }
}

function blockedView(wait: AgentWait | null): AgentStatusView {
  // The contract guarantees a wait whenever activity is blocked; a missing one
  // would be a contract violation, and guessing a reason for it would hide the
  // violation rather than surface it.
  if (!wait) {
    return { tone: 'unknown', label: 'blocked', detail: 'no wait recorded', actionable: false };
  }
  if (wait.owner === 'operator') {
    return {
      tone: 'attention',
      label: operatorLabel(wait.kind),
      detail: wait.detail,
      actionable: true
    };
  }
  return {
    tone: 'waiting',
    label: wait.owner === 'provider' ? `waiting: ${wait.kind}` : `held: ${wait.kind}`,
    detail: wait.detail,
    actionable: false
  };
}

function operatorLabel(kind: string): string {
  switch (kind) {
    case 'approval':
      return 'needs approval';
    case 'input':
      return 'needs input';
    case 'auth':
      return 'needs sign-in';
    case 'billing':
      return 'needs billing';
    default:
      return `needs you: ${kind}`;
  }
}

function exitDetail(snapshot: SessionStateSnapshot): string | undefined {
  const exit = snapshot.exit;
  if (!exit) {
    return undefined;
  }
  if (exit.signal) {
    return `killed by ${exit.signal}`;
  }
  return typeof exit.code === 'number' ? `exit ${exit.code}` : undefined;
}

function degradedDetail(snapshot: SessionStateSnapshot): string | undefined {
  return snapshot.health.status === 'degraded' ? snapshot.health.reason : undefined;
}

/**
 * The view for one session, or the honest `unknown` when the authority did not
 * report it. Every consumer goes through this rather than indexing the map
 * directly, so "absent" renders identically everywhere.
 */
export function viewFor(views: Record<string, SessionStatusView>, sessionId: string): SessionStatusView {
  return views[sessionId] ?? NO_SNAPSHOT_VIEW;
}

/** True only when this session is waiting on the operator personally. */
export function needsOperator(views: Record<string, SessionStatusView>, sessionId: string): boolean {
  return views[sessionId]?.agent?.actionable === true;
}

/** Sessions whose state the operator personally has to clear. */
export function actionableSessions(views: Record<string, SessionStatusView>): string[] {
  return Object.entries(views)
    .filter(([, view]) => view.agent?.actionable === true)
    .map(([sessionId]) => sessionId)
    .sort();
}

