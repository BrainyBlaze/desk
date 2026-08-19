import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyApplicationBuild } from '../scripts/verify-application-build.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const roots: string[] = [];

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixture(options: { stale?: boolean; moor?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-application-contract-'));
  roots.push(root);
  for (const directory of ['bin', 'dist/cli', 'dist/shared', 'libexec']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  executable(join(root, 'bin/desk.js'), '#!/usr/bin/env node\n');
  executable(join(root, 'dist/cli/main.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  executable(join(root, 'libexec/desk-standalone'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(root, 'libexec/desk-standalone.provenance.json'), '{}\n');
  writeFileSync(
    join(root, 'dist/shared/runtimeProvenance.js'),
    options.stale
      ? 'export function assertCurrentStandaloneBuild(){ throw new Error("stale standalone build"); }\n'
      : 'export function assertCurrentStandaloneBuild(){}\n'
  );
  if (options.moor) executable(join(root, 'libexec/moor'), '#!/bin/sh\nexit 0\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('application build contract', () => {
  it('accepts only a current executable application build', async () => {
    await expect(verifyApplicationBuild(fixture())).resolves.toBeUndefined();
  });

  it('rejects stale standalone provenance through the canonical runtime check', async () => {
    await expect(verifyApplicationBuild(fixture({ stale: true }))).rejects.toThrow(
      'stale standalone build'
    );
  });

  it('requires the verified Moor payload for a distribution build', async () => {
    await expect(
      verifyApplicationBuild(fixture(), { requireMoor: true })
    ).rejects.toThrow('libexec/moor');
    await expect(
      verifyApplicationBuild(fixture({ moor: true }), { requireMoor: true })
    ).resolves.toBeUndefined();
  });

  it('wires the same verifier into builds, installs, and release CI', () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    expect(packageJson.scripts['build:application']).toContain('verify:application-build');
    expect(packageJson.scripts['build:distribution']).toContain('--require-moor');

    const installer = readFileSync(join(projectRoot, 'install.sh'), 'utf8');
    expect(installer).toContain('verify:application-build -- --require-moor');

    const workflow = readFileSync(join(projectRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('run: npm run build:application');
  });
});
