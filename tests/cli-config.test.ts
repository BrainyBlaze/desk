import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

// `desk config` must print the manifest path even when the manifest is corrupt
// (finding N13) — it is exactly the command a user needs to find the file to fix.
// Driven in-process via main().
function runConfig(manifest: string): { code: number; stdout: string } {
  const out: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line = '') => out.push(String(line)));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return { code: main(['config', '--file', manifest]), stdout: out.join('\n') };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
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
