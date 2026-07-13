import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line = '') => output.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  return { code: main(args), stdout: output.join('\n'), stderr: errors.join('\n') };
}

describe('desk CLI without tmux on PATH', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-cli-tmux-missing-'));
    manifest = join(dir, 'desk.yml');
    writeFileSync(
      manifest,
      `groups:
  - id: main
    sessions:
      - name: alpha
        cwd: /tmp
        command: bash
`
    );
    vi.stubEnv('PATH', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails attach honestly when tmux cannot be spawned', () => {
    const result = run(['attach', '--file', manifest, 'alpha']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('tmux not found');
  });

  it('fails status instead of reporting every session as missing', () => {
    const result = run(['status', '--file', manifest]);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('missing');
    expect(result.stderr).toContain('tmux not found');
  });

  it('fails capture honestly when tmux cannot be spawned', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const result = run(['capture', '--file', manifest, 'alpha']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(writes.join('')).toContain('tmux not found');
  });
});
