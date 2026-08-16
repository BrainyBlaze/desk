import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGitRequest } from '../src/server/gitApi.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Git API POSIX paths', () => {
  it('preserves a literal backslash in a repository filename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-git-posix-path-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'a\\b'), 'tracked\n');
    execFileSync('git', ['add', '--', 'a\\b'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=Desk', '-c', 'user.email=desk@example.invalid', 'commit', '-qm', 'seed'],
      { cwd: repo }
    );

    const url = new URL('http://desk.test/api/git/log');
    url.searchParams.set('root', root);
    url.searchParams.set('repo', repo);
    url.searchParams.set('path', 'a\\b');
    let body = '';
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string | Buffer) => {
        body = chunk?.toString() ?? '';
      })
    } as unknown as ServerResponse;

    const handled = await handleGitRequest({ method: 'GET' } as IncomingMessage, response, url);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(body).commits).toHaveLength(1);
  });
});
