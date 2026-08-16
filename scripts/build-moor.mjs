#!/usr/bin/env node
// Build the bundled moor holder from the vendored source snapshot into
// libexec/moor. The vendor tree is PROVENANCE-pinned: this script refuses to
// build anything whose snapshot digest does not match the recorded one, so a
// release can never silently ship a drifted holder. Requires a Rust toolchain
// (cargo) on the RELEASE BUILDER's machine only — end users receive the built
// libexec/moor.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_REPOSITORY = 'https://github.com/BrainyBlaze/moor.git';
export const EXPECTED_COMMIT = '649ea81769591d0c4212af52803e7d69ab127f1c';
export const EXPECTED_VERSION = '0.1.0';

export function snapshotDigest(root) {
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
    hash.update(path.slice(root.length + 1).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function readProvenance(vendorRoot) {
  return JSON.parse(readFileSync(join(vendorRoot, 'PROVENANCE.json'), 'utf8'));
}

export function validateVendor(vendorRoot) {
  const provenance = readProvenance(vendorRoot);
  if (provenance.repository !== EXPECTED_REPOSITORY) {
    throw new Error(`vendor provenance repository mismatch: ${provenance.repository}`);
  }
  if (provenance.commit !== EXPECTED_COMMIT) {
    throw new Error(`vendor provenance commit mismatch: ${provenance.commit}`);
  }
  if (provenance.version !== EXPECTED_VERSION) {
    throw new Error(`vendor provenance version mismatch: ${provenance.version}`);
  }
  const digest = snapshotDigest(vendorRoot);
  if (digest !== provenance.snapshotDigest) {
    throw new Error(
      `vendor snapshot digest mismatch: computed ${digest}, recorded ${provenance.snapshotDigest}`
    );
  }
  return provenance;
}

export function buildMoor({ root = DEFAULT_ROOT, outfile = join(root, 'libexec', 'moor') } = {}) {
  const vendorRoot = join(root, 'vendor', 'moor');
  const provenance = validateVendor(vendorRoot);

  const target = mkdtempSync(join(tmpdir(), 'desk-moor-build-'));
  try {
    const result = spawnSync(
      'cargo',
      ['build', '--release', '--locked', '--bin', 'moor', '--manifest-path', join(vendorRoot, 'Cargo.toml')],
      { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } }
    );
    if (result.status !== 0) {
      throw new Error(`cargo build failed with status ${result.status}`);
    }
    const built = join(target, 'release', 'moor');
    if (!existsSync(built)) {
      throw new Error(`cargo reported success but ${built} is missing`);
    }
    mkdirSync(dirname(outfile), { recursive: true });
    const staging = `${outfile}.tmp-${process.pid}`;
    copyFileSync(built, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, outfile);
    return { outfile, provenance };
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { outfile, provenance } = buildMoor();
  process.stdout.write(
    `built ${outfile} from moor ${provenance.version} @ ${provenance.commit}\n`
  );
}
