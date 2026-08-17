#!/usr/bin/env node
// Project a QA-approved moor release manifest (v1) into the pin document Desk
// consumes: scripts/distribution/moor-pin.json.
//
// The projection is NORMATIVE, not invented here: moor
// docs/release-manifest-v1.md § "Desk pin projection" defines it. This file is
// the mechanical implementation of that section and nothing more. Read it there
// before changing anything here.
//
// The pin is the ONLY artifact Desk consumes, so the projection is the point at
// which incomplete release evidence could quietly become a complete claim. It
// therefore REFUSES rather than repairs: a manifest that is not
// v1, that is missing a projected input, whose target matrix is not exactly the
// ratified four, or whose coverage is not exactly full-matrix produces an error
// naming that specific problem and NO output. A
// partially-projected pin is never written.
//
// Nothing here re-derives a size or a digest. Every projected value except
// `schemaVersion` is copied verbatim from the manifest, so the pin and the
// manifest can be compared literally and the two documents cannot drift.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOOR_CLOSURE_LABELS,
  MOOR_PIN_SCHEMA_VERSION,
  MOOR_TARGETS,
  PIN_RELATIVE_PATH,
  readMoorPin
} from './fetch-moor.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The schema of the document this projector READS (moor release-manifest v1). */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The schema of the document this projector WRITES. This is the one key the
 * projection sets rather than copies: the manifest states 1 (its own schema)
 * and the pin states 3 (the consumer schema). The two documents version
 * independently, so copying that number would claim the pin is something it is
 * not.
 */
export const PIN_SCHEMA_VERSION = 3;

// The consumer owns the pin schema. If it moves, the projection is no longer
// known to satisfy it, so fail at load rather than emit a document claiming a
// version whose requirements this file has never been reviewed against.
if (MOOR_PIN_SCHEMA_VERSION !== PIN_SCHEMA_VERSION) {
  throw new Error(
    `moor pin consumer moved to schemaVersion ${MOOR_PIN_SCHEMA_VERSION}; this projector is only ` +
      `reviewed against ${PIN_SCHEMA_VERSION} — re-derive the projection from moor ` +
      'docs/release-manifest-v1.md before bumping this constant'
  );
}

/**
 * The ratified four-target matrix in the canonical row order of the moor release
 * manifest's target table. Spelled out literally because the ORDER is normative
 * for the canonical bytes and the consumer's own constant is only ever compared
 * as a set; the cross-check below keeps the two from drifting apart.
 */
export const CANONICAL_TARGET_ORDER = Object.freeze([
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin'
]);

{
  const projected = [...CANONICAL_TARGET_ORDER].sort().join(', ');
  const consumed = [...MOOR_TARGETS].sort().join(', ');
  if (projected !== consumed) {
    throw new Error(
      `the projected target matrix [${projected}] no longer matches the matrix the consumer requires [${consumed}]`
    );
  }
}

/** The keys copied out of each manifest target entry — a whitelist (see below). */
const PROJECTED_TARGET_FIELDS = Object.freeze(['asset', 'size', 'sha256']);

/** The top-level manifest keys the pin needs, besides the schemaVersion it sets. */
const PROJECTED_INPUTS = Object.freeze(['repository', 'version', 'commit', 'coverage', 'targets']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Ordered key list for diagnostics; sorted so a message is stable to compare. */
function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

/** Validate the only coverage object the hosted four-target matrix can emit. */
function validateManifestCoverage(coverage) {
  if (!isPlainObject(coverage)) {
    throw new Error(
      `moor release manifest coverage must be an object stating which lanes verified this candidate; got ${JSON.stringify(coverage) ?? String(coverage)}`
    );
  }
  const keys = sortedKeys(coverage);
  const expected = ['requiredClosure'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(
      `moor release manifest coverage must carry exactly [${expected.join(', ')}]; got [${keys.join(', ')}]`
    );
  }
  if (!MOOR_CLOSURE_LABELS.includes(coverage.requiredClosure)) {
    throw new Error(
      `moor release manifest coverage requiredClosure must be ${MOOR_CLOSURE_LABELS[0]}; got ${JSON.stringify(coverage.requiredClosure)}`
    );
  }
}

/** Copy coverage verbatim with canonical key order. */
function projectCoverage(coverage) {
  return { requiredClosure: coverage.requiredClosure };
}

/**
 * Project a parsed moor release manifest into the pin object. Pure: it reads the
 * manifest, returns a fresh object, and never touches the filesystem.
 *
 * The projection is a WHITELIST — it copies the keys it names and nothing
 * else. An exclusion list would leak the next field added to the manifest into
 * the pin, and because the consumer rejects unknown keys that leak would surface
 * as a fail-closed refusal at install time on a developer's machine rather than
 * as an obvious failure here at build time. `candidate`, `artifactId`,
 * `artifactName` and `provenance` are excluded deliberately: they identify the
 * candidate run, and they must have been validated BEFORE this projection was
 * made rather than carried along in the consumer's document.
 */
export function projectMoorPin(manifest) {
  if (!isPlainObject(manifest)) {
    throw new Error(
      `moor release manifest must be a JSON object; got ${JSON.stringify(manifest) ?? String(manifest)}`
    );
  }
  // SUBSTANCE BEFORE SHAPE. A manifest at another schema version is missing v1
  // keys *because* it is not v1; reporting the key set first would hide the one
  // fact that explains the failure and send the operator hunting for a field
  // that moved on purpose. The consumer diagnoses its own pin the same way.
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `moor release manifest schemaVersion ${JSON.stringify(manifest.schemaVersion)} is not the release-manifest v${MANIFEST_SCHEMA_VERSION} this projector reads`
    );
  }
  for (const input of PROJECTED_INPUTS) {
    if (manifest[input] === undefined || manifest[input] === null) {
      throw new Error(`moor release manifest is missing the projected input "${input}"`);
    }
  }
  validateManifestCoverage(manifest.coverage);

  if (!isPlainObject(manifest.targets)) {
    throw new Error('moor release manifest targets must be an object carrying the ratified four-target matrix');
  }
  const targetKeys = sortedKeys(manifest.targets);
  const expectedTargets = [...CANONICAL_TARGET_ORDER].sort();
  if (
    targetKeys.length !== expectedTargets.length ||
    targetKeys.some((key, index) => key !== expectedTargets[index])
  ) {
    throw new Error(
      `moor release manifest targets must be exactly the ratified four-target matrix [${expectedTargets.join(', ')}]; got [${targetKeys.join(', ')}]`
    );
  }

  const targets = {};
  for (const triple of CANONICAL_TARGET_ORDER) {
    const target = manifest.targets[triple];
    if (!isPlainObject(target)) {
      throw new Error(`moor release manifest target ${triple} must be an object`);
    }
    const projected = {};
    for (const field of PROJECTED_TARGET_FIELDS) {
      if (target[field] === undefined || target[field] === null) {
        throw new Error(`moor release manifest target ${triple} is missing the projected field "${field}"`);
      }
      projected[field] = target[field];
    }
    targets[triple] = projected;
  }

  // Key order here IS the canonical byte order of the pin.
  return {
    schemaVersion: PIN_SCHEMA_VERSION,
    repository: manifest.repository,
    version: manifest.version,
    commit: manifest.commit,
    coverage: projectCoverage(manifest.coverage),
    targets
  };
}

