import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line = '') => output.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  return { code: await main(args), stdout: output.join('\n'), stderr: errors.join('\n') };
}

describe('desk CLI native lifecycle', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-cli-native-lifecycle-'));
    manifest = join(dir, 'desk.yml');
    writeFileSync(
      manifest,
      `groups:
  - id: main
    sessions:
      - name: alpha
        cwd: /tmp
        command: bash
        sessionId: alpha
`
    );
    vi.stubEnv('PATH', '');
    vi.stubEnv('DESK_ATCH_BIN', '');
    vi.stubEnv('DESK_ATCH_SOCKET_ROOT', join(dir, 'atch'));
    vi.stubEnv('HOME', dir);
    const defaultManifest = join(dir, '.config', 'desk', 'desk.yml');
    mkdirSync(join(dir, '.config', 'desk'), { recursive: true });
    writeFileSync(defaultManifest, String.raw`groups:
  - id: main
    sessions:
      - name: alpha
        cwd: /tmp
        command: bash
        sessionId: alpha
`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails attach honestly when no atch binary is available', async () => {
    const result = await run(['attach', '--file', manifest, 'alpha']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no atch binary found');
  });

  it('reports status from the canonical atch socket path without requiring the binary', async () => {
    const result = await run(['status', '--file', manifest]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('missing');
    expect(result.stdout).toContain('alpha');
    expect(result.stderr).toBe('');
  });

  it('captures retained output through the daemon instead of a local multiplexer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, lines: ['one', 'two'], totalAvailable: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const result = await run(['capture', '--file', manifest, 'alpha']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(writes.join('')).toBe('one\ntwo\n');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:5178/control/tail',
      expect.objectContaining({ body: JSON.stringify({ sessionId: 'alpha', rows: 200, offset: 0 }) })
    );
  });

  it('routes default-manifest up through the web control plane', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ exitCode: 0, actions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    const result = await run(['up', '--dry-run']);

    expect(result.code).toBe(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/api/up',
      expect.objectContaining({ body: JSON.stringify({ dryRun: true }) })
    );
  });
});
