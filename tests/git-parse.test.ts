import { describe, expect, it } from 'vitest';
import { parseBranchList, parseDiffHunks, parseLogOutput, parseNameStatus, parsePorcelainStatus, parseRefNames, parseWorktreeList, LOG_FIELD_SEP, LOG_RECORD_SEP } from '../src/server/gitParse';

describe('parsePorcelainStatus', () => {
  it('parses branch headers including ahead/behind', () => {
    const output = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head master',
      '# branch.upstream origin/master',
      '# branch.ab +2 -1',
      ''
    ].join('\n');
    const status = parsePorcelainStatus(output);
    expect(status.branchInfo).toEqual({
      branch: 'master',
      oid: '1234567890abcdef1234567890abcdef12345678',
      upstream: 'origin/master',
      ahead: 2,
      behind: 1,
      detached: false
    });
    expect(status.entries).toEqual([]);
  });

  it('flags a detached head and an unborn branch', () => {
    const detached = parsePorcelainStatus('# branch.oid abc123\n# branch.head (detached)\n');
    expect(detached.branchInfo.detached).toBe(true);
    expect(detached.branchInfo.branch).toBeNull();
    const unborn = parsePorcelainStatus('# branch.oid (initial)\n# branch.head main\n');
    expect(unborn.branchInfo.oid).toBeNull();
  });

  it('parses ordinary, renamed, unmerged, and untracked entries', () => {
    const output = [
      '1 M. N... 100644 100644 100644 aaaa bbbb src/app.ts',
      '1 .D N... 100644 100644 000000 aaaa aaaa gone.txt',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.ts\told name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? fresh file.md'
    ].join('\n');
    const { entries } = parsePorcelainStatus(output);
    expect(entries).toEqual([
      { path: 'src/app.ts', index: 'M', worktree: '.', untracked: false, conflicted: false },
      { path: 'gone.txt', index: '.', worktree: 'D', untracked: false, conflicted: false },
      { path: 'new name.ts', origPath: 'old name.ts', index: 'R', worktree: '.', untracked: false, conflicted: false },
      { path: 'conflict.ts', index: 'U', worktree: 'U', untracked: false, conflicted: true },
      { path: 'fresh file.md', index: '.', worktree: '?', untracked: true, conflicted: false }
    ]);
  });
});

describe('parseLogOutput', () => {
  const record = (fields: string[]): string => fields.join(LOG_FIELD_SEP) + LOG_RECORD_SEP;

  it('parses records with parents, refs, and subjects', () => {
    const output =
      record([
        'c2',
        'c1 c0',
        'Ada',
        'ada@x.io',
        '2026-06-11T10:00:00+02:00',
        'HEAD -> refs/heads/master, refs/remotes/origin/master',
        'merge: feature'
      ]) +
      '\n' +
      record(['c1', 'c0', 'Bob', 'bob@x.io', '2026-06-10T09:00:00+02:00', 'tag: refs/tags/v1.0', 'fix things']) +
      '\n' +
      record(['c0', '', 'Ada', 'ada@x.io', '2026-06-09T08:00:00+02:00', '', 'root']);
    const commits = parseLogOutput(output);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toMatchObject({ sha: 'c2', parents: ['c1', 'c0'], subject: 'merge: feature' });
    expect(commits[0]!.refs).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'master', kind: 'branch' },
      { name: 'origin/master', kind: 'remote' }
    ]);
    expect(commits[1]!.refs).toEqual([{ name: 'v1.0', kind: 'tag' }]);
    expect(commits[2]).toMatchObject({ parents: [], refs: [] });
  });
});

describe('parseRefNames', () => {
  it('classifies full decorations including slashed local branches', () => {
    expect(
      parseRefNames('HEAD -> refs/heads/feature/colors, tag: refs/tags/v2, refs/remotes/origin/dev, refs/heads/dev')
    ).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'feature/colors', kind: 'branch' },
      { name: 'v2', kind: 'tag' },
      { name: 'origin/dev', kind: 'remote' },
      { name: 'dev', kind: 'branch' }
    ]);
  });

  it('falls back gracefully on short decorations', () => {
    expect(parseRefNames('HEAD, tag: v2, dev')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'v2', kind: 'tag' },
      { name: 'dev', kind: 'branch' }
    ]);
  });
});

