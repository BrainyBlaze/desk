import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROVENANCE = fileURLToPath(new URL('../vendor/atch/PROVENANCE.json', import.meta.url));
const BUILD_SCRIPT = fileURLToPath(new URL('../scripts/build-atch.mjs', import.meta.url));

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

function snapshotDigest(root: string): string {
  const files: string[] = [];
  const visit = (directory: string) => {
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

describe('bundled atch distribution contract', () => {
  it('pins the exact fork snapshot, upstream base, and ordered local patch range', () => {
    expect(existsSync(PROVENANCE), 'vendor/atch/PROVENANCE.json must exist').toBe(true);
    if (!existsSync(PROVENANCE)) {
      return;
    }

    const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      fork: {
        repository: 'https://github.com/BrainyBlaze/atch.git',
        commit: '0dd332eea478b5415ac54c39bcc1e28c2c9761f3',
        tree: '6eb4f166fa972843ed71e888f62cf80601864ceb',
        version: '1.6-bb1'
      },
      upstream: {
        repository: 'https://github.com/mobydeck/atch.git',
        baseCommit: '15e0d3a0912618c08f7a74f85e41cca673b313f0'
      },
      patches: {
        range:
          '15e0d3a0912618c08f7a74f85e41cca673b313f0..0dd332eea478b5415ac54c39bcc1e28c2c9761f3',
        count: 41
      },
      snapshot: {
        algorithm: 'sha256',
        format: 'git-path-mode-content-v1'
      }
    });
    expect(provenance.snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotDigest(fileURLToPath(new URL('../vendor/atch', import.meta.url)))).toBe(provenance.snapshot.digest);
    expect(provenance.patches.commits).toHaveLength(41);
    expect(provenance.patches.commits[0]).toEqual({
      commit: '6c6648014ea0a26b0850e8916835f9d510ce9d3c',
      subject: 'fork: zero-replay + DECSET state preamble + 4 KB push payload'
    });
    expect(provenance.patches.commits.at(-1)).toEqual({
      commit: '0dd332eea478b5415ac54c39bcc1e28c2c9761f3',
      subject: 'fix: accept single-byte v3 terminal input'
    });
    expect(new Set(provenance.patches.commits.map(({ commit }: { commit: string }) => commit)).size).toBe(41);

    for (const required of [
      'README.md',
      'atch.c',
      'atch.h',
      'atch_event_sink.c',
      'atch_event_sink.h',
      'attach.c',
      'config.h',
      'makefile',
      'master.c',
      'tstate.c'
    ]) {
      expect(existsSync(fileURLToPath(new URL(`../vendor/atch/${required}`, import.meta.url))), required).toBe(true);
    }
  });

  it('builds the pinned fork before every Desk distribution', async () => {
    const packageJson = JSON.parse(source('package.json'));
    const gitignore = source('.gitignore');

    expect(packageJson.scripts['build:atch']).toBe('node scripts/build-atch.mjs');
    expect(packageJson.scripts['build:distribution']).toMatch(/^npm run build:atch && /);
    expect(existsSync(BUILD_SCRIPT), 'scripts/build-atch.mjs must exist').toBe(true);
    expect(gitignore).toContain('/libexec/atch');
    if (!existsSync(BUILD_SCRIPT)) {
      return;
    }

    const temporary = mkdtempSync(join(tmpdir(), 'desk-atch-contract-'));
    try {
      const { buildAtch, verifyAtchSnapshot } = await import('../scripts/build-atch.mjs');
      const outfile = join(temporary, 'atch');
      await buildAtch({ root: ROOT, outfile });

      expect(statSync(outfile).mode & 0o777).toBe(0o755);
      const version = spawnSync(outfile, ['--version'], { encoding: 'utf8' });
      expect(version.status).toBe(0);
      expect(version.stdout).toMatch(/^atch - version 1\.6-bb1,/);

      const altered = join(temporary, 'altered-vendor');
      cpSync(fileURLToPath(new URL('../vendor/atch', import.meta.url)), altered, { recursive: true });
      writeFileSync(join(altered, 'atch.c'), '\n/* drift */\n', { flag: 'a' });
      expect(() => verifyAtchSnapshot(altered)).toThrow(/snapshot digest/i);
      const alteredProvenancePath = join(altered, 'PROVENANCE.json');
      const alteredProvenance = JSON.parse(readFileSync(alteredProvenancePath, 'utf8'));
      alteredProvenance.snapshot.digest = snapshotDigest(altered);
      writeFileSync(alteredProvenancePath, `${JSON.stringify(alteredProvenance, null, 2)}\n`);
      expect(() => verifyAtchSnapshot(altered)).toThrow(/pinned snapshot digest/i);

      writeFileSync(outfile, 'preserve-existing-target\n');
      chmodSync(outfile, 0o755);
      await expect(
        buildAtch({
          root: ROOT,
          outfile,
          env: { ...process.env, CC: join(temporary, 'missing-compiler') }
        })
      ).rejects.toThrow(/compiler/i);
      expect(readFileSync(outfile, 'utf8')).toBe('preserve-existing-target\n');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('requires runnable bundled binaries from the installer and Docker image', () => {
    const installer = source('install.sh');
    const dockerfile = source('Dockerfile');

    expect(installer).toContain('ATCH_VERSION="1.6-bb1"');
    expect(installer).toMatch(/"\$STAGED_RELEASE\/libexec\/atch" --version/);
    expect(dockerfile.match(/libexec\/atch --version/g)).toHaveLength(2);
  });

  it('builds and probes bundled atch on Linux and both supported macOS architectures', () => {
    const ci = source('.github/workflows/ci.yml');
    const installerWorkflow = source('.github/workflows/installer.yml');
    const releaseWorkflow = source('.github/workflows/release.yml');

    expect(ci).toContain('./libexec/atch --version');
    expect(installerWorkflow).toContain("'scripts/build-atch.mjs'");
    expect(installerWorkflow).toContain("'vendor/atch/**'");
    expect(installerWorkflow).toContain('macos-15');
    expect(installerWorkflow).toContain('macos-15-intel');
    expect(installerWorkflow).toContain('npm run build:atch');
    expect(installerWorkflow).toContain(
      'make -C vendor/atch CC=cc STATIC_FLAG= security-storage-test'
    );
    expect(installerWorkflow).toContain('file libexec/atch');
    expect(installerWorkflow).toContain('./libexec/atch --version');
    expect(releaseWorkflow).toContain("'scripts/build-atch.mjs'");
    expect(releaseWorkflow).toContain("'vendor/atch/**'");
  });

  it('documents the pinned bundled binary and preserves the override resolution order', () => {
    // The user-facing set. The internal CLI contract spec used to be checked
    // here too; it left the repo with the rest of the build-process artifacts,
    // and its one assertion duplicated the troubleshooting page below — the
    // page an operator actually reads when atch will not resolve.
    const documentation = [
      'README.md',
      'docs/getting-started.md',
      'docs/distribution-deployment.md',
      'docs/troubleshooting.md'
    ].map(source);
    const combined = documentation.join('\n');

    expect(combined).not.toMatch(
      /does not bundle atch|distribution-license decision (?:is )?(?:open|pending)|pending the distribution-license decision|separately installed reviewed binary|present only when the release bundles atch|current image does not package atch/i
    );
    expect(source('README.md')).toMatch(/bundles.*atch/i);
    expect(source('docs/getting-started.md')).toMatch(/bundled.*atch/i);
    expect(source('docs/distribution-deployment.md')).toContain('vendor/atch/PROVENANCE.json');
    expect(source('docs/distribution-deployment.md')).toContain('libexec/atch');
    expect(source('docs/troubleshooting.md')).toMatch(
      /DESK_ATCH_BIN.*same-release.*libexec\/atch.*PATH/is
    );
  });
});
