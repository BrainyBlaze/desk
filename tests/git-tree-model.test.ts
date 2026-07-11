import { describe, expect, it } from 'vitest';
import { buildTreeGitModel, owningRepoOf, repoRelative, shortenBranch, EMPTY_TREE_GIT_MODEL } from '../src/web/editor/gitTreeModel';
import type { GitStatusMapRepo } from '../src/shared/git';

const branch = (over: Partial<GitStatusMapRepo['branch']> = {}): GitStatusMapRepo['branch'] => ({
  branch: 'main',
  oid: 'abc123',
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  detached: false,
  ...over
});

const entry = (path: string, over: Partial<GitStatusMapRepo['entries'][number]> = {}) => ({
  path,
  index: '.',
  worktree: 'M',
  untracked: false,
  conflicted: false,
  ...over
});

describe('buildTreeGitModel', () => {
  const root = '/home/u/projects';
  const repos: GitStatusMapRepo[] = [
    {
      root: '/home/u/projects/app',
      branch: branch(),
      entries: [
        entry('src/deep/file.ts'),
        entry('new.ts', { worktree: '?', untracked: true }),
        entry('staged.ts', { index: 'A', worktree: '.' }),
        entry('clash.ts', { index: 'M', worktree: 'M', conflicted: true })
      ]
    },
    { root: '/home/u/projects/lib', branch: branch({ branch: 'dev', ahead: 0 }), entries: [] }
  ];

  it('maps file badges with worktree state winning over index', () => {
    const model = buildTreeGitModel(repos, root);
    expect(model.badges.get('/home/u/projects/app/src/deep/file.ts')).toEqual({ letter: 'M', tone: 'modified' });
    expect(model.badges.get('/home/u/projects/app/new.ts')).toEqual({ letter: 'U', tone: 'untracked' });
    expect(model.badges.get('/home/u/projects/app/staged.ts')).toEqual({ letter: 'A', tone: 'added' });
    expect(model.badges.get('/home/u/projects/app/clash.ts')).toEqual({ letter: '!', tone: 'conflict' });
  });

  it('propagates changed-dir dots to ancestors below the explorer root', () => {
    const model = buildTreeGitModel(repos, root);
    expect(model.changedDirs.has('/home/u/projects/app/src/deep')).toBe(true);
    expect(model.changedDirs.has('/home/u/projects/app/src')).toBe(true);
    expect(model.changedDirs.has('/home/u/projects/app')).toBe(true);
    expect(model.changedDirs.has('/home/u/projects')).toBe(false);
  });

  it('builds repo chips including clean repos', () => {
    const model = buildTreeGitModel(repos, root);
    expect(model.repoChips.get('/home/u/projects/app')?.changes).toBe(4);
    expect(model.repoChips.get('/home/u/projects/lib')).toMatchObject({ branch: 'dev', changes: 0 });
  });

  it('sorts repo roots longest-first for owning lookups', () => {
    const nested: GitStatusMapRepo[] = [
      { root: '/r/a', branch: branch(), entries: [] },
      { root: '/r/a-long/sub', branch: branch(), entries: [] }
    ];
    const model = buildTreeGitModel(nested, '/r');
    expect(owningRepoOf('/r/a-long/sub/x.ts', model.repoRoots)).toBe('/r/a-long/sub');
    expect(owningRepoOf('/r/a/x.ts', model.repoRoots)).toBe('/r/a');
    expect(owningRepoOf('/r/other/x.ts', model.repoRoots)).toBeNull();
    // prefix similarity must not confuse the lookup: /r/a is not a prefix-match for /r/a-long
    expect(owningRepoOf('/r/a-long/x.ts', model.repoRoots)).toBeNull();
  });

  it('repoRelative strips the repo prefix only', () => {
    expect(repoRelative('/r/a/src/x.ts', '/r/a')).toBe('src/x.ts');
    expect(repoRelative('/r/a', '/r/a')).toBe('.');
    expect(repoRelative('/elsewhere/x', '/r/a')).toBe('/elsewhere/x');
  });

  it('exposes a frozen-shape empty model', () => {
    expect(EMPTY_TREE_GIT_MODEL.badges.size).toBe(0);
    expect(EMPTY_TREE_GIT_MODEL.repoRoots).toEqual([]);
  });
});

describe('shortenBranch', () => {
  it('keeps short names intact', () => {
    expect(shortenBranch('main')).toBe('main');
    expect(shortenBranch('feat/quick-fix')).toBe('feat/quick-fix');
  });

  it('shortens long names keeping both ends', () => {
    const result = shortenBranch('feat/m48-constrained-qwen-realizer');
    expect(result.length).toBeLessThanOrEqual(21);
    expect(result.startsWith('feat/m48')).toBe(true);
    expect(result.endsWith('realizer')).toBe(true);
    expect(result).toContain('…');
  });

  it('respects a custom max', () => {
    expect(shortenBranch('abcdefghijklmnop', 10).length).toBeLessThanOrEqual(10);
  });

  it('respects exact max boundaries for tiny max (tail <= 0), never splicing the whole branch back', () => {
    expect(shortenBranch('abcdefghijklmnop', 0)).toBe('');
    expect(shortenBranch('abcdefghijklmnop', 1)).toBe('…');
    const five = shortenBranch('abcdefghijklmnop', 5);
    expect(five.length).toBe(5);
    expect(five).not.toContain('klmnop');
  });
});
