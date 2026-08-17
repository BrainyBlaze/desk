import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFileAtomic } from '../src/shared/atomicFile';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-atomic-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('writeTextFileAtomic', () => {
  it('writes content, creates parent dirs, and leaves no temp file behind', () => {
    const dir = tmpDir();
    const path = join(dir, 'nested', 'file.json');
    writeTextFileAtomic(path, '{"a":1}');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(join(dir, 'nested')).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('overwrites an existing file', () => {
    const dir = tmpDir();
    const path = join(dir, 'f.txt');
    writeTextFileAtomic(path, 'one');
    writeTextFileAtomic(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
  });
});

