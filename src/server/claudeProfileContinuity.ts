import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { SessionSpec } from '../core/types.js';
import { profileRoot } from '../shared/agentProfiles.js';
import { withFileLockSync } from '../shared/fileLock.js';
import {
  recordClaudeProfileMemorySyncFailure,
  syncClaudeProfileMemory,
  type ClaudeMemoryConflict,
  type SyncClaudeProfileMemoryOptions,
  type SyncClaudeProfileMemoryResult
} from './claudeProfileMemory.js';

export interface ClaudeSessionHandoffOptions {
  sourceRoot: string;
  targetRoot: string;
  storeRoot: string;
  cwd: string;
  providerSessionId: string;
  sourceProfileId: string;
  targetProfileId: string;
  retainRollbackState?: boolean;
}

export interface ClaudeSessionHandoffResult {
  generationId: string;
  relativePaths: string[];
}

export interface ClaudeSessionStartOptions {
  homeDir: string;
  profileRoot?: string;
  profileId?: string;
  storeRoot?: string;
  cwd: string;
  providerSessionId: string;
  deskSessionId?: string;
}

export interface ClaudeSessionStartResult {
  managed: boolean;
  generationId?: string;
}

export interface ConfirmClaudeSessionStartOptions {
  homeDir: string;
  storeRoot?: string;
  deskSessionId: string;
  providerSessionId: string;
}

export type ConfirmClaudeSessionStartResult =
  | { ok: true; managed: false }
  | { ok: true; managed: true; generationId: string }
  | {
      ok: false;
      code: 'continuity-resume-unconfirmed' | 'continuity-store-corrupt';
      error: string;
    };

interface LifecycleResult {
  ok: boolean;
  error?: string;
}

export interface ExecuteClaudeProfileHandoffOptions {
  oldSpec: SessionSpec;
  newSpec: SessionSpec;
  homeDir: string;
  storeRoot?: string;
  memoryStoreRoot?: string;
  wasRunning: boolean;
  retire: () => Promise<LifecycleResult>;
  commit: () => void | Promise<void>;
  startTarget: () => Promise<LifecycleResult>;
  restoreSource: () => Promise<LifecycleResult>;
  syncMemory?: (
    options: SyncClaudeProfileMemoryOptions
  ) => SyncClaudeProfileMemoryResult;
  onPrepared?: (result: ClaudeSessionHandoffResult) => void;
}

export interface ExecuteClaudeProfileHandoffResult {
  ok: boolean;
  committed: boolean;
  error?: string;
  memoryConflicts?: ClaudeMemoryConflict[];
  memoryWarnings?: string[];
}

export type ClaudeContinuityErrorCode =
  | 'continuity-no-resume-id'
  | 'continuity-missing-transcript'
  | 'continuity-session-conflict'
  | 'continuity-unknown-artifact'
  | 'continuity-unsafe-file'
  | 'continuity-cross-device'
  | 'continuity-no-space'
  | 'continuity-store-corrupt'
  | 'continuity-resume-unconfirmed';

interface ClaudeGenerationArtifact {
  relativePath: string;
  mode: number;
  size: number;
  sha256: string;
}

interface ClaudeGenerationRecord {
  policyVersion: 1;
  generationId: string;
  providerSessionId: string;
  projectSlug: string;
  sourceProfileId: string;
  targetProfileId: string;
  artifacts: ClaudeGenerationArtifact[];
}

interface ClaudeLinkPlan {
  relativePath: string;
  destination: 'store' | 'target';
  existed: boolean;
  originalDev?: string;
  originalIno?: string;
}

interface ClaudeHandoffJournal {
  policyVersion: 1;
  generationId: string;
  providerSessionId: string;
  projectSlug: string;
  sourceProfileId: string;
  targetProfileId: string;
  previousGenerationId?: string;
  phase: 'preparing' | 'prepared' | 'committed' | 'rolled-back';
  links: ClaudeLinkPlan[];
}

interface ClaudeActivationRecord {
  policyVersion: 1;
  generationId: string;
  deskSessionId: string;
  providerSessionId: string;
  sourceProfileId: string;
  targetProfileId: string;
  projectSlug: string;
  state: 'starting-unconfirmed' | 'ready' | 'needs-attention';
  errorCode?: 'continuity-resume-unconfirmed' | 'continuity-store-corrupt';
  observedProviderSessionId?: string;
}

export class ClaudeContinuityError extends Error {
  constructor(
    readonly code: ClaudeContinuityErrorCode,
    message: string,
    readonly relativePath?: string
  ) {
    super(message);
    this.name = 'ClaudeContinuityError';
  }
}

export function isClaudeProfileChange(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): boolean {
  return Boolean(
    oldSpec &&
      newSpec &&
      oldSpec.agent === 'claude' &&
      newSpec.agent === 'claude' &&
      oldSpec.profileId !== newSpec.profileId
  );
}

export function requiresClaudeProfileHandoff(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): boolean {
  return Boolean(
    isClaudeProfileChange(oldSpec, newSpec) &&
      oldSpec &&
      newSpec &&
      oldSpec.resume &&
      oldSpec.resume === newSpec.resume
  );
}

function claudeConfigRoot(homeDir: string, profileId: string | undefined): string {
  return profileId === undefined ? join(homeDir, '.claude') : profileRoot(profileId, homeDir);
}

