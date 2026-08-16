import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PIN_RELATIVE_PATH, readMoorPin } from '../scripts/fetch-moor.mjs';
import {
  canonicalPinBytes,
  projectMoorPin,
  projectMoorPinBytes
} from '../scripts/project-moor-pin.mjs';

const TARGET_TABLE: Array<[string, string, string]> = [
  ['x86_64-unknown-linux-musl', 'moor-0.1.0-linux-x64', 'moor-candidate-x86_64-unknown-linux-musl'],
  ['aarch64-unknown-linux-musl', 'moor-0.1.0-linux-arm64', 'moor-candidate-aarch64-unknown-linux-musl'],
  ['x86_64-apple-darwin', 'moor-0.1.0-macos-x64', 'moor-candidate-x86_64-apple-darwin'],
  ['aarch64-apple-darwin', 'moor-0.1.0-macos-arm64', 'moor-candidate-aarch64-apple-darwin']
];

const COMMIT = '526cbb2df57a61240d8a6c135b55888716cf32c9';

function digestFor(triple: string): string {
  let hex = '';
  for (let index = 0; hex.length < 64; index += 1) {
    hex += Array.from(`${triple}#${index}`)
      .map((character) => (character.codePointAt(0)! % 16).toString(16))
      .join('');
  }
  return hex.slice(0, 64);
}

