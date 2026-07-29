import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isValidProfileId, profileRoot } from '../shared/agentProfiles.js';
import { withFileLockSync } from '../shared/fileLock.js';

const MAX_MEMORY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_TREE_BYTES = 256 * 1024 * 1024;

interface MemoryFile {
  data: Buffer;
  mode: number;
  sha256: string;
}

interface MemorySnapshot {
  files: Map<string, MemoryFile>;
  unsafe: string[];
}

export interface ClaudeMemoryConflict {
  conflictId: string;
  relativePath: string;
  reason:
    | 'diverged'
    | 'unsafe-profile-artifact'
    | 'unsafe-canonical-artifact'
    | 'unsafe-base-artifact';
  recordPath: string;
  baseSha256?: string;
  canonicalSha256?: string;
  profileSha256?: string;
  baseOriginSessionId?: string;
  canonicalOriginSessionId?: string;
  profileOriginSessionId?: string;
}

export interface SyncClaudeProfileMemoryOptions {
  homeDir: string;
  storeRoot?: string;
  profileId?: string;
  cwd: string;
}

export interface SyncClaudeProfileMemoryResult {
  profileId: string;
  projectSlug: string;
  conflicts: ClaudeMemoryConflict[];
}

export function claudeMemoryProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function recordClaudeProfileMemorySyncFailure(
  options: SyncClaudeProfileMemoryOptions,
  error: unknown
): void {
  if (options.profileId !== undefined && !isValidProfileId(options.profileId)) {
    throw new Error(`invalid Claude profile id: ${options.profileId}`);
  }
  const slug = claudeMemoryProjectSlug(options.cwd);
  const storeRoot =
    options.storeRoot ??
    join(options.homeDir, '.config', 'desk', 'continuity', 'claude-memory');
  const branchKey = options.profileId ?? '_ambient';
  const statePath = join(
    storeRoot,
    'projects',
    slug,
    'branches',
    branchKey,
    'state.json'
  );
  const lockRoot = join(storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  withFileLockSync(join(lockRoot, `${slug}.lock`), () => {
    let conflictIds: string[] = [];
    if (existsSync(statePath)) {
      try {
        const previous = JSON.parse(readFileSync(statePath, 'utf8')) as {
          conflictIds?: unknown;
        };
        if (
          Array.isArray(previous.conflictIds) &&
          previous.conflictIds.every((value) => typeof value === 'string')
        ) {
          conflictIds = previous.conflictIds;
        }
      } catch {
        // The durable error below supersedes an unreadable previous state.
      }
    }
    atomicWriteJson(statePath, {
      policyVersion: 1,
      profileId: options.profileId ?? null,
      projectSlug: slug,
      conflictIds,
      syncError: error instanceof Error ? error.message : String(error)
    });
  });
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameFile(left: MemoryFile | undefined, right: MemoryFile | undefined): boolean {
  return (
    (left === undefined && right === undefined) ||
    (left !== undefined &&
      right !== undefined &&
      left.sha256 === right.sha256 &&
      left.mode === right.mode)
  );
}

function relativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`memory path escapes its root: ${path}`);
  }
  return value.split(sep).join('/');
}

