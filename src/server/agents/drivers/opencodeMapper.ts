import type {
  AssistantMessage,
  Event,
  Message,
  Part,
  Permission,
  SessionStatus,
  TextPart,
  ToolPart,
  UserMessage
} from '@opencode-ai/sdk';
import type { DriverEvent, DriverStatusEvent } from '../host/driver.js';

/**
 * OpenCode → DriverEvent mappers (pure functions; no SDK / network access).
 *
 * The opencode driver feeds every SDK observation through these helpers before emitting
 * to the host runner. Keeping them pure means the bulk of the protocol-translation logic
 * is unit-testable without spawning a real `opencode serve` child; only the small SDK-
 * binding surface in `opencodeDriver.ts` needs the live-binary probe.
 *
 * Mapping rules (spec docs/native-ui-mode-spec.md §4):
 *  - message.part.updated { delta }        → assistant-delta (transient) AND text-accumulator update
 *  - message.updated (AssistantMessage, completed) → assistant-message (committed, assembled markdown)
 *  - message.updated (UserMessage)         → SWALLOWED live (driver already emitted from inject(); never guessed)
 *  - ToolPart state pending                → tool-start
 *  - ToolPart state running                → (no event; sub-state of processing)
 *  - ToolPart state completed              → tool-end status=ok
 *  - ToolPart state error                  → tool-end status=error
 *  - session.status busy                   → status state=processing
 *  - session.status idle                   → status state=idle + turn-complete for the in-flight assistant message
 *  - session.status retry                  → attention-hint session-status with detail
 *  - session.idle                          → status state=idle + turn-complete
 *  - session.error                         → agent-error (fatal inferred from error type)
 *  - permission.updated                    → permission-request (requestId=permission.id)
 *  - permission.replied                    → permission-resolved (optionId=response)
 *
 * Session filter (R3): every event is filtered by `ctx.sessionId`. opencode subagent
 * Task tool creates child sessions on the same serve process; their messages/permissions
 * would otherwise leak into our transcript. The mapper drops anything not matching.
 *
 * History-derived UserMessages default source='external' (claude review msg-20260705-153930):
 * opencode history has no origin tag, so we never guess 'ui' or 'channel'.
 */

/**
 * Per-messageID accumulator for assistant text parts. Replaces an earlier
 * `Map<string, string>` shape that APPENDed part texts — wrong, because opencode fires
 * message.part.updated REPEATEDLY for the same partID as its text grows (part.text is the
 * full accumulated text of that part at that moment). The correct shape tracks each part's
 * latest text keyed by partID, plus the first-seen order so the assembled markdown preserves
 * authoring intent.
 */
export interface AssistantMessageText {
  /** Part IDs in first-seen order. */
  partOrder: string[];
  /** Latest text per partID. Replace on each message.part.updated for the same id. */
  partText: Map<string, string>;
}

/**
 * Assemble an AssistantMessageText into committed markdown by joining part texts in
 * first-seen order with a double-newline separator (markdown paragraph break; matches
 * composeAssistantMarkdown on the history path so live and backfilled commits render
 * identically). Single-part messages collapse to that part's latest text.
 */
export function assembleMarkdown(acc: AssistantMessageText | undefined): string {
  if (!acc || acc.partOrder.length === 0) {
    return '';
  }
  const segments: string[] = [];
  for (const partId of acc.partOrder) {
    const text = acc.partText.get(partId);
    if (text) {
      segments.push(text);
    }
  }
  return segments.join('\n\n');
}

/**
 * Live-event mapping context. The driver owns these fields and passes them in so the
 * mapper stays pure:
 *  - `sessionId`: filter events by session id (R3). Foreign-session events return null.
 *  - `pendingTurnId`: in-flight assistant messageID; used to attribute turn-complete
 *    when session.idle fires (which carries no message id itself).
 *  - `assistantTextByMessageId`: per-messageID accumulator keyed by partID. The mapper
 *    mutates this on every message.part.updated for a text part (REPLACE per partID,
 *    NOT append); assembled markdown is read on commit (R1 fix).
 *  - `assistantCommitted`: set of assistant messageIDs we've already emitted assistant-
 *    message for, so the same id's repeated message.updated (they fire multiple times)
 *    cannot double-commit.
 */
export interface LiveEventContext {
  sessionId: string;
  pendingTurnId?: string;
  assistantTextByMessageId: Map<string, AssistantMessageText>;
  assistantCommitted: Set<string>;
}

/** Build a ToolPart summary suitable for tool-start / tool-end display. */
function summarizeTool(part: ToolPart): string {
  if (part.state.status === 'completed' && part.state.title) {
    return part.state.title;
  }
  if (part.state.status === 'running' && part.state.title) {
    return part.state.title;
  }
  return `${part.tool}(${Object.keys(part.state.input).slice(0, 4).join(',')})`;
}

