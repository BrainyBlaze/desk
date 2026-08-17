// Channels delivery vocabulary.
//
// The contracts shared by the delivery engine and the web ops console: what a
// session's queue is doing, how far a single delivery got, and why a queue is
// held. Defined once here — delivery/engine.ts re-exports them for the server
// and channelsClient.ts re-exports them for the web — so a new state lands in
// one place and tsc forces every consumer to handle it.
//
// Nothing here describes the conversation on disk (protocol/format.ts) or
// decides who a message is for (protocol/routing.ts).

import type { AgentActivity, SessionLifecycle, WaitOwner } from '../../../shared/controlPlane/index.js';

/**
 * Channels engine diagnostics — the contracts shared by the server engine and
 * the web ops console. DEFINED HERE (single source): delivery/engine.ts imports
 * + re-exports them for the server, channelsClient.ts imports + re-exports them
 * for the web. They used to be hand-mirrored in the client, which drifted from
 * the server union; a new state now lands in one place and tsc-forces every
 * consumer (e.g. the EngineConsole label maps) to handle it.
 */

/**
 * `unregistered` — the engine holds NO runtime state for the session (it is
 * not a tracked member of any channel this engine drives). It is not `ready`:
 * ready is a positive claim about a queue the engine owns, and this engine
 * owns none for the session. Operator diagnostics must say so instead of
 * shading it green.
 */
export type DeliveryStatus = 'ready' | 'queued' | 'delivering' | 'submit-stuck' | 'blocked' | 'paused' | 'unregistered';

/**
 * One Channels row combines a projection of one canonical authority batch with
 * Channels-owned delivery transaction state. Agent activity and delivery are
 * deliberately orthogonal.
 */
export interface LifecycleState {
  sessionId: string;
  authorityRevision: number | null;
  lifecycle: SessionLifecycle | 'unknown';
  activity: AgentActivity;
  waitOwner?: WaitOwner;
  waitKind?: string;
  waitDetail?: string;
  actionable: boolean;
  queueDepth: number;
  deliveryStatus: DeliveryStatus;
  lastDeliveryAt?: string;
  lastReleaseAt?: string;
  submitState?: SubmitState;
  pausedByOperator?: boolean;
  pauseReason?: string;
  pausedAt?: string;
  deliveryBlocked?: boolean;
  blockedReason?: DeliveryBlockReason;
  blockedItemCount: number;
  droppedQueueItems: number;
}

export interface SessionResumeInfo {
  sessionName?: string;
  agent?: string;
  cwd?: string;
  resume?: string;
  hasResume: boolean;
  bypassPermissions?: boolean;
  uiMode?: 'terminal' | 'native';
}

export interface ChannelActivityEvent {
  seq: number;
  kind: 'message' | 'queued' | 'delivery' | 'human-mention';
  channel: string;
  file: string;
  messageId: string;
  author: string;
  /** queue/delivery events: the member/session that should receive or received the prompt */
  target?: string;
  preview: string;
  at: string;
}

/**
 * Lifecycle of a single delivery's submit, as the verify cycle observes it.
 * `delivering` is set the instant the paste is pushed; the verify cycle resolves
 * it to `submitted` (positive evidence the prompt was accepted — the agent went
 * working, OR after a ready-gated delivery a structural approval/input menu
 * appeared) or to one of three stuck classifications after N cycles:
 *  - `submit-stuck-paste`        — pane never changed from pre-paste; the paste
 *    never landed in the input box.
 *  - `submit-stuck-submit`       — the prompt is in the box (pane changed) but
 *    the submit Enter was eaten, so it never ran.
 *  - `submit-stuck-unobservable` — no positive observation across N cycles
 *    (capture null/failed throughout); submission unconfirmed, so at-least-once
 *    replay (the message-id embedded in the prompt makes the replay safe).
 *  - (`delivery-ack-timeout` is NOT a live state: it exists only in
 *    `HistoricalSubmitState` for readers of already-persisted history.)
 *  - `submit-not-applicable` — the receiving session is not an agent (a shell),
 *    so there is no submit to verify: no activity to go `working`, no input box
 *    an Enter could be eaten by, no approval menu. The paste reached the pane
 *    and the shell ran the line; every agent-shaped verdict — `submitted` as
 *    much as `submit-stuck-*` — would be a claim about evidence that cannot
 *    exist. Terminal and NOT a failure: it never blocks the queue and its
 *    ack-file is `.delivered`, not `.stuck-*`.
 * The on-disk ack-file durability layer keys its `.delivering/.delivered/
 * .stuck-*` renames on these transitions.
 */