function diskPath(root: string, path: string): string {
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid memory relative path: ${path}`);
  }
  return join(root, ...parts);
}

function readSnapshot(root: string): MemorySnapshot {
  const files = new Map<string, MemoryFile>();
  const unsafe: string[] = [];
  let totalBytes = 0;
  if (!existsSync(root)) {
    return { files, unsafe };
  }
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        walk(join(path, entry.name));
      }
      return;
    }
    const rel = relativePath(root, path);
    if (!stat.isFile()) {
      unsafe.push(rel);
      return;
    }
    if (stat.size > MAX_MEMORY_FILE_BYTES) {
      unsafe.push(rel);
      return;
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_MEMORY_TREE_BYTES) {
      unsafe.push(rel);
      return;
    }
    const data = readFileSync(path);
    files.set(rel, {
      data,
      mode: stat.mode & 0o777,
      sha256: sha256(data)
    });
  };
  walk(root);
  return { files, unsafe };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path: string, file: MemoryFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, 'wx', file.mode);
  try {
    writeFileSync(fd, file.data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function atomicWriteJson(path: string, value: unknown): void {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  atomicWrite(path, { data, mode: 0o600, sha256: sha256(data) });
}

function blockedByUnsafe(path: string, unsafe: Set<string>): boolean {
  for (const entry of unsafe) {
    if (path === entry || path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

function applySnapshot(
  root: string,
  current: Map<string, MemoryFile>,
  next: Map<string, MemoryFile>,
  unsafe: Set<string> = new Set()
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = [...new Set([...current.keys(), ...next.keys()])].sort();
  for (const path of paths) {
    if (blockedByUnsafe(path, unsafe)) continue;
    const before = current.get(path);
    const after = next.get(path);
    if (sameFile(before, after)) continue;
    const target = diskPath(root, path);
    if (after === undefined) {
      rmSync(target, { force: true });
      syncDirectory(dirname(target));
      continue;
    }
    atomicWrite(target, after);
  }
}

function setFile(
  snapshot: Map<string, MemoryFile>,
  path: string,
  file: MemoryFile | undefined
): void {
  if (file === undefined) snapshot.delete(path);
  else snapshot.set(path, file);
}

function originSessionId(file: MemoryFile | undefined): string | undefined {
  if (file === undefined) return undefined;
  const prefix = file.data.subarray(0, 8192).toString('utf8');
  if (!prefix.startsWith('---')) return undefined;
  const end = prefix.indexOf('\n---', 3);
  if (end < 0) return undefined;
  const match = prefix
    .slice(0, end)
    .match(/^originSessionId:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  return match?.[1];
}

function conflictId(
  profileId: string,
  path: string,
  reason: ClaudeMemoryConflict['reason'],
  base: MemoryFile | undefined,
  canonical: MemoryFile | undefined,
  profile: MemoryFile | undefined
): string {
  return createHash('sha256')
    .update(
      [
        profileId,
        path,
        reason,
        base?.sha256 ?? 'absent',
        canonical?.sha256 ?? 'absent',
        profile?.sha256 ?? 'absent'
      ].join('\0')
    )
    .digest('hex')
    .slice(0, 24);
}

function writeConflict(
  conflictsRoot: string,
  profileId: string,
  path: string,
  reason: ClaudeMemoryConflict['reason'],
  base: MemoryFile | undefined,
  canonical: MemoryFile | undefined,
  profile: MemoryFile | undefined
): ClaudeMemoryConflict {
  const id = conflictId(profileId, path, reason, base, canonical, profile);
  const recordPath = join(conflictsRoot, profileId, id);
  mkdirSync(recordPath, { recursive: true, mode: 0o700 });
  for (const [name, file] of [
    ['base', base],
    ['canonical', canonical],
    ['profile', profile]
  ] as const) {
    const output = join(recordPath, name);
    if (file === undefined) rmSync(output, { force: true });
    else atomicWrite(output, file);
  }
  const result: ClaudeMemoryConflict = {
    conflictId: id,
    relativePath: path,
    reason,
    recordPath,
    ...(base === undefined ? {} : { baseSha256: base.sha256 }),
    ...(canonical === undefined ? {} : { canonicalSha256: canonical.sha256 }),
    ...(profile === undefined ? {} : { profileSha256: profile.sha256 }),
    ...(originSessionId(base) === undefined
      ? {}
      : { baseOriginSessionId: originSessionId(base) }),
    ...(originSessionId(canonical) === undefined
      ? {}
      : { canonicalOriginSessionId: originSessionId(canonical) }),
    ...(originSessionId(profile) === undefined
      ? {}
      : { profileOriginSessionId: originSessionId(profile) })
  };
  atomicWriteJson(join(recordPath, 'conflict.json'), {
    policyVersion: 1,
    ...result,
    recordPath: undefined
  });
  return result;
}

function synchronizeLocked(
  options: SyncClaudeProfileMemoryOptions,
  storeRoot: string,
  slug: string
): SyncClaudeProfileMemoryResult {
  const displayProfileId = options.profileId ?? 'ambient';
  const branchKey = options.profileId ?? '_ambient';
  const projectRoot = join(storeRoot, 'projects', slug);
  const canonicalRoot = join(projectRoot, 'canonical', 'files');
  const baseRoot = join(projectRoot, 'branches', branchKey, 'base', 'files');
  const activeRoot = join(
    options.profileId === undefined
      ? join(options.homeDir, '.claude')
      : profileRoot(options.profileId, options.homeDir),
    'projects',
    slug,
    'memory'
  );
  const conflictsRoot = join(projectRoot, 'conflicts');
  mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
  mkdirSync(baseRoot, { recursive: true, mode: 0o700 });

  const canonical = readSnapshot(canonicalRoot);
  const base = readSnapshot(baseRoot);
  const profile = readSnapshot(activeRoot);
  const conflicts: ClaudeMemoryConflict[] = [];
  const unsafeProfile = new Set(profile.unsafe);
  const unsafeCanonical = new Set(canonical.unsafe);
  const unsafeBase = new Set(base.unsafe);
  const nextCanonical = new Map(canonical.files);
  const nextProfile = new Map(profile.files);
  const nextBase = new Map(base.files);

  for (const [unsafe, reason] of [
    [profile.unsafe, 'unsafe-profile-artifact'],
    [canonical.unsafe, 'unsafe-canonical-artifact'],
    [base.unsafe, 'unsafe-base-artifact']
  ] as const) {
    for (const path of unsafe) {
      conflicts.push(
        writeConflict(
          conflictsRoot,
          displayProfileId,
          path,
          reason,
          base.files.get(path),
          canonical.files.get(path),
          profile.files.get(path)
        )
      );
    }
  }

  const paths = [
    ...new Set([...base.files.keys(), ...canonical.files.keys(), ...profile.files.keys()])
  ].sort();
  for (const path of paths) {
    if (
      blockedByUnsafe(path, unsafeProfile) ||
      blockedByUnsafe(path, unsafeCanonical) ||
      blockedByUnsafe(path, unsafeBase)
    ) {
      continue;
    }
    const ancestor = base.files.get(path);
    const remote = canonical.files.get(path);
    const local = profile.files.get(path);
    let chosen: MemoryFile | undefined;
    if (sameFile(local, remote)) {
      chosen = local;
    } else if (sameFile(local, ancestor)) {
      chosen = remote;
    } else if (sameFile(remote, ancestor)) {
      chosen = local;
    } else {
      conflicts.push(
        writeConflict(
          conflictsRoot,
          displayProfileId,
          path,
          'diverged',
          ancestor,
          remote,
          local
        )
      );
      continue;
    }
    setFile(nextCanonical, path, chosen);
    setFile(nextProfile, path, chosen);
    setFile(nextBase, path, chosen);
  }

  // This order is recoverable without a journal. Canonical first means a crash
  // leaves each local file either still mergeable from its old base or already
  // equal to canonical; base advances only after both working copies converge.
  applySnapshot(canonicalRoot, canonical.files, nextCanonical, unsafeCanonical);
  applySnapshot(activeRoot, profile.files, nextProfile, unsafeProfile);
  applySnapshot(baseRoot, base.files, nextBase, unsafeBase);
  atomicWriteJson(join(projectRoot, 'branches', branchKey, 'state.json'), {
    policyVersion: 1,
    profileId: options.profileId ?? null,
    projectSlug: slug,
    conflictIds: conflicts.map((conflict) => conflict.conflictId)
  });

  return { profileId: displayProfileId, projectSlug: slug, conflicts };
}

export function syncClaudeProfileMemory(
  options: SyncClaudeProfileMemoryOptions
): SyncClaudeProfileMemoryResult {
  if (options.profileId !== undefined && !isValidProfileId(options.profileId)) {
    throw new Error(`invalid Claude profile id: ${options.profileId}`);
  }
  const slug = claudeMemoryProjectSlug(options.cwd);
  const storeRoot =
    options.storeRoot ??
    join(options.homeDir, '.config', 'desk', 'continuity', 'claude-memory');
  const lockRoot = join(storeRoot, 'locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return withFileLockSync(join(lockRoot, `${slug}.lock`), () =>
    synchronizeLocked(options, storeRoot, slug)
  );
}
