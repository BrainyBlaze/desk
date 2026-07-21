// Durable intake store conformance (spec §6.5). Exactly-once intake must survive
// a daemon RESTART: the invocation dedup-set and the sourceSeq allocator persist.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intake } from '../src/shared/controlPlane/index.js';
import { FileIntakeStore } from '../src/server/runtime/fileIntakeStore.js';

describe('durable intake store — exactly-once survives restart (§6.5)', () => {
  let dir: string;
  let path: string;
  const gen = () => 1; // fixed current generation for these cases
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intake-'));
    path = join(dir, 'intake.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('allocates monotonic sourceSeq and dedups a retry in-process', () => {
    const store = new FileIntakeStore(path, gen);
    const a = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i1', state: 'working', ts: 1 }, store);
    const b = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i2', state: 'idle', ts: 2 }, store);
    expect(a.event.sourceSeq).toBe(1);
    expect(b.event.sourceSeq).toBe(2);
    const retry = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i1', state: 'working', ts: 3 }, store);
    expect(retry.kind).toBe('duplicate');
    expect(retry.event).toEqual(a.event);
    store.close();
  });

  it('THE restart property: a lost-ACK retry after restart returns the SAME event', () => {
    const s1 = new FileIntakeStore(path, gen);
    const first = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'dup', state: 'working', ts: 1 }, s1);
    expect(first.kind).toBe('accepted');
    s1.close();

    // "daemon restart" — a fresh store replays the durable log:
    const s2 = new FileIntakeStore(path, gen);
    const retry = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'dup', state: 'working', ts: 99 }, s2);
    expect(retry.kind).toBe('duplicate'); // deduped across the restart
    expect(retry.event.eventId).toBe(first.event.eventId); // SAME eventId, no second sourceSeq
    s2.close();
  });

  it('sourceSeq continues higher after restart (no reuse)', () => {
    const s1 = new FileIntakeStore(path, gen);
    intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i1', state: 'working', ts: 1 }, s1); // seq 1
    intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i2', state: 'working', ts: 2 }, s1); // seq 2
    s1.close();
    const s2 = new FileIntakeStore(path, gen);
    const next = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i3', state: 'working', ts: 3 }, s2);
    expect(next.event.sourceSeq).toBe(3); // continues, never reuses 1/2
    s2.close();
  });

  it('a torn final line (crash mid-append) is skipped; the retry re-commits cleanly', () => {
    const s1 = new FileIntakeStore(path, gen);
    intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'i1', state: 'working', ts: 1 }, s1); // durable seq 1
    s1.close();
    appendFileSync(path, '{"sessionId":"s1","invocationId":"torn"'); // partial line
    const s2 = new FileIntakeStore(path, gen);
    // the torn 'torn' invocation is NOT deduped (its append never completed):
    const r = intake({ sessionId: 's1', carriedGeneration: 1, source: 'typed-hook', invocationId: 'torn', state: 'working', ts: 2 }, s2);
    expect(r.kind).toBe('accepted');
    expect(r.event.sourceSeq).toBe(2); // seq 1 recovered, this is the next
    s2.close();
  });
});