function errorMessage(error: unknown): string {
  if (error instanceof ClaudeContinuityError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function restoreAfterPrecommitFailure(
  options: ExecuteClaudeProfileHandoffOptions,
  error: unknown
): Promise<ExecuteClaudeProfileHandoffResult> {
  const message = errorMessage(error);
  if (!options.wasRunning) {
    return { ok: false, committed: false, error: message };
  }
  const restored = await options.restoreSource();
  if (!restored.ok) {
    return {
      ok: false,
      committed: false,
      error: `${message}; source restart failed: ${restored.error ?? 'unknown error'}`
    };
  }
  return { ok: false, committed: false, error: message };
}

export async function executeClaudeProfileHandoff(
  options: ExecuteClaudeProfileHandoffOptions
): Promise<ExecuteClaudeProfileHandoffResult> {
  if (!requiresClaudeProfileHandoff(options.oldSpec, options.newSpec)) {
    return { ok: false, committed: false, error: 'not a same-conversation Claude profile change' };
  }
  if (options.wasRunning) {
    const retired = await options.retire();
    if (!retired.ok) {
      return { ok: false, committed: false, error: retired.error ?? 'session retire failed' };
    }
  }
  const memoryConflicts: ClaudeMemoryConflict[] = [];
  const memoryWarnings: string[] = [];
  const syncMemory = options.syncMemory ?? syncClaudeProfileMemory;
  for (const [label, profileId] of [
    ['source', options.oldSpec.profileId],
    ['target', options.newSpec.profileId]
  ] as const) {
    try {
      const result = syncMemory({
        homeDir: options.homeDir,
        ...(options.memoryStoreRoot === undefined
          ? {}
          : { storeRoot: options.memoryStoreRoot }),
        profileId,
        cwd: options.oldSpec.cwd
      });
      memoryConflicts.push(...result.conflicts);
    } catch (error) {
      if (options.syncMemory === undefined) {
        try {
          recordClaudeProfileMemorySyncFailure(
            {
              homeDir: options.homeDir,
              ...(options.memoryStoreRoot === undefined
                ? {}
                : { storeRoot: options.memoryStoreRoot }),
              profileId,
              cwd: options.oldSpec.cwd
            },
            error
          );
        } catch {
          // Transcript handoff remains independent from diagnostic persistence.
        }
      }
      memoryWarnings.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const withMemoryDiagnostics = (
    result: ExecuteClaudeProfileHandoffResult
  ): ExecuteClaudeProfileHandoffResult => ({
    ...result,
    ...(memoryConflicts.length === 0 ? {} : { memoryConflicts }),
    ...(memoryWarnings.length === 0 ? {} : { memoryWarnings })
  });
  const storageOptions: ClaudeSessionHandoffOptions = {
    sourceRoot: claudeConfigRoot(options.homeDir, options.oldSpec.profileId),
    targetRoot: claudeConfigRoot(options.homeDir, options.newSpec.profileId),
    storeRoot:
      options.storeRoot ?? join(options.homeDir, '.config', 'desk', 'continuity', 'claude'),
    cwd: options.oldSpec.cwd,
    providerSessionId: options.oldSpec.resume!,
    sourceProfileId: options.oldSpec.profileId ?? 'ambient',
    targetProfileId: options.newSpec.profileId ?? 'ambient',
    retainRollbackState: true
  };
  let prepared: ClaudeSessionHandoffResult;
  try {
    prepared = prepareClaudeSessionHandoff(storageOptions);
  } catch (error) {
    return withMemoryDiagnostics(await restoreAfterPrecommitFailure(options, error));
  }
  try {
    options.onPrepared?.(prepared);
    await options.commit();
  } catch (error) {
    let failure = error;
    try {
      rollbackClaudeSessionHandoff(storageOptions, prepared.generationId);
    } catch (rollbackError) {
      failure = new ClaudeContinuityError(
        'continuity-store-corrupt',
        `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`
      );
    }
    return withMemoryDiagnostics(await restoreAfterPrecommitFailure(options, failure));
  }
  let finalizeError: unknown;
  try {
    finalizeClaudeSessionHandoff(storageOptions, prepared.generationId);
  } catch (error) {
    finalizeError = error;
  }
  if (!options.wasRunning) {
    return withMemoryDiagnostics(
      finalizeError === undefined
        ? { ok: true, committed: true }
        : { ok: false, committed: true, error: errorMessage(finalizeError) }
    );
  }
  const started = await options.startTarget();
  return withMemoryDiagnostics(
    !started.ok
      ? { ok: false, committed: true, error: started.error ?? 'target session start failed' }
      : finalizeError === undefined
        ? { ok: true, committed: true }
        : { ok: false, committed: true, error: errorMessage(finalizeError) }
  );
}

function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]/g, '-');
}

function assertInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '') {
    throw new Error(`continuity path escapes its root: ${path}`);
  }
}

function collectRegularFiles(root: string, path: string, output: string[]): void {
  if (!existsSync(path)) {
    return;
  }
  assertInside(root, path);
  if (basename(path) === '.lock') {
    return;
  }
  const stat = lstatSync(path);
  if (stat.isFile()) {
    output.push(relative(root, path));
    return;
  }
  if (!stat.isDirectory()) {
    const relativePath = relative(root, path);
    throw new ClaudeContinuityError(
      'continuity-unsafe-file',
      `continuity session artifact is not a regular file or directory: ${relativePath}`,
      relativePath
    );
  }
  for (const entry of readdirSync(path)) {
    collectRegularFiles(root, join(path, entry), output);
  }
}

function filesEqual(left: string, right: string): boolean {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
    return true;
  }
  if (leftStat.size !== rightStat.size) {
    return false;
  }
  const leftFd = openSync(left, 'r');
  const rightFd = openSync(right, 'r');
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let offset = 0;
    while (offset < leftStat.size) {
      const length = Math.min(leftBuffer.length, leftStat.size - offset);
      const leftRead = readSync(leftFd, leftBuffer, 0, length, offset);
      const rightRead = readSync(rightFd, rightBuffer, 0, length, offset);
      if (leftRead !== rightRead || !leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) {
        return false;
      }
      offset += leftRead;
    }
    return true;
  } finally {
    closeSync(leftFd);
    closeSync(rightFd);
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let offset = 0;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw new Error(`continuity control record write made no progress: ${path}`);
      }
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

