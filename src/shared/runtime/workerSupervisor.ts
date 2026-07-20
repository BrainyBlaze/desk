// xterm-worker supervisor (spec §3.3). Pure state machine — no process/fs. The
// daemon wraps it around real worker child processes; here it decides admission
// (the fail-closed MAX_LIVE_WORKERS cap), sharding, restart backoff, and
// visible-first restore batching. Keeping it pure makes the resource-safety
// rules unit-testable without spawning anything.

export interface SupervisorConfig {
  /** Hard cap on LIVE headless emulators per host (§3.3). Beyond it, admission
   *  FAILS CLOSED — new sessions are refused with a surfaced reason, never
   *  silently over-committed. */
  maxLiveWorkers: number;
  /** Shard the headless emulators across N worker processes once the live count
   *  exceeds this (§3.3: shard at > MAX_LIVE_WORKERS/2). Below it, one process. */
  shardThreshold: number;
  /** Parallel checkpoint-restore fan-out (§3.3), visible-first. */
  restoreConcurrency: number;
  /** Restart backoff: delay = min(baseMs * factor^(attempt-1), maxMs). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffFactor: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: Readonly<SupervisorConfig> = Object.freeze({
  maxLiveWorkers: 256,
  shardThreshold: 128, // MAX_LIVE_WORKERS / 2
  restoreConcurrency: 8,
  backoffBaseMs: 250,
  backoffMaxMs: 30_000,
  backoffFactor: 2
});

export type AdmitResult =
  | { ok: true; shardIndex: number; live: number }
  | { ok: false; reason: 'cap-exceeded'; live: number; cap: number };

interface BackoffState {
  attempt: number;
  nextRetryAt: number;
}

/**
 * Tracks live emulators and enforces the §3.3 resource rules. `admit` is the
 * single chokepoint: it refuses past the cap (fail-closed) and assigns a shard.
 * Sharding is recomputed on the CURRENT live count so a session's shardIndex is
 * stable for a given population size (the daemon re-plans placement when the
 * shard count changes).
 */
export class WorkerSupervisor {
  private readonly cfg: SupervisorConfig;
  private readonly live = new Set<string>();
  private readonly backoff = new Map<string, BackoffState>();

  constructor(cfg: SupervisorConfig = DEFAULT_SUPERVISOR_CONFIG) {
    this.cfg = cfg;
  }

  get liveCount(): number {
    return this.live.size;
  }

  /** Number of worker PROCESSES for the current population (§3.3 sharding). */
  shardCount(live: number = this.live.size): number {
    if (live <= this.cfg.shardThreshold) return 1;
    return Math.ceil(live / this.cfg.shardThreshold);
  }

  /**
   * Admit a new live emulator. Idempotent for an already-live session (returns
   * ok with its current shard). Fails closed once the cap is reached.
   */
  admit(sessionId: string, _now: number): AdmitResult {
    if (this.live.has(sessionId)) {
      return { ok: true, shardIndex: this.shardIndexOf(sessionId), live: this.live.size };
    }
    if (this.live.size >= this.cfg.maxLiveWorkers) {
      return { ok: false, reason: 'cap-exceeded', live: this.live.size, cap: this.cfg.maxLiveWorkers };
    }
    this.live.add(sessionId);
    this.backoff.delete(sessionId); // a successful (re)admit clears backoff
    return { ok: true, shardIndex: this.shardIndexOf(sessionId), live: this.live.size };
  }

  /** Retire a live emulator (session ended or worker process died for good). */
  release(sessionId: string): void {
    this.live.delete(sessionId);
  }

  /**
   * Record a worker crash and compute the next retry time with bounded
   * exponential backoff. The session is NOT counted live while awaiting restart
   * (release it first if it was live). Returns the attempt number + nextRetryAt.
   */
  recordCrash(sessionId: string, now: number): { attempt: number; nextRetryAt: number } {
    const prev = this.backoff.get(sessionId);
    const attempt = (prev?.attempt ?? 0) + 1;
    const delay = Math.min(this.cfg.backoffBaseMs * this.cfg.backoffFactor ** (attempt - 1), this.cfg.backoffMaxMs);
    const state = { attempt, nextRetryAt: now + delay };
    this.backoff.set(sessionId, state);
    return state;
  }

  /** Is a crashed session eligible to restart yet (its backoff elapsed)? */
  canRestart(sessionId: string, now: number): boolean {
    const state = this.backoff.get(sessionId);
    return state === undefined || now >= state.nextRetryAt;
  }

  /**
   * Batch sessions for restore, visible-first, `restoreConcurrency` per wave
   * (§3.3). `visible` sessions lead so the focused screens repaint first.
   */
  planRestore(sessions: readonly { sessionId: string; visible: boolean }[]): string[][] {
    const ordered = [...sessions].sort((a, b) => Number(b.visible) - Number(a.visible)).map((s) => s.sessionId);
    const waves: string[][] = [];
    for (let i = 0; i < ordered.length; i += this.cfg.restoreConcurrency) {
      waves.push(ordered.slice(i, i + this.cfg.restoreConcurrency));
    }
    return waves;
  }

  /** Deterministic shard placement: hash the sessionId into [0, shardCount). */
  private shardIndexOf(sessionId: string): number {
    const shards = this.shardCount();
    if (shards <= 1) return 0;
    let h = 2166136261;
    for (let i = 0; i < sessionId.length; i++) {
      h ^= sessionId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % shards;
  }
}