/** Map a ToolPart to its initial tool-start payload (used in history backfill). */
function mapToolStart(part: ToolPart): DriverEvent {
  return {
    kind: 'tool-start',
    toolUseId: part.callID,
    name: part.tool,
    summary: summarizeTool(part)
  };
}

/** Map a ToolPart to its committed tool-end payload (history backfill, or completed state). */
function mapToolEnd(part: ToolPart): DriverEvent | null {
  if (part.state.status === 'pending') {
    return null;
  }
  if (part.state.status === 'running') {
    // Running tool with no completion yet — emit only the start; live state will arrive
    // via message.part.updated when the tool transitions to completed/error.
    return null;
  }
  if (part.state.status === 'completed') {
    return {
      kind: 'tool-end',
      toolUseId: part.callID,
      status: 'ok',
      summary: summarizeTool(part),
      detail: part.state.output.slice(0, 4000)
    };
  }
  return {
    kind: 'tool-end',
    toolUseId: part.callID,
    status: 'error',
    summary: summarizeTool(part),
    detail: part.state.error
  };
}

/** Concatenate text + reasoning parts of an AssistantMessage into committed markdown. */
function composeAssistantMarkdown(parts: Part[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const textPart = part as TextPart;
      if (textPart.synthetic) {
        continue;
      }
      segments.push(textPart.text);
    }
  }
  return segments.join('\n\n');
}

/** Extract the user's text from a UserMessage's parts (synthetic parts ignored). */
function composeUserText(parts: Part[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const textPart = part as TextPart;
      if (textPart.synthetic) {
        continue;
      }
      segments.push(textPart.text);
    }
  }
  return segments.join('\n');
}

/**
 * Map an opencode Message + its parts (as returned by GET /session/:id/message) into the
 * DriverEvent stream for history backfill. Returns one or more events per message in
 * chronological order. Tools embedded in the parts produce tool-start + tool-end pairs.
 *
 * Caller (host runner) emits these BEFORE its own history-boundary event.
 */
export function mapHistoryMessage(
  info: Message,
  parts: Part[],
  source: 'ui' | 'channel' | 'external' = 'external'
): DriverEvent[] {
  const events: DriverEvent[] = [];
  if (info.role === 'user') {
    const text = composeUserText(parts);
    events.push({
      kind: 'user-message',
      id: info.id,
      text,
      source
    });
    return events;
  }
  const assistant = info as AssistantMessage;
  for (const part of parts) {
    if (part.type === 'tool') {
      const toolPart = part as ToolPart;
      events.push(mapToolStart(toolPart));
      const end = mapToolEnd(toolPart);
      if (end) {
        events.push(end);
      }
    }
  }
  events.push({
    kind: 'assistant-message',
    id: assistant.id,
    turnId: assistant.id,
    markdown: composeAssistantMarkdown(parts)
  });
  if (assistant.time.completed) {
    events.push({
      kind: 'turn-complete',
      turnId: assistant.id,
      usage: {
        costUsd: assistant.cost
      }
    });
  }
  return events;
}

/**
 * Map a live SSE Event from /event into a DriverEvent. Returns null when the event kind
 * has no normalized representation OR when the event belongs to a foreign session
 * (subagent child session, etc.).
 *
 * Caller is responsible for mutating `ctx.assistantTextByMessageId` and
 * `ctx.assistantCommitted` based on the return value — see `applyLiveEventSideEffects`.
 */
