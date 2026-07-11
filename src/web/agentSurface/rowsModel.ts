import { AGENT_SURFACE_RING_SIZE } from '../../core/agentSurfaceProtocol.js';
import type { AgentSurfaceEvent, AgentSurfaceState } from '../../core/agentSurfaceProtocol.js';

/**
 * Pure row-model helpers for the NativeAgentSurface. Extracted from the component so the
 * mapping logic is unit-testable without rendering React.
 */

export interface AgentRow {
  kind: 'user-message' | 'assistant-message' | 'tool' | 'turn-complete' | 'system';
  id: string;
  turnId?: string;
  text: string;
  authorLabel?: 'you' | 'assistant' | 'tool' | 'system' | 'subagent';
  /** Item 11: rows emitted by a child agent, nested under the spawning tool row. */
  children?: AgentRow[];
  createdAt?: string;
  updatedAt?: string;
  collapse?: RowCollapse;
  toolUseId?: string;
  toolName?: string;
  toolStatus?: 'ok' | 'error' | 'denied' | 'running';
  toolState?: ToolStateDisplay;
  toolDetail?: string;
  toolResult?: string;
}

export interface ToolStateDisplay {
  label: 'Running' | 'Done' | 'Failed' | 'Denied';
  tone: 'running' | 'ok' | 'error' | 'denied';
  active: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

type ToolTerminalStatus = 'ok' | 'error' | 'denied';

export const DEFAULT_TURN_COLLAPSE_ROW_THRESHOLD = 120;
export const DEFAULT_TURN_COLLAPSE_KEEP_RECENT_TURNS = 3;
/**
 * Hard memory bound on a session's row history (top-level + nested child rows).
 * A long-lived agent can emit tens of thousands of rows; without a ceiling the
 * model (and every render over it) grows unbounded. Shared with the broker ring
 * so neither side out-buffers the other (§ retention contract).
 */
export const DEFAULT_MAX_RETAINED_ROWS = AGENT_SURFACE_RING_SIZE;

/**
 * Per-row cap on streamed tool output (tool-output-delta concatenation). A tool
 * that streams megabytes into one row would otherwise grow that row's text
 * unbounded, invisible to row-count retention. Keep the most recent tail — the
 * end of a stream is what the reader wants — with a truncation marker.
 */
export const MAX_TOOL_RESULT_CHARS = 16_000;

/**
 * Per-turn cap on accumulated assistant streaming text (pendingAssistant). A turn
 * that streams deltas but never emits a terminal assistant-message would otherwise
 * grow this string unbounded in the component, invisible to row-count retention.
 */
export const MAX_PENDING_ASSISTANT_CHARS = 100_000;

/**
 * Aggregate cap on the pendingAssistant map's ENTRY count. Each streaming turn
 * adds one keyed entry; an abandoned turnId (streams deltas but never emits a
 * terminal assistant-message) would otherwise linger forever. Bounding entries
 * (in addition to the per-string char cap) keeps N * MAX_PENDING_ASSISTANT_CHARS
 * from accumulating across many abandoned turns.
 */
export const MAX_PENDING_ASSISTANT_TURNS = 64;

/** Bound a growing string to its last maxChars, prefixing a truncation marker. */
export function clampTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `…[truncated ${text.length - maxChars} chars]\n${text.slice(text.length - maxChars)}`;
}

/**
 * Accumulate a streaming assistant delta into the pendingAssistant map, bounded
 * both per-string (clampTail) and in aggregate entry count (oldest turn evicted
 * once over MAX_PENDING_ASSISTANT_TURNS). Pure so the bound is node-testable.
 */
export function appendPendingAssistant(prev: Map<string, string>, turnId: string, text: string): Map<string, string> {
  const next = new Map(prev);
  next.set(turnId, clampTail((next.get(turnId) ?? '') + text, MAX_PENDING_ASSISTANT_CHARS));
  while (next.size > MAX_PENDING_ASSISTANT_TURNS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    next.delete(oldest);
  }
  return next;
}

