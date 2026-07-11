import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { LockOptions } from 'proper-lockfile';

const require = createRequire(import.meta.url);
const { lock, lockSync } = require('proper-lockfile') as typeof import('proper-lockfile');

const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 120_000;
const DEFAULT_UPDATE_MS = 10_000;

export interface FileLockOptions {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
  updateMs?: number;
  notFoundMessage?: string;
}

export class FileLockBusyError extends Error {
  readonly code = 'FILE_LOCK_BUSY';

  constructor(
    readonly lockPath: string,
    readonly timeoutMs: number
  ) {
    super(`could not acquire file lock ${lockPath} within ${timeoutMs}ms`);
    this.name = 'FileLockBusyError';
  }
}

export async function withFileLock<T>(
  lockPath: string,
  action: () => T | Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  assertLockParent(lockPath, options.notFoundMessage);
  const resolved = resolveOptions(lockPath, options);
  let release: () => Promise<void>;
  try {
    release = await lock(lockPath, resolved.lockOptions);
  } catch (error) {
    throwAcquireError(error, lockPath, resolved.timeoutMs, options.notFoundMessage);
  }
  try {
    return await action();
  } finally {
    await release();
  }
}

export function withFileLockSync<T>(
  lockPath: string,
  action: () => T,
  options: FileLockOptions = {}
): T {
  assertLockParent(lockPath, options.notFoundMessage);
  const resolved = resolveOptions(lockPath, options);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + resolved.timeoutMs;
  const lockOptions = { ...resolved.lockOptions, retries: 0 };
  let release: (() => void) | undefined;
  do {
    try {
      release = lockSync(lockPath, lockOptions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ELOCKED') {
        throwAcquireError(error, lockPath, resolved.timeoutMs, options.notFoundMessage);
      }
      if (Date.now() >= deadline) {
        throw new FileLockBusyError(lockPath, resolved.timeoutMs);
      }
      syncBackoff(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  } while (!release);
  try {
    return action();
  } finally {
    release();
  }
}

function assertLockParent(lockPath: string, notFoundMessage?: string): void {
  if (existsSync(dirname(lockPath))) {
    return;
  }
  const error = new Error(notFoundMessage ?? `file lock parent does not exist for ${lockPath}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

function resolveOptions(
  lockPath: string,
  options: FileLockOptions
): { lockOptions: LockOptions; timeoutMs: number } {
  const retryMs = positiveInteger(options.retryMs ?? DEFAULT_RETRY_MS, 'file lock retryMs');
  const timeoutMs = nonNegativeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'file lock timeoutMs');
  const staleMs = positiveInteger(options.staleMs ?? DEFAULT_STALE_MS, 'file lock staleMs');
  const updateMs = positiveInteger(
    options.updateMs ?? Math.floor(Math.min(DEFAULT_UPDATE_MS, staleMs / 2)),
    'file lock updateMs'
  );
  const retries = Math.ceil(timeoutMs / retryMs);
  return {
    timeoutMs,
    lockOptions: {
      lockfilePath: lockPath,
      realpath: false,
      retries: {
        retries,
        factor: 1,
        minTimeout: retryMs,
        maxTimeout: retryMs,
        randomize: false
      },
      stale: staleMs,
      update: updateMs
    }
  };
}

function throwAcquireError(error: unknown, lockPath: string, timeoutMs: number, notFoundMessage?: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ELOCKED') {
    throw new FileLockBusyError(lockPath, timeoutMs);
  }
  if (code === 'ENOENT' && notFoundMessage) {
    throw new Error(notFoundMessage);
  }
  throw error;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function syncBackoff(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}
