import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJsonBody, sendJson } from './httpUtil.js';
import { resolveFsPath } from './fsSafety.js';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranchList,
  parseDiffHunks,
  parseLogOutput,
  parseNameStatus,
  parsePorcelainStatus,
  parseWorktreeList,
  type GitCommitFile,
  type GitLogCommit,
  type GitStatus
} from './gitParse.js';
import type { GitLineDiffResult, GitStatusMapRepo } from '../shared/git.js';

const execFileAsync = promisify(execFile);

/** Hard caps so a pathological repo can never wedge the dev server. */
const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_REPOS = 200;
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.cache']);
const GIT_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_DIFF_SIDE_BYTES = 5 * 1024 * 1024;

/**
 * Every spelling git uses when HEAD names no commit yet (a freshly-inited
 * repo's unborn branch). The wording depends on how HEAD reached the command
 * line: "ambiguous argument 'HEAD': unknown revision" for explicit rev args,
 * "bad revision 'HEAD'" when paths follow, "does not have any commits yet" /
 * "bad default revision" when HEAD is implicit.
 */
export const NO_COMMITS_STDERR = /does not have any commits yet|bad default revision|bad revision|unknown revision|ambiguous argument/i;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runTool(command: string, args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      // No optional lock acquisition: status polling must never collide with
      // an agent running its own git commands in the same repo.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return { ok: false, stdout: failure.stdout ?? '', stderr: (failure.stderr ?? failure.message ?? 'command failed').trim() };
  }
}

const runGit = (repo: string, args: string[], timeout?: number): Promise<ExecResult> =>
  runTool('git', args, repo, timeout);

const runGh = (repo: string, args: string[], timeout?: number): Promise<ExecResult> =>
  runTool('gh', args, repo, timeout);

function requireGit(result: ExecResult, action: string): string {
  if (!result.ok) {
    throw new Error(result.stderr || `git ${action} failed`);
  }
  return result.stdout;
}

/* ---------- repo discovery ---------- */

export type { GitRepoSummary } from '../shared/git.js';
import type { GitRepoSummary } from '../shared/git.js';

function isGitRepo(path: string): boolean {
  // .git is a directory for normal clones and a file for worktrees/submodules.
  return existsSync(join(path, '.git'));
}

/**
 * Walk upward from a path to the repo that owns it, bounded by the explorer
 * root — repos above the root are out of scope (and out of the sandbox).
 */
export function resolveOwningRepo(path: string, root: string): string | null {
  const rootResolved = resolve(root);
  let current = resolve(path);
  while (current === rootResolved || current.startsWith(`${rootResolved}/`)) {
    if (isGitRepo(current)) {
      return current;
    }
    const parent = current.slice(0, current.lastIndexOf('/')) || '/';
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/** Find git repos under root (depth-limited, dependency dirs skipped). */
export function findGitRepos(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= SCAN_MAX_REPOS) {
      return;
    }
    if (isGitRepo(dir)) {
      found.push(dir);
      return; // nested repos under a repo are almost always vendored — skip
    }
    if (depth >= SCAN_MAX_DEPTH) {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (SCAN_SKIP_DIRS.has(name) || (name.startsWith('.') && depth > 0)) {
        continue;
      }
      const child = join(dir, name);
      try {
        if (statSync(child).isDirectory()) {
          walk(child, depth + 1);
        }
      } catch {
        // unreadable entries are skipped
      }
    }
  };
  walk(resolve(root), 0);
  return found;
}

async function summarizeRepo(root: string, path: string): Promise<GitRepoSummary> {
  const name = path === resolve(root) ? path.slice(path.lastIndexOf('/') + 1) : relative(resolve(root), path);
  const status = await runGit(path, ['status', '--porcelain=v2', '--branch']);
  if (!status.ok) {
    return { path, name, branch: null, detached: false, ahead: 0, behind: 0, changes: 0, upstream: null };
  }
  const parsed = parsePorcelainStatus(status.stdout);
  return {
    path,
    name,
    branch: parsed.branchInfo.branch,
    detached: parsed.branchInfo.detached,
    ahead: parsed.branchInfo.ahead,
    behind: parsed.branchInfo.behind,
    changes: parsed.entries.length,
    upstream: parsed.branchInfo.upstream
  };
}

async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = (cursor += 1) - 1;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------- request handling ---------- */

/**
 * Handle /api/git/* requests. Returns false when the URL is not a git route
 * so the caller's routing chain continues. Every operation shells out to the
 * git/gh CLIs — no git libraries.
 */