export interface RowCollapse {
  defaultCollapsed: true;
  reason: 'channel-onboarding' | 'long-payload';
  preview: string;
}

export interface PendingPermission {
  requestId: string;
  variant: 'tool' | 'command' | 'file-edit' | 'question';
  title: string;
  detail?: string;
  diff?: { path: string; before?: string; after?: string };
  options: Array<{ id: string; label: string; treatment: string }>;
}

export interface RowModel {
  rows: AgentRow[];
  status: AgentSurfaceState;
  pendingPermission: PendingPermission | null;
  /**
   * Cumulative count of top-level rows evicted from the FRONT over this model's
   * life. The absolute position of rows[i] is prunedRowCount + i; unread/anchor
   * logic keyed on row position must use this offset, since front-eviction makes
   * a raw rows.length count non-monotonic.
   */
  prunedRowCount: number;
  /**
   * High-watermark of the highest committed event.seq applied. A committed event
   * arriving with seq <= this is a replay (e.g. reconnect backfill) — possibly of
   * a row already pruned — so it is skipped rather than resurrected by id-only
   * idempotency. Reset per snapshot (rowsFromSnapshot seeds it from the ring).
   */
  appliedThroughSeq: number;
}

export type AgentFeedItem =
  | { kind: 'row'; id: string; row: AgentRow; rowIndex: number; firstRowIndex: number; lastRowIndex: number }
  | {
      kind: 'turn-summary';
      id: string;
      turnId: string;
      rows: AgentRow[];
      firstRowIndex: number;
      lastRowIndex: number;
      rowCount: number;
      toolCount: number;
      assistantCount: number;
      preview: string;
    };

export interface BuildAgentFeedItemsOptions {
  collapseAfterRows?: number;
  keepRecentTurns?: number;
  expandedTurnIds?: ReadonlySet<string>;
}

export function initialRowModel(): RowModel {
  return { rows: [], status: 'starting', pendingPermission: null, prunedRowCount: 0, appliedThroughSeq: -1 };
}

/**
 * Build a RowModel from a snapshot ring (committed events). The broker already filters
 * transients out of the ring, so we don't expect deltas here; status / commit / tool /
 * permission / turn-complete / system rows are projected in chronological order.
 */
export function rowsFromSnapshot(
  events: AgentSurfaceEvent[],
  state: AgentSurfaceState = 'starting',
  lastSeq?: number
): RowModel {
  const model = initialRowModel();
  model.status = state;
  let maxSeq = -1;
  for (const event of events) {
    applyCommittedEvent(model, event);
    if (event.seq > maxSeq) {
      maxSeq = event.seq;
    }
  }
  // Seed the replay watermark from the broker's lastSeq — the highest seq it has
  // emitted, which can EXCEED max(retained events) once count/byte eviction drops
  // committed events or when the tail was transient-only. Seeding from max(events)
  // would leave a replay window (max(events), lastSeq] that id-only idempotency
  // can't catch after pruning. Fall back to max(events) when lastSeq is absent.
  model.appliedThroughSeq = lastSeq !== undefined ? Math.max(lastSeq, maxSeq) : maxSeq;
  // Enforce the retention ceiling once, after the whole ring is projected, so a
  // large snapshot rebuild stays O(n) instead of re-splicing on every row.
  enforceRowRetention(model);
  return model;
}

