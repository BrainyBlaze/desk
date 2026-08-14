// Durable CMD_CACHE (spec §6.10). The fsync'd backing behind the delivery
// idempotency store, so a within-horizon retry still dedups against a cached
// ACKED result across a daemon RESTART (past-horizon entries stay fail-closed —
// losing the cache degrades only to the safe "refuse" default, never a double
// submit). Wraps InMemoryCmdCache: each state transition is appended + fsync'd;
// on startup the log is replayed (then evicted) to rebuild the live state;
// compact() rewrites the log from the live set to bound its growth.

import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_CMD_CACHE_CONFIG,
  InMemoryCmdCache,
  type CmdCacheConfig,
  type CmdRecord,
  type CmdStep,
  type RetryDecision
} from '../../shared/delivery/cmdCache.js';

interface LogOp {
  op: 'p' | 'w' | 'a' | 'd';
  s: string; // sessionId
  g: number; // generation
  k?: string; // stepKey
  t?: string; // txnId
  st?: CmdStep; // step
  r?: string; // result
  ts?: number;
}

export class FileCmdCache {
  private readonly path: string;
  private readonly mem: InMemoryCmdCache;
  private fd: number | null = null;
  /**
   * Set only when a partial op could NOT be rolled back (desk#65). The log then
   * ends mid-record; appending behind it would fuse the two into one line that
   * replay's JSON.parse guard discards WHOLE — losing the new op silently on
   * top of the torn one. Refusing is the only fail-closed answer left.
   */
  private appendFailure: Error | null = null;

  constructor(path: string, cfg: CmdCacheConfig = DEFAULT_CMD_CACHE_CONFIG, now?: number) {
    this.path = path;
    this.mem = new InMemoryCmdCache(cfg);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.replay(now);
    this.fd = openSync(path, 'a');
  }

  private replay(now?: number): void {
    if (existsSync(this.path)) {
      const text = readFileSync(this.path, 'utf8');
      // The newline is the LAST byte of a record, so an unterminated final
      // segment never committed. Dropping it durably BEFORE the append handle
      // opens is what stops this incarnation's first append from fusing onto a
      // tail left by a hard kill.
      const terminated = text.lastIndexOf('\n') + 1;
      if (terminated < text.length) this.truncateTail(terminated);
      for (const line of text.slice(0, terminated).split('\n')) {
        if (line.length === 0) continue;
        let o: LogOp;
        try {
          o = JSON.parse(line) as LogOp;
        } catch {
          continue; // torn/corrupt line — skip fail-closed
        }
        this.apply(o);
      }
    }
    if (now !== undefined) this.mem.evict(now); // drop past-horizon on recovery
  }

  private apply(o: LogOp): void {
    switch (o.op) {
      case 'p':
        if (o.k !== undefined && o.t !== undefined && o.st !== undefined) this.mem.prepare(o.s, o.g, o.k, o.t, o.st, o.ts ?? 0);
        return;
      case 'w':
        if (o.k !== undefined) this.mem.markWritten(o.s, o.g, o.k);
        return;
      case 'a':
        if (o.k !== undefined) this.mem.markAcked(o.s, o.g, o.k, o.r);
        return;
      case 'd':
        this.mem.dropGeneration(o.s, o.g);
        return;
    }
  }

  /**
   * Append one op COMPLETELY or leave the log exactly as it was.
   *
   * writeSync reports how many bytes it actually took, and a regular file may
   * legally take fewer than asked, or zero. The newline that terminates the
   * JSON is the last byte, so a partial write fsync'd anyway commits a record
   * that replay cannot parse — and the NEXT op appends onto that same line, so
   * replay discards both. Hence the loop, and hence the rollback: reading the
   * count without undoing the partial bytes still leaves the tail in front of
   * the retry.
   */
  private append(o: LogOp): void {
    if (this.appendFailure !== null) throw this.appendFailure;
    if (this.fd === null) this.fd = openSync(this.path, 'a');
    const fd = this.fd;
    const bytes = Buffer.from(`${JSON.stringify(o)}\n`, 'utf8');
    const appendStart = fstatSync(fd).size;
    let written = 0;
    try {
      while (written < bytes.length) {
        const remaining = bytes.length - written;
        const count = writeSync(fd, bytes, written, remaining);
        // Zero is legal and must not be looped on; a count past the range we
        // handed in describes nothing we can trust. Both are "incomplete".
        if (count <= 0 || count > remaining) {
          throw new Error('durable cmd cache append made no progress');
        }
        written += count;
      }
      // A record we cannot fsync is a record we cannot claim; roll it back too.
      fsyncSync(fd);
    } catch (error) {
      this.rollbackTo(fd, appendStart);
      // Propagate. The caller's in-memory transition has already happened and
      // is NOT undone, because here memory running ahead of the log is safe in
      // both directions: a live entry only ever makes dedup STRICTER (it
      // returns the cached result instead of re-submitting), and the restart
      // that loses it falls back to this cache's documented degradation — the
      // fail-closed "refuse", never a double submit. What must not happen is a
      // caller believing the transition is durable when it is not.
      throw error;
    }
  }

