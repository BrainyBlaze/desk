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
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PIN_RELATIVE_PATH = join('scripts', 'distribution', 'moor-pin.json');
export const MOOR_ATTESTED_VERSION = 'moor 0.1.0';
export const MOOR_PIN_SCHEMA_VERSION = 1;
/** The ONLY repository production assets may come from. */
export const MOOR_RELEASE_REPOSITORY = 'https://github.com/BrainyBlaze/moor';
/** The ratified 6-key target matrix — a pin must cover EXACTLY these. */
export const MOOR_TARGETS = Object.freeze([
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc'
]);
const DOWNLOAD_DEADLINE_MS = 60_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024; // no holder build approaches this

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
  // EXACT key sets: an unknown key is either a typo silently ignored (a
  // pinned field that never actually pins) or smuggled data — both rejected.
  const topKeys = Object.keys(pin).sort();
  const expectedTop = ['commit', 'repository', 'schemaVersion', 'targets', 'version'];
  if (topKeys.length !== expectedTop.length || topKeys.some((key, i) => key !== expectedTop[i])) {
    throw new Error(`moor pin must carry exactly [${expectedTop.join(', ')}]; got [${topKeys.join(', ')}]`);
  }
  if (pin.schemaVersion !== MOOR_PIN_SCHEMA_VERSION) {
    throw new Error(`moor pin schemaVersion ${pin.schemaVersion} is not the supported ${MOOR_PIN_SCHEMA_VERSION}`);
  }
  if (typeof pin.version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(pin.version)) {
    throw new Error(`moor pin version must be a canonical tag like v0.1.0, got ${JSON.stringify(pin.version)}`);
  }
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw new Error('moor pin is missing the exact 40-hex release commit');
  }
  if (pin.repository !== MOOR_RELEASE_REPOSITORY) {
    // Production assets come from exactly one place — any other repository
    // string in a committed pin is a supply-chain red flag, not a config.
    throw new Error(`moor pin repository must be ${MOOR_RELEASE_REPOSITORY}, got ${pin.repository}`);
  }
  if (pin.targets === null || typeof pin.targets !== 'object') {
    throw new Error('moor pin carries no targets — fail closed, nothing to download');
  }
  const keys = Object.keys(pin.targets).sort();
  const expected = [...MOOR_TARGETS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(
      `moor pin must cover exactly the ratified 6-target matrix; got [${keys.join(', ')}]`
    );
  }
  for (const [triple, target] of Object.entries(pin.targets)) {
    const targetKeys = Object.keys(target ?? {}).sort();
    const expectedTarget = ['asset', 'sha256', 'size'];
    if (targetKeys.length !== expectedTarget.length || targetKeys.some((key, i) => key !== expectedTarget[i])) {
      throw new Error(
        `moor pin target ${triple} must carry exactly [${expectedTarget.join(', ')}]; got [${targetKeys.join(', ')}]`
      );
    }
    // A literal release filename: name chars only — no traversal, path
    // separators, query/fragment syntax, or whitespace can reach a URL.
    if (typeof target.asset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\.exe)?$/.test(target.asset) || target.asset.includes('..')) {
      throw new Error(`moor pin target ${triple} asset is not a literal release filename: ${JSON.stringify(target.asset)}`);
    }
    if (!Number.isSafeInteger(target?.size) || target.size <= 0 || target.size > MAX_ASSET_BYTES) {
      throw new Error(`moor pin target ${triple} is missing a sane byte size`);
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
    // Explicit override for tests/candidate mirrors ONLY: https or file.
    if (!baseUrl.startsWith('https://') && !baseUrl.startsWith('file://')) {
      throw new Error('DESK_MOOR_RELEASE_BASE_URL must be https:// or file://');
    }
    return `${baseUrl.replace(/\/$/, '')}/${target.asset}`;
  }
  return `${pin.repository}/releases/download/${pin.version}/${target.asset}`;
}

async function download(url) {
  if (url.startsWith('file://')) {
    return readFileSync(fileURLToPath(url));
  }
  if (!url.startsWith('https://')) {
    throw new Error(`moor downloads are https-only (or an explicit file:// test override): ${url}`);
  }
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)
  });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new Error(`downloaded asset exceeds the ${MAX_ASSET_BYTES}-byte cap — refusing`);
  }
  return bytes;
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
  if (bytes.length !== target.size) {
    throw new Error(
      `moor asset size mismatch for ${triple}: downloaded ${bytes.length} bytes, pinned ${target.size} — refusing to install`
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== target.sha256) {
    throw new Error(
      `moor asset digest mismatch for ${triple}: downloaded ${digest}, pinned ${target.sha256} — refusing to install`
    );
  }
  mkdirSync(dirname(outfile), { recursive: true });
  // Stage in a private temp DIRECTORY under the CANONICAL basename: the moor
  // spec (§3) derives the --version answer from the invoked basename, so a
  // probe of `moor.tmp-<pid>` would answer `moor.tmp-<pid> 0.1.0` and fail
  // attestation on every real binary (desk#40). Probing `<dir>/moor` keeps
  // attest-before-promote AND the canonical answer.
  const stagingDir = join(dirname(outfile), `.moor-stage-${process.pid}`);
  const staging = join(stagingDir, 'moor');
  try {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    const attested = attest(staging);
    if (!attested.ok) {
      throw new Error(`downloaded moor failed attestation: ${attested.reason}`);
    }
    renameSync(staging, outfile); // atomic: no partial binary is ever active
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
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
