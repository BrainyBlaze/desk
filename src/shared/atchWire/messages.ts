// atch v3 wire — schema-driven per-frame payload codec.
// Each fixed-layout frame is described by an ordered FIELD list mirroring the
// docs/atch-wire-v3.md payload tables; a generic walker encodes/decodes it. This
// keeps the codec a faithful transcription of the frozen contract and makes the
// golden vectors self-consistent. Variable-shape frames (RECORD envelope) get a
// dedicated codec below. Pure module.

import { ByteReader, ByteWriter, WireError } from './codec.js';
import { ErrorCode, FrameType, RecordType } from './frames.js';

type FieldKind = 'u8' | 'u16' | 'u32' | 'u64' | 'str16' | 'blob32' | 'b16' | 'b32';
interface Field {
  name: string;
  kind: FieldKind;
}
const f = (name: string, kind: FieldKind): Field => ({ name, kind });

/** Value bag for a decoded/encoding frame body. u64→bigint, str16→string, blobs/fixed→Uint8Array. */
export type Body = Record<string, number | bigint | string | Uint8Array>;

/**
 * Fixed-layout frame schemas (byte order = contract order). Frames with
 * conditional/variable layout are handled by dedicated codecs, not here.
 */
export const FRAME_SCHEMA: Partial<Record<FrameType, Field[]>> = {
  [FrameType.HELLO]: [f('client_version', 'u16'), f('peer_role', 'u8'), f('capabilities', 'u32'), f('incarnation', 'b16')],
  [FrameType.ATTACH]: [
    f('role', 'u8'),
    f('prev_generation', 'u32'),
    f('last_seen_offset', 'u64'),
    f('last_seen_record_seq', 'u64'),
    f('desired_rows', 'u16'),
    f('desired_cols', 'u16'),
    f('sessionId', 'str16')
  ],
  [FrameType.ATTACH_ACK]: [
    f('generation', 'u32'),
    f('retained_start_offset', 'u64'),
    f('retained_start_record_seq', 'u64'),
    f('retained_end_offset', 'u64'),
    f('retained_end_record_seq', 'u64'),
    f('controller_ack_offset', 'u64'),
    f('controller_ack_record_seq', 'u64'),
    f('has_checkpoint', 'u8'),
    f('checkpoint_set_id', 'u64'),
    f('checkpoint_offset', 'u64'),
    f('checkpoint_record_seq', 'u64'),
    f('tail_offset', 'u64'),
    f('tail_record_seq', 'u64'),
    f('rows', 'u16'),
    f('cols', 'u16'),
    f('current_state_exact', 'u8'),
    f('restart_recoverable', 'u8'),
    f('main_exact', 'u8'),
    f('alt_exact', 'u8'),
    f('active_buffer', 'u8'),
    f('caps', 'u32')
  ],
  [FrameType.ERROR]: [f('code', 'u16'), f('detail', 'str16')],
  [FrameType.HEARTBEAT]: [],
  [FrameType.DETACH]: [],
  [FrameType.LEASE_RELEASE]: [],
  [FrameType.OUTPUT_ACK]: [f('ack_offset', 'u64'), f('ack_record_seq', 'u64')],
  [FrameType.INPUT]: [f('flags', 'u8'), f('surface_id', 'u32'), f('bytes', 'blob32')],
  [FrameType.COMMAND]: [
    f('txnId', 'b16'),
    f('step', 'u8'),
    f('step_key', 'b16'),
    f('generation', 'u32'),
    f('payload_digest', 'b32'),
    f('payload', 'blob32')
  ],
  [FrameType.COMMAND_ACK]: [f('txnId', 'b16'), f('step', 'u8'), f('result', 'u8')],
  [FrameType.RESIZE]: [f('lease_epoch', 'u32'), f('surface_id', 'u32'), f('generation', 'u32'), f('rows', 'u16'), f('cols', 'u16')],
  [FrameType.LEASE_CLAIM]: [f('role', 'u8'), f('forced', 'u8')],
  [FrameType.LEASE_GRANT]: [
    f('granted', 'u8'),
    f('owner_conn', 'u32'),
    f('lease_epoch', 'u32'),
    f('ack_offset', 'u64'),
    f('ack_record_seq', 'u64')
  ],
  [FrameType.EVENT_STREAM]: [f('event_type', 'u8'), f('generation', 'u32'), f('event_seq', 'u64'), f('ts_ms', 'u64'), f('body', 'str16')],
  [FrameType.SIGNAL_REQUEST]: [f('opId', 'b16'), f('signal', 'u8'), f('escalate_ms', 'u32')],
  [FrameType.SIGNAL_ACK]: [f('opId', 'b16'), f('result', 'u8'), f('child_status', 'u32')],
  [FrameType.STATE_UPDATE]: [
    f('state_record_seq', 'u64'),
    f('worker_incarnation', 'b16'),
    f('current_state_exact', 'u8'),
    f('restart_recoverable', 'u8'),
    f('main_exact', 'u8'),
    f('alt_exact', 'u8'),
    f('active_buffer', 'u8')
  ],
  [FrameType.STATE_UPDATE_ACK]: [f('state_record_seq', 'u64'), f('result', 'u8'), f('committed_state_record_seq', 'u64')],
  [FrameType.CHECKPOINT_ACK]: [f('checkpoint_set_id', 'u64'), f('snapshot_kind', 'u8'), f('stored', 'u8'), f('at_offset', 'u64'), f('at_record_seq', 'u64')],
  [FrameType.JOURNAL_READ]: [f('from_record_seq', 'u64'), f('max_records', 'u32'), f('max_bytes', 'u32')],
  [FrameType.CHECKPOINT_GET]: [
    f('at_or_before_offset', 'u64'),
    f('at_or_before_record_seq', 'u64'),
    f('snapshot_kind', 'u8'),
    f('accepted_format_versions', 'u32'),
    f('accepted_patch_versions', 'str16')
  ],
  [FrameType.CHECKPOINT_PUT]: [
    f('checkpoint_set_id', 'u64'),
    f('generation', 'u32'),
    f('output_offset', 'u64'),
    f('record_seq', 'u64'),
    f('geometry_rev', 'u32'),
    f('rows', 'u16'),
    f('cols', 'u16'),
    f('snapshot_kind', 'u8'),
    f('format_version', 'u32'),
    f('xterm_version', 'str16'),
    f('patch_version', 'str16'),
    f('checksum', 'b32'),
    f('snapshot', 'blob32')
  ],
  [FrameType.TERMINAL_REPLY]: [
    f('query_id', 'u64'),
    f('generation', 'u32'),
    f('lease_epoch', 'u32'),
    f('source', 'u8'),
    f('query_class', 'u8'),
    f('reply', 'blob32')
  ],
  [FrameType.GAP]: [
    f('from_offset', 'u64'),
    f('from_record_seq', 'u64'),
    f('to_offset', 'u64'),
    f('to_record_seq', 'u64'),
    f('reason', 'u8'),
    f('current_state_exact', 'u8'),
    f('restart_recoverable', 'u8'),
    f('main_exact', 'u8'),
    f('alt_exact', 'u8'),
    f('active_buffer', 'u8')
  ],
  [FrameType.FENCE]: [f('at_offset', 'u64'), f('at_record_seq', 'u64'), f('phase', 'u8')],
  [FrameType.REDRAW]: [f('method', 'u8'), f('rows', 'u16'), f('cols', 'u16')]
};

