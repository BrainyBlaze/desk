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
// v2 (desk#60): the pin carries the candidate's `coverage` verbatim. The
// version MOVED rather than the field being added quietly, so a pin written
// before this — which cannot say which lanes verified it — is rejected by name
// instead of being read as though its closure were full.
export const MOOR_PIN_SCHEMA_VERSION = 2;
/** The closure labels the release assembler is allowed to state. */
export const MOOR_CLOSURE_LABELS = Object.freeze(['full-matrix', 'hosted-only', 'partial']);
/**
 * The EXACT deferred vocabulary of moor release-manifest v1, in the canonical
 * ascending order the assembler emits. Pin schema v2 is the consumer half of
 * that manifest and deliberately binds to this set: without it, any invented
 * gate/lane string stays structurally valid and "coverage copied verbatim" is
 * unenforceable at the only artifact Desk consumes. Enrolling a runner does not
 * change this vocabulary — verified triples simply drop out of `unverified`
 * until the closure is full. Changing the vocabulary is a cross-repo contract
 * change and MUST move the pin schema version, never be accepted silently.
 */
export const MOOR_DEFERRED_TRIPLES = Object.freeze([
  'x86_64-pc-windows-msvc/compatibility/windows-10-1809-x64',
  'x86_64-pc-windows-msvc/compatibility/windows-server-2019-x64',
  'x86_64-pc-windows-msvc/native-conformance/windows-10-1809-x64',
  'x86_64-pc-windows-msvc/native-conformance/windows-server-2019-x64',
  'x86_64-unknown-linux-musl/compatibility/wsl1-ubuntu-22.04-x64',
  'x86_64-unknown-linux-musl/compatibility/wsl2-ubuntu-22.04-x64'
]);
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

/**
 * Validate the candidate coverage the pin inherits from the release manifest.
 * The two shapes are mirrored from the assembler exactly: a full matrix states
 * its label and nothing else, and a narrowed closure MUST name every lane it
 * could not verify — a narrowed claim with no list is unfalsifiable, which is
 * worse than no claim at all.
 */
function validatePinCoverage(coverage) {
  if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) {
    throw new Error('moor pin carries no coverage — it cannot state which lanes verified this candidate');
  }
  if (!MOOR_CLOSURE_LABELS.includes(coverage.requiredClosure)) {
    throw new Error(
      `moor pin requiredClosure must be one of [${MOOR_CLOSURE_LABELS.join(', ')}]; got ${JSON.stringify(coverage.requiredClosure)}`
    );
  }
  const full = coverage.requiredClosure === 'full-matrix';
  const keys = Object.keys(coverage).sort();
  const expected = full ? ['requiredClosure'] : ['requiredClosure', 'unverified'];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new Error(
      full
        ? `moor pin full-matrix coverage must carry exactly [requiredClosure]; got [${keys.join(', ')}]`
        : `moor pin narrowed coverage must carry exactly [${expected.join(', ')}]; got [${keys.join(', ')}]`
    );
  }
  if (full) return;
  if (!Array.isArray(coverage.unverified) || coverage.unverified.length === 0) {
    throw new Error(
      'moor pin narrowed coverage must list every unverified lane — a narrowed closure that names nothing cannot be checked'
    );
  }
  // Each entry must be one of the SIX deferred triples this schema version
  // binds to, listed once, in the assembler's canonical ascending order. A
  // duplicate would pad the list into looking more complete than it is, and an
  // arbitrary order makes two projections of one manifest differ byte-wise.
  let previous = '';
  for (const entry of coverage.unverified) {
    const entryKeys = Object.keys(entry ?? {}).sort();
    const expectedEntry = ['gate', 'lane', 'target'];
    if (entryKeys.length !== expectedEntry.length || entryKeys.some((key, i) => key !== expectedEntry[i])) {
      throw new Error(
        `moor pin unverified entry must carry exactly [${expectedEntry.join(', ')}]; got [${entryKeys.join(', ')}]`
      );
    }
    const triple = `${entry.target}/${entry.gate}/${entry.lane}`;
    if (!MOOR_DEFERRED_TRIPLES.includes(triple)) {
      throw new Error(
        `moor pin unverified entry ${triple} is not one of the deferred triples this pin schema binds to: [${MOOR_DEFERRED_TRIPLES.join(', ')}]`
      );
    }
    if (triple === previous) {
      throw new Error(`moor pin lists the unverified lane ${triple} more than once`);
    }
    if (triple < previous) {
      throw new Error(`moor pin unverified lanes must ascend canonically; ${triple} follows ${previous}`);
    }
    previous = triple;
  }
  // The label is a CLAIM about how much is missing, so it must agree with what
  // is actually listed — otherwise a reader who trusts the label at a glance is
  // misled by an object that contradicts itself.
  const missing = coverage.unverified.length;
  const expectedLabel = missing === MOOR_DEFERRED_TRIPLES.length ? 'hosted-only' : 'partial';
  if (coverage.requiredClosure !== expectedLabel) {
    throw new Error(
      `moor pin closure ${coverage.requiredClosure} contradicts its own list: ${missing} of ${MOOR_DEFERRED_TRIPLES.length} deferred lanes are unverified, which is ${expectedLabel}`
    );
  }
}

