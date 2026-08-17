import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateAssetMetadata,
  observeReleaseAssets,
  planReleaseTransaction,
  releaseEvidenceBody,
  validateCandidateBinding,
  validateImmutableReleaseSettings,
  validatePublication,
  validateReleaseTag,
  validateStarterDeletion
} from '../scripts/release/promotion.js';

const ROOT = new URL('../', import.meta.url);
const SHA = 'a'.repeat(40);
const RUN_ID = 123456;
const ARTIFACT_ID = 654321;
const VERSION = 'v0.4.0';
const ARTIFACT_NAME = `desk-release-candidate-${VERSION}-${SHA}`;
const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function bindingFixture() {
  const artifact = {
    id: ARTIFACT_ID,
    name: ARTIFACT_NAME,
    expired: false,
    workflow_run: { id: RUN_ID, head_sha: SHA }
  };
  return {
    run: {
      id: RUN_ID,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: SHA,
      path: '.github/workflows/release.yml'
    },
    artifact,
    runArtifacts: { total_count: 1, artifacts: [artifact] }
  };
}

function candidateFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-release-promotion-'));
  roots.push(root);
  const sourceName = 'desk-v0.4.0-source.tar.gz';
  const source = Buffer.from('source archive bytes\n');
  const installer = Buffer.from('#!/usr/bin/env bash\necho installer\n');
  const manifest = {
    schemaVersion: 2,
    version: VERSION,
    source: { asset: sourceName, sha256: sha256(source) },
    node: { version: '22.23.1', npmVersion: '10.9.8', targets: {} },
    bun: { version: '1.3.14', tag: 'bun-v1.3.14', targets: {} },
    moor: {
      schemaVersion: 3,
      repository: 'https://github.com/BrainyBlaze/moor',
      version: 'v0.1.0',
      commit: 'b'.repeat(40),
      coverage: { requiredClosure: 'full-matrix' },
      targets: {
        'x86_64-unknown-linux-musl': {
          asset: 'moor-0.1.0-linux-x64',
          size: 1,
          sha256: '1'.repeat(64)
        },
        'aarch64-unknown-linux-musl': {
          asset: 'moor-0.1.0-linux-arm64',
          size: 2,
          sha256: '2'.repeat(64)
        },
        'x86_64-apple-darwin': {
          asset: 'moor-0.1.0-macos-x64',
          size: 3,
          sha256: '3'.repeat(64)
        },
        'aarch64-apple-darwin': {
          asset: 'moor-0.1.0-macos-arm64',
          size: 4,
          sha256: '4'.repeat(64)
        }
      }
    }
  };
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, sourceName), source);
  writeFileSync(join(root, 'desk-install-manifest.json'), manifestSource);
  writeFileSync(join(root, 'install.sh'), installer);
  writeFileSync(
    join(root, 'SHA256SUMS'),
    `${sha256(manifestSource)}  desk-install-manifest.json\n${sha256(source)}  ${sourceName}\n${sha256(installer)}  install.sh\n`
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('immutable Desk release candidate binding', () => {
  it('accepts one successful attempt-1 run and the exact artifact from that run', () => {
    const fixture = bindingFixture();

    expect(
      validateCandidateBinding({
        ...fixture,
        expected: {
          runId: RUN_ID,
          runAttempt: 1,
          artifactId: ARTIFACT_ID,
          artifactName: ARTIFACT_NAME,
          candidateSha: SHA
        }
      })
    ).toEqual({ runId: RUN_ID, artifactId: ARTIFACT_ID, candidateSha: SHA });
  });

  it.each([
    ['run id', (value: ReturnType<typeof bindingFixture>) => (value.run.id = RUN_ID + 1)],
    ['attempt', (value: ReturnType<typeof bindingFixture>) => (value.run.run_attempt = 2)],
    ['conclusion', (value: ReturnType<typeof bindingFixture>) => (value.run.conclusion = 'failure')],
    ['event', (value: ReturnType<typeof bindingFixture>) => (value.run.event = 'push')],
    ['branch', (value: ReturnType<typeof bindingFixture>) => (value.run.head_branch = 'release')],
    ['head', (value: ReturnType<typeof bindingFixture>) => (value.run.head_sha = 'c'.repeat(40))],
    ['workflow', (value: ReturnType<typeof bindingFixture>) => (value.run.path = '.github/workflows/ci.yml')],
    ['artifact id', (value: ReturnType<typeof bindingFixture>) => (value.artifact.id = ARTIFACT_ID + 1)],
    ['artifact name', (value: ReturnType<typeof bindingFixture>) => (value.artifact.name = 'other')],
    ['expired artifact', (value: ReturnType<typeof bindingFixture>) => (value.artifact.expired = true)],
    [
      'artifact run',
      (value: ReturnType<typeof bindingFixture>) => (value.artifact.workflow_run.id = RUN_ID + 1)
    ],
    [
      'run inventory',
      (value: ReturnType<typeof bindingFixture>) => (value.runArtifacts.artifacts = [])
    ],
    [
      'paginated run inventory',
      (value: ReturnType<typeof bindingFixture>) => (value.runArtifacts.total_count = 2)
    ]
  ])('rejects a mismatched %s', (_name, mutate) => {
    const fixture = bindingFixture();
    mutate(fixture);

    expect(() =>
      validateCandidateBinding({
        ...fixture,
        expected: {
          runId: RUN_ID,
          runAttempt: 1,
          artifactId: ARTIFACT_ID,
          artifactName: ARTIFACT_NAME,
          candidateSha: SHA
        }
      })
    ).toThrow();
  });

  it('rejects a rerun even when the supplied binding consistently names attempt 2', () => {
    const fixture = bindingFixture();
    fixture.run.run_attempt = 2;

    expect(() =>
      validateCandidateBinding({
        ...fixture,
        expected: {
          runId: RUN_ID,
          runAttempt: 2,
          artifactId: ARTIFACT_ID,
          artifactName: ARTIFACT_NAME,
          candidateSha: SHA
        }
      })
    ).toThrow(/attempt.*1/i);
  });
});

describe('candidate asset verification', () => {
  it('binds the exact four-file inventory and every byte digest', () => {
    const root = candidateFixture();

    const metadata = candidateAssetMetadata(root, VERSION, SHA);

    expect(metadata.version).toBe(VERSION);
    expect(metadata.candidateSha).toBe(SHA);
    expect(metadata.assets.map((asset) => asset.name)).toEqual([
      'SHA256SUMS',
      'desk-install-manifest.json',
      'desk-v0.4.0-source.tar.gz',
      'install.sh'
    ]);
    for (const asset of metadata.assets) {
      const bytes = readFileSync(join(root, asset.name));
      expect(asset).toMatchObject({ size: bytes.length, sha256: sha256(bytes) });
    }
  });

  it('rejects extra files, checksum tampering, and the wrong manifest version', () => {
    const extra = candidateFixture();
    writeFileSync(join(extra, 'unexpected'), 'no\n');
    expect(() => candidateAssetMetadata(extra, VERSION, SHA)).toThrow(/inventory|unexpected/i);

    const checksum = candidateFixture();
    writeFileSync(join(checksum, 'SHA256SUMS'), `${'0'.repeat(64)}  desk-install-manifest.json\n`);
    expect(() => candidateAssetMetadata(checksum, VERSION, SHA)).toThrow(/checksum|SHA256SUMS/i);

    const installer = candidateFixture();
    writeFileSync(join(installer, 'install.sh'), '#!/bin/sh\necho tampered\n');
    expect(() => candidateAssetMetadata(installer, VERSION, SHA)).toThrow(/checksum|install/i);

    const version = candidateFixture();
    const path = join(version, 'desk-install-manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.version = 'v0.3.2';
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => candidateAssetMetadata(version, VERSION, SHA)).toThrow(/version|checksum/i);
  });
});

describe('release transaction planning', () => {
  const body = releaseEvidenceBody({
    version: VERSION,
    candidateSha: SHA,
    runId: RUN_ID,
    runAttempt: 1,
    artifactId: ARTIFACT_ID
  });
  const expected = {
    version: VERSION,
    candidateSha: SHA,
    releaseBody: body,
    assets: [
      { name: 'SHA256SUMS', size: 10, sha256: '1'.repeat(64) },
      { name: 'desk-install-manifest.json', size: 20, sha256: '2'.repeat(64) },
      { name: 'desk-v0.4.0-source.tar.gz', size: 30, sha256: '3'.repeat(64) },
      { name: 'install.sh', size: 40, sha256: '4'.repeat(64) }
    ]
  };

  it('derives fresh evidence from numeric asset downloads without trusting release filenames as paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-release-observed-'));
    roots.push(root);
    writeFileSync(join(root, '7'), 'published bytes\n');

    expect(
      observeReleaseAssets(
        [{ id: 7, name: 'desk-install-manifest.json', state: 'uploaded', size: 16 }],
        root
      )
    ).toEqual({
      '7': {
        name: 'desk-install-manifest.json',
        size: 16,
        sha256: sha256('published bytes\n')
      }
    });
    expect(() =>
      observeReleaseAssets(
        [{ id: 7, name: '../escape', state: 'uploaded', size: 16 }],
        root
      )
    ).toThrow(/name|asset/i);
    expect(() =>
      observeReleaseAssets(
        [{ id: 7, name: 'desk-install-manifest.json', state: 'uploaded', size: 17 }],
        root
      )
    ).toThrow(/size/i);
  });
  const release = {
    id: 42,
    tag_name: VERSION,
    target_commitish: SHA,
    name: `Desk ${VERSION}`,
    body,
    draft: true,
    prerelease: false
  };
  const tag = {
    ref: `refs/tags/${VERSION}`,
    object: { type: 'commit', sha: SHA }
  };

  it('creates the exact draft, uploads only missing assets, publishes, and then becomes idempotent', () => {
    expect(
      planReleaseTransaction({ expected, release: null, assets: [], observed: {}, starterDeleteCounts: {} })
    ).toEqual({ type: 'create-release' });

    expect(
      planReleaseTransaction({ expected, release, assets: [], observed: {}, starterDeleteCounts: {} })
    ).toEqual({ type: 'upload', name: 'SHA256SUMS' });

    const assets = expected.assets.map((asset, index) => ({
      id: index + 1,
      name: asset.name,
      state: 'uploaded',
      size: asset.size
    }));
    const observed = Object.fromEntries(
      assets.map((asset, index) => [String(asset.id), expected.assets[index]])
    );
    expect(
      planReleaseTransaction({ expected, release, assets, observed, starterDeleteCounts: {} })
    ).toEqual({ type: 'publish' });
    expect(
      planReleaseTransaction({
        expected,
        release: { ...release, draft: false, immutable: true },
        assets,
        observed,
        starterDeleteCounts: {}
      })
    ).toEqual({ type: 'complete' });
    expect(() =>
      planReleaseTransaction({
        expected,
        release: { ...release, draft: false, immutable: false },
        assets,
        observed,
        starterDeleteCounts: {}
      })
    ).toThrow(/immutable/i);
  });

  it('fails closed on conflicts and permits only bounded starter cleanup on the exact draft', () => {
    expect(() =>
      planReleaseTransaction({
        expected: {
          ...expected,
          assets: expected.assets.map((asset) =>
            asset.name === 'install.sh' ? { ...asset, name: '../install.sh' } : asset
          )
        },
        release: null,
        assets: [],
        observed: {},
        starterDeleteCounts: {}
      })
    ).toThrow(/asset|inventory|name/i);

    const starter = { id: 7, name: 'SHA256SUMS', state: 'starter', size: 10 };
    const deletePlan =
      planReleaseTransaction({
        expected,
        release,
        assets: [starter],
        observed: {},
        starterDeleteCounts: {}
      });
    expect(deletePlan).toEqual({ type: 'delete-starter', id: 7, name: 'SHA256SUMS' });
    expect(
      validateStarterDeletion({
        expected,
        release,
        assets: [starter],
        asset: starter,
        plan: deletePlan,
        starterDeleteCounts: {}
      })
    ).toEqual(deletePlan);
    expect(() =>
      validateStarterDeletion({
        expected,
        release,
        assets: [starter],
        asset: { ...starter, state: 'uploaded' },
        plan: deletePlan,
        starterDeleteCounts: {}
      })
    ).toThrow(/starter|evidence|download/i);
    expect(() =>
      validateStarterDeletion({
        expected,
        release,
        assets: [starter],
        asset: { ...starter, id: 8 },
        plan: deletePlan,
        starterDeleteCounts: {}
      })
    ).toThrow(/plan|id|starter/i);
    expect(() =>
      validateStarterDeletion({
        expected,
        release,
        assets: [starter, { ...starter, id: 8, name: 'unexpected' }],
        asset: starter,
        plan: deletePlan,
        starterDeleteCounts: {}
      })
    ).toThrow(/unexpected/i);

    expect(() =>
      planReleaseTransaction({
        expected,
        release: { ...release, draft: false, immutable: true },
        assets: [starter],
        observed: {},
        starterDeleteCounts: {}
      })
    ).toThrow(/draft|starter/i);
    expect(() =>
      planReleaseTransaction({
        expected,
        release,
        assets: [starter],
        observed: {},
        starterDeleteCounts: { SHA256SUMS: 2 }
      })
    ).toThrow(/starter|limit/i);
    expect(() =>
      planReleaseTransaction({
        expected,
        release,
        assets: [{ ...starter, name: 'unexpected' }],
        observed: {},
        starterDeleteCounts: {}
      })
    ).toThrow(/unexpected/i);
    expect(() =>
      planReleaseTransaction({
        expected,
        release,
        assets: [{ ...starter, state: 'uploaded' }],
        observed: { '7': { name: 'SHA256SUMS', size: 10, sha256: 'f'.repeat(64) } },
        starterDeleteCounts: {}
      })
    ).toThrow(/digest|sha|conflict/i);
  });

  it('re-resolves the direct tag and all asset bytes immediately before publication', () => {
    const assets = expected.assets.map((asset, index) => ({
      id: index + 1,
      name: asset.name,
      state: 'uploaded',
      size: asset.size
    }));
    const observed = Object.fromEntries(
      assets.map((asset, index) => [String(asset.id), expected.assets[index]])
    );
    const plan = { type: 'publish' } as const;

    expect(validateImmutableReleaseSettings({ enabled: true })).toEqual({ enabled: true });
    expect(() => validateImmutableReleaseSettings({ enabled: false })).toThrow(/immutable|enabled/i);
    expect(validateReleaseTag(tag, VERSION, SHA)).toEqual({ version: VERSION, candidateSha: SHA });
    expect(
      validatePublication({ expected, tag, release, assets, observed, plan })
    ).toEqual(plan);
    expect(() =>
      validatePublication({
        expected,
        tag: { ...tag, object: { type: 'tag', sha: SHA } },
        release,
        assets,
        observed,
        plan
      })
    ).toThrow(/tag|commit/i);
    expect(() =>
      validatePublication({
        expected,
        tag,
        release: { ...release, draft: false },
        assets,
        observed,
        plan
      })
    ).toThrow(/publish|plan|draft/i);
    expect(() =>
      validatePublication({ expected, tag, release, assets, observed, plan: { type: 'upload' } })
    ).toThrow(/plan|publish/i);
  });
});

