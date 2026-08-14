// desk#65: writeSync returns the number of bytes it ACTUALLY wrote. A regular
// file may legally return short without throwing — at an ENOSPC boundary, or
// when the call is interrupted — and a one-byte write may legally return zero.
// Every record these three sites append is newline-terminated with the newline
// LAST, so a short write leaves an unterminated record; two of the three then
// fsync that truncated record durably, and the next append concatenates onto
// it, fusing two records into one unparseable line.
//
// A loop alone is not enough: reading the count but leaving the partial bytes
// behind still poisons the next append. The invariant under test is stronger —
// every append is COMPLETE OR REVERSIBLE. Each site therefore gets a short
// write the loop must finish, a zero or over-reported count that must be
// refused outright, and a short-then-error that must leave the file exactly as
// it was before the record was attempted; the two fsync'd stores additionally
// get the unrepairable-rollback branch and the startup repair that lets a
// restart recover from it.
//
// Every on-disk assertion about a failed append is made IN PROCESS,
// immediately after the failure and before any restart — otherwise the startup
// repair would absorb the damage and a passing test would only prove that
// startup repair works.
//
// Only node:fs.writeSync and ftruncateSync are mocked, and only when explicitly
// armed against one named payload: everything else runs the real filesystem,
// because the property is about what the real file contains.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function noSpace(): NodeJS.ErrnoException {
  const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
  error.code = 'ENOSPC';
  return error;
}

/**
 * The injected witness.
 *
 * `armed` gates it entirely and `match` narrows it to the one payload under
 * test, so unrelated durable writes in the same call tree (journals, locks,
 * manifests) go through untouched.
 *
 * `calls` counts MATCHING writeSync calls and `injected` / `failed` record
 * which arm actually fired — a test that never reaches the injection proves
 * nothing, so every test asserts them.
 */
const shortWrite = vi.hoisted(() => ({
  armed: false,
  match: '',
  mode: 'short' as 'short' | 'zero' | 'over',
  bytes: 0,
  failAfterFirst: false,
  /** Latched on the first match: the retry writes only the REMAINDER of the
   *  record, which no longer contains the matched substring, so the descriptor
   *  is what identifies it. */
  fd: -1,
  calls: 0,
  injected: 0,
  failed: 0
}));

/**
 * Makes the ROLLBACK itself fail, which is the only way to reach the branch
 * where a partial record cannot be undone. Neither this nor the short write is
 * reachable from a real filesystem on demand, which is exactly why they are
 * injected.
 */
