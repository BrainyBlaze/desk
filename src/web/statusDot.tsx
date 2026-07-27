import type { SessionStatusView } from './agentStatusModel.js';

/**
 * The session dot. Its grammar is deliberate and consistent everywhere:
 *
 *   animated  — something is happening now, or the operator is being asked for
 *               something. Motion is reserved for these two.
 *   steady    — a known resting state: idle, or waiting on someone who is not
 *               the operator.
 *   hollow    — Desk has no evidence. Not a claim that the agent is resting.
 *
 * A non-agent session (a shell) has no activity axis at all, so it shows plain
 * liveness rather than a badge that would mean nothing.
 */
export function StatusDot({ view }: { view: SessionStatusView }): JSX.Element {
  const tone = dotTone(view);
  const title = dotTitle(view);
  return <span className={`statusDot ${tone}${view.degradedReason ? ' degraded' : ''}`} title={title} />;
}

export function dotTone(view: SessionStatusView): string {
  if (view.exited) {
    return 'exited';
  }
  if (!view.agent) {
    // A plain terminal: alive or not, nothing more to say about it.
    return view.lifecycle === 'running' ? 'running' : 'unknown';
  }
  return view.agent.tone;
}

/** Hover text: the state, then why — the detail is what makes it actionable. */
export function dotTitle(view: SessionStatusView): string {
  const parts: string[] = [];
  if (view.agent) {
    parts.push(view.agent.label);
    if (view.agent.detail) {
      parts.push(view.agent.detail);
    }
  } else {
    parts.push(view.lifecycle);
  }
  if (view.degradedReason) {
    parts.push(`degraded: ${view.degradedReason}`);
  }
  return parts.join(' — ');
}
