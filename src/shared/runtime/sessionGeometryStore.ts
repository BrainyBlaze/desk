// Last-measured session geometry (desk#62).
//
// A session's terminal size is knowable in exactly one place: a surface that
// actually rendered it and measured itself. Nothing else in Desk can derive it
// — the moor status descriptor (wire schema §5) carries pid, containment,
// replay coordinates and clocks, but NO rows/cols, so a re-adopting controller
// cannot ask the holder how big the child's pty is.
//
// That knowledge therefore has to be KEPT. This port records a client-measured
// geometry the moment it is applied, so a daemon restart can restore a session
// at the size it actually had instead of writing an invented one over it. A
// session no surface has ever measured has no record, and the absence is the
// honest answer: callers must treat "no record" as "unknown", never as a size.

/** A real moor geometry (wire schema §4): both dimensions measured, not preserve. */
export interface SessionGeometry {
  readonly rows: number;
  readonly cols: number;
}

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
   * The last geometry a real client measured for this session, or undefined
   * when none ever did. Undefined means UNKNOWN — never a size to fall back on.
   */
  get(sessionId: string): SessionGeometry | undefined;
  /**
   * Record a client-measured geometry. Called on every APPLIED resize (not at
   * shutdown: a daemon that is killed never runs shutdown code). A geometry
   * that is not a real §4 pair is refused rather than stored.
   */
  record(sessionId: string, geometry: { rows: number; cols: number }): void;
}

/** Process-local store — the default when no durable one is injected. */
export class InMemorySessionGeometryStore implements SessionGeometryStore {
  private readonly measured = new Map<string, SessionGeometry>();

  get(sessionId: string): SessionGeometry | undefined {
    return this.measured.get(sessionId);
  }

  record(sessionId: string, geometry: { rows: number; cols: number }): void {
    if (sessionId.length === 0 || !isRealSessionGeometry(geometry)) return;
    this.measured.set(sessionId, { rows: geometry.rows, cols: geometry.cols });
  }
}