export function encodeBody(type: FrameType, body: Body): Uint8Array {
  const schema = FRAME_SCHEMA[type];
  if (!schema) throw new WireError(ErrorCode.INTERNAL, `no fixed schema for type ${type} (use a dedicated codec)`);
  const w = new ByteWriter();
  for (const fld of schema) {
    const v = body[fld.name];
    switch (fld.kind) {
      case 'u8': w.u8(Number(v)); break;
      case 'u16': w.u16(Number(v)); break;
      case 'u32': w.u32(Number(v)); break;
      case 'u64': w.u64(typeof v === 'bigint' ? v : BigInt(v as number)); break;
      case 'str16': w.str16(String(v)); break;
      case 'blob32': w.blob32(v as Uint8Array); break;
      case 'b16': w.fixed(v as Uint8Array, 16); break;
      case 'b32': w.fixed(v as Uint8Array, 32); break;
    }
  }
  return w.take();
}

export function decodeBody(type: FrameType, payload: Uint8Array): Body {
  const schema = FRAME_SCHEMA[type];
  if (!schema) throw new WireError(ErrorCode.INTERNAL, `no fixed schema for type ${type}`);
  const r = new ByteReader(payload);
  const out: Body = {};
  for (const fld of schema) {
    switch (fld.kind) {
      case 'u8': out[fld.name] = r.u8(); break;
      case 'u16': out[fld.name] = r.u16(); break;
      case 'u32': out[fld.name] = r.u32(); break;
      case 'u64': out[fld.name] = r.u64(); break;
      case 'str16': out[fld.name] = r.str16(); break;
      case 'blob32': out[fld.name] = r.blob32(); break;
      case 'b16': out[fld.name] = r.fixed(16); break;
      case 'b32': out[fld.name] = r.fixed(32); break;
    }
  }
  r.end();
  return out;
}

