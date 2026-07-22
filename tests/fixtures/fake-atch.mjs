// Minimal fake atch master for the spawn-contract test. Reads the injected
// ATCH_GENERATION env var, writes it to the given file (so the test can assert
// the daemon injected the ledger value), opens the session socket, and answers
// the daemon's handshake with a hand-rolled ATTACH_ACK carrying that SAME
// generation — the daemon's attach resolves only on a validated ACK, so a
// silent fixture would time the attach out. Codec-free on purpose (this runs
// under plain node with no build); byte layout mirrors the frozen v3 wire:
// header = magic 'ATV3' + u16 version + u16 type + u32 flags + u32 payload_len
// + u32 generation + u64 sequence + u64 aux (36 bytes, LE).
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const sockPath = process.argv[2];
const genOutFile = process.argv[3];
const gen = Number.parseInt(process.env.ATCH_GENERATION ?? '0', 10);
writeFileSync(genOutFile, String(gen));

const ATTACH_ACK = 3;

function attachAckFrame(generation) {
  // Payload (schema order): generation u32, 6×u64 offsets, has_checkpoint u8,
  // 3×u64 checkpoint fields, tail_offset u64, tail_record_seq u64, rows u16,
  // cols u16, 5×u8 state flags, caps u32 = 106 bytes (non-essential zeroed).
  const payload = new Uint8Array(106);
  const pv = new DataView(payload.buffer);
  pv.setUint32(0, generation, true);
  pv.setUint16(4 + 48 + 1 + 24 + 16, 24, true); // rows
  pv.setUint16(4 + 48 + 1 + 24 + 16 + 2, 80, true); // cols

  const frame = new Uint8Array(36 + payload.length);
  const fv = new DataView(frame.buffer);
  frame.set([0x41, 0x54, 0x56, 0x33], 0); // 'ATV3'
  fv.setUint16(4, 3, true); // version
  fv.setUint16(6, ATTACH_ACK, true); // type
  fv.setUint32(8, 0, true); // flags
  fv.setUint32(12, payload.length, true); // payload_len
  fv.setUint32(16, generation, true); // header generation
  // sequence (u64) + aux (u64) stay zero
  frame.set(payload, 36);
  return frame;
}

const server = createServer((sock) => {
  // Accept the daemon's HELLO/ATTACH bytes, then ACK with the injected generation.
  sock.once('data', () => sock.write(attachAckFrame(gen)));
  sock.on('error', () => sock.destroy());
});
server.listen(sockPath);

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
