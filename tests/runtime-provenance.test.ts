import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvePackageRoot } from '../src/shared/packageRoot.js';
import {
  computeRuntimeSourceFingerprint,
  inspectStandaloneBuildProvenance,
  readManagedReleaseProvenance,
  resolveRuntimeProvenance,
  writeStandaloneBuildProvenance
} from '../src/shared/runtimeProvenance.js';

const roots: string[] = [];

function write(root: string, relativePath: string, content = ''): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-runtime-source-'));
  roots.push(root);
  write(root, 'package.json', '{"version":"0.4.0"}\n');
  write(root, 'package-lock.json', '{}\n');
  write(root, 'tsconfig.json', '{}\n');
  write(root, 'vite.config.ts', 'export default {};\n');
  write(root, 'index.html', '<main></main>\n');
  write(root, 'src/cli/main.ts', 'export const cli = true;\n');
  write(root, 'scripts/build-standalone.ts', 'export {};\n');
  write(root, 'scripts/make-assets.mjs', 'export {};\n');
  return root;
}

function distributionRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-runtime-release-'));
  roots.push(root);
  write(root, 'package.json', '{"version":"0.4.0"}\n');
  write(root, 'dist/cli/main.js');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime source provenance', () => {
  it('hashes runtime inputs deterministically and excludes generated or documentary files', () => {
    const root = sourceRoot();
    const initial = computeRuntimeSourceFingerprint(root);

    write(root, 'docs/notes.md', 'not executable\n');
    write(root, 'dist/cli/main.js', 'generated\n');
    expect(computeRuntimeSourceFingerprint(root)).toBe(initial);

    write(root, 'src/cli/main.ts', 'export const cli = false;\n');
    expect(computeRuntimeSourceFingerprint(root)).not.toBe(initial);
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes an atomic build stamp and detects a later source change', () => {
    const root = sourceRoot();
    const executable = write(root, 'libexec/desk-standalone', 'binary');
    const fingerprint = computeRuntimeSourceFingerprint(root);

    writeStandaloneBuildProvenance(executable, fingerprint);
    expect(inspectStandaloneBuildProvenance(root)).toEqual({
      state: 'current',
      builtSourceFingerprint: fingerprint,
      currentSourceFingerprint: fingerprint
    });
    expect(readdirSync(join(root, 'libexec')).filter((name) => name.includes('.tmp-'))).toEqual([]);

    write(root, 'src/server.ts', 'export const changed = true;\n');
    expect(inspectStandaloneBuildProvenance(root)).toEqual({
      state: 'stale',
      builtSourceFingerprint: fingerprint,
      currentSourceFingerprint: computeRuntimeSourceFingerprint(root)
    });
  });

  it('reports missing and malformed standalone stamps without trusting them', () => {
    const root = sourceRoot();
    const executable = write(root, 'libexec/desk-standalone', 'binary');

    expect(inspectStandaloneBuildProvenance(root)).toEqual({ state: 'missing' });
    write(root, 'libexec/desk-standalone.provenance.json', '{bad json');
    expect(inspectStandaloneBuildProvenance(root)).toMatchObject({ state: 'invalid' });

    write(
      root,
      'libexec/desk-standalone.provenance.json',
      '{"schemaVersion":1,"sourceFingerprint":"not-a-sha"}\n'
    );
    expect(inspectStandaloneBuildProvenance(root)).toMatchObject({ state: 'invalid' });
  });

  it('rejects symlinked runtime inputs whose external content is not self-contained', () => {
    const root = sourceRoot();
    const external = write(root, 'external.ts', 'export const external = true;\n');
    symlinkSync(external, join(root, 'src', 'external.ts'));

    expect(() => computeRuntimeSourceFingerprint(root)).toThrow(
      'runtime source inputs must not contain symbolic links: src/external.ts'
    );
  });
});

describe('managed release provenance', () => {
  it('projects only validated installer-owned release fields', () => {
    const root = distributionRoot();
    write(
      root,
      '.desk-release',
      `${JSON.stringify({
        schemaVersion: 2,
        managedBy: 'desk-installer',
        version: 'v0.4.0',
        installId: '20260818000000-1-2',
        target: 'linux-x64',
        sourceSha256: 'a'.repeat(64),
        ignored: { secret: true }
      })}\n`
    );

    expect(readManagedReleaseProvenance(root)).toEqual({
      state: 'managed',
      schemaVersion: 2,
      version: 'v0.4.0',
      installId: '20260818000000-1-2',
      target: 'linux-x64',
      sourceSha256: 'a'.repeat(64)
    });
  });

  it('distinguishes unmanaged distributions from malformed managed metadata', () => {
    const root = distributionRoot();
    expect(readManagedReleaseProvenance(root)).toEqual({ state: 'unmanaged' });

    write(root, '.desk-release', '{"schemaVersion":2,"managedBy":"desk-installer"}\n');
    expect(readManagedReleaseProvenance(root)).toMatchObject({ state: 'invalid' });
  });

  it('resolves one diagnostic projection for source and distribution runtimes', () => {
    const source = sourceRoot();
    expect(resolveRuntimeProvenance(source, { DESK_RUNTIME_MODE: 'vite' })).toMatchObject({
      schemaVersion: 1,
      packageKind: 'source',
      runtimeKind: 'vite',
      version: '0.4.0',
      standaloneBuild: { state: 'missing' }
    });

    const distribution = distributionRoot();
    expect(resolveRuntimeProvenance(distribution, {})).toMatchObject({
      schemaVersion: 1,
      packageKind: 'distribution',
      runtimeKind: 'standalone',
      version: '0.4.0',
      release: { state: 'unmanaged' }
    });
  });

  it('uses a release-shaped cwd only for Bun virtual module URLs', () => {
    const root = sourceRoot();

    expect(resolvePackageRoot('file:///$bunfs/root/desk-standalone', root)).toBe(root);
    expect(() => resolvePackageRoot('file:///missing/desk-standalone', root)).toThrow(
      /cannot locate the desk package root/
    );
  });
});
