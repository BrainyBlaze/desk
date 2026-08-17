// Durable consumer store (spec §6.5). The fsync'd backing behind the exactly-once
// consumer: a durable receipt set + a durable cursor, so applied side effects are
// not re-run after a daemon restart. Node stdlib only.
//
// Ordering (§6.5): apply effect → record receipt (fsync) → advance cursor. A
// crash re-processes from the cursor; the receipt makes the re-apply a no-op.
// This is correct for IDEMPOTENT / receipt-guarded effects (the common case:
// state updates keyed by acceptanceId). A NON-idempotent effect (e.g. posting a
// message) must use the outbox variant — the effect appends its payload as part
// of the same receipt record so effect+receipt commit atomically; this store's
// applyAndReceipt gives that atomicity for the receipt write, and the effect
// callback is responsible for staging its payload into the same transaction.

import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { type ConsumerStore } from '../../shared/controlPlane/consumer.js';

export class FileConsumerStore implements ConsumerStore {
  private readonly receiptPath: string;
  private readonly cursorPath: string;
  private readonly receipts = new Set<string>();
  private cur = 0;
  private fd: number | null = null;
  /**
   * Set only when a partial receipt could NOT be rolled back (desk#65). The
   * file then ends mid-id, and any further append would fuse onto it and be
   * read back as one corrupt id instead of two real ones — so the store
   * refuses everything from here on rather than write past it.
   */
  private appendFailure: Error | null = null;

  constructor(receiptPath: string, cursorPath: string) {
    this.receiptPath = receiptPath;
    this.cursorPath = cursorPath;
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    this.replay();
    this.fd = openSync(receiptPath, 'a');
  }

  private replay(): void {
    if (existsSync(this.receiptPath)) {
      const text = readFileSync(this.receiptPath, 'utf8');
      // The newline is the LAST byte of a receipt, so an unterminated final
      // segment is a record that never committed. Recovering it as a receipt
      // would invent an id, and leaving it in place would let the first append
      // of this incarnation fuse onto it — the same corruption a short write
      // causes, arriving instead from a hard kill. Drop it durably, BEFORE the
      // append handle opens.
      const terminated = text.lastIndexOf('\n') + 1;
      if (terminated < text.length) this.truncateTail(terminated);
      for (const line of text.slice(0, terminated).split('\n')) {
        if (line.length > 0) this.receipts.add(line);
      }
    }
    if (existsSync(this.cursorPath)) {
      const n = Number(readFileSync(this.cursorPath, 'utf8').trim());
      if (Number.isFinite(n)) this.cur = n;
    }
  }

  cursor(): number {
    return this.cur;
  }

  setCursor(seq: number): void {
    if (seq <= this.cur) return;
    this.cur = seq;
    // atomic rewrite of the single cursor value (temp + rename + fsync-dir-implied).
    const tmp = `${this.cursorPath}.tmp.${process.pid}`;
    writeFileSync(tmp, String(seq), { mode: 0o600 });
    renameSync(tmp, this.cursorPath);
  }

  hasReceipt(eventId: string): boolean {
    return this.receipts.has(eventId);
  }

  applyAndReceipt(eventId: string, effect: () => void): void {
    // Canonical acceptance IDs are bounded nonblank identifiers without newlines.
    //
    // Health is checked BEFORE the effect runs: an effect this store already
    // knows it cannot receipt is a guaranteed double-apply on the next replay.
    if (this.appendFailure !== null) throw this.appendFailure;
    effect();
    if (this.fd === null) this.fd = openSync(this.receiptPath, 'a');
    this.appendReceipt(this.fd, eventId);
    // Reached only once the id is whole on disk AND fsync'd: `receipts` is a
    // mirror of the durable set, never a promise about it.
    this.receipts.add(eventId);
  }

  /**
   * Append one receipt COMPLETELY or leave the file exactly as it was.
   *
   * writeSync reports how many bytes it actually took, and a regular file may
   * legally take fewer than asked (an ENOSPC boundary, an interrupted call) or
   * zero. The newline that terminates the id is the last byte, so a partial
   * write that is fsync'd anyway commits a TRUNCATED event id: on replay the
   * id no longer matches, the effect it recorded is applied a second time, and
   * the next append fuses onto the unterminated line. Hence the loop — and
   * hence the rollback, because reading the count without undoing the partial
   * bytes still leaves that tail in front of the retry.
   */
  private appendReceipt(fd: number, eventId: string): void {
    const bytes = Buffer.from(`${eventId}\n`, 'utf8');
    const appendStart = fstatSync(fd).size;
    let written = 0;
    try {
      while (written < bytes.length) {
        const remaining = bytes.length - written;
        const count = writeSync(fd, bytes, written, remaining);
        // Zero is legal and must not be looped on; a count past the range we
        // handed in describes nothing we can trust. Both are "incomplete".
        if (count <= 0 || count > remaining) {
          throw new Error('durable consumer receipt append made no progress');
        }
        written += count;
      }
      // A failed fsync leaves a record we cannot vouch for; it is rolled back
      // with the rest rather than counted as a receipt.
      fsyncSync(fd);
    } catch (error) {
      this.rollbackTo(fd, appendStart);
      // The effect has ALREADY run and no file operation can un-run it. The
      // honest report is the failure itself: the caller must not advance the
      // cursor past an entry whose receipt does not exist, and a retry (or a
      // restart) will re-apply the effect — which is precisely the idempotency
      // this store's contract already requires of its callers. Swallowing it
      // would advance the cursor over an unrecorded effect and turn a loud
      // failure into a silent exactly-once violation.
      throw error;
    }
  }

  /** Undo a partial append, or refuse to ever append again if it cannot be undone. */
  private rollbackTo(fd: number, appendStart: number): void {
    try {
      ftruncateSync(fd, appendStart);
      fsyncSync(fd);
    } catch {
      this.appendFailure = new Error(
        'durable consumer receipt store refuses to append behind an unrepairable partial receipt'
      );
      try {
        closeSync(fd);
      } catch {
        // The descriptor is unusable either way; what matters is that nothing
        // writes through it again. Restart replay truncates the torn tail.
      }
      if (this.fd === fd) this.fd = null;
    }
  }

  private truncateTail(offset: number): void {
    const fd = openSync(this.receiptPath, 'r+');
    try {
      ftruncateSync(fd, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
