// Journal replay projector conformance (spec §4.9).

import { describe, expect, it } from 'vitest';
import { ByteWriter } from '../src/shared/atchWire/codec.js';
import { EventType, RecordType } from '../src/shared/atchWire/frames.js';
import { type RecordEnvelope } from '../src/shared/atchWire/messages.js';
import { replayJournal, type ReplayAction } from '../src/shared/journal/index.js';

const out = (seq: bigint, offset: bigint, text: string): RecordEnvelope => ({
  record_type: RecordType.OUTPUT,
  record_seq: seq,
  generation: 1,
  output_offset: offset,
  body: new TextEncoder().encode(text)
});
const resize = (seq: bigint, offset: bigint, rows: number, cols: number, rev: number): RecordEnvelope => ({
  record_type: RecordType.RESIZE,
  record_seq: seq,
  generation: 1,
  output_offset: offset,
  body: new ByteWriter().u16(rows).u16(cols).u32(rev).take()
});
const event = (seq: bigint, offset: bigint, et: number): RecordEnvelope => ({
  record_type: RecordType.EVENT,
  record_seq: seq,
  generation: 1,
  output_offset: offset,
  body: new ByteWriter().u8(et).take()
});
const truncation = (seq: bigint, fromOff: bigint, fromSeq: bigint, toOff: bigint, toSeq: bigint): RecordEnvelope => ({
  record_type: RecordType.TRUNCATION,
  record_seq: seq,
  generation: 1,
  output_offset: fromOff,
  body: new ByteWriter().u64(fromOff).u64(fromSeq).u64(toOff).u64(toSeq).take()
});

describe('journal replay — record_seq total order (§4.9)', () => {
  it('orders by record_seq, not output_offset (interleaved RESIZE/EVENT vs OUTPUT)', () => {
    // RESIZE and OUTPUT at the SAME offset — only record_seq disambiguates.
    const result = replayJournal([out(2n, 100n, 'B'), resize(1n, 100n, 40, 120, 3), out(3n, 101n, 'C')]);
    expect(result.actions.map((a) => a.kind)).toEqual(['resize', 'output', 'output']);
    expect(result.discontinuityAt).toBeNull();
  });

  it('projects each record type to its action', () => {
    const result = replayJournal([out(1n, 0n, 'hi'), resize(2n, 2n, 50, 200, 7), event(3n, 2n, EventType.EXIT)]);
    const r = result.actions as ReplayAction[];
    expect(r[0]).toMatchObject({ kind: 'output', offset: 0n });
    expect(r[1]).toMatchObject({ kind: 'resize', rows: 50, cols: 200, geometryRev: 7 });
    expect(r[2]).toMatchObject({ kind: 'event', eventType: EventType.EXIT });
  });
});

describe('journal replay — EVENT dedupe (§4.9)', () => {
  it('does not double-project the same event (generation, offset, type)', () => {
    const result = replayJournal([event(1n, 50n, EventType.SIGNAL), event(2n, 50n, EventType.SIGNAL)]);
    const events = result.actions.filter((a) => a.kind === 'event');
    expect(events).toHaveLength(1); // deduped
  });

  it('keeps distinct events at different offsets', () => {
    const result = replayJournal([event(1n, 50n, EventType.SIGNAL), event(2n, 60n, EventType.SIGNAL)]);
    expect(result.actions.filter((a) => a.kind === 'event')).toHaveLength(2);
  });
});

describe('journal replay — gaps + discontinuity (§4.9 / §8.2)', () => {
  it('a TRUNCATION record declares a gap and does NOT flag discontinuity', () => {
    const result = replayJournal([out(1n, 0n, 'A'), truncation(2n, 1n, 2n, 500n, 50n), out(50n, 500n, 'Z')]);
    const gap = result.actions.find((a) => a.kind === 'gap');
    expect(gap).toMatchObject({ kind: 'gap', fromOffset: 1n, toOffset: 500n });
    expect(result.discontinuityAt).toBeNull(); // truncation explains the seq jump
  });

  it('an UNEXPECTED record_seq hole (undeclared loss) is flagged', () => {
    const result = replayJournal([out(1n, 0n, 'A'), out(5n, 10n, 'E')]); // missing 2,3,4
    expect(result.discontinuityAt).toBe(2n);
  });
});
