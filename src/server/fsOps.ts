import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
  hidden: boolean;
  /** true when the entry can be expanded in the tree (dir, or symlink to dir) */
  expandable: boolean;
}

export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

export type FsReadResult =
  | { ok: true; content: string; mtimeMs: number; size: number }
  | { ok: false; reason: 'binary' | 'too-large'; size: number };

export type FsWriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number };
export type FsCreateResult = { ok: true; mtimeMs: number } | { ok: false; exists: true };

export function sortFsEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const aRank = a.kind === 'file' ? 1 : 0;
    const bRank = b.kind === 'file' ? 1 : 0;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return a.name.localeCompare(b.name);
  });
}

export function listDirectory(path: string): FsEntry[] {
  const entries: FsEntry[] = [];
  for (const dirent of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, dirent.name);
    let stats;
    try {
      stats = lstatSync(entryPath);
    } catch {
      continue; // raced deletion — skip
    }
    let expandable = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        expandable = statSync(entryPath).isDirectory();
      } catch {
        expandable = false; // broken symlink
      }
    }
    entries.push({
      name: dirent.name,
      path: entryPath,
      kind: dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'dir' : 'file',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hidden: dirent.name.startsWith('.'),
      expandable
    });
  }
  return sortFsEntries(entries);
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export function readFileSafe(path: string): FsReadResult {
  const stats = statSync(path);
  if (stats.size > MAX_EDITABLE_BYTES) {
    return { ok: false, reason: 'too-large', size: stats.size };
  }
  const buffer = readFileSync(path);
  if (isBinary(buffer)) {
    return { ok: false, reason: 'binary', size: stats.size };
  }
  return { ok: true, content: buffer.toString('utf8'), mtimeMs: stats.mtimeMs, size: stats.size };
}

/**
 * Atomic write (temp + rename, same crash-safety pattern as the manifest).
 * When expectedMtimeMs is supplied and the on-disk mtime differs, the write
 * is refused — optimistic concurrency against agents editing the same file.
 */
export function writeFileAtomic(path: string, content: string, expectedMtimeMs?: number): FsWriteResult {
  if (expectedMtimeMs !== undefined && existsSync(path)) {
    const current = statSync(path).mtimeMs;
    if (current !== expectedMtimeMs) {
      return { ok: false, conflict: true, mtimeMs: current };
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.desk-tmp-${process.pid}`);
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
  return { ok: true, mtimeMs: statSync(path).mtimeMs };
}

/**
 * Atomic create (temp + hard-link claim, same directory). Unlike rename, the
 * final claim fails if `path` already exists, so callers can retry a suffixed
 * name without clobbering a concurrent writer. Accepts Buffer for uploads.
 */
export function writeFileAtomicCreate(path: string, content: string | Buffer): FsCreateResult {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.desk-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(temp, content);
    try {
      linkSync(temp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, exists: true };
      }
      throw err;
    }
    return { ok: true, mtimeMs: statSync(path).mtimeMs };
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // best-effort temp cleanup
    }
  }
}

export function createEntry(path: string, kind: 'file' | 'dir'): void {
  if (existsSync(path)) {
    throw new Error(`already exists: ${path}`);
  }
  if (kind === 'dir') {
    mkdirSync(path, { recursive: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', 'utf8');
}

/** Copy a file or directory (recursive); refuses clobber and self-nesting. */
export function copyEntry(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(`does not exist: ${from}`);
  }
  if (existsSync(to)) {
    throw new Error(`target already exists: ${to}`);
  }
  const fromResolved = resolve(from);
  const toResolved = resolve(to);
  if (toResolved === fromResolved || toResolved.startsWith(fromResolved + sep)) {
    throw new Error('cannot copy a directory into itself');
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export function renameEntry(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(`does not exist: ${from}`);
  }
  if (existsSync(to)) {
    throw new Error(`target already exists: ${to}`);
  }
  const fromResolved = resolve(from);
  const toResolved = resolve(to);
  if (toResolved === fromResolved || toResolved.startsWith(fromResolved + sep)) {
    throw new Error('cannot move a directory into itself');
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

export function deleteEntry(path: string): void {
  rmSync(path, { recursive: true });
}
