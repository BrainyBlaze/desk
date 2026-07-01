/**
 * Pure parsers for git plumbing output (status --porcelain=v2, log records,
 * name-status file lists). Kept free of child_process so they are unit-testable
 * the same way fsOps/fsSearch are.
 */

import type { GitBranchInfo, GitLineDiffHunk, GitStatus, GitStatusEntry } from '../shared/git.js';

export type { GitBranchInfo, GitLineDiffHunk, GitStatus, GitStatusEntry } from '../shared/git.js';

const EMPTY_BRANCH: GitBranchInfo = {
  branch: null,
  oid: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false
};

/** Parse `git status --porcelain=v2 --branch` output. */
export function parsePorcelainStatus(output: string): GitStatus {
  const branchInfo: GitBranchInfo = { ...EMPTY_BRANCH };
  const entries: GitStatusEntry[] = [];
  for (const line of output.split('\n')) {
    if (line === '') {
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      branchInfo.oid = oid === '(initial)' ? null : oid;
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      branchInfo.detached = head === '(detached)';
      branchInfo.branch = branchInfo.detached ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      branchInfo.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        branchInfo.ahead = Number(match[1]);
        branchInfo.behind = Number(match[2]);
      }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const fields = splitFields(line, 8);
      if (fields) {
        entries.push({
          path: fields.rest,
          index: fields.parts[1]![0]!,
          worktree: fields.parts[1]![1]!,
          untracked: false,
          conflicted: false
        });
      }
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path\torigPath
      const fields = splitFields(line, 9);
      if (fields) {
        const tab = fields.rest.indexOf('\t');
        const target = tab === -1 ? fields.rest : fields.rest.slice(0, tab);
        const source = tab === -1 ? undefined : fields.rest.slice(tab + 1);
        entries.push({
          path: target,
          origPath: source,
          index: fields.parts[1]![0]!,
          worktree: fields.parts[1]![1]!,
          untracked: false,
          conflicted: false
        });
      }
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = splitFields(line, 10);
      if (fields) {
        entries.push({
          path: fields.rest,
          index: fields.parts[1]![0]!,
          worktree: fields.parts[1]![1]!,
          untracked: false,
          conflicted: true
        });
      }
    } else if (line.startsWith('? ')) {
      entries.push({
        path: line.slice(2),
        index: '.',
        worktree: '?',
        untracked: true,
        conflicted: false
      });
    }
  }
  return { branchInfo, entries };
}

/** Split a porcelain line into `count` space-separated fields + the path rest. */
function splitFields(line: string, count: number): { parts: string[]; rest: string } | null {
  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const next = line.indexOf(' ', cursor);
    if (next === -1) {
      return null;
    }
    parts.push(line.slice(cursor, next));
    cursor = next + 1;
  }
  return { parts, rest: line.slice(cursor) };
}

/* ---------- log ---------- */

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
  /** ISO 8601 author date */
  date: string;
  subject: string;
  refs: GitRef[];
}

export const LOG_FIELD_SEP = '\x1f';
export const LOG_RECORD_SEP = '\x1e';
/** --format string matching parseLogOutput (records split by \x1e, fields by \x1f). */
export const LOG_FORMAT = `%H${LOG_FIELD_SEP}%P${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%D${LOG_FIELD_SEP}%s${LOG_RECORD_SEP}`;

/** Parse `git log --format=LOG_FORMAT` output into commits. */
export function parseLogOutput(output: string): GitLogCommit[] {
  const commits: GitLogCommit[] = [];
  for (const record of output.split(LOG_RECORD_SEP)) {
    const trimmed = record.replace(/^\n/, '');
    if (trimmed === '') {
      continue;
    }
    const fields = trimmed.split(LOG_FIELD_SEP);
    if (fields.length < 7) {
      continue;
    }
    commits.push({
      sha: fields[0]!,
      parents: fields[1] === '' ? [] : fields[1]!.split(' '),
      author: fields[2]!,
      email: fields[3]!,
      date: fields[4]!,
      refs: parseRefNames(fields[5]!),
      subject: fields.slice(6).join(LOG_FIELD_SEP)
    });
  }
  return commits;
}

/**
 * Parse a `%D` decoration into refs. Expects `--decorate=full` so kinds are
 * unambiguous (`refs/heads/feature/x` is a branch, not a remote); short
 * forms are still handled as a fallback.
 */
