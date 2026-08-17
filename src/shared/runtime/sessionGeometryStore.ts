// Last-COMMANDED session geometry (desk#62, semantics sharpened by desk#68).
//
// This journal holds the last valid geometry Desk commanded for a session —
// what the owning surface asked for and the daemon sent — NOT the pty's
// measured truth. Moor is the authority on what the child's pty actually is;
// Desk never hears it back, because the moor status descriptor (wire schema §5)
// carries pid, containment, replay coordinates and clocks, but NO rows/cols.
// Until the protocol carries the holder's pair, the last commanded size is the
// best available approximation, and it is the only geometry Desk may honestly
// persist.
//
// So the journal is KEPT: this port records a geometry the moment it is
// commanded, and a daemon restart restores a session at the last commanded
// size instead of writing an invented one over it. A session Desk never
// commanded a size for has no record, and the absence is the honest answer:
// callers must treat "no record" as "unknown", never as a size.

/** A real moor geometry (wire schema §4): both dimensions explicit, not preserve. */
export interface SessionGeometry {
  readonly rows: number;
  readonly cols: number;
}

/**
 * The size a session is created at when no viewer has measured anything yet:
 * moor creates a session with no viewer at exactly 80 columns by 24 rows
 * (moor spec §4.3). Desk commands this same size at provision — it is policy,
 * not a measurement — and the first real viewer replaces it with a RESIZE. It
 * is the one place this constant lives; a caller that wants a real viewport
 * must have measured one.
 */
export const SESSION_CREATION_GEOMETRY: SessionGeometry = { rows: 24, cols: 80 };

/** Moor wire schema §4: each dimension 1..32767, product at most 2,000,000. */
export function isRealSessionGeometry(value: {
  rows: number;
  cols: number;
}): value is SessionGeometry {
  const { rows, cols } = value;
  return (
    Number.isInteger(rows) &&
    Number.isInteger(cols) &&
    rows >= 1 &&
    rows <= 32_767 &&
    cols >= 1 &&
    cols <= 32_767 &&
    rows * cols <= 2_000_000
  );
}

export interface SessionGeometryStore {
  /**
   * The last geometry Desk commanded for this session, or undefined when it
   * never commanded one. Undefined means UNKNOWN — never a size to fall back
   * on. Read a record as "what the owner last asked for", never as "the child
   * is at this size now" — moor owns that truth.
   */
  get(sessionId: string): SessionGeometry | undefined;
  /**
   * Record a geometry the moment it is COMMANDED (not at shutdown: a daemon
   * that is killed never runs shutdown code). A geometry that is not a real
   * §4 pair is refused rather than stored.
   */
  record(sessionId: string, geometry: { rows: number; cols: number }): void;
  /**
   * The session ENDED — drop what was remembered about it. Called from the one
   * terminal end of a session (DaemonCore.retire), never from a daemon detach
   * or shutdown: a holder that outlives the daemon must come back at the size
   * it has, which is the whole point of remembering. Without this, a durable
   * store keeps one record for every session that ever existed.
   */
  forget(sessionId: string): void;
}

/** Process-local store — the default when no durable one is injected. */
export class InMemorySessionGeometryStore implements SessionGeometryStore {
  private readonly commanded = new Map<string, SessionGeometry>();

  get(sessionId: string): SessionGeometry | undefined {
    return this.commanded.get(sessionId);
  }

  record(sessionId: string, geometry: { rows: number; cols: number }): void {
    if (sessionId.length === 0 || !isRealSessionGeometry(geometry)) return;
    this.commanded.set(sessionId, { rows: geometry.rows, cols: geometry.cols });
  }

  forget(sessionId: string): void {
    this.commanded.delete(sessionId);
  }
}
