import { describe, expect, it } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  InMemoryConsumerStore,
  consume,
  type JournalEntry
} from '../src/shared/controlPlane/index.js';

function entry(seq: number, acceptanceId: string): JournalEntry {
  return {
    seq,
    event: {
      acceptanceId,
      acceptedSeq: seq,
      acceptedAt: 1_000 + seq,
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
        occurredAt: 500 + seq,
        observedAt: 600 + seq,
        facts: [{ kind: 'activity', activity: 'working' }]
      }
    }
  };
}

describe('canonical control-plane consumer', () => {
  it('applies each new accepted event exactly once and advances the cursor', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    const entries = [entry(1, 'accepted-1'), entry(2, 'accepted-2')];

    expect(consume(entries, store, (event) => applied.push(event.acceptanceId))).toBe(2);
    expect(applied).toEqual(['accepted-1', 'accepted-2']);
    expect(store.cursor()).toBe(2);
  });

  it('does not reapply a full journal replay', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    const entries = [entry(1, 'accepted-1'), entry(2, 'accepted-2')];

    consume(entries, store, (event) => applied.push(event.acceptanceId));
    expect(consume(entries, store, (event) => applied.push(event.acceptanceId))).toBe(0);
    expect(applied).toEqual(['accepted-1', 'accepted-2']);
  });

  it('uses the acceptance receipt when a crash precedes cursor advancement', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    store.applyAndReceipt('accepted-1', () => applied.push('accepted-1'));

    expect(
      consume(
        [entry(1, 'accepted-1'), entry(2, 'accepted-2')],
        store,
        (event) => applied.push(event.acceptanceId)
      )
    ).toBe(1);
    expect(applied).toEqual(['accepted-1', 'accepted-2']);
    expect(store.cursor()).toBe(2);
  });

  it('deduplicates the same canonical acceptance at a later journal sequence', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];

    expect(
      consume(
        [entry(1, 'accepted-1'), entry(2, 'accepted-2'), entry(5, 'accepted-1')],
        store,
        (event) => applied.push(event.acceptanceId)
      )
    ).toBe(2);
    expect(applied).toEqual(['accepted-1', 'accepted-2']);
    expect(store.cursor()).toBe(5);
  });
});
