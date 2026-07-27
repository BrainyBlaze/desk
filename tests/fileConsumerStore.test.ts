// Durable consumer store conformance (spec §6.5). Exactly-once side effects must
// survive a daemon RESTART: the receipt set + cursor persist, so a replay after
// restart re-applies nothing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_STATE_SCHEMA_VERSION,
  consume,
  type JournalEntry
} from '../src/shared/controlPlane/index.js';
import { FileConsumerStore } from '../src/server/runtime/fileConsumerStore.js';

const entry = (seq: number, acceptanceId: string): JournalEntry => ({
  seq,
  event: {
    acceptanceId,
    acceptedSeq: seq,
    acceptedAt: seq,
    envelope: {
      schemaVersion: AGENT_STATE_SCHEMA_VERSION,
      sessionId: 'agent-a',
      generation: 1,
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      producerInstanceId: 'hooks-a',
      producerSeq: seq,
      eventId: `producer-event-${seq}`,
      invocationId: `invocation-${seq}`,
      occurredAt: seq,
      observedAt: seq,
      facts: [{ kind: 'activity', activity: 'working' }]
    }
  }
});

describe('durable consumer store — exactly-once survives restart (§6.5)', () => {
  let dir: string;
  let receiptPath: string;
  let cursorPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'consumer-'));
    receiptPath = join(dir, 'receipts.log');
    cursorPath = join(dir, 'cursor');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('applies each entry once and persists receipts + cursor', () => {
    const store = new FileConsumerStore(receiptPath, cursorPath);
    const applied: string[] = [];
    consume([entry(1, 'e1'), entry(2, 'e2')], store, (e) => applied.push(e.acceptanceId));
    expect(applied).toEqual(['e1', 'e2']);
    expect(store.cursor()).toBe(2);
    store.close();
  });

  it('THE restart property: replay after restart re-applies nothing', () => {
    const s1 = new FileConsumerStore(receiptPath, cursorPath);
    const applied: string[] = [];
    consume([entry(1, 'e1'), entry(2, 'e2')], s1, (e) => applied.push(e.acceptanceId));
    s1.close();

    // "daemon restart": fresh store replays the durable receipts + cursor.
    const s2 = new FileConsumerStore(receiptPath, cursorPath);
    expect(s2.cursor()).toBe(2); // cursor recovered
    expect(s2.hasReceipt('e1')).toBe(true);
    const n = consume([entry(1, 'e1'), entry(2, 'e2'), entry(3, 'e3')], s2, (e) => applied.push(e.acceptanceId));
    expect(n).toBe(1); // only the NEW entry e3 applies
    expect(applied).toEqual(['e1', 'e2', 'e3']); // e1/e2 never re-applied
    s2.close();
  });

  it('crash after receipt before cursor advance → replay is a no-op (receipt guard)', () => {
    const s1 = new FileConsumerStore(receiptPath, cursorPath);
    const applied: string[] = [];
    s1.applyAndReceipt('e1', () => applied.push('e1')); // effect + receipt durable, cursor NOT advanced
    s1.close(); // "crash" before setCursor

    const s2 = new FileConsumerStore(receiptPath, cursorPath);
    expect(s2.cursor()).toBe(0); // cursor never advanced
    expect(s2.hasReceipt('e1')).toBe(true); // but the receipt survived
    const n = consume([entry(1, 'e1'), entry(2, 'e2')], s2, (e) => applied.push(e.acceptanceId));
    expect(applied).toEqual(['e1', 'e2']); // e1 NOT re-applied
    expect(n).toBe(1);
    s2.close();
  });
});
