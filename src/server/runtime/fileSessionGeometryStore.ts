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
    this.replay();
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

  /** Rebuild the last-wins map; repair only a malformed, unterminated final line. */
  private replay(): void {
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const line = bytes.subarray(offset, end).toString('utf8');
      if (newline === -1) {
        // An unterminated tail is a torn write: drop it durably so the next
        // append starts on a clean record boundary.
        this.truncateTail(offset);
        return;
      }
      this.absorb(line);
      offset = newline + 1;
    }
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
    const geometry = { rows: Number(record.r), cols: Number(record.c) };
    if (!isRealSessionGeometry(geometry)) return;
    this.measured.set(record.s, geometry);
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
