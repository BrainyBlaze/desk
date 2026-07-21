// Durable CMD_CACHE conformance (spec §6.10). A within-horizon retry must still
// dedup against a cached ACKED result across a daemon RESTART; past-horizon stays
// fail-closed; compaction bounds the log.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCmdCache } from '../src/server/runtime/fileCmdCache.js';

describe('durable CMD_CACHE — dedup survives restart (§6.10)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmdcache-'));
    path = join(dir, 'cmdcache.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prepare → written → acked persists and reads back after restart', () => {
    const c1 = new FileCmdCache(path);
    c1.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    c1.markWritten('s1', 1, 'k1');
    c1.markAcked('s1', 1, 'k1', 'ok:accepted');
    c1.close();

    const c2 = new FileCmdCache(path);
    const rec = c2.get('s1', 1, 'k1');
    expect(rec?.phase).toBe('ACKED');
    expect(rec?.result).toBe('ok:accepted');
    c2.close();
  });

  it('THE restart property: a within-horizon retry returns the cached ACKED result', () => {
    const c1 = new FileCmdCache(path, { horizonMs: 600_000, maxEntries: 512 });
    c1.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    c1.markAcked('s1', 1, 'k1', 'ok');
    c1.close();

    const c2 = new FileCmdCache(path, { horizonMs: 600_000, maxEntries: 512 }, 2000); // restart, still within horizon
    expect(c2.retry('s1', 1, 'k1')).toEqual({ action: 'return-cached', result: 'ok' });
    c2.close();
  });

  it('a past-horizon entry is evicted on recovery → retry refuses (fail-closed)', () => {
    const c1 = new FileCmdCache(path, { horizonMs: 1000, maxEntries: 512 });
    c1.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    c1.markAcked('s1', 1, 'k1', 'ok');
    c1.close();
    // restart at now well past the horizon → evicted on recovery:
    const c2 = new FileCmdCache(path, { horizonMs: 1000, maxEntries: 512 }, 1000 + 5000);
    expect(c2.retry('s1', 1, 'k1')).toEqual({ action: 'refuse', reason: 'horizon-exhausted' });
    c2.close();
  });

  it('dropGeneration persists — a later retry refuses after restart', () => {
    const c1 = new FileCmdCache(path);
    c1.prepare('s1', 1, 'k1', 'txn-1', 'submit', 1000);
    c1.markAcked('s1', 1, 'k1', 'ok');
    c1.dropGeneration('s1', 1);
    c1.close();
    const c2 = new FileCmdCache(path);
    expect(c2.retry('s1', 1, 'k1')).toEqual({ action: 'refuse', reason: 'horizon-exhausted' });
    c2.close();
  });

  it('compact rewrites the log from the live set and preserves state', () => {
    const c1 = new FileCmdCache(path);
    c1.prepare('s1', 1, 'k1', 'txn-1', 'body', 1000);
    c1.markWritten('s1', 1, 'k1');
    c1.prepare('s1', 1, 'k2', 'txn-1', 'submit', 1001);
    c1.markAcked('s1', 1, 'k2', 'done');
    const before = readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
    c1.compact();
    const after = readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
    expect(after).toBeLessThanOrEqual(before); // no more lines than the transitions
    c1.close();

    const c2 = new FileCmdCache(path);
    expect(c2.get('s1', 1, 'k1')?.phase).toBe('WRITTEN');
    expect(c2.get('s1', 1, 'k2')?.phase).toBe('ACKED');
    expect(c2.get('s1', 1, 'k2')?.result).toBe('done');
    c2.close();
  });
});
