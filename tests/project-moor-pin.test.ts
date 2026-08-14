// desk#60, remaining code gap: `scripts/fetch-moor.mjs` reads and strictly
// validates `scripts/distribution/moor-pin.json`, but NOTHING in this repository
// could produce that document. A human hand-authoring it gets it wrong — the
// consumer rejects duplicate keys, demands an exact key set, demands the
// deferred lanes in canonical ascending order with no repeats, and demands the
// closure label agree with the list it carries.
//
// `scripts/project-moor-pin.mjs` is the mechanical projection specified in the
// moor repo at docs/release-manifest-v1.md § "Desk pin projection". These tests
// bind it to the REAL consumer: the pin is written as bytes and handed to
// `readMoorPin` from fetch-moor.mjs, never to a restatement of the schema here.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIN_RELATIVE_PATH,
  assertCoverageAcceptable,
  readMoorPin
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore plain-JS module without type declarations
} from '../scripts/fetch-moor.mjs';
import {
  canonicalPinBytes,
  projectMoorPin,
  projectMoorPinBytes
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore plain-JS module without type declarations
} from '../scripts/project-moor-pin.mjs';

/**
 * The literal v0.1.0 target table from moor docs/release-manifest-v1.md, in the
 * canonical six-row order. Written out rather than imported so a drift in
 * Desk's own constants cannot make these witnesses self-confirming.
 */
const TARGET_TABLE: Array<[string, string, string]> = [
  ['x86_64-unknown-linux-musl', 'moor-0.1.0-linux-x64', 'moor-candidate-x86_64-unknown-linux-musl'],
  ['aarch64-unknown-linux-musl', 'moor-0.1.0-linux-arm64', 'moor-candidate-aarch64-unknown-linux-musl'],
  ['x86_64-apple-darwin', 'moor-0.1.0-macos-x64', 'moor-candidate-x86_64-apple-darwin'],
  ['aarch64-apple-darwin', 'moor-0.1.0-macos-arm64', 'moor-candidate-aarch64-apple-darwin'],
  ['x86_64-pc-windows-msvc', 'moor-0.1.0-windows-x64.exe', 'moor-candidate-x86_64-pc-windows-msvc'],
  ['aarch64-pc-windows-msvc', 'moor-0.1.0-windows-arm64.exe', 'moor-candidate-aarch64-pc-windows-msvc']
];

const COMMIT = 'f1bd230bdaf0a7a476f4069a95a2cee77996ab48';

/**
 * The six deferred (target, gate, lane) triples of the frozen matrix, ascending,
 * spelled out from moor docs/release-matrix.md § "Required closure and the
 * deferred set" — again literal, not imported.
 */
const DEFERRED_LANES = [
  { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-10-1809-x64' },
  { target: 'x86_64-pc-windows-msvc', gate: 'compatibility', lane: 'windows-server-2019-x64' },
  { target: 'x86_64-pc-windows-msvc', gate: 'native-conformance', lane: 'windows-10-1809-x64' },
  { target: 'x86_64-pc-windows-msvc', gate: 'native-conformance', lane: 'windows-server-2019-x64' },
  { target: 'x86_64-unknown-linux-musl', gate: 'compatibility', lane: 'wsl1-ubuntu-22.04-x64' },
  { target: 'x86_64-unknown-linux-musl', gate: 'compatibility', lane: 'wsl2-ubuntu-22.04-x64' }
];

function digestFor(triple: string): string {
  // A deterministic 64-hex stand-in; the projector copies it verbatim and never
  // recomputes it, so its provenance is irrelevant to the projection.
  let hex = '';
  for (let index = 0; hex.length < 64; index += 1) {
    hex += Array.from(`${triple}#${index}`)
      .map((character) => (character.codePointAt(0)! % 16).toString(16))
      .join('');
  }
  return hex.slice(0, 64);
}

/** A conforming release-manifest v1, complete with the fields the pin excludes. */
function manifestWith(coverage: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repository: 'https://github.com/BrainyBlaze/moor',
    version: 'v0.1.0',
    commit: COMMIT,
    candidate: {
      workflowRunId: '31750058794',
      workflowRunAttempt: 1,
      metadataArtifactName: 'moor-release-candidate-v1'
    },
    coverage,
    targets: Object.fromEntries(
      TARGET_TABLE.map(([triple, asset, artifactName], row) => [
        triple,
        {
          asset,
          size: 4_100_000 + row,
          sha256: digestFor(triple),
          artifactId: `920084344${row}`,
          artifactName,
          provenance: {
            build: {
              workflowRunId: '31750058794',
              workflowRunAttempt: 1,
              jobId: `100000000${row}`,
              jobName: `build (${triple})`
            },
            verification: [
              {
                gate: 'identity',
                lane: 'ubuntu-24.04-x64',
                workflowRunId: '31750058794',
                workflowRunAttempt: 1,
                jobId: `200000000${row}`,
                jobName: `identity (${triple})`
              }
            ]
          }
        }
      ])
    )
  };
}

