/**
 * Pure builder turning /api/git/status-map payloads into explorer tree
 * decorations: per-file badges, changed-ancestor dirs, and repo-root chips.
 * Kept free of React/fetch so it unit-tests like editorState/gitStatusMeta.
 */
import type { GitStatusEntry, GitStatusMapRepo } from '../../shared/git.js';
import { statusBadge, type StatusBadge } from '../git/gitStatusMeta.js';

export interface RepoChipInfo {
  root: string;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  changes: number;
}

export interface TreeGitModel {
  /** absolute file path → status badge (worktree state wins over index) */
  badges: Map<string, StatusBadge>;
  /** absolute file path → raw porcelain entry (menu action availability) */
  entries: Map<string, GitStatusEntry>;
  /** absolute dir paths with at least one change underneath */
  changedDirs: Set<string>;
  /** absolute repo root → branch chip */
  repoChips: Map<string, RepoChipInfo>;
  /** repo roots, longest first (for owning-repo lookups) */
  repoRoots: string[];
}

export const EMPTY_TREE_GIT_MODEL: TreeGitModel = {
  badges: new Map(),
  entries: new Map(),
  changedDirs: new Set(),
  repoChips: new Map(),
  repoRoots: []
};

function badgeFor(entry: GitStatusEntry): StatusBadge {
  if (entry.conflicted) {
    return statusBadge(entry, 'merge');
  }
  // The worktree letter is what the user sees on disk; fall back to the
  // staged letter for fully-staged files.
  if (entry.untracked || entry.worktree !== '.') {
    return statusBadge(entry, 'changes');
  }
  return statusBadge(entry, 'staged');
}

export function buildTreeGitModel(repos: GitStatusMapRepo[], explorerRoot: string): TreeGitModel {
  const badges = new Map<string, StatusBadge>();
  const entries = new Map<string, GitStatusEntry>();
  const changedDirs = new Set<string>();
  const repoChips = new Map<string, RepoChipInfo>();
  const rootPrefix = explorerRoot.endsWith('/') ? explorerRoot : `${explorerRoot}/`;
  for (const repo of repos) {
    repoChips.set(repo.root, {
      root: repo.root,
      branch: repo.branch.branch,
      detached: repo.branch.detached,
      ahead: repo.branch.ahead,
      behind: repo.branch.behind,
      changes: repo.entries.length
    });
    for (const entry of repo.entries) {
      const absolute = `${repo.root}/${entry.path}`;
      badges.set(absolute, badgeFor(entry));
      entries.set(absolute, entry);
      // Propagate a "contains changes" dot up to (excluding) the explorer root.
      let dir = absolute.slice(0, absolute.lastIndexOf('/'));
      while (dir !== explorerRoot && dir.startsWith(rootPrefix)) {
        changedDirs.add(dir);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    }
  }
  const repoRoots = [...repoChips.keys()].sort((a, b) => b.length - a.length);
  return { badges, entries, changedDirs, repoChips, repoRoots };
}

/** Longest repo root that owns the path (the path itself counts). */
export function owningRepoOf(path: string, repoRoots: string[]): string | null {
  for (const root of repoRoots) {
    if (path === root || path.startsWith(`${root}/`)) {
      return root;
    }
  }
  return null;
}

/** Repo-relative form of an absolute path. */
export function repoRelative(path: string, repoRoot: string): string {
  return path === repoRoot ? '.' : path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}

/**
 * Shorten a branch name for the tree chip, keeping BOTH ends — the prefix
 * carries the kind (feat/fix) and the tail is the distinctive part
 * ("feat/m48-constrained-qwen-realizer" → "feat/m48…n-realizer"). The full
 * name stays in the row tooltip.
 */
export function shortenBranch(branch: string, max = 21): string {
  if (branch.length <= max) {
    return branch;
  }
  const head = Math.max(4, Math.floor((max - 1) * 0.4));
  const tail = max - 1 - head;
  if (tail <= 0) {
    // Tiny max: `slice(-0)` would splice the whole branch back. Reserve the last slot for
    // the ellipsis; a non-positive max has no room even for that.
    if (max <= 0) {
      return '';
    }
    return `${branch.slice(0, max - 1)}…`;
  }
  return `${branch.slice(0, head)}…${branch.slice(-tail)}`;
}
