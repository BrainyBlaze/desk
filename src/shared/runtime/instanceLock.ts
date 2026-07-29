// desk-runtime single-instance lock (spec §3.2). Pure DECISION logic; the daemon
// supplies the fs/process adapter (read/write the lockfile atomically, probe a
// pid via /proc). The lock is one-per-per-user-runtime and is ensured lazily by
// serve/up/attach/capture. A PID alone is unsafe (PID reuse after a crash), so
// the record pins the holder's process START-TIME too: only alive AND
// start-time-matching means the lock is genuinely held.

/** The on-disk lock record (0700 dir / 0600 file per §3.2). */
export interface LockRecord {
  pid: number;
  /** Holder process start-time (e.g. /proc/<pid>/stat field 22) — PID-reuse guard. */
  startTime: number;
  /** The runtime control socket the holder is serving (0600). */
  sockPath: string;
  /** Daemon protocol version, so a client can detect a version mismatch. */
  version: string;
}

/** A live probe of the recorded pid (the daemon's fs/process adapter fills this). */
export interface PidProbe {
  /** Is the pid a currently-running process (kill(pid,0) succeeded)? */
  alive: boolean;
  /** Its process start-time, or null if unreadable / not alive. */
  startTime: number | null;
}

export type LockDecision =
  | { action: 'acquire'; reason: 'no-lock' | 'stale-dead-pid' | 'stale-pid-reused' | 'stale-unreadable' }
  | { action: 'defer'; holder: LockRecord }
  | { action: 'is-self' };

/**
 * Decide what to do about an existing lock (§3.2). Pure — the caller performs
 * the probe and, on `acquire`, atomically writes its own record (O_CREAT|O_EXCL
 * or rename-into-place) then re-reads to confirm it won the race.
 *
 *  - no existing record                         → acquire (no-lock)
 *  - record is us (pid+startTime match self)    → is-self (already ensured)
 *  - recorded pid not alive                     → acquire (stale-dead-pid)
 *  - pid alive but start-time differs (reused)  → acquire (stale-pid-reused)
 *  - pid alive, start-time unreadable           → acquire (stale-unreadable) —
 *    fail-forward: an unverifiable holder is treated as stale so the runtime can
 *    always be (re)established; the atomic write + re-read guards the real race.
 *  - pid alive and start-time matches           → defer (a live peer owns it)
 */
export function decideLock(existing: LockRecord | null, self: { pid: number; startTime: number }, probe: PidProbe): LockDecision {
  if (existing === null) return { action: 'acquire', reason: 'no-lock' };
  if (existing.pid === self.pid && existing.startTime === self.startTime) return { action: 'is-self' };
  if (!probe.alive) return { action: 'acquire', reason: 'stale-dead-pid' };
  if (probe.startTime === null) return { action: 'acquire', reason: 'stale-unreadable' };
  if (probe.startTime !== existing.startTime) return { action: 'acquire', reason: 'stale-pid-reused' };
  return { action: 'defer', holder: existing };
}

/**
 * Decide whether an explicit `stop` may proceed (§3.2/§11.4: runtime stop
 * refuses while sessions live unless `--forced`). Pure.
 */
export function decideStop(liveSessions: number, forced: boolean): { action: 'stop' } | { action: 'refuse'; liveSessions: number } {
  if (liveSessions > 0 && !forced) return { action: 'refuse', liveSessions };
  return { action: 'stop' };
}
