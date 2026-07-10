import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFileOr, writeTextFileAtomic } from '../src/shared/atomicFile';

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

describe('readJsonFileOr', () => {
  it('parses a valid JSON object', () => {
    const dir = tmpDir();
    const path = join(dir, 'v.json');
    writeFileSync(path, '{"x":true}');
    expect(readJsonFileOr(path, { x: false })).toEqual({ x: true });
  });

  it('returns the fallback for a missing file', () => {
    expect(readJsonFileOr(join(tmpDir(), 'nope.json'), { d: 1 })).toEqual({ d: 1 });
  });

  it('returns the fallback for malformed JSON without throwing', () => {
    const dir = tmpDir();
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not json ');
    expect(readJsonFileOr(path, {})).toEqual({});
  });

  it('returns the fallback for non-object JSON (array or scalar)', () => {
    const dir = tmpDir();
    const arrPath = join(dir, 'arr.json');
    writeFileSync(arrPath, '[1,2,3]');
    expect(readJsonFileOr(arrPath, { ok: true })).toEqual({ ok: true });
    const numPath = join(dir, 'num.json');
    writeFileSync(numPath, '42');
    expect(readJsonFileOr(numPath, { ok: true })).toEqual({ ok: true });
  });
});
