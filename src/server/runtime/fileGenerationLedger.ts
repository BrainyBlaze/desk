// Durable generation-ledger store (spec §4.8.1). The fsync'd, append-only,
// per-user backing behind GenerationLedger — the fence-critical state that MUST
// survive a daemon restart (a reused sessionId after a crash must still get a
// higher generation, never a reset). Node stdlib only.
//
// Format: newline-delimited JSON records {s: sessionId, g: generation}, appended
// and fsync'd BEFORE the allocation is returned (so the caller — the daemon —
// can then write the registry + spawn, per the §4.8.1 order). On startup the log
// is replayed to rebuild the max-per-sessionId map. A torn final line (partial
// write from a crash) is durably truncated before append mode is opened, so the
// next record cannot concatenate with it and disappear from a later replay.

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import { type GenerationLedgerStore } from '../../shared/controlPlane/generationLedger.js';

export class FileGenerationLedgerStore implements GenerationLedgerStore {
  private readonly path: string;
  private readonly max = new Map<string, number>();
  private fd: number | null = null;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.replay();
    this.fd = openSync(path, 'a'); // append handle for the process lifetime
  }

  /** Rebuild the max map and repair only a malformed, unterminated final tail. */
  private replay(): void {
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const next = newline === -1 ? bytes.length : newline + 1;
      const line = bytes.subarray(offset, end).toString('utf8');
      if (line.length === 0) {
        offset = next;
        continue;
      }
      let rec: { s?: unknown; g?: unknown };
      try {
        rec = JSON.parse(line);
      } catch {
        if (newline === -1) {
          this.truncateTail(offset);
          return;
        }
        throw new Error(
          `corrupt generation ledger at byte ${offset}: malformed interior record`
        );
      }
      if (
        typeof rec.s !== 'string' ||
        rec.s.length === 0 ||
        !Number.isSafeInteger(rec.g) ||
        (rec.g as number) < 1
      ) {
        throw new Error(
          `corrupt generation ledger at byte ${offset}: invalid generation record`
        );
      }
      const generation = rec.g as number;
      const prev = this.max.get(rec.s) ?? 0;
      if (generation > prev) this.max.set(rec.s, generation);
      if (newline === -1) {
        this.appendRecordSeparator();
      }
      offset = next;
    }
  }

  private truncateTail(offset: number): void {
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private appendRecordSeparator(): void {
    const fd = openSync(this.path, 'a');
    try {
      if (writeSync(fd, '\n') !== 1) {
        throw new Error('generation ledger separator repair made no progress');
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  read(sessionId: string): number {
    return this.max.get(sessionId) ?? 0;
  }

  write(sessionId: string, generation: number): void {
    const prev = this.max.get(sessionId) ?? 0;
    if (generation <= prev) return; // monotonic guard — never lower a recorded max
    if (this.fd === null) this.fd = openSync(this.path, 'a');
    const line = Buffer.from(`${JSON.stringify({ s: sessionId, g: generation })}\n`);
    let written = 0;
    while (written < line.length) {
      const count = writeSync(this.fd, line, written, line.length - written);
      if (count <= 0) {
        throw new Error('generation ledger append made no progress');
      }
      written += count;
    }
    fsyncSync(this.fd); // durable BEFORE the allocation is used (§4.8.1 order)
    this.max.set(sessionId, generation);
  }

  /** Close the append handle (daemon shutdown). */
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
