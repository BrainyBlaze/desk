import type { DeskAgent } from './types.js';

/**
 * Native UI mode — normalized agent-surface protocol (spec: docs/native-ui-mode-spec.md §4).
 *
 * Three server-side drivers (claude / codex / opencode) produce this one protocol;
 * one broker fans it to browser surfaces. Type definitions are the frozen Phase 0
 * contract; parse-or-throw validators land with their RED tests in follow-up commits.
 */

export type AgentSurfaceState =
  | 'starting'
  | 'idle'
  | 'processing'
  | 'tool-executing'
  | 'awaiting-permission'
  | 'interrupted'
  | 'error'
  | 'exited';

export interface AgentSurfaceEventBase {
  /** Monotonic per host spawn; assigned by the adapter host. */
  seq: number;
  /** ISO timestamp assigned by the adapter host. */
  ts: string;
}

export type AgentSurfacePermissionTreatment = 'allow' | 'allow-session' | 'deny' | 'answer' | 'custom';

export interface AgentSurfacePermissionOption {
  id: string;
  label: string;
  treatment: AgentSurfacePermissionTreatment;
}

export type AgentSurfaceEvent = AgentSurfaceEventBase &
  (
    | { kind: 'session-info'; agentSessionId?: string; model?: string }
    | { kind: 'status'; state: AgentSurfaceState; detail?: string }
    | { kind: 'user-message'; id: string; text: string; source: 'ui' | 'channel' | 'external' }
    /** Transient; excluded from the replay ring. */
    | { kind: 'assistant-delta'; turnId: string; text: string }
    /** Committed; replaces the in-progress row with the same turnId. */
    | { kind: 'assistant-message'; id: string; turnId: string; markdown: string }
    | { kind: 'tool-start'; toolUseId: string; name: string; summary: string; detail?: string }
    /** Transient; excluded from the replay ring. */
    | { kind: 'tool-output-delta'; toolUseId: string; text: string }
    | { kind: 'tool-end'; toolUseId: string; status: 'ok' | 'error' | 'denied'; summary?: string; detail?: string }
    | {
        kind: 'permission-request';
        requestId: string;
        variant: 'tool' | 'command' | 'file-edit' | 'question';
        title: string;
        detail?: string;
        diff?: { path: string; before?: string; after?: string };
        options: AgentSurfacePermissionOption[];
      }
    | { kind: 'permission-resolved'; requestId: string; optionId: string; via: 'ui' | 'agent' | 'timeout' | 'respawn' }
    | { kind: 'turn-complete'; turnId: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }
    /** Per-agent attention nuances that are not FSM states; broker maps to AgentEventV2 kinds. */
    | { kind: 'attention-hint'; attention: 'idle-prompt' | 'elicitation' | 'session-status'; detail?: string }
    /** Emitted exactly once per spawn, after committed-history backfill and before live events. */
    | { kind: 'history-boundary'; backfillComplete: true }
    | { kind: 'agent-error'; message: string; fatal: boolean }
  );

export type AgentUiErrorCode =
  | 'adapter-unavailable'
  | 'driver-start-failed'
  | 'not-native-session'
  | 'send-while-busy'
  | 'unknown-permission'
  | 'invalid-frame';

/** Browser -> server frames on /ws/agent-ui. */
export type AgentUiClientFrame =
  | { type: 'subscribe'; session: string; surfaceId: string; visible: boolean }
  | { type: 'visibility'; session: string; surfaceId: string; visible: boolean }
  | { type: 'unsubscribe'; session: string; surfaceId: string }
  | { type: 'send'; session: string; surfaceId: string; text: string }
  | { type: 'respond-permission'; session: string; surfaceId: string; requestId: string; optionId: string; note?: string }
  | { type: 'interrupt'; session: string; surfaceId: string };

/** Server -> browser frames on /ws/agent-ui. */
export type AgentUiServerFrame =
  | { type: 'ready'; version: 1 }
  | { type: 'snapshot'; session: string; surfaceId: string; state: AgentSurfaceState; lastSeq: number; events: AgentSurfaceEvent[] }
  | { type: 'event'; session: string; event: AgentSurfaceEvent }
  | { type: 'error'; session?: string; code: AgentUiErrorCode; message: string }
  | { type: 'exit'; session: string; reason: 'killed' | 'crashed' | 'mode-switched' };

/** Server -> adapter-host frames on /ws/agent-host. */
export type AgentHostServerFrame =
  | { type: 'hello-ack'; lastSeq: number }
  | { type: 'inject'; requestId: string; text: string; source: 'ui' | 'channel' | 'external' }
  | { type: 'respond-permission'; requestId: string; permissionRequestId: string; optionId: string; note?: string }
  | { type: 'interrupt'; requestId: string }
  | { type: 'shutdown'; requestId: string };

/** Adapter-host -> server frames on /ws/agent-host. */
export type AgentHostClientFrame =
  | { type: 'hello'; session: string; token: string; agent: DeskAgent; pid: number }
  | { type: 'event'; event: AgentSurfaceEvent }
  | { type: 'command-result'; requestId: string; ok: true }
  | { type: 'command-result'; requestId: string; ok: false; error: { code: AgentUiErrorCode; message: string; retryable: boolean } };