describe('parseNameStatus', () => {
  it('parses plain and rename/copy lines', () => {
    const output = ['M\tsrc/a.ts', 'A\tdocs/new.md', 'D\tgone.txt', 'R087\told/path.ts\tnew/path.ts', ''].join('\n');
    expect(parseNameStatus(output)).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'docs/new.md', status: 'A' },
      { path: 'gone.txt', status: 'D' },
      { path: 'new/path.ts', origPath: 'old/path.ts', status: 'R' }
    ]);
  });
});

describe('parseBranchList', () => {
  const SEP = '\x1f';
  const line = (...fields: string[]) => fields.join(SEP);

  it('parses local and remote branches with tracking info', () => {
    const output = [
      line('refs/heads/master', 'abc1234', '*', 'origin/master', '[ahead 2, behind 1]', '2026-06-11T10:00:00+02:00', 'tip work'),
      line('refs/heads/feature/x', 'def5678', ' ', '', '', '2026-06-10T09:00:00+02:00', 'wip: thing'),
      line('refs/remotes/origin/master', 'abc1234', ' ', '', '', '2026-06-11T10:00:00+02:00', 'tip work'),
      line('refs/remotes/origin/HEAD', 'abc1234', ' ', '', '', '2026-06-11T10:00:00+02:00', 'tip work')
    ].join('\n');
    const branches = parseBranchList(output);
    expect(branches).toHaveLength(3); // origin/HEAD symref dropped
    expect(branches[0]).toMatchObject({
      name: 'master',
      current: true,
      remote: false,
      upstream: 'origin/master',
      ahead: 2,
      behind: 1
    });
    expect(branches[1]).toMatchObject({ name: 'feature/x', current: false, ahead: 0, behind: 0, upstream: undefined });
    expect(branches[2]).toMatchObject({ name: 'origin/master', remote: true });
  });

  it('keeps subjects containing the field separator intact', () => {
    const branches = parseBranchList(line('refs/heads/a', '111', ' ', '', '', '2026-01-01T00:00:00Z', `sub${SEP}ject`));
    expect(branches[0]?.subject).toBe(`sub${SEP}ject`);
  });
});

describe('parseWorktreeList', () => {
  it('parses porcelain blocks with main/detached/locked/prunable flags', () => {
    const output = [
      'worktree /workspace/projects/desk',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/master',
      '',
      'worktree /workspace/projects/desk/.agent-worktrees/channels-subsystem',
      'HEAD aaaa456789abcdef0123456789abcdef01234567',
      'branch refs/heads/worktree-channels-subsystem',
      'locked agent session',
      '',
      'worktree /tmp/detached-tree',
      'HEAD bbbb456789abcdef0123456789abcdef01234567',
      'detached',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n');
    const trees = parseWorktreeList(output);
    expect(trees).toHaveLength(3);
    expect(trees[0]).toMatchObject({ path: '/workspace/projects/desk', branch: 'master', main: true, locked: false });
    expect(trees[1]).toMatchObject({
      branch: 'worktree-channels-subsystem',
      main: false,
      locked: true,
      sha: 'aaaa456789ab'
    });
    expect(trees[2]).toMatchObject({ detached: true, prunable: true });
    expect(trees[2]?.branch).toBeUndefined();
  });
});

describe('parseDiffHunks', () => {
  it('classifies modified, added, and deleted hunks in new-file coordinates', () => {
    const output = [
      'diff --git a/file.ts b/file.ts',
      'index 123..456 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -3,2 +3,2 @@ context',
      '-old',
      '+new',
      '@@ -10,0 +11,4 @@',
      '+only added',
      '@@ -20,3 +27,0 @@',
      '-removed',
      ''
    ].join('\n');
    expect(parseDiffHunks(output)).toEqual([
      { kind: 'modified', start: 3, count: 2 },
      { kind: 'added', start: 11, count: 4 },
      { kind: 'deleted', start: 27, count: 0 }
    ]);
  });

  it('defaults omitted counts to 1 and handles deletion at the top of the file', () => {
    const output = ['@@ -5 +5 @@', '-a', '+b', '@@ -1,2 +0,0 @@', '-x', '-y'].join('\n');
    expect(parseDiffHunks(output)).toEqual([
      { kind: 'modified', start: 5, count: 1 },
      { kind: 'deleted', start: 0, count: 0 }
    ]);
  });

  it('ignores non-header lines that merely start with @@', () => {
    expect(parseDiffHunks('@@ not a header\ncontext @@ -1 +1 @@')).toEqual([]);
  });

  it('returns no hunks for an empty diff', () => {
    expect(parseDiffHunks('')).toEqual([]);
  });
});
