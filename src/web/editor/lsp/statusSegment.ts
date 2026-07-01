import type { StatusSegment } from '../../statusSegments.js';

/**
 * Read-only consumer-side model of an editor LSP session's lifecycle, surfaced
 * to the status bar from read-only websocket status envelopes, plus a
 * separate sanitized `$/progress` overlay (token/value details only). This module is
 * pure display logic; decoding the real websocket envelope into this shape is a thin
 * adapter wired once the backend signal lands.
 */
export type LspLifecycleState = 'warming' | 'ready' | 'degraded' | 'restarting' | 'stopped';

/** Sanitized `$/progress` snapshot for an active indexing-style operation. */
export interface LspProgress {
  /** 0-100 when the server reports it; absent for indeterminate progress. */
  percentage?: number;
  /** `$/progress` begin title, e.g. "rust-analyzer indexing". */
  title?: string;
  /** Latest `$/progress` report message, e.g. "crate 1/8". */
  message?: string;
}

export interface LspSessionStatus {
  languageId: string;
  serverName?: string;
  phase: LspLifecycleState;
  /** Present only while a `$/progress` operation is active; cleared on its `end`. */
  progress?: LspProgress;
  /** Why a session is degraded or stopped (shown in the hint). */
  reason?: string;
}

const PROGRESS_OVERLAY_PHASES: ReadonlySet<LspLifecycleState> = new Set<LspLifecycleState>(['warming', 'ready']);

function clampPercent(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function serverContext(status: LspSessionStatus): string {
  return status.serverName ? `${status.languageId} - ${status.serverName}` : status.languageId;
}

/**
 * Map an LSP session status to its bottom-status-bar segment, or null when there is
 * no session to report. Active progress overlays the calm lifecycle phases (warming/
 * ready) as an "indexing" view; a degraded/restarting/stopped phase always wins over a
 * stale progress payload so an unhealthy session can never masquerade as healthy.
 */
export function lspStatusSegment(status: LspSessionStatus | null | undefined): StatusSegment | null {
  if (!status) {
    return null;
  }

  if (status.progress && PROGRESS_OVERLAY_PHASES.has(status.phase)) {
    const { percentage, title, message } = status.progress;
    const label = title?.trim() || 'indexing';
    const pct = percentage != null ? ` ${Math.round(clampPercent(percentage))}%` : '';
    return {
      key: 'lsp',
      text: `LSP: ${label}${pct}`,
      tone: 'accent',
      hint: message?.trim() || `${serverContext(status)} indexing`
    };
  }

  switch (status.phase) {
    case 'warming':
      return { key: 'lsp', text: 'LSP: warming', tone: 'accent', hint: `${serverContext(status)} starting` };
    case 'ready':
      return { key: 'lsp', text: 'LSP: ready', hint: serverContext(status) };
    case 'degraded':
      return {
        key: 'lsp',
        text: 'LSP: degraded',
        tone: 'warn',
        hint: status.reason?.trim() || `${serverContext(status)} unavailable - using built-in features`
      };
    case 'restarting':
      return { key: 'lsp', text: 'LSP: restarting', tone: 'warn', hint: `${serverContext(status)} restarting` };
    case 'stopped':
      return {
        key: 'lsp',
        text: 'LSP: stopped',
        tone: 'danger',
        hint: status.reason?.trim() || `${serverContext(status)} stopped`
      };
    default: {
      // Exhaustiveness guard: a new phase must be handled explicitly.
      const _never: never = status.phase;
      return _never;
    }
  }
}
