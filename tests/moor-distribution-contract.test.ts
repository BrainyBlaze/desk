// Distribution contract for the bundled moor holder: the vendored source
// snapshot is PROVENANCE-pinned (repository/commit/version + a content
// digest), the build script refuses drift, and the release ships ONLY the
// `moor` name — no compatibility binary is ever built or shipped. Building is
// exercised by `npm run fetch:moor` on developer/CI hosts; this contract
// validates the pinned inputs and (when present) the built artifact.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_COMMIT,
  EXPECTED_REPOSITORY,
  EXPECTED_VERSION,
  buildMoor,
  readProvenance,
  snapshotDigest,
  validateVendor
} from '../scripts/build-moor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor', 'moor');
const BUNDLED = join(ROOT, 'libexec', 'moor');
const REQUIRED_VENDOR_COMMIT = '649ea81769591d0c4212af52803e7d69ab127f1c';
const REQUIRED_SNAPSHOT_DIGEST = '8ad04bde92132a5923796260414f097250cc9256c28303d920a4a0c114e5d9a6';
const REQUIRED_BINARY_SIZE = 1_340_816;
const REQUIRED_BINARY_SHA256 = '5ff5fdc635d00010090363c30748996b1b8314dab9f4a503ced7e699461819a7';

describe('moor distribution contract — provenance-pinned vendor snapshot', () => {
  it('carries a provenance that names the fork, the frozen commit, and the version', () => {
    const provenance = readProvenance(VENDOR);
    expect(provenance.repository).toBe(EXPECTED_REPOSITORY);
    expect(provenance.commit).toBe(EXPECTED_COMMIT);
    expect(provenance.commit).toBe(REQUIRED_VENDOR_COMMIT);
    expect(provenance.version).toBe(EXPECTED_VERSION);
    expect(provenance.license).toBe('MIT OR Apache-2.0');
    expect(provenance.snapshotDigest).toBe(REQUIRED_SNAPSHOT_DIGEST);
  });

  it('the snapshot content digest matches the recorded provenance exactly', () => {
    const provenance = readProvenance(VENDOR);
    expect(snapshotDigest(VENDOR)).toBe(provenance.snapshotDigest);
    expect(() => validateVendor(VENDOR)).not.toThrow();
  });

  it('refuses a tampered snapshot (digest drift fails closed)', () => {
    const copy = mkdtempSync(join(tmpdir(), 'desk-moor-contract-'));
    try {
      cpSync(VENDOR, copy, { recursive: true });
      writeFileSync(join(copy, 'src', 'tampered.rs'), '// drifted\n');
      expect(() => validateVendor(copy)).toThrow(/snapshot digest mismatch/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('Desk builds and ships ONLY the moor name from the pinned snapshot', () => {
    const manifest = readFileSync(join(VENDOR, 'Cargo.toml'), 'utf8');
    expect(manifest).toContain('name = "moor"');
    expect(manifest).toContain('license = "MIT OR Apache-2.0"');
    expect(existsSync(join(VENDOR, 'LICENSE-MIT'))).toBe(true);
    expect(existsSync(join(VENDOR, 'LICENSE-APACHE'))).toBe(true);
    expect(existsSync(join(VENDOR, 'vendor', 'windows-spawn', 'Cargo.toml'))).toBe(true);
    // The build script pins `--bin moor`, so only that target is ever built,
    // and the release ships no second binary under the compatibility name.
    const builder = readFileSync(join(ROOT, 'scripts', 'build-moor.mjs'), 'utf8');
    expect(builder).toContain("'--bin', 'moor'");
    expect(existsSync(join(ROOT, 'libexec', 'atch'))).toBe(false);
    expect(manifest).not.toContain('name = "atch"');
  });

  it('the vendored holder consumes the supervisor-independent carriers Desk emits', () => {
    const runtime = readFileSync(join(VENDOR, 'src', 'runtime', 'private.rs'), 'utf8');
    expect(runtime).toContain('environment_key(invoked, "_LAUNCH_CHANNEL")');
    expect(runtime).toContain('std::env::var_os("MOOR_SESSION_GENERATION")');
    expect(runtime).not.toContain('std::env::var_os("DESK_MOOR_LAUNCH_CHANNEL")');
    expect(runtime).not.toContain('std::env::var_os("DESK_SESSION_GENERATION")');
  });

  it(
    'builds the exact Moor v4 binary through the release builder',
    () => {
      const outputRoot = mkdtempSync(join(tmpdir(), 'desk-moor-release-build-'));
      const outfile = join(outputRoot, 'moor');
      try {
        const { provenance } = buildMoor({ root: ROOT, outfile });
        expect(provenance.commit).toBe(REQUIRED_VENDOR_COMMIT);
        expect(statSync(outfile).size).toBe(REQUIRED_BINARY_SIZE);
        expect(createHash('sha256').update(readFileSync(outfile)).digest('hex')).toBe(
          REQUIRED_BINARY_SHA256
        );
      } finally {
        rmSync(outputRoot, { recursive: true, force: true });
      }
    },
    60_000
  );
});

describe.skipIf(!existsSync(BUNDLED))('moor distribution contract — built artifact', () => {
  it('libexec/moor is the pinned holder and answers as moor', () => {
    const result = spawnSync(BUNDLED, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`moor ${EXPECTED_VERSION}`);
  });
});