function syncDestinationDirectories(root: string, paths: readonly string[]): void {
  const directories = new Set<string>([resolve(root)]);
  for (const path of paths) {
    let current = resolve(dirname(path));
    const rootPath = resolve(root);
    while (current === rootPath || current.startsWith(`${rootPath}${sep}`)) {
      directories.add(current);
      if (current === rootPath) {
        break;
      }
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    fsyncDirectory(directory);
  }
  const parent = dirname(resolve(root));
  if (existsSync(parent)) {
    fsyncDirectory(parent);
  }
}

function parseCurrentGenerationId(sessionRoot: string): string | undefined {
  const path = join(sessionRoot, 'generation.json');
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { generationId?: unknown };
    return typeof parsed.generationId === 'string' ? parsed.generationId : undefined;
  } catch {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity generation record is unreadable for ${basename(sessionRoot)}`
    );
  }
}

function linkDestination(
  options: ClaudeSessionHandoffOptions,
  relativePath: string,
  destination: ClaudeLinkPlan['destination']
): string {
  return destination === 'target'
    ? join(options.targetRoot, relativePath)
    : join(options.storeRoot, 'sessions', options.providerSessionId, 'files', relativePath);
}

function buildLinkPlan(
  options: ClaudeSessionHandoffOptions,
  relativePath: string,
  destination: ClaudeLinkPlan['destination']
): ClaudeLinkPlan {
  const path = linkDestination(options, relativePath, destination);
  if (!existsSync(path)) {
    return { relativePath, destination, existed: false };
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new ClaudeContinuityError(
      'continuity-unsafe-file',
      `continuity ${destination} is not a regular file: ${relativePath}`,
      relativePath
    );
  }
  return {
    relativePath,
    destination,
    existed: true,
    originalDev: String(stat.dev),
    originalIno: String(stat.ino)
  };
}

function backupPath(
  sessionRoot: string,
  generationId: string,
  plan: ClaudeLinkPlan
): string {
  return join(sessionRoot, 'backups', generationId, plan.destination, plan.relativePath);
}

function createLinkBackups(
  options: ClaudeSessionHandoffOptions,
  sessionRoot: string,
  generationId: string,
  plans: readonly ClaudeLinkPlan[]
): string[] {
  const created: string[] = [];
  for (const plan of plans) {
    if (!plan.existed) {
      continue;
    }
    const destination = linkDestination(options, plan.relativePath, plan.destination);
    const stat = lstatSync(destination);
    if (!stat.isFile()) {
      throw new ClaudeContinuityError(
        'continuity-unsafe-file',
        `continuity ${plan.destination} is not a regular file: ${plan.relativePath}`,
        plan.relativePath
      );
    }
    const backup = backupPath(sessionRoot, generationId, plan);
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    try {
      linkSync(destination, backup);
    } catch (error) {
      mapLinkError(error, plan.relativePath);
    }
    created.push(backup);
  }
  return created;
}

function rollbackLinkPlans(
  options: ClaudeSessionHandoffOptions,
  sessionRoot: string,
  generationId: string,
  plans: readonly ClaudeLinkPlan[]
): void {
  const failures: string[] = [];
  for (const plan of [...plans].reverse()) {
    const destination = linkDestination(options, plan.relativePath, plan.destination);
    const backup = backupPath(sessionRoot, generationId, plan);
    try {
      if (!plan.existed) {
        rmSync(destination, { force: true });
      } else if (existsSync(backup)) {
        replaceWithHardlink(backup, destination, plan.relativePath);
      } else {
        const stat = lstatSync(destination);
        if (
          !stat.isFile() ||
          plan.originalDev === undefined ||
          plan.originalIno === undefined ||
          String(stat.dev) !== plan.originalDev ||
          String(stat.ino) !== plan.originalIno
        ) {
          throw new ClaudeContinuityError(
            'continuity-store-corrupt',
            `continuity backup is missing for a changed ${plan.destination}: ${plan.relativePath}`,
            plan.relativePath
          );
        }
      }
    } catch (error) {
      failures.push(`${plan.destination}:${plan.relativePath}: ${errorMessage(error)}`);
    }
  }
  rmSync(join(sessionRoot, 'backups', generationId), { recursive: true, force: true });
  if (failures.length > 0) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity rollback failed: ${failures.join('; ')}`
    );
  }
}

function readControlRecord(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('record is not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity control record is unreadable: ${basename(path)} (${errorMessage(error)})`
    );
  }
}

