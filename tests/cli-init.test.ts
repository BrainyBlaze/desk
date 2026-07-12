import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

// `desk init` must never silently destroy an existing config (finding C1). Driven
// in-process via main() with console spies (a subprocess-per-case was flaky under
// full-suite parallel load — many concurrent tsx spawns).
function runInit(args: string[]): { code: number; stderr: string } {
  const errors: string[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return { code: main(['init', ...args]), stderr: errors.join('\n') };
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
  }
}

const POPULATED = 'groups:\n  - id: g\n    label: G\n    sessions:\n      - name: n\n        cwd: /tmp\n        command: bash\n';

describe('desk init', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-init-'));
    manifest = join(dir, 'desk.yml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing config and leaves it untouched', () => {
    writeFileSync(manifest, POPULATED);
    const res = runInit(['--file', manifest]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('already exists');
    // The original config is intact — no data loss.
    expect(readFileSync(manifest, 'utf8')).toBe(POPULATED);
    expect(existsSync(`${manifest}.bak`)).toBe(false);
  });

  it('creates a fresh config when none exists', () => {
    const res = runInit(['--file', manifest]);
    expect(res.code).toBe(0);
    expect(existsSync(manifest)).toBe(true);
    expect(readFileSync(manifest, 'utf8')).not.toContain('id: g');
  });

  it('overwrites with --force but keeps a .bak of the previous config', () => {
    writeFileSync(manifest, POPULATED);
    const res = runInit(['--file', manifest, '--force']);
    expect(res.code).toBe(0);
    // New config is empty; the old one is recoverable from .bak.
    expect(readFileSync(manifest, 'utf8')).not.toContain('id: g');
    expect(readFileSync(`${manifest}.bak`, 'utf8')).toBe(POPULATED);
  });
});
