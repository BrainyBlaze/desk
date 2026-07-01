import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyEntry,
  createEntry,
  deleteEntry,
  isBinary,
  listDirectory,
  MAX_EDITABLE_BYTES,
  readFileSafe,
  renameEntry,
  sortFsEntries,
  writeFileAtomic,
  type FsEntry
} from '../src/server/fsOps';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-fs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listDirectory', () => {
  it('lists files, dirs, hidden entries and symlinks with metadata', () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'b.txt'), 'hello');
    writeFileSync(join(root, '.hidden'), 'x');
    symlinkSync(join(root, 'sub'), join(root, 'link'));
    const entries = listDirectory(root);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get('sub')?.kind).toBe('dir');
    expect(byName.get('sub')?.expandable).toBe(true);
    expect(byName.get('b.txt')?.kind).toBe('file');
    expect(byName.get('b.txt')?.size).toBe(5);
    expect(byName.get('.hidden')?.hidden).toBe(true);
    expect(byName.get('link')?.kind).toBe('symlink');
    expect(byName.get('link')?.expandable).toBe(true);
  });

  it('sorts directories first, then names', () => {
    const entries: FsEntry[] = [
      { name: 'z.txt', path: '/z.txt', kind: 'file', size: 0, mtimeMs: 0, hidden: false, expandable: false },
      { name: 'alpha', path: '/alpha', kind: 'dir', size: 0, mtimeMs: 0, hidden: false, expandable: true },
      { name: 'a.txt', path: '/a.txt', kind: 'file', size: 0, mtimeMs: 0, hidden: false, expandable: false }
    ];
    expect(sortFsEntries(entries).map((entry) => entry.name)).toEqual(['alpha', 'a.txt', 'z.txt']);
  });
});

describe('readFileSafe', () => {
  it('reads a text file with mtime', () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'content');
    const result = readFileSafe(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('content');
      expect(result.mtimeMs).toBe(statSync(path).mtimeMs);
    }
  });

  it('flags binary files instead of returning bytes', () => {
    const path = join(root, 'a.bin');
    writeFileSync(path, Buffer.from([0x7f, 0x45, 0x00, 0x46]));
    const result = readFileSafe(path);
    expect(result).toMatchObject({ ok: false, reason: 'binary' });
  });

  it('flags oversized files', () => {
    const path = join(root, 'big.txt');
    writeFileSync(path, 'a'.repeat(MAX_EDITABLE_BYTES + 1));
    expect(readFileSafe(path)).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('isBinary', () => {
  it('detects NUL bytes and accepts utf8', () => {
    expect(isBinary(Buffer.from('plain text é'))).toBe(false);
    expect(isBinary(Buffer.from([0x00, 0x01]))).toBe(true);
  });
});

describe('writeFileAtomic', () => {
  it('writes new files and returns the new mtime', () => {
    const path = join(root, 'new.txt');
    const result = writeFileAtomic(path, 'data');
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('data');
  });

  it('accepts a write when the expected mtime matches', () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'v1');
    const mtimeMs = statSync(path).mtimeMs;
    const result = writeFileAtomic(path, 'v2', mtimeMs);
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('v2');
  });

  it('rejects with conflict when the file changed underneath', () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'v1');
    const staleMtime = statSync(path).mtimeMs - 5000;
    const result = writeFileAtomic(path, 'v2', staleMtime);
    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(path, 'utf8')).toBe('v1');
  });

  it('leaves no temp files behind', () => {
    const path = join(root, 'a.txt');
    writeFileAtomic(path, 'data');
    expect(listDirectory(root).map((entry) => entry.name)).toEqual(['a.txt']);
  });
});

describe('copyEntry', () => {
  it('copies a file', () => {
    writeFileSync(join(root, 'a.txt'), 'payload');
    copyEntry(join(root, 'a.txt'), join(root, 'b.txt'));
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('payload');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('payload');
  });

  it('copies a directory recursively', () => {
    mkdirSync(join(root, 'dir/sub'), { recursive: true });
    writeFileSync(join(root, 'dir/sub/x.txt'), 'deep');
    copyEntry(join(root, 'dir'), join(root, 'dir2'));
    expect(readFileSync(join(root, 'dir2/sub/x.txt'), 'utf8')).toBe('deep');
  });

  it('refuses to clobber an existing target', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    writeFileSync(join(root, 'b.txt'), 'y');
    expect(() => copyEntry(join(root, 'a.txt'), join(root, 'b.txt'))).toThrow(/already exists/);
  });

  it('refuses to copy a directory into its own descendant', () => {
    mkdirSync(join(root, 'dir/sub'), { recursive: true });
    expect(() => copyEntry(join(root, 'dir'), join(root, 'dir/sub/clone'))).toThrow(/into itself/);
  });
});

describe('createEntry / renameEntry / deleteEntry', () => {
  it('creates files and nested directories', () => {
    createEntry(join(root, 'nested/dir'), 'dir');
    createEntry(join(root, 'nested/dir/file.ts'), 'file');
    expect(statSync(join(root, 'nested/dir')).isDirectory()).toBe(true);
    expect(readFileSync(join(root, 'nested/dir/file.ts'), 'utf8')).toBe('');
  });

  it('refuses to create over an existing entry', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    expect(() => createEntry(join(root, 'a.txt'), 'file')).toThrow(/exists/);
  });

  it('renames and moves entries, refusing to clobber', () => {
    mkdirSync(join(root, 'target'));
    writeFileSync(join(root, 'a.txt'), 'x');
    renameEntry(join(root, 'a.txt'), join(root, 'target/b.txt'));
    expect(readFileSync(join(root, 'target/b.txt'), 'utf8')).toBe('x');
    writeFileSync(join(root, 'a.txt'), 'y');
    expect(() => renameEntry(join(root, 'a.txt'), join(root, 'target/b.txt'))).toThrow(/already exists/);
  });

  it('refuses to move a directory into itself', () => {
    mkdirSync(join(root, 'dir'));
    expect(() => renameEntry(join(root, 'dir'), join(root, 'dir/sub'))).toThrow(/into itself/);
  });

  it('deletes files and recursive directories', () => {
    mkdirSync(join(root, 'dir/sub'), { recursive: true });
    writeFileSync(join(root, 'dir/sub/a.txt'), 'x');
    deleteEntry(join(root, 'dir'));
    expect(existsSync(join(root, 'dir'))).toBe(false);
  });
});