function readHandoffJournal(path: string, options: ClaudeSessionHandoffOptions): ClaudeHandoffJournal {
  const record = readControlRecord(path);
  const phases = new Set(['preparing', 'prepared', 'committed', 'rolled-back']);
  if (
    record.policyVersion !== 1 ||
    record.providerSessionId !== options.providerSessionId ||
    typeof record.generationId !== 'string' ||
    typeof record.projectSlug !== 'string' ||
    typeof record.sourceProfileId !== 'string' ||
    typeof record.targetProfileId !== 'string' ||
    typeof record.phase !== 'string' ||
    !phases.has(record.phase) ||
    !Array.isArray(record.links)
  ) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity journal is invalid for ${options.providerSessionId}`
    );
  }
  const links = record.links.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `continuity journal contains an invalid link plan for ${options.providerSessionId}`
      );
    }
    const link = value as Record<string, unknown>;
    if (
      typeof link.relativePath !== 'string' ||
      (link.destination !== 'store' && link.destination !== 'target') ||
      typeof link.existed !== 'boolean' ||
      (link.originalDev !== undefined && typeof link.originalDev !== 'string') ||
      (link.originalIno !== undefined && typeof link.originalIno !== 'string')
    ) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `continuity journal contains an invalid link plan for ${options.providerSessionId}`
      );
    }
    const plan: ClaudeLinkPlan = {
      relativePath: link.relativePath,
      destination: link.destination,
      existed: link.existed,
      originalDev: link.originalDev,
      originalIno: link.originalIno
    };
    assertInside(
      plan.destination === 'target'
        ? options.targetRoot
        : join(options.storeRoot, 'sessions', options.providerSessionId, 'files'),
      linkDestination(options, plan.relativePath, plan.destination)
    );
    return plan;
  });
  return {
    policyVersion: 1,
    generationId: record.generationId,
    providerSessionId: options.providerSessionId,
    projectSlug: record.projectSlug,
    sourceProfileId: record.sourceProfileId,
    targetProfileId: record.targetProfileId,
    previousGenerationId:
      typeof record.previousGenerationId === 'string' ? record.previousGenerationId : undefined,
    phase: record.phase as ClaudeHandoffJournal['phase'],
    links
  };
}

function restorePreviousControlRecords(
  options: ClaudeSessionHandoffOptions,
  sessionRoot: string,
  journal: ClaudeHandoffJournal
): void {
  const generationPath = join(sessionRoot, 'generation.json');
  const commitPath = join(sessionRoot, 'commit.json');
  if (!journal.previousGenerationId) {
    rmSync(generationPath, { force: true });
    rmSync(commitPath, { force: true });
    fsyncDirectory(sessionRoot);
    return;
  }
  const previousPath = join(
    sessionRoot,
    'generations',
    `${journal.previousGenerationId}.json`
  );
  if (!existsSync(previousPath)) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `previous continuity generation is missing: ${journal.previousGenerationId}`
    );
  }
  durableWriteJson(generationPath, readControlRecord(previousPath));
  durableWriteJson(commitPath, {
    policyVersion: 1,
    generationId: journal.previousGenerationId,
    providerSessionId: options.providerSessionId
  });
}

function validateCommittedLinks(
  options: ClaudeSessionHandoffOptions,
  sessionRoot: string,
  journal: ClaudeHandoffJournal
): void {
  const generationRecordPath = join(
    sessionRoot,
    'generations',
    `${journal.generationId}.json`
  );
  if (!existsSync(generationRecordPath)) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `committed continuity generation is missing: ${journal.generationId}`
    );
  }
  const generation = readControlRecord(generationRecordPath);
  if (
    generation.generationId !== journal.generationId ||
    !Array.isArray(generation.artifacts)
  ) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `committed continuity generation is invalid: ${journal.generationId}`
    );
  }
  for (const value of generation.artifacts) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `committed continuity generation has an invalid artifact: ${journal.generationId}`
      );
    }
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.relativePath !== 'string' || typeof artifact.size !== 'number') {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `committed continuity generation has an invalid artifact: ${journal.generationId}`
      );
    }
    const store = linkDestination(options, artifact.relativePath, 'store');
    const target = linkDestination(options, artifact.relativePath, 'target');
    if (!existsSync(store) || !existsSync(target)) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `committed continuity artifact is missing: ${artifact.relativePath}`,
        artifact.relativePath
      );
    }
    const storeStat = lstatSync(store);
    const targetStat = lstatSync(target);
    if (
      !storeStat.isFile() ||
      !targetStat.isFile() ||
      storeStat.size !== artifact.size ||
      targetStat.size !== artifact.size ||
      storeStat.dev !== targetStat.dev ||
      storeStat.ino !== targetStat.ino
    ) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `committed continuity artifact does not match its generation: ${artifact.relativePath}`,
        artifact.relativePath
      );
    }
  }
}

function recoveryOptionsForJournal(
  options: ClaudeSessionHandoffOptions,
  journal: ClaudeHandoffJournal
): ClaudeSessionHandoffOptions {
  if (journal.targetProfileId === options.targetProfileId) {
    return options;
  }
  if (journal.targetProfileId === options.sourceProfileId) {
    return { ...options, targetRoot: options.sourceRoot };
  }
  throw new ClaudeContinuityError(
    'continuity-store-corrupt',
    `cannot resolve target profile ${journal.targetProfileId} for interrupted generation ${journal.generationId}`
  );
}

function recoverInterruptedHandoff(
  options: ClaudeSessionHandoffOptions,
  sessionRoot: string
): void {
  const journalPath = join(sessionRoot, 'journal.json');
  if (!existsSync(journalPath)) {
    return;
  }
  const journal = readHandoffJournal(journalPath, options);
  const recoveryOptions = recoveryOptionsForJournal(options, journal);
  if (journal.phase === 'rolled-back') {
    rmSync(join(sessionRoot, 'backups', journal.generationId), {
      recursive: true,
      force: true
    });
    return;
  }
  const commitPath = join(sessionRoot, 'commit.json');
  const commit = existsSync(commitPath) ? readControlRecord(commitPath) : undefined;
  if (commit?.generationId === journal.generationId) {
    const immutableGenerationPath = join(
      sessionRoot,
      'generations',
      `${journal.generationId}.json`
    );
    if (!existsSync(immutableGenerationPath)) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `committed continuity generation is missing: ${journal.generationId}`
      );
    }
    if (journal.phase !== 'committed') {
      validateCommittedLinks(recoveryOptions, sessionRoot, journal);
      durableWriteJson(
        join(sessionRoot, 'generation.json'),
        readControlRecord(immutableGenerationPath)
      );
      durableWriteJson(journalPath, { ...journal, phase: 'committed' });
    }
    rmSync(join(sessionRoot, 'backups', journal.generationId), {
      recursive: true,
      force: true
    });
    fsyncDirectory(sessionRoot);
    return;
  }
  if (journal.phase === 'committed') {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity commit marker does not match generation ${journal.generationId}`
    );
  }
  if (
    commit !== undefined &&
    commit.generationId !== journal.previousGenerationId
  ) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity commit marker is unrelated to interrupted generation ${journal.generationId}`
    );
  }
  rollbackLinkPlans(recoveryOptions, sessionRoot, journal.generationId, journal.links);
  rmSync(join(sessionRoot, 'generations', `${journal.generationId}.json`), {
    force: true
  });
  restorePreviousControlRecords(options, sessionRoot, journal);
  durableWriteJson(journalPath, { ...journal, phase: 'rolled-back' });
}

function mapLinkError(error: unknown, relativePath: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EXDEV') {
    throw new ClaudeContinuityError(
      'continuity-cross-device',
      `continuity requires source, target, and store on one filesystem: ${relativePath}`,
      relativePath
    );
  }
  if (code === 'ENOSPC') {
    throw new ClaudeContinuityError(
      'continuity-no-space',
      `continuity could not allocate a directory entry: ${relativePath}`,
      relativePath
    );
  }
  throw error;
}

function replaceWithHardlink(source: string, target: string, relativePath: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target)) {
    const sourceStat = statSync(source);
    const targetStat = lstatSync(target);
    if (!targetStat.isFile()) {
      throw new ClaudeContinuityError(
        'continuity-unsafe-file',
        `continuity target is not a regular file: ${relativePath}`,
        relativePath
      );
    }
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
      return;
    }
    const temporary = `${target}.desk-link-${process.pid}-${randomUUID()}`;
    try {
      linkSync(source, temporary);
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      mapLinkError(error, relativePath);
    }
    return;
  }
  try {
    linkSync(source, target);
  } catch (error) {
    mapLinkError(error, relativePath);
  }
}

function assertKnownCompanionEntries(
  root: string,
  companionRoot: string,
  allowed: ReadonlySet<string>
): void {
  if (!existsSync(companionRoot)) {
    return;
  }
  const stat = lstatSync(companionRoot);
  if (!stat.isDirectory()) {
    const relativePath = relative(root, companionRoot);
    throw new ClaudeContinuityError(
      'continuity-unsafe-file',
      `continuity companion root is not a directory: ${relativePath}`,
      relativePath
    );
  }
  for (const entry of readdirSync(companionRoot)) {
    if (!allowed.has(entry)) {
      const relativePath = relative(root, join(companionRoot, entry));
      throw new ClaudeContinuityError(
        'continuity-unknown-artifact',
        `unknown Claude session artifact: ${relativePath}`,
        relativePath
      );
    }
  }
}

function collectSessionEnvelope(
  root: string,
  projectSlug: string,
  providerSessionId: string,
  requireTranscript: boolean
): string[] {
  const projectRoot = join(root, 'projects', projectSlug);
  const companionRoot = join(projectRoot, providerSessionId);
  const transcript = join(projectRoot, `${providerSessionId}.jsonl`);
  const relativePaths: string[] = [];
  if (requireTranscript && !existsSync(transcript)) {
    throw new ClaudeContinuityError(
      'continuity-missing-transcript',
      `Claude transcript is missing for ${providerSessionId}`
    );
  }
  const allowedCompanionDirectories = ['subagents', 'tool-results', 'workflows'] as const;
  assertKnownCompanionEntries(root, companionRoot, new Set(allowedCompanionDirectories));
  collectRegularFiles(root, transcript, relativePaths);
  for (const directory of allowedCompanionDirectories) {
    collectRegularFiles(root, join(companionRoot, directory), relativePaths);
  }
  collectRegularFiles(root, join(root, 'file-history', providerSessionId), relativePaths);
  collectRegularFiles(root, join(root, 'tasks', providerSessionId), relativePaths);
  return relativePaths;
}

function storedProfileId(profileId: string | undefined): string {
  return profileId ?? 'ambient';
}

function readGenerationRecord(path: string): ClaudeGenerationRecord {
  const record = readControlRecord(path);
  if (
    record.policyVersion !== 1 ||
    typeof record.generationId !== 'string' ||
    typeof record.providerSessionId !== 'string' ||
    typeof record.projectSlug !== 'string' ||
    typeof record.sourceProfileId !== 'string' ||
    typeof record.targetProfileId !== 'string' ||
    !Array.isArray(record.artifacts)
  ) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity generation record is invalid: ${basename(path)}`
    );
  }
  const artifacts = record.artifacts.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `continuity generation has an invalid artifact: ${record.generationId}`
      );
    }
    const artifact = value as Record<string, unknown>;
    if (
      typeof artifact.relativePath !== 'string' ||
      typeof artifact.mode !== 'number' ||
      typeof artifact.size !== 'number' ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `continuity generation has an invalid artifact: ${record.generationId}`
      );
    }
    return {
      relativePath: artifact.relativePath,
      mode: artifact.mode,
      size: artifact.size,
      sha256: artifact.sha256
    };
  });
  return {
    policyVersion: 1,
    generationId: record.generationId,
    providerSessionId: record.providerSessionId,
    projectSlug: record.projectSlug,
    sourceProfileId: record.sourceProfileId,
    targetProfileId: record.targetProfileId,
    artifacts
  };
}

