import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const DESK_MANIFEST_SCHEMA = 2;
const MOOR_PIN_SCHEMA = 3;
const MOOR_VERSION = 'v0.1.0';
const MOOR_REPOSITORY = 'https://github.com/BrainyBlaze/moor';
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const VERSION = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const MOOR_TARGETS = {
  'aarch64-apple-darwin': 'moor-0.1.0-macos-arm64',
  'aarch64-unknown-linux-musl': 'moor-0.1.0-linux-arm64',
  'x86_64-apple-darwin': 'moor-0.1.0-macos-x64',
  'x86_64-unknown-linux-musl': 'moor-0.1.0-linux-x64'
};

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function exactKeys(value, keys, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} has unexpected keys`);
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path, label = basename(path)) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validateMoorPin(pin) {
  exactKeys(
    pin,
    ['schemaVersion', 'repository', 'version', 'commit', 'coverage', 'targets'],
    'manifest.moor'
  );
  invariant(pin.schemaVersion === MOOR_PIN_SCHEMA, `manifest.moor schemaVersion must be ${MOOR_PIN_SCHEMA}`);
  invariant(pin.repository === MOOR_REPOSITORY, 'manifest.moor repository is not canonical');
  invariant(pin.version === MOOR_VERSION, `manifest.moor version must be ${MOOR_VERSION}`);
  invariant(typeof pin.commit === 'string' && SHA40.test(pin.commit), 'manifest.moor commit is invalid');
  exactKeys(pin.coverage, ['requiredClosure'], 'manifest.moor.coverage');
  invariant(
    pin.coverage.requiredClosure === 'full-matrix',
    'manifest.moor coverage must require the full matrix'
  );
  exactKeys(pin.targets, Object.keys(MOOR_TARGETS), 'manifest.moor.targets');
  for (const [target, expectedAsset] of Object.entries(MOOR_TARGETS)) {
    const entry = pin.targets[target];
    exactKeys(entry, ['asset', 'size', 'sha256'], `manifest.moor.targets.${target}`);
    invariant(entry.asset === expectedAsset, `manifest.moor target ${target} has the wrong asset`);
    positiveInteger(entry.size, `manifest.moor target ${target} size`);
    invariant(typeof entry.sha256 === 'string' && SHA64.test(entry.sha256), `manifest.moor target ${target} sha256 is invalid`);
  }
}

function parseChecksums(source) {
  invariant(!source.includes('\r'), 'SHA256SUMS must use LF line endings');
  const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n');
  invariant(lines.length === 3, 'SHA256SUMS must contain exactly three entries');
  const values = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    invariant(match, 'SHA256SUMS contains a malformed entry');
    invariant(!values.has(match[2]), 'SHA256SUMS contains a duplicate name');
    values.set(match[2], match[1]);
  }
  return values;
}

export function validateCandidateBinding({ run, artifact, runArtifacts, expected }) {
  positiveInteger(expected.runId, 'expected run id');
  positiveInteger(expected.runAttempt, 'expected run attempt');
  invariant(expected.runAttempt === 1, 'formal candidate run attempt must be 1');
  positiveInteger(expected.artifactId, 'expected artifact id');
  invariant(typeof expected.artifactName === 'string' && expected.artifactName.length > 0, 'expected artifact name is missing');
  invariant(typeof expected.candidateSha === 'string' && SHA40.test(expected.candidateSha), 'expected candidate SHA is invalid');

  invariant(run?.id === expected.runId, 'candidate run id does not match');
  invariant(run.run_attempt === expected.runAttempt, 'candidate run attempt does not match');
  invariant(run.status === 'completed' && run.conclusion === 'success', 'candidate run did not complete successfully');
  invariant(run.event === 'workflow_dispatch', 'candidate run was not manually dispatched');
  invariant(run.head_branch === 'main', 'candidate run was not on main');
  invariant(run.head_sha === expected.candidateSha, 'candidate run head SHA does not match');
  invariant(run.path === RELEASE_WORKFLOW, 'candidate run used the wrong workflow');

  invariant(artifact?.id === expected.artifactId, 'candidate artifact id does not match');
  invariant(artifact.name === expected.artifactName, 'candidate artifact name does not match');
  invariant(artifact.expired === false, 'candidate artifact is expired');
  invariant(artifact.workflow_run?.id === expected.runId, 'candidate artifact belongs to another run');
  invariant(
    artifact.workflow_run?.head_sha === expected.candidateSha,
    'candidate artifact belongs to another head SHA'
  );

  const inventory = Array.isArray(runArtifacts?.artifacts) ? runArtifacts.artifacts : [];
  invariant(
    Number.isSafeInteger(runArtifacts?.total_count) && runArtifacts.total_count === inventory.length,
    'candidate run artifact inventory is incomplete or paginated'
  );
  const matches = inventory.filter((entry) => entry?.id === expected.artifactId);
  invariant(matches.length === 1, 'candidate artifact is not uniquely present in the run inventory');
  invariant(matches[0].name === expected.artifactName, 'run inventory artifact name does not match');
  invariant(matches[0].expired === false, 'run inventory artifact is expired');

  return {
    runId: expected.runId,
    artifactId: expected.artifactId,
    candidateSha: expected.candidateSha
  };
}

export function candidateAssetMetadata(root, expectedVersion, candidateSha) {
  invariant(typeof expectedVersion === 'string' && VERSION.test(expectedVersion), 'release version is invalid');
  invariant(typeof candidateSha === 'string' && SHA40.test(candidateSha), 'candidate SHA is invalid');
  const sourceName = `desk-${expectedVersion}-source.tar.gz`;
  const expectedNames = ['SHA256SUMS', 'desk-install-manifest.json', sourceName, 'install.sh'].sort();
  const entries = readdirSync(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  invariant(JSON.stringify(names) === JSON.stringify(expectedNames), 'candidate artifact inventory is unexpected');
  invariant(entries.every((entry) => entry.isFile()), 'candidate artifact inventory must contain regular files only');

  const sourcePath = join(root, sourceName);
  const manifestPath = join(root, 'desk-install-manifest.json');
  const installerPath = join(root, 'install.sh');
  const sumsPath = join(root, 'SHA256SUMS');
  const source = readFileSync(sourcePath);
  const manifestBytes = readFileSync(manifestPath);
  const installerBytes = readFileSync(installerPath);
  const sumsBytes = readFileSync(sumsPath);
  const checksums = parseChecksums(sumsBytes.toString('utf8'));
  exactKeys(
    Object.fromEntries(checksums),
    ['desk-install-manifest.json', sourceName, 'install.sh'],
    'SHA256SUMS'
  );
  invariant(checksums.get(sourceName) === sha256(source), 'source checksum does not match SHA256SUMS');
  invariant(
    checksums.get('desk-install-manifest.json') === sha256(manifestBytes),
    'manifest checksum does not match SHA256SUMS'
  );
  invariant(
    checksums.get('install.sh') === sha256(installerBytes),
    'installer checksum does not match SHA256SUMS'
  );

  const manifest = readJson(manifestPath, 'desk-install-manifest.json');
  exactKeys(manifest, ['schemaVersion', 'version', 'source', 'node', 'bun', 'moor'], 'install manifest');
  invariant(manifest.schemaVersion === DESK_MANIFEST_SCHEMA, `install manifest schemaVersion must be ${DESK_MANIFEST_SCHEMA}`);
  invariant(manifest.version === expectedVersion, 'install manifest version does not match');
  exactKeys(manifest.source, ['asset', 'sha256'], 'install manifest source');
  invariant(manifest.source.asset === sourceName, 'install manifest source asset does not match');
  invariant(manifest.source.sha256 === sha256(source), 'install manifest source digest does not match');
  validateMoorPin(manifest.moor);

  return {
    version: expectedVersion,
    candidateSha,
    assets: expectedNames.map((name) => {
      const path = join(root, name);
      const bytes = readFileSync(path);
      return { name, size: statSync(path).size, sha256: sha256(bytes) };
    })
  };
}

export function releaseEvidenceBody({ version, candidateSha, runId, runAttempt, artifactId }) {
  invariant(typeof version === 'string' && VERSION.test(version), 'release version is invalid');
  invariant(typeof candidateSha === 'string' && SHA40.test(candidateSha), 'candidate SHA is invalid');
  positiveInteger(runId, 'candidate run id');
  positiveInteger(runAttempt, 'candidate run attempt');
  positiveInteger(artifactId, 'candidate artifact id');
  return [
    'Immutable Desk release promotion.',
    '',
    `candidate_sha=${candidateSha}`,
    `candidate_run_id=${runId}`,
    `candidate_run_attempt=${runAttempt}`,
    `candidate_artifact_id=${artifactId}`
  ].join('\n');
}

export function observeReleaseAssets(assets, root) {
  invariant(Array.isArray(assets), 'release assets must be an array');
  const observed = {};
  const expectedFiles = [];
  const seenIds = new Set();

  for (const asset of assets) {
    invariant(asset && typeof asset === 'object' && !Array.isArray(asset), 'release asset is invalid');
    const id = positiveInteger(asset.id, 'release asset id');
    invariant(!seenIds.has(id), `duplicate release asset id: ${id}`);
    seenIds.add(id);
    invariant(
      typeof asset.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name),
      `release asset ${id} name is invalid`
    );
    invariant(asset.state === 'starter' || asset.state === 'uploaded', `release asset ${id} state is invalid`);
    if (asset.state === 'starter') {
      continue;
    }

    const expectedSize = positiveInteger(asset.size, `release asset ${asset.name} size`);
    const file = String(id);
    expectedFiles.push(file);
    const bytes = readFileSync(join(root, file));
    invariant(bytes.length === expectedSize, `release asset ${asset.name} downloaded size conflicts`);
    observed[file] = { name: asset.name, size: bytes.length, sha256: sha256(bytes) };
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const actualFiles = entries.map((entry) => entry.name).sort();
  expectedFiles.sort();
  invariant(
    entries.every((entry) => entry.isFile()) &&
      JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    'observed asset download inventory is unexpected'
  );
  return observed;
}

export function validateReleaseTag(tag, version, candidateSha) {
  invariant(typeof version === 'string' && VERSION.test(version), 'release version is invalid');
  invariant(typeof candidateSha === 'string' && SHA40.test(candidateSha), 'candidate SHA is invalid');
  invariant(tag && typeof tag === 'object' && !Array.isArray(tag), 'release tag is invalid');
  invariant(tag.ref === `refs/tags/${version}`, 'release tag ref does not match');
  invariant(tag.object?.type === 'commit', 'release tag must point directly to a commit');
  invariant(tag.object.sha === candidateSha, 'release tag does not point to the candidate SHA');
  return { version, candidateSha };
}

export function validateImmutableReleaseSettings(settings) {
  invariant(
    settings && typeof settings === 'object' && !Array.isArray(settings),
    'immutable release settings are invalid'
  );
  invariant(settings.enabled === true, 'immutable releases must be enabled');
  return { enabled: true };
}

function validateExpected(expected) {
  invariant(typeof expected?.version === 'string' && VERSION.test(expected.version), 'expected release version is invalid');
  invariant(typeof expected.candidateSha === 'string' && SHA40.test(expected.candidateSha), 'expected candidate SHA is invalid');
  invariant(typeof expected.releaseBody === 'string' && expected.releaseBody.length > 0, 'expected release body is missing');
  invariant(Array.isArray(expected.assets) && expected.assets.length === 4, 'expected release must contain four assets');
  const names = new Set();
  for (const asset of expected.assets) {
    invariant(
      typeof asset.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name),
      'expected asset name is invalid'
    );
    invariant(!names.has(asset.name), 'expected asset names are duplicated');
    names.add(asset.name);
    positiveInteger(asset.size, `expected asset ${asset.name} size`);
    invariant(typeof asset.sha256 === 'string' && SHA64.test(asset.sha256), `expected asset ${asset.name} sha256 is invalid`);
  }
  const expectedNames = [
    'SHA256SUMS',
    'desk-install-manifest.json',
    `desk-${expected.version}-source.tar.gz`,
    'install.sh'
  ].sort();
  invariant(
    JSON.stringify([...names].sort()) === JSON.stringify(expectedNames),
    'expected release asset inventory is invalid'
  );
  return new Map(expected.assets.map((asset) => [asset.name, asset]));
}

export function planReleaseTransaction({ expected, release, assets, observed, starterDeleteCounts }) {
  const expectedByName = validateExpected(expected);
  invariant(Array.isArray(assets), 'release assets must be an array');
  invariant(observed && typeof observed === 'object' && !Array.isArray(observed), 'observed assets must be an object');
  invariant(
    starterDeleteCounts && typeof starterDeleteCounts === 'object' && !Array.isArray(starterDeleteCounts),
    'starter delete counts must be an object'
  );

  if (release === null) {
    invariant(assets.length === 0, 'assets exist without a release');
    return { type: 'create-release' };
  }
  invariant(release && typeof release === 'object' && !Array.isArray(release), 'release must be an object');
  positiveInteger(release.id, 'release id');
  invariant(release.tag_name === expected.version, 'release tag does not match');
  invariant(release.target_commitish === expected.candidateSha, 'release target does not match candidate SHA');
  invariant(release.name === `Desk ${expected.version}`, 'release name does not match');
  invariant(release.body === expected.releaseBody, 'release evidence body does not match');
  invariant(release.prerelease === false, 'release must not be a prerelease');
  invariant(typeof release.draft === 'boolean', 'release draft state is invalid');
  if (!release.draft) {
    invariant(release.immutable === true, 'published release must be immutable');
  }

  const currentByName = new Map();
  for (const asset of assets) {
    invariant(asset && typeof asset === 'object' && !Array.isArray(asset), 'release asset is invalid');
    invariant(expectedByName.has(asset.name), `unexpected release asset: ${asset.name}`);
    invariant(!currentByName.has(asset.name), `duplicate release asset: ${asset.name}`);
    currentByName.set(asset.name, asset);
  }

  for (const [name, asset] of currentByName) {
    const expectedAsset = expectedByName.get(name);
    positiveInteger(asset.id, `release asset ${name} id`);
    if (asset.state === 'starter') {
      invariant(release.draft, 'a starter asset may be removed only from a draft release');
      const count = starterDeleteCounts[name] ?? 0;
      invariant(Number.isSafeInteger(count) && count >= 0, `starter delete count for ${name} is invalid`);
      invariant(count < 2, `starter delete limit reached for ${name}`);
      return { type: 'delete-starter', id: asset.id, name };
    }
    invariant(asset.state === 'uploaded', `release asset ${name} has invalid state`);
    invariant(asset.size === expectedAsset.size, `release asset ${name} size conflicts with the candidate`);
    const downloaded = observed[String(asset.id)];
    invariant(downloaded && typeof downloaded === 'object', `release asset ${name} has no fresh download evidence`);
    invariant(downloaded.name === name, `release asset ${name} download name conflicts`);
    invariant(downloaded.size === expectedAsset.size, `release asset ${name} downloaded size conflicts`);
    invariant(downloaded.sha256 === expectedAsset.sha256, `release asset ${name} digest conflicts with the candidate`);
  }

  for (const expectedAsset of expected.assets) {
    if (!currentByName.has(expectedAsset.name)) {
      invariant(release.draft, `published release is missing ${expectedAsset.name}`);
      return { type: 'upload', name: expectedAsset.name };
    }
  }
  return release.draft ? { type: 'publish' } : { type: 'complete' };
}

export function validateStarterDeletion({
  expected,
  release,
  assets,
  asset,
  plan,
  starterDeleteCounts
}) {
  exactKeys(plan, ['type', 'id', 'name'], 'starter deletion plan');
  invariant(plan.type === 'delete-starter', 'starter deletion plan has the wrong action');
  invariant(Array.isArray(assets), 'fresh release assets must be an array');
  const matchingAssets = assets.filter((entry) => entry?.id === plan.id);
  invariant(matchingAssets.length === 1, 'fresh release asset list does not contain the planned id');
  invariant(
    ['id', 'name', 'state', 'size'].every((key) => matchingAssets[0][key] === asset?.[key]),
    'fresh starter asset does not match the listed asset'
  );
  const freshPlan = planReleaseTransaction({
    expected,
    release,
    assets,
    observed: {},
    starterDeleteCounts
  });
  invariant(sameMetadata(freshPlan, plan), 'fresh starter state does not match the deletion plan');
  return plan;
}

export function validatePublication({ expected, tag, release, assets, observed, plan }) {
  exactKeys(plan, ['type'], 'publication plan');
  invariant(plan.type === 'publish', 'publication plan has the wrong action');
  validateReleaseTag(tag, expected.version, expected.candidateSha);
  const freshPlan = planReleaseTransaction({
    expected,
    release,
    assets,
    observed,
    starterDeleteCounts: {}
  });
  invariant(sameMetadata(freshPlan, plan), 'fresh release state does not permit publish');
  return plan;
}

function parsePositiveArgument(value, label) {
  invariant(/^[1-9][0-9]*$/.test(value ?? ''), `${label} must contain digits only`);
  return positiveInteger(Number(value), label);
}

function loadRelease(path) {
  if (path === '-') {
    return null;
  }
  return readJson(path, 'release JSON');
}

function normalizeAssets(value) {
  return Array.isArray(value) ? value : value?.assets;
}

function sameMetadata(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'validate-binding') {
    invariant(args.length === 8, 'validate-binding requires 8 arguments');
    const [runPath, artifactPath, inventoryPath, runId, attempt, artifactId, artifactName, candidateSha] = args;
    validateCandidateBinding({
      run: readJson(runPath, 'run JSON'),
      artifact: readJson(artifactPath, 'artifact JSON'),
      runArtifacts: readJson(inventoryPath, 'run artifacts JSON'),
      expected: {
        runId: parsePositiveArgument(runId, 'candidate run id'),
        runAttempt: parsePositiveArgument(attempt, 'candidate run attempt'),
        artifactId: parsePositiveArgument(artifactId, 'candidate artifact id'),
        artifactName,
        candidateSha
      }
    });
    return;
  }
  if (command === 'verify-candidate') {
    invariant(args.length === 7, 'verify-candidate requires 7 arguments');
    const [root, version, candidateSha, runId, attempt, artifactId, output] = args;
    const metadata = candidateAssetMetadata(root, version, candidateSha);
    metadata.releaseBody = releaseEvidenceBody({
      version,
      candidateSha,
      runId: parsePositiveArgument(runId, 'candidate run id'),
      runAttempt: parsePositiveArgument(attempt, 'candidate run attempt'),
      artifactId: parsePositiveArgument(artifactId, 'candidate artifact id')
    });
    writeJson(output, metadata);
    return;
  }
  if (command === 'plan-release') {
    invariant(args.length === 6, 'plan-release requires 6 arguments');
    const [expectedPath, releasePath, assetsPath, observedPath, countsPath, output] = args;
    const plan = planReleaseTransaction({
      expected: readJson(expectedPath, 'expected metadata'),
      release: loadRelease(releasePath),
      assets: normalizeAssets(readJson(assetsPath, 'release assets JSON')),
      observed: readJson(observedPath, 'observed assets JSON'),
      starterDeleteCounts: readJson(countsPath, 'starter delete counts JSON')
    });
    writeJson(output, plan);
    return;
  }
  if (command === 'observe-assets') {
    invariant(args.length === 3, 'observe-assets requires 3 arguments');
    const [assetsPath, root, output] = args;
    writeJson(
      output,
      observeReleaseAssets(normalizeAssets(readJson(assetsPath, 'release assets JSON')), root)
    );
    return;
  }
  if (command === 'verify-tag') {
    invariant(args.length === 3, 'verify-tag requires 3 arguments');
    const [tagPath, version, candidateSha] = args;
    validateReleaseTag(readJson(tagPath, 'tag JSON'), version, candidateSha);
    return;
  }
  if (command === 'verify-immutable-settings') {
    invariant(args.length === 1, 'verify-immutable-settings requires 1 argument');
    validateImmutableReleaseSettings(readJson(args[0], 'immutable release settings JSON'));
    return;
  }
  if (command === 'verify-starter-deletion') {
    invariant(args.length === 6, 'verify-starter-deletion requires 6 arguments');
    const [expectedPath, releasePath, assetsPath, assetPath, planPath, countsPath] = args;
    validateStarterDeletion({
      expected: readJson(expectedPath, 'expected metadata'),
      release: readJson(releasePath, 'release JSON'),
      assets: normalizeAssets(readJson(assetsPath, 'release assets JSON')),
      asset: readJson(assetPath, 'release asset JSON'),
      plan: readJson(planPath, 'starter deletion plan JSON'),
      starterDeleteCounts: readJson(countsPath, 'starter delete counts JSON')
    });
    return;
  }
  if (command === 'verify-publication') {
    invariant(args.length === 6, 'verify-publication requires 6 arguments');
    const [expectedPath, tagPath, releasePath, assetsPath, observedPath, planPath] = args;
    validatePublication({
      expected: readJson(expectedPath, 'expected metadata'),
      tag: readJson(tagPath, 'tag JSON'),
      release: readJson(releasePath, 'release JSON'),
      assets: normalizeAssets(readJson(assetsPath, 'release assets JSON')),
      observed: readJson(observedPath, 'observed assets JSON'),
      plan: readJson(planPath, 'publication plan JSON')
    });
    return;
  }
  if (command === 'verify-live-release') {
    invariant(args.length === 2, 'verify-live-release requires 2 arguments');
    const [root, expectedPath] = args;
    const expected = readJson(expectedPath, 'expected metadata');
    const actual = candidateAssetMetadata(root, expected.version, expected.candidateSha);
    invariant(
      sameMetadata(actual, {
        version: expected.version,
        candidateSha: expected.candidateSha,
        assets: expected.assets
      }),
      'live release assets do not match the candidate'
    );
    return;
  }
  throw new Error(`unknown promotion command: ${command ?? ''}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
