import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createInstallManifest,
  validateReleaseVersion,
  writeReleaseAssets
} from '../scripts/create-release-assets.mjs';

const roots: string[] = [];

const MOOR_TARGETS = {
  'x86_64-unknown-linux-musl': 'moor-0.1.0-linux-x64',
  'aarch64-unknown-linux-musl': 'moor-0.1.0-linux-arm64',
  'x86_64-apple-darwin': 'moor-0.1.0-macos-x64',
  'aarch64-apple-darwin': 'moor-0.1.0-macos-arm64',
  'x86_64-pc-windows-msvc': 'moor-0.1.0-windows-x64.exe',
  'aarch64-pc-windows-msvc': 'moor-0.1.0-windows-arm64.exe'
} as const;

function fixtureMoorPin() {
  return {
    schemaVersion: 1,
    repository: 'https://github.com/BrainyBlaze/moor',
    version: 'v0.1.0',
    commit: 'b'.repeat(40),
    targets: Object.fromEntries(
      Object.entries(MOOR_TARGETS).map(([target, asset], index) => [
        target,
        { asset, size: index + 1, sha256: (index + 1).toString(16).repeat(64) }
      ])
    )
  };
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-release-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts', 'distribution'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'fixture'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'libexec'), { recursive: true });
  mkdirSync(join(root, 'vendor', 'moor', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"desk-fixture","version":"0.3.0"}\n');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  writeFileSync(join(root, 'node_modules', 'fixture', 'tracked.txt'), 'exclude\n');
  writeFileSync(join(root, 'dist', 'tracked.txt'), 'exclude\n');
  writeFileSync(join(root, 'libexec', 'desk-standalone'), 'exclude\n');
  writeFileSync(join(root, 'libexec', 'moor'), 'exclude\n');
  writeFileSync(join(root, 'vendor', 'moor', 'PROVENANCE.json'), '{}\n');
  writeFileSync(join(root, 'vendor', 'moor', 'src', 'main.rs'), '// vendored source\n');
  writeFileSync(
    join(root, 'scripts', 'distribution', 'toolchains.json'),
    readFileSync(new URL('../scripts/distribution/toolchains.json', import.meta.url))
  );
  writeFileSync(
    join(root, 'scripts', 'distribution', 'moor-pin.json'),
    `${JSON.stringify(fixtureMoorPin(), null, 2)}\n`
  );
  run('git', ['init', '-q'], root);
  run('git', ['add', '.'], root);
  run(
    'git',
    ['-c', 'user.name=Desk Tests', '-c', 'user.email=desk-tests@example.invalid', 'commit', '-qm', 'fixture'],
    root
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release asset generation', () => {
  it('accepts only canonical release tags', () => {
    expect(validateReleaseVersion('v0.3.0')).toBe('v0.3.0');
    expect(validateReleaseVersion('v1.2.3-rc.1')).toBe('v1.2.3-rc.1');
    for (const value of ['0.3.0', 'v01.2.3', 'v1.2', 'v1.2.3/../../x', 'v1.2.3+build', '']) {
      expect(() => validateReleaseVersion(value)).toThrow(/version/i);
    }
  });

  it('creates a schema-versioned manifest with the exact Moor pin projection', () => {
    const moor = fixtureMoorPin();
    const manifest = createInstallManifest({
      version: 'v0.3.0',
      sourceAsset: 'desk-v0.3.0-source.tar.gz',
      sourceSha256: 'a'.repeat(64),
      toolchains: {
        schemaVersion: 1,
        node: { version: '22.23.1', npmVersion: '10.9.8', targets: {} },
        bun: { version: '1.3.14', tag: 'bun-v1.3.14', targets: {} }
      },
      moor
    });

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      version: 'v0.3.0',
      source: { asset: 'desk-v0.3.0-source.tar.gz', sha256: 'a'.repeat(64) },
      node: { version: '22.23.1', npmVersion: '10.9.8' },
      bun: { version: '1.3.14', tag: 'bun-v1.3.14' },
      moor
    });
    expect(manifest.moor).not.toBe(moor);
    expect(manifest.moor.repository).toBe('https://github.com/BrainyBlaze/moor');
  });

  it('rejects a Moor pin with unknown fields or nonliteral target assets', () => {
    const moor = fixtureMoorPin();
    expect(() =>
      createInstallManifest({
        version: 'v0.3.0',
        sourceAsset: 'desk-v0.3.0-source.tar.gz',
        sourceSha256: 'a'.repeat(64),
        toolchains: {
          schemaVersion: 1,
          node: { version: '22.23.1', npmVersion: '10.9.8', targets: {} },
          bun: { version: '1.3.14', tag: 'bun-v1.3.14', targets: {} }
        },
        moor: { ...moor, url: 'https://invalid.example' }
      })
    ).toThrow(/moor.*keys/i);

    moor.targets['x86_64-unknown-linux-musl'].asset = 'moor-0.1.0-linux-arm64';
    expect(() =>
      createInstallManifest({
        version: 'v0.3.0',
        sourceAsset: 'desk-v0.3.0-source.tar.gz',
        sourceSha256: 'a'.repeat(64),
        toolchains: {
          schemaVersion: 1,
          node: { version: '22.23.1', npmVersion: '10.9.8', targets: {} },
          bun: { version: '1.3.14', tag: 'bun-v1.3.14', targets: {} }
        },
        moor
      })
    ).toThrow(/moor.*asset/i);
  });

  it('writes deterministic source, manifest, and checksum assets from clean committed source', () => {
    const root = createRepository();
    const first = join(mkdtempSync(join(tmpdir(), 'desk-release-output-')), 'assets');
    const second = join(mkdtempSync(join(tmpdir(), 'desk-release-output-')), 'assets');
    roots.push(first.slice(0, -'/assets'.length), second.slice(0, -'/assets'.length));

    writeReleaseAssets({ root, version: 'v0.3.0', outDir: first });
    writeReleaseAssets({ root, version: 'v0.3.0', outDir: second });

    expect(readdirSync(first).sort()).toEqual([
      'SHA256SUMS',
      'desk-install-manifest.json',
      'desk-v0.3.0-source.tar.gz'
    ]);
    for (const name of readdirSync(first)) {
      expect(readFileSync(join(first, name))).toEqual(readFileSync(join(second, name)));
    }

    const checksums = readFileSync(join(first, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(checksums).toHaveLength(2);
    for (const line of checksums) {
      const [digest, name] = line.split(/\s{2}/);
      expect(createHash('sha256').update(readFileSync(join(first, name))).digest('hex')).toBe(digest);
    }

    const listing = run('tar', ['-tzf', join(first, 'desk-v0.3.0-source.tar.gz')], root);
    expect(listing).toContain('desk-v0.3.0/README.md');
    expect(listing).toContain('desk-v0.3.0/scripts/distribution/moor-pin.json');
    expect(listing).not.toMatch(/(?:^|\/)vendor\/moor(?:\/|$)/m);
    expect(listing).not.toMatch(/(?:^|\/)(?:\.git|node_modules|dist|libexec)(?:\/|$)/m);
  });

  it('reads release metadata from the exact archived ref rather than working-tree HEAD', () => {
    const root = createRepository();
    const releasedRef = run('git', ['rev-parse', 'HEAD'], root).trim();
    const newerPin = fixtureMoorPin();
    newerPin.commit = 'c'.repeat(40);
    writeFileSync(
      join(root, 'scripts', 'distribution', 'moor-pin.json'),
      `${JSON.stringify(newerPin, null, 2)}\n`
    );
    run('git', ['add', 'scripts/distribution/moor-pin.json'], root);
    run(
      'git',
      ['-c', 'user.name=Desk Tests', '-c', 'user.email=desk-tests@example.invalid', 'commit', '-qm', 'new pin'],
      root
    );
    const outDir = join(mkdtempSync(join(tmpdir(), 'desk-release-output-')), 'assets');
    roots.push(outDir.slice(0, -'/assets'.length));

    writeReleaseAssets({ root, version: 'v0.3.0', outDir, ref: releasedRef });

    const manifest = JSON.parse(readFileSync(join(outDir, 'desk-install-manifest.json'), 'utf8'));
    expect(manifest.moor.commit).toBe('b'.repeat(40));
  });

  it('refuses dirty or untracked checkout state instead of packaging local artifacts', () => {
    const root = createRepository();
    const outDir = join(root, '..', `desk-release-rejected-${Date.now()}`);
    roots.push(outDir);
    writeFileSync(join(root, 'libexec', 'desk-standalone'), 'dirty\n');

    expect(() => writeReleaseAssets({ root, version: 'v0.3.0', outDir })).toThrow(/clean|dirty|untracked/i);
  });
});
