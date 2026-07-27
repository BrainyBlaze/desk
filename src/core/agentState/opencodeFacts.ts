// OpenCode → agent-state facts.
//
// The OpenCode plugin runs inside the agent process, where nothing Desk owns
// can be tested. So the plugin decides NOTHING: it observes typed events,
// copies a bounded slice of the discriminating fields, and posts it. Every
// judgement about what an observation means lives here, in one tested place.
// The previous edge-side switch is exactly how two arms matching event names
// that do not exist survived unnoticed.
//
// OpenCode is the only supported agent that publishes an explicit activity
// state (`SessionStatus`), and the only one whose state can also be POLLED
// (`GET /session/status`) — which is what makes honest recovery after a Desk
// restart possible without replaying stale history.

import { boundedDetail, type AgentSemanticFact, type AgentWaitInput } from './facts.js';

/**
 * The event `type` strings of the SDK's `Event` union, pinned.
 *
 * Provenance: @opencode-ai/sdk 1.17.7, `dist/gen/types.gen.d.ts`, the union
 * `export type Event = …`. This is the union the plugin's `event` hook
 * receives (`Hooks.event: (input: { event: Event }) => …`), so it — not the
 * published docs — decides what an adapter can observe. The docs list names
 * (`permission.asked`, `question.asked`) that this union does not contain.
 *
 * Pinned rather than imported: Desk does not depend on the OpenCode SDK, and a
 * silent upstream rename must fail a test rather than silently stop producing
 * facts. `opencode-event-drift.test.ts` compares this list against a locally
 * installed SDK when one is present.
 */
export const OPENCODE_EVENT_TYPES: readonly string[] = Object.freeze([
  'command.executed',
  'file.edited',
  'file.watcher.updated',
  'installation.update-available',
  'installation.updated',
  'lsp.client.diagnostics',
  'lsp.updated',
  'message.part.removed',
  'message.part.updated',
  'message.removed',
  'message.updated',
  'permission.replied',
  'permission.updated',
  'pty.created',
  'pty.deleted',
  'pty.exited',
  'pty.updated',
  'server.connected',
  'server.instance.disposed',
  'session.compacted',
  'session.created',
  'session.deleted',
  'session.diff',
  'session.error',
  'session.idle',
  'session.status',
  'session.updated',
  'todo.updated',
  'tui.command.execute',
  'tui.prompt.append',
  'tui.toast.show',
  'vcs.branch.updated'
]);

/**
 * Plugin hook slots the adapter uses, addressed as `hook:<name>` so one mapper
 * covers both sources. These are `Hooks` members, NOT members of the `Event`
 * union — `permission.ask` is a hook, `permission.updated` is an event, and
 * conflating them is what made approvals look handled while input requests
 * silently never arrived.
 */
export const OPENCODE_HOOK_SLOTS: readonly string[] = Object.freeze([
  'chat.message',
  'permission.ask',
  'tool.execute.after',
  'tool.execute.before'
]);

/** Everything the adapter observes, in the address space the mapper accepts. */
export const OPENCODE_OBSERVED_TYPES: readonly string[] = Object.freeze([
  'message.part.updated',
  'message.updated',
  'permission.replied',
  'permission.updated',
  'session.error',
  'session.idle',
  'session.status',
  ...OPENCODE_HOOK_SLOTS.map((slot) => `hook:${slot}`)
]);

/**
 * The bounded slice the plugin posts. Only discriminating fields cross the
 * boundary: an OpenCode event can carry a whole message body, and none of that
 * is needed to answer "is this agent working".
 */
export interface OpencodeObservation {
  type: string;
  sessionID?: string;
  /** `session.status` — the SessionStatus discriminant and its retry detail. */
  status?: { type?: string; attempt?: number; message?: string };
  /** `session.error` — the error discriminant, never the payload. */
  error?: { name?: string; message?: string; isRetryable?: boolean; statusCode?: number };
  /** `permission.updated` / `hook:permission.ask` — what is being approved. */
  permissionTitle?: string;
  /** `tool.execute.*` callID: pairs a tool interval's two edges. */
  toolUseId?: string;
}

export function isKnownOpencodeEventType(type: string): boolean {
  return OPENCODE_EVENT_TYPES.includes(type);
}

/**
 * Facts asserted by one observation. Returns an empty array when the
 * observation asserts nothing — an unrecognised type never guesses, because a
 * wrong `idle` is worse than an honest `unknown` (R2/R3).
 *
 * An observation may assert more than one fact: a turn that ended at the
 * output-length cap is both idle and degraded, and dropping either would lie.
 */