function recoverSessionForStart(
  options: ClaudeSessionStartOptions,
  activeRoot: string,
  storeRoot: string,
  sessionRoot: string
): void {
  const journalPath = join(sessionRoot, 'journal.json');
  if (!existsSync(journalPath)) {
    return;
  }
  const header = readControlRecord(journalPath);
  if (
    typeof header.sourceProfileId !== 'string' ||
    typeof header.targetProfileId !== 'string'
  ) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity journal has invalid profile ownership for ${options.providerSessionId}`
    );
  }
  const activeProfileId = storedProfileId(options.profileId);
  const rootFor = (profileId: string): string => {
    if (profileId === activeProfileId) {
      return activeRoot;
    }
    return claudeConfigRoot(
      options.homeDir,
      profileId === 'ambient' ? undefined : profileId
    );
  };
  recoverInterruptedHandoff(
    {
      sourceRoot: rootFor(header.sourceProfileId),
      targetRoot: rootFor(header.targetProfileId),
      storeRoot,
      cwd: options.cwd,
      providerSessionId: options.providerSessionId,
      sourceProfileId: header.sourceProfileId,
      targetProfileId: header.targetProfileId
    },
    sessionRoot
  );
}

function isSafeDeskSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function activationIndexPath(storeRoot: string, deskSessionId: string): string {
  if (!isSafeDeskSessionId(deskSessionId)) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `invalid Desk session id for continuity activation: ${deskSessionId}`
    );
  }
  return join(storeRoot, 'activations', `${deskSessionId}.json`);
}

function writeActivationRecords(
  storeRoot: string,
  generation: ClaudeGenerationRecord,
  deskSessionId: string,
  state: ClaudeActivationRecord['state'],
  details: Pick<
    ClaudeActivationRecord,
    'errorCode' | 'observedProviderSessionId'
  > = {}
): ClaudeActivationRecord {
  const activation: ClaudeActivationRecord = {
    policyVersion: 1,
    generationId: generation.generationId,
    deskSessionId,
    providerSessionId: generation.providerSessionId,
    sourceProfileId: generation.sourceProfileId,
    targetProfileId: generation.targetProfileId,
    projectSlug: generation.projectSlug,
    state,
    ...details
  };
  durableWriteJson(
    join(storeRoot, 'sessions', generation.providerSessionId, 'activation.json'),
    activation
  );
  durableWriteJson(activationIndexPath(storeRoot, deskSessionId), activation);
  return activation;
}

function prepareClaudeSessionStartLocked(
  options: ClaudeSessionStartOptions,
  activeRoot: string,
  storeRoot: string
): ClaudeSessionStartResult {
  const sessionRoot = join(storeRoot, 'sessions', options.providerSessionId);
  if (!existsSync(sessionRoot)) {
    return { managed: false };
  }
  recoverSessionForStart(options, activeRoot, storeRoot, sessionRoot);
  const generationPath = join(sessionRoot, 'generation.json');
  if (!existsSync(generationPath)) {
    return { managed: false };
  }
  const generation = readGenerationRecord(generationPath);
  const activeProfileId = storedProfileId(options.profileId);
  const projectSlug = claudeProjectDirName(options.cwd);
  if (
    generation.providerSessionId !== options.providerSessionId ||
    generation.projectSlug !== projectSlug ||
    generation.targetProfileId !== activeProfileId
  ) {
    throw new ClaudeContinuityError(
      'continuity-session-conflict',
      `continuity generation ${generation.generationId} belongs to ${generation.targetProfileId}/${generation.projectSlug}`
    );
  }
  const commit = readControlRecord(join(sessionRoot, 'commit.json'));
  if (commit.generationId !== generation.generationId) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity commit marker does not match generation ${generation.generationId}`
    );
  }

  const expectedPaths = new Set(generation.artifacts.map((artifact) => artifact.relativePath));
  let refreshGeneration = false;
  const materialized: string[] = [];
  for (const artifact of generation.artifacts) {
    const store = join(sessionRoot, 'files', artifact.relativePath);
    const target = join(activeRoot, artifact.relativePath);
    assertInside(join(sessionRoot, 'files'), store);
    assertInside(activeRoot, target);
    const storeExists = existsSync(store);
    const targetExists = existsSync(target);
    if (!storeExists && !targetExists) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `continuity artifact is missing from store and active profile: ${artifact.relativePath}`,
        artifact.relativePath
      );
    }
    if (!targetExists) {
      const storeStat = lstatSync(store);
      if (!storeStat.isFile()) {
        throw new ClaudeContinuityError(
          'continuity-store-corrupt',
          `continuity store artifact is not a regular file: ${artifact.relativePath}`,
          artifact.relativePath
        );
      }
      replaceWithHardlink(store, target, artifact.relativePath);
      materialized.push(target);
      continue;
    }
    const targetStat = lstatSync(target);
    if (!targetStat.isFile()) {
      throw new ClaudeContinuityError(
        'continuity-unsafe-file',
        `active Claude session artifact is not a regular file: ${artifact.relativePath}`,
        artifact.relativePath
      );
    }
    if (!storeExists) {
      refreshGeneration = true;
      continue;
    }
    const storeStat = lstatSync(store);
    if (
      !storeStat.isFile() ||
      storeStat.dev !== targetStat.dev ||
      storeStat.ino !== targetStat.ino
    ) {
      refreshGeneration = true;
    }
  }
  if (materialized.length > 0) {
    syncDestinationDirectories(activeRoot, materialized);
  }
  const activePaths = collectSessionEnvelope(
    activeRoot,
    projectSlug,
    options.providerSessionId,
    true
  ).sort();
  if (
    activePaths.length !== expectedPaths.size ||
    activePaths.some((relativePath) => !expectedPaths.has(relativePath))
  ) {
    refreshGeneration = true;
  }
  let activeGeneration = generation;
  if (refreshGeneration) {
    prepareClaudeSessionHandoffLocked({
      sourceRoot: activeRoot,
      targetRoot: activeRoot,
      storeRoot,
      cwd: options.cwd,
      providerSessionId: options.providerSessionId,
      sourceProfileId: activeProfileId,
      targetProfileId: activeProfileId
    });
    activeGeneration = readGenerationRecord(generationPath);
  }
  if (options.deskSessionId) {
    writeActivationRecords(
      storeRoot,
      activeGeneration,
      options.deskSessionId,
      'starting-unconfirmed'
    );
  }
  return { managed: true, generationId: activeGeneration.generationId };
}