export function buildAgentFeedItems(
  rows: AgentRow[],
  options: BuildAgentFeedItemsOptions = {}
): AgentFeedItem[] {
  const collapseAfterRows = options.collapseAfterRows ?? DEFAULT_TURN_COLLAPSE_ROW_THRESHOLD;
  if (rows.length < collapseAfterRows) {
    return rows.map((row, index) => rowFeedItem(row, index));
  }

  const keepRecentTurns = options.keepRecentTurns ?? DEFAULT_TURN_COLLAPSE_KEEP_RECENT_TURNS;
  const completedTurns = collectCompletedTurns(rows);
  const collapseThroughTurnIndex = completedTurns.length - keepRecentTurns;
  if (collapseThroughTurnIndex <= 0) {
    return rows.map((row, index) => rowFeedItem(row, index));
  }

  const items: AgentFeedItem[] = [];
  let nextTurn = 0;
  let index = 0;
  while (index < rows.length) {
    const turn = completedTurns[nextTurn];
    if (turn && index === turn.startIndex) {
      const shouldCollapse =
        nextTurn < collapseThroughTurnIndex && !options.expandedTurnIds?.has(turn.turnId);
      if (shouldCollapse) {
        items.push(turnSummaryItem(turn, rows));
      } else {
        for (let rowIndex = turn.startIndex; rowIndex <= turn.endIndex; rowIndex += 1) {
          items.push(rowFeedItem(rows[rowIndex], rowIndex));
        }
      }
      index = turn.endIndex + 1;
      nextTurn += 1;
      continue;
    }
    items.push(rowFeedItem(rows[index], index));
    index += 1;
  }
  return items;
}

/**
 * Apply one committed (or transient) event to the model in place. Idempotent on messageID
 * for assistant-message and tool events so a replay ring + a duplicate live event don't
 * double-render.
 */
export function applyEvent(model: RowModel, event: AgentSurfaceEvent): void {
  // Replay guard: a committed event with seq <= the applied watermark is a
  // reconnect-backfill duplicate — possibly of a row already pruned, which
  // id-only idempotency can no longer detect (it scans surviving rows). Skip it
  // so pruned rows aren't resurrected. (Transient deltas never reach applyEvent;
  // they're handled in the component before this call, so the watermark only ever
  // sees committed events with monotonic per-host seqs.)
  if (event.seq <= model.appliedThroughSeq) {
    return;
  }
  // Public boundary: apply the event, advance the watermark, then enforce the
  // retention ceiling once on the TOP-LEVEL model. Retention must not run inside
  // applyEventCore's child recursion — that operates on nested child sub-models
  // (parent.children), which are bounded by this top-level pass instead.
  applyEventCore(model, event);
  model.appliedThroughSeq = event.seq;
  enforceRowRetention(model);
}