describe('release workflow contract', () => {
  it('promotes the exact candidate artifact and has no tag-triggered rebuild path', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', ROOT), 'utf8');
    const promote = workflow.slice(workflow.indexOf('  promote:'));

    expect(workflow).not.toMatch(/push:\s*\n\s*tags:/);
    expect(workflow).toContain(
      "github.event_name == 'pull_request' || (inputs.operation == 'candidate' && github.run_attempt == 1)"
    );
    expect(workflow.match(/gh api --paginate --slurp/g) ?? []).toHaveLength(3);
    expect(workflow).toContain('operation:');
    expect(workflow).toContain('candidate_run_id:');
    expect(workflow).toContain('candidate_run_attempt:');
    expect(workflow).toContain('candidate_artifact_id:');
    expect(workflow).toContain('candidate_sha:');
    expect(workflow).toContain('github.ref_protected');
    expect(workflow).toContain('npm run build:application');
    expect(workflow).toContain('bun-version: 1.3.14');
    expect(workflow).not.toContain('sudo apt-get');
    expect(workflow).toContain('bash "$RUNNER_TEMP/release-assets/install.sh"');
    expect(workflow).toContain('${{ runner.temp }}/release-assets/install.sh');
    expect(promote).toContain('actions: read');
    expect(promote).toContain('contents: write');
    expect(promote).toContain('environment: release');
    expect(promote).toContain('actions/artifacts/$CANDIDATE_ARTIFACT_ID/zip');
    expect(promote).not.toContain('actions/download-artifact');
    expect(promote).toContain('validate-binding');
    expect(promote).toContain('verify-candidate');
    expect(promote).toContain('observe-assets');
    expect(promote).toContain('plan-release');
    expect(promote).toContain('verify-starter-deletion');
    expect(promote).toContain('verify-publication');
    expect(promote).toContain('verify-immutable-settings');
    expect(promote).toContain('verify-live-release');
    expect(promote).toContain('immutable-releases');
    expect(promote).not.toContain('npm run release:assets');
    expect(promote).not.toMatch(/npm run build/);
    expect(promote).not.toContain('actions/upload-artifact');
  });
});
