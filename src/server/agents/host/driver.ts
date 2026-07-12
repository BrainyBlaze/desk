import type { AgentSurfaceCommand, AgentSurfaceEventPayload, AgentUiErrorCode } from '../../../core/agentSurfaceProtocol.js';

/**
 * Native UI mode — adapter-host driver contract (spec: docs/native-ui-mode-spec.md §5).
 *
 * Three server-side drivers implement this interface (claude / codex / opencode); the
 * adapter host (`runner.ts`) loads one based on `DESK_AGENT`, subscribes BEFORE `start()`,
 * stamps every emitted payload with monotonic `seq` + ISO `ts` to produce a wire
 * `AgentSurfaceEvent`, and bridges commands (`inject` / `respondPermission` / `interrupt`
 * / `shutdown`) to driver methods.
 *
 * The host owns the broker WebSocket; drivers are pure protocol producers that talk only
 * to their agent-native surface (Claude Agent SDK / codex app-server / opencode serve).
 */

/**
 * Driver-emitted event payload. Structurally identical to `AgentSurfaceEventPayload`
 * because the adapter host stamps the `seq`/`ts` envelope to produce a wire event.
 *
 * Use `AgentSurfaceEventPayload` directly rather than `Omit<AgentSurfaceEvent, 'seq'|'ts'>`
 * — TypeScript collapses the enveloped discriminated union through that `Omit`, breaking
 * the per-kind discriminant. See commit 93276e6 for the protocol-side split rationale.
 */
// Drivers may attach child-agent attribution (item 11); the runner's envelope
// spread carries it into AgentSurfaceEvent.parentToolUseId.
export type DriverEvent = AgentSurfaceEventPayload & { parentToolUseId?: string };

/** Status-only driver event, narrowed for deterministic start() return values. */
export type DriverStatusEvent = Extract<DriverEvent, { kind: 'status' }>;

/**
 * Typed command failure. Drivers throw `DriverCommandError` from `inject` /
 * `respondPermission` / `interrupt` / `shutdown` when they can identify a specific
 * failure mode with a known retry disposition; the host maps it verbatim to a
 * `command-result ok:false` frame.
 *
 * Unknown errors thrown by command methods default to
 * `{ code: 'adapter-unavailable', retryable: true }` for `inject` / `respondPermission`
 * / `interrupt` (transient by assumption; channels-engine requeues with attempt-cap),
 * and `{ code: 'adapter-unavailable', retryable: false }` for `shutdown` (terminal;
 * host emits the failure frame if the socket is still writable, then exits).
 *
 * `start()` failures are not commands: an unknown error there becomes
 * `agent-error {fatal:true}` + nonzero host exit (mapped to AgentUiErrorCode
 * `driver-start-failed`).
 */
export interface DriverCommandError extends Error {
  /** AgentUiErrorCode carried in the `command-result` frame. */
  code: AgentUiErrorCode;
  /** When true, the host tells the caller (broker/channels-engine/UI) to requeue. */
  retryable: boolean;
}

/**
 * Runtime guard for `DriverCommandError`. Recognizes only `Error` instances carrying
 * string `code` + boolean `retryable` — plain `Error`, partial-shape objects, and
 * non-Error values are rejected so the host can fall through to its default mapping.
 */
export function isDriverCommandError(error: unknown): error is DriverCommandError {
  if (!(error instanceof Error)) {
    return false;
  }
  const record = error as { code?: unknown; retryable?: unknown };
  return typeof record.code === 'string' && typeof record.retryable === 'boolean';
}

/**
 * Create a `DriverCommandError`. Centralized so drivers don't hand-roll the
 * `Object.assign(new Error(...), {code, retryable})` shape across the codebase.
 */
export function driverCommandError(
  message: string,
  code: AgentUiErrorCode,
  retryable: boolean
): DriverCommandError {
  const error = new Error(message) as DriverCommandError;
  error.code = code;
  error.retryable = retryable;
  return error;
}