function applyEventCore(model: RowModel, event: AgentSurfaceEvent): void {
  // Item 11: child-agent events nest under the spawning tool row. Attribution
  // is stripped before the recursive apply so the child sub-model uses the
  // exact same row logic (idempotency included). Orphans (parent pruned or
  // never seen) render flat with a 'subagent' author so they are never lost.
  if (
    event.parentToolUseId &&
    (event.kind === 'user-message' ||
      event.kind === 'assistant-message' ||
      event.kind === 'tool-start' ||
      event.kind === 'tool-end' ||
      event.kind === 'tool-output-delta')
  ) {
    const parent = model.rows.find((r) => r.kind === 'tool' && r.toolUseId === event.parentToolUseId);
    const stripped = { ...event };
    delete (stripped as { parentToolUseId?: string }).parentToolUseId;
    if (parent) {
      parent.children = parent.children ?? [];
      // Child sub-model: retention/watermark fields are unused here (children are
      // bounded by the top-level pass in enforceRowRetention), but the type needs them.
      const childModel: RowModel = {
        rows: parent.children,
        status: model.status,
        pendingPermission: null,
        prunedRowCount: 0,
        appliedThroughSeq: -1
      };
      applyEventCore(childModel, stripped as AgentSurfaceEvent);
      return;
    }
    const before = model.rows.length;
    applyEventCore(model, stripped as AgentSurfaceEvent);
    const added = model.rows.length > before ? model.rows[model.rows.length - 1] : undefined;
    if (added && added.kind !== 'tool') {
      added.authorLabel = 'subagent';
    }
    return;
  }
  switch (event.kind) {
    case 'session-info':
      return;
    case 'status':
      model.status = event.state;
      return;
    case 'user-message':
      if (!model.rows.some((r) => r.id === event.id)) {
        model.rows.push({
          kind: 'user-message',
          id: event.id,
          authorLabel: 'you',
          createdAt: event.ts,
          text: event.text,
          ...collapseMetadataForPayload('user-message', event.text)
        });
      }
      return;
    case 'assistant-delta':
      // MVP: deltas are accumulated in the component's pendingAssistant map; the model
      // commits them on assistant-message. Skip here.
      return;
    case 'assistant-message':
      if (event.markdown.trim() === '') {
        return; // BUG-3 sub-bug: skip empty-markdown assistant events (blank bubble)
      }
      if (!model.rows.some((r) => r.id === event.id)) {
        model.rows.push({
          kind: 'assistant-message',
          id: event.id,
          turnId: event.turnId,
          authorLabel: 'assistant',
          createdAt: event.ts,
          text: event.markdown
        });
      }
      return;
    case 'tool-start': {
      const toolRowId = `tool-${event.toolUseId}`;
      const existing = model.rows.find((r) => r.id === toolRowId);
      if (existing) {
        existing.toolStatus = 'running';
        existing.authorLabel = 'tool';
        existing.createdAt = existing.createdAt ?? event.ts;
        existing.updatedAt = undefined;
        existing.toolName = event.name;
        existing.text = event.summary;
        existing.toolDetail = event.detail;
        existing.toolResult = undefined;
        existing.toolState = toolStateForStart(existing.createdAt);
      } else {
        model.rows.push({
          kind: 'tool',
          id: toolRowId,
          toolUseId: event.toolUseId,
          toolName: event.name,
          authorLabel: 'tool',
          createdAt: event.ts,
          text: event.summary,
          toolStatus: 'running',
          toolState: toolStateForStart(event.ts),
          ...(event.detail ? { toolDetail: event.detail } : {})
        });
      }
      return;
    }
    case 'tool-output-delta': {
      const existing = model.rows.find((r) => r.id === `tool-${event.toolUseId}`);
      if (existing) {
        existing.toolResult = clampTail(`${existing.toolResult ?? ''}${event.text}`, MAX_TOOL_RESULT_CHARS);
      }
      return;
    }
    case 'tool-end': {
      const toolRowId = `tool-${event.toolUseId}`;
      const existing = model.rows.find((r) => r.id === toolRowId);
      if (existing) {
        existing.toolStatus = event.status;
        existing.authorLabel = 'tool';
        existing.createdAt = existing.createdAt ?? event.ts;
        existing.updatedAt = event.ts;
        existing.toolState = toolStateForEnd(event.status, existing.toolState?.startedAt ?? existing.createdAt, event.ts);
        const result = event.detail ?? event.summary ?? event.status;
        if (result.trim()) existing.toolResult = result;
      } else {
        const result = event.detail ?? event.summary ?? event.status;
        model.rows.push({
          kind: 'tool',
          id: toolRowId,
          toolUseId: event.toolUseId,
          authorLabel: 'tool',
          createdAt: event.ts,
          updatedAt: event.ts,
          text: event.summary ?? event.status,
          toolStatus: event.status,
          toolState: toolStateForEnd(event.status, event.ts, event.ts),
          ...(result.trim() ? { toolResult: result } : {})
        });
      }
      return;
    }
    case 'permission-request':
      model.pendingPermission = {
        requestId: event.requestId,
        variant: event.variant,
        title: event.title,
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.diff ? { diff: event.diff } : {}),
        options: event.options.map((o) => ({ id: o.id, label: o.label, treatment: o.treatment }))
      };
      return;
    case 'permission-resolved':
      if (model.pendingPermission?.requestId === event.requestId) {
        model.pendingPermission = null;
      }
      return;
    case 'turn-complete':
      if (!model.rows.some((r) => r.kind === 'turn-complete' && r.turnId === event.turnId)) {
        model.rows.push({
          kind: 'turn-complete',
          id: `tc-${event.turnId}`,
          turnId: event.turnId,
          authorLabel: 'system',
          createdAt: event.ts,
          text: ''
        });
      }
      return;
    case 'attention-hint': {
      // BUG-14 fix: attention-hint (esp. session-status from retry) MUST be visible.
      // Previously skipped → opencode retried provider errors silently → user saw nothing.
      const label = event.attention === 'session-status' ? 'status' : event.attention;
      const id = `hint-${event.seq}`;
      // Guard like the committed sibling kinds: a replay (rowsFromSnapshot) or a
      // live reconnect overlap must not create a duplicate row / React key.
      if (!model.rows.some((r) => r.id === id)) {
        const text = event.detail ? `${label}: ${event.detail}` : label;
        model.rows.push({
          kind: 'system',
          id,
          authorLabel: 'system',
          createdAt: event.ts,
          text,
          ...collapseMetadataForPayload('system', text)
        });
      }
      return;
    }
    case 'history-boundary':
      return;
    case 'agent-error': {
      const id = `err-${event.seq}`;
      if (!model.rows.some((r) => r.id === id)) {
        model.rows.push({ kind: 'system', id, authorLabel: 'system', createdAt: event.ts, text: event.message });
      }
      return;
    }
  }
}

