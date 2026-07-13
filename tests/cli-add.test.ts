import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

// `desk add` must validate --agent at the write boundary (finding C5): an
// unsupported agent was written to the config and then bricked every later
// command. Driven in-process via main() (subprocess-per-case was flaky under
// full-suite parallel load).
function runAdd(args: string[]): { code: number; stderr: string } {
  const errors: string[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return { code: main(['add', ...args]), stderr: errors.join('\n') };
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
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