export type SubmitState =
  | 'delivering'
  | 'submitted'
  | 'submit-not-applicable'
  | 'submit-stuck-paste'
  | 'submit-stuck-submit'
  | 'submit-stuck-unobservable';

/**
 * The HISTORICAL submit vocabulary: everything the live engine emits today plus
 * `delivery-ack-timeout`, a state no live path has emitted since delivery ACK
 * outcomes were retired. It survives only in already-persisted event rings and
 * ack-file names, so readers of durable history (the timeline, the console
 * label table) speak this wider vocabulary — while the engine's own state and
 * every write path speak `SubmitState`, and a write arm for the retired state
 * cannot exist because the type refuses it.
 */
export type HistoricalSubmitState = SubmitState | 'delivery-ack-timeout';

/**
 * Agents whose sessions are a bare shell rather than an assistant CLI. They
 * produce no canonical activity, so agent-shaped submit verification (see
 * SubmitState) has no evidence to read and must not be run against them.
 */
const SHELL_AGENTS = new Set(['bash']);

/** True when a session's agent is a plain shell rather than an assistant CLI. */
export function isShellAgent(agent: string | undefined): boolean {
  return agent !== undefined && SHELL_AGENTS.has(agent);
}

/** Why a session's queue is currently held (ops-console diagnostic). */
// This runtime list is deliberately exhaustive: lifecycle refusal, drain
// single-flight ownership, transport failure, and the two observable terminal
// submit failures are the only production paths that can populate
// SessionDiagnostic.blockedReason.
export const DELIVERY_BLOCK_REASONS = [
  'offline',
  'booting',
  'draining',
  'send-failed',
  'submit-stuck-paste',
  'submit-stuck-submit'
] as const;

export type DeliveryBlockReason = (typeof DELIVERY_BLOCK_REASONS)[number];

/** Durable queue item shared by the delivery engine and persistence layer. */
export interface QueuedPrompt {
  seq: number;
  channel: string;
  messageId: string;
  author: string;
  prompt: string;
  queuedAt: string;
  /** 'prompt' = standalone briefing delivered verbatim; absent/'message' = channel dispatch. */
  kind?: 'message' | 'prompt';
  /** Conversation file the message lives in (root.md / thread-...). */
  file?: string;
  /** Receiving member channel handle, used by digest instructions. */
  member?: string;
}

/** A queued prompt as exposed to the ops console (no full prompt body). */
export interface QueuedItemMeta {
  seq: number;
  channel: string;
  messageId: string;
  author: string;
  queuedAt: string;
  kind: 'message' | 'prompt';
  preview: string;
}

/**
 * A durable stuck delivery (.stuck-paste / .stuck-submit / .stuck-unobservable)
 * as exposed to the ops console — the no-body diagnostic of a stuck queue item
 * (mirrors QueuedItemMeta-vs-QueuedPrompt). The full prompt body never enters
 * the diagnostic payload; the operator force-delivers or drops by seq.
 */
export interface BlockedItemMeta {
  seq: number;
  kind: 'paste' | 'submit' | 'unobservable';
  channel: string;
  messageId: string;
  author: string;
  queuedAt: string;
  preview: string;
}

/** Per-session engine diagnostics for the ops console. */
export interface SessionDiagnostic {
  sessionId: string;
  authorityRevision: number | null;
  lifecycle: SessionLifecycle | 'unknown';
  activity: AgentActivity;
  waitOwner?: WaitOwner;
  waitKind?: string;
  waitDetail?: string;
  actionable: boolean;
  queueDepth: number;
  deliveryStatus: DeliveryStatus;
  pausedByOperator?: boolean;
  pauseReason?: string;
  pausedAt?: string;
  draining: boolean;
  lastDeliveryAt?: string;
  lastReleaseAt?: string;
  /** result of the last delivery's submit verification (undefined = none yet) */
  submitState?: SubmitState;
  deliveryBlocked?: boolean;
  blockedReason?: DeliveryBlockReason;
  blockedSince?: string;
  blockedCycles?: number;
  blockedHeadSeq?: number;
  droppedQueueItems?: number;
  /** durable stuck items (.stuck-*) surfaced for operator force-deliver / drop */
  blockedItems?: BlockedItemMeta[];
  items: QueuedItemMeta[];
  /** manifest-backed resume/session metadata for the resume inspector */
  sessionName?: string;
  agent?: string;
  cwd?: string;
  resume?: string;
  hasResume?: boolean;
  bypassPermissions?: boolean;
}
