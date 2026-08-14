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
  private readonly measured = new Map<string, SessionGeometry>();
  private fd: number | null = null;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const records = this.replay();
    if (records > this.measured.size) this.compact();
    this.fd = openSync(path, 'a');
  }

  get(sessionId: string): SessionGeometry | undefined {
    return this.measured.get(sessionId);
  }

  record(sessionId: string, geometry: { rows: number; cols: number }): void {
    // A geometry that is not a real §4 pair is not knowledge — refuse it rather
    // than persist something a later restore would apply as if it were measured.
    if (sessionId.length === 0 || !isRealSessionGeometry(geometry)) return;
    const previous = this.measured.get(sessionId);
    if (previous?.rows === geometry.rows && previous.cols === geometry.cols) return;
    const next: SessionGeometry = { rows: geometry.rows, cols: geometry.cols };
    this.measured.set(sessionId, next);
    if (this.fd === null) return;
    try {
      writeSync(
        this.fd,
        `${JSON.stringify({ s: sessionId, c: next.cols, r: next.rows })}\n`
      );
    } catch {
      // A full or read-only state root must not break a live resize; the
      // in-memory value still serves this daemon incarnation.
    }
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
    try {
      writeFileSync(scratch, body, { mode: 0o600 });
      renameSync(scratch, this.path);
    } catch {
      // Compaction is housekeeping, never a precondition for serving: a
      // read-only or full state root keeps the long log and the correct map.
      try {
        unlinkSync(scratch);
      } catch {
        // nothing to clean up
      }
    }
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
