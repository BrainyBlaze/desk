#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUT = join(ROOT, 'src', 'server', 'agents', 'codexBindings');
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

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

export function projectionDigest(root) {
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

function parseArgs(argv) {
  const options = {
    codexBin: process.env.CODEX_BIN || 'codex',
    outDir: DEFAULT_OUT,
    updateVersion: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--codex') {
      options.codexBin = argv[++index];
    } else if (arg === '--out') {
      options.outDir = resolve(argv[++index]);
    } else if (arg === '--update-version') {
      options.updateVersion = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.codexBin || !options.outDir) {
    throw new Error('--codex and --out require values');
  }
  return options;
}

function codexVersion(codexBin) {
  const result = spawnSync(codexBin, ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    throw new Error(`codex --version failed: ${detail}`);
  }
  const version = result.stdout.trim();
  if (!/^codex-cli\s+\S+$/.test(version)) {
    throw new Error(`unexpected codex version output: ${version}`);
  }
  return version;
}

function pinnedVersion(outDir) {
  const source = readFileSync(join(outDir, 'version.ts'), 'utf8');
  const match = /CODEX_APP_SERVER_BINDINGS_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(source);
  if (!match) throw new Error('reviewed bindings are missing a valid version pin');
  return match[1];
}

function validateReviewedProjection(outDir) {
  const expected = readFileSync(join(outDir, DIGEST_FILE), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`reviewed bindings are missing a valid ${DIGEST_FILE}`);
  }
  const actual = projectionDigest(outDir);
  if (actual !== expected) {
    throw new Error(`reviewed projection digest mismatch: expected ${expected}, got ${actual}`);
  }

  const clientRequest = readFileSync(join(outDir, 'ClientRequest.ts'), 'utf8');
  for (const method of REQUIRED_METHODS) {
    if (!clientRequest.includes(`"method": "${method}"`)) {
      throw new Error(`reviewed bindings are missing required method: ${method}`);
    }
  }
}

function check(options) {
  if (options.updateVersion) {
    throw new Error(
      'automatic binding updates are disabled; create and approve a manual reviewed projection'
    );
  }
  const version = codexVersion(options.codexBin);
  const pinned = pinnedVersion(options.outDir);
  if (pinned !== version) {
    throw new Error(
      `version mismatch: reviewed bindings use ${pinned}, but ${options.codexBin} is ${version}; ` +
        'create and approve a manual reviewed projection before changing the pin'
    );
  }
  validateReviewedProjection(options.outDir);
  process.stdout.write(`checked reviewed Codex app-server bindings with ${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codex-bindings-check: ${message}\n`);
    process.exitCode = 1;
  }
}
