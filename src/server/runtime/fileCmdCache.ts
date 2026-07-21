// Durable CMD_CACHE (spec §6.10). The fsync'd backing behind the delivery
// idempotency store, so a within-horizon retry still dedups against a cached
// ACKED result across a daemon RESTART (past-horizon entries stay fail-closed —
// losing the cache degrades only to the safe "refuse" default, never a double
// submit). Wraps InMemoryCmdCache: each state transition is appended + fsync'd;
// on startup the log is replayed (then evicted) to rebuild the live state;
// compact() rewrites the log from the live set to bound its growth.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
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

  constructor(path: string, cfg: CmdCacheConfig = DEFAULT_CMD_CACHE_CONFIG, now?: number) {
    this.path = path;
    this.mem = new InMemoryCmdCache(cfg);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.replay(now);
    this.fd = openSync(path, 'a');
  }

  private replay(now?: number): void {
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
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

  private append(o: LogOp): void {
    if (this.fd === null) this.fd = openSync(this.path, 'a');
    writeSync(this.fd, JSON.stringify(o) + '\n');
    fsyncSync(this.fd);
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
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