// ---- RECORD envelope (variable-shape; shared by live + journal) --------------
export interface RecordEnvelope {
  record_type: RecordType;
  record_seq: bigint;
  generation: number;
  output_offset: bigint;
  body: Uint8Array;
}

export function encodeRecord(rec: RecordEnvelope): Uint8Array {
  const inner = new ByteWriter()
    .u8(rec.record_type)
    .u64(rec.record_seq)
    .u32(rec.generation >>> 0)
    .u64(rec.output_offset)
    .u32(rec.body.length)
    .bytes(rec.body)
    .take();
  const crc = crc32Of(inner);
  return new ByteWriter().bytes(inner).u32(crc).take();
}

export function decodeRecord(payload: Uint8Array): RecordEnvelope {
  if (payload.length < 4) throw new WireError(ErrorCode.TRUNCATED, 'record too short');
  const inner = payload.subarray(0, payload.length - 4);
  const r = new ByteReader(payload);
  const record_type = r.u8() as RecordType;
  const record_seq = r.u64();
  const generation = r.u32();
  const output_offset = r.u64();
  const bodyLen = r.u32();
  const body = r.fixed(bodyLen);
  const crc = r.u32();
  r.end();
  if (crc32Of(inner) !== crc) throw new WireError(ErrorCode.TRUNCATED, 'record crc mismatch');
  return { record_type, record_seq, generation, output_offset, body };
}

// re-export crc32 via a thin wrapper so this module owns the record crc domain.
import { crc32 as crc32Of } from './frames.js';

// ---- CHECKPOINT_DATA (conditional body) --------------------------------------
export interface CheckpointData {
  checkpoint_set_id: bigint;
  present: number;
  snapshot_kind: number;
  /** present==1 → the CHECKPOINT_PUT body from `generation` onward. */
  put?: Body;
}

export function encodeCheckpointData(d: CheckpointData): Uint8Array {
  const w = new ByteWriter().u64(d.checkpoint_set_id).u8(d.present).u8(d.snapshot_kind);
  if (d.present) {
    if (!d.put) throw new WireError(ErrorCode.INTERNAL, 'CHECKPOINT_DATA present=1 without body');
    // The put body per §3.23 is the CHECKPOINT_PUT layout from `generation` on:
    // encode a full CHECKPOINT_PUT body and drop its leading checkpoint_set_id (u64).
    const full = encodeBody(FrameType.CHECKPOINT_PUT, { checkpoint_set_id: d.checkpoint_set_id, ...d.put });
    w.bytes(full.subarray(8));
  }
  return w.take();
}

export function decodeCheckpointData(payload: Uint8Array): CheckpointData {
  const r = new ByteReader(payload);
  const checkpoint_set_id = r.u64();
  const present = r.u8();
  const snapshot_kind = r.u8();
  if (!present) {
    r.end();
    return { checkpoint_set_id, present, snapshot_kind };
  }
  // Reconstruct a CHECKPOINT_PUT body by prefixing the set_id, then schema-decode.
  const withId = new ByteWriter().u64(checkpoint_set_id).bytes(r.rest()).take();
  const put = decodeBody(FrameType.CHECKPOINT_PUT, withId);
  return { checkpoint_set_id, present, snapshot_kind, put };
}

// ---- JOURNAL_DATA (record array) ---------------------------------------------
export interface JournalData {
  from_record_seq: bigint;
  eof: number;
  records: RecordEnvelope[];
}

export function encodeJournalData(d: JournalData): Uint8Array {
  const w = new ByteWriter().u64(d.from_record_seq).u8(d.eof).u32(d.records.length);
  for (const rec of d.records) {
    const encoded = encodeRecord(rec);
    w.u32(encoded.length).bytes(encoded);
  }
  return w.take();
}

export function decodeJournalData(payload: Uint8Array): JournalData {
  const r = new ByteReader(payload);
  const from_record_seq = r.u64();
  const eof = r.u8();
  const count = r.u32();
  const records: RecordEnvelope[] = [];
  for (let i = 0; i < count; i++) {
    const recLen = r.u32();
    records.push(decodeRecord(r.fixed(recLen)));
  }
  r.end();
  return { from_record_seq, eof, records };
}
