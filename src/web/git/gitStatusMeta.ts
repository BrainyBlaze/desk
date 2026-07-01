import type { GitStatusEntry } from './gitClient.js';

/** VSCode-style single-letter badge + tone class for a change row. */
export interface StatusBadge {
  letter: string;
  tone: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
}

const LETTER_TONES: Record<string, StatusBadge['tone']> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed'
};

export function statusBadge(entry: GitStatusEntry, group: 'staged' | 'changes' | 'merge'): StatusBadge {
  if (group === 'merge') {
    return { letter: '!', tone: 'conflict' };
  }
  if (entry.untracked) {
    return { letter: 'U', tone: 'untracked' };
  }
  const letter = group === 'staged' ? entry.index : entry.worktree;
  return { letter, tone: LETTER_TONES[letter] ?? 'modified' };
}

export function commitFileBadge(status: string): StatusBadge {
  return { letter: status, tone: LETTER_TONES[status] ?? 'modified' };
}

export interface ChangeGroups {
  merge: GitStatusEntry[];
  staged: GitStatusEntry[];
  changes: GitStatusEntry[];
}

/** Split status entries into the VSCode groups (merge / staged / changes). */
export function groupChanges(entries: GitStatusEntry[]): ChangeGroups {
  const merge: GitStatusEntry[] = [];
  const staged: GitStatusEntry[] = [];
  const changes: GitStatusEntry[] = [];
  for (const entry of entries) {
    if (entry.conflicted) {
      merge.push(entry);
      continue;
    }
    if (entry.index !== '.' && !entry.untracked) {
      staged.push(entry);
    }
    if (entry.worktree !== '.' || entry.untracked) {
      changes.push(entry);
    }
  }
  return { merge, staged, changes };
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Short human time distance for history rows ("3h", "2d", "Jan 4"). */
export function shortTimeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  if (seconds < 14 * 86_400) {
    return `${Math.floor(seconds / 86_400)}d`;
  }
  const date = new Date(then);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
