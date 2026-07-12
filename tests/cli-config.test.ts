import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `desk config` must print the manifest path even when the manifest is corrupt
// (finding N13) — it is exactly the command a user needs to find the file to
// fix. It must run before the manifest is parsed.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = join(repoRoot, 'src', 'cli', 'main.ts');

function runConfig(manifest: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(tsx, [cliEntry, 'config', '--file', manifest], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('desk config', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-config-'));
    manifest = join(dir, 'desk.yml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the path even when the manifest is unparseable', () => {
    writeFileSync(manifest, 'groups: [oops\n'); // invalid YAML
    const res = runConfig(manifest);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(manifest);
  });
});