  /** Undo a partial append, or refuse to ever append again if it cannot be undone. */
  private rollbackTo(fd: number, appendStart: number): void {
    try {
      ftruncateSync(fd, appendStart);
      fsyncSync(fd);
    } catch {
      this.appendFailure = new Error(
        'durable cmd cache refuses to append behind an unrepairable partial record'
      );
      try {
        closeSync(fd);
      } catch {
        // The descriptor is unusable either way; what matters is that nothing
        // writes through it again. Restart replay truncates the torn tail.
      }
      if (this.fd === fd) this.fd = null;
    }
  }

  private truncateTail(offset: number): void {
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  prepare(sessionId: string, generation: number, stepKey: string, txnId: string, step: CmdStep, now: number): { record: CmdRecord; existed: boolean } {
    const r = this.mem.prepare(sessionId, generation, stepKey, txnId, step, now);
    if (!r.existed) this.append({ op: 'p', s: sessionId, g: generation, k: stepKey, t: txnId, st: step, ts: now });
    return r;
  }

  markWritten(sessionId: string, generation: number, stepKey: string): boolean {
    const ok = this.mem.markWritten(sessionId, generation, stepKey);
    if (ok) this.append({ op: 'w', s: sessionId, g: generation, k: stepKey });
    return ok;
  }

  markAcked(sessionId: string, generation: number, stepKey: string, result: string | undefined): boolean {
    const ok = this.mem.markAcked(sessionId, generation, stepKey, result);
    if (ok) this.append({ op: 'a', s: sessionId, g: generation, k: stepKey, r: result });
    return ok;
  }

  get(sessionId: string, generation: number, stepKey: string): CmdRecord | undefined {
    return this.mem.get(sessionId, generation, stepKey);
  }

  retry(sessionId: string, generation: number, stepKey: string): RetryDecision {
    return this.mem.retry(sessionId, generation, stepKey);
  }

  dropGeneration(sessionId: string, generation: number): void {
    this.append({ op: 'd', s: sessionId, g: generation });
    this.mem.dropGeneration(sessionId, generation);
  }

  evict(now: number): number {
    return this.mem.evict(now);
  }

  /** Rewrite the log from the live set (atomic temp+rename), bounding its growth. */
  compact(): void {
    const tmp = `${this.path}.tmp.${process.pid}`;
    const lines: string[] = [];
    for (const { sessionId, generation, record } of this.mem.entries()) {
      lines.push(JSON.stringify({ op: 'p', s: sessionId, g: generation, k: record.stepKey, t: record.txnId, st: record.step, ts: record.ts } satisfies LogOp));
      // markAcked goes PREPARED→ACKED directly, so a 'w' is needed ONLY for a
      // record whose current phase is WRITTEN (not for ACKED — p+a rebuilds it).
      if (record.phase === 'WRITTEN') lines.push(JSON.stringify({ op: 'w', s: sessionId, g: generation, k: record.stepKey } satisfies LogOp));
      if (record.phase === 'ACKED') lines.push(JSON.stringify({ op: 'a', s: sessionId, g: generation, k: record.stepKey, r: record.result } satisfies LogOp));
    }
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
    renameSync(tmp, this.path);
    this.fd = openSync(this.path, 'a');
    // A rename replaces the log wholesale, so an unrepairable partial record is
    // gone BY CONSTRUCTION — there is nothing left for a later append to fuse
    // onto, and holding the refusal past that point would be refusing over a
    // tail that no longer exists.
    this.appendFailure = null;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
