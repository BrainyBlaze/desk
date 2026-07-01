/** Client for /api/git/* — same readJson conventions as fsClient. */

import type { GitLineDiffResult, GitStatusMapRepo } from '../../shared/git.js';

export type {
  GitBranchInfo,
  GitLineDiffHunk,
  GitLineDiffResult,
  GitRepoSummary,
  GitStatus,
  GitStatusEntry,
  GitStatusMapRepo
} from '../../shared/git.js';
import type { GitRepoSummary, GitStatus } from '../../shared/git.js';

export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface GitRef {
  name: string;
  kind: GitRefKind;
}

export interface GitLogCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: GitRef[];
}

export interface GitCommitFile {
  path: string;
  origPath?: string;
  status: string;
}

export interface GitCommitDetail {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  files: GitCommitFile[];
}

export type GitDiffMode = 'worktree' | 'index' | 'commit' | 'range';

export type GitDiffResult =
  | { ok: true; original: string; modified: string }
  | { ok: false; reason: 'binary' | 'too-large' };

export interface GitHubInfo {
  available: boolean;
  reason?: string;
  nameWithOwner?: string;
  description?: string;
  url?: string;
  isPrivate?: boolean;
  stargazerCount?: number;
  defaultBranch?: string;
  pullRequest?: { number: number; title: string; url: string; state: string; isDraft: boolean } | null;
}

export type GitSyncOp = 'fetch' | 'pull' | 'push' | 'publish';

async function readJson<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `request failed (${response.status})`);
  }
  return payload;
}

const enc = encodeURIComponent;

export async function gitRepos(root: string): Promise<GitRepoSummary[]> {
  const payload = await readJson<{ repos: GitRepoSummary[] }>(fetch(`/api/git/repos?root=${enc(root)}`));
  return payload.repos;
}

export async function gitStatus(root: string, repo: string): Promise<GitStatus> {
  return readJson(fetch(`/api/git/status?root=${enc(root)}&repo=${enc(repo)}`));
}

export async function gitLog(
  root: string,
  repo: string,
  limit: number,
  skip: number,
  /** repo-relative path: per-file history (--follow, HEAD lineage only) */
  path?: string
): Promise<{ commits: GitLogCommit[]; hasMore: boolean }> {
  const extra = path ? `&path=${enc(path)}` : '';
  return readJson(fetch(`/api/git/log?root=${enc(root)}&repo=${enc(repo)}&limit=${limit}&skip=${skip}${extra}`));
}

/** Status for every repo owning one of `paths` — explorer tree decorations. */
export async function gitStatusMap(root: string, paths: string[]): Promise<GitStatusMapRepo[]> {
  const payload = await readJson<{ repos: GitStatusMapRepo[] }>(
    fetch('/api/git/status-map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, paths })
    })
  );
  return payload.repos;
}

/** Gutter hunks for one file (worktree+index vs HEAD). */
export async function gitLineDiff(root: string, repo: string, path: string): Promise<GitLineDiffResult> {
  return readJson(fetch(`/api/git/line-diff?root=${enc(root)}&repo=${enc(repo)}&path=${enc(path)}`));
}

export async function gitCommitDetail(root: string, repo: string, sha: string): Promise<GitCommitDetail> {
  return readJson(fetch(`/api/git/commit?root=${enc(root)}&repo=${enc(repo)}&sha=${enc(sha)}`));
}

export async function gitDiff(
  root: string,
  repo: string,
  path: string,
  mode: GitDiffMode,
  sha?: string,
  origPath?: string,
  /** range mode: merge-base sha (left side) and branch ref (right side) */
  range?: { base: string; ref: string }
): Promise<GitDiffResult> {
  const extra =
    (sha ? `&sha=${enc(sha)}` : '') +
    (origPath ? `&origPath=${enc(origPath)}` : '') +
    (range ? `&base=${enc(range.base)}&ref=${enc(range.ref)}` : '');
  return readJson(
    fetch(`/api/git/diff?root=${enc(root)}&repo=${enc(repo)}&path=${enc(path)}&mode=${mode}${extra}`)
  );
}

export interface GitBranchDiff {
  baseSha: string;
  refSha: string;
  files: GitCommitFile[];
}

/** Files a branch changes vs merge-base(HEAD, ref) — view without checkout. */
export async function gitBranchDiff(root: string, repo: string, ref: string): Promise<GitBranchDiff> {
  return readJson(fetch(`/api/git/branch-diff?root=${enc(root)}&repo=${enc(repo)}&ref=${enc(ref)}`));
}

export async function gitGitHubInfo(root: string, repo: string): Promise<GitHubInfo> {
  return readJson(fetch(`/api/git/github?root=${enc(root)}&repo=${enc(repo)}`));
}

export async function gitBrowseUrl(
  root: string,
  repo: string,
  target: { sha?: string; path?: string } = {}
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const extra = (target.sha ? `&sha=${enc(target.sha)}` : '') + (target.path ? `&path=${enc(target.path)}` : '');
  return readJson(fetch(`/api/git/browse?root=${enc(root)}&repo=${enc(repo)}${extra}`));
}

function post<T>(pathname: string, payload: Record<string, unknown>): Promise<T> {
  return readJson(
    fetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export const gitStage = (root: string, repo: string, paths: string[]): Promise<GitStatus> =>
  post('/api/git/stage', { root, repo, paths });

export const gitUnstage = (root: string, repo: string, paths: string[]): Promise<GitStatus> =>
  post('/api/git/unstage', { root, repo, paths });

export const gitDiscard = (root: string, repo: string, tracked: string[], untracked: string[]): Promise<GitStatus> =>
  post('/api/git/discard', { root, repo, tracked, untracked });

export const gitCommit = (
  root: string,
  repo: string,
  message: string,
  options: { amend?: boolean; all?: boolean } = {}
): Promise<GitStatus> => post('/api/git/commit', { root, repo, message, ...options });

export const gitSync = (root: string, repo: string, op: GitSyncOp): Promise<GitStatus> =>
  post('/api/git/sync', { root, repo, op });

export const gitCheckout = (root: string, repo: string, ref: string): Promise<GitStatus> =>
  post('/api/git/checkout', { root, repo, ref });

export const gitCreateBranch = (root: string, repo: string, name: string, sha: string): Promise<GitStatus> =>
  post('/api/git/branch', { root, repo, name, sha });

export const gitRevert = (root: string, repo: string, sha: string): Promise<GitStatus> =>
  post('/api/git/revert', { root, repo, sha });

export interface GitBranchRef {
  name: string;
  sha: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  date: string;
  subject: string;
}

export interface GitWorktree {
  path: string;
  sha: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
}

export interface GitBranchesInfo {
  branches: GitBranchRef[];
  worktrees: GitWorktree[];
}

export async function gitBranches(root: string, repo: string): Promise<GitBranchesInfo> {
  return readJson(fetch(`/api/git/branches?root=${enc(root)}&repo=${enc(repo)}`));
}

export const gitDeleteBranch = (root: string, repo: string, name: string, force = false): Promise<{ ok: boolean }> =>
  post('/api/git/branch-delete', { root, repo, name, force });

export const gitRemoveWorktree = (root: string, repo: string, path: string): Promise<{ ok: boolean }> =>
  post('/api/git/worktree-remove', { root, repo, path });
