// CMD_CACHE (spec §6.10 / §4.4) — the durable per-(session,generation) command
// idempotency store. Pure logic; the daemon persists it fsync-on-write.
//
// Each command STEP (body or submit) gets a stable `stepKey`. A retry re-sends
// the SAME stepKey; the cache decides whether to (a) return the cached ACKED
// result (dedupe), (b) re-issue an ambiguous PREPARED/WRITTEN step (safe because
// the atch master is idempotent by key within the generation), or (c) REFUSE
// because the entry aged past the retry horizon (fail-closed — a replay whose
// dedupe proof is gone must not risk a double-submit). The guarantee is
// "deduped retries within the retained generation", NOT exactly-once.

export type CmdStep = 'body' | 'submit';

/**
 * Transport phase of one step (§6.10):
 *  - PREPARED — intent recorded, send not yet confirmed on the wire (AMBIGUOUS:
 *    it may or may not have landed).
 *  - WRITTEN  — the master confirmed the bytes were written (still pre-ACK for
 *    the higher-level result, but proven on the wire).
 *  - ACKED    — the COMMAND_ACK / native command-result arrived; `result` set.
 */
export type CmdPhase = 'PREPARED' | 'WRITTEN' | 'ACKED';

export interface CmdRecord {
  stepKey: string;
  txnId: string;
  step: CmdStep;
  phase: CmdPhase;
  result?: string;
  /** Creation time — the retry horizon is measured from here and never bumped. */
  ts: number;
}

export interface CmdCacheConfig {
  /** Retry horizon in ms; past it an entry is evicted and replays are refused. */
  horizonMs: number;
  /** Max retained entries per (session, generation); oldest evicted beyond it. */
  maxEntries: number;
}

/** Proposed defaults (§6.10, [CHECK]): 10 minutes / 512 entries per session. */
export const DEFAULT_CMD_CACHE_CONFIG: Readonly<CmdCacheConfig> = Object.freeze({
  horizonMs: 600_000,
  maxEntries: 512
});

export type RetryDecision =
  | { action: 'return-cached'; result: string | undefined }
  | { action: 'reissue'; phase: CmdPhase }
  | { action: 'refuse'; reason: 'horizon-exhausted' };

/**
 * In-memory reference CMD_CACHE — the executable spec. Partitioned by
 * (session, generation); a new generation supersedes the old (its idempotency
 * keys describe a dead process), so drop the partition on generation change.
 */
export class InMemoryCmdCache {
  private readonly cfg: CmdCacheConfig;
  /** partition key `${sessionId}\u0000${generation}` → stepKey → record. */
  private partitions = new Map<string, Map<string, CmdRecord>>();

  constructor(cfg: CmdCacheConfig = DEFAULT_CMD_CACHE_CONFIG) {
    this.cfg = cfg;
  }

  private key(sessionId: string, generation: number): string {
    return `${sessionId}\u0000${generation}`;
  }
  private partition(sessionId: string, generation: number): Map<string, CmdRecord> {
    const k = this.key(sessionId, generation);
    let p = this.partitions.get(k);
    if (p === undefined) {
      p = new Map<string, CmdRecord>();
      this.partitions.set(k, p);
    }
    return p;
  }

  /**
   * Record intent for a step (PREPARED). Idempotent: if the stepKey already
   * exists (crash-recovery re-prepare, or a retry that reached prepare), the
   * existing record is returned unchanged with `existed:true` so the caller
   * reads its real phase rather than resetting it to PREPARED.
   */
  prepare(
    sessionId: string,
    generation: number,
    stepKey: string,
    txnId: string,
    step: CmdStep,
    now: number
  ): { record: CmdRecord; existed: boolean } {
    const p = this.partition(sessionId, generation);
    const existing = p.get(stepKey);
    if (existing !== undefined) return { record: existing, existed: true };
    const record: CmdRecord = { stepKey, txnId, step, phase: 'PREPARED', ts: now };
    p.set(stepKey, record);
    return { record, existed: false };
  }

  /** Advance PREPARED → WRITTEN (wire-proven). No-op if absent or already past. */
  markWritten(sessionId: string, generation: number, stepKey: string): boolean {
    const rec = this.partition(sessionId, generation).get(stepKey);
    if (rec === undefined) return false;
    if (rec.phase === 'PREPARED') rec.phase = 'WRITTEN';
    return true;
  }

  /** Advance to ACKED and store the result. No-op if absent. */
  markAcked(sessionId: string, generation: number, stepKey: string, result: string | undefined): boolean {
    const rec = this.partition(sessionId, generation).get(stepKey);
    if (rec === undefined) return false;
    rec.phase = 'ACKED';
    rec.result = result;
    return true;
  }

  get(sessionId: string, generation: number, stepKey: string): CmdRecord | undefined {
    return this.partition(sessionId, generation).get(stepKey);
  }

  /**
   * Decide a RE-SEND of a known stepKey (§6.10). Absent record → the entry aged
   * out of the horizon (or the generation was dropped): its dedupe proof is
   * gone, so REFUSE (fail-closed). ACKED → return the cached result (dedupe).
   * PREPARED/WRITTEN → re-issue is safe (idempotent by key on the master).
   */
  retry(sessionId: string, generation: number, stepKey: string): RetryDecision {
    const rec = this.partition(sessionId, generation).get(stepKey);
    if (rec === undefined) return { action: 'refuse', reason: 'horizon-exhausted' };
    if (rec.phase === 'ACKED') return { action: 'return-cached', result: rec.result };
    return { action: 'reissue', phase: rec.phase };
  }

  /** Drop a whole generation's partition (call on generation change). */
  dropGeneration(sessionId: string, generation: number): void {
    this.partitions.delete(this.key(sessionId, generation));
  }

  /** Enumerate all live records with their (session, generation) — for durable-log compaction. */
  *entries(): IterableIterator<{ sessionId: string; generation: number; record: CmdRecord }> {
    const SEP = String.fromCharCode(0); // must match key()'s \u0000 separator
    for (const [pk, p] of this.partitions) {
      const sp = pk.lastIndexOf(SEP);
      const sessionId = pk.slice(0, sp);
      const generation = Number(pk.slice(sp + 1));
      for (const record of p.values()) yield { sessionId, generation, record };
    }
  }

  /**
   * Enforce the horizon: evict records older than `horizonMs`, then trim each
   * partition to `maxEntries` (oldest by ts first). Returns the eviction count.
   * The daemon calls this on a timer; eviction is what makes a later replay
   * fail closed (retry → refuse).
   */
  evict(now: number): number {
    let evicted = 0;
    for (const [pk, p] of this.partitions) {
      for (const [sk, rec] of p) {
        if (rec.ts + this.cfg.horizonMs <= now) {
          p.delete(sk);
          evicted++;
        }
      }
      if (p.size > this.cfg.maxEntries) {
        const ordered = [...p.values()].sort((a, b) => a.ts - b.ts);
        const drop = p.size - this.cfg.maxEntries;
        for (let i = 0; i < drop; i++) {
          p.delete(ordered[i].stepKey);
          evicted++;
        }
      }
      if (p.size === 0) this.partitions.delete(pk);
    }
    return evicted;
  }
}