export function parseRefNames(decoration: string): GitRef[] {
  if (decoration.trim() === '') {
    return [];
  }
  const refs: GitRef[] = [];
  const classify = (name: string): GitRef => {
    if (name.startsWith('refs/heads/')) {
      return { name: name.slice('refs/heads/'.length), kind: 'branch' };
    }
    if (name.startsWith('refs/remotes/')) {
      return { name: name.slice('refs/remotes/'.length), kind: 'remote' };
    }
    if (name.startsWith('refs/tags/')) {
      return { name: name.slice('refs/tags/'.length), kind: 'tag' };
    }
    return { name, kind: 'branch' };
  };
  for (const raw of decoration.split(', ')) {
    const part = raw.trim();
    if (part === '') {
      continue;
    }
    if (part.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', kind: 'head' });
      refs.push(classify(part.slice('HEAD -> '.length)));
    } else if (part === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' });
    } else if (part.startsWith('tag: ')) {
      refs.push({ name: part.slice('tag: '.length).replace(/^refs\/tags\//, ''), kind: 'tag' });
    } else {
      refs.push(classify(part));
    }
  }
  return refs;
}

/* ---------- name-status file lists ---------- */

export interface GitCommitFile {
  path: string;
  origPath?: string;
  /** single status letter: A M D R C T */
  status: string;
}

export interface GitBranchRef {
  /** short name: `feature/x` for locals, `origin/feature/x` for remotes */
  name: string;
  sha: string;
  /** branch currently checked out in THIS worktree */
  current: boolean;
  remote: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** ISO 8601 committer date */
  date: string;
  subject: string;
}

/** --format string matching parseBranchList (fields split by \x1f). */
export const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname:short)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:iso8601-strict)',
  '%(subject)'
].join(LOG_FIELD_SEP);

/** Parse `git for-each-ref refs/heads refs/remotes --format=BRANCH_FORMAT`. */
export function parseBranchList(output: string): GitBranchRef[] {
  const branches: GitBranchRef[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const fields = line.split(LOG_FIELD_SEP);
    if (fields.length < 7) {
      continue;
    }
    const refname = fields[0]!;
    let name: string;
    let remote: boolean;
    if (refname.startsWith('refs/heads/')) {
      name = refname.slice('refs/heads/'.length);
      remote = false;
    } else if (refname.startsWith('refs/remotes/')) {
      name = refname.slice('refs/remotes/'.length);
      remote = true;
      // `origin/HEAD` is a symref pointer, not a branch.
      if (/^[^/]+\/HEAD$/.test(name)) {
        continue;
      }
    } else {
      continue;
    }
    const track = fields[4] ?? '';
    const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
    branches.push({
      name,
      sha: fields[1]!,
      current: fields[2] === '*',
      remote,
      upstream: fields[3] === '' ? undefined : fields[3],
      ahead,
      behind,
      date: fields[5]!,
      subject: fields.slice(6).join(LOG_FIELD_SEP)
    });
  }
  return branches;
}

export interface GitWorktree {
  path: string;
  sha: string;
  /** short branch name; undefined when detached */
  branch?: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** the main working tree (first entry of `git worktree list`) */
  main: boolean;
}

/** Parse `git worktree list --porcelain` (blank-line separated blocks). */
export function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      continue;
    }
    const entry: GitWorktree = {
      path: '',
      sha: '',
      detached: false,
      locked: false,
      prunable: false,
      main: worktrees.length === 0
    };
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        entry.path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        entry.sha = line.slice('HEAD '.length).slice(0, 12);
      } else if (line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        entry.detached = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        entry.locked = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        entry.prunable = true;
      }
    }
    if (entry.path !== '') {
      worktrees.push(entry);
    }
  }
  return worktrees;
}

/** Parse `--name-status` lines ("M\tpath", "R100\told\tnew"). */
export function parseNameStatus(output: string): GitCommitFile[] {
  const files: GitCommitFile[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }
    const status = parts[0]![0]!;
    if (status === 'R' || status === 'C') {
      if (parts.length >= 3) {
        files.push({ path: parts[2]!, origPath: parts[1]!, status });
      }
    } else {
      files.push({ path: parts[1]!, status });
    }
  }
  return files;
}

/**
 * Parse `git diff -U0` output into gutter hunks (new-file coordinates).
 * Header form: `@@ -oldStart[,oldCount] +newStart[,newCount] @@`; counts
 * default to 1 when omitted. oldCount 0 → pure addition; newCount 0 → pure
 * deletion (newStart is the line AFTER which content was removed, 0 = top).
 */
export function parseDiffHunks(output: string): GitLineDiffHunk[] {
  const hunks: GitLineDiffHunk[] = [];
  const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of output.split('\n')) {
    if (!line.startsWith('@@')) {
      continue;
    }
    const match = header.exec(line);
    if (!match) {
      continue;
    }
    const oldCount = match[1] === undefined ? 1 : Number(match[1]);
    const newStart = Number(match[2]);
    const newCount = match[3] === undefined ? 1 : Number(match[3]);
    if (newCount === 0) {
      hunks.push({ kind: 'deleted', start: newStart, count: 0 });
    } else if (oldCount === 0) {
      hunks.push({ kind: 'added', start: newStart, count: newCount });
    } else {
      hunks.push({ kind: 'modified', start: newStart, count: newCount });
    }
  }
  return hunks;
}
