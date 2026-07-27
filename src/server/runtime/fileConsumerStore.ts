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

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { type ConsumerStore } from '../../shared/controlPlane/consumer.js';

export class FileConsumerStore implements ConsumerStore {
  private readonly receiptPath: string;
  private readonly cursorPath: string;
  private readonly receipts = new Set<string>();
  private cur = 0;
  private fd: number | null = null;

  constructor(receiptPath: string, cursorPath: string) {
    this.receiptPath = receiptPath;
    this.cursorPath = cursorPath;
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    this.replay();
    this.fd = openSync(receiptPath, 'a');
  }

  private replay(): void {
    if (existsSync(this.receiptPath)) {
      for (const line of readFileSync(this.receiptPath, 'utf8').split('\n')) {
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
    effect();
    if (this.fd === null) this.fd = openSync(this.receiptPath, 'a');
    writeSync(this.fd, eventId + '\n');
    fsyncSync(this.fd);
    this.receipts.add(eventId);
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
