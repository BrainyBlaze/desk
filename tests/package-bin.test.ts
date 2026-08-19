import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectDeskCliEntry } from '../bin/desk.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-package-bin-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  return root;
}

function addFile(root: string, relativePath: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Desk package bin selection', () => {
  it('dispatches the source CLI through the package bin', () => {
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const result = spawnSync(process.execPath, [join(repositoryRoot, 'bin', 'desk.js'), 'help'], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: desk <command> [options]');
  });

  it('selects the source CLI when source and stale dist are both present', () => {
    const root = makeRoot();
    const sourceEntry = addFile(root, 'src/cli/main.ts');
    addFile(root, 'vite.config.ts');
    addFile(root, 'dist/cli/main.js');

    expect(selectDeskCliEntry(root)).toEqual({ kind: 'source', entry: sourceEntry });
  });

  it('selects the built CLI for a distribution without source markers', () => {
    const root = makeRoot();
    const builtEntry = addFile(root, 'dist/cli/main.js');

    expect(selectDeskCliEntry(root)).toEqual({ kind: 'built', entry: builtEntry });
  });

  it('fails closed when neither complete source markers nor a built CLI exist', () => {
    const root = makeRoot();
    addFile(root, 'src/cli/main.ts');

    expect(() => selectDeskCliEntry(root)).toThrow(
      'Desk package has neither a complete source checkout nor a built CLI'
    );
  });
});
