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
  collapse?: RowCollapse;
  toolUseId?: string;
  toolName?: string;
  toolStatus?: 'ok' | 'error' | 'denied' | 'running';
  toolDetail?: string;
  toolResult?: string;
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
}

export function initialRowModel(): RowModel {
  return { rows: [], status: 'starting', pendingPermission: null };
}

/**
 * Build a RowModel from a snapshot ring (committed events). The broker already filters
 * transients out of the ring, so we don't expect deltas here; status / commit / tool /
 * permission / turn-complete / system rows are projected in chronological order.
 */
export function rowsFromSnapshot(events: AgentSurfaceEvent[], state: AgentSurfaceState = 'starting'): RowModel {
  const model = initialRowModel();
  model.status = state;
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
        model.rows.push({
          kind: 'user-message',
          id: event.id,
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
        model.rows.push({ kind: 'assistant-message', id: event.id, turnId: event.turnId, text: event.markdown });
      }
      return;
    case 'tool-start': {
      const toolRowId = `tool-${event.toolUseId}`;
      const existing = model.rows.find((r) => r.id === toolRowId);
      if (existing) {
        existing.toolStatus = 'running';
        existing.toolName = event.name;
        existing.text = event.summary;
        existing.toolDetail = event.detail;
        existing.toolResult = undefined;
      } else {
        model.rows.push({
          kind: 'tool',
          id: toolRowId,
          toolUseId: event.toolUseId,
          toolName: event.name,
          text: event.summary,
          toolStatus: 'running',
          ...(event.detail ? { toolDetail: event.detail } : {})
        });
      }
      return;
    }
    case 'tool-output-delta': {
      const existing = model.rows.find((r) => r.id === `tool-${event.toolUseId}`);
      if (existing) {
        existing.toolResult = `${existing.toolResult ?? ''}${event.text}`;
      }
      return;
    }
    case 'tool-end': {
      const toolRowId = `tool-${event.toolUseId}`;
      const existing = model.rows.find((r) => r.id === toolRowId);
      if (existing) {
        existing.toolStatus = event.status;
        const result = event.detail ?? event.summary ?? event.status;
        if (result.trim()) existing.toolResult = result;
      } else {
        const result = event.detail ?? event.summary ?? event.status;
        model.rows.push({
          kind: 'tool',
          id: toolRowId,
          toolUseId: event.toolUseId,
          text: event.summary ?? event.status,
          toolStatus: event.status,
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
        model.rows.push({ kind: 'turn-complete', id: `tc-${event.turnId}`, turnId: event.turnId, text: '' });
      }
      return;
    case 'attention-hint': {
      // BUG-14 fix: attention-hint (esp. session-status from retry) MUST be visible.
      // Previously skipped → opencode retried provider errors silently → user saw nothing.
      const label = event.attention === 'session-status' ? 'status' : event.attention;
      model.rows.push({
        kind: 'system',
        id: `hint-${event.seq}`,
        text: event.detail ? `${label}: ${event.detail}` : label,
        ...collapseMetadataForPayload('system', event.detail ? `${label}: ${event.detail}` : label)
      });
      return;
    }
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
