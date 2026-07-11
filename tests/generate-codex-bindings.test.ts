import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GENERATOR = fileURLToPath(new URL('../scripts/generate-codex-bindings.mjs', import.meta.url));
const REQUIRED_METHODS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/steer',
  'turn/interrupt'
];

describe('Codex bindings generator', () => {
  let root: string;
  let fakeCodex: string;
  let outDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-codex-generator-'));
    fakeCodex = join(root, 'codex-fixture.mjs');
    outDir = join(root, 'codexBindings');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'version.ts'), "export const CODEX_APP_SERVER_BINDINGS_VERSION = 'codex-cli 1.2.2';\n");
    writeFileSync(join(outDir, 'sentinel.ts'), 'old bindings\n');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 1.2.3\\n');
  process.exit(0);
}
const outIndex = args.indexOf('--out');
if (args[0] !== 'app-server' || args[1] !== 'generate-ts' || !args.includes('--experimental') || outIndex < 0) {
  process.stderr.write('unexpected arguments: ' + args.join(' '));
  process.exit(2);
}
const out = args[outIndex + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'ClientRequest.ts'), ${JSON.stringify(REQUIRED_METHODS.map((method) => `"method": "${method}"`).join('\n'))});
writeFileSync(join(out, 'index.ts'), '// GENERATED CODE! DO NOT MODIFY BY HAND!\\n');
`,
      { mode: 0o755 }
    );
    chmodSync(fakeCodex, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(...args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [GENERATOR, '--codex', fakeCodex, '--out', outDir, ...args], {
      encoding: 'utf8'
    });
  }

  it('refuses an unapproved Codex CLI version change without touching checked bindings', () => {
    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('version mismatch');
    expect(readFileSync(join(outDir, 'sentinel.ts'), 'utf8')).toBe('old bindings\n');
  });

  it('regenerates atomically and updates the pin when explicitly approved', () => {
    const result = run('--update-version');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('generated Codex app-server bindings with codex-cli 1.2.3');
    expect(readFileSync(join(outDir, 'version.ts'), 'utf8')).toContain('codex-cli 1.2.3');
    expect(readFileSync(join(outDir, 'ClientRequest.ts'), 'utf8')).toContain('"method": "turn/start"');
    expect(() => readFileSync(join(outDir, 'sentinel.ts'), 'utf8')).toThrow();
  });
});
