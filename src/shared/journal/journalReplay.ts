// Journal replay projector (spec §4.9). Pure. Applies typed records in
// record_seq TOTAL ORDER (output_offset alone can't order RESIZE/EVENT vs OUTPUT
// — they interleave at the same offset) and projects each to a replay action.
// Used by both authoritative recovery (§8.1 replay checkpoint→tail) and history
// (§7.4). EVENT records dedupe; TRUNCATION declares a gap; an UNEXPECTED
// record_seq discontinuity (loss inside the retained range) is flagged.

import { ByteReader } from '../atchWire/codec.js';
import { RecordType } from '../atchWire/frames.js';
import { type RecordEnvelope } from '../atchWire/messages.js';

export type ReplayAction =
  | { kind: 'output'; recordSeq: bigint; offset: bigint; bytes: Uint8Array }
  | { kind: 'resize'; recordSeq: bigint; rows: number; cols: number; geometryRev: number }
  | { kind: 'event'; recordSeq: bigint; offset: bigint; eventType: number; body: Uint8Array }
  | { kind: 'checkpoint-anchor'; recordSeq: bigint; checkpointSetId: bigint; offset: bigint }
  | { kind: 'gap'; recordSeq: bigint; fromOffset: bigint; toOffset: bigint };

export interface ReplayResult {
  actions: ReplayAction[];
  /** First record_seq where an UNEXPECTED (non-TRUNCATION) discontinuity was seen, else null. */
  discontinuityAt: bigint | null;
}

/**
 * Project a set of records into ordered replay actions (§4.9).
 * - Records are ordered by record_seq (the total order); ties are impossible
 *   (record_seq is unique per session).
 * - A record_seq gap that is NOT explained by a TRUNCATION record is flagged as
 *   a discontinuity (loss inside the retained range) — the caller marks the
 *   affected buffer inexact (§8.2). TRUNCATION records legitimately declare gaps.
 * - EVENT records dedupe by (generation, output_offset, eventType) so a replay of
 *   overlapping segments never double-projects an event.
 */
export function replayJournal(records: readonly RecordEnvelope[]): ReplayResult {
  const ordered = [...records].sort((a, b) => (a.record_seq < b.record_seq ? -1 : a.record_seq > b.record_seq ? 1 : 0));
  const actions: ReplayAction[] = [];
  const seenEvents = new Set<string>();
  let expectedSeq: bigint | null = null;
  let discontinuityAt: bigint | null = null;

  for (const rec of ordered) {
    // record_seq contiguity — a hole not declared by TRUNCATION is loss.
    if (expectedSeq !== null && rec.record_seq !== expectedSeq && rec.record_type !== RecordType.TRUNCATION) {
      if (discontinuityAt === null) discontinuityAt = expectedSeq;
    }
    expectedSeq = rec.record_seq + 1n;

    switch (rec.record_type) {
      case RecordType.OUTPUT:
        actions.push({ kind: 'output', recordSeq: rec.record_seq, offset: rec.output_offset, bytes: rec.body });
        break;
      case RecordType.RESIZE: {
        const r = new ByteReader(rec.body);
        actions.push({ kind: 'resize', recordSeq: rec.record_seq, rows: r.u16(), cols: r.u16(), geometryRev: r.u32() });
        break;
      }
      case RecordType.EVENT: {
        const eventType = rec.body.length > 0 ? rec.body[0] : 0;
        const dedupeKey = `${rec.generation} ${rec.output_offset} ${eventType}`;
        if (seenEvents.has(dedupeKey)) break; // §4.9 dedupe
        seenEvents.add(dedupeKey);
        actions.push({ kind: 'event', recordSeq: rec.record_seq, offset: rec.output_offset, eventType, body: rec.body });
        break;
      }
      case RecordType.CHECKPOINT_MARK: {
        const r = new ByteReader(rec.body);
        const checkpointSetId = r.u64();
        const offset = r.u64();
        actions.push({ kind: 'checkpoint-anchor', recordSeq: rec.record_seq, checkpointSetId, offset });
        break;
      }
      case RecordType.TRUNCATION: {
        const r = new ByteReader(rec.body);
        const fromOffset = r.u64();
        r.u64(); // from_record_seq
        const toOffset = r.u64();
        const toRecordSeq = r.u64();
        actions.push({ kind: 'gap', recordSeq: rec.record_seq, fromOffset, toOffset });
        // after a declared truncation, the next expected seq is the truncation target.
        expectedSeq = toRecordSeq;
        break;
      }
      default:
        break; // unknown record type — skip (fail-closed on the consumer side)
    }
  }
  return { actions, discontinuityAt };
}
