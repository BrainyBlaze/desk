// Control plane conformance (spec §6, contract C16). Exercises the four
// correctness properties the daemon depends on: source precedence, staleness
// DROP (not mask), the generation fence, and exactly-once (intake dedupe +
// consumer replay).

import { describe, expect, it } from 'vitest';
import {
  InMemoryConsumerStore,
  InMemoryIntakeStore,
  type AcceptedEvent,
  type JournalEntry,
  type SourceContribution,
  applySessionEvent,
  consume,
  createSessionModel,
  intake,
  refreshSessionState,
  resolveState,
  SOURCE_TTL_MS
} from '../src/shared/controlPlane/index.js';

const T0 = 1_000_000;
const contrib = (source: SourceContribution['source'], state: SourceContribution['state'], sourceSeq: number, ts: number): SourceContribution => ({
  source,
  state,
  sourceSeq,
  ts
});
const cmap = (...cs: SourceContribution[]) => new Map(cs.map((c) => [c.source, c]));

// ---- §6.2 precedence ---------------------------------------------------------
describe('control plane — source precedence (§6.2)', () => {
  it('typed-hook outranks native-fsm outranks worker-rendered outranks unknown', () => {
    const all = cmap(
      contrib('unknown', 'idle', 1, T0),
      contrib('worker-rendered', 'blocked', 1, T0),
      contrib('native-fsm', 'awaiting-approval', 1, T0),
      contrib('typed-hook', 'working', 1, T0)
    );
    expect(resolveState(all, T0)).toEqual({ state: 'working', source: 'typed-hook' });
  });

  it('a fresh lower source wins when no higher source is present', () => {
    expect(resolveState(cmap(contrib('worker-rendered', 'blocked', 1, T0)), T0)).toEqual({
      state: 'blocked',
      source: 'worker-rendered'
    });
  });

  it('bash/custom unknown is a real lowest source, never coerced up', () => {
    expect(resolveState(cmap(contrib('unknown', 'working', 9, T0)), T0)).toEqual({
      state: 'working',
      source: 'unknown'
    });
  });

  it('empty contributions resolve to unknown (fail-closed floor)', () => {
    expect(resolveState(new Map(), T0)).toEqual({ state: 'unknown', source: 'unknown' });
  });
});

// ---- §6.4 staleness: DROP, not mask -----------------------------------------
describe('control plane — staleness drop (§6.4)', () => {
  it('a stale typed-hook is DROPPED so a fresh native-fsm wins (not masked to unknown)', () => {
    const staleHookTs = T0;
    const now = T0 + SOURCE_TTL_MS['typed-hook'] + 1; // hook now stale
    const all = cmap(
      contrib('typed-hook', 'idle', 1, staleHookTs),
      contrib('native-fsm', 'working', 1, now - 1) // fresh
    );
    // If staleness MASKED (replaced hook with unknown) the answer would still be
    // native-fsm working; the discriminating case is that the stale HIGH source
    // must not win with its OWN stale value:
    expect(resolveState(all, now)).toEqual({ state: 'working', source: 'native-fsm' });
  });

  it('the stale high-precedence source does not win with its stale value', () => {
    const now = T0 + SOURCE_TTL_MS['typed-hook'] + 1;
    const all = cmap(
      contrib('typed-hook', 'working', 5, T0), // stale
      contrib('worker-rendered', 'idle', 1, now - 1) // fresh, lower
    );
    expect(resolveState(all, now)).toEqual({ state: 'idle', source: 'worker-rendered' });
  });

  it('all sources stale → unknown (never sticky-working, R2)', () => {
    const now = T0 + SOURCE_TTL_MS['typed-hook'] + SOURCE_TTL_MS['worker-rendered'] + 10;
    const all = cmap(contrib('typed-hook', 'working', 1, T0), contrib('worker-rendered', 'working', 1, T0));
    expect(resolveState(all, now)).toEqual({ state: 'unknown', source: 'unknown' });
  });

  it('unknown source never expires (infinite TTL floor)', () => {
    const farFuture = T0 + 10 * 365 * 24 * 3600 * 1000;
    expect(resolveState(cmap(contrib('unknown', 'idle', 1, T0)), farFuture)).toEqual({
      state: 'idle',
      source: 'unknown'
    });
  });
});

