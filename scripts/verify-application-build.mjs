#!/usr/bin/env node

import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function requireRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`application build is missing ${label}: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`application build ${label} is not a regular file: ${path}`);
  }
  return stat;
}

function requireExecutable(path, label) {
  const stat = requireRegularFile(path, label);
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`application build ${label} is not executable: ${path}`);
  }
}

export async function verifyApplicationBuild(
  root = process.cwd(),
  { requireMoor = false } = {}
) {
  const canonicalRoot = resolve(root);
  const launcher = join(canonicalRoot, 'bin', 'desk.js');
  const cli = join(canonicalRoot, 'dist', 'cli', 'main.js');
  const standalone = join(canonicalRoot, 'libexec', 'desk-standalone');
  const provenance = `${standalone}.provenance.json`;
  const runtimeProvenance = join(
    canonicalRoot,
    'dist',
    'shared',
    'runtimeProvenance.js'
  );

  requireExecutable(launcher, 'bin/desk.js');
  requireExecutable(cli, 'dist/cli/main.js');
  requireExecutable(standalone, 'libexec/desk-standalone');
  requireRegularFile(provenance, 'standalone provenance');
  requireRegularFile(runtimeProvenance, 'runtime provenance module');
  if (requireMoor) requireExecutable(join(canonicalRoot, 'libexec', 'moor'), 'libexec/moor');

  const canonical = await import(pathToFileURL(runtimeProvenance).href);
  if (typeof canonical.assertCurrentStandaloneBuild !== 'function') {
    throw new Error('application build runtime provenance module has no canonical assertion');
  }
  canonical.assertCurrentStandaloneBuild(canonicalRoot);

  const help = spawnSync(process.execPath, [cli, 'help'], {
    cwd: canonicalRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 8 << 20
  });
  if (help.error !== undefined || help.status !== 0) {
    const detail = (help.error?.message ?? help.stderr ?? '').trim();
    throw new Error(`application build CLI smoke failed${detail === '' ? '' : `: ${detail}`}`);
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return { requireMoor: false };
  if (argv.length === 1 && argv[0] === '--require-moor') return { requireMoor: true };
  throw new Error(`unexpected application-build verifier argument: ${argv.join(' ')}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await verifyApplicationBuild(process.cwd(), parseArguments(process.argv.slice(2)));
    console.log('application build contract: verified');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
