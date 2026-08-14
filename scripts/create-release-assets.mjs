#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { MOOR_PIN_SCHEMA_VERSION } from './fetch-moor.mjs';

const releaseTagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const digestPattern = /^[0-9a-f]{64}$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const commitPattern = /^[0-9a-f]{40}$/;
const MOOR_REPOSITORY = 'https://github.com/BrainyBlaze/moor';
const MOOR_VERSION = 'v0.1.0';
const MAX_MOOR_BYTES = 64 * 1024 * 1024;
const MOOR_ASSETS = {
  'x86_64-unknown-linux-musl': 'moor-0.1.0-linux-x64',
  'aarch64-unknown-linux-musl': 'moor-0.1.0-linux-arm64',
  'x86_64-apple-darwin': 'moor-0.1.0-macos-x64',
  'aarch64-apple-darwin': 'moor-0.1.0-macos-arm64',
  'x86_64-pc-windows-msvc': 'moor-0.1.0-windows-x64.exe',
  'aarch64-pc-windows-msvc': 'moor-0.1.0-windows-arm64.exe'
};

export function validateReleaseVersion(value) {
  if (typeof value !== 'string' || !releaseTagPattern.test(value)) {
    throw new Error(`release version must be a canonical vX.Y.Z tag: ${String(value)}`);
  }
  return value;
}

function validateAsset(value, label) {
  if (typeof value !== 'string' || !assetPattern.test(value)) {
    throw new Error(`${label} must be a canonical asset basename`);
  }
  return value;
}

function validateDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validateExactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  ) {
    throw new Error(`${label} has invalid keys`);
  }
  return value;
}

