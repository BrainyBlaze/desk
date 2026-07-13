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

const releaseTagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const digestPattern = /^[0-9a-f]{64}$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function createInstallManifest({ version, sourceAsset, sourceSha256, toolchains }) {
  return {
    schemaVersion: 1,
    version: validateReleaseVersion(version),
    source: {
      asset: validateAsset(sourceAsset, 'source asset'),
      sha256: validateDigest(sourceSha256, 'source digest')
    },
    node: structuredClone(validateToolchains(toolchains).node),
    bun: structuredClone(toolchains.bun)
  };
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

  const packageJson = JSON.parse(readFileSync(join(canonicalRoot, 'package.json'), 'utf8'));
  if (`v${packageJson.version}` !== releaseVersion) {
    throw new Error(`release ${releaseVersion} does not match package.json v${packageJson.version}`);
  }

  const toolchains = JSON.parse(
    readFileSync(join(canonicalRoot, 'scripts', 'distribution', 'toolchains.json'), 'utf8')
  );
  validateToolchains(toolchains);
  const commit = resolveCommit(canonicalRoot, ref);
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
      ':(exclude)src/server/assets/*.tar.gz'
    ]);
    const sourcePath = join(stagedOutput, sourceAsset);
    writeFileSync(sourcePath, gzipSync(readFileSync(sourceTar), { level: 9, mtime: 0 }));

    const manifest = createInstallManifest({
      version: releaseVersion,
      sourceAsset,
      sourceSha256: sha256(sourcePath),
      toolchains
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
