import { describe, expect, it } from 'vitest';
import {
  formatAheadBehind,
  formatClock,
  formatSaveState,
  getStatusSegments,
  gitStatusCounts,
  publishStatus,
  relativeToRootPath
} from '../src/web/statusSegments.js';
import type { GitStatusEntry } from '../src/web/git/gitClient.js';

function entry(partial: Partial<GitStatusEntry>): GitStatusEntry {
  return { path: 'f', index: '.', worktree: '.', untracked: false, conflicted: false, ...partial };
}

describe('gitStatusCounts', () => {
  it('buckets staged, changed, and conflicted entries', () => {
    const counts = gitStatusCounts([
      entry({ index: 'M' }),
      entry({ worktree: 'M' }),
      entry({ untracked: true }),
      entry({ conflicted: true, index: 'U', worktree: 'U' })
    ]);
    expect(counts).toEqual({ staged: 1, changed: 2, conflicted: 1 });
  });

  it('counts a partially staged file in both buckets', () => {
    expect(gitStatusCounts([entry({ index: 'M', worktree: 'M' })])).toEqual({ staged: 1, changed: 1, conflicted: 0 });
  });

  it('empty tree is clean', () => {
    expect(gitStatusCounts([])).toEqual({ staged: 0, changed: 0, conflicted: 0 });
  });

  it('does not count porcelain-v2 dot sentinels as changes', () => {
    expect(gitStatusCounts([entry({})])).toEqual({ staged: 0, changed: 0, conflicted: 0 });
  });
});

describe('formatAheadBehind', () => {
  it('renders arrows only for non-zero values', () => {
    expect(formatAheadBehind(2, 1)).toBe('↑2 ↓1');
    expect(formatAheadBehind(0, 3)).toBe('↓3');
    expect(formatAheadBehind(0, 0)).toBe('');
    expect(formatAheadBehind(undefined, undefined)).toBe('');
  });
});

describe('formatClock / formatSaveState / relativeToRootPath', () => {
  it('pads the clock', () => {
    expect(formatClock(new Date(2026, 5, 11, 9, 5))).toBe('09:05');
  });

  it('save state flips on dirty count', () => {
    expect(formatSaveState(0)).toEqual({ text: 'saved', tone: 'ok' });
    expect(formatSaveState(3)).toEqual({ text: '● 3 unsaved', tone: 'warn' });
  });

  it('relativizes only paths under the root', () => {
    expect(relativeToRootPath('/a/b/c.ts', '/a/b')).toBe('c.ts');
    expect(relativeToRootPath('/elsewhere/c.ts', '/a/b')).toBe('/elsewhere/c.ts');
    expect(relativeToRootPath('/a/b/c.ts', null)).toBe('/a/b/c.ts');
    // a root that merely prefixes a sibling dir must not match
    expect(relativeToRootPath('/a/bc/d.ts', '/a/b')).toBe('/a/bc/d.ts');
  });
});

describe('status segment store', () => {
  it('publishes per scope and dedupes unchanged payloads', () => {
    publishStatus('test-scope', [{ key: 'a', text: 'one' }]);
    const first = getStatusSegments('test-scope');
    expect(first).toHaveLength(1);

    // identical content -> the stored array identity must not change
    publishStatus('test-scope', [{ key: 'a', text: 'one' }]);
    expect(getStatusSegments('test-scope')).toBe(first);

    publishStatus('test-scope', [{ key: 'a', text: 'two' }]);
    expect(getStatusSegments('test-scope')).not.toBe(first);
    expect(getStatusSegments('test-scope')[0].text).toBe('two');

    expect(getStatusSegments('other-scope')).toEqual([]);
  });
});