const rollbackFailure = vi.hoisted(() => ({ enabled: false, refused: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    writeSync: (...args: Parameters<typeof real.writeSync>): number => {
      if (!shortWrite.armed) return real.writeSync(...args);
      const [fd, data] = args;
      const isString = typeof data === 'string';
      const view = isString ? undefined : (data as NodeJS.ArrayBufferView);
      const offset = typeof args[2] === 'number' ? args[2] : 0;
      const length =
        typeof args[3] === 'number'
          ? args[3]
          : isString
            ? data.length - offset
            : view!.byteLength - offset;
      const payload = isString
        ? data.slice(offset, offset + length)
        : Buffer.from(view!.buffer, view!.byteOffset, view!.byteLength)
            .subarray(offset, offset + length)
            .toString('utf8');
      const matches =
        shortWrite.fd === fd ||
        shortWrite.match.length === 0 ||
        payload.includes(shortWrite.match);
      if (!matches) return real.writeSync(...args);
      shortWrite.calls += 1;
      if (shortWrite.calls === 1) {
        shortWrite.fd = fd;
        shortWrite.injected += 1;
        // A zero-byte return is legal and must be refused, not looped on.
        if (shortWrite.mode === 'zero') return 0;
        // A count larger than the range handed to writeSync describes nothing
        // the caller can trust; it must be treated as incomplete, not as done.
        if (shortWrite.mode === 'over') return real.writeSync(...args) + 1;
        const short = Math.min(shortWrite.bytes, length);
        return isString
          ? real.writeSync(fd, data.slice(offset, offset + short))
          : real.writeSync(fd, view!, offset, short);
      }
      if (shortWrite.failAfterFirst && shortWrite.calls === 2) {
        shortWrite.failed += 1;
        throw noSpace();
      }
      return real.writeSync(...args);
    },
    ftruncateSync: (...args: Parameters<typeof real.ftruncateSync>): void => {
      if (rollbackFailure.enabled) {
        rollbackFailure.refused += 1;
        const error = new Error('EIO: i/o error, ftruncate') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      real.ftruncateSync(...args);
    }
  };
});

import { FileConsumerStore } from '../src/server/runtime/fileConsumerStore.js';
import { FileCmdCache } from '../src/server/runtime/fileCmdCache.js';

function arm(options: {
  match: string;
  mode?: 'short' | 'zero' | 'over';
  bytes?: number;
  failAfterFirst?: boolean;
}): void {
  shortWrite.armed = true;
  shortWrite.match = options.match;
  shortWrite.mode = options.mode ?? 'short';
  shortWrite.bytes = options.bytes ?? 0;
  shortWrite.failAfterFirst = options.failAfterFirst ?? false;
  shortWrite.fd = -1;
  shortWrite.calls = 0;
  shortWrite.injected = 0;
  shortWrite.failed = 0;
}

function disarm(): void {
  shortWrite.armed = false;
  shortWrite.match = '';
  shortWrite.fd = -1;
  shortWrite.failAfterFirst = false;
  rollbackFailure.enabled = false;
}

afterEach(() => disarm());

describe('durable consumer receipts are complete or reversible (desk#65)', () => {
  let dir: string;
  let receiptPath: string;
  let cursorPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'consumer-short-'));
    receiptPath = join(dir, 'receipts.log');
    cursorPath = join(dir, 'cursor');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const receipts = (): string[] =>
    readFileSync(receiptPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

  it('finishes a short receipt write before claiming the effect was recorded', () => {
    const store = new FileConsumerStore(receiptPath, cursorPath);
    store.applyAndReceipt('receipt-one', () => {});

    arm({ match: 'receipt-two', bytes: 4 });
    store.applyAndReceipt('receipt-two', () => {});
    expect(shortWrite.injected).toBe(1);
    expect(shortWrite.calls).toBe(2); // the remainder was written, not dropped
    disarm();

    // The id is whole and newline-terminated, so the NEXT append starts on a
    // record boundary instead of fusing onto "rece".
    expect(readFileSync(receiptPath, 'utf8')).toBe('receipt-one\nreceipt-two\n');
    store.applyAndReceipt('receipt-three', () => {});
    expect(receipts()).toEqual(['receipt-one', 'receipt-two', 'receipt-three']);
    store.close();
  });

  it('refuses a receipt whose write reports no progress, and applies no effect twice', () => {
    const store = new FileConsumerStore(receiptPath, cursorPath);
    store.applyAndReceipt('receipt-one', () => {});
    const committed = readFileSync(receiptPath, 'utf8');

    const applied: string[] = [];
    arm({ match: 'receipt-two', mode: 'zero' });
    expect(() => store.applyAndReceipt('receipt-two', () => applied.push('effect'))).toThrow(
      'durable consumer receipt append made no progress'
    );
    expect(shortWrite.injected).toBe(1);
    disarm();

    // The effect DID run and cannot be un-run. Everything the store OWNS must
    // read as if the receipt had never been attempted.
    expect(applied).toEqual(['effect']);
    expect(readFileSync(receiptPath, 'utf8')).toBe(committed);
    // The in-memory set must never claim a durability the disk does not hold:
    // hasReceipt is a durability question, and answering it "true" here would
    // make this incarnation disagree with every incarnation after a restart —
    // an exactly-once violation that stays invisible until the daemon dies.
    expect(store.hasReceipt('receipt-two')).toBe(false);
    store.close();
  });

  it('refuses a receipt whose write over-reports its own byte count', () => {
    const store = new FileConsumerStore(receiptPath, cursorPath);
    store.applyAndReceipt('receipt-one', () => {});

    arm({ match: 'receipt-two', mode: 'over' });
    expect(() => store.applyAndReceipt('receipt-two', () => {})).toThrow(
      'durable consumer receipt append made no progress'
    );
    expect(shortWrite.injected).toBe(1);
    disarm();

    // The over-reported write really did land bytes on disk; refusing without
    // rolling them back would leave the record committed but unacknowledged.
    expect(readFileSync(receiptPath, 'utf8')).toBe('receipt-one\n');
    expect(store.hasReceipt('receipt-two')).toBe(false);
    store.close();
  });

  it('rolls the partial tail back so a retry cannot fuse two event ids into one', () => {
    const store = new FileConsumerStore(receiptPath, cursorPath);
    store.applyAndReceipt('receipt-one', () => {});

    const applied: string[] = [];
    arm({ match: 'receipt-two', bytes: 5, failAfterFirst: true });
    expect(() => store.applyAndReceipt('receipt-two', () => applied.push('effect'))).toThrow(
      'ENOSPC'
    );
    expect(shortWrite.injected).toBe(1);
    expect(shortWrite.failed).toBe(1); // the retry of the remainder is what failed
    disarm();

    // In process, before any restart: the five bytes of "recei" are gone.
    expect(readFileSync(receiptPath, 'utf8')).toBe('receipt-one\n');
    expect(store.hasReceipt('receipt-two')).toBe(false);

    // The retry re-runs the effect, because the receipt genuinely never
    // committed — exactly what a restart would have done.
    store.applyAndReceipt('receipt-two', () => applied.push('effect'));
    expect(applied).toEqual(['effect', 'effect']);
    expect(receipts()).toEqual(['receipt-one', 'receipt-two']);
    expect(receipts()).not.toContain('receireceipt-two');
    store.close();

    const restored = new FileConsumerStore(receiptPath, cursorPath);
    expect(restored.hasReceipt('receipt-one')).toBe(true);
    expect(restored.hasReceipt('receipt-two')).toBe(true);
    restored.close();
  });

  it('refuses every later receipt when the partial one cannot be rolled back', () => {
    const store = new FileConsumerStore(receiptPath, cursorPath);
    store.applyAndReceipt('receipt-one', () => {});

    arm({ match: 'receipt-two', bytes: 5, failAfterFirst: true });
    rollbackFailure.enabled = true;
    expect(() => store.applyAndReceipt('receipt-two', () => {})).toThrow('ENOSPC');
    expect(shortWrite.failed).toBe(1);
    expect(rollbackFailure.refused).toBeGreaterThanOrEqual(1);
    disarm();

    // The tail could not be repaired. The store must not append a valid id
    // behind it — the two would be read back as one fused id — and it must
    // refuse BEFORE running an effect it already knows it cannot receipt.
    const applied: string[] = [];
    expect(() => store.applyAndReceipt('receipt-three', () => applied.push('effect'))).toThrow(
      'refuses to append behind an unrepairable partial receipt'
    );
    expect(applied).toEqual([]);
    expect(readFileSync(receiptPath, 'utf8')).toBe('receipt-one\nrecei');
    store.close();

    // The refusal is not a dead end: the store has no atomic rewrite path, so
    // recovery is a restart, and replay is what makes that safe.
    const restarted = new FileConsumerStore(receiptPath, cursorPath);
    expect(readFileSync(receiptPath, 'utf8')).toBe('receipt-one\n');
    restarted.applyAndReceipt('receipt-three', () => applied.push('effect'));
    expect(applied).toEqual(['effect']);
    expect(receipts()).toEqual(['receipt-one', 'receipt-three']);
    restarted.close();
  });

  it('repairs a torn tail at startup so the first append cannot fuse onto it', () => {
    // A hard kill mid-write leaves exactly this: a terminated record followed
    // by an unterminated one.
    writeFileSync(receiptPath, 'receipt-one\nrecei');
    const store = new FileConsumerStore(receiptPath, cursorPath);
    expect(store.hasReceipt('receipt-one')).toBe(true);
    // "recei" is not a receipt — recovering it would invent an id.
    expect(store.hasReceipt('recei')).toBe(false);
    expect(readFileSync(receiptPath, 'utf8')).toBe('receipt-one\n');

    store.applyAndReceipt('receipt-two', () => {});
    expect(receipts()).toEqual(['receipt-one', 'receipt-two']);
    store.close();
  });
});

