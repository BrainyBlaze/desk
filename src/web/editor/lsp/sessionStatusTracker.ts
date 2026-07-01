/**
 * Editor-side reducer that folds a session's read-only lifecycle status frames and sanitized
 * `$/progress` notifications into a single {@link LspSessionStatus} for the status bar. Pure and
 * connection-agnostic: it is fed by `attachSessionStatus` over a real LspConnection, but unit tests
 * drive the accept* methods directly. It never reaches the backend and holds no command surface.
 */

import type { LspExit, LspLifecycleStatus } from './connection.js';
import type { LspProgress, LspSessionStatus } from './statusSegment.js';

export interface SessionStatusTracker {
  /** Fold a `type:'status'` lifecycle frame. */
  acceptStatus(status: LspLifecycleStatus): void;
  /** Fold a sanitized `$/progress` notification ({ token, value:{ kind, title?, message?, percentage? } }). */
  acceptProgress(params: unknown): void;
  /** Fold a connection exit; only a restart-annotated exit (restart supervisor) changes the phase. */
  acceptExit(exit: LspExit): void;
  /** The latest folded status, or null before the first lifecycle frame. */
  current(): LspSessionStatus | null;
}

/** Phases for which an active progress overlay is meaningful; others drop stale progress. */
const PROGRESS_PHASES = new Set(['warming', 'ready']);

interface ProgressValue {
  kind?: string;
  title?: string;
  message?: string;
  percentage?: number;
}

function readProgressValue(params: unknown): ProgressValue | null {
  if (typeof params !== 'object' || params === null) {
    return null;
  }
  const value = (params as { value?: unknown }).value;
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as ProgressValue;
}

export function createSessionStatusTracker(opts: {
  languageId: string;
  serverName?: string;
  onChange: (status: LspSessionStatus) => void;
}): SessionStatusTracker {
  let phase: LspSessionStatus['phase'] | null = null;
  let serverName: string | undefined = opts.serverName;
  let reason: string | undefined;
  let progress: LspProgress | undefined;

  const snapshot = (): LspSessionStatus | null => {
    if (phase === null) {
      return null;
    }
    const status: LspSessionStatus = { languageId: opts.languageId, phase };
    if (serverName !== undefined) {
      status.serverName = serverName;
    }
    if (reason !== undefined) {
      status.reason = reason;
    }
    if (progress !== undefined) {
      status.progress = progress;
    }
    return status;
  };

  const emit = (): void => {
    const next = snapshot();
    if (next) {
      opts.onChange(next);
    }
  };

  return {
    acceptStatus(status: LspLifecycleStatus): void {
      phase = status.state;
      // serverConfigId is the trusted server identity; an explicit serverName from opts still wins.
      serverName = opts.serverName ?? status.serverConfigId;
      reason = status.reason;
      // A degraded/restarting/stopped session must not keep showing healthy indexing progress.
      if (!PROGRESS_PHASES.has(status.state)) {
        progress = undefined;
      }
      emit();
    },

    acceptProgress(params: unknown): void {
      const value = readProgressValue(params);
      if (!value) {
        return;
      }
      if (value.kind === 'end') {
        if (progress === undefined) {
          return;
        }
        progress = undefined;
      } else if (value.kind === 'begin') {
        const next: LspProgress = {};
        if (typeof value.title === 'string') {
          next.title = value.title;
        }
        if (typeof value.message === 'string') {
          next.message = value.message;
        }
        if (typeof value.percentage === 'number') {
          next.percentage = value.percentage;
        }
        progress = next;
      } else {
        // report: merge onto the active overlay, keeping the begin title when none is provided.
        const next: LspProgress = { ...(progress ?? {}) };
        if (typeof value.title === 'string') {
          next.title = value.title;
        }
        if (typeof value.message === 'string') {
          next.message = value.message;
        }
        if (typeof value.percentage === 'number') {
          next.percentage = value.percentage;
        }
        progress = next;
      }
      emit();
    },

    acceptExit(exit: LspExit): void {
      // Only a bounded-restart annotation changes what we show; a plain close leaves the last phase
      // (the editor binding tears the session down and the store entry is cleared on close).
      if (!exit.restart) {
        return;
      }
      phase = exit.restart.state;
      progress = undefined;
      emit();
    },

    current(): LspSessionStatus | null {
      return snapshot();
    }
  };
}
