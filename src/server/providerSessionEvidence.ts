import { constants, type BigIntStats, type Dir, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder, types as utilTypes } from 'node:util';
import { isValidProfileId, profileRoot } from '../shared/agentProfiles.js';
import { isValidProviderSessionId } from '../shared/providerSessionIdentity.js';
import { claudeProjectDirName } from './claudeProfileContinuity.js';

// Provider transcripts are untrusted evidence, not binding authority. Keep all
// discovery and parsing limits here so callers cannot accidentally turn this
// verifier into an unbounded recursive scan or a manifest-writing seam.
export const PROVIDER_EVIDENCE_MAX_DIRECTORY_ENTRIES = 65_536;
export const PROVIDER_EVIDENCE_MAX_PREFIX_BYTES = 256 * 1_024;
export const PROVIDER_EVIDENCE_MAX_RECORDS = 64;
export const PROVIDER_EVIDENCE_MAX_LINE_BYTES = 64 * 1_024;

export type ProviderSessionEvidenceProvider = 'codex' | 'claude';

export interface VerifyProviderSessionEvidenceOptions {
  provider: ProviderSessionEvidenceProvider;
  providerSessionId: string;
  selected: {
    cwd: string;
    profileId?: string;
  };
  homeDir: string;
  notBeforeMs: number;
}

/** @internal Deterministic race/bound seams; production callers leave this absent. */
export interface ProviderSessionEvidenceTestOptions {
  beforeOpen?: (candidatePath: string) => void | Promise<void>;
  afterOpen?: (candidatePath: string) => void | Promise<void>;
  afterRead?: (candidatePath: string) => void | Promise<void>;
  beforeDirectoryOpen?: (directoryPath: string) => void | Promise<void>;
  afterDirectoryOpen?: (directoryPath: string) => void | Promise<void>;
  afterDirectoryRead?: (
    directoryPath: string,
    entry: Dirent | null
  ) => void | Promise<void>;
  directoryDescriptorPath?: (descriptor: number) => string;
  readChunk?: (
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>;
  limits?: {
    maxDirectoryEntries?: number;
  };
}

export type ProviderSessionEvidenceFailure = {
  ok: false;
  code:
    | 'evidence-not-found'
    | 'evidence-mismatch'
    | 'evidence-invalid-request'
    | 'evidence-stale'
    | 'evidence-malformed'
    | 'evidence-line-too-long'
    | 'evidence-scan-bound-exhausted'
    | 'evidence-unsafe-file';
  error: string;
};

export type ProviderSessionEvidenceResult =
  | {
      ok: true;
      provider: ProviderSessionEvidenceProvider;
      providerSessionId: string;
      evidencePath: string;
    }
  | ProviderSessionEvidenceFailure;

interface DirectoryEntryBudget {
  remaining: number;
  exhausted: boolean;
}

type DirectoryEntriesResult =
  | { ok: true; entries: Dirent[] }
  | ProviderSessionEvidenceFailure;

interface ValidatedDirectoryPath {
  readonly rootPath: string;
  readonly path: string;
  readonly canonicalRoot: string;
  readonly canonicalPath: string;
  readonly rootMetadata: BigIntStats;
  readonly intermediateMetadata: readonly BigIntStats[];
  readonly directoryMetadata: BigIntStats;
}

interface TrustedDirectory extends ValidatedDirectoryPath {
  readonly sourcePath: string;
  readonly descriptorPath: string;
  readonly handle: FileHandle;
}

interface RetainedDirectoryEpoch {
  readonly directory: ValidatedDirectoryPath;
  readonly sourcePath: string;
}

type DirectoryCandidatesResult =
  | { ok: true; candidates: ValidatedDirectoryPath[] }
  | ProviderSessionEvidenceFailure;

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function compareNumericDirectoryNamesNewestFirst(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedRight.length - normalizedLeft.length;
  }
  const numericOrder = normalizedRight.localeCompare(normalizedLeft);
  return numericOrder !== 0 ? numericOrder : right.localeCompare(left);
}

const CODEX_ROLLOUT_FILE_RE =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_NUMERIC_DIRECTORY_RE = /^\d+$/;

