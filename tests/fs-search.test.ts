import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskApiError } from '../src/server/apiValidation.js';
import { createDeskApiMiddleware } from '../src/server/deskApiRouter.js';
import { handleFsRequest } from '../src/server/fsApi.js';
import { fsSearchFiles } from '../src/web/editor/fsClient.js';
import {
  parseRipgrepJson,
  RipgrepUnavailableError,
  scoreFuzzyPath,
  searchContent,
  searchFiles,
  SEARCH_RESULT_CAP
} from '../src/server/fsSearch.js';

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

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-search-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git/config'), 'needle noise');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'const needle = 1;\nplain line\n');
  writeFileSync(join(root, '.hidden.txt'), 'needle here too');
  return root;
}

// Search has exactly one engine. These run the real ripgrep the host provides;
// there is no second implementation for them to fall through to, so a host
// without rg fails this file loudly instead of passing on a weaker walker.
describe('ripgrep-backed search over a real tree', () => {
  let root: string;
  beforeEach(() => {
    root = makeTree();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('searchFiles ranks the fuzzy hit first, lists hidden files, and skips .git', async () => {
    const result = await searchFiles(root, 'appts');
    expect(result.matches[0]?.path).toBe('src/app.ts');
    const all = await searchFiles(root, '');
    const paths = all.matches.map((match) => match.path);
    expect(paths).toContain('.hidden.txt');
    expect(paths.some((path) => path.startsWith('.git/'))).toBe(false);
    expect(all.truncated).toBe(false);
  });

  it('searchContent reports 1-based positions, includes hidden files, and skips .git', async () => {
    const result = await searchContent(root, 'needle');
    expect(result.matches).toContainEqual({ path: 'src/app.ts', line: 1, column: 7, text: 'const needle = 1;' });
    expect(result.matches.some((match) => match.path === '.hidden.txt')).toBe(true);
    expect(result.matches.some((match) => match.path.startsWith('.git/'))).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('searchContent caps the result at SEARCH_RESULT_CAP and says so', async () => {
    // rg is invoked with --max-count 20 per file, so the cap needs many files.
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(root, `many-${index}.txt`), Array.from({ length: 20 }, () => 'needle line').join('\n'));
    }
    const result = await searchContent(root, 'needle');
    expect(result.matches.length).toBe(SEARCH_RESULT_CAP);
    expect(result.truncated).toBe(true);
  });

  it('a run cut short by the output cap is reported as truncated even when few matches were parsed', async () => {
    // The 8 MB output cap kills a runaway rg and keeps what arrived. Before this
    // pin, `truncated` was derived from the result cap alone, so a file list or
    // match stream cut at the byte cap came back with `truncated: false` — a
    // partial answer presented as the whole. The cap is injectable so the test
    // can hit it with a small tree instead of eight megabytes of paths.
    mkdirSync(join(root, 'wide'));
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(root, 'wide', `entry-${index}-${'x'.repeat(48)}.txt`), 'needle\n');
    }
    const files = await searchFiles(root, 'entry', { outputCapBytes: 256 });
    expect(files.truncated).toBe(true);
    const content = await searchContent(root, 'needle', { outputCapBytes: 256 });
    expect(content.truncated).toBe(true);
    // The same tree under the real cap is complete, and says so.
    const whole = await searchFiles(root, 'entry');
    expect(whole.matches.length).toBe(200);
    expect(whole.truncated).toBe(false);
  });
});

describe('search without ripgrep on PATH', () => {
  let root: string;
  let emptyBin: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    root = makeTree();
    emptyBin = mkdtempSync(join(tmpdir(), 'desk-no-rg-'));
    savedPath = process.env.PATH;
    process.env.PATH = emptyBin;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('searchFiles refuses by name instead of degrading to a weaker engine', async () => {
    const failure = await searchFiles(root, 'app').then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(RipgrepUnavailableError);
    expect(failure).toBeInstanceOf(DeskApiError);
    expect(failure).toMatchObject({ statusCode: 503, code: 'ripgrep-required' });
    expect((failure as Error).message).toMatch(/ripgrep/);
    expect((failure as Error).message).toMatch(/install/);
    expect((failure as Error).message).toMatch(/ENOENT/);
  });

  it('searchContent refuses the same way', async () => {
    await expect(searchContent(root, 'needle')).rejects.toMatchObject({ statusCode: 503, code: 'ripgrep-required' });
  });

  it('a present but non-executable rg is reported as such, not as absent', async () => {
    writeFileSync(join(emptyBin, 'rg'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(emptyBin, 'rg'), 0o644);
    const failure = await searchFiles(root, 'app').then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(RipgrepUnavailableError);
    expect((failure as Error).message).toMatch(/EACCES/);
    expect((failure as Error).message).not.toMatch(/ENOENT/);
  });

  it('keeps no memory of the absence: once rg is back on PATH the next search runs', async () => {
    await expect(searchFiles(root, 'app')).rejects.toBeInstanceOf(RipgrepUnavailableError);
    process.env.PATH = savedPath;
    const result = await searchFiles(root, 'appts');
    expect(result.matches[0]?.path).toBe('src/app.ts');
  });

  it('the /api/fs/search route answers 503 with the named code the client shows verbatim', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const middleware = createDeskApiMiddleware([(req, res, url) => handleFsRequest(req, res, url)]);
    const req = { method: 'GET', url: `/api/fs/search?root=${encodeURIComponent(root)}&q=app&mode=files` } as IncomingMessage;
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      body: undefined as string | undefined,
      end(body?: string) {
        this.body = body;
      }
    };
    await middleware(req, res as unknown as ServerResponse, vi.fn());
    expect(res.statusCode).toBe(503);
    const payload = JSON.parse(res.body ?? '{}') as { error?: string; code?: string };
    expect(payload.code).toBe('ripgrep-required');
    expect(payload.error).toMatch(/ripgrep/);

    // The last link: the browser client turns that body into the message the
    // search panel hands to the error toast — the server's own words, not a
    // generic "request failed (503)".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => res.body ?? '' }) as unknown as Response)
    );
    await expect(fsSearchFiles(root, 'app')).rejects.toThrow(payload.error);
    vi.unstubAllGlobals();
  });
});