export async function handleGitRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/git/')) {
    return false;
  }

  if (req.method === 'GET') {
    const root = requireParam(url.searchParams.get('root'), 'root');

    if (url.pathname === '/api/git/repos') {
      const repos = findGitRepos(root);
      sendJson(res, 200, { repos: await mapLimited(repos, 8, (path) => summarizeRepo(root, path)) });
      return true;
    }

    const repo = resolveRepo(url.searchParams.get('repo'), root);

    if (url.pathname === '/api/git/status') {
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/log') {
      const limit = boundedInt(url.searchParams.get('limit'), 60, 1, 500);
      const skip = boundedInt(url.searchParams.get('skip'), 0, 0, 100_000);
      const pathRaw = url.searchParams.get('path');
      const filterPath = pathRaw ? requireRepoFile(pathRaw, repo) : undefined;
      sendJson(res, 200, await readLog(repo, limit, skip, filterPath));
      return true;
    }

    if (url.pathname === '/api/git/line-diff') {
      const path = requireRepoFile(url.searchParams.get('path'), repo);
      sendJson(res, 200, await readLineDiff(repo, path));
      return true;
    }

    if (url.pathname === '/api/git/commit') {
      const sha = requireSha(url.searchParams.get('sha'));
      sendJson(res, 200, await readCommitDetail(repo, sha));
      return true;
    }

    if (url.pathname === '/api/git/diff') {
      const path = requireRepoFile(url.searchParams.get('path'), repo);
      const mode = url.searchParams.get('mode');
      if (mode !== 'worktree' && mode !== 'index' && mode !== 'commit' && mode !== 'range') {
        throw new Error('mode must be worktree, index, commit, or range');
      }
      const sha = mode === 'commit' ? requireSha(url.searchParams.get('sha')) : undefined;
      const origRaw = url.searchParams.get('origPath');
      const origPath = origRaw ? requireRepoFile(origRaw, repo) : undefined;
      const range =
        mode === 'range'
          ? { base: requireSha(url.searchParams.get('base')), ref: requireRef(url.searchParams.get('ref')) }
          : undefined;
      sendJson(res, 200, await readDiffPair(repo, path, mode, sha, origPath, range));
      return true;
    }

    if (url.pathname === '/api/git/branch-diff') {
      // What a branch would change, WITHOUT checking it out: files differing
      // between merge-base(HEAD, ref) and ref — the branch's own work.
      const ref = requireRef(url.searchParams.get('ref'));
      sendJson(res, 200, await readBranchDiff(repo, ref));
      return true;
    }

    if (url.pathname === '/api/git/branches') {
      const refs = requireGit(
        await runGit(repo, ['for-each-ref', 'refs/heads', 'refs/remotes', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`]),
        'for-each-ref'
      );
      const trees = requireGit(await runGit(repo, ['worktree', 'list', '--porcelain']), 'worktree list');
      sendJson(res, 200, { branches: parseBranchList(refs), worktrees: parseWorktreeList(trees) });
      return true;
    }

    if (url.pathname === '/api/git/github') {
      sendJson(res, 200, await readGitHubInfo(repo));
      return true;
    }

    if (url.pathname === '/api/git/browse') {
      const sha = url.searchParams.get('sha');
      const path = url.searchParams.get('path');
      const args = ['browse', '-n'];
      if (sha) {
        args.push('-c', requireSha(sha));
      } else if (path) {
        args.push(requireRepoFile(path, repo));
      }
      const result = await runGh(repo, args);
      if (!result.ok) {
        sendJson(res, 200, { ok: false, error: result.stderr });
        return true;
      }
      sendJson(res, 200, { ok: true, url: result.stdout.trim() });
      return true;
    }
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const root = requireParam(typeof body.root === 'string' ? body.root : null, 'root');

    if (url.pathname === '/api/git/status-map') {
      // Explorer tree decorations: status every repo owning the given paths
      // (the tree's visible dirs) — never the full recursive repo scan.
      sendJson(res, 200, { repos: await readStatusMap(root, body.paths) });
      return true;
    }

    const repo = resolveRepo(typeof body.repo === 'string' ? body.repo : null, root);

    if (url.pathname === '/api/git/stage') {
      const paths = readRepoFiles(body.paths, repo);
      requireGit(await runGit(repo, ['add', '-A', '--', ...paths]), 'add');
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/unstage') {
      const paths = readRepoFiles(body.paths, repo);
      const restored = await runGit(repo, ['restore', '--staged', '--', ...paths]);
      if (!restored.ok) {
        // Before the first commit there is no HEAD to restore from.
        requireGit(await runGit(repo, ['rm', '-r', '--cached', '-q', '--', ...paths]), 'unstage');
      }
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/discard') {
      const tracked = readRepoFiles(body.tracked, repo, { optional: true });
      const untracked = readRepoFiles(body.untracked, repo, { optional: true });
      if (tracked.length > 0) {
        requireGit(await runGit(repo, ['restore', '--', ...tracked]), 'restore');
      }
      if (untracked.length > 0) {
        requireGit(await runGit(repo, ['clean', '-fdq', '--', ...untracked]), 'clean');
      }
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/commit') {
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message === '' && body.amend !== true) {
        throw new Error('commit message is required');
      }
      const args = ['commit'];
      if (body.all === true) {
        args.push('-a');
      }
      if (body.amend === true) {
        args.push('--amend');
        args.push(message === '' ? '--no-edit' : '-m');
      } else {
        args.push('-m');
      }
      if (message !== '' || body.amend !== true) {
        args.push(message);
      }
      requireGit(await runGit(repo, args), 'commit');
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/sync') {
      const op = body.op;
      if (op === 'fetch') {
        requireGit(await runGit(repo, ['fetch', '--all', '--prune'], NETWORK_TIMEOUT_MS), 'fetch');
      } else if (op === 'pull') {
        requireGit(await runGit(repo, ['pull', '--ff-only'], NETWORK_TIMEOUT_MS), 'pull');
      } else if (op === 'push') {
        requireGit(await runGit(repo, ['push'], NETWORK_TIMEOUT_MS), 'push');
      } else if (op === 'publish') {
        const branch = requireGit(await runGit(repo, ['branch', '--show-current']), 'branch').trim();
        if (branch === '') {
          throw new Error('cannot publish a detached HEAD');
        }
        requireGit(await runGit(repo, ['push', '-u', 'origin', branch], NETWORK_TIMEOUT_MS), 'push');
      } else {
        throw new Error('op must be fetch, pull, push, or publish');
      }
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/checkout') {
      const ref = requireRef(body.ref);
      requireGit(await runGit(repo, ['checkout', ref]), 'checkout');
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/branch') {
      const name = requireRef(body.name);
      const sha = requireSha(typeof body.sha === 'string' ? body.sha : null);
      requireGit(await runGit(repo, ['checkout', '-b', name, sha]), 'branch');
      sendJson(res, 200, await readStatus(repo));
      return true;
    }

    if (url.pathname === '/api/git/branch-delete') {
      const name = requireRef(body.name);
      // -d refuses unmerged branches; the client re-asks and sends force.
      requireGit(await runGit(repo, ['branch', body.force === true ? '-D' : '-d', name]), 'branch delete');
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/git/worktree-remove') {
      const target = typeof body.path === 'string' ? resolve(body.path) : '';
      const listed = requireGit(await runGit(repo, ['worktree', 'list', '--porcelain']), 'worktree list');
      const known = parseWorktreeList(listed);
      const entry = known.find((tree) => resolve(tree.path) === target);
      if (!entry) {
        throw new Error('path is not a worktree of this repository');
      }
      if (entry.main) {
        throw new Error('refusing to remove the main working tree');
      }
      requireGit(await runGit(repo, ['worktree', 'remove', entry.path]), 'worktree remove');
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/git/revert') {
      const sha = requireSha(typeof body.sha === 'string' ? body.sha : null);
      requireGit(await runGit(repo, ['revert', '--no-edit', sha]), 'revert');
      sendJson(res, 200, await readStatus(repo));
      return true;
    }
  }

  sendJson(res, 404, { error: `unknown git route ${url.pathname}` });
  return true;
}

/* ---------- readers ---------- */

async function readStatus(repo: string): Promise<GitStatus> {
  return parsePorcelainStatus(requireGit(await runGit(repo, ['status', '--porcelain=v2', '--branch']), 'status'));
}

/** Status for every repo owning one of the requested paths (deduped). */
async function readStatusMap(root: string, rawPaths: unknown): Promise<GitStatusMapRepo[]> {
  const repoSet = new Set<string>();
  const candidates = Array.isArray(rawPaths) ? rawPaths.slice(0, 400) : [];
  for (const entry of candidates) {
    if (typeof entry !== 'string') {
      continue;
    }
    let resolved: string;
    try {
      resolved = resolveFsPath(entry, root);
    } catch {
      continue; // paths escaping the root are silently dropped
    }
    const owner = resolveOwningRepo(resolved, root);
    if (owner) {
      repoSet.add(owner);
    }
  }
  const results = await mapLimited([...repoSet], 8, async (repoRoot): Promise<GitStatusMapRepo | null> => {
    try {
      const status = await readStatus(repoRoot);
      return { root: repoRoot, branch: status.branchInfo, entries: status.entries };
    } catch {
      return null; // a repo mid-gc or mid-rebase must not fail the whole map
    }
  });
  return results.filter((repo): repo is GitStatusMapRepo => repo !== null);
}

/**
 * Gutter hunks for one file: worktree+index vs HEAD (`git diff -U0 HEAD`).
 * Untracked files (and repos without commits) report untracked=true so the
 * client can paint the whole file as added.
 */
async function readLineDiff(repo: string, path: string): Promise<GitLineDiffResult> {
  const tracked = await runGit(repo, ['ls-files', '--error-unmatch', '--', path]);
  if (!tracked.ok) {
    return { untracked: true, hunks: [] };
  }
  const diff = await runGit(repo, ['diff', '-U0', 'HEAD', '--', path]);
  if (!diff.ok) {
    if (NO_COMMITS_STDERR.test(diff.stderr)) {
      return { untracked: true, hunks: [] }; // no commits yet — everything is new
    }
    throw new Error(diff.stderr || 'git diff failed');
  }
  return { untracked: false, hunks: parseDiffHunks(diff.stdout) };
}

async function readLog(
  repo: string,
  limit: number,
  skip: number,
  filterPath?: string
): Promise<{ commits: GitLogCommit[]; hasMore: boolean }> {
  const result = await runGit(repo, [
    'log',
    '--topo-order',
    '--decorate=full',
    `--format=${LOG_FORMAT}`,
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    // Per-file history follows HEAD's lineage only — the all-refs view is for
    // the repo-wide graph. --follow tracks the file across renames.
    ...(filterPath ? ['--follow', 'HEAD', '--', filterPath] : ['--branches', '--remotes', '--tags', 'HEAD'])
  ]);
  if (!result.ok) {
    // Empty repos (no commits yet) report an error — present them as empty history.
    if (NO_COMMITS_STDERR.test(result.stderr)) {
      return { commits: [], hasMore: false };
    }
    throw new Error(result.stderr || 'git log failed');
  }
  const commits = parseLogOutput(result.stdout);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export interface GitCommitDetail {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  files: GitCommitFile[];
}

async function readCommitDetail(repo: string, sha: string): Promise<GitCommitDetail> {
  const meta = requireGit(
    await runGit(repo, ['show', '-s', '--format=%H\x1f%an\x1f%ae\x1f%aI\x1f%B', sha]),
    'show'
  ).split('\x1f');
  const files = parseNameStatus(
    requireGit(
      await runGit(repo, ['show', sha, '--format=', '--name-status', '--find-renames', '--diff-merges=first-parent']),
      'show'
    )
  );
  return {
    sha: meta[0] ?? sha,
    author: meta[1] ?? '',
    email: meta[2] ?? '',
    date: meta[3] ?? '',
    message: (meta[4] ?? '').trim(),
    files
  };
}

export type GitDiffResult =
  | { ok: true; original: string; modified: string }
  | { ok: false; reason: 'binary' | 'too-large' };

async function readDiffPair(
  repo: string,
  path: string,
  mode: 'worktree' | 'index' | 'commit' | 'range',
  sha?: string,
  origPath?: string,
  range?: { base: string; ref: string }
): Promise<GitDiffResult> {
  const showOrEmpty = async (spec: string): Promise<string> => {
    const result = await runGit(repo, ['show', spec]);
    return result.ok ? result.stdout : '';
  };
  let original = '';
  let modified = '';
  if (mode === 'worktree') {
    original = await showOrEmpty(`:${path}`);
    if (original === '') {
      // Not in the index (untracked) — fall back to HEAD for files that are
      // staged-deleted but still present in the worktree.
      original = await showOrEmpty(`HEAD:${path}`);
    }
    modified = readWorktreeFile(repo, path);
  } else if (mode === 'index') {
    original = await showOrEmpty(`HEAD:${origPath ?? path}`);
    modified = await showOrEmpty(`:${path}`);
  } else if (mode === 'range' && range) {
    original = await showOrEmpty(`${range.base}:${origPath ?? path}`);
    modified = await showOrEmpty(`${range.ref}:${path}`);
  } else {
    original = await showOrEmpty(`${sha}^:${origPath ?? path}`);
    modified = await showOrEmpty(`${sha}:${path}`);
  }
  if (original.length > MAX_DIFF_SIDE_BYTES || modified.length > MAX_DIFF_SIDE_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  if (original.includes('\0') || modified.includes('\0')) {
    return { ok: false, reason: 'binary' };
  }
  return { ok: true, original, modified };
}

export interface GitBranchDiff {
  /** merge-base of HEAD and the ref — the diff's left side */
  baseSha: string;
  /** the ref's tip */
  refSha: string;
  files: GitCommitFile[];
}

/** Files a branch changes relative to merge-base(HEAD, ref) — no checkout. */
async function readBranchDiff(repo: string, ref: string): Promise<GitBranchDiff> {
  const refSha = requireGit(await runGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]), 'rev-parse').trim();
  const mergeBase = await runGit(repo, ['merge-base', 'HEAD', ref]);
  // Unrelated histories have no merge-base: diff against the empty tree so
  // every file on the branch shows as added.
  const baseSha = mergeBase.ok
    ? mergeBase.stdout.trim()
    : requireGit(await runGit(repo, ['hash-object', '-t', 'tree', '/dev/null']), 'hash-object').trim();
  const nameStatus = requireGit(
    await runGit(repo, ['diff', '--name-status', '--find-renames', baseSha, refSha]),
    'diff'
  );
  return { baseSha, refSha, files: parseNameStatus(nameStatus) };
}

function readWorktreeFile(repo: string, path: string): string {
  const absolute = resolve(repo, path);
  try {
    if (statSync(absolute).size > MAX_DIFF_SIDE_BYTES) {
      return ''; // size guard re-checked by the caller via the cap above
    }
    return readFileSync(absolute, 'utf8');
  } catch {
    return ''; // deleted in the worktree
  }
}

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

async function readGitHubInfo(repo: string): Promise<GitHubInfo> {
  const view = await runGh(repo, [
    'repo',
    'view',
    '--json',
    'nameWithOwner,description,url,isPrivate,stargazerCount,defaultBranchRef'
  ]);
  if (!view.ok) {
    return { available: false, reason: view.stderr.split('\n')[0] };
  }
  let info: GitHubInfo;
  try {
    const parsed = JSON.parse(view.stdout) as {
      nameWithOwner?: string;
      description?: string;
      url?: string;
      isPrivate?: boolean;
      stargazerCount?: number;
      defaultBranchRef?: { name?: string };
    };
    info = {
      available: true,
      nameWithOwner: parsed.nameWithOwner,
      description: parsed.description,
      url: parsed.url,
      isPrivate: parsed.isPrivate,
      stargazerCount: parsed.stargazerCount,
      defaultBranch: parsed.defaultBranchRef?.name,
      pullRequest: null
    };
  } catch {
    return { available: false, reason: 'unparseable gh output' };
  }
  const prStatus = await runGh(repo, ['pr', 'status', '--json', 'number,title,url,state,isDraft']);
  if (prStatus.ok) {
    try {
      const parsed = JSON.parse(prStatus.stdout) as {
        currentBranch?: { number: number; title: string; url: string; state: string; isDraft: boolean } | null;
      };
      info.pullRequest = parsed.currentBranch ?? null;
    } catch {
      // PR info stays null — the repo card is still useful without it
    }
  }
  return info;
}

/* ---------- validation ---------- */

function requireParam(value: string | null, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`${name} query/body parameter is required`);
  }
  return value;
}

/** The repo must live inside the explorer root and actually be a git repo. */
function resolveRepo(raw: string | null, root: string): string {
  const repo = resolveFsPath(requireParam(raw, 'repo'), root);
  if (!isGitRepo(repo)) {
    throw new Error(`not a git repository: ${raw}`);
  }
  return repo;
}

/** Validate a repo-relative file path (no escapes), returning it normalized. */
function requireRepoFile(raw: string | null, repo: string): string {
  const value = requireParam(raw, 'path');
  const resolved = resolve(repo, value);
  const rel = relative(resolve(repo), resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the repository: ${value}`);
  }
  return rel.split('\\').join('/');
}

function readRepoFiles(value: unknown, repo: string, options: { optional?: boolean } = {}): string[] {
  if (!Array.isArray(value)) {
    if (options.optional) {
      return [];
    }
    throw new Error('paths must be an array');
  }
  return value.map((entry) => requireRepoFile(typeof entry === 'string' ? entry : null, repo));
}

function requireSha(value: string | null): string {
  if (!value || !/^[0-9a-f]{4,64}$/i.test(value)) {
    throw new Error('sha must be a hex object id');
  }
  return value;
}

function requireRef(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('-') || /[\s~^:?*[\\]/.test(value)) {
    throw new Error('invalid ref name');
  }
  return value;
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`numeric parameter out of range: ${value}`);
  }
  return parsed;
}