function isExactCodexCandidate(
  name: string,
  year: string,
  month: string,
  day: string,
  providerSessionId: string
): boolean {
  const match = CODEX_ROLLOUT_FILE_RE.exec(name);
  return Boolean(
    match &&
      Number(match[1]) === Number(year) &&
      Number(match[2]) === Number(month) &&
      Number(match[3]) === Number(day) &&
      match[4] === providerSessionId
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function readBoundedDirectoryEntries(
  directory: Dir,
  trusted: TrustedDirectory,
  budget: DirectoryEntryBudget,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  while (budget.remaining > 0) {
    if (!(await revalidateTrustedDirectory(trusted))) {
      throw new Error('provider evidence directory identity changed before read');
    }
    const entry = await directory.read();
    await testOptions.afterDirectoryRead?.(trusted.path, entry);
    if (!(await revalidateTrustedDirectory(trusted))) {
      throw new Error('provider evidence directory identity changed after read');
    }
    if (entry === null) return entries;
    budget.remaining -= 1;
    entries.push(entry);
  }
  // The Nth permitted entry is still in bounds. Probe once only to
  // distinguish exact EOF from a genuine N+1 entry; never inspect that
  // sentinel entry or include it in traversal/selection.
  if (!(await revalidateTrustedDirectory(trusted))) {
    throw new Error('provider evidence directory identity changed before sentinel read');
  }
  const sentinel = await directory.read();
  await testOptions.afterDirectoryRead?.(trusted.path, sentinel);
  if (!(await revalidateTrustedDirectory(trusted))) {
    throw new Error('provider evidence directory identity changed after sentinel read');
  }
  budget.exhausted = sentinel !== null;
  return entries;
}

async function boundedDirectoryEntries(
  directoryPath: TrustedDirectory,
  budget: DirectoryEntryBudget,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<DirectoryEntriesResult> {
  let directory: Dir;
  try {
    if (!(await revalidateTrustedDirectory(directoryPath))) return unsafeEvidenceFile();
    directory = await opendir(directoryPath.descriptorPath);
    if (!(await revalidateTrustedDirectory(directoryPath))) {
      await directory.close().catch(() => undefined);
      return unsafeEvidenceFile();
    }
  } catch {
    return unsafeEvidenceFile();
  }

  let result: DirectoryEntriesResult;
  try {
    result = {
      ok: true,
      entries: await readBoundedDirectoryEntries(
        directory,
        directoryPath,
        budget,
        testOptions
      )
    };
  } catch {
    result = unsafeEvidenceFile();
  }
  try {
    await directory.close();
  } catch {
    return unsafeEvidenceFile();
  }
  if (!(await revalidateTrustedDirectory(directoryPath))) return unsafeEvidenceFile();
  return result;
}

async function numericDirectories(
  directory: TrustedDirectory,
  budget: DirectoryEntryBudget,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<DirectoryCandidatesResult> {
  const result = await boundedDirectoryEntries(directory, budget, testOptions);
  if (!result.ok) return result;
  const candidates: ValidatedDirectoryPath[] = [];
  for (const entry of result.entries) {
    if (!CODEX_NUMERIC_DIRECTORY_RE.test(entry.name)) continue;
    if (!entry.isDirectory()) return unsafeEvidenceFile();
    let sourceMetadata: BigIntStats;
    try {
      if (!(await revalidateTrustedDirectory(directory))) return unsafeEvidenceFile();
      sourceMetadata = await lstat(join(directory.descriptorPath, entry.name), {
        bigint: true
      });
      if (!(await revalidateTrustedDirectory(directory))) return unsafeEvidenceFile();
    } catch {
      return unsafeEvidenceFile();
    }
    if (sourceMetadata.isSymbolicLink()) return unsafeEvidenceFile();
    if (!sourceMetadata.isDirectory()) return unsafeEvidenceFile();
    const observed = await observeChildDirectory(directory, entry.name);
    if (observed === undefined) return unsafeEvidenceFile();
    if (!sameDirectory(sourceMetadata, observed.directoryMetadata)) return unsafeEvidenceFile();
    candidates.push(observed);
  }
  candidates.sort((left, right) =>
    compareNumericDirectoryNamesNewestFirst(
      left.path.slice(left.path.lastIndexOf(sep) + 1),
      right.path.slice(right.path.lastIndexOf(sep) + 1)
    )
  );
  return {
    ok: true,
    candidates
  };
}

function evidenceNotFound(): ProviderSessionEvidenceFailure {
  return {
    ok: false,
    code: 'evidence-not-found',
    error: 'provider session evidence was not found'
  };
}

function invalidEvidenceRequest(): ProviderSessionEvidenceFailure {
  return {
    ok: false,
    code: 'evidence-invalid-request',
    error: 'provider session evidence request is invalid'
  };
}

function unsafeEvidenceFile(): ProviderSessionEvidenceFailure {
  return {
    ok: false,
    code: 'evidence-unsafe-file',
    error: 'provider session evidence file is unsafe'
  };
}

function scanBoundExhausted(): ProviderSessionEvidenceFailure {
  return {
    ok: false,
    code: 'evidence-scan-bound-exhausted',
    error: 'provider session evidence scan bound was exhausted'
  };
}

function oversizedEvidenceLine(): ProviderSessionEvidenceFailure {
  return {
    ok: false,
    code: 'evidence-line-too-long',
    error: 'provider session evidence contains an oversized JSONL record'
  };
}

function malformedEvidence(): ProviderSessionEvidenceFailure {
  return {
    ok: false,
    code: 'evidence-malformed',
    error: 'provider session evidence contains malformed JSON'
  };
}

function sameRegularFile(pathMetadata: BigIntStats, openedMetadata: BigIntStats): boolean {
  return (
    pathMetadata.isFile() &&
    openedMetadata.isFile() &&
    pathMetadata.dev === openedMetadata.dev &&
    pathMetadata.ino === openedMetadata.ino
  );
}

function sameRegularFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    sameRegularFile(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function sameDirectory(pathMetadata: BigIntStats, currentMetadata: BigIntStats): boolean {
  return (
    pathMetadata.isDirectory() &&
    currentMetadata.isDirectory() &&
    pathMetadata.dev === currentMetadata.dev &&
    pathMetadata.ino === currentMetadata.ino &&
    pathMetadata.size === currentMetadata.size &&
    pathMetadata.mtimeNs === currentMetadata.mtimeNs &&
    pathMetadata.ctimeNs === currentMetadata.ctimeNs
  );
}

function sameValidatedDirectoryPath(
  expected: ValidatedDirectoryPath,
  current: ValidatedDirectoryPath
): boolean {
  return (
    expected.rootPath === current.rootPath &&
    expected.path === current.path &&
    expected.canonicalRoot === current.canonicalRoot &&
    expected.canonicalPath === current.canonicalPath &&
    sameDirectory(expected.rootMetadata, current.rootMetadata) &&
    expected.intermediateMetadata.length === current.intermediateMetadata.length &&
    expected.intermediateMetadata.every((metadata, index) =>
      sameDirectory(metadata, current.intermediateMetadata[index]!)
    ) &&
    sameDirectory(expected.directoryMetadata, current.directoryMetadata)
  );
}

async function lstatDirectoryPath(
  root: string,
  directoryPath: string
): Promise<Omit<ValidatedDirectoryPath, 'canonicalRoot' | 'canonicalPath'> | undefined> {
  const rootPath = resolve(root);
  const path = resolve(directoryPath);
  if (!isContainedPath(rootPath, path)) return undefined;
  try {
    const rootMetadata = await lstat(rootPath, { bigint: true });
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return undefined;
    const parts = relative(rootPath, path).split(sep);
    const intermediateMetadata: BigIntStats[] = [];
    let current = rootPath;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      const metadata = await lstat(current, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
      if (index < parts.length - 1) {
        intermediateMetadata.push(metadata);
      } else {
        return {
          rootPath,
          path,
          rootMetadata,
          intermediateMetadata,
          directoryMetadata: metadata
        };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function validateProviderRoot(
  root: string
): Promise<ValidatedDirectoryPath | undefined> {
  const rootPath = resolve(root);
  try {
    const before = await lstat(rootPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
    const canonicalRoot = await realpath(rootPath);
    const after = await lstat(rootPath, { bigint: true });
    if (!sameDirectory(before, after)) return undefined;
    return {
      rootPath,
      path: rootPath,
      canonicalRoot,
      canonicalPath: canonicalRoot,
      rootMetadata: after,
      intermediateMetadata: [],
      directoryMetadata: after
    };
  } catch {
    return undefined;
  }
}

async function validateDirectoryPath(
  root: string,
  directoryPath: string
): Promise<ValidatedDirectoryPath | undefined> {
  const before = await lstatDirectoryPath(root, directoryPath);
  if (before === undefined) return undefined;
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(before.rootPath),
      realpath(before.path)
    ]);
    if (!isContainedPath(canonicalRoot, canonicalPath)) return undefined;
    const after = await lstatDirectoryPath(before.rootPath, before.path);
    if (after === undefined) return undefined;
    const validatedBefore: ValidatedDirectoryPath = {
      ...before,
      canonicalRoot,
      canonicalPath
    };
    const validatedAfter: ValidatedDirectoryPath = {
      ...after,
      canonicalRoot,
      canonicalPath
    };
    return sameValidatedDirectoryPath(validatedBefore, validatedAfter)
      ? validatedAfter
      : undefined;
  } catch {
    return undefined;
  }
}

async function revalidateDirectorySource(
  expected: ValidatedDirectoryPath,
  sourcePath: string
): Promise<boolean> {
  try {
    const [current, sourceMetadata, canonicalSource] = await Promise.all([
      expected.path === expected.rootPath
        ? validateProviderRoot(expected.rootPath)
        : validateDirectoryPath(expected.rootPath, expected.path),
      lstat(sourcePath, { bigint: true }),
      realpath(sourcePath)
    ]);
    return (
      current !== undefined &&
      sameValidatedDirectoryPath(expected, current) &&
      sameDirectory(expected.directoryMetadata, sourceMetadata) &&
      canonicalSource === expected.canonicalPath
    );
  } catch {
    return false;
  }
}

// Proves a descriptor alias (for example /dev/fd/N) still names the expected
// directory by CAPABILITY rather than by path: re-open it read-only and require
// the same dev+ino identity as the trusted directory. A realpath comparison
// only works where the alias is a magic symlink (Linux /proc and /dev/fd);
// macOS /dev/fd is an fdesc node whose realpath returns the alias itself, so a
// path comparison there could never hold and silently degraded every provider
// directory to untrusted. Opening the alias and fstat-ing it works on both
// platforms and is fail-closed: any open/stat failure or a dev+ino mismatch
// (a bad or swapped alias) yields false. Identity is enforced on `probed`.
async function descriptorAliasHasDirectoryIdentity(
  descriptorPath: string,
  expected: BigIntStats
): Promise<boolean> {
  let probe: FileHandle | undefined;
  try {
    probe = await open(descriptorPath, constants.O_RDONLY);
    return sameDirectory(expected, await probe.stat({ bigint: true }));
  } catch {
    return false;
  } finally {
    await probe?.close().catch(() => undefined);
  }
}

async function revalidateTrustedDirectory(directory: TrustedDirectory): Promise<boolean> {
  try {
    const [reachable, openedMetadata, descriptorHasIdentity] = await Promise.all([
      revalidateDirectorySource(directory, directory.sourcePath),
      directory.handle.stat({ bigint: true }),
      descriptorAliasHasDirectoryIdentity(directory.descriptorPath, directory.directoryMetadata)
    ]);
    return reachable && sameDirectory(directory.directoryMetadata, openedMetadata) && descriptorHasIdentity;
  } catch {
    return false;
  }
}

async function observeChildDirectory(
  parent: TrustedDirectory,
  name: string
): Promise<ValidatedDirectoryPath | undefined> {
  if (!(await revalidateTrustedDirectory(parent))) return undefined;
  const path = join(parent.path, name);
  const sourcePath = join(parent.descriptorPath, name);
  const observed = await validateDirectoryPath(parent.rootPath, path);
  if (observed === undefined) return undefined;
  if (!(await revalidateDirectorySource(observed, sourcePath))) return undefined;
  return (await revalidateTrustedDirectory(parent)) ? observed : undefined;
}

function directoryOpenFlags(): number | undefined {
  if (
    typeof constants.O_DIRECTORY !== 'number' ||
    typeof constants.O_NOFOLLOW !== 'number'
  ) {
    return undefined;
  }
  return (
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0)
  );
}

async function openTrustedDirectory(
  expected: ValidatedDirectoryPath,
  sourcePath: string,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<TrustedDirectory | undefined> {
  const flags = directoryOpenFlags();
  if (flags === undefined) return undefined;
  try {
    await testOptions.beforeDirectoryOpen?.(expected.path);
  } catch {
    return undefined;
  }
  if (!(await revalidateDirectorySource(expected, sourcePath))) return undefined;

  let handle: FileHandle;
  try {
    handle = await open(sourcePath, flags);
  } catch {
    return undefined;
  }
  let transferred = false;
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    if (!sameDirectory(expected.directoryMetadata, openedMetadata)) return undefined;
    const descriptorPath =
      testOptions.directoryDescriptorPath?.(handle.fd) ?? `/dev/fd/${handle.fd}`;
    // Re-confirm the descriptor alias by capability (dev+ino), cross-platform
    // and fail-closed -- see descriptorAliasHasDirectoryIdentity. The same
    // invariant is re-checked by revalidateTrustedDirectory below and on every
    // later revalidation, so trust never rests on a Linux-only realpath.
    if (!(await descriptorAliasHasDirectoryIdentity(descriptorPath, expected.directoryMetadata))) {
      return undefined;
    }
    const trusted: TrustedDirectory = {
      ...expected,
      sourcePath,
      descriptorPath,
      handle
    };
    await testOptions.afterDirectoryOpen?.(expected.path);
    if (!(await revalidateTrustedDirectory(trusted))) return undefined;
    transferred = true;
    return trusted;
  } catch {
    return undefined;
  } finally {
    if (!transferred) await handle.close().catch(() => undefined);
  }
}

async function closeTrustedDirectory(directory: TrustedDirectory): Promise<boolean> {
  // close() is the point where descriptor authority is lost. Prove the live
  // descriptor immediately before it, then make the reachable path/epoch the
  // post-close linearization point instead of returning a pre-close result.
  const trustedBeforeClose = await revalidateTrustedDirectory(directory);
  try {
    await directory.handle.close();
  } catch {
    return false;
  }
  return (
    trustedBeforeClose &&
    (await revalidateDirectorySource(directory, directory.sourcePath))
  );
}

function retainClosedDirectoryEpoch(directory: TrustedDirectory): RetainedDirectoryEpoch {
  return {
    directory: {
      rootPath: directory.rootPath,
      path: directory.path,
      canonicalRoot: directory.canonicalRoot,
      canonicalPath: directory.canonicalPath,
      rootMetadata: directory.rootMetadata,
      intermediateMetadata: directory.intermediateMetadata,
      directoryMetadata: directory.directoryMetadata
    },
    // The descriptor-relative source disappears as ancestors unwind. The
    // validated reachable path is the only durable source for the final epoch
    // proof, and revalidateDirectorySource rechecks its full lstat/realpath chain.
    sourcePath: directory.path
  };
}

async function revalidateRetainedDirectoryEpochs(
  epochs: readonly RetainedDirectoryEpoch[]
): Promise<boolean> {
  for (const epoch of epochs) {
    if (!(await revalidateDirectorySource(epoch.directory, epoch.sourcePath))) return false;
  }
  return true;
}

async function useTrustedDirectory<T>(
  directory: TrustedDirectory,
  operation: () => Promise<T>
): Promise<T | ProviderSessionEvidenceFailure> {
  let result: T | ProviderSessionEvidenceFailure;
  try {
    result = await operation();
  } catch {
    result = unsafeEvidenceFile();
  }
  return (await closeTrustedDirectory(directory)) ? result : unsafeEvidenceFile();
}

type TrustedDirectoryLookupResult =
  | { ok: true; directory: TrustedDirectory }
  | ProviderSessionEvidenceFailure;

async function openProviderRoot(
  root: string,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<TrustedDirectoryLookupResult> {
  let observedRoot: BigIntStats;
  try {
    observedRoot = await lstat(root, { bigint: true });
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? evidenceNotFound() : unsafeEvidenceFile();
  }
  if (!observedRoot.isDirectory() || observedRoot.isSymbolicLink()) {
    return unsafeEvidenceFile();
  }
  const validatedRoot = await validateProviderRoot(root);
  if (
    validatedRoot === undefined ||
    !sameDirectory(observedRoot, validatedRoot.directoryMetadata)
  ) {
    return unsafeEvidenceFile();
  }
  const directory = await openTrustedDirectory(
    validatedRoot,
    validatedRoot.path,
    testOptions
  );
  return directory === undefined ? unsafeEvidenceFile() : { ok: true, directory };
}

async function openExactChildDirectory(
  parent: TrustedDirectory,
  name: string,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<TrustedDirectoryLookupResult> {
  const sourcePath = join(parent.descriptorPath, name);
  let sourceMetadata: BigIntStats;
  try {
    if (!(await revalidateTrustedDirectory(parent))) return unsafeEvidenceFile();
    sourceMetadata = await lstat(sourcePath, { bigint: true });
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') && (await revalidateTrustedDirectory(parent))
      ? evidenceNotFound()
      : unsafeEvidenceFile();
  }
  if (!(await revalidateTrustedDirectory(parent))) return unsafeEvidenceFile();
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    return unsafeEvidenceFile();
  }
  const observed = await observeChildDirectory(parent, name);
  if (
    observed === undefined ||
    !sameDirectory(sourceMetadata, observed.directoryMetadata)
  ) {
    return unsafeEvidenceFile();
  }
  const directory = await openTrustedDirectory(observed, sourcePath, testOptions);
  return directory === undefined ? unsafeEvidenceFile() : { ok: true, directory };
}

interface SafePathChain {
  rootMetadata: BigIntStats;
  intermediateMetadata: BigIntStats[];
  candidateMetadata: BigIntStats;
}

function sameSafePathChain(expected: SafePathChain, current: SafePathChain): boolean {
  return (
    sameDirectory(expected.rootMetadata, current.rootMetadata) &&
    expected.intermediateMetadata.length === current.intermediateMetadata.length &&
    expected.intermediateMetadata.every((metadata, index) =>
      sameDirectory(metadata, current.intermediateMetadata[index]!)
    ) &&
    sameRegularFile(expected.candidateMetadata, current.candidateMetadata)
  );
}

async function lstatSafePathChain(
  root: string,
  candidate: string
): Promise<SafePathChain | undefined> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isContainedPath(resolvedRoot, resolvedCandidate)) return undefined;
  try {
    const rootMetadata = await lstat(resolvedRoot, { bigint: true });
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return undefined;
    const parts = relative(resolvedRoot, resolvedCandidate).split(sep);
    const intermediateMetadata: BigIntStats[] = [];
    let current = resolvedRoot;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      const metadata = await lstat(current, { bigint: true });
      if (metadata.isSymbolicLink()) return undefined;
      if (index < parts.length - 1) {
        if (!metadata.isDirectory()) return undefined;
        intermediateMetadata.push(metadata);
      } else {
        return metadata.isFile()
          ? { rootMetadata, intermediateMetadata, candidateMetadata: metadata }
          : undefined;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface ValidatedEvidencePath extends SafePathChain {
  canonicalRoot: string;
  canonicalCandidate: string;
}

interface ValidatedEvidenceCandidate {
  readonly parent: TrustedDirectory;
  readonly path: string;
  readonly sourcePath: string;
  readonly validatedPath: ValidatedEvidencePath;
}

type EvidenceCandidateLookupResult =
  | { ok: true; candidate: ValidatedEvidenceCandidate }
  | ProviderSessionEvidenceFailure;

async function validateEvidencePath(
  root: string,
  candidate: string
): Promise<ValidatedEvidencePath | undefined> {
  const chain = await lstatSafePathChain(root, candidate);
  if (chain === undefined) return undefined;
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate)
    ]);
    if (!isContainedPath(canonicalRoot, canonicalCandidate)) return undefined;
    const currentChain = await lstatSafePathChain(root, candidate);
    if (currentChain === undefined || !sameSafePathChain(chain, currentChain)) return undefined;
    return { ...currentChain, canonicalRoot, canonicalCandidate };
  } catch {
    return undefined;
  }
}

function sameValidatedEvidencePath(
  expected: ValidatedEvidencePath,
  current: ValidatedEvidencePath
): boolean {
  return (
    sameSafePathChain(expected, current) &&
    expected.canonicalRoot === current.canonicalRoot &&
    expected.canonicalCandidate === current.canonicalCandidate
  );
}

async function revalidateEvidenceCandidate(
  candidate: ValidatedEvidenceCandidate
): Promise<boolean> {
  try {
    if (!(await revalidateTrustedDirectory(candidate.parent))) return false;
    const [currentPath, sourceMetadata, canonicalSource] = await Promise.all([
      validateEvidencePath(candidate.parent.rootPath, candidate.path),
      lstat(candidate.sourcePath, { bigint: true }),
      realpath(candidate.sourcePath)
    ]);
    if (
      currentPath === undefined ||
      !sameValidatedEvidencePath(candidate.validatedPath, currentPath) ||
      !sameRegularFile(candidate.validatedPath.candidateMetadata, sourceMetadata) ||
      canonicalSource !== candidate.validatedPath.canonicalCandidate
    ) {
      return false;
    }
    return revalidateTrustedDirectory(candidate.parent);
  } catch {
    return false;
  }
}

async function revalidateEvidenceCandidateSnapshot(
  candidate: ValidatedEvidenceCandidate,
  expectedMetadata: BigIntStats
): Promise<boolean> {
  try {
    if (!(await revalidateTrustedDirectory(candidate.parent))) return false;
    const [currentPath, sourceMetadata, canonicalSource] = await Promise.all([
      validateEvidencePath(candidate.parent.rootPath, candidate.path),
      lstat(candidate.sourcePath, { bigint: true }),
      realpath(candidate.sourcePath)
    ]);
    if (
      currentPath === undefined ||
      !sameValidatedEvidencePath(candidate.validatedPath, currentPath) ||
      !sameRegularFileSnapshot(expectedMetadata, currentPath.candidateMetadata) ||
      !sameRegularFileSnapshot(expectedMetadata, sourceMetadata) ||
      canonicalSource !== candidate.validatedPath.canonicalCandidate
    ) {
      return false;
    }
    return revalidateTrustedDirectory(candidate.parent);
  } catch {
    return false;
  }
}

async function lookupEvidenceCandidate(
  parent: TrustedDirectory,
  name: string,
  missingIsNotFound: boolean
): Promise<EvidenceCandidateLookupResult> {
  const path = join(parent.path, name);
  const sourcePath = join(parent.descriptorPath, name);
  let sourceMetadata: BigIntStats;
  try {
    if (!(await revalidateTrustedDirectory(parent))) return unsafeEvidenceFile();
    sourceMetadata = await lstat(sourcePath, { bigint: true });
  } catch (error) {
    if (!(await revalidateTrustedDirectory(parent))) return unsafeEvidenceFile();
    return missingIsNotFound && hasErrorCode(error, 'ENOENT')
      ? evidenceNotFound()
      : unsafeEvidenceFile();
  }
  if (!(await revalidateTrustedDirectory(parent))) return unsafeEvidenceFile();
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    return unsafeEvidenceFile();
  }
  const validatedPath = await validateEvidencePath(parent.rootPath, path);
  if (
    validatedPath === undefined ||
    !sameRegularFile(sourceMetadata, validatedPath.candidateMetadata)
  ) {
    return unsafeEvidenceFile();
  }
  const candidate: ValidatedEvidenceCandidate = {
    parent,
    path,
    sourcePath,
    validatedPath
  };
  return (await revalidateEvidenceCandidate(candidate))
    ? { ok: true, candidate }
    : unsafeEvidenceFile();
}

type ValidatedEvidenceRead = {
  ok: true;
  canonicalPath: string;
  content: Buffer;
  truncated: boolean;
};

function mtimePredates(metadata: BigIntStats, notBeforeMs: number): boolean {
  const wholeMilliseconds = Math.floor(notBeforeMs);
  const fractionalNanoseconds = Math.ceil(
    (notBeforeMs - wholeMilliseconds) * 1_000_000
  );
  const notBeforeNs =
    BigInt(wholeMilliseconds) * 1_000_000n + BigInt(fractionalNanoseconds);
  return metadata.mtimeNs < notBeforeNs;
}

async function readValidatedEvidence(
  candidate: ValidatedEvidenceCandidate,
  notBeforeMs: number,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<ValidatedEvidenceRead | ProviderSessionEvidenceFailure> {
  try {
    await testOptions.beforeOpen?.(candidate.path);
  } catch {
    return unsafeEvidenceFile();
  }
  if (!(await revalidateEvidenceCandidate(candidate))) return unsafeEvidenceFile();

  let handle: FileHandle;
  try {
    // O_NOFOLLOW closes the leaf-symlink race and O_NONBLOCK prevents a FIFO
    // swap from hanging the final open where the platform exposes either flag;
    // the lstat/fstat identity fences below remain mandatory on every platform.
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
    handle = await open(candidate.sourcePath, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    return unsafeEvidenceFile();
  }

  let result: ValidatedEvidenceRead | ProviderSessionEvidenceFailure;
  let finalReadMetadata: BigIntStats | undefined;
  try {
    await testOptions.afterOpen?.(candidate.path);
    const [openedMetadata, candidateStillValid] = await Promise.all([
      handle.stat({ bigint: true }),
      revalidateEvidenceCandidate(candidate)
    ]);
    if (
      !candidateStillValid ||
      !sameRegularFile(candidate.validatedPath.candidateMetadata, openedMetadata)
    ) {
      result = unsafeEvidenceFile();
    } else if (mtimePredates(openedMetadata, notBeforeMs)) {
      result = {
        ok: false,
        code: 'evidence-stale',
        error: 'provider session evidence predates this launch'
      };
    } else {
      const bytes = Buffer.alloc(PROVIDER_EVIDENCE_MAX_PREFIX_BYTES);
      const readChunk =
        testOptions.readChunk ??
        ((_handle, buffer, offset, length, position) =>
          handle.read(buffer, offset, length, position));
      let bytesRead = 0;
      while (bytesRead < PROVIDER_EVIDENCE_MAX_PREFIX_BYTES) {
        const remaining = PROVIDER_EVIDENCE_MAX_PREFIX_BYTES - bytesRead;
        const result = await readChunk(handle, bytes, bytesRead, remaining, bytesRead);
        if (
          !Number.isSafeInteger(result.bytesRead) ||
          result.bytesRead < 0 ||
          result.bytesRead > remaining
        ) {
          throw new Error('provider evidence reader returned an invalid byte count');
        }
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      await testOptions.afterRead?.(candidate.path);
      const [afterReadMetadata, candidateStillValidAfterRead] = await Promise.all([
        handle.stat({ bigint: true }),
        revalidateEvidenceCandidate(candidate)
      ]);
      if (
        !candidateStillValidAfterRead ||
        !sameRegularFile(candidate.validatedPath.candidateMetadata, afterReadMetadata)
      ) {
        result = unsafeEvidenceFile();
      } else if (mtimePredates(afterReadMetadata, notBeforeMs)) {
        result = {
          ok: false,
          code: 'evidence-stale',
          error: 'provider session evidence predates this launch'
        };
      } else if (!sameRegularFileSnapshot(openedMetadata, afterReadMetadata)) {
        result = unsafeEvidenceFile();
      } else {
        finalReadMetadata = afterReadMetadata;
        result = {
          ok: true,
          canonicalPath: candidate.validatedPath.canonicalCandidate,
          content: bytes.subarray(0, bytesRead),
          truncated: afterReadMetadata.size > BigInt(bytesRead)
        };
      }
    }
  } catch {
    result = unsafeEvidenceFile();
  }

  let preCloseMetadata: BigIntStats | undefined;
  if (result.ok && finalReadMetadata !== undefined) {
    // The returned bytes are already bracketed by opened/after-read bigint fd
    // snapshots. Carry that exact size/mtime/ctime identity across close so a
    // same-inode in-place rewrite cannot inherit the pre-close eligible bytes.
    try {
      const [currentMetadata, candidateStillValidBeforeClose] = await Promise.all([
        handle.stat({ bigint: true }),
        revalidateEvidenceCandidateSnapshot(candidate, finalReadMetadata)
      ]);
      if (
        candidateStillValidBeforeClose &&
        sameRegularFileSnapshot(finalReadMetadata, currentMetadata)
      ) {
        preCloseMetadata = currentMetadata;
      } else {
        result = unsafeEvidenceFile();
      }
    } catch {
      result = unsafeEvidenceFile();
    }
  }

  try {
    await handle.close();
  } catch {
    return unsafeEvidenceFile();
  }
  if (
    result.ok &&
    (preCloseMetadata === undefined ||
      !(await revalidateEvidenceCandidateSnapshot(candidate, preCloseMetadata)))
  ) {
    return unsafeEvidenceFile();
  }
  return result;
}

function inspectBoundedJsonl(
  content: Buffer,
  truncated: boolean,
  isEligible: (record: unknown) => boolean
): { ok: true } | ProviderSessionEvidenceFailure {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let recordsInspected = 0;
  const inspectCompleteLine = (
    start: number,
    end: number
  ): { ok: true } | ProviderSessionEvidenceFailure | undefined => {
    if (recordsInspected >= PROVIDER_EVIDENCE_MAX_RECORDS) {
      return {
        ok: false,
        code: 'evidence-scan-bound-exhausted',
        error: 'provider session evidence scan bound was exhausted'
      };
    }
    recordsInspected += 1;
    const lineLength = end - start;
    if (lineLength === 0) return malformedEvidence();
    if (lineLength > PROVIDER_EVIDENCE_MAX_LINE_BYTES) {
      return oversizedEvidenceLine();
    }
    let decodedLine: string;
    try {
      decodedLine = decoder.decode(content.subarray(start, end));
    } catch {
      return malformedEvidence();
    }
    let value: unknown;
    try {
      value = JSON.parse(decodedLine);
    } catch {
      return malformedEvidence();
    }
    return isEligible(value) ? { ok: true } : undefined;
  };

  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a) {
      const inspection = inspectCompleteLine(lineStart, index);
      if (inspection !== undefined) return inspection;
      lineStart = index + 1;
    }
  }
  if (lineStart < content.length) {
    if (truncated) {
      // A byte-budget cut is not an EOF delimiter. Size can be proven from the
      // fragment, but neither its UTF-8 nor its JSON is parsed as a complete record.
      if (content.length - lineStart > PROVIDER_EVIDENCE_MAX_LINE_BYTES) {
        return oversizedEvidenceLine();
      }
    } else {
      const inspection = inspectCompleteLine(lineStart, content.length);
      if (inspection !== undefined) return inspection;
    }
  }
  return truncated
    ? {
        ok: false,
        code: 'evidence-scan-bound-exhausted',
        error: 'provider session evidence scan bound was exhausted'
      }
    : {
        ok: false,
        code: 'evidence-mismatch',
        error: 'provider session evidence did not match the requested identity'
      };
}

type CodexDiscoveryResult = ProviderSessionEvidenceResult | undefined;

async function scanCodexHierarchy(
  directory: TrustedDirectory,
  labels: readonly string[],
  options: VerifyProviderSessionEvidenceOptions,
  budget: DirectoryEntryBudget,
  retainedNewerEpochs: RetainedDirectoryEpoch[],
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<CodexDiscoveryResult> {
  if (labels.length < 3) {
    const children = await numericDirectories(directory, budget, testOptions);
    if (!children.ok) return children;
    if (budget.exhausted) return scanBoundExhausted();
    for (const childPath of children.candidates) {
      const childName = basename(childPath.path);
      const child = await openTrustedDirectory(
        childPath,
        join(directory.descriptorPath, childName),
        testOptions
      );
      if (child === undefined) return unsafeEvidenceFile();
      const childResult = await useTrustedDirectory(child, () =>
        scanCodexHierarchy(
          child,
          [...labels, childName],
          options,
          budget,
          retainedNewerEpochs,
          testOptions
        )
      );
      if (childResult !== undefined) return childResult;
      // A completed child precedes every later sibling in the numeric
      // newest-first walk. Keep its bounded path/epoch snapshot after close so
      // a deeper insertion cannot hide behind unchanged ancestor epochs.
      retainedNewerEpochs.push(retainClosedDirectoryEpoch(child));
    }
    return undefined;
  }

  const entries = await boundedDirectoryEntries(directory, budget, testOptions);
  if (!entries.ok) return entries;
  if (budget.exhausted) return scanBoundExhausted();
  const names = entries.entries.map((entry) => entry.name).sort().reverse();
  const [year, month, day] = labels;
  for (const name of names) {
    if (!isExactCodexCandidate(name, year!, month!, day!, options.providerSessionId)) {
      continue;
    }
    const candidate = await lookupEvidenceCandidate(directory, name, false);
    if (!candidate.ok) return candidate;
    const evidence = await readValidatedEvidence(
      candidate.candidate,
      options.notBeforeMs,
      testOptions
    );
    if (!(await revalidateTrustedDirectory(directory))) return unsafeEvidenceFile();
    if (!evidence.ok) return evidence;
    const inspection = inspectBoundedJsonl(evidence.content, evidence.truncated, (value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        value.type !== 'session_meta' ||
        !('payload' in value) ||
        typeof value.payload !== 'object' ||
        value.payload === null
      ) {
        return false;
      }
      const payload = value.payload;
      return Boolean(
        'id' in payload &&
        payload.id === options.providerSessionId &&
        'cwd' in payload &&
        payload.cwd === options.selected.cwd
      );
    });
    if (!inspection.ok) return inspection;
    // Retrospectively bracket the accepted leaf's post-close snapshot with
    // every previously scanned newer subtree. This is bounded by the same
    // global directory-entry budget and never reopens an evidence candidate.
    if (!(await revalidateRetainedDirectoryEpochs(retainedNewerEpochs))) {
      return unsafeEvidenceFile();
    }
    return {
      ok: true,
      provider: options.provider,
      providerSessionId: options.providerSessionId,
      evidencePath: evidence.canonicalPath
    };
  }
  return undefined;
}

async function verifyClaudeSessionEvidence(
  root: string,
  options: VerifyProviderSessionEvidenceOptions,
  testOptions: ProviderSessionEvidenceTestOptions
): Promise<ProviderSessionEvidenceResult> {
  const rootLookup = await openProviderRoot(root, testOptions);
  if (!rootLookup.ok) return rootLookup;
  return useTrustedDirectory(rootLookup.directory, async () => {
    const projectsLookup = await openExactChildDirectory(
      rootLookup.directory,
      'projects',
      testOptions
    );
    if (!projectsLookup.ok) return projectsLookup;
    return useTrustedDirectory(projectsLookup.directory, async () => {
      const projectLookup = await openExactChildDirectory(
        projectsLookup.directory,
        claudeProjectDirName(options.selected.cwd),
        testOptions
      );
      if (!projectLookup.ok) return projectLookup;
      return useTrustedDirectory(projectLookup.directory, async () => {
        const candidate = await lookupEvidenceCandidate(
          projectLookup.directory,
          `${options.providerSessionId}.jsonl`,
          true
        );
        if (!candidate.ok) return candidate;
        const evidence = await readValidatedEvidence(
          candidate.candidate,
          options.notBeforeMs,
          testOptions
        );
        if (!evidence.ok) return evidence;
        const inspection = inspectBoundedJsonl(evidence.content, evidence.truncated, (value) =>
          Boolean(
            typeof value === 'object' &&
            value !== null &&
            'sessionId' in value &&
            value.sessionId === options.providerSessionId &&
            'cwd' in value &&
            value.cwd === options.selected.cwd
          )
        );
        if (!inspection.ok) return inspection;
        return {
          ok: true,
          provider: options.provider,
          providerSessionId: options.providerSessionId,
          evidencePath: evidence.canonicalPath
        };
      });
    });
  });
}

interface ResolvedProviderSessionEvidenceRequest {
  options: VerifyProviderSessionEvidenceOptions;
  root: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    return false;
  }
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    isAbsolute(value)
  );
}

function readProviderSessionEvidenceRequest(
  value: unknown
): ResolvedProviderSessionEvidenceRequest | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    if (
      !hasOwn(value, 'provider') ||
      !hasOwn(value, 'providerSessionId') ||
      !hasOwn(value, 'selected') ||
      !hasOwn(value, 'homeDir') ||
      !hasOwn(value, 'notBeforeMs')
    ) {
      return undefined;
    }

    const provider = value.provider;
    const providerSessionId = value.providerSessionId;
    const selectedValue = value.selected;
    const homeDir = value.homeDir;
    const notBeforeMs = value.notBeforeMs;
    if (
      (provider !== 'codex' && provider !== 'claude') ||
      typeof providerSessionId !== 'string' ||
      !isValidProviderSessionId(provider, providerSessionId) ||
      !isPlainRecord(selectedValue) ||
      !hasOwn(selectedValue, 'cwd') ||
      !isSafeAbsolutePath(homeDir) ||
      typeof notBeforeMs !== 'number' ||
      !Number.isFinite(notBeforeMs) ||
      notBeforeMs < 0 ||
      notBeforeMs > Number.MAX_SAFE_INTEGER
    ) {
      return undefined;
    }

    const cwd = selectedValue.cwd;
    if (!isSafeAbsolutePath(cwd)) return undefined;
    let profileId: string | undefined;
    if (hasOwn(selectedValue, 'profileId')) {
      const selectedProfileId = selectedValue.profileId;
      if (typeof selectedProfileId !== 'string' || !isValidProfileId(selectedProfileId)) {
        return undefined;
      }
      profileId = selectedProfileId;
    }

    const selected =
      profileId === undefined ? { cwd } : { cwd, profileId };
    const options: VerifyProviderSessionEvidenceOptions = {
      provider,
      providerSessionId,
      selected,
      homeDir,
      notBeforeMs
    };
    const root =
      profileId === undefined
        ? join(homeDir, provider === 'codex' ? '.codex' : '.claude')
        : profileRoot(profileId, homeDir);
    return { options, root };
  } catch {
    return undefined;
  }
}

