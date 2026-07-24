#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_FORK_REPOSITORY = 'https://github.com/BrainyBlaze/atch.git';
const EXPECTED_COMMIT = '0dd332eea478b5415ac54c39bcc1e28c2c9761f3';
const EXPECTED_TREE = '6eb4f166fa972843ed71e888f62cf80601864ceb';
const EXPECTED_VERSION = '1.6-bb1';
const EXPECTED_UPSTREAM_REPOSITORY = 'https://github.com/mobydeck/atch.git';
const EXPECTED_UPSTREAM_BASE = '15e0d3a0912618c08f7a74f85e41cca673b313f0';
const EXPECTED_PATCH_RANGE = `${EXPECTED_UPSTREAM_BASE}..${EXPECTED_COMMIT}`;
const EXPECTED_PATCH_COUNT = 41;
const EXPECTED_SNAPSHOT_DIGEST = '94c43f96fb9b13128e10e15df88c0c2d14eca827af78f2460337f7364608f234';

function snapshotDigest(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (name !== 'PROVENANCE.json') {
        files.push(path);
      }
    }
  };
  visit(root);

  const hash = createHash('sha256');
  for (const path of files) {
    const stat = lstatSync(path);
    const rel = relative(root, path).split(sep).join('/');
    if (stat.isSymbolicLink()) {
      hash.update(`120000 ${rel}\0${readlinkSync(path)}\0`);
    } else {
      hash.update(`${stat.mode & 0o111 ? '100755' : '100644'} ${rel}\0`);
      hash.update(readFileSync(path));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export function verifyAtchSnapshot(vendorRoot) {
  const provenancePath = join(vendorRoot, 'PROVENANCE.json');
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  if (
    provenance?.schemaVersion !== 1 ||
    provenance?.fork?.repository !== EXPECTED_FORK_REPOSITORY ||
    provenance?.fork?.commit !== EXPECTED_COMMIT ||
    provenance?.fork?.tree !== EXPECTED_TREE ||
    provenance?.fork?.version !== EXPECTED_VERSION ||
    provenance?.upstream?.repository !== EXPECTED_UPSTREAM_REPOSITORY ||
    provenance?.upstream?.baseCommit !== EXPECTED_UPSTREAM_BASE ||
    provenance?.patches?.range !== EXPECTED_PATCH_RANGE ||
    provenance?.patches?.count !== EXPECTED_PATCH_COUNT ||
    provenance?.snapshot?.algorithm !== 'sha256' ||
    provenance?.snapshot?.format !== 'git-path-mode-content-v1'
  ) {
    throw new Error('build-atch: unsupported or invalid provenance manifest');
  }
  if (provenance.snapshot.digest !== EXPECTED_SNAPSHOT_DIGEST) {
    throw new Error('build-atch: provenance does not match the pinned snapshot digest');
  }
  const actual = snapshotDigest(vendorRoot);
  if (actual !== provenance.snapshot.digest) {
    throw new Error(
      `build-atch: snapshot digest mismatch (expected ${provenance.snapshot.digest}, got ${actual})`
    );
  }
  return provenance;
}

function commandWorks(command, env) {
  const result = spawnSync(command, ['--version'], {
    env,
    stdio: 'ignore'
  });
  return result.status === 0;
}

function selectCompiler(env) {
  if (env.CC !== undefined && env.CC !== '') {
    if (!commandWorks(env.CC, env)) {
      throw new Error(`build-atch: configured C compiler is not runnable: ${env.CC}`);
    }
    return env.CC;
  }
  for (const candidate of ['cc', 'gcc', 'clang']) {
    if (commandWorks(candidate, env)) {
      return candidate;
    }
  }
  throw new Error('build-atch: no working C compiler found (tried cc, gcc, and clang)');
}

function run(command, args, { cwd, env, label }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 8 << 20
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.error?.message ?? result.stderr ?? result.stdout).trim();
    throw new Error(`build-atch: ${label} failed${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

function probeAtch(path, env) {
  const output = run(path, ['--version'], {
    cwd: dirname(path),
    env,
    label: 'version probe'
  });
  if (!output.startsWith(`atch - version ${EXPECTED_VERSION},`)) {
    throw new Error(`build-atch: unexpected version output: ${output.trim()}`);
  }
}

export async function buildAtch({
  root = DEFAULT_ROOT,
  outfile = join(root, 'libexec', 'atch'),
  env = process.env
} = {}) {
  const canonicalRoot = resolve(root);
  const canonicalOutfile = resolve(outfile);
  const vendorRoot = join(canonicalRoot, 'vendor', 'atch');
  const provenance = verifyAtchSnapshot(vendorRoot);
  const compiler = selectCompiler(env);
  if (!commandWorks('make', env)) {
    throw new Error('build-atch: make is not runnable');
  }

  const buildRoot = mkdtempSync(join(resolve(tmpdir()), 'desk-atch-build-'));
  const sourceRoot = join(buildRoot, 'atch');
  const temporaryOutfile = join(dirname(canonicalOutfile), `.atch-${process.pid}-${randomUUID()}`);

  try {
    cpSync(vendorRoot, sourceRoot, { recursive: true, verbatimSymlinks: true });
    run(
      'make',
      [
        '-C',
        sourceRoot,
        `CC=${compiler}`,
        'STATIC_FLAG=',
        `VERSION=${provenance.fork.version}`,
        'atch'
      ],
      {
        cwd: canonicalRoot,
        env,
        label: 'fork compilation'
      }
    );

    const built = join(sourceRoot, 'atch');
    probeAtch(built, env);
    mkdirSync(dirname(canonicalOutfile), { recursive: true });
    copyFileSync(built, temporaryOutfile);
    chmodSync(temporaryOutfile, 0o755);
    probeAtch(temporaryOutfile, env);
    renameSync(temporaryOutfile, canonicalOutfile);
  } finally {
    if (existsSync(temporaryOutfile)) {
      rmSync(temporaryOutfile, { force: true });
    }
    rmSync(buildRoot, { recursive: true, force: true });
  }

  return canonicalOutfile;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outfile = await buildAtch();
    console.log(`build-atch: wrote ${outfile}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
