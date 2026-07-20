// atch v3 wire — frozen constants, frame-type registry, and enums.
// Byte-exact transcription of docs/atch-wire-v3.md (FROZEN 2026-07-20, consensus
// @claude-1 + @codex). This is the single source both the Desk TS codec and the
// atch C fork implement against; conformance = the golden vectors in
// tests/fixtures/atch-wire/. Pure module (src/shared): no server/web imports.

/** ASCII "ATV3". */
export const MAGIC = Uint8Array.of(0x41, 0x54, 0x56, 0x33);
export const PROTO_VERSION = 3;
export const HEADER_LEN = 36;

export const MAX_PAYLOAD = 1 << 20; // 1 MiB — per-frame payload cap
export const MAX_MSG = 16 << 20; // 16 MiB — reassembled MORE-message cap
export const MAX_UNACKED = 8 << 20; // 8 MiB — master un-acked OUTPUT window
export const MIN_ROWS = 1;
export const MAX_ROWS = 1000;
export const MIN_COLS = 1;
export const MAX_COLS = 1000;
export const MAX_CELLS = 2_000_000;
export const MAX_STR16 = 0xffff; // 65535
export const MAX_CHECKPOINT = 4 << 20; // 4 MiB
export const MAX_TERMINAL_REPLY = 256;
export const MORE_TIMEOUT_MS = 5000;
export const LEASE_TTL_MS = 15000;
export const HEARTBEAT_MS = 5000;

/** Frame types (u16). FROZEN — 30 types. */
export enum FrameType {
  HELLO = 1,
  ATTACH = 2,
  ATTACH_ACK = 3,
  DETACH = 4,
  ERROR = 5,
  HEARTBEAT = 6,
  RECORD = 16,
  OUTPUT_ACK = 17,
  INPUT = 18,
  COMMAND = 19,
  COMMAND_ACK = 20,
  RESIZE = 21,
  LEASE_CLAIM = 32,
  LEASE_GRANT = 33,
  LEASE_RELEASE = 34,
  EVENT_STREAM = 48,
  SIGNAL_REQUEST = 50,
  SIGNAL_ACK = 51,
  STATE_UPDATE = 52,
  STATE_UPDATE_ACK = 53,
  CHECKPOINT_PUT = 64,
  CHECKPOINT_ACK = 65,
  JOURNAL_READ = 66,
  JOURNAL_DATA = 67,
  CHECKPOINT_GET = 68,
  CHECKPOINT_DATA = 69,
  TERMINAL_REPLY = 70,
  GAP = 80,
  FENCE = 82,
  REDRAW = 83
}

/** The 30 valid frame-type numbers, for validation + exhaustive vector coverage. */
export const ALL_FRAME_TYPES: readonly FrameType[] = Object.freeze(
  Object.values(FrameType).filter((v): v is FrameType => typeof v === 'number')
);

/** Header flag bits (u32). */
export const Flag = {
  ROLE_CONTROLLER: 1 << 0,
  ROLE_OBSERVER: 1 << 1,
  MORE: 1 << 2,
  STRICT: 1 << 3,
  COMPRESSED: 1 << 4 // reserved, must be 0
} as const;
/** Bits that MUST be zero (reserved). Nonzero under STRICT → BAD_FLAGS. */
export const RESERVED_FLAG_MASK = ~(
  Flag.ROLE_CONTROLLER |
  Flag.ROLE_OBSERVER |
  Flag.MORE |
  Flag.STRICT |
  Flag.COMPRESSED
) >>> 0;

/** Capability bits (u32, HELLO negotiation). */
export const Cap = {
  RECORD: 1 << 0,
  COMMAND: 1 << 1,
  CHECKPOINT: 1 << 2,
  SIGNAL: 1 << 3,
  STATE_UPDATE: 1 << 4,
  REDRAW: 1 << 5
} as const;

/** Error codes (u16). */
export enum ErrorCode {
  BAD_MAGIC = 1,
  BAD_VERSION = 2,
  PAYLOAD_TOO_LARGE = 3,
  UNKNOWN_TYPE = 4,
  UNKNOWN_ROLE = 5,
  LEASE_DENIED = 6,
  BAD_SEQUENCE = 7,
  TRUNCATED = 8,
  PEER_UID_MISMATCH = 9,
  INTERNAL = 10,
  BAD_FLAGS = 11,
  CAP_UNSUPPORTED = 12,
  KEY_CONFLICT = 13,
  GENERATION_MISMATCH = 14,
  GEOMETRY_INVALID = 15
}

/** Typed journal record types (u8) — the RECORD envelope + on-disk journal. */
export enum RecordType {
  OUTPUT = 1,
  RESIZE = 2,
  EVENT = 3,
  CHECKPOINT_MARK = 4,
  TRUNCATION = 5
}

/** EVENT record subtypes (u8). */
export enum EventType {
  START = 1,
  EXIT = 2,
  SIGNAL = 3,
  GAP = 4,
  CONTROLLER = 5,
  TRUNCATION = 6,
  RECOVERY_LOST = 7,
  MASTER_LOST = 8
}

/** GAP reasons (u8). */
export enum GapReason {
  TRUNCATED = 1,
  BACKPRESSURE_OVERFLOW = 2,
  SINK_FAILURE = 3,
  RECOVERY_LOST = 4,
  GENERATION_CHANGED = 5
}

/** COMMAND_ACK results (u8). */
export enum CommandResult {
  ACCEPTED = 0,
  REJECTED = 1,
  DUPLICATE = 2,
  AMBIGUOUS = 3,
  KEY_CONFLICT = 4
}

/** Snapshot kinds (u8). */
export enum SnapshotKind {
  AUTHORITATIVE_STATE = 0,
  TERMINAL_DISPLAY = 1
}

/** Attach roles (u8) — canonical in ATTACH (header role bits ignored there). */
export enum Role {
  OBSERVER = 0,
  CONTROLLER = 1
}

/** Signals a SIGNAL_REQUEST may carry (u8). */
export enum SignalKind {
  TERM = 1,
  KILL = 2,
  INT = 3,
  HUP = 4
}

/** TERMINAL_REPLY query classes (u8). */
export enum QueryClass {
  DA1 = 1,
  DA2 = 2,
  DSR = 3,
  CPR = 4,
  DECRQM = 5,
  XTVERSION = 6,
  PIXEL_GEOM = 7,
  COLOR = 8,
  FOCUS = 9
}

/** Checksum domain tags (see §7). */
export const CKPT_DOMAIN = 'atch-ckpt-v3\0';
export const CMD_DIGEST_DOMAIN = 'atch-cmd-v3\0';

/** crc32 IEEE-802.3 (reflected, init/final 0xFFFFFFFF) — journal records. */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
