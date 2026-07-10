import type { DeskAgent } from './types.js';

/** High but finite protocol caps. These guard allocation; they are not UI truncation limits. */
export const MAX_AGENT_SURFACE_TEXT_LENGTH = 4 * 1024 * 1024;
export const MAX_AGENT_SURFACE_OPTIONS = 100;
export const MAX_AGENT_SURFACE_COMMANDS = 500;

/**
 * Native UI mode — normalized agent-surface protocol (spec: docs/native-ui-mode-spec.md §4).
 *
 * Three server-side drivers (claude / codex / opencode) produce this one protocol;
 * one broker fans it to browser surfaces. Type definitions are the frozen Phase 0
 * contract; parse-or-throw validators land with their RED tests in follow-up commits.
 */

/**
 * Bound on retained agent-surface rows/events. The broker keeps this many
 * committed events in its per-session ring, and the client row model retains at
 * most this many rows — a single shared ceiling so neither side out-buffers the
 * other. Both the server broker and the client rowsModel import this.
 */
export const AGENT_SURFACE_RING_SIZE = 2000;

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
  /** When set, this event belongs to the child agent spawned by that tool call (item 11). */
  parentToolUseId?: string;
}

export type AgentSurfacePermissionTreatment = 'allow' | 'allow-session' | 'deny' | 'answer' | 'custom';

export interface AgentSurfacePermissionOption {
  id: string;
  label: string;
  treatment: AgentSurfacePermissionTreatment;
}

/** A slash command the agent supports (UX item 9: composer palette). */
export interface AgentSurfaceCommand {
  name: string;
  description?: string;
}

/**
 * Event payloads without the seq/ts envelope. Drivers emit these; the adapter
 * host stamps seq/ts to produce AgentSurfaceEvent. Exported separately because
 * Omit over the enveloped union collapses the discriminant in TypeScript.
 */
