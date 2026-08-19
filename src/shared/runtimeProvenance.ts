import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { writeTextFileAtomic } from './atomicFile.js';
import { classifyPackageRoot, type DeskPackageKind } from './packageRoot.js';

const SOURCE_FINGERPRINT_INPUTS = [
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'src',
  'scripts/build-standalone.ts',
  'scripts/make-assets.mjs'
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STANDALONE_PROVENANCE_SCHEMA_VERSION = 1;

export interface StandaloneBuildProvenance {
  schemaVersion: 1;
  sourceFingerprint: string;
}

export type StandaloneBuildState =
  | { state: 'missing' }
  | { state: 'invalid'; error: string }
  | {
      state: 'current' | 'stale';
      builtSourceFingerprint: string;
      currentSourceFingerprint: string;
    };

export type ManagedReleaseProvenance =
  | { state: 'unmanaged' }
  | { state: 'invalid'; error: string }
  | {
      state: 'managed';
      schemaVersion: 2;
      version: string;
      installId: string;
      target: string;
      sourceSha256: string;
    };

export type RuntimeProvenance =
  | {
      schemaVersion: 1;
      packageKind: 'source';
      runtimeKind: 'vite' | 'standalone';
      version: string;
      sourceFingerprint: string;
      standaloneBuild: StandaloneBuildState;
    }
  | {
      schemaVersion: 1;
      packageKind: 'distribution';
      runtimeKind: 'standalone';
      version: string;
      release: ManagedReleaseProvenance;
    };

function normalizedRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function appendFingerprintEntry(hash: ReturnType<typeof createHash>, root: string, path: string): void {
  const stat = lstatSync(path);
  const relativePath = normalizedRelativePath(root, path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      appendFingerprintEntry(hash, root, join(path, name));
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`runtime source inputs must not contain symbolic links: ${relativePath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`unsupported runtime source input ${relativePath}`);
  }

  const content = readFileSync(path);
  hash.update(`file:${relativePath.length}:${relativePath}:${content.byteLength}:`);
  hash.update(content);
  hash.update('\n');
}

export function computeRuntimeSourceFingerprint(root: string): string {
  if (classifyPackageRoot(root) !== 'source') {
    throw new Error(`runtime source fingerprint requires a complete source checkout at ${root}`);
  }

  const hash = createHash('sha256');
  hash.update('desk-runtime-source-v1\n');
  for (const relativePath of SOURCE_FINGERPRINT_INPUTS) {
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      throw new Error(`runtime source input is missing: ${relativePath}`);
    }
    appendFingerprintEntry(hash, root, path);
  }
  return hash.digest('hex');
}

export function standaloneProvenancePath(executable: string): string {
  return `${executable}.provenance.json`;
}

export function writeStandaloneBuildProvenance(
  executable: string,
  sourceFingerprint: string
): void {
  if (!SHA256_PATTERN.test(sourceFingerprint)) {
    throw new Error('standalone source fingerprint must be a lowercase SHA-256 digest');
  }
  const provenance: StandaloneBuildProvenance = {
    schemaVersion: STANDALONE_PROVENANCE_SCHEMA_VERSION,
    sourceFingerprint
  };
  writeTextFileAtomic(
    standaloneProvenancePath(executable),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
}

function parseStandaloneBuildProvenance(value: unknown): StandaloneBuildProvenance {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== STANDALONE_PROVENANCE_SCHEMA_VERSION ||
    typeof (value as { sourceFingerprint?: unknown }).sourceFingerprint !== 'string' ||
    !SHA256_PATTERN.test((value as { sourceFingerprint: string }).sourceFingerprint)
  ) {
    throw new Error('expected schemaVersion 1 and a lowercase SHA-256 sourceFingerprint');
  }
  return value as StandaloneBuildProvenance;
}

export function inspectStandaloneBuildProvenance(root: string): StandaloneBuildState {
  const executable = join(root, 'libexec', 'desk-standalone');
  const path = standaloneProvenancePath(executable);
  if (!existsSync(executable) || !existsSync(path)) {
    return { state: 'missing' };
  }

  let provenance: StandaloneBuildProvenance;
  try {
    provenance = parseStandaloneBuildProvenance(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return {
      state: 'invalid',
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const currentSourceFingerprint = computeRuntimeSourceFingerprint(root);
  return {
    state: provenance.sourceFingerprint === currentSourceFingerprint ? 'current' : 'stale',
    builtSourceFingerprint: provenance.sourceFingerprint,
    currentSourceFingerprint
  };
}

export function assertCurrentStandaloneBuild(root: string): void {
  const provenance = inspectStandaloneBuildProvenance(root);
  if (provenance.state === 'current') {
    return;
  }
  if (provenance.state === 'missing') {
    throw new Error('Standalone runtime provenance is missing; run npm run build:standalone');
  }
  if (provenance.state === 'invalid') {
    throw new Error('Standalone runtime provenance is invalid; run npm run build:standalone');
  }
  throw new Error('Standalone runtime is stale for this source checkout; run npm run build:standalone');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`expected non-empty ${field}`);
  }
  return value;
}

export function readManagedReleaseProvenance(root: string): ManagedReleaseProvenance {
  const path = join(root, '.desk-release');
  if (!existsSync(path)) {
    return { state: 'unmanaged' };
  }

  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (value.schemaVersion !== 2 || value.managedBy !== 'desk-installer') {
      throw new Error('expected desk-installer schemaVersion 2 metadata');
    }
    const sourceSha256 = requiredString(value.sourceSha256, 'sourceSha256');
    if (!SHA256_PATTERN.test(sourceSha256)) {
      throw new Error('expected sourceSha256 to be a lowercase SHA-256 digest');
    }
    return {
      state: 'managed',
      schemaVersion: 2,
      version: requiredString(value.version, 'version'),
      installId: requiredString(value.installId, 'installId'),
      target: requiredString(value.target, 'target'),
      sourceSha256
    };
  } catch (error) {
    return {
      state: 'invalid',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function packageVersion(root: string): string {
  const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return requiredString(value.version, 'package version');
}

function sourceRuntimeKind(env: NodeJS.ProcessEnv): 'vite' | 'standalone' {
  return env.DESK_RUNTIME_MODE === 'standalone' ? 'standalone' : 'vite';
}

export function resolveRuntimeProvenance(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeProvenance {
  const packageKind: DeskPackageKind = classifyPackageRoot(root);
  const version = packageVersion(root);
  if (packageKind === 'source') {
    return {
      schemaVersion: 1,
      packageKind,
      runtimeKind: sourceRuntimeKind(env),
      version,
      sourceFingerprint: computeRuntimeSourceFingerprint(root),
      standaloneBuild: inspectStandaloneBuildProvenance(root)
    };
  }
  return {
    schemaVersion: 1,
    packageKind,
    runtimeKind: 'standalone',
    version,
    release: readManagedReleaseProvenance(root)
  };
}
