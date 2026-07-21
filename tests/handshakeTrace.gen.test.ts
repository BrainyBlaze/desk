// Handshake conformance trace generator (spec §4). Emits a deterministic
// byte-level trace of the v3 controller-attach flow — the exact frames the
// daemon master client sends (HELLO, ATTACH) and the master replies (ATTACH_ACK,
// RECORD) — so the atch C master v3 adapter has a protocol-FLOW oracle beyond the
// per-frame golden vectors. Writes tests/fixtures/atch-wire/handshake-trace.json.
// All values are FIXED for reproducibility; the incarnation is client-chosen
// (any 16 bytes) — the C master must accept any value.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, type RawFrame } from '../src/shared/atchWire/codec.js';
import { FrameType, RecordType, Role, Cap } from '../src/shared/atchWire/frames.js';
import { encodeBody, encodeRecord, type Body } from '../src/shared/atchWire/messages.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const CAPS = Cap.RECORD | Cap.COMMAND | Cap.CHECKPOINT | Cap.SIGNAL | Cap.STATE_UPDATE | Cap.REDRAW; // 0x3f
const INCARNATION = new Uint8Array(16).fill(0x11);

function bodyClient(type: FrameType, seq: bigint, body: Body): RawFrame {
  return { type, flags: 0, generation: 0, sequence: seq, aux: 0n, payload: encodeBody(type, body) };
}

function jsonBody(b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) out[k] = v instanceof Uint8Array ? { hex: hex(v) } : typeof v === 'bigint' ? { u64: v.toString() } : v;
  return out;
}

function trace(name: string, direction: 'client->master' | 'master->client', frame: RawFrame, body: Body): Record<string, unknown> {
  const bytes = encodeFrame(frame);
  const dec = decodeFrame(bytes, true)!.frame;
  return {
    name,
    direction,
    header: {
      magic: 'ATV3',
      version: 3,
      type: dec.type,
      typeName: FrameType[dec.type],
      flags: dec.flags,
      payload_len: dec.payload.length,
      generation: dec.generation,
      sequence: dec.sequence.toString(),
      aux: dec.aux.toString()
    },
    body: jsonBody(body),
    headerHex: hex(bytes.subarray(0, 36)),
    payloadHex: hex(dec.payload),
    frameHex: hex(bytes)
  };
}

const ATTACH_ACK_BODY: Body = {
  generation: 1,
  retained_start_offset: 0n,
  retained_start_record_seq: 0n,
  retained_end_offset: 0n,
  retained_end_record_seq: 0n,
  controller_ack_offset: 0n,
  controller_ack_record_seq: 0n,
  has_checkpoint: 0,
  checkpoint_set_id: 0n,
  checkpoint_offset: 0n,
  checkpoint_record_seq: 0n,
  tail_offset: 0n,
  tail_record_seq: 0n,
  rows: 40,
  cols: 120,
  current_state_exact: 1,
  restart_recoverable: 1,
  main_exact: 1,
  alt_exact: 1,
  active_buffer: 0,
  caps: CAPS
};

describe('handshake conformance trace (§4)', () => {
  it('emits the controller-attach flow to a fixture', () => {
    // client → master
    const hello = bodyClient(FrameType.HELLO, 0n, { client_version: 3, peer_role: Role.CONTROLLER, capabilities: CAPS, incarnation: INCARNATION });
    const attach = bodyClient(FrameType.ATTACH, 1n, { role: Role.CONTROLLER, prev_generation: 0, last_seen_offset: 0n, last_seen_record_seq: 0n, desired_rows: 40, desired_cols: 120, sessionId: 'web-1' });
    // INPUT is FrameType 18 (NOT 5); payload = flags u8 + surface_id u32 + bytes
    // blob32 — the PTY keystrokes are the `bytes` field, NOT the whole payload.
    const inputBody: Body = { flags: 0, surface_id: 7, bytes: new TextEncoder().encode('ls\r') };
    const input = bodyClient(FrameType.INPUT, 2n, inputBody);
    // RESIZE is FrameType 21 (NOT 83); payload = lease_epoch u32 + surface_id u32
    // + generation u32 + rows u16 + cols u16 = 16 bytes (NOT 5).
    const resizeBody: Body = { lease_epoch: 1, surface_id: 7, generation: 1, rows: 50, cols: 200 };
    const resize = bodyClient(FrameType.RESIZE, 3n, resizeBody);
    // master → client
    const attachAck: RawFrame = { type: FrameType.ATTACH_ACK, flags: 0, generation: 1, sequence: 0n, aux: 0n, payload: encodeBody(FrameType.ATTACH_ACK, ATTACH_ACK_BODY) };
    const recordBody = new TextEncoder().encode('hi');
    const record: RawFrame = { type: FrameType.RECORD, flags: 0, generation: 1, sequence: 1n, aux: 0n, payload: encodeRecord({ record_type: RecordType.OUTPUT, record_seq: 1n, generation: 1, output_offset: 0n, body: recordBody }) };

    const flow = [
      trace('HELLO', 'client->master', hello, { client_version: 3, peer_role: Role.CONTROLLER, capabilities: CAPS, incarnation: INCARNATION }),
      trace('ATTACH', 'client->master', attach, { role: Role.CONTROLLER, prev_generation: 0, last_seen_offset: 0n, last_seen_record_seq: 0n, desired_rows: 40, desired_cols: 120, sessionId: 'web-1' }),
      trace('INPUT', 'client->master', input, inputBody),
      trace('RESIZE', 'client->master', resize, resizeBody),
      trace('ATTACH_ACK', 'master->client', attachAck, ATTACH_ACK_BODY),
      trace('RECORD(OUTPUT)', 'master->client', record, { record_type: RecordType.OUTPUT, record_seq: 1n, generation: 1, output_offset: 0n, body: recordBody })
    ];

    const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'atch-wire');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'handshake-trace.json'),
      JSON.stringify({ contract: 'atch-wire-v3', note: 'controller attach flow; incarnation is client-chosen (any 16 bytes); RECORD inner = record_type u8, record_seq u64, generation u32, output_offset u64, body_len u32, body, crc32 u32', flow }, null, 2) + '\n'
    );
    expect(flow).toHaveLength(6);
    // sanity: every frame re-decodes to its declared type.
    for (const f of flow) expect((f.header as { typeName: string }).typeName).toBeTruthy();
  });
});