function manifestWith(coverage: unknown = { requiredClosure: 'full-matrix' }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repository: 'https://github.com/BrainyBlaze/moor',
    version: 'v0.1.0',
    commit: COMMIT,
    candidate: {
      workflowRunId: '31954915654',
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
              workflowRunId: '31954915654',
              workflowRunAttempt: 1,
              jobId: `100000000${row}`,
              jobName: `build (${triple})`
            },
            verification: [
              {
                gate: 'identity',
                lane: 'hosted',
                workflowRunId: '31954915654',
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

describe('Moor pin projection', () => {
  it('emits a full four-target pin accepted by the real consumer', () => {
    const pin = readThroughRealValidator(projectMoorPinBytes(manifestWith()));

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
    for (const [triple, asset] of TARGET_TABLE) {
      expect((pin.targets as Record<string, unknown>)[triple]).toEqual({
        asset,
        size: expect.any(Number),
        sha256: digestFor(triple)
      });
    }
  });

  it('also satisfies the release-asset validator', async () => {
    const { validateMoorPin } = await import('../scripts/create-release-assets.mjs');
    expect(() => validateMoorPin(projectMoorPin(manifestWith()))).not.toThrow();
  });

  it('sets consumer schema 3 instead of copying manifest schema 1', () => {
    const manifest = manifestWith();
    const pin = projectMoorPin(manifest);

    expect(manifest.schemaVersion).toBe(1);
    expect(pin.schemaVersion).toBe(3);
  });

  it('projects through a whitelist', () => {
    const manifest = {
      ...manifestWith(),
      attestationBundle: { predicate: 'do-not-project' }
    };
    const target = (manifest.targets as Record<string, Record<string, unknown>>)[
      'x86_64-apple-darwin'
    ];
    target.signature = 'do-not-project-either';

    const bytes = projectMoorPinBytes(manifest);
    expect(bytes).not.toContain('attestationBundle');
    expect(bytes).not.toContain('do-not-project');
    expect(bytes).not.toContain('signature');
    expect(bytes).not.toContain('candidate');
    expect(bytes).not.toContain('provenance');
    expect(() => readThroughRealValidator(bytes)).not.toThrow();
  });

  it('returns data that does not alias the manifest', () => {
    const manifest = manifestWith();
    const pin = projectMoorPin(manifest);
    const pinTarget = (pin.targets as Record<string, Record<string, unknown>>)[
      'x86_64-apple-darwin'
    ];
    pinTarget.asset = 'mutated';

    const manifestTarget = (manifest.targets as Record<string, Record<string, unknown>>)[
      'x86_64-apple-darwin'
    ];
    expect(manifestTarget.asset).toBe('moor-0.1.0-macos-x64');
  });
});

describe('Moor pin canonical bytes', () => {
  it('emits byte-identical output for repeated projections', () => {
    expect(projectMoorPinBytes(manifestWith())).toBe(projectMoorPinBytes(manifestWith()));
  });

  it('uses two-space JSON, one LF, no BOM, and stable top-level order', () => {
    const bytes = projectMoorPinBytes(manifestWith());

    expect(bytes.startsWith('{\n  "schemaVersion": 3,\n')).toBe(true);
    expect(bytes.endsWith('}\n')).toBe(true);
    expect(bytes.endsWith('}\n\n')).toBe(false);
    expect(bytes.charCodeAt(0)).toBe(0x7b);
    expect(bytes.includes('\r')).toBe(false);
    expect(/[ \t]+\n/.test(bytes)).toBe(false);
    expect(bytes.indexOf('"repository"')).toBeLessThan(bytes.indexOf('"version"'));
    expect(bytes.indexOf('"version"')).toBeLessThan(bytes.indexOf('"commit"'));
    expect(bytes.indexOf('"commit"')).toBeLessThan(bytes.indexOf('"coverage"'));
    expect(bytes.indexOf('"coverage"')).toBeLessThan(bytes.indexOf('"targets"'));
  });

  it('emits targets in canonical table order', () => {
    const bytes = projectMoorPinBytes(manifestWith());
    const positions = TARGET_TABLE.map(([triple]) => bytes.indexOf(`"${triple}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('canonicalizes an already projected object identically', () => {
    const manifest = manifestWith();
    expect(canonicalPinBytes(projectMoorPin(manifest))).toBe(projectMoorPinBytes(manifest));
  });
});

describe('Moor pin projection refusals', () => {
  it('refuses a non-object manifest', () => {
    expect(() => projectMoorPin(null)).toThrow(/must be a JSON object/);
  });

  it('diagnoses the wrong schema before missing inputs', () => {
    const manifest = { schemaVersion: 2, repository: 'https://github.com/BrainyBlaze/moor' };
    expect(() => projectMoorPin(manifest)).toThrow(/schemaVersion 2/);
    expect(() => projectMoorPin(manifest)).not.toThrow(/missing the projected input/);
  });

  it('names every missing projected input', () => {
    for (const missing of ['repository', 'version', 'commit', 'coverage', 'targets']) {
      const manifest = manifestWith();
      delete manifest[missing];
      expect(() => projectMoorPin(manifest)).toThrow(`missing the projected input "${missing}"`);
    }
  });

  it('requires exactly the four-target matrix', () => {
    const extra = manifestWith();
    (extra.targets as Record<string, unknown>)['x86_64-unknown-linux-gnu'] = {
      asset: 'moor-0.1.0-linux-x64-gnu',
      size: 1,
      sha256: digestFor('gnu')
    };
    expect(() => projectMoorPin(extra)).toThrow(/exactly the ratified four-target matrix/);

    const short = manifestWith();
    delete (short.targets as Record<string, unknown>)['aarch64-apple-darwin'];
    expect(() => projectMoorPin(short)).toThrow(/exactly the ratified four-target matrix/);
  });

  it('names a missing target field', () => {
    const manifest = manifestWith();
    delete (manifest.targets as Record<string, Record<string, unknown>>)[
      'x86_64-apple-darwin'
    ].sha256;
    expect(() => projectMoorPin(manifest)).toThrow(
      'target x86_64-apple-darwin is missing the projected field "sha256"'
    );
  });

  it('requires coverage to be an object', () => {
    expect(() => projectMoorPin(manifestWith('full-matrix'))).toThrow(/coverage must be an object/);
  });

  it('requires full-matrix as the sole coverage field', () => {
    expect(() => projectMoorPin(manifestWith({ requiredClosure: 'partial' }))).toThrow(
      /requiredClosure must be full-matrix/
    );
    expect(() =>
      projectMoorPin(manifestWith({ requiredClosure: 'full-matrix', unverified: [] }))
    ).toThrow(/coverage must carry exactly \[requiredClosure\]/);
  });

  it('refuses at the bytes entry point without emitting a partial document', () => {
    const manifest = manifestWith();
    delete manifest.commit;
    expect(() => projectMoorPinBytes(manifest)).toThrow('missing the projected input "commit"');
  });
});

describe('Moor pin projector CLI', () => {
  const cli = new URL('../scripts/project-moor-pin.mjs', import.meta.url).pathname;

  function runCli(args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
  }

  it('writes a consumer-valid pin atomically and leaves no output on refusal', () => {
    const work = mkdtempSync(join(tmpdir(), 'desk-pin-cli-'));
    try {
      const manifestPath = join(work, 'moor-release-manifest-v1.json');
      const outPath = join(work, 'out', 'moor-pin.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifestWith(), null, 2)}\n`);

      const written = runCli([manifestPath, '--out', outPath]);
      expect(written.status).toBe(0);
      expect(readFileSync(outPath, 'utf8')).toBe(projectMoorPinBytes(manifestWith()));
      expect(() => readThroughRealValidator(readFileSync(outPath, 'utf8'))).not.toThrow();

      const brokenPath = join(work, 'broken.json');
      const broken = manifestWith();
      delete broken.commit;
      writeFileSync(brokenPath, JSON.stringify(broken));
      const refusedOut = join(work, 'refused', 'moor-pin.json');

      const refused = runCli([brokenPath, '--out', refusedOut]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('missing the projected input "commit"');
      expect(existsSync(refusedOut)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('refuses an unrecognized argument', () => {
    const refused = runCli(['manifest.json', '--force']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('unknown argument "--force"');
  });
});
