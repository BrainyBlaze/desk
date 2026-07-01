import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveRootForPath, expandTilde } from '../src/server/fsApi.js';

describe('expandTilde', () => {
  it('expands ~ and ~/path to the home directory; leaves absolute paths alone', () => {
    expect(expandTilde('~')).toBe(homedir());
    expect(expandTilde('~/a/b')).toBe(join(homedir(), 'a/b'));
    expect(expandTilde('/abs/x')).toBe('/abs/x');
  });
});

describe('deriveRootForPath', () => {
  let base: string | undefined;
  afterEach(() => {
    if (base) {
      rmSync(base, { recursive: true, force: true });
      base = undefined;
    }
  });

  it('roots a file at its parent dir when there is no project/git ancestor', () => {
    base = mkdtempSync(join(tmpdir(), 'desk-root-'));
    mkdirSync(join(base, 'a'), { recursive: true });
    writeFileSync(join(base, 'a', 'foo.ts'), 'x');
    expect(deriveRootForPath(join(base, 'a', 'foo.ts'))).toBe(join(base, 'a'));
  });

  it('roots a directory at its PARENT, so the directory is a revealable tree node', () => {
    base = mkdtempSync(join(tmpdir(), 'desk-root-'));
    mkdirSync(join(base, 'a', 'sub'), { recursive: true });
    expect(deriveRootForPath(join(base, 'a', 'sub'))).toBe(join(base, 'a'));
  });

  it('prefers the git root when the target is inside a repo', () => {
    base = mkdtempSync(join(tmpdir(), 'desk-root-'));
    mkdirSync(join(base, '.git'), { recursive: true });
    mkdirSync(join(base, 'a', 'sub'), { recursive: true });
    expect(deriveRootForPath(join(base, 'a', 'sub'))).toBe(base);
    expect(deriveRootForPath(join(base, 'a', 'foo.ts'))).toBe(base);
  });
});
