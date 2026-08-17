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
// v3: the pin carries the candidate's `coverage` verbatim and binds to the
// four-target Unix release matrix. The
// version MOVED rather than the field being added quietly, so a pin written
// before this — which cannot say which lanes verified it — is rejected by name
// instead of being read as though its closure were full.
export const MOOR_PIN_SCHEMA_VERSION = 3;
/** The only closure the four-target release matrix can state. */
export const MOOR_CLOSURE_LABELS = Object.freeze(['full-matrix']);
/** The ONLY repository production assets may come from. */
export const MOOR_RELEASE_REPOSITORY = 'https://github.com/BrainyBlaze/moor';
/** The ratified four-key target matrix — a pin must cover EXACTLY these. */
export const MOOR_TARGETS = Object.freeze([
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin'
]);
const DOWNLOAD_DEADLINE_MS = 60_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024; // no holder build approaches this

function parseJsonRejectingDuplicateKeys(source) {
  const value = JSON.parse(source);
  // JSON.parse establishes the grammar first; this token walk retains object
  // members that the parsed value would collapse before exact-key validation.
  const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let tokenIndex = 0;
  const visitValue = () => {
    const token = tokens[tokenIndex++];
    if (token === '[') {
      if (tokens[tokenIndex] === ']') {
        tokenIndex += 1;
        return;
      }
      while (true) {
        visitValue();
        if (tokens[tokenIndex++] === ']') return;
      }
    }
    if (token !== '{') return;
    const keys = new Set();
    if (tokens[tokenIndex] === '}') {
      tokenIndex += 1;
      return;
    }
    while (true) {
      const key = JSON.parse(tokens[tokenIndex++]);
      if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
      keys.add(key);
      tokenIndex += 1; // colon; JSON.parse above already established valid syntax
      visitValue();
      if (tokens[tokenIndex++] === '}') return;
    }
  };

  visitValue();
  return value;
}

/**
 * The canonical target key for a host — the ratified four-key matrix (no libc
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
    default:
      throw new Error(`unsupported platform for moor: ${platform}`);
  }
}

/**
 * Validate the candidate coverage the pin inherits from the release manifest.
 * Every required lane is hosted, so the only valid shape states full closure
 * and carries no secondary list.
 */
function validatePinCoverage(coverage) {
  if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) {
    throw new Error('moor pin carries no coverage — it cannot state which lanes verified this candidate');
  }
  const keys = Object.keys(coverage).sort();
  const expected = ['requiredClosure'];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new Error(
      `moor pin full-matrix coverage must carry exactly [requiredClosure]; got [${keys.join(', ')}]`
    );
  }
  if (!MOOR_CLOSURE_LABELS.includes(coverage.requiredClosure)) {
    throw new Error(
      `moor pin requiredClosure must be ${MOOR_CLOSURE_LABELS[0]}; got ${JSON.stringify(coverage.requiredClosure)}`
    );
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
  const pin = parseJsonRejectingDuplicateKeys(readFileSync(path, 'utf8'));
  // The schema version is diagnosed FIRST: a real pre-coverage pin carries both
  // the old version and no coverage, and reporting that as a generic key-set
  // mismatch hides the one fact the operator needs — that the pin predates
  // coverage and cannot say what verified it.
  if (pin.schemaVersion !== MOOR_PIN_SCHEMA_VERSION) {
    const predates =
      pin.schemaVersion === 1 && (pin.coverage === undefined || pin.coverage === null);
    throw new Error(
      predates
        ? `moor pin schemaVersion 1 predates release coverage: it cannot state which lanes verified this candidate — re-project it from the release manifest at schemaVersion ${MOOR_PIN_SCHEMA_VERSION}`
        : `moor pin schemaVersion ${pin.schemaVersion} is not the supported ${MOOR_PIN_SCHEMA_VERSION}`
    );
  }
  // EXACT key sets: an unknown key is either a typo silently ignored (a
  // pinned field that never actually pins) or smuggled data — both rejected.
  const topKeys = Object.keys(pin).sort();
  const expectedTop = ['commit', 'coverage', 'repository', 'schemaVersion', 'targets', 'version'];
  if (topKeys.length !== expectedTop.length || topKeys.some((key, i) => key !== expectedTop[i])) {
    throw new Error(`moor pin must carry exactly [${expectedTop.join(', ')}]; got [${topKeys.join(', ')}]`);
  }
  // The release document forbids a leading zero in any component: `v01.2.3`
  // and `v1.2.3` denote one version but name two different tags, so a consumer
  // that accepts both cannot say which release it pinned. A bare `0` component
  // is canonical and stays accepted — v0.1.0 is the first release.
  if (
    typeof pin.version !== 'string' ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pin.version)
  ) {
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
  validatePinCoverage(pin.coverage);
  if (pin.targets === null || typeof pin.targets !== 'object') {
    throw new Error('moor pin carries no targets — fail closed, nothing to download');
  }
  const keys = Object.keys(pin.targets).sort();
  const expected = [...MOOR_TARGETS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(
      `moor pin must cover exactly the ratified four-target matrix; got [${keys.join(', ')}]`
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
    if (typeof target.asset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.asset) || target.asset.includes('..')) {
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

/**
 * Strict argv parsing: acquisition has no options, so every argument is
 * refused rather than silently ignored.
 */
export function parseFetchMoorArgs(argv) {
  if (argv.length > 0) {
    throw new Error(
      `unknown argument ${JSON.stringify(argv[0])}; fetch-moor accepts no arguments`
    );
  }
  return {};
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  parseFetchMoorArgs(process.argv.slice(2));
  const { outfile, version, triple, sha256 } = await fetchMoor();
  process.stdout.write(`installed ${outfile} — moor ${version} (${triple}, sha256 ${sha256})\n`);
}
