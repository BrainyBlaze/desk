import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRipgrepJson, scoreFuzzyPath, searchContent, searchFiles, walkTextSearch, walkFiles, SEARCH_RESULT_CAP } from '../src/server/fsSearch';

describe('scoreFuzzyPath', () => {
  it('returns -1 when the query is not a subsequence', () => {
    expect(scoreFuzzyPath('zzz', 'src/app.ts')).toBe(-1);
  });

  it('scores basename matches above directory matches', () => {
    const inBase = scoreFuzzyPath('app', 'src/app.ts');
    const inDir = scoreFuzzyPath('app', 'app/index.ts');
    expect(inBase).toBeGreaterThan(inDir);
  });

  it('scores consecutive runs above scattered matches', () => {
    expect(scoreFuzzyPath('abc', 'x/abc.ts')).toBeGreaterThan(scoreFuzzyPath('abc', 'x/a-b-c.ts'));
  });

  it('matches case-insensitively and accepts empty query', () => {
    expect(scoreFuzzyPath('APP', 'src/app.ts')).toBeGreaterThan(0);
    expect(scoreFuzzyPath('', 'src/app.ts')).toBe(0);
  });
});

describe('parseRipgrepJson', () => {
  it('extracts path, line, column and trimmed text from match records', () => {
    const sample = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'const value = 42;\n' },
          line_number: 7,
          submatches: [{ match: { text: 'value' }, start: 6, end: 11 }]
        }
      }),
      JSON.stringify({ type: 'end', data: {} }),
      'not-json'
    ].join('\n');
    const matches = parseRipgrepJson(sample);
    expect(matches).toEqual([{ path: 'src/a.ts', line: 7, column: 7, text: 'const value = 42;' }]);
  });
});

describe('node fallback walkers', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-search-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git/config'), 'noise');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/app.ts'), 'const needle = 1;\nplain line\n');
    writeFileSync(join(root, '.hidden.txt'), 'needle here too');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walkFiles lists hidden files but skips .git', () => {
    const files = walkFiles(root);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('.hidden.txt');
    expect(files.some((file) => file.startsWith('.git/'))).toBe(false);
  });

  it('walkTextSearch finds content matches with positions', () => {
    const matches = walkTextSearch(root, 'needle');
    expect(matches).toContainEqual({ path: 'src/app.ts', line: 1, column: 7, text: 'const needle = 1;' });
    expect(matches.some((match) => match.path === '.hidden.txt')).toBe(true);
  });

  it('searchFiles and searchContent work end-to-end against the temp tree', async () => {
    const files = await searchFiles(root, 'appts');
    expect(files.matches[0]?.path).toBe('src/app.ts');
    const content = await searchContent(root, 'needle');
    expect(content.matches.some((match) => match.path === 'src/app.ts' && match.line === 1)).toBe(true);
  });

  it('walkTextSearch returns at most SEARCH_RESULT_CAP+1 entries when matches exceed the cap', () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 600 }, () => 'needle line').join('\n'));
    const matches = walkTextSearch(root, 'needle');
    expect(matches.length).toBeLessThanOrEqual(SEARCH_RESULT_CAP + 1);
    expect(matches.length).toBe(SEARCH_RESULT_CAP + 1);
  });
});