/**
 * The driver contract. Drivers connect to their agent on `start()`, emit events through
 * `onEvent` (subscribed BEFORE `start()` so startup events cannot be missed), accept
 * commands via the four command methods, expose committed history for backfill, and
 * release resources on `shutdown()`.
 *
 * All command methods MAY throw `DriverCommandError` for typed failures; the host maps
 * those verbatim. Unknown errors fall through to the per-method default mapping
 * documented on `DriverCommandError`.
 *
 * HOST-RUNNER INVARIANTS (cross-agent — learned from claude live probe e180c9b):
 * - **No short timeout around `start()`**: agent init can legitimately take minutes in
 *   hook-heavy environments (claude runs the user's SessionStart hook stack with
 *   settingSources default; same hooks as terminal mode). `start()` resolving fast does
 *   NOT mean the agent is ready to answer; it means the spawn pipe is up.
 * - **`session-info` events may arrive at ANY time and supersede the `start()` return**:
 *   in claude streaming-input mode the SDK emits init only after the first user input
 *   arrives — so the start() return carries best-known identity (resume id when
 *   resuming, undefined when fresh), and the real session id + model arrive later as a
 *   `session-info` event the host MUST forward. For FRESH sessions that event is where
 *   the resume id first appears; the broker's `session-info` → `persistSessionResume`
 *   mapping (spec §6) is the only id path in that case.
 */
export interface AgentDriver {
  /**
   * Subscribe to driver-emitted event payloads. The host subscribes BEFORE calling
   * `start()` so events emitted during agent connection / resume are not lost.
   *
   * Returns an unsubscribe function; drivers must stop invoking the handler after
   * unsubscribe returns AND after `shutdown()` resolves.
   */
  onEvent(handler: (event: DriverEvent) => void): () => void;

  /**
   * Connect to / spawn the agent, resume if a resume id was provided at host launch,
   * and return the initial broker-visible session-info plus the current deterministic
   * status. The host emits both as `AgentSurfaceEvent`s when `hello-ack.lastSeq === 0`
   * (fresh subscriber or server restart), ahead of any committed-history backfill.
   *
   * **Returns immediately with best-known identity** — see interface-level invariant:
   * the real session id / model may arrive later via a `session-info` event that
   * supersedes this return value. Host MUST forward those events. Host MUST NOT wrap
   * this call in a short timeout (agent init can take minutes under hook-heavy envs).
   *
   * Should throw on unrecoverable failure (the host emits `agent-error {fatal:true}`
   * and exits nonzero so the tmux pane surfaces the failure).
   */
  start(): Promise<{
    session: { agentSessionId?: string; model?: string; commands?: AgentSurfaceCommand[] };
    status: DriverStatusEvent;
  }>;

  /**
   * Send a user message. Resolves when the agent ACCEPTS the message (not when the
   * turn completes — turn progress flows back through `onEvent`).
   *
   * For history-derived events whose original source is unknowable, drivers MUST
   * default `source` to `'external'`; never guess `'ui'` or `'channel'` from agent
   * state. Live `inject` calls carry the caller's `source` through verbatim.
   */
  inject(text: string, source: 'ui' | 'channel' | 'external'): Promise<void>;

  /**
   * Respond to a previously-emitted `permission-request`. `requestId` matches the
   * `permission-request.requestId` the driver emitted; `optionId` matches one of the
   * `permission-request.options[].id` values. Resolves when the response is delivered
   * to the agent.
   */
  respondPermission(requestId: string, optionId: string, note?: string): Promise<void>;

  /**
   * Interrupt the current turn. Resolves when the interrupt is acknowledged by the
   * agent (subsequent state transitions arrive as events).
   */
  interrupt(): Promise<void>;

  /**
   * Fetch committed history for backfill. Called by the host only when
   * `hello-ack.lastSeq === 0` (fresh subscriber or server restart). Returns events
   * in chronological order; the host stamps `seq`/`ts` itself, so drivers must NOT
   * emit a `history-boundary` payload — the host emits that after `fetchHistory`
   * resolves. Drivers that cannot backfill MUST throw `DriverCommandError` with
   * `code: 'adapter-unavailable'` so the host can emit a typed `agent-error` instead
   * of pretending the snapshot is complete.
   */
  fetchHistory(): Promise<DriverEvent[]>;

  /**
   * Clean shutdown — close the agent connection, free resources, ensure no further
   * events are emitted via any subscribed handler. Called once on tmux-session kill
   * / mode-switch / Desk server shutdown. Should not return until the driver has
   * released its agent resources or given up trying.
   */
  shutdown(): Promise<void>;
}