const FULL_MATRIX_MANIFEST = () => manifestWith({ requiredClosure: 'full-matrix' });
const HOSTED_ONLY_MANIFEST = () =>
  manifestWith({ requiredClosure: 'hosted-only', unverified: DEFERRED_LANES.map((lane) => ({ ...lane })) });

/**
 * Hand the projected BYTES to the real consumer exactly as it will meet them on
 * disk: through `readMoorPin`, which parses (rejecting duplicate keys) and
 * validates. Nothing here restates the pin schema.
 */
function readThroughRealValidator(bytes: string): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'desk-pin-projection-'));
  try {
    const path = join(root, PIN_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return readMoorPin(root) as Record<string, unknown>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('moor pin projection — the consumer accepts what the projector emits', () => {
  it('projects a full-matrix manifest into a pin the real validator reads', () => {
    const pin = readThroughRealValidator(projectMoorPinBytes(FULL_MATRIX_MANIFEST()));

    expect(Object.keys(pin).sort()).toEqual([
      'commit',
      'coverage',
      'repository',
      'schemaVersion',
      'targets',
      'version'
    ]);
    expect(pin.coverage).toEqual({ requiredClosure: 'full-matrix' });
    expect(pin.version).toBe('v0.1.0');
    expect(pin.commit).toBe(COMMIT);
    expect(pin.repository).toBe('https://github.com/BrainyBlaze/moor');
    for (const [triple, asset] of TARGET_TABLE) {
      expect((pin.targets as Record<string, unknown>)[triple]).toEqual({
        asset,
        size: expect.any(Number),
        sha256: digestFor(triple)
      });
    }
  });

  it('also satisfies the release-asset lane validator for a full-matrix candidate', async () => {
    // The publishing lane owns a second, stricter reading of the same document
    // (`validateMoorPin` lives in create-release-assets.mjs, NOT fetch-moor.mjs).
    // A projection the installer accepts but the publisher rejects would split
    // the pin into two incompatible documents, so bind to both.
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    expect(() => validateMoorPin(projectMoorPin(FULL_MATRIX_MANIFEST()))).not.toThrow();
  });

  it('projects a hosted-only manifest into a valid pin that the release gate refuses by default', () => {
    const pin = readThroughRealValidator(projectMoorPinBytes(HOSTED_ONLY_MANIFEST()));

    expect(pin.coverage).toEqual({
      requiredClosure: 'hosted-only',
      unverified: DEFERRED_LANES
    });
    // The gate: a narrowed closure is an OPERATOR decision, never a default.
    expect(() => assertCoverageAcceptable(pin)).toThrow(/closure is hosted-only, not full-matrix/);
    expect(() => assertCoverageAcceptable(pin)).toThrow(
      /x86_64-unknown-linux-musl\/compatibility\/wsl2-ubuntu-22\.04-x64/
    );
    expect(() => assertCoverageAcceptable(pin, { allowNarrowed: true })).not.toThrow();
  });
});

describe('moor pin projection — schemaVersion is set, never copied', () => {
  it('states the consumer schema 2 even though the manifest states 1', () => {
    const manifest = FULL_MATRIX_MANIFEST();
    expect(manifest.schemaVersion).toBe(1);

    const pin = projectMoorPin(manifest);

    expect(pin.schemaVersion).toBe(2);
    expect(pin.schemaVersion).not.toBe(manifest.schemaVersion);
  });
});

describe('moor pin projection — whitelist, not exclusion list', () => {
  it('drops candidate, artifact and provenance fields entirely', () => {
    const bytes = projectMoorPinBytes(FULL_MATRIX_MANIFEST());

    for (const excluded of [
      'candidate',
      'workflowRunId',
      'workflowRunAttempt',
      'metadataArtifactName',
      'artifactId',
      'artifactName',
      'provenance',
      'verification',
      'jobId',
      'jobName'
    ]) {
      expect(bytes).not.toContain(excluded);
    }
  });

  it('does not leak an unknown extra top-level key the manifest gains later', () => {
    const manifest = { ...FULL_MATRIX_MANIFEST(), attestationBundle: { predicate: 'leak-me' } };

    const pin = projectMoorPin(manifest);

    expect(Object.keys(pin)).not.toContain('attestationBundle');
    expect(projectMoorPinBytes(manifest)).not.toContain('leak-me');
    // Still a pin the consumer accepts — a new manifest field must not break
    // the projection, only stay out of it.
    expect(() => readThroughRealValidator(projectMoorPinBytes(manifest))).not.toThrow();
  });

  it('does not leak an unknown extra field added to a target entry', () => {
    const manifest = FULL_MATRIX_MANIFEST();
    (manifest.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin'].signature =
      'leak-me-too';

    expect(projectMoorPinBytes(manifest)).not.toContain('leak-me-too');
  });
});

describe('moor pin projection — canonical bytes', () => {
  it('emits byte-identical output for two projections of one manifest', () => {
    expect(projectMoorPinBytes(FULL_MATRIX_MANIFEST())).toBe(projectMoorPinBytes(FULL_MATRIX_MANIFEST()));
    expect(projectMoorPinBytes(HOSTED_ONLY_MANIFEST())).toBe(projectMoorPinBytes(HOSTED_ONLY_MANIFEST()));
  });

  it('matches the manifest byte-canonicalisation rules: 2-space indent, one LF, no BOM', () => {
    const bytes = projectMoorPinBytes(HOSTED_ONLY_MANIFEST());

    expect(bytes.startsWith('{\n  "schemaVersion": 2,\n')).toBe(true);
    expect(bytes.endsWith('}\n')).toBe(true);
    expect(bytes.endsWith('}\n\n')).toBe(false);
    expect(bytes.charCodeAt(0)).toBe(0x7b); // no byte-order mark
    expect(bytes.includes('\r')).toBe(false);
    expect(/[ \t]+\n/.test(bytes)).toBe(false); // no trailing whitespace
    expect(Buffer.from(bytes, 'utf8').length).toBe(bytes.length); // printable ASCII only
    // Key order is the projection's own, not JSON.parse insertion luck.
    expect(bytes.indexOf('"repository"')).toBeLessThan(bytes.indexOf('"version"'));
    expect(bytes.indexOf('"version"')).toBeLessThan(bytes.indexOf('"commit"'));
    expect(bytes.indexOf('"commit"')).toBeLessThan(bytes.indexOf('"coverage"'));
    expect(bytes.indexOf('"coverage"')).toBeLessThan(bytes.indexOf('"targets"'));
  });

  it('emits the six targets in the canonical table order regardless of the pin object walk', () => {
    const bytes = projectMoorPinBytes(FULL_MATRIX_MANIFEST());
    const positions = TARGET_TABLE.map(([triple]) => bytes.indexOf(`"${triple}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('re-serialises canonically from an already-projected pin object', () => {
    const manifest = FULL_MATRIX_MANIFEST();
    expect(canonicalPinBytes(projectMoorPin(manifest))).toBe(projectMoorPinBytes(manifest));
  });

  it('returns a pin that does not alias the manifest it was projected from', () => {
    const manifest = HOSTED_ONLY_MANIFEST();
    const pin = projectMoorPin(manifest);

    (pin.coverage as { unverified: Array<Record<string, string>> }).unverified[0].lane = 'mutated';

    expect((manifest.coverage as { unverified: Array<Record<string, string>> }).unverified[0].lane).toBe(
      'windows-10-1809-x64'
    );
  });
});

describe('moor pin projection — refuses rather than repairs', () => {
  it('refuses a manifest that is not an object', () => {
    expect(() => projectMoorPin(null)).toThrow(
      'moor release manifest must be a JSON object; got null'
    );
  });

  it('refuses a manifest that is not schemaVersion 1', () => {
    const manifest = { ...FULL_MATRIX_MANIFEST(), schemaVersion: 2 };

    expect(() => projectMoorPin(manifest)).toThrow(
      'moor release manifest schemaVersion 2 is not the release-manifest v1 this projector reads'
    );
  });

  it('reports the wrong schema version, not the missing keys, when a manifest is both', () => {
    // Substance before shape. A v2 manifest is missing v1 keys BECAUSE it is a
    // v2 manifest; reporting the key set would hide the fact that explains the
    // failure and send the operator hunting for a field that moved on purpose.
    const manifest = { schemaVersion: 2, repository: 'https://github.com/BrainyBlaze/moor' };

    expect(() => projectMoorPin(manifest)).toThrow(
      'moor release manifest schemaVersion 2 is not the release-manifest v1 this projector reads'
    );
    expect(() => projectMoorPin(manifest)).not.toThrow(/missing the projected input/);
  });

  it('refuses a manifest missing a projected input, naming that input', () => {
    for (const missing of ['repository', 'version', 'commit', 'coverage', 'targets']) {
      const manifest = FULL_MATRIX_MANIFEST();
      delete manifest[missing];

      expect(() => projectMoorPin(manifest)).toThrow(
        `moor release manifest is missing the projected input "${missing}"`
      );
    }
  });

  it('refuses a manifest whose targets are not exactly the ratified six', () => {
    const extra = FULL_MATRIX_MANIFEST();
    (extra.targets as Record<string, unknown>)['x86_64-unknown-linux-gnu'] = {
      asset: 'moor-0.1.0-linux-x64-gnu',
      size: 1,
      sha256: digestFor('gnu')
    };

    expect(() => projectMoorPin(extra)).toThrow(
      'moor release manifest targets must be exactly the ratified 6-target matrix'
    );
    expect(() => projectMoorPin(extra)).toThrow('x86_64-unknown-linux-gnu');

    const short = FULL_MATRIX_MANIFEST();
    delete (short.targets as Record<string, unknown>)['aarch64-apple-darwin'];

    expect(() => projectMoorPin(short)).toThrow(
      'moor release manifest targets must be exactly the ratified 6-target matrix'
    );
  });

  it('refuses a target entry missing a projected field, naming target and field', () => {
    const manifest = FULL_MATRIX_MANIFEST();
    delete (manifest.targets as Record<string, Record<string, unknown>>)['x86_64-apple-darwin'].sha256;

    expect(() => projectMoorPin(manifest)).toThrow(
      'moor release manifest target x86_64-apple-darwin is missing the projected field "sha256"'
    );
  });

  it('refuses coverage that is not an object', () => {
    expect(() => projectMoorPin(manifestWith('full-matrix'))).toThrow(
      'moor release manifest coverage must be an object stating which lanes verified this candidate; got "full-matrix"'
    );
  });

  it('refuses a closure label outside the ratified vocabulary', () => {
    expect(() => projectMoorPin(manifestWith({ requiredClosure: 'mostly' }))).toThrow(
      'moor release manifest coverage requiredClosure must be one of [full-matrix, hosted-only, partial]; got "mostly"'
    );
  });

  it('refuses a full-matrix coverage that also carries a list', () => {
    expect(() =>
      projectMoorPin(manifestWith({ requiredClosure: 'full-matrix', unverified: [DEFERRED_LANES[0]] }))
    ).toThrow(
      'moor release manifest full-matrix coverage must carry exactly [requiredClosure]; got [requiredClosure, unverified]'
    );
  });

  it('refuses a narrowed coverage that names no lane', () => {
    expect(() => projectMoorPin(manifestWith({ requiredClosure: 'partial' }))).toThrow(
      'moor release manifest narrowed coverage must carry exactly [requiredClosure, unverified]; got [requiredClosure]'
    );
    expect(() => projectMoorPin(manifestWith({ requiredClosure: 'partial', unverified: [] }))).toThrow(
      'moor release manifest narrowed coverage must list every unverified lane — a narrowed closure that names nothing cannot be checked'
    );
  });

  it('refuses an unverified entry whose key set is not exactly target, gate, lane', () => {
    expect(() =>
      projectMoorPin(
        manifestWith({
          requiredClosure: 'partial',
          unverified: [{ ...DEFERRED_LANES[0], runner: 'self-hosted' }]
        })
      )
    ).toThrow(
      'moor release manifest unverified entry must carry exactly [target, gate, lane]; got [gate, lane, runner, target]'
    );
  });

  it('refuses an unverified lane outside the deferred set', () => {
    expect(() =>
      projectMoorPin(
        manifestWith({
          requiredClosure: 'partial',
          unverified: [{ target: 'aarch64-apple-darwin', gate: 'identity', lane: 'macos-14-arm64' }]
        })
      )
    ).toThrow(
      'moor release manifest unverified lane aarch64-apple-darwin/identity/macos-14-arm64 is not one of the deferred lanes of the frozen matrix'
    );
  });

  it('refuses a repeated unverified lane', () => {
    expect(() =>
      projectMoorPin(
        manifestWith({
          requiredClosure: 'partial',
          unverified: [{ ...DEFERRED_LANES[0] }, { ...DEFERRED_LANES[0] }]
        })
      )
    ).toThrow(
      'moor release manifest lists the unverified lane x86_64-pc-windows-msvc/compatibility/windows-10-1809-x64 more than once'
    );
  });

  it('refuses unverified lanes that do not ascend canonically', () => {
    expect(() =>
      projectMoorPin(
        manifestWith({
          requiredClosure: 'partial',
          unverified: [{ ...DEFERRED_LANES[2] }, { ...DEFERRED_LANES[0] }]
        })
      )
    ).toThrow(
      'moor release manifest unverified lanes must ascend canonically; x86_64-pc-windows-msvc/compatibility/windows-10-1809-x64 follows x86_64-pc-windows-msvc/native-conformance/windows-10-1809-x64'
    );
  });

  it('refuses a closure label that contradicts the list it carries', () => {
    expect(() =>
      projectMoorPin(
        manifestWith({ requiredClosure: 'hosted-only', unverified: [{ ...DEFERRED_LANES[0] }] })
      )
    ).toThrow(
      'moor release manifest closure hosted-only contradicts its own list: 1 of 6 deferred lanes are unverified, which is partial'
    );
    expect(() =>
      projectMoorPin(
        manifestWith({ requiredClosure: 'partial', unverified: DEFERRED_LANES.map((lane) => ({ ...lane })) })
      )
    ).toThrow(
      'moor release manifest closure partial contradicts its own list: 6 of 6 deferred lanes are unverified, which is hosted-only'
    );
  });

  it('refuses at the bytes entry point too — no partially-projected document', () => {
    const manifest = FULL_MATRIX_MANIFEST();
    delete manifest.commit;

    expect(() => projectMoorPinBytes(manifest)).toThrow('missing the projected input "commit"');
  });
});

describe('moor pin projection — CLI wrapper', () => {
  const cli = new URL('../scripts/project-moor-pin.mjs', import.meta.url).pathname;

  function runCli(args: string[]): { status: number | null; stderr: string; stdout: string } {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
  }

  it('writes a pin the consumer reads, and leaves nothing behind when it refuses', () => {
    const work = mkdtempSync(join(tmpdir(), 'desk-pin-cli-'));
    try {
      const manifestPath = join(work, 'moor-release-manifest-v1.json');
      const outPath = join(work, 'out', 'moor-pin.json');
      writeFileSync(manifestPath, `${JSON.stringify(HOSTED_ONLY_MANIFEST(), null, 2)}\n`);

      const written = runCli([manifestPath, '--out', outPath]);
      expect(written.status).toBe(0);
      expect(readFileSync(outPath, 'utf8')).toBe(projectMoorPinBytes(HOSTED_ONLY_MANIFEST()));

      const broken = join(work, 'broken.json');
      const badManifest = HOSTED_ONLY_MANIFEST();
      delete badManifest.commit;
      writeFileSync(broken, JSON.stringify(badManifest));
      const refusedOut = join(work, 'refused', 'moor-pin.json');

      const refused = runCli([broken, '--out', refusedOut]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('missing the projected input "commit"');
      expect(existsSync(refusedOut)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('refuses an unrecognised argument rather than ignoring it', () => {
    const refused = runCli(['manifest.json', '--force']);

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('unknown argument "--force"');
  });
});
