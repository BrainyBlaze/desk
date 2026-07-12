import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `desk init` must never silently destroy an existing config (finding C1). We
// invoke the real CLI in a subprocess so the test exercises exactly the command
// a user runs — the module has import-time side effects that preclude importing
// main() directly.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = join(repoRoot, 'src', 'cli', 'main.ts');

function runInit(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(tsx, [cliEntry, 'init', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
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