export type AgentSurfaceEventPayload =
  (
    | { kind: 'session-info'; agentSessionId?: string; model?: string; commands?: AgentSurfaceCommand[] }
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

export type AgentSurfaceEvent = AgentSurfaceEventBase & AgentSurfaceEventPayload;

export type AgentUiErrorCode =
  | 'adapter-unavailable'
  | 'driver-start-failed'
  | 'not-native-session'
  | 'send-while-busy'
  | 'unknown-permission'
  | 'unsupported-command'
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

const AGENT_SURFACE_STATES: readonly AgentSurfaceState[] = [
  'starting',
  'idle',
  'processing',
  'tool-executing',
  'awaiting-permission',
  'interrupted',
  'error',
  'exited'
];

const PERMISSION_TREATMENTS: readonly AgentSurfacePermissionTreatment[] = ['allow', 'allow-session', 'deny', 'answer', 'custom'];

const AGENT_UI_ERROR_CODES: readonly AgentUiErrorCode[] = [
  'adapter-unavailable',
  'driver-start-failed',
  'not-native-session',
  'send-while-busy',
  'unknown-permission',
  'unsupported-command',
  'invalid-frame'
];

const MESSAGE_SOURCES = ['ui', 'channel', 'external'] as const;
const TOOL_END_STATUSES = ['ok', 'error', 'denied'] as const;
const PERMISSION_VARIANTS = ['tool', 'command', 'file-edit', 'question'] as const;
const RESOLUTION_VIAS = ['ui', 'agent', 'timeout', 'respawn'] as const;
const ATTENTION_HINTS = ['idle-prompt', 'elicitation', 'session-status'] as const;

export function parseAgentUiClientFrame(value: unknown): AgentUiClientFrame {
  const frame = asRecord(value);
  const session = nonEmptyString(frame.session);
  const surfaceId = nonEmptyString(frame.surfaceId);
  switch (frame.type) {
    case 'subscribe':
      return { type: 'subscribe', session, surfaceId, visible: bool(frame.visible) };
    case 'visibility':
      return { type: 'visibility', session, surfaceId, visible: bool(frame.visible) };
    case 'unsubscribe':
      return { type: 'unsubscribe', session, surfaceId };
    case 'send':
      return { type: 'send', session, surfaceId, text: nonEmptyString(frame.text) };
    case 'respond-permission':
      return {
        type: 'respond-permission',
        session,
        surfaceId,
        requestId: nonEmptyString(frame.requestId),
        optionId: nonEmptyString(frame.optionId),
        ...(frame.note === undefined ? {} : { note: str(frame.note) })
      };
    case 'interrupt':
      return { type: 'interrupt', session, surfaceId };
    default:
      throw invalidFrame();
  }
}

export function parseAgentSurfaceEvent(value: unknown): AgentSurfaceEvent {
  const parsed = parseAgentSurfaceEventInner(value);
  const record = asRecord(value);
  if (record.parentToolUseId !== undefined) {
    return { ...parsed, parentToolUseId: nonEmptyString(record.parentToolUseId) };
  }
  return parsed;
}

function parseAgentSurfaceEventInner(value: unknown): AgentSurfaceEvent {
  const event = asRecord(value);
  const seq = nonNegativeInt(event.seq);
  const ts = nonEmptyString(event.ts);
  switch (event.kind) {
    case 'session-info':
      return {
        kind: 'session-info',
        seq,
        ts,
        ...(event.agentSessionId === undefined ? {} : { agentSessionId: str(event.agentSessionId) }),
        ...(event.model === undefined ? {} : { model: str(event.model) }),
        ...(event.commands === undefined ? {} : { commands: parseCommands(event.commands) })
      };
    case 'status':
      return {
        kind: 'status',
        seq,
        ts,
        state: oneOf(event.state, AGENT_SURFACE_STATES),
        ...(event.detail === undefined ? {} : { detail: str(event.detail) })
      };
    case 'user-message':
      return {
        kind: 'user-message',
        seq,
        ts,
        id: nonEmptyString(event.id),
        text: str(event.text),
        source: oneOf(event.source, MESSAGE_SOURCES)
      };
    case 'assistant-delta':
      return { kind: 'assistant-delta', seq, ts, turnId: nonEmptyString(event.turnId), text: str(event.text) };
    case 'assistant-message':
      return {
        kind: 'assistant-message',
        seq,
        ts,
        id: nonEmptyString(event.id),
        turnId: nonEmptyString(event.turnId),
        markdown: str(event.markdown)
      };
    case 'tool-start':
      return {
        kind: 'tool-start',
        seq,
        ts,
        toolUseId: nonEmptyString(event.toolUseId),
        name: nonEmptyString(event.name),
        summary: str(event.summary),
        ...(event.detail === undefined ? {} : { detail: str(event.detail) })
      };
    case 'tool-output-delta':
      return { kind: 'tool-output-delta', seq, ts, toolUseId: nonEmptyString(event.toolUseId), text: str(event.text) };
    case 'tool-end':
      return {
        kind: 'tool-end',
        seq,
        ts,
        toolUseId: nonEmptyString(event.toolUseId),
        status: oneOf(event.status, TOOL_END_STATUSES),
        ...(event.summary === undefined ? {} : { summary: str(event.summary) }),
        ...(event.detail === undefined ? {} : { detail: str(event.detail) })
      };
    case 'permission-request':
      return {
        kind: 'permission-request',
        seq,
        ts,
        requestId: nonEmptyString(event.requestId),
        variant: oneOf(event.variant, PERMISSION_VARIANTS),
        title: nonEmptyString(event.title),
        ...(event.detail === undefined ? {} : { detail: str(event.detail) }),
        ...(event.diff === undefined ? {} : { diff: parseDiff(event.diff) }),
        options: parseOptions(event.options)
      };
    case 'permission-resolved':
      return {
        kind: 'permission-resolved',
        seq,
        ts,
        requestId: nonEmptyString(event.requestId),
        optionId: nonEmptyString(event.optionId),
        via: oneOf(event.via, RESOLUTION_VIAS)
      };
    case 'turn-complete':
      return {
        kind: 'turn-complete',
        seq,
        ts,
        turnId: nonEmptyString(event.turnId),
        ...(event.usage === undefined ? {} : { usage: parseUsage(event.usage) })
      };
    case 'attention-hint':
      return {
        kind: 'attention-hint',
        seq,
        ts,
        attention: oneOf(event.attention, ATTENTION_HINTS),
        ...(event.detail === undefined ? {} : { detail: str(event.detail) })
      };
    case 'history-boundary':
      if (event.backfillComplete !== true) {
        throw invalidFrame();
      }
      return { kind: 'history-boundary', seq, ts, backfillComplete: true };
    case 'agent-error':
      return { kind: 'agent-error', seq, ts, message: nonEmptyString(event.message), fatal: bool(event.fatal) };
    default:
      throw invalidFrame();
  }
}

export function parseAgentHostServerFrame(value: unknown): AgentHostServerFrame {
  const frame = asRecord(value);
  switch (frame.type) {
    case 'hello-ack':
      return { type: 'hello-ack', lastSeq: nonNegativeInt(frame.lastSeq) };
    case 'inject':
      return {
        type: 'inject',
        requestId: nonEmptyString(frame.requestId),
        text: nonEmptyString(frame.text),
        source: oneOf(frame.source, MESSAGE_SOURCES)
      };
    case 'respond-permission':
      return {
        type: 'respond-permission',
        requestId: nonEmptyString(frame.requestId),
        permissionRequestId: nonEmptyString(frame.permissionRequestId),
        optionId: nonEmptyString(frame.optionId),
        ...(frame.note === undefined ? {} : { note: str(frame.note) })
      };
    case 'interrupt':
      return { type: 'interrupt', requestId: nonEmptyString(frame.requestId) };
    case 'shutdown':
      return { type: 'shutdown', requestId: nonEmptyString(frame.requestId) };
    default:
      throw invalidFrame();
  }
}

export function parseAgentHostClientFrame(value: unknown): AgentHostClientFrame {
  const frame = asRecord(value);
  switch (frame.type) {
    case 'hello':
      return {
        type: 'hello',
        session: nonEmptyString(frame.session),
        token: nonEmptyString(frame.token),
        agent: nonEmptyString(frame.agent),
        pid: nonNegativeInt(frame.pid)
      };
    case 'event':
      return { type: 'event', event: parseAgentSurfaceEvent(frame.event) };
    case 'command-result': {
      const requestId = nonEmptyString(frame.requestId);
      if (frame.ok === true) {
        return { type: 'command-result', requestId, ok: true };
      }
      if (frame.ok === false) {
        const error = asRecord(frame.error);
        return {
          type: 'command-result',
          requestId,
          ok: false,
          error: {
            code: oneOf(error.code, AGENT_UI_ERROR_CODES),
            message: nonEmptyString(error.message),
            retryable: bool(error.retryable)
          }
        };
      }
      throw invalidFrame();
    }
    default:
      throw invalidFrame();
  }
}

function parseOptions(value: unknown): AgentSurfacePermissionOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_SURFACE_OPTIONS) {
    throw invalidFrame();
  }
  return value.map((entry) => {
    const option = asRecord(entry);
    return {
      id: nonEmptyString(option.id),
      label: nonEmptyString(option.label),
      treatment: oneOf(option.treatment, PERMISSION_TREATMENTS)
    };
  });
}