/** The one argument that approves a narrowed candidate, spelled out in full. */
export const NARROWED_COVERAGE_FLAG = '--allow-narrowed-coverage';

/**
 * Installing a narrowed candidate is an OPERATOR decision, never a default: a
 * pin whose closure is not the full matrix is refused unless the operator says
 * so by name, and the refusal names every lane that was never verified so the
 * decision is made against facts rather than a label.
 */
export function assertCoverageAcceptable(pin, { allowNarrowed = false } = {}) {
  // A literal boolean, never a truthy value: the string 'false', 1, {} and []
  // are all truthy, so approving on truthiness would grant approval to a caller
  // who believes they withheld it — the worst possible direction to fail.
  if (allowNarrowed !== true && allowNarrowed !== false) {
    throw new Error(
      `narrowed-coverage approval must be a literal boolean; got ${JSON.stringify(allowNarrowed)}`
    );
  }
  if (pin.coverage.requiredClosure === 'full-matrix' || allowNarrowed) return;
  const lanes = pin.coverage.unverified
    .map((entry) => `${entry.target}/${entry.gate}/${entry.lane}`)
    .join(', ');
  throw new Error(
    `moor pin closure is ${pin.coverage.requiredClosure}, not full-matrix: these lanes never verified this candidate — ${lanes}. ` +
      `Pass ${NARROWED_COVERAGE_FLAG} to install it anyway.`
  );
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
  validatePinCoverage(pin.coverage);
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
  attest = defaultAttestation,
  allowNarrowedCoverage = false
} = {}) {
  const pin = readMoorPin(root);
  assertCoverageAcceptable(pin, { allowNarrowed: allowNarrowedCoverage });
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
 * Strict argv parsing: an unrecognised argument is REFUSED, never ignored — a
 * silently dropped flag is how an operator believes they approved something
 * they did not. Approval is a command-line decision only; no environment
 * variable can grant it, because an ambient variable set once in a shell
 * profile turns a deliberate decision into a permanent default.
 */
export function parseFetchMoorArgs(argv) {
  let allowNarrowedCoverage = false;
  for (const argument of argv) {
    if (argument === NARROWED_COVERAGE_FLAG) {
      // Exactly zero or one. A repeated approval is a malformed command line,
      // and quietly collapsing it to one approval is the same fail-open as
      // ignoring an unknown flag.
      if (allowNarrowedCoverage) {
        throw new Error(`${NARROWED_COVERAGE_FLAG} may be given at most once`);
      }
      allowNarrowedCoverage = true;
      continue;
    }
    throw new Error(
      `unknown argument ${JSON.stringify(argument)}; the only accepted argument is ${NARROWED_COVERAGE_FLAG}`
    );
  }
  return { allowNarrowedCoverage };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { allowNarrowedCoverage } = parseFetchMoorArgs(process.argv.slice(2));
  const { outfile, version, triple, sha256 } = await fetchMoor({ allowNarrowedCoverage });
  process.stdout.write(`installed ${outfile} — moor ${version} (${triple}, sha256 ${sha256})\n`);
}
