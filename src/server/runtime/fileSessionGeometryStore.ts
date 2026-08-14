// Durable last-measured session geometry (desk#62). The on-disk backing behind
// SessionGeometryStore: the only way a daemon that comes back can know how big
// a surviving session's terminal actually is, because the moor status
// descriptor does not carry geometry and the browser may not be attached.
//
// Format: newline-delimited JSON records {s: sessionId, c: cols, r: rows},
// appended when a client-measured geometry CHANGES (so a resize drag costs one
// record, not one per frame) and replayed last-wins on startup. A torn final
// line from a hard kill is truncated before the append handle opens, so the
// next record cannot concatenate with it.
//
// Append-only would grow without bound: a drag still writes one record per
// distinct size, and nothing prunes a session that no longer exists. So replay
// compacts — whenever the log carries more records than the sessions it
// describes, the reconstructed last-wins map is written back in place of the
// history. The rule has no tuned threshold to defend: a superseded record is
// dead weight on every subsequent startup, so it goes.
//
// Startup alone is not enough, though: a daemon that runs for weeks never
// reaches that check. So the same compaction runs ONLINE once the appends
// since the last attempt pass a threshold relative to the live set (see
// compactionThreshold), and `forget` runs it to evict a retired session — the
// append-only format has no way to express a deletion.
//
// Deliberately NOT fsync'd per record: this is remembered knowledge, not
// fence-critical state. The failure it must survive is a killed daemon, and the
// kernel's page cache survives that; a machine crash may lose the newest record
// and the session simply reads as unmeasured — which is the honest answer, not
// a wrong size.

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import {
  isRealSessionGeometry,
  type SessionGeometry,
  type SessionGeometryStore
} from '../../shared/runtime/sessionGeometryStore.js';