export function validateMoorPin(moor) {
  // desk#60: the pin carries the release manifest's coverage, so a candidate
  // whose closure was narrowed cannot be published as though the full frozen
  // matrix stood behind it. A legacy v1 pin cannot state that at all and is
  // refused by name — a release asset must never be built from a pin that
  // cannot say what verified it.
  // The version is checked BEFORE the key set, or a legacy pin — which is
  // missing `coverage` precisely because it predates it — reports a generic
  // key mismatch and hides the one fact that matters.
  if (moor?.schemaVersion !== MOOR_PIN_SCHEMA_VERSION) {
    throw new Error(
      moor.schemaVersion === 1
        ? 'Moor pin schemaVersion 1 predates release coverage: re-project it from the release manifest'
        : `Moor pin schemaVersion must be ${MOOR_PIN_SCHEMA_VERSION}`
    );
  }
  validateExactKeys(
    moor,
    ['schemaVersion', 'repository', 'version', 'commit', 'coverage', 'targets'],
    'Moor pin'
  );
  // A published release is a full-matrix claim. A narrowed candidate may be
  // installed by a developer who accepts it explicitly, but it is never baked
  // into release assets end users receive.
  if (moor.coverage?.requiredClosure !== 'full-matrix') {
    throw new Error(
      `Moor pin closure must be full-matrix to publish a release; got ${JSON.stringify(moor.coverage?.requiredClosure)}`
    );
  }
  validateExactKeys(moor.coverage, ['requiredClosure'], 'Moor pin coverage');
  if (moor.repository !== MOOR_REPOSITORY || moor.version !== MOOR_VERSION) {
    throw new Error(`Moor pin must select ${MOOR_REPOSITORY} ${MOOR_VERSION}`);
  }
  if (typeof moor.commit !== 'string' || !commitPattern.test(moor.commit)) {
    throw new Error('Moor pin commit must be 40 lowercase hexadecimal characters');
  }
  validateExactKeys(moor.targets, Object.keys(MOOR_ASSETS), 'Moor pin targets');
  for (const [target, expectedAsset] of Object.entries(MOOR_ASSETS)) {
    const entry = validateExactKeys(moor.targets[target], ['asset', 'size', 'sha256'], `Moor ${target}`);
    if (entry.asset !== expectedAsset) {
      throw new Error(`Moor ${target} asset must be ${expectedAsset}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_MOOR_BYTES) {
      throw new Error(`Moor ${target} size must be a positive integer no greater than ${MAX_MOOR_BYTES}`);
    }
    validateDigest(entry.sha256, `Moor ${target} sha256`);
  }
  return moor;
}

function validateToolchains(toolchains) {
  if (toolchains?.schemaVersion !== 1) {
    throw new Error('toolchain manifest schemaVersion must be 1');
  }
  if (toolchains.node?.version !== '22.23.1' || toolchains.node?.npmVersion !== '10.9.8') {
    throw new Error('toolchain manifest must pin Node 22.23.1 with npm 10.9.8');
  }
  if (toolchains.bun?.version !== '1.3.14' || toolchains.bun?.tag !== 'bun-v1.3.14') {
    throw new Error('toolchain manifest must pin Bun 1.3.14');
  }
  for (const [kind, definition] of [
    ['node', toolchains.node],
    ['bun', toolchains.bun]
  ]) {
    for (const [target, entry] of Object.entries(definition.targets ?? {})) {
      if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(target)) {
        throw new Error(`unsupported ${kind} target in manifest: ${target}`);
      }
      validateAsset(entry.asset, `${kind}.${target}.asset`);
      validateDigest(entry.sha256, `${kind}.${target}.sha256`);
      const expectedLibc = target.startsWith('linux-') ? 'glibc' : 'system';
      if (entry.libc !== expectedLibc) {
        throw new Error(`${kind}.${target}.libc must be ${expectedLibc}`);
      }
    }
  }
  return toolchains;
}

export function createInstallManifest({ version, sourceAsset, sourceSha256, toolchains, moor }) {
  return {
    schemaVersion: 2,
    version: validateReleaseVersion(version),
    source: {
      asset: validateAsset(sourceAsset, 'source asset'),
      sha256: validateDigest(sourceSha256, 'source digest')
    },
    node: structuredClone(validateToolchains(toolchains).node),
    bun: structuredClone(toolchains.bun),
    moor: structuredClone(validateMoorPin(moor))
  };
}

function parseCanonicalJson(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (`${JSON.stringify(value, null, 2)}\n` !== source) {
    throw new Error(`${label} must use canonical two-space JSON with unique ordered keys and one final LF`);
  }
  return value;
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 << 20
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.error?.message ?? result.stderr).trim()}`);
  }
  return result.stdout.trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireCleanRepository(root) {
  const status = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') {
    throw new Error(`release source must be a clean checkout; dirty or untracked paths found:\n${status}`);
  }
}

function resolveCommit(root, ref) {
  const commit = runGit(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error(`release ref did not resolve to a commit: ${ref}`);
  }
  return commit;
}

function readGitFile(root, commit, path) {
  const result = spawnSync('git', ['show', '--no-textconv', `${commit}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 << 20
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `release commit does not contain ${path}: ${(result.error?.message ?? result.stderr).trim()}`
    );
  }
  return result.stdout;
}

function requireEmptyOutput(outDir) {
  if (!existsSync(outDir)) {
    return;
  }
  if (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length !== 0) {
    throw new Error(`release output directory must be absent or empty: ${outDir}`);
  }
}

export function writeReleaseAssets({ root, version, outDir, ref = 'HEAD' }) {
  const canonicalRoot = resolve(root);
  const canonicalOut = resolve(outDir);
  const releaseVersion = validateReleaseVersion(version);
  requireCleanRepository(canonicalRoot);
  requireEmptyOutput(canonicalOut);
  const commit = resolveCommit(canonicalRoot, ref);

  const packageJson = JSON.parse(readGitFile(canonicalRoot, commit, 'package.json'));
  if (`v${packageJson.version}` !== releaseVersion) {
    throw new Error(`release ${releaseVersion} does not match package.json v${packageJson.version}`);
  }

  const toolchains = JSON.parse(readGitFile(canonicalRoot, commit, 'scripts/distribution/toolchains.json'));
  validateToolchains(toolchains);
  const moor = parseCanonicalJson(
    readGitFile(canonicalRoot, commit, 'scripts/distribution/moor-pin.json'),
    'Moor distribution pin'
  );
  validateMoorPin(moor);
  const sourceAsset = `desk-${releaseVersion}-source.tar.gz`;
  const outputParent = dirname(canonicalOut);
  mkdirSync(outputParent, { recursive: true });
  const staging = mkdtempSync(join(outputParent, '.desk-release-assets-'));
  const stagedOutput = join(staging, 'payload');
  mkdirSync(stagedOutput);

  try {
    const sourceTar = join(staging, 'source.tar');
    runGit(canonicalRoot, [
      'archive',
      '--format=tar',
      `--prefix=desk-${releaseVersion}/`,
      `--output=${sourceTar}`,
      commit,
      '--',
      '.',
      ':(exclude).git',
      ':(exclude)node_modules',
      ':(exclude)dist',
      ':(exclude)libexec',
      ':(exclude)vendor/moor',
      ':(exclude)src/server/assets/*.tar.gz'
    ]);
    const sourcePath = join(stagedOutput, sourceAsset);
    writeFileSync(sourcePath, gzipSync(readFileSync(sourceTar), { level: 9, mtime: 0 }));

    const manifest = createInstallManifest({
      version: releaseVersion,
      sourceAsset,
      sourceSha256: sha256(sourcePath),
      toolchains,
      moor
    });
    const manifestPath = join(stagedOutput, 'desk-install-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

    const checksumEntries = [sourceAsset, 'desk-install-manifest.json']
      .sort()
      .map((name) => `${sha256(join(stagedOutput, name))}  ${name}`);
    writeFileSync(join(stagedOutput, 'SHA256SUMS'), `${checksumEntries.join('\n')}\n`, { mode: 0o644 });

    if (existsSync(canonicalOut)) {
      rmSync(canonicalOut, { recursive: true });
    }
    renameSync(stagedOutput, canonicalOut);
    return {
      manifest: join(canonicalOut, 'desk-install-manifest.json'),
      checksums: join(canonicalOut, 'SHA256SUMS'),
      source: join(canonicalOut, sourceAsset)
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { root: process.cwd(), ref: 'HEAD' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--root', '--version', '--ref', '--out-dir'].includes(flag)) {
      throw new Error(`unexpected release asset argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value === '') {
      throw new Error(`${flag} requires a value`);
    }
    const key = flag === '--out-dir' ? 'outDir' : flag.slice(2);
    if (options[key] !== undefined && !['root', 'ref'].includes(key)) {
      throw new Error(`${flag} may be specified only once`);
    }
    options[key] = value;
    index += 1;
  }
  if (options.version === undefined || options.outDir === undefined) {
    throw new Error('--version and --out-dir are required');
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = writeReleaseAssets(parseArguments(process.argv.slice(2)));
    console.log(`release assets written to ${dirname(output.source)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