// ---- session reducer: generation + sourceSeq monotonicity + timestamps ------
describe('control plane — session reducer (§6.1–6.3)', () => {
  const ev = (over: Partial<AcceptedEvent>): AcceptedEvent => ({
    sessionId: 's1',
    generation: 1,
    source: 'typed-hook',
    sourceSeq: 1,
    invocationId: 'i1',
    state: 'working',
    ts: T0,
    eventId: 'e1',
    ...over
  });

  it('a higher-generation event drops all prior-generation contributions', () => {
    const m = createSessionModel('s1', 1, T0);
    applySessionEvent(m, ev({ generation: 1, source: 'worker-rendered', state: 'blocked', sourceSeq: 1 }), T0);
    applySessionEvent(m, ev({ generation: 2, source: 'typed-hook', state: 'idle', sourceSeq: 1 }), T0 + 1);
    expect(m.generation).toBe(2);
    expect(m.contributions.has('worker-rendered')).toBe(false); // dead-process source cleared
    expect(m.state).toBe('idle');
  });

  it('a lower-generation event is ignored (defense in depth behind the fence)', () => {
    const m = createSessionModel('s1', 2, T0);
    applySessionEvent(m, ev({ generation: 2, state: 'working', sourceSeq: 3 }), T0);
    applySessionEvent(m, ev({ generation: 1, state: 'idle', sourceSeq: 99 }), T0 + 1);
    expect(m.state).toBe('working');
  });

  it('within a generation, only a strictly higher sourceSeq replaces (reorder-safe)', () => {
    const m = createSessionModel('s1', 1, T0);
    applySessionEvent(m, ev({ sourceSeq: 5, state: 'working' }), T0);
    applySessionEvent(m, ev({ sourceSeq: 3, state: 'idle' }), T0 + 1); // out-of-order, older
    expect(m.state).toBe('working');
    applySessionEvent(m, ev({ sourceSeq: 6, state: 'idle' }), T0 + 2); // newer
    expect(m.state).toBe('idle');
  });

  it('stateSince advances only on a real state change; idleSince tracks idle', () => {
    const m = createSessionModel('s1', 1, T0);
    applySessionEvent(m, ev({ sourceSeq: 1, state: 'working' }), T0 + 10);
    const since = m.stateSince;
    applySessionEvent(m, ev({ sourceSeq: 2, state: 'working' }), T0 + 20); // re-observe, no change
    expect(m.stateSince).toBe(since);
    expect(m.idleSince).toBeUndefined();
    applySessionEvent(m, ev({ sourceSeq: 3, state: 'idle' }), T0 + 30);
    expect(m.stateSince).toBe(T0 + 30);
    expect(m.idleSince).toBe(T0 + 30);
  });

  it('refresh catches a staleness-driven transition with no new event', () => {
    // Freshness is measured from event.ts (production time), so ts must track
    // when each source reported (as a real intake stamps it).
    const m = createSessionModel('s1', 1, T0);
    applySessionEvent(m, ev({ source: 'typed-hook', sourceSeq: 1, state: 'working', ts: T0 }), T0);
    applySessionEvent(m, ev({ source: 'worker-rendered', invocationId: 'i2', sourceSeq: 1, state: 'idle', ts: T0 + 44_000 }), T0 + 44_000);
    expect(m.state).toBe('working'); // hook still fresh at T0+44000 (TTL 45000)
    const now = T0 + 46_000; // hook now stale (>45000 old); rendered still fresh (2000ms old < 8000)
    refreshSessionState(m, now);
    expect(m.state).toBe('idle');
    expect(m.source).toBe('worker-rendered');
  });
});