export class FileSessionGeometryStore implements SessionGeometryStore {
  private readonly path: string;
  /** In-memory truth: what this daemon incarnation serves, disk or no disk. */
  private readonly measured = new Map<string, SessionGeometry>();
  /**
   * What we believe actually REACHED the disk. The dedupe measures against
   * this, never against `measured`: an append failure is swallowed so a full
   * state root cannot break a live resize, and if the dedupe were measured
   * against memory the two would diverge permanently — memory holds the new
   * size, the file holds the old one, and every later record of that same
   * geometry is suppressed as "unchanged" against a value the disk never got.
   * The durable record would never catch up, and a restart would restore the
   * stale size.
   */
  private readonly persisted = new Map<string, SessionGeometry>();
  private fd: number | null = null;
  /** Appends accumulated since the last compaction ATTEMPT (see compactionThreshold). */
  private appendsSinceCompactionAttempt = 0;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const records = this.replay();
    // Whatever the log carries beyond one record per live session is already
    // dead weight; it counts against the online bound from the first append,
    // so a compaction that could not run at startup is not started from zero.
    this.appendsSinceCompactionAttempt = Math.max(0, records - this.measured.size);
    if (records > this.measured.size) this.compact();
    else this.syncPersistedFromMeasured();
    this.fd = openSync(path, 'a');
  }

  get(sessionId: string): SessionGeometry | undefined {
    return this.measured.get(sessionId);
  }

  record(sessionId: string, geometry: { rows: number; cols: number }): void {
    // A geometry that is not a real §4 pair is not knowledge — refuse it rather
    // than persist something a later restore would apply as if it were measured.
    if (sessionId.length === 0 || !isRealSessionGeometry(geometry)) return;
    const next: SessionGeometry = { rows: geometry.rows, cols: geometry.cols };
    // Memory first and unconditionally: this is what serves the live session.
    this.measured.set(sessionId, next);
    const durable = this.persisted.get(sessionId);
    if (durable?.rows === next.rows && durable.cols === next.cols) return;
    if (this.fd === null) return;
    try {
      writeSync(
        this.fd,
        `${JSON.stringify({ s: sessionId, c: next.cols, r: next.rows })}\n`
      );
    } catch {
      // A full or read-only state root must not break a live resize; the
      // in-memory value still serves this daemon incarnation. `persisted` is
      // left STALE on purpose, so the next record for this session writes
      // again even when the geometry has not changed since.
      return;
    }
    this.persisted.set(sessionId, next);
    this.appendsSinceCompactionAttempt += 1;
    if (this.appendsSinceCompactionAttempt > this.compactionThreshold()) this.compact();
  }

  /**
   * The session ended: its remembered size describes nothing any more. The
   * append-only format cannot express a deletion, so the log is rewritten
   * without it — the only way a session ever leaves the file.
   */
  forget(sessionId: string): void {
    const wasMeasured = this.measured.delete(sessionId);
    const wasPersisted = this.persisted.delete(sessionId);
    // Nothing to evict: rewriting the log here would burn a full file rewrite
    // on every retire of a session no surface ever measured.
    if (!wasMeasured && !wasPersisted) return;
    this.compact();
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  /**
   * Rebuild the last-wins map; repair only a malformed, unterminated final
   * line. Returns how many terminated records the log held, which is what
   * decides whether any of them are now dead weight.
   */
  private replay(): number {
    if (!existsSync(this.path)) return 0;
    const bytes = readFileSync(this.path);
    let offset = 0;
    let records = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        // An unterminated tail is a torn write: drop it durably so the next
        // append starts on a clean record boundary.
        this.truncateTail(offset);
        return records;
      }
      this.absorb(bytes.subarray(offset, newline).toString('utf8'));
      records += 1;
      offset = newline + 1;
    }
    return records;
  }

  private absorb(line: string): void {
    if (line.length === 0) return;
    let record: { s?: unknown; c?: unknown; r?: unknown };
    try {
      record = JSON.parse(line) as { s?: unknown; c?: unknown; r?: unknown };
    } catch {
      return; // an unreadable record is an unmeasured session, not a fatal error
    }
    if (typeof record.s !== 'string' || record.s.length === 0) return;
    // Typed BEFORE it is measured against the wire range: `Number('48')` and
    // `Number(true)` both survive coercion, and the second one would install a
    // 1x1 "measured" geometry. A dimension that is not already a number is not
    // a dimension.
    if (typeof record.r !== 'number' || typeof record.c !== 'number') return;
    const geometry = { rows: record.r, cols: record.c };
    if (!isRealSessionGeometry(geometry)) return;
    this.measured.set(record.s, geometry);
  }

  /**
   * How many appends may accumulate before the log is rewritten.
   *
   * RELATIVE, not a bare constant. One compaction costs a rewrite of
   * `measured.size` records, so letting 4x that many appends accumulate first
   * amortises the rewrite to about a quarter of a record written per append —
   * the same ratio for a two-session laptop and a five-hundred-session fleet —
   * and bounds the log at roughly 5x the live set. A bare constant gets both
   * ends wrong: 64 would rewrite a 500-session fleet every few resizes, while
   * a constant large enough for that fleet would leave a small one carrying a
   * log two orders of magnitude longer than the sessions it describes.
   *
   * The floor is the small-fleet half of the same argument: at one live
   * session 4x1 would rewrite the file every fifth step of a window drag,
   * which costs far more than the four dead records it reclaims. 64 keeps the
   * worst case a 64-line file.
   */
  private compactionThreshold(): number {
    return Math.max(64, 4 * this.measured.size);
  }

  /**
   * Replace the log with the map it reconstructs to. Written beside the log and
   * renamed over it, so a failure mid-write leaves the original history intact;
   * and if the rename itself is lost to a machine crash, the surviving file is
   * still the older, longer log — never a truncated one.
   */
  private compact(): void {
    const scratch = `${this.path}.compact`;
    let body = '';
    for (const [sessionId, geometry] of this.measured) {
      body += `${JSON.stringify({ s: sessionId, c: geometry.cols, r: geometry.rows })}\n`;
    }
    // The append handle names an INODE, and the rename below puts a different
    // one at this path. Holding the old handle across it would keep appending
    // into the unlinked file — writes that vanish with no error at all — so
    // the handle is dropped first and re-opened on whatever the path now names.
    const wasOpen = this.fd !== null;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    try {
      writeFileSync(scratch, body, { mode: 0o600 });
      renameSync(scratch, this.path);
      // The file now IS the map, so what reached the disk is exactly `measured`.
      this.syncPersistedFromMeasured();
    } catch {
      // Compaction is housekeeping, never a precondition for serving: a
      // read-only or full state root keeps the long log and the correct map.
      try {
        unlinkSync(scratch);
      } catch {
        // nothing to clean up
      }
    }
    // Counted from the ATTEMPT, not the success: a failed rewrite backs off a
    // full threshold instead of retrying on every subsequent append.
    this.appendsSinceCompactionAttempt = 0;
    if (wasOpen) {
      try {
        this.fd = openSync(this.path, 'a');
      } catch {
        // The log has become unwritable. The in-memory map keeps serving this
        // incarnation and every later append is a no-op, never a throw.
        this.fd = null;
      }
    }
  }

  private syncPersistedFromMeasured(): void {
    this.persisted.clear();
    for (const [sessionId, geometry] of this.measured) this.persisted.set(sessionId, geometry);
  }

  private truncateTail(offset: number): void {
    const handle = openSync(this.path, 'r+');
    try {
      ftruncateSync(handle, offset);
    } finally {
      closeSync(handle);
    }
  }
}