function prepareClaudeSessionHandoffLocked(
  options: ClaudeSessionHandoffOptions
): ClaudeSessionHandoffResult {
  const sessionRoot = join(options.storeRoot, 'sessions', options.providerSessionId);
  recoverInterruptedHandoff(options, sessionRoot);
  const projectSlug = claudeProjectDirName(options.cwd);
  const relativePaths = collectSessionEnvelope(
    options.sourceRoot,
    projectSlug,
    options.providerSessionId,
    true
  ).sort();
  const targetRelativePaths = collectSessionEnvelope(
    options.targetRoot,
    projectSlug,
    options.providerSessionId,
    false
  );

  const sourcePaths = new Set(relativePaths);
  for (const relativePath of targetRelativePaths) {
    if (!sourcePaths.has(relativePath)) {
      throw new ClaudeContinuityError(
        'continuity-session-conflict',
        `Claude session artifact exists only in target profile: ${relativePath}`,
        relativePath
      );
    }
  }
  for (const relativePath of relativePaths) {
    const source = join(options.sourceRoot, relativePath);
    const target = join(options.targetRoot, relativePath);
    if (!existsSync(target)) {
      continue;
    }
    const targetStat = lstatSync(target);
    if (!targetStat.isFile()) {
      throw new ClaudeContinuityError(
        'continuity-unsafe-file',
        `continuity target is not a regular file: ${relativePath}`,
        relativePath
      );
    }
    if (!filesEqual(source, target)) {
      throw new ClaudeContinuityError(
        'continuity-session-conflict',
        `Claude session artifact differs in target profile: ${relativePath}`,
        relativePath
      );
    }
  }

  const generationId = randomUUID();
  const generation: ClaudeGenerationRecord = {
    policyVersion: 1,
    generationId,
    providerSessionId: options.providerSessionId,
    projectSlug,
    sourceProfileId: options.sourceProfileId,
    targetProfileId: options.targetProfileId,
    artifacts: relativePaths.map((relativePath) => {
      const source = join(options.sourceRoot, relativePath);
      const stat = statSync(source);
      return {
        relativePath,
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: sha256File(source)
      };
    })
  };
  const links: ClaudeLinkPlan[] = relativePaths.flatMap((relativePath) => [
    buildLinkPlan(options, relativePath, 'store'),
    buildLinkPlan(options, relativePath, 'target')
  ]);
  const journal: ClaudeHandoffJournal = {
    policyVersion: 1,
    generationId,
    providerSessionId: options.providerSessionId,
    projectSlug,
    sourceProfileId: options.sourceProfileId,
    targetProfileId: options.targetProfileId,
    previousGenerationId: parseCurrentGenerationId(sessionRoot),
    phase: 'preparing',
    links
  };
  const journalPath = join(sessionRoot, 'journal.json');
  const commitPath = join(sessionRoot, 'commit.json');
  const generationPath = join(sessionRoot, 'generation.json');
  const immutableGenerationPath = join(sessionRoot, 'generations', `${generationId}.json`);
  const destinations = links.map((plan) =>
    linkDestination(options, plan.relativePath, plan.destination)
  );

  durableWriteJson(journalPath, journal);
  try {
    const backups = createLinkBackups(options, sessionRoot, generationId, links);
    if (backups.length > 0) {
      syncDestinationDirectories(join(sessionRoot, 'backups', generationId), backups);
    }
    for (const relativePath of relativePaths) {
      const source = join(options.sourceRoot, relativePath);
      replaceWithHardlink(
        source,
        linkDestination(options, relativePath, 'store'),
        relativePath
      );
      replaceWithHardlink(
        source,
        linkDestination(options, relativePath, 'target'),
        relativePath
      );
    }
    syncDestinationDirectories(options.targetRoot, destinations.filter((_, index) => index % 2 === 1));
    syncDestinationDirectories(options.storeRoot, destinations.filter((_, index) => index % 2 === 0));
    durableWriteJson(immutableGenerationPath, generation);
    durableWriteJson(journalPath, { ...journal, phase: 'prepared' });
    durableWriteJson(commitPath, {
      policyVersion: 1,
      generationId,
      providerSessionId: options.providerSessionId
    });
    durableWriteJson(generationPath, generation);
    durableWriteJson(journalPath, { ...journal, phase: 'committed' });
    if (!options.retainRollbackState) {
      rmSync(join(sessionRoot, 'backups', generationId), { recursive: true, force: true });
    }
    fsyncDirectory(sessionRoot);
  } catch (error) {
    let rollbackError: unknown;
    try {
      rollbackLinkPlans(options, sessionRoot, generationId, links);
      rmSync(immutableGenerationPath, { force: true });
      restorePreviousControlRecords(options, sessionRoot, journal);
      durableWriteJson(journalPath, { ...journal, phase: 'rolled-back' });
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure;
    }
    if (rollbackError) {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`
      );
    }
    throw error;
  }
  return { generationId, relativePaths };
}

export function prepareClaudeSessionHandoff(
  options: ClaudeSessionHandoffOptions
): ClaudeSessionHandoffResult {
  const lockRoot = join(options.storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return withFileLockSync(
    join(lockRoot, `${options.providerSessionId}.lock`),
    () => prepareClaudeSessionHandoffLocked(options)
  );
}

function finalizeClaudeSessionHandoff(
  options: ClaudeSessionHandoffOptions,
  generationId: string
): void {
  const lockRoot = join(options.storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  withFileLockSync(join(lockRoot, `${options.providerSessionId}.lock`), () => {
    const sessionRoot = join(options.storeRoot, 'sessions', options.providerSessionId);
    const journal = readHandoffJournal(join(sessionRoot, 'journal.json'), options);
    if (journal.generationId !== generationId || journal.phase !== 'committed') {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `cannot finalize continuity generation ${generationId}`
      );
    }
    rmSync(join(sessionRoot, 'backups', generationId), { recursive: true, force: true });
    fsyncDirectory(sessionRoot);
  });
}

function rollbackClaudeSessionHandoff(
  options: ClaudeSessionHandoffOptions,
  generationId: string
): void {
  const lockRoot = join(options.storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  withFileLockSync(join(lockRoot, `${options.providerSessionId}.lock`), () => {
    const sessionRoot = join(options.storeRoot, 'sessions', options.providerSessionId);
    const journalPath = join(sessionRoot, 'journal.json');
    const journal = readHandoffJournal(journalPath, options);
    if (journal.generationId !== generationId || journal.phase !== 'committed') {
      throw new ClaudeContinuityError(
        'continuity-store-corrupt',
        `cannot roll back continuity generation ${generationId}`
      );
    }
    rollbackLinkPlans(options, sessionRoot, generationId, journal.links);
    rmSync(join(sessionRoot, 'generations', `${generationId}.json`), { force: true });
    restorePreviousControlRecords(options, sessionRoot, journal);
    durableWriteJson(journalPath, { ...journal, phase: 'rolled-back' });
  });
}

export function prepareClaudeSessionStart(
  options: ClaudeSessionStartOptions
): ClaudeSessionStartResult {
  const storeRoot =
    options.storeRoot ?? join(options.homeDir, '.config', 'desk', 'continuity', 'claude');
  const activeRoot =
    options.profileRoot ?? claudeConfigRoot(options.homeDir, options.profileId);
  const lockRoot = join(storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return withFileLockSync(
    join(lockRoot, `${options.providerSessionId}.lock`),
    () => prepareClaudeSessionStartLocked(options, activeRoot, storeRoot)
  );
}

function readActivationRecord(path: string): ClaudeActivationRecord {
  const record = readControlRecord(path);
  if (
    record.policyVersion !== 1 ||
    typeof record.generationId !== 'string' ||
    typeof record.deskSessionId !== 'string' ||
    typeof record.providerSessionId !== 'string' ||
    typeof record.sourceProfileId !== 'string' ||
    typeof record.targetProfileId !== 'string' ||
    typeof record.projectSlug !== 'string' ||
    (record.state !== 'starting-unconfirmed' &&
      record.state !== 'ready' &&
      record.state !== 'needs-attention')
  ) {
    throw new ClaudeContinuityError(
      'continuity-store-corrupt',
      `continuity activation record is invalid: ${basename(path)}`
    );
  }
  return {
    policyVersion: 1,
    generationId: record.generationId,
    deskSessionId: record.deskSessionId,
    providerSessionId: record.providerSessionId,
    sourceProfileId: record.sourceProfileId,
    targetProfileId: record.targetProfileId,
    projectSlug: record.projectSlug,
    state: record.state,
    errorCode:
      record.errorCode === 'continuity-resume-unconfirmed' ||
      record.errorCode === 'continuity-store-corrupt'
        ? record.errorCode
        : undefined,
    observedProviderSessionId:
      typeof record.observedProviderSessionId === 'string'
        ? record.observedProviderSessionId
        : undefined
  };
}

export function confirmClaudeSessionStart(
  options: ConfirmClaudeSessionStartOptions
): ConfirmClaudeSessionStartResult {
  const storeRoot =
    options.storeRoot ?? join(options.homeDir, '.config', 'desk', 'continuity', 'claude');
  const indexedActivationPath = activationIndexPath(storeRoot, options.deskSessionId);
  if (!existsSync(indexedActivationPath)) {
    return { ok: true, managed: false };
  }
  let activation: ClaudeActivationRecord;
  try {
    activation = readActivationRecord(indexedActivationPath);
  } catch (error) {
    return {
      ok: false,
      code: 'continuity-store-corrupt',
      error: errorMessage(error)
    };
  }
  const lockRoot = join(storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return withFileLockSync(
    join(lockRoot, `${activation.providerSessionId}.lock`),
    () => {
      const sessionRoot = join(
        storeRoot,
        'sessions',
        activation.providerSessionId
      );
      const activationPath = join(sessionRoot, 'activation.json');
      try {
        activation = readActivationRecord(activationPath);
        const generation = readGenerationRecord(join(sessionRoot, 'generation.json'));
        if (
          generation.generationId !== activation.generationId ||
          generation.providerSessionId !== activation.providerSessionId ||
          activation.deskSessionId !== options.deskSessionId
        ) {
          throw new ClaudeContinuityError(
            'continuity-store-corrupt',
            `continuity activation does not match generation ${generation.generationId}`
          );
        }
        if (options.providerSessionId !== activation.providerSessionId) {
          writeActivationRecords(
            storeRoot,
            generation,
            options.deskSessionId,
            'needs-attention',
            {
              errorCode: 'continuity-resume-unconfirmed',
              observedProviderSessionId: options.providerSessionId
            }
          );
          return {
            ok: false,
            code: 'continuity-resume-unconfirmed',
            error:
              `expected Claude session ${activation.providerSessionId}, ` +
              `observed ${options.providerSessionId}`
          };
        }

        const sourceRoot = claudeConfigRoot(
          options.homeDir,
          generation.sourceProfileId === 'ambient'
            ? undefined
            : generation.sourceProfileId
        );
        const targetRoot = claudeConfigRoot(
          options.homeDir,
          generation.targetProfileId === 'ambient'
            ? undefined
            : generation.targetProfileId
        );
        const removed: string[] = [];
        const conflicts: string[] = [];
        if (resolve(sourceRoot) !== resolve(targetRoot)) {
          for (const artifact of generation.artifacts) {
            const source = join(sourceRoot, artifact.relativePath);
            if (!existsSync(source)) {
              continue;
            }
            const store = join(sessionRoot, 'files', artifact.relativePath);
            const sourceStat = lstatSync(source);
            const storeStat = existsSync(store) ? lstatSync(store) : undefined;
            if (
              !sourceStat.isFile() ||
              !storeStat?.isFile() ||
              sourceStat.dev !== storeStat.dev ||
              sourceStat.ino !== storeStat.ino
            ) {
              conflicts.push(artifact.relativePath);
              continue;
            }
            rmSync(source, { force: true });
            removed.push(source);
          }
        }
        if (removed.length > 0) {
          syncDestinationDirectories(sourceRoot, removed);
        }
        if (conflicts.length > 0) {
          writeActivationRecords(
            storeRoot,
            generation,
            options.deskSessionId,
            'needs-attention',
            { errorCode: 'continuity-store-corrupt' }
          );
          return {
            ok: false,
            code: 'continuity-store-corrupt',
            error: `stale source artifacts diverged: ${conflicts.join(', ')}`
          };
        }
        writeActivationRecords(
          storeRoot,
          generation,
          options.deskSessionId,
          'ready'
        );
        return { ok: true, managed: true, generationId: generation.generationId };
      } catch (error) {
        return {
          ok: false,
          code: 'continuity-store-corrupt',
          error: errorMessage(error)
        };
      }
    }
  );
}
