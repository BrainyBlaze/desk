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
// which a narrowed candidate could quietly become indistinguishable from a
// complete one. It therefore REFUSES rather than repairs: a manifest that is not
// v1, that is missing a projected input, whose target matrix is not exactly the
// ratified six, or whose coverage does not match one of the three specified
// branches produces an error naming that specific problem and NO output. A
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
  MOOR_DEFERRED_TRIPLES,
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
 * and the pin states 2 (the consumer schema). The two documents version
 * independently, so copying that number would claim the pin is something it is
 * not — and, worse, a pin stamped 1 is exactly the pre-coverage document the
 * consumer refuses by name.
 */
export const PIN_SCHEMA_VERSION = 2;

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
 * The ratified six-target matrix in the canonical row order of the moor release
 * manifest's target table. Spelled out literally because the ORDER is normative
 * for the canonical bytes and the consumer's own constant is only ever compared
 * as a set; the cross-check below keeps the two from drifting apart.
 */
export const CANONICAL_TARGET_ORDER = Object.freeze([
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc'
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

/**
 * Validate the manifest's coverage object against the three branches moor
 * defines. The pin copies this object VERBATIM, so anything wrong here would
 * either be copied into the pin (and refused at install time, far from the
 * mistake) or — worse, for the label/list disagreement — be copied into a pin
 * that validates while lying about how much verified the candidate.
 *
 * The LABEL is checked before the key set: a coverage object states, first of
 * all, which of the two situations produced the candidate, and reporting a key
 * mismatch on an object whose closure is nonsense hides the fact that actually
 * explains the failure.
 */
function validateManifestCoverage(coverage) {
  if (!isPlainObject(coverage)) {
    throw new Error(
      `moor release manifest coverage must be an object stating which lanes verified this candidate; got ${JSON.stringify(coverage) ?? String(coverage)}`
    );
  }
  if (!MOOR_CLOSURE_LABELS.includes(coverage.requiredClosure)) {
    throw new Error(
      `moor release manifest coverage requiredClosure must be one of [${MOOR_CLOSURE_LABELS.join(', ')}]; got ${JSON.stringify(coverage.requiredClosure)}`
    );
  }
  const full = coverage.requiredClosure === 'full-matrix';
  const keys = sortedKeys(coverage);
  // "full-matrix" asserts every deferred pair verified too, so the array would
  // be empty — and this format never encodes an empty array.
  const expected = full ? ['requiredClosure'] : ['requiredClosure', 'unverified'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(
      full
        ? `moor release manifest full-matrix coverage must carry exactly [${expected.join(', ')}]; got [${keys.join(', ')}]`
        : `moor release manifest narrowed coverage must carry exactly [${expected.join(', ')}]; got [${keys.join(', ')}]`
    );
  }
  if (full) return;
  if (!Array.isArray(coverage.unverified) || coverage.unverified.length === 0) {
    throw new Error(
      'moor release manifest narrowed coverage must list every unverified lane — a narrowed closure that names nothing cannot be checked'
    );
  }
  // The deferred vocabulary is the consumer's binding constant, reused rather
  // than restated: a projector that accepted a lane string the consumer rejects
  // would emit a pin that fails at install time instead of at projection time.
  let previous = '';
  for (const entry of coverage.unverified) {
    const entryKeys = sortedKeys(entry);
    const expectedEntry = ['gate', 'lane', 'target'];
    if (entryKeys.length !== expectedEntry.length || entryKeys.some((key, index) => key !== expectedEntry[index])) {
      throw new Error(
        `moor release manifest unverified entry must carry exactly [target, gate, lane]; got [${entryKeys.join(', ')}]`
      );
    }
    const triple = `${entry.target}/${entry.gate}/${entry.lane}`;
    if (!MOOR_DEFERRED_TRIPLES.includes(triple)) {
      throw new Error(
        `moor release manifest unverified lane ${triple} is not one of the deferred lanes of the frozen matrix: [${MOOR_DEFERRED_TRIPLES.join(', ')}]`
      );
    }
    if (triple === previous) {
      throw new Error(`moor release manifest lists the unverified lane ${triple} more than once`);
    }
    if (triple < previous) {
      throw new Error(
        `moor release manifest unverified lanes must ascend canonically; ${triple} follows ${previous}`
      );
    }
    previous = triple;
  }
  // The label is a CLAIM about how much is missing, and it is the part of the
  // object a reader trusts at a glance, so it must agree with what is listed.
  const missing = coverage.unverified.length;
  const expectedLabel = missing === MOOR_DEFERRED_TRIPLES.length ? 'hosted-only' : 'partial';
  if (coverage.requiredClosure !== expectedLabel) {
    throw new Error(
      `moor release manifest closure ${coverage.requiredClosure} contradicts its own list: ${missing} of ${MOOR_DEFERRED_TRIPLES.length} deferred lanes are unverified, which is ${expectedLabel}`
    );
  }
}

/**
 * Copy one deferred-lane entry with its keys in the canonical order the manifest
 * defines (`target`, `gate`, `lane`). Values are untouched; only the emission
 * order is fixed, so two projections of one manifest are byte-identical.
 */
function projectUnverifiedEntry(entry) {
  return { target: entry.target, gate: entry.gate, lane: entry.lane };
}

/** Copy coverage verbatim, key order fixed to the branch the manifest declares. */
function projectCoverage(coverage) {
  if (coverage.requiredClosure === 'full-matrix') {
    return { requiredClosure: coverage.requiredClosure };
  }
  return {
    requiredClosure: coverage.requiredClosure,
    unverified: coverage.unverified.map(projectUnverifiedEntry)
  };
}

/**
 * Project a parsed moor release manifest into the pin object. Pure: it reads the
 * manifest, returns a fresh object, and never touches the filesystem.
 *
 * The projection is a WHITELIST — it copies the six keys it names and nothing
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
    throw new Error('moor release manifest targets must be an object carrying the ratified 6-target matrix');
  }
  const targetKeys = sortedKeys(manifest.targets);
  const expectedTargets = [...CANONICAL_TARGET_ORDER].sort();
  if (
    targetKeys.length !== expectedTargets.length ||
    targetKeys.some((key, index) => key !== expectedTargets[index])
  ) {
    throw new Error(
      `moor release manifest targets must be exactly the ratified 6-target matrix [${expectedTargets.join(', ')}]; got [${targetKeys.join(', ')}]`
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