export function opencodeFacts(observation: OpencodeObservation): AgentSemanticFact[] {
  if (!observation || typeof observation.type !== 'string') {
    return [];
  }
  switch (observation.type) {
    case 'session.status':
      return sessionStatusFacts(observation);
    case 'session.idle':
      return [{ kind: 'activity', activity: 'idle' }];
    case 'session.error':
      return sessionErrorFacts(observation);
    case 'permission.updated':
    case 'hook:permission.ask':
      return [{ kind: 'blocked', wait: approvalWait(observation.permissionTitle) }];
    case 'permission.replied':
      return [{ kind: 'unblocked' }];
    // A new user message opens the turn: OpenCode publishes no
    // "prompt submitted" event, and this hook is the typed equivalent.
    case 'hook:chat.message':
      return [{ kind: 'activity', activity: 'working' }];
    // A tool call is an INTERVAL. Its two edges let the authority hold
    // `working` for as long as the tool actually runs, instead of decaying to
    // unknown in the middle of a long one.
    case 'hook:tool.execute.before':
      return observation.toolUseId ? [{ kind: 'tool', phase: 'start' }] : [{ kind: 'heartbeat' }];
    case 'hook:tool.execute.after':
      return observation.toolUseId ? [{ kind: 'tool', phase: 'end' }] : [{ kind: 'heartbeat' }];
    // Streaming progress stays a plain beat: it proves life without claiming a
    // transition, and it must never promote a blocked session back to working.
    case 'message.updated':
    case 'message.part.updated':
      return [{ kind: 'heartbeat' }];
    default:
      return [];
  }
}

/**
 * `SessionStatus` is `{type:"idle"} | {type:"busy"} | {type:"retry",…}`. This is
 * the one place across the three agents where the agent states its activity
 * outright, so it is mapped directly rather than inferred from turn edges.
 *
 * `retry` is a provider wait: OpenCode is going to try again on its own, so the
 * operator must see the state without being summoned by it.
 */
function sessionStatusFacts(observation: OpencodeObservation): AgentSemanticFact[] {
  switch (observation.status?.type) {
    case 'busy':
      return [{ kind: 'activity', activity: 'working' }];
    case 'idle':
      return [{ kind: 'activity', activity: 'idle' }];
    case 'retry': {
      const attempt = observation.status.attempt;
      const detail = boundedDetail(observation.status.message);
      return [
        {
          kind: 'blocked',
          wait: {
            kind: 'retry',
            owner: 'provider',
            // `next` is deliberately not mapped to a countdown: its unit is
            // undocumented, and inventing one would put a wrong clock on the
            // operator's screen. Attempt count is unambiguous.
            detail: typeof attempt === 'number' ? `attempt ${attempt}${detail ? ` — ${detail}` : ''}` : detail
          }
        }
      ];
    }
    default:
      return [];
  }
}

/**
 * `session.error` carries a discriminated error, and the discriminant answers
 * the question the wait axis asks: who has to act. An aborted message is the
 * operator pressing stop — a normal end of turn, not a failure, and reporting
 * it as one is how a live agent gets painted dead.
 */
function sessionErrorFacts(observation: OpencodeObservation): AgentSemanticFact[] {
  const error = observation.error ?? {};
  const detail = boundedDetail(error.message);
  switch (error.name) {
    case 'MessageAbortedError':
      return [{ kind: 'activity', activity: 'idle' }];
    case 'MessageOutputLengthError':
      return [
        { kind: 'activity', activity: 'idle' },
        { kind: 'health', health: { status: 'degraded', reason: 'output-length-cap' } }
      ];
    case 'ProviderAuthError':
      return [{ kind: 'blocked', wait: { kind: 'auth', owner: 'operator', detail } }];
    // The SDK spells this discriminant `APIError`, not `ApiError`.
    case 'APIError':
      return [{ kind: 'blocked', wait: apiErrorWait(error, detail) }];
    default:
      return [{ kind: 'health', health: { status: 'degraded', reason: detail ?? 'session-error' } }];
  }
}

/**
 * `isRetryable` is OpenCode's own verdict on whether waiting helps, which maps
 * exactly onto the wait owner. Status codes that mean "your account" go to the
 * operator even when the provider calls them retryable.
 */
function apiErrorWait(
  error: NonNullable<OpencodeObservation['error']>,
  detail: string | undefined
): AgentWaitInput {
  const status = error.statusCode;
  if (status === 401 || status === 403) {
    return { kind: 'auth', owner: 'operator', detail };
  }
  if (status === 402) {
    return { kind: 'billing', owner: 'operator', detail };
  }
  if (error.isRetryable === true) {
    return { kind: status === 429 ? 'rate-limit' : 'provider-retry', owner: 'provider', detail };
  }
  return { kind: 'provider-error', owner: 'operator', detail };
}

function approvalWait(title: unknown): AgentWaitInput {
  return { kind: 'approval', owner: 'operator', detail: boundedDetail(title) };
}
