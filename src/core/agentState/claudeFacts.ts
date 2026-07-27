// Claude Code → agent-state facts.
//
// Claude publishes no activity field anywhere: its status line carries model,
// cost, and context usage, and nothing about whether a turn is running. So
// activity is reconstructed from typed lifecycle hooks — the turn opens on
// `UserPromptSubmit` and closes on `Stop` or `StopFailure` — with tool hooks
// proving a long turn is still alive in between.
//
// As with OpenCode, the hook shim decides nothing: it posts a bounded slice of
// the hook payload and the meaning is settled here, under test.

import { boundedDetail, type AgentSemanticFact, type AgentWaitInput } from './facts.js';

/**
 * Hook events Desk installs for Claude. `PreToolUse`/`PostToolUse` are the
 * heartbeat: they are the only typed proof, between the two turn edges, that a
 * long turn is still running.
 *
 * `MessageDisplay` is deliberately NOT installed even though it would beat
 * during streaming: a command hook spawns a process per firing, and that hook
 * fires per displayed chunk. The cost of a fork per token is not worth a
 * finer-grained beat — a tool-less turn instead relies on the authority's
 * lease window and, when that expires, reports `unknown`. An honest unknown is
 * the point; a fabricated `idle` is the failure this subsystem is being
 * rebuilt to remove.
 */
export const CLAUDE_HOOK_EVENTS: readonly string[] = Object.freeze([
  'Notification',
  'PermissionRequest',
  'PostToolBatch',
  'PostToolUse',
  'PostToolUseFailure',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'StopFailure',
  'UserPromptSubmit'
]);

/**
 * `Notification` matchers Desk subscribes to. `agent_needs_input` and
 * `agent_completed` matter as much as the dialog matchers: they are how a
 * session that is waiting on the human announces itself without a dialog.
 */
export const CLAUDE_NOTIFICATION_MATCHERS: readonly string[] = Object.freeze([
  'agent_completed',
  'agent_needs_input',
  'elicitation_dialog',
  'idle_prompt',
  'permission_prompt'
]);

/** The bounded slice the hook shim posts; hook payloads are not forwarded whole. */
export interface ClaudeObservation {
  /** The hook event name, verbatim. */
  hook: string;
  /** `Notification.notification_type`, `StopFailure`'s reason matcher, etc. */
  matcher?: string;
  /** Operator-facing text, already bounded by the shim. */
  message?: string;
  /** `PreToolUse`/`PostToolUse` tool name — carried for the event feed, not for state. */
  tool?: string;
  /** Pairs a tool interval's two edges. Required for any tool edge. */
  toolUseId?: string;
}

/**
 * `StopFailure` reason → who has to do something about it.
 *
 * Every one of these ends the turn, so none of them produces a wait: a wait
 * means "stopped until X happens", and a finished turn is not stopped, it is
 * over. They surface as an idle turn plus a degraded health reason, which is
 * what makes "your turn died on a rate limit" an event the operator can act on
 * without painting a live agent as blocked or dead.
 */
const STOP_FAILURE_REASONS: Record<string, string> = {
  rate_limit: 'provider-rate-limit',
  overloaded: 'provider-overloaded',
  server_error: 'provider-error',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  billing_error: 'billing',
  invalid_request: 'invalid-request',
  model_not_found: 'model-not-found',
  max_output_tokens: 'output-length-cap',
  unknown: 'unknown-error'
};

export function claudeFacts(observation: ClaudeObservation): AgentSemanticFact[] {
  if (!observation || typeof observation.hook !== 'string') {
    return [];
  }
  switch (observation.hook) {
    // The turn opens the moment the prompt is accepted, before the model runs.
    case 'UserPromptSubmit':
      return [{ kind: 'activity', activity: 'working' }];
    case 'Stop':
      return [{ kind: 'activity', activity: 'idle' }];
    case 'StopFailure':
      return stopFailureFacts(observation);
    case 'PermissionRequest':
      return [{ kind: 'blocked', wait: operatorWait('approval', observation.message) }];
    case 'Notification':
      return notificationFacts(observation);
    // A tool call is an INTERVAL, not a beat. Its two edges let the authority
    // hold `working` for as long as the tool is genuinely running: an open
    // interval is evidence, where silence between two beats is not. Without
    // this a build or a test run longer than the working lease decays to
    // unknown while the agent is demonstrably busy.
    case 'PreToolUse':
      return observation.toolUseId ? [{ kind: 'tool', phase: 'start' }] : [{ kind: 'heartbeat' }];
    // A FAILED tool closes its interval too. Closing only on success would
    // leak an open interval on every failing tool call, and the session would
    // sit on the long open-tool ceiling instead of its short working lease.
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return observation.toolUseId ? [{ kind: 'tool', phase: 'end' }] : [{ kind: 'heartbeat' }];
    // A batch resolves MANY tool ids at once; the contract allows one edge per
    // observation, so a batch stays a plain beat rather than guessing which id
    // it should close.
    case 'PostToolBatch':
      return [{ kind: 'heartbeat' }];
    // SessionStart/SessionEnd register and retire the producer; the daemon owns
    // lifecycle, so neither asserts anything about activity.
    case 'SessionStart':
    case 'SessionEnd':
      return [];
    default:
      return [];
  }
}

function stopFailureFacts(observation: ClaudeObservation): AgentSemanticFact[] {
  const reason = STOP_FAILURE_REASONS[observation.matcher ?? ''] ?? 'unknown-error';
  return [
    { kind: 'activity', activity: 'idle' },
    { kind: 'health', health: { status: 'degraded', reason } }
  ];
}

function notificationFacts(observation: ClaudeObservation): AgentSemanticFact[] {
  switch (observation.matcher) {
    case 'permission_prompt':
      return [{ kind: 'blocked', wait: operatorWait('approval', observation.message) }];
    case 'elicitation_dialog':
    case 'agent_needs_input':
      return [{ kind: 'blocked', wait: operatorWait('input', observation.message) }];
    case 'idle_prompt':
    case 'agent_completed':
      return [{ kind: 'activity', activity: 'idle' }];
    default:
      // An unrecognised notification is not evidence of anything. Guessing here
      // is how a new upstream matcher would silently start reporting idle.
      return [];
  }
}

function operatorWait(kind: string, message: unknown): AgentWaitInput {
  return { kind, owner: 'operator', detail: boundedDetail(message) };
}