/**
 * The canonical bytes of a pin, matching the manifest's own canonicalisation
 * rules so that two projections of one manifest are byte-identical: UTF-8
 * without a byte-order mark, the key order established above, two spaces per
 * indent level and one space after each `:`, no trailing whitespace, and
 * exactly one LF terminating the final `}`.
 */
export function canonicalPinBytes(pin) {
  return `${JSON.stringify(pin, null, 2)}\n`;
}

/** Project and serialise in one step — the form the CLI and callers want. */
export function projectMoorPinBytes(manifest) {
  return canonicalPinBytes(projectMoorPin(manifest));
}

/**
 * Read a manifest file. Plain JSON.parse by design: the manifest's own producer
 * and QA lane own its validation (duplicate keys included) per moor
 * docs/release-manifest-v1.md, and this projector's contract begins at an
 * ALREADY QA-APPROVED manifest. What it does guarantee is that whatever comes
 * out the far end is a document the consumer accepts — see the self-check below.
 */
function readManifestFile(path) {
  if (!existsSync(path)) {
    throw new Error(`no moor release manifest at ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`moor release manifest at ${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * Hand the projected bytes to the REAL consumer before they reach the
 * repository. `readMoorPin` only reads from a root, so the candidate bytes are
 * staged in a private temp root: nothing unvalidated is ever written to the
 * destination, not even briefly.
 */
function assertConsumerAccepts(bytes) {
  const root = mkdtempSync(join(tmpdir(), 'desk-moor-pin-projection-'));
  try {
    const staged = join(root, PIN_RELATIVE_PATH);
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, bytes);
    readMoorPin(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Strict argv parsing, matching the acquirer's rule: an unrecognised argument is
 * REFUSED, never ignored, because a silently dropped flag is how an operator
 * believes they asked for something they did not get.
 */
export function parseProjectPinArgs(argv) {
  let manifestPath;
  let outPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') {
      if (outPath !== undefined) throw new Error('--out may be given at most once');
      outPath = argv[index + 1];
      if (outPath === undefined) throw new Error('--out requires a path');
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`unknown argument ${JSON.stringify(argument)}; usage: project-moor-pin.mjs <manifest.json> [--out <path>]`);
    }
    if (manifestPath !== undefined) {
      throw new Error(`unexpected second manifest path ${JSON.stringify(argument)}`);
    }
    manifestPath = argument;
  }
  if (manifestPath === undefined) {
    throw new Error('usage: project-moor-pin.mjs <manifest.json> [--out <path>]');
  }
  return { manifestPath, outPath };
}

/** Write the projection of `manifestPath` to `outPath`, atomically or not at all. */
export function projectMoorPinFile({ manifestPath, outPath = join(DEFAULT_ROOT, PIN_RELATIVE_PATH) }) {
  const bytes = projectMoorPinBytes(readManifestFile(manifestPath));
  assertConsumerAccepts(bytes);
  mkdirSync(dirname(outPath), { recursive: true });
  const staging = `${outPath}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, bytes);
    renameSync(staging, outPath); // atomic: no partial pin is ever readable
  } finally {
    rmSync(staging, { force: true });
  }
  return { outPath, bytes };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const { manifestPath, outPath } = parseProjectPinArgs(process.argv.slice(2));
    const projected = projectMoorPinFile({ manifestPath, outPath });
    process.stdout.write(`projected ${manifestPath} -> ${projected.outPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