// ---- §6.3 generation fence + §6.5 exactly-once intake -----------------------
describe('control plane — intake fence + exactly-once (§6.3/§6.5)', () => {
  it('fences an event whose carried generation != ledger-current', () => {
    const store = new InMemoryIntakeStore();
    store.setGeneration('s1', 3);
    const r = intake({ sessionId: 's1', carriedGeneration: 2, source: 'typed-hook', invocationId: 'a', state: 'working', ts: T0 }, store);
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('generation-fence');
  });

  it('allocates monotonic sourceSeq per (session, source)', () => {
    const store = new InMemoryIntakeStore();
    store.setGeneration('s1', 1);
    const a = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'a', state: 'working', ts: T0 }, store);
    const b = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'b', state: 'idle', ts: T0 + 1 }, store);
    const c = intake({ sessionId: 's1', carriedGeneration: 1, source: 'worker-rendered', invocationId: 'c', state: 'idle', ts: T0 + 2 }, store);
    expect(a.event.sourceSeq).toBe(1);
    expect(b.event.sourceSeq).toBe(2); // same source, next seq
    expect(c.event.sourceSeq).toBe(1); // different source, independent counter
    expect(a.event.eventId).toBe('s1:1:typed-hook:1');
  });

  it('a retry with the same invocationId returns the SAME event (lost-ACK exactly-once)', () => {
    const store = new InMemoryIntakeStore();
    store.setGeneration('s1', 1);
    const first = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'dup', state: 'working', ts: T0 }, store);
    const retry = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'dup', state: 'working', ts: T0 + 500 }, store);
    expect(first.kind).toBe('accepted');
    expect(retry.kind).toBe('duplicate');
    expect(retry.event).toEqual(first.event); // no new sourceSeq / eventId
  });

  it('a retry after a generation change is fenced (fail-closed, not deduped)', () => {
    const store = new InMemoryIntakeStore();
    store.setGeneration('s1', 1);
    intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'dup', state: 'working', ts: T0 }, store);
    store.setGeneration('s1', 2); // session recreated before the retry
    const retry = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'dup', state: 'working', ts: T0 + 1 }, store);
    expect(retry.kind).toBe('rejected');
  });
});

// ---- §6.5 exactly-once consumer (cursor + receipt) --------------------------
describe('control plane — exactly-once consumer (§6.5)', () => {
  const entry = (seq: number, eventId: string): JournalEntry => ({
    seq,
    event: {
      sessionId: 's1',
      generation: 1,
      source: 'typed-hook',
      sourceSeq: seq,
      invocationId: `i${seq}`,
      state: 'working',
      ts: T0 + seq,
      eventId
    }
  });

  it('applies each new entry exactly once and advances the cursor', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    const es = [entry(1, 'e1'), entry(2, 'e2'), entry(3, 'e3')];
    const n = consume(es, store, (e) => applied.push(e.eventId));
    expect(n).toBe(3);
    expect(applied).toEqual(['e1', 'e2', 'e3']);
    expect(store.cursor()).toBe(3);
  });

  it('a full replay applies nothing again (receipt guard)', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    const es = [entry(1, 'e1'), entry(2, 'e2')];
    consume(es, store, (e) => applied.push(e.eventId));
    const n = consume(es, store, (e) => applied.push(e.eventId)); // replay whole journal
    expect(n).toBe(0);
    expect(applied).toEqual(['e1', 'e2']); // effect ran once each
  });

  it('crash after effect+receipt before cursor advance → replay is a no-op', () => {
    // Simulate: effect+receipt committed (atomic) but cursor NOT advanced.
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    store.applyAndReceipt('e1', () => applied.push('e1')); // effect+receipt landed
    // cursor still 0 (crash before setCursor). Now replay from the journal:
    const n = consume([entry(1, 'e1'), entry(2, 'e2')], store, (e) => applied.push(e.eventId));
    expect(applied).toEqual(['e1', 'e2']); // e1 NOT re-applied
    expect(n).toBe(1); // only e2 newly applied
    expect(store.cursor()).toBe(2);
  });

  it('a re-journaled intake duplicate (same eventId) applies no second effect', () => {
    const store = new InMemoryConsumerStore();
    const applied: string[] = [];
    // e1 appears at seq 1 and again (duplicate re-journaled) at seq 5:
    const n = consume([entry(1, 'e1'), entry(2, 'e2'), { ...entry(5, 'e1') }], store, (e) => applied.push(e.eventId));
    expect(applied).toEqual(['e1', 'e2']);
    expect(n).toBe(2);
    expect(store.cursor()).toBe(5); // cursor still advanced past the duplicate
  });
});