function applyCommittedEvent(model: RowModel, event: AgentSurfaceEvent): void {
  // Core only: retention is enforced once by the caller after the full snapshot
  // loop, so the projection stays linear.
  applyEventCore(model, event);
}

interface CompletedTurnSpan {
  turnId: string;
  startIndex: number;
  endIndex: number;
}

function rowFeedItem(row: AgentRow, rowIndex: number): AgentFeedItem {
  return {
    kind: 'row',
    id: row.id,
    row,
    rowIndex,
    firstRowIndex: rowIndex,
    lastRowIndex: rowIndex
  };
}

/** Total rows including all nested child (subagent) rows. */
function countRows(rows: AgentRow[]): number {
  let total = 0;
  for (const row of rows) {
    total += 1;
    if (row.children) {
      total += countRows(row.children);
    }
  }
  return total;
}

/**
 * Bound the model's row history in place — top-level AND nested child rows — to
 * maxRows. Eviction is layered from most to least coherent:
 *  1. Evict WHOLE completed turns from the oldest end (turn spans/summaries stay
 *     coherent), dropping the minimum span that reaches the cap.
 *  2. Hard fallback: if a single oversized ACTIVE turn (or a run with no completed
 *     turn) still exceeds the cap, coherence yields to the ceiling — drop oldest
 *     top-level rows (subtree included) until under cap or one row remains.
 *  3. If that one row's own children still blow the cap, drop its oldest children.
 * Every top-level row dropped is added to prunedRowCount so position-keyed
 * unread/anchor logic can offset past it.
 */
export function enforceRowRetention(model: RowModel, maxRows: number = DEFAULT_MAX_RETAINED_ROWS): void {
  const sizeOf = (row: AgentRow): number => 1 + (row.children ? countRows(row.children) : 0);
  let total = countRows(model.rows);
  if (total <= maxRows) {
    return;
  }

  // Phase 1 — whole completed turns. A running prefix sum keeps this O(n).
  const turns = collectCompletedTurns(model.rows);
  let acc = 0; // cumulative size of rows[0..cursor-1]
  let cursor = 0;
  let dropTo = 0; // top-level index to splice up to (exclusive)
  for (const turn of turns) {
    while (cursor <= turn.endIndex) {
      acc += sizeOf(model.rows[cursor]);
      cursor += 1;
    }
    dropTo = turn.endIndex + 1;
    if (total - acc <= maxRows) {
      break;
    }
  }
  if (dropTo > 0) {
    model.rows.splice(0, dropTo);
    model.prunedRowCount += dropTo;
    total -= acc;
  }
  if (total <= maxRows) {
    return;
  }

  // Phase 2 — hard fallback: oldest top-level rows (subtree included).
  while (total > maxRows && model.rows.length > 1) {
    const [gone] = model.rows.splice(0, 1);
    model.prunedRowCount += 1;
    total -= sizeOf(gone);
  }
  if (total <= maxRows) {
    return;
  }

  // Phase 3 — one top-level row whose children alone exceed the cap.
  const only = model.rows[0];
  if (only?.children) {
    while (total > maxRows && only.children.length > 0) {
      const [gone] = only.children.splice(0, 1);
      total -= sizeOf(gone);
    }
  }
}