describe('durable cmd cache appends are complete or reversible (desk#65)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmdcache-short-'));
    path = join(dir, 'cmdcache.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = (): string[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);

  it('finishes a short transition write before the op is fsynced', () => {
    const cache = new FileCmdCache(path);
    cache.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);

    arm({ match: '"op":"w"', bytes: 11 });
    cache.markWritten('s1', 1, 'k1');
    expect(shortWrite.injected).toBe(1);
    expect(shortWrite.calls).toBe(2);
    disarm();

    expect(lines()).toHaveLength(2);
    for (const line of lines()) expect(() => JSON.parse(line)).not.toThrow();
    cache.close();

    const restarted = new FileCmdCache(path);
    expect(restarted.get('s1', 1, 'k1')?.phase).toBe('WRITTEN');
    restarted.close();
  });

  it('refuses a transition whose write reports no progress', () => {
    const cache = new FileCmdCache(path);
    cache.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    cache.markWritten('s1', 1, 'k1');
    const committed = readFileSync(path, 'utf8');

    arm({ match: '"op":"a"', mode: 'zero' });
    expect(() => cache.markAcked('s1', 1, 'k1', 'ok:accepted')).toThrow(
      'durable cmd cache append made no progress'
    );
    expect(shortWrite.injected).toBe(1);
    disarm();

    expect(readFileSync(path, 'utf8')).toBe(committed);
    cache.close();

    // Fail-closed: the restart reads the last phase the log actually justifies,
    // never one it does not.
    const restarted = new FileCmdCache(path);
    expect(restarted.get('s1', 1, 'k1')?.phase).toBe('WRITTEN');
    restarted.close();
  });

  it('refuses a transition whose write over-reports its own byte count', () => {
    const cache = new FileCmdCache(path);
    cache.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    const committed = readFileSync(path, 'utf8');

    arm({ match: '"op":"w"', mode: 'over' });
    expect(() => cache.markWritten('s1', 1, 'k1')).toThrow(
      'durable cmd cache append made no progress'
    );
    expect(shortWrite.injected).toBe(1);
    disarm();

    // The over-reported write really did land bytes on disk; refusing without
    // rolling them back would leave the op committed but unacknowledged.
    expect(readFileSync(path, 'utf8')).toBe(committed);
    cache.close();
  });

  it('rolls the partial tail back so a later op cannot fuse into an unparseable line', () => {
    const cache = new FileCmdCache(path);
    cache.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    const committed = readFileSync(path, 'utf8');

    arm({ match: '"op":"w"', bytes: 11, failAfterFirst: true });
    expect(() => cache.markWritten('s1', 1, 'k1')).toThrow('ENOSPC');
    expect(shortWrite.injected).toBe(1);
    expect(shortWrite.failed).toBe(1);
    disarm();

    expect(readFileSync(path, 'utf8')).toBe(committed);

    // A later op must land on a clean record boundary. If the partial tail
    // survived, this append would fuse with it and BOTH records would be lost
    // to the replay's JSON.parse guard — the earlier one silently.
    cache.markAcked('s1', 1, 'k1', 'ok:accepted');
    expect(lines()).toHaveLength(2);
    for (const line of lines()) expect(() => JSON.parse(line)).not.toThrow();
    cache.close();

    const restarted = new FileCmdCache(path);
    const record = restarted.get('s1', 1, 'k1');
    expect(record?.phase).toBe('ACKED');
    expect(record?.result).toBe('ok:accepted');
    restarted.close();
  });

  it('refuses every later op when the partial one cannot be rolled back', () => {
    const cache = new FileCmdCache(path);
    cache.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    const committed = readFileSync(path, 'utf8');

    arm({ match: '"op":"w"', bytes: 11, failAfterFirst: true });
    rollbackFailure.enabled = true;
    expect(() => cache.markWritten('s1', 1, 'k1')).toThrow('ENOSPC');
    expect(shortWrite.failed).toBe(1);
    expect(rollbackFailure.refused).toBeGreaterThanOrEqual(1);
    disarm();

    expect(() => cache.markAcked('s1', 1, 'k1', 'ok:accepted')).toThrow(
      'refuses to append behind an unrepairable partial record'
    );
    // The unrepairable tail is still there, and nothing was written past it.
    expect(readFileSync(path, 'utf8')).toBe(`${committed}{"op":"w","`);

    // compact() replaces the log wholesale via temp+rename, so the tail is gone
    // by construction — the refusal must lift with it rather than outlive it.
    // It rebuilds from MEMORY, which the refused transitions already advanced,
    // so what it writes is the live set and not the old prefix.
    cache.compact();
    expect(readFileSync(path, 'utf8')).not.toContain('{"op":"w","\n');
    for (const line of lines()) expect(() => JSON.parse(line)).not.toThrow();

    // Appending works again, on a log with no tail to fuse onto.
    const beforeDrop = lines().length;
    cache.dropGeneration('s1', 1);
    expect(lines()).toHaveLength(beforeDrop + 1);
    for (const line of lines()) expect(() => JSON.parse(line)).not.toThrow();
    cache.close();

    const restarted = new FileCmdCache(path);
    expect(restarted.get('s1', 1, 'k1')).toBeUndefined();
    restarted.close();
  });

  it('repairs a torn tail at startup so the first append cannot fuse onto it', () => {
    const cache = new FileCmdCache(path);
    cache.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    const committed = readFileSync(path, 'utf8');
    cache.close();
    writeFileSync(path, `${committed}{"op":"w","`);

    const restarted = new FileCmdCache(path);
    expect(readFileSync(path, 'utf8')).toBe(committed);
    restarted.markAcked('s1', 1, 'k1', 'ok:accepted');
    expect(lines()).toHaveLength(2);
    for (const line of lines()) expect(() => JSON.parse(line)).not.toThrow();
    restarted.close();

    const again = new FileCmdCache(path);
    expect(again.get('s1', 1, 'k1')?.phase).toBe('ACKED');
    again.close();
  });
});