function parseDiff(value: unknown): { path: string; before?: string; after?: string } {
  const diff = asRecord(value);
  return {
    path: nonEmptyString(diff.path),
    ...(diff.before === undefined ? {} : { before: str(diff.before) }),
    ...(diff.after === undefined ? {} : { after: str(diff.after) })
  };
}

function parseUsage(value: unknown): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const usage = asRecord(value);
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: finiteNumber(usage.inputTokens) }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: finiteNumber(usage.outputTokens) }),
    ...(usage.costUsd === undefined ? {} : { costUsd: finiteNumber(usage.costUsd) })
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidFrame();
  }
  return value as Record<string, unknown>;
}

function parseCommands(value: unknown): AgentSurfaceCommand[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SURFACE_COMMANDS) {
    throw invalidFrame();
  }
  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      name: nonEmptyString(record.name),
      ...(record.description === undefined ? {} : { description: str(record.description) })
    };
  });
}

function nonEmptyString(value: unknown): string {
  const parsed = str(value);
  if (parsed.trim() === '') {
    throw invalidFrame();
  }
  return parsed;
}

function str(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_AGENT_SURFACE_TEXT_LENGTH) {
    throw invalidFrame();
  }
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw invalidFrame();
  }
  return value;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidFrame();
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidFrame();
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidFrame();
  }
  return value as T;
}

function invalidFrame(): Error {
  return new Error('invalid agent surface frame');
}
