// Controller / resize lease (spec §7.5/§7.9). Pure state machine. Exactly one
// focused surface holds the controller lease: only the owner may drive INPUT and
// RESIZE; hidden surfaces are observers. Handoff is explicit or forced, TTL
// auto-releases a dead owner, and `epoch` increments on every handoff so
// in-flight replies from a prior owner are fenced (dropped) — the same
// lease_epoch that fences TERMINAL_REPLY frames (§7.7).

export const DEFAULT_LEASE_TTL_MS = 15_000; // §7.9 heartbeat TTL

export interface LeaseState {
  /** The current controller's connection id, or null if unheld. */
  ownerConn: string | null;
  /** Increments on every HANDOFF (grant to a new owner). Fences stale replies. */
  epoch: number;
  /** Last heartbeat from the owner (for TTL auto-release). */
  lastHeartbeat: number;
}

export function createLeaseState(): LeaseState {
  return { ownerConn: null, epoch: 0, lastHeartbeat: 0 };
}

export type ClaimResult =
  | { granted: true; epoch: number; ackOffset: bigint; demoted: string | null }
  | { granted: false; reason: 'held'; owner: string; epoch: number };

/**
 * Claim the lease (§7.9 LEASE_CLAIM → LEASE_GRANT). `ackOffset` is the current
 * output offset the new controller must replay to before driving (catch-up).
 *  - unheld            → grant, epoch++ (a handoff from no-one).
 *  - same conn re-claim → re-grant, refresh heartbeat, epoch UNCHANGED (no handoff).
 *  - held, not forced  → DENIED (someone else controls).
 *  - held, forced      → demote the current owner (it gets a controller{released}
 *    EVENT), grant to the claimant, epoch++.
 */
export function claim(
  s: LeaseState,
  conn: string,
  forced: boolean,
  now: number,
  ackOffset: bigint
): ClaimResult {
  if (s.ownerConn === conn) {
    s.lastHeartbeat = now; // re-claim by the same owner — no handoff
    return { granted: true, epoch: s.epoch, ackOffset, demoted: null };
  }
  if (s.ownerConn === null) {
    s.ownerConn = conn;
    s.epoch += 1;
    s.lastHeartbeat = now;
    return { granted: true, epoch: s.epoch, ackOffset, demoted: null };
  }
  if (!forced) {
    return { granted: false, reason: 'held', owner: s.ownerConn, epoch: s.epoch };
  }
  const demoted = s.ownerConn;
  s.ownerConn = conn;
  s.epoch += 1;
  s.lastHeartbeat = now;
  return { granted: true, epoch: s.epoch, ackOffset, demoted };
}

/** Release the lease if `conn` holds it. The next grant bumps the epoch. */
export function release(s: LeaseState, conn: string): boolean {
  if (s.ownerConn !== conn) return false;
  s.ownerConn = null;
  return true;
}

/** Refresh the owner's heartbeat (keeps the lease alive under TTL). */
export function heartbeat(s: LeaseState, conn: string, now: number): boolean {
  if (s.ownerConn !== conn) return false;
  s.lastHeartbeat = now;
  return true;
}

/**
 * TTL sweep (§7.9): a disconnected owner whose heartbeat lapsed auto-releases,
 * so the daemon can reclaim and catch up. Returns the reclaimed conn or null.
 */
export function sweepTtl(s: LeaseState, now: number, ttlMs: number = DEFAULT_LEASE_TTL_MS): string | null {
  if (s.ownerConn === null) return null;
  if (now - s.lastHeartbeat <= ttlMs) return null;
  const reclaimed = s.ownerConn;
  s.ownerConn = null;
  return reclaimed;
}

/** Only the lease owner may drive RESIZE / INPUT (§7.5). */
export function canControl(s: LeaseState, conn: string): boolean {
  return s.ownerConn === conn;
}

/**
 * Fence a reply/resize by its lease_epoch (§7.7/§7.9): a frame carrying an epoch
 * other than the current one is from a prior owner and MUST be dropped.
 */
export function isFencedEpoch(s: LeaseState, frameEpoch: number): boolean {
  return frameEpoch !== s.epoch;
}