export function mapLiveEvent(
  event: Event,
  ctx: LiveEventContext
): DriverEvent | DriverEvent[] | null {
  if (!belongsToSession(event, ctx.sessionId)) {
    return null;
  }
  switch (event.type) {
    case 'message.part.updated': {
      const { part, delta } = event.properties;
      if (part.type !== 'text') {
        return null;
      }
      // R1 fix: REPLACE per partID (not append). opencode fires many updates for the same
      // partID as text grows; part.text is the full accumulated text at that moment.
      // Tracking first-seen order lets us assemble multi-part messages correctly on commit.
      let acc = ctx.assistantTextByMessageId.get(part.messageID);
      if (!acc) {
        acc = { partOrder: [], partText: new Map() };
        ctx.assistantTextByMessageId.set(part.messageID, acc);
      }
      if (!acc.partText.has(part.id)) {
        acc.partOrder.push(part.id);
      }
      acc.partText.set(part.id, part.text);

      if (!delta) {
        return null;
      }
      return {
        kind: 'assistant-delta',
        turnId: part.messageID,
        text: delta
      };
    }
    case 'message.updated': {
      const info = event.properties.info;
      if (info.role === 'user') {
        // R2 fix: live user-messages are emitted by the driver's inject() (with the
        // caller's source + actual text). message.updated for users carries no parts
        // and no origin; we swallow it entirely. The driver's handleEvent drops the
        // matching inject from its echo-tracking set.
        //
        // v2 implication: when opencode live dual-view is added (multiple clients on
        // one serve), user messages originating from OTHER clients will not surface in
        // this driver's transcript until that path is designed. Deliberate v1 constraint.
        return null;
      }
      const assistant = info as AssistantMessage;
      // R1 fix: emit assistant-message exactly once per messageID, with the assembled
      // markdown from accumulated text parts. Only commit when the assistant message
      // has reached completion (info.time.completed set) — partial updates do not commit.
      if (!assistant.time.completed) {
        return null;
      }
      if (ctx.assistantCommitted.has(assistant.id)) {
        return null;
      }
      ctx.assistantCommitted.add(assistant.id);
      const markdown = assembleMarkdown(ctx.assistantTextByMessageId.get(assistant.id));
      return {
        kind: 'assistant-message',
        id: assistant.id,
        turnId: assistant.id,
        markdown
      };
    }
    case 'session.status': {
      return mapSessionStatus(event.properties.status);
    }
    case 'session.idle': {
      const events: DriverEvent[] = [{ kind: 'status', state: 'idle' }];
      if (ctx.pendingTurnId) {
        events.push({ kind: 'turn-complete', turnId: ctx.pendingTurnId });
      }
      return events;
    }
    case 'session.error': {
      return mapSessionError(event.properties.error);
    }
    case 'permission.updated': {
      return mapPermission(event.properties);
    }
    case 'permission.replied': {
      return {
        kind: 'permission-resolved',
        requestId: event.properties.permissionID,
        optionId: event.properties.response,
        via: 'agent'
      };
    }
    default:
      // file.*, lsp.*, tui.*, pty.*, session.compacted, session.updated, message.removed,
      // message.part.removed, etc. — not part of the agent-surface contract.
      return null;
  }
}

/**
 * Returns true if the event payload references our session id. Different event kinds
 * carry the session id in different fields; this checks them all. Returns true for
 * event kinds that have NO session scoping (server.connected, etc.) — those still
 * pass through to the mapper's switch.
 */
function belongsToSession(event: Event, sessionId: string): boolean {
  const props = (event as { properties?: Record<string, unknown> }).properties;
  if (!props) {
    return true;
  }
  const candidate =
    props.sessionID ??
    (props.part as { sessionID?: string } | undefined)?.sessionID ??
    (props.info as { sessionID?: string } | undefined)?.sessionID ??
    (props.permission as { sessionID?: string } | undefined)?.sessionID;
  if (typeof candidate !== 'string') {
    // Events that legitimately have no session id (server.connected) — pass through.
    return true;
  }
  return candidate === sessionId;
}

/** Map a SessionStatus (idle/busy/retry) to a DriverStatusEvent. */
export function mapSessionStatus(status: SessionStatus): DriverStatusEvent {
  if (status.type === 'busy') {
    return { kind: 'status', state: 'processing' };
  }
  if (status.type === 'idle') {
    return { kind: 'status', state: 'idle' };
  }
  // retry — agent is alive but waiting on a backoff; surface as attention-hint via the
  // driver wrapping this into a status + attention-hint pair when it emits.
  return { kind: 'status', state: 'processing', detail: `retry: ${status.message}` };
}

/**
 * Expand a retry DriverStatusEvent into the (status, attention-hint) pair the broker
 * expects. Driver calls this when emitting mapSessionStatus output for a retry status.
 */
export function expandRetryStatus(status: DriverStatusEvent): DriverEvent[] {
  if (status.state === 'processing' && status.detail?.startsWith('retry: ')) {
    return [
      { kind: 'status', state: 'processing' },
      { kind: 'attention-hint', attention: 'session-status', detail: status.detail }
    ];
  }
  return [status];
}

/** Map an opencode Permission into a permission-request DriverEvent. */
export function mapPermission(perm: Permission): DriverEvent {
  const variant = perm.type === 'command' ? 'command' : perm.type === 'file' ? 'file-edit' : 'tool';
  return {
    kind: 'permission-request',
    requestId: perm.id,
    variant,
    title: perm.title,
    options: [
      { id: 'allow', label: 'Allow', treatment: 'allow' },
      { id: 'allow-always', label: 'Allow for this session', treatment: 'allow-session' },
      { id: 'deny', label: 'Deny', treatment: 'deny' }
    ]
  };
}

/** Map an opencode session.error payload into an agent-error DriverEvent. */
export function mapSessionError(
  error:
    | { name?: string; data?: { message?: string }; message?: string }
    | undefined
    | null
): DriverEvent {
  if (!error || typeof error !== 'object') {
    return { kind: 'agent-error', message: 'unknown error', fatal: false };
  }
  const message = error.data?.message ?? error.message ?? error.name ?? 'opencode error';
  // ProviderAuthError is fatal (user must fix creds); ApiError with isRetryable=false is fatal;
  // everything else is recoverable (will be retried by the agent or surfaced for retry).
  const fatal = error.name === 'ProviderAuthError';
  return { kind: 'agent-error', message, fatal };
}
