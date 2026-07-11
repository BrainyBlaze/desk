import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLockBusyError, withFileLock, withFileLockSync } from '../../src/shared/fileLock.js';

describe('shared file lock', () => {
  let root: string;
  let lockPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-file-lock-'));
    lockPath = join(root, '.write.lock');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a sync action result and releases the lock directory', () => {
    const result = withFileLockSync(lockPath, () => 'done');

    expect(result).toBe('done');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes overlapping async actions for the same path', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(lockPath, async () => {
      order.push('first:start');
      await firstMayFinish;
      order.push('first:end');
    });
    await waitFor(() => order.length === 1);

    const second = withFileLock(lockPath, async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('fails with a typed busy error after bounded sync contention', () => {
    withFileLockSync(lockPath, () => {
      expect(() =>
        withFileLockSync(lockPath, () => undefined, {
          retryMs: 5,
          timeoutMs: 20
        })
      ).toThrow(FileLockBusyError);
    });
  });

  it('keeps a live async holder fresh beyond the stale threshold', async () => {
    const options = {
      retryMs: 25,
      staleMs: 2_000,
      timeoutMs: 4_000,
      updateMs: 1_000
    };
    let entered = false;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(
      lockPath,
      async () => {
        entered = true;
        await firstMayFinish;
      },
      options
    );
    await waitFor(() => entered);
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    let secondEntered = false;
    const second = withFileLock(
      lockPath,
      async () => {
        secondEntered = true;
      },
      options
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondEntered).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  }, 7_000);

  it('maps a missing parent to the caller-facing not-found error', async () => {
    const missingLock = join(root, 'missing', '.write.lock');

    await expect(
      withFileLock(missingLock, async () => undefined, {
        notFoundMessage: "channel 'missing' not found"
      })
    ).rejects.toThrow("channel 'missing' not found");
    expect(existsSync(missingLock)).toBe(false);
  });

  it('supports callers that explicitly create the lock parent first', () => {
    const nested = join(root, 'created', '.write.lock');
    mkdirSync(join(root, 'created'));

    expect(withFileLockSync(nested, () => 42)).toBe(42);
  });

  it('derives an integer update interval from an odd stale interval', () => {
    expect(
      withFileLockSync(lockPath, () => 'done', {
        staleMs: 2_001
      })
    ).toBe('done');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
