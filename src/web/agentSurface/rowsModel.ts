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
  toolUseId?: string;
  toolStatus?: 'ok' | 'error' | 'denied';
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
}

export function initialRowModel(): RowModel {
  return { rows: [], status: 'starting', pendingPermission: null };
}

/**
 * Build a RowModel from a snapshot ring (committed events). The broker already filters
 * transients out of the ring, so we don't expect deltas here; status / commit / tool /
 * permission / turn-complete / system rows are projected in chronological order.
 */
export function rowsFromSnapshot(events: AgentSurfaceEvent[]): RowModel {
  const model = initialRowModel();
  for (const event of events) {
    applyCommittedEvent(model, event);
  }
  return model;
}

/**
 * Apply one committed (or transient) event to the model in place. Idempotent on messageID
 * for assistant-message and tool events so a replay ring + a duplicate live event don't
 * double-render.
 */
export function applyEvent(model: RowModel, event: AgentSurfaceEvent): void {
  switch (event.kind) {
    case 'session-info':
      return;
    case 'status':
      model.status = event.state;
      return;
    case 'user-message':
      if (!model.rows.some((r) => r.id === event.id)) {
        model.rows.push({ kind: 'user-message', id: event.id, text: event.text });
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
        model.rows.push({ kind: 'assistant-message', id: event.id, turnId: event.turnId, text: event.markdown });
      }
      return;
    case 'tool-start':
      model.rows.push({ kind: 'tool', id: `tool-${event.toolUseId}-start`, toolUseId: event.toolUseId, text: event.summary });
      return;
    case 'tool-output-delta':
      return;
    case 'tool-end':
      model.rows.push({
        kind: 'tool',
        id: `tool-${event.toolUseId}-end`,
        toolUseId: event.toolUseId,
        toolStatus: event.status,
        text: event.summary ?? event.status
      });
      return;
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
      model.rows.push({ kind: 'turn-complete', id: `tc-${event.turnId}-${event.seq}`, turnId: event.turnId, text: '' });
      return;
    case 'attention-hint':
      return;
    case 'history-boundary':
      return;
    case 'agent-error':
      model.rows.push({ kind: 'system', id: `err-${event.seq}`, text: event.message });
      return;
  }
}

function applyCommittedEvent(model: RowModel, event: AgentSurfaceEvent): void {
  applyEvent(model, event);
}
