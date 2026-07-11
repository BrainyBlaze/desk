#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUT = join(ROOT, 'src', 'server', 'agents', 'codexBindings');
const REQUIRED_METHODS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/steer',
  'turn/interrupt'
];

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

function runCodex(codexBin, args) {
  const result = spawnSync(codexBin, args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    throw new Error(`codex ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function readPinnedVersion(outDir) {
  const versionPath = join(outDir, 'version.ts');
  if (!existsSync(versionPath)) {
    return undefined;
  }
  const match = /CODEX_APP_SERVER_BINDINGS_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(versionPath, 'utf8'));
  return match?.[1];
}

function validateGeneratedBindings(outDir) {
  const clientRequestPath = join(outDir, 'ClientRequest.ts');
  if (!existsSync(clientRequestPath)) {
    throw new Error('generated bindings are missing ClientRequest.ts');
  }
  const clientRequest = readFileSync(clientRequestPath, 'utf8');
  for (const method of REQUIRED_METHODS) {
    if (!clientRequest.includes(`"method": "${method}"`)) {
      throw new Error(`generated bindings are missing required method: ${method}`);
    }
  }
}

function installAtomically(generatedDir, outDir) {
  const backupDir = `${outDir}.backup-${process.pid}-${Date.now()}`;
  const hadCurrent = existsSync(outDir);
  if (hadCurrent) {
    renameSync(outDir, backupDir);
  }
  try {
    renameSync(generatedDir, outDir);
  } catch (error) {
    if (hadCurrent && !existsSync(outDir) && existsSync(backupDir)) {
      renameSync(backupDir, outDir);
    }
    throw error;
  }
  if (hadCurrent) {
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function generate(options) {
  const version = runCodex(options.codexBin, ['--version']);
  if (!/^codex-cli\s+\S+$/.test(version)) {
    throw new Error(`unexpected codex version output: ${version}`);
  }
  const pinnedVersion = readPinnedVersion(options.outDir);
  if (pinnedVersion && pinnedVersion !== version && !options.updateVersion) {
    throw new Error(
      `version mismatch: checked bindings use ${pinnedVersion}, but ${options.codexBin} is ${version}; ` +
        'rerun with --update-version only for an intentional protocol update'
    );
  }

  const parent = dirname(options.outDir);
  mkdirSync(parent, { recursive: true });
  const generatedDir = mkdtempSync(join(parent, '.codexBindings-'));
  try {
    runCodex(options.codexBin, ['app-server', 'generate-ts', '--experimental', '--out', generatedDir]);
    validateGeneratedBindings(generatedDir);
    writeFileSync(
      join(generatedDir, 'version.ts'),
      `export const CODEX_APP_SERVER_BINDINGS_VERSION = ${JSON.stringify(version)};\n`
    );
    installAtomically(generatedDir, options.outDir);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
  process.stdout.write(`generated Codex app-server bindings with ${version}\n`);
}

try {
  generate(parseArgs(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`generate-codex-bindings: ${message}\n`);
  process.exitCode = 1;
}
