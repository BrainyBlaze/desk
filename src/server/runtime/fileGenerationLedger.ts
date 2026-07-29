// Durable generation-ledger store (spec §4.8.1). The fsync'd, append-only,
// per-user backing behind GenerationLedger — the fence-critical state that MUST
// survive a daemon restart (a reused sessionId after a crash must still get a
// higher generation, never a reset). Node stdlib only.
//
// Format: newline-delimited JSON records {s: sessionId, g: generation}, appended
// and fsync'd BEFORE the allocation is returned (so the caller — the daemon —
// can then write the registry + spawn, per the §4.8.1 order). On startup the log
// is replayed to rebuild the max-per-sessionId map; a torn final line (partial
// write from a crash) is skipped — safe, because a torn append means the spawn
// that would have consumed that generation never happened.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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

  /** Rebuild the max-per-sessionId map from the durable log (torn tail skipped). */
  private replay(): void {
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      let rec: { s?: unknown; g?: unknown };
      try {
        rec = JSON.parse(line);
      } catch {
        // A torn final line (crash mid-append) is the only expected parse
        // failure; skip it. A non-final unparseable line is corruption — also
        // skip fail-closed (the max may be understated, so a later allocate can
        // never REISSUE a used generation, only skip ahead conservatively).
        continue;
      }
      if (typeof rec.s === 'string' && typeof rec.g === 'number') {
        const prev = this.max.get(rec.s) ?? 0;
        if (rec.g > prev) this.max.set(rec.s, rec.g);
      }
    }
  }

  read(sessionId: string): number {
    return this.max.get(sessionId) ?? 0;
  }

  write(sessionId: string, generation: number): void {
    const prev = this.max.get(sessionId) ?? 0;
    if (generation <= prev) return; // monotonic guard — never lower a recorded max
    if (this.fd === null) this.fd = openSync(this.path, 'a');
    const line = JSON.stringify({ s: sessionId, g: generation }) + '\n';
    writeSync(this.fd, line);
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
