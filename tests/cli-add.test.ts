import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `desk add` must validate --agent at the write boundary (finding C5): an
// unsupported agent was written to the config and then bricked every later
// command on load. Subprocess-invoked so it exercises the real CLI.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = join(repoRoot, 'src', 'cli', 'main.ts');

function runAdd(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync(tsx, [cliEntry, 'add', ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stderr: e.stderr ?? '' };
  }
}

describe('desk add --agent validation', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-add-'));
    manifest = join(dir, 'desk.yml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an unsupported agent and does not write the config (no brick)', () => {
    const res = runAdd(['--file', manifest, '--group', 'g', '--name', 'n', '--cwd', '/tmp', '--agent', 'gemini', '--resume', 'x']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unsupported --agent 'gemini'");
    expect(existsSync(manifest)).toBe(false);
  });

  it('accepts a supported agent', () => {
    const res = runAdd(['--file', manifest, '--group', 'g', '--name', 'n', '--cwd', '/tmp', '--agent', 'claude', '--resume', 'x']);
    expect(res.code).toBe(0);
    expect(existsSync(manifest)).toBe(true);
  });
});
