import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CHECKER = fileURLToPath(new URL('../scripts/generate-codex-bindings.mjs', import.meta.url));
const DIGEST_FILE = 'REVIEWED_PROJECTION.sha256';
const REQUIRED_METHODS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/steer',
  'turn/interrupt'
];

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

function projectionDigest(root: string): string {
  const snapshotRoot = resolve(root);
  const hash = createHash('sha256');
  for (const path of filesUnder(snapshotRoot)) {
    const label = relative(snapshotRoot, path);
    if (label === DIGEST_FILE) continue;
    const labelBytes = Buffer.from(label);
    const contents = readFileSync(path);
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64LE(BigInt(labelBytes.length), 0);
    lengths.writeBigUInt64LE(BigInt(contents.length), 8);
    hash.update(lengths).update(labelBytes).update(contents);
  }
  return hash.digest('hex');
}

describe('reviewed Codex bindings projection', () => {
  let root: string;
  let fakeCodex: string;
  let invocationLog: string;
  let outDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-codex-bindings-check-'));
    fakeCodex = join(root, 'codex-fixture.mjs');
    invocationLog = join(root, 'unexpected-invocations.ndjson');
    outDir = join(root, 'codexBindings');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'ClientRequest.ts'),
      `export type ClientRequest = ${REQUIRED_METHODS.map(
        (method) => `{ "method": "${method}" }`
      ).join(' | ')};\n`
    );
    writeFileSync(
      join(outDir, 'version.ts'),
      "export const CODEX_APP_SERVER_BINDINGS_VERSION = 'codex-cli 1.2.3';\n"
    );
    writeFileSync(join(outDir, 'sentinel.ts'), 'reviewed bindings\n');
    writeFileSync(join(outDir, DIGEST_FILE), `${projectionDigest(outDir)}\n`);
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args.length === 1 && args[0] === '--version') {\n  process.stdout.write('codex-cli 1.2.3\\n');\n  process.exit(0);\n}\nappendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + '\\n');\nprocess.exit(2);\n`,
      { mode: 0o755 }
    );
    chmodSync(fakeCodex, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(...args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [CHECKER, '--codex', fakeCodex, '--out', outDir, ...args], {
      encoding: 'utf8'
    });
  }

  it('checks the pinned reviewed projection without regenerating it', () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('checked reviewed Codex app-server bindings with codex-cli 1.2.3');
    expect(readFileSync(join(outDir, 'sentinel.ts'), 'utf8')).toBe('reviewed bindings\n');
    expect(existsSync(invocationLog)).toBe(false);
  });

  it('refuses an unapproved Codex CLI version change without touching the projection', () => {
    writeFileSync(
      join(outDir, 'version.ts'),
      "export const CODEX_APP_SERVER_BINDINGS_VERSION = 'codex-cli 1.2.2';\n"
    );
    writeFileSync(join(outDir, DIGEST_FILE), `${projectionDigest(outDir)}\n`);

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('version mismatch');
    expect(readFileSync(join(outDir, 'sentinel.ts'), 'utf8')).toBe('reviewed bindings\n');
    expect(existsSync(invocationLog)).toBe(false);
  });

  it('requires a manual reviewed projection for protocol updates', () => {
    const result = run('--update-version');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manual reviewed projection');
    expect(readFileSync(join(outDir, 'sentinel.ts'), 'utf8')).toBe('reviewed bindings\n');
    expect(existsSync(invocationLog)).toBe(false);
  });

  it('rejects drift from the reviewed projection digest', () => {
    writeFileSync(join(outDir, 'sentinel.ts'), 'unreviewed drift\n');

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reviewed projection digest mismatch');
    expect(existsSync(invocationLog)).toBe(false);
  });
});
