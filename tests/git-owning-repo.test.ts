import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOwningRepo } from '../src/server/gitApi';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-own-'));
  // root/repoA/.git (dir), root/repoA/src/deep, root/worktreeB/.git (file), root/plain
  mkdirSync(join(root, 'repoA', '.git'), { recursive: true });
  mkdirSync(join(root, 'repoA', 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'worktreeB'), { recursive: true });
  writeFileSync(join(root, 'worktreeB', '.git'), 'gitdir: /elsewhere\n');
  mkdirSync(join(root, 'plain'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveOwningRepo', () => {
  it('walks up from a nested path to the repo root', () => {
    expect(resolveOwningRepo(join(root, 'repoA', 'src', 'deep'), root)).toBe(join(root, 'repoA'));
    expect(resolveOwningRepo(join(root, 'repoA', 'src', 'deep', 'file.ts'), root)).toBe(join(root, 'repoA'));
  });

  it('returns the repo itself for a repo root path', () => {
    expect(resolveOwningRepo(join(root, 'repoA'), root)).toBe(join(root, 'repoA'));
  });

  it('treats a .git FILE (linked worktree) as a repo', () => {
    expect(resolveOwningRepo(join(root, 'worktreeB'), root)).toBe(join(root, 'worktreeB'));
  });

  it('returns null for paths with no owning repo inside the root', () => {
    expect(resolveOwningRepo(join(root, 'plain'), root)).toBeNull();
    expect(resolveOwningRepo(root, root)).toBeNull();
  });

  it('never escapes the explorer root', () => {
    // tmpdir itself could be inside some repo on a dev machine; the walk must
    // stop at root regardless.
    expect(resolveOwningRepo(join(root, 'plain', 'sub'), root)).toBeNull();
  });
});
