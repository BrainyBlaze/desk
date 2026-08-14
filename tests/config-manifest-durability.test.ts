import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('manifest replacement durability', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-manifest-durability-'));
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a replacement only after syncing the temp inode and parent directory', async () => {
    const operations: string[] = [];
    const pathsByFd = new Map<number, string>();

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        openSync: ((path: string, flags: string | number, mode?: number) => {
          const fd = actual.openSync(path, flags, mode);
          pathsByFd.set(fd, path);
          operations.push(`open:${path}`);
          return fd;
        }) as typeof actual.openSync,
        fsyncSync: ((fd: number) => {
          operations.push(`fsync:${pathsByFd.get(fd) ?? 'unknown'}`);
          actual.fsyncSync(fd);
        }) as typeof actual.fsyncSync,
        renameSync: ((oldPath: string, newPath: string) => {
          operations.push(`rename:${oldPath}:${newPath}`);
          actual.renameSync(oldPath, newPath);
        }) as typeof actual.renameSync
      };
    });

    const manifestPath = join(root, 'desk.yml');
    const { writeManifestFile } = await import('../src/core/config.js');
    writeManifestFile(manifestPath, { groups: [] });

    const renameIndex = operations.findIndex((operation) =>
      operation.startsWith('rename:')
    );
    const inodeSyncIndex = operations.findIndex(
      (operation) =>
        operation.startsWith('fsync:') && operation.includes('.tmp-')
    );
    const directorySyncIndex = operations.findIndex(
      (operation) => operation === `fsync:${root}`
    );

    expect(inodeSyncIndex).toBeGreaterThanOrEqual(0);
    expect(inodeSyncIndex).toBeLessThan(renameIndex);
    expect(directorySyncIndex).toBeGreaterThan(renameIndex);
    expect(readFileSync(manifestPath, 'utf8')).toContain('groups: []');
  });
});