/** Validate untrusted runtime input and return only typed evidence outcomes. */
export function verifyProviderSessionEvidence(
  options: VerifyProviderSessionEvidenceOptions,
  testOptions?: ProviderSessionEvidenceTestOptions
): Promise<ProviderSessionEvidenceResult>;
export async function verifyProviderSessionEvidence(
  input: unknown,
  testOptions: ProviderSessionEvidenceTestOptions = {}
): Promise<ProviderSessionEvidenceResult> {
  const request = readProviderSessionEvidenceRequest(input);
  if (request === undefined) return invalidEvidenceRequest();
  const { options, root } = request;

  if (options.provider === 'claude') {
    return verifyClaudeSessionEvidence(root, options, testOptions);
  }

  const requestedDirectoryLimit = testOptions.limits?.maxDirectoryEntries;
  const maxDirectoryEntries =
    requestedDirectoryLimit !== undefined &&
    Number.isSafeInteger(requestedDirectoryLimit) &&
    requestedDirectoryLimit > 0
      ? Math.min(PROVIDER_EVIDENCE_MAX_DIRECTORY_ENTRIES, requestedDirectoryLimit)
      : PROVIDER_EVIDENCE_MAX_DIRECTORY_ENTRIES;
  const directoryBudget: DirectoryEntryBudget = {
    remaining: maxDirectoryEntries,
    exhausted: false
  };
  const retainedNewerEpochs: RetainedDirectoryEpoch[] = [];
  const rootLookup = await openProviderRoot(root, testOptions);
  if (!rootLookup.ok) return rootLookup;
  const trustedRoot = rootLookup.directory;

  const discovery = await useTrustedDirectory(trustedRoot, async () => {
    const sessionsLookup = await openExactChildDirectory(
      trustedRoot,
      'sessions',
      testOptions
    );
    if (!sessionsLookup.ok) return sessionsLookup;
    return useTrustedDirectory(sessionsLookup.directory, () =>
      scanCodexHierarchy(
        sessionsLookup.directory,
        [],
        options,
        directoryBudget,
        retainedNewerEpochs,
        testOptions
      )
    );
  });
  return discovery ?? evidenceNotFound();
}
