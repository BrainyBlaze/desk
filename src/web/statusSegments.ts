import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { GitStatusEntry } from './git/gitClient.js';

/**
 * One cell of the bottom status bar. Segments with onClick render as buttons
 * (copy a path, jump to a subsystem); the rest are read-only telemetry.
 */
export interface StatusSegment {
  key: string;
  text: string;
  icon?: ReactNode;
  /** hover tooltip; defaults to text */
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger' | 'accent';
  onClick?: () => void;
}

/* ---------- per-subsystem segment store ----------
 * Subsystems stay hidden-mounted, so each keeps publishing its own context;
 * the bar renders only the active scope. A module-level store (same idiom as
 * sidebarPanel's drag flag) avoids threading callbacks through five
 * component trees. */

const scopeSegments = new Map<string, StatusSegment[]>();
const listeners = new Set<() => void>();
const EMPTY: StatusSegment[] = [];

function segmentsEqual(a: StatusSegment[], b: StatusSegment[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (seg, i) =>
        seg.key === b[i].key &&
        seg.text === b[i].text &&
        seg.tone === b[i].tone &&
        seg.hint === b[i].hint &&
        seg.icon === b[i].icon &&
        seg.onClick === b[i].onClick
    )
  );
}

/** Replace a scope's segments; no-op (no re-render) when nothing changed. */
export function publishStatus(scope: string, segments: StatusSegment[]): void {
  const previous = scopeSegments.get(scope) ?? EMPTY;
  if (segmentsEqual(previous, segments)) {
    return;
  }
  scopeSegments.set(scope, segments);
  for (const listener of listeners) {
    listener();
  }
}

export function getStatusSegments(scope: string): StatusSegment[] {
  return scopeSegments.get(scope) ?? EMPTY;
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStatusSegments(scope: string): StatusSegment[] {
  return useSyncExternalStore(subscribeStatus, () => getStatusSegments(scope));
}

/* ---------- pure helpers (unit-tested) ---------- */

export interface GitStatusCounts {
  staged: number;
  changed: number;
  conflicted: number;
}

/** Mirror of the changes panel's bucketing: conflicts trump everything;
 * untracked and worktree edits are "changed"; an entry can be both staged
 * and changed (partial stage). */
export function gitStatusCounts(entries: GitStatusEntry[]): GitStatusCounts {
  const counts: GitStatusCounts = { staged: 0, changed: 0, conflicted: 0 };
  for (const entry of entries) {
    if (entry.conflicted) {
      counts.conflicted += 1;
      continue;
    }
    if (!entry.untracked && entry.index !== ' ' && entry.index !== '?') {
      counts.staged += 1;
    }
    if (entry.untracked || (entry.worktree !== ' ' && entry.worktree !== '?')) {
      counts.changed += 1;
    }
  }
  return counts;
}

/** "↑2 ↓1" sync arrows; empty string when in sync or unknown. */
export function formatAheadBehind(ahead: number | undefined, behind: number | undefined): string {
  const parts: string[] = [];
  if (ahead && ahead > 0) {
    parts.push(`↑${ahead}`);
  }
  if (behind && behind > 0) {
    parts.push(`↓${behind}`);
  }
  return parts.join(' ');
}

/** HH:MM, 24h, locale-stable for the status clock. */
export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Editor save summary: dirty count wins over the calm "saved" state. */
export function formatSaveState(dirtyCount: number): { text: string; tone: 'ok' | 'warn' } {
  return dirtyCount > 0 ? { text: `● ${dirtyCount} unsaved`, tone: 'warn' } : { text: 'saved', tone: 'ok' };
}

/** Path shown relative to the explorer root; absolute paths outside it stay absolute. */
export function relativeToRootPath(path: string, root: string | null): string {
  if (root && path.startsWith(root.endsWith('/') ? root : `${root}/`)) {
    return path.slice((root.endsWith('/') ? root : `${root}/`).length);
  }
  return path;
}
