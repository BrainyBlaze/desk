#!/usr/bin/env node
// Verified acquisition of the bundled moor holder for DEVELOPER and CI
// builds: no Cargo, no vendored source. Reads the committed pin document
// (scripts/distribution/moor-pin.json — schema owned by the installer lane),
// selects the canonical target triple for this host, downloads the pinned
// release asset, verifies its SHA-256 against the pin, installs it atomically
// into libexec/moor, and finally runs the #10 attestation probe. Every
// failure path is fail-closed: an unpinned tree, a missing target, a digest
// mismatch, or a failed probe leaves no partial libexec/moor behind.
//
// End users never run this: the installer lane ships its own download path.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PIN_RELATIVE_PATH = join('scripts', 'distribution', 'moor-pin.json');
export const MOOR_ATTESTED_VERSION = 'moor 0.1.0';

/**
 * The canonical target key for a host — the ratified 6-key matrix (no libc
 * detection: linux ships one static-musl binary per CPU that also serves
 * glibc hosts). Exact key literals bind to the reviewed release contract
 * (docs/release-distribution.md in the moor repo) before this ships.
 */
export function moorTargetTriple({ platform = process.platform, arch = process.arch } = {}) {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (cpu === undefined) {
    throw new Error(`unsupported CPU architecture for moor: ${arch}`);
  }
  switch (platform) {
    case 'linux':
      return `${cpu}-unknown-linux-musl`;
    case 'darwin':
      return `${cpu}-apple-darwin`;
    case 'win32':
      return `${cpu}-pc-windows-msvc`;
    default:
      throw new Error(`unsupported platform for moor: ${platform}`);
  }
}

/** Parse + structurally validate the pin document. Fail-closed on anything off. */
export function readMoorPin(root = DEFAULT_ROOT) {
  const path = join(root, PIN_RELATIVE_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `no pinned moor release: ${PIN_RELATIVE_PATH} is absent — the moor release lane has not published/pinned yet`
    );
  }
  const pin = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof pin.version !== 'string' || pin.version.length === 0) {
    throw new Error('moor pin is missing a release version');
  }
  if (typeof pin.repository !== 'string' || pin.repository.length === 0) {
    throw new Error('moor pin is missing the release repository');
  }
  if (pin.targets === null || typeof pin.targets !== 'object' || Object.keys(pin.targets).length === 0) {
    throw new Error('moor pin carries no targets — fail closed, nothing to download');
  }
  for (const [triple, target] of Object.entries(pin.targets)) {
    if (typeof target?.asset !== 'string' || target.asset.length === 0) {
      throw new Error(`moor pin target ${triple} is missing its asset name`);
    }
    if (typeof target?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(target.sha256)) {
      throw new Error(`moor pin target ${triple} is missing a valid sha256`);
    }
  }
  return pin;
}

/** The download URL for a pinned asset; base override for tests/mirrors. */
export function assetUrl(pin, triple, baseUrl = process.env.DESK_MOOR_RELEASE_BASE_URL) {
  const target = pin.targets[triple];
  if (target === undefined) {
    throw new Error(`moor pin has no target for this host triple: ${triple}`);
  }
  if (baseUrl !== undefined && baseUrl.length > 0) {
    return `${baseUrl.replace(/\/$/, '')}/${target.asset}`;
  }
  return `${pin.repository.replace(/\/$/, '').replace(/\.git$/, '')}/releases/download/${pin.version}/${target.asset}`;
}

async function download(url) {
  if (url.startsWith('file://')) {
    return readFileSync(fileURLToPath(url));
  }
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchMoor({
  root = DEFAULT_ROOT,
  outfile = join(root, 'libexec', 'moor'),
  triple = moorTargetTriple(),
  baseUrl = process.env.DESK_MOOR_RELEASE_BASE_URL,
  attest = defaultAttestation
} = {}) {
  const pin = readMoorPin(root);
  const target = pin.targets[triple];
  if (target === undefined) {
    throw new Error(`moor pin has no target for this host triple: ${triple}`);
  }
  const url = assetUrl(pin, triple, baseUrl);
  const bytes = await download(url);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== target.sha256) {
    throw new Error(
      `moor asset digest mismatch for ${triple}: downloaded ${digest}, pinned ${target.sha256} — refusing to install`
    );
  }
  mkdirSync(dirname(outfile), { recursive: true });
  const staging = `${outfile}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    const attested = attest(staging);
    if (!attested.ok) {
      throw new Error(`downloaded moor failed attestation: ${attested.reason}`);
    }
    renameSync(staging, outfile); // atomic: no partial binary is ever active
  } finally {
    rmSync(staging, { force: true });
  }
  return { outfile, version: pin.version, triple, sha256: digest };
}

function defaultAttestation(path) {
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 3_000,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.error !== undefined) {
    return { ok: false, reason: `version probe failed to run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `version probe exited ${result.status}` };
  }
  const answer = (result.stdout ?? '').trim();
  if (answer !== MOOR_ATTESTED_VERSION) {
    return { ok: false, reason: `version probe answered ${JSON.stringify(answer)}` };
  }
  return { ok: true };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { outfile, version, triple, sha256 } = await fetchMoor();
  process.stdout.write(`installed ${outfile} — moor ${version} (${triple}, sha256 ${sha256})\n`);
}
