// Distribution contract for the bundled moor holder: the vendored source
// snapshot is PROVENANCE-pinned (repository/commit/version + a content
// digest), the build script refuses drift, and the release ships ONLY the
// `moor` name — no compatibility binary is ever built or shipped. Building is
// exercised by `npm run fetch:moor` on developer/CI hosts; this contract
// validates the pinned inputs and (when present) the built artifact.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_COMMIT,
  EXPECTED_REPOSITORY,
  EXPECTED_VERSION,
  readProvenance,
  snapshotDigest,
  validateVendor
} from '../scripts/build-moor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor', 'moor');
const BUNDLED = join(ROOT, 'libexec', 'moor');

describe('moor distribution contract — provenance-pinned vendor snapshot', () => {
  it('carries a provenance that names the fork, the frozen commit, and the version', () => {
    const provenance = readProvenance(VENDOR);
    expect(provenance.repository).toBe(EXPECTED_REPOSITORY);
    expect(provenance.commit).toBe(EXPECTED_COMMIT);
    expect(provenance.version).toBe(EXPECTED_VERSION);
    expect(provenance.license).toBe('MIT OR Apache-2.0');
    expect(provenance.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
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
    // The build script pins `--bin moor`, so only that target is ever built,
    // and the release ships no second binary under the compatibility name.
    const builder = readFileSync(join(ROOT, 'scripts', 'build-moor.mjs'), 'utf8');
    expect(builder).toContain("'--bin', 'moor'");
    expect(existsSync(join(ROOT, 'libexec', 'atch'))).toBe(false);
    // HONEST PIN of the upstream state at 93d593a: the vendored manifest
    // still DECLARES upstream's dual-name compatibility bin target. Its
    // removal is tracked in https://github.com/BrainyBlaze/moor/issues/25 —
    // when upstream lands it, revendor/repin and FLIP this expectation.
    expect(manifest).toContain('name = "atch"');
  });
});

describe.skipIf(!existsSync(BUNDLED))('moor distribution contract — built artifact', () => {
  it('libexec/moor is the pinned holder and answers as moor', () => {
    const result = spawnSync(BUNDLED, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`moor ${EXPECTED_VERSION}`);
  });
});
