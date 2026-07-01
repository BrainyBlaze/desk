/**
 * Git types shared between the server (gitParse/gitApi) and the web client
 * (gitClient, editor decorations). Single source of truth — both sides
 * re-export from here so existing import sites keep working.
 */

export interface GitBranchInfo {
  /** current branch name; null while detached */
  branch: string | null;
  /** HEAD oid; null before the first commit */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
}

export interface GitStatusEntry {
  /** path relative to the repo root (rename target for renames) */
  path: string;
  /** rename/copy source path */
  origPath?: string;
  /** index (staged) state letter, '.' = unchanged */
  index: string;
  /** worktree state letter, '.' = unchanged */
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branchInfo: GitBranchInfo;
  entries: GitStatusEntry[];
}

export interface GitRepoSummary {
  path: string;
  name: string;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  changes: number;
  upstream: string | null;
}

/** One repo's slice of a status-map response (explorer tree decorations). */
export interface GitStatusMapRepo {
  /** absolute repo root */
  root: string;
  branch: GitBranchInfo;
  entries: GitStatusEntry[];
}

/**
 * One gutter hunk in NEW-file line coordinates (from `git diff -U0`).
 * 'deleted' hunks carry the line AFTER which content was removed (0 = before
 * the first line) and count 0.
 */
export interface GitLineDiffHunk {
  kind: 'added' | 'modified' | 'deleted';
  start: number;
  count: number;
}

export interface GitLineDiffResult {
  /** untracked files have no diff base — the whole file is "added" */
  untracked: boolean;
  hunks: GitLineDiffHunk[];
}