function collectCompletedTurns(rows: AgentRow[]): CompletedTurnSpan[] {
  const turns: CompletedTurnSpan[] = [];
  let startIndex = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === 'turn-complete' && row.turnId) {
      turns.push({ turnId: row.turnId, startIndex, endIndex: index });
      startIndex = index + 1;
    }
  }
  return turns;
}

function turnSummaryItem(turn: CompletedTurnSpan, rows: AgentRow[]): AgentFeedItem {
  const turnRows = rows.slice(turn.startIndex, turn.endIndex + 1);
  return {
    kind: 'turn-summary',
    id: `turn-summary-${turn.turnId}`,
    turnId: turn.turnId,
    rows: turnRows,
    firstRowIndex: turn.startIndex,
    lastRowIndex: turn.endIndex,
    rowCount: turnRows.length,
    toolCount: turnRows.filter((row) => row.kind === 'tool').length,
    assistantCount: turnRows.filter((row) => row.kind === 'assistant-message').length,
    preview: turnPreview(turnRows)
  };
}

function turnPreview(rows: AgentRow[]): string {
  const row = rows.find((candidate) => candidate.kind === 'user-message' && candidate.text.trim())
    ?? rows.find((candidate) => candidate.kind === 'assistant-message' && candidate.text.trim())
    ?? rows.find((candidate) => candidate.text.trim());
  return row ? previewText(row.text) : 'completed turn';
}

function collapseMetadataForPayload(
  kind: AgentRow['kind'],
  text: string
): { collapse?: RowCollapse } {
  if (kind !== 'user-message' && kind !== 'system') {
    return {};
  }
  const reason = collapseReasonForPayload(text);
  if (!reason) {
    return {};
  }
  return {
    collapse: {
      defaultCollapsed: true,
      reason,
      preview: previewText(text)
    }
  };
}

function collapseReasonForPayload(text: string): RowCollapse['reason'] | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (
    normalized.includes('You have been added to the desk channel') &&
    normalized.includes('This is a multi-agent collaboration room')
  ) {
    return 'channel-onboarding';
  }
  if (normalized.length >= 900) {
    return 'long-payload';
  }
  return null;
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 156) {
    return normalized;
  }
  return `${normalized.slice(0, 153).trimEnd()}...`;
}

function toolStateForStart(startedAt: string): ToolStateDisplay {
  return {
    label: 'Running',
    tone: 'running',
    active: true,
    startedAt
  };
}

function toolStateForEnd(
  status: ToolTerminalStatus,
  startedAt: string,
  finishedAt: string
): ToolStateDisplay {
  const durationMs = durationBetween(startedAt, finishedAt);
  return {
    label: toolStateLabel(status),
    tone: status,
    active: false,
    startedAt,
    finishedAt,
    ...(durationMs !== null ? { durationMs } : {})
  };
}

function toolStateLabel(status: ToolTerminalStatus): ToolStateDisplay['label'] {
  switch (status) {
    case 'ok':
      return 'Done';
    case 'error':
      return 'Failed';
    case 'denied':
      return 'Denied';
  }
}

function durationBetween(startedAt: string, finishedAt: string): number | null {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}
