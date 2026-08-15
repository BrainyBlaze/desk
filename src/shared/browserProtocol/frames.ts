// Loss-aware browser protocol (spec §7.4/§7.6/§7.7) — frozen constants + frame
// registry. The single multiplexed BINARY WebSocket between the web server and a
// browser tab. Pure module (src/shared): no server/web imports.
//
// Each WS binary message IS exactly one frame (WS preserves message boundaries),
// so there is no magic/reassembly like the legacy wire needed — just a 2-byte
// header (version, type) + a typed payload. A SUBSCRIBE assigns a compact u32
// `channelId` (returned in SUBSCRIBE_ACK); every subsequent frame routes by
// channelId instead of repeating the session/surface strings on the hot path.
// Every DATA frame (SNAPSHOT/OUTPUT) carries generation+revision so a stale
// producer's bytes are discardable at the browser.

/**
 * v2: EXIT carries the holder's tagged ending (BpExitKind + per-kind payload)
 * instead of one i32 code + u16 signal, so an unprovable ending travels as
 * `unknown` rather than a fabricated code 0. Both ends ship in this repo and
 * the browser is the only consumer, so the layout was replaced, not extended;
 * a tab still running the v1 bundle rejects every v2 frame as BAD_VERSION (and
 * the server its v1 frames) until it reloads — silence, never a mis-decoded
 * ending shown as a code.
 */
export const BP_VERSION = 2;
export const BP_HEADER_LEN = 2; // u8 version + u8 type

/** Hard per-frame payload cap (bytes). The server chunks output/snapshots below this. */
export const BP_MAX_FRAME_BYTES = 1 << 20; // 1 MiB
/** Snapshot/output chunk size the server targets (§7.4 SNAP_CHUNK). */
export const BP_SNAP_CHUNK = 256 * 1024;
/** Input payload cap per frame. */
export const BP_MAX_INPUT_BYTES = 1 << 16; // 64 KiB
/** Query request/reply byte cap (parity with the legacy wire MAX_TERMINAL_REPLY). */
export const BP_MAX_QUERY_BYTES = 256;
/** channelId 0 is reserved for connection-level frames (HEARTBEAT, conn ERROR). */
export const BP_CONN_CHANNEL = 0;

/**
 * Frame types (u8). Client→server occupy 1–15, server→client 16–31, so the
 * direction of any frame is readable from its type id alone.
 */
export enum BpFrameType {
  // client → server
  SUBSCRIBE = 1,
  UNSUBSCRIBE = 2,
  VISIBILITY = 3,
  INPUT = 4,
  RESIZE = 5,
  QUERY_REPLY = 6,
  // server → client
  SUBSCRIBE_ACK = 16,
  SNAPSHOT = 17,
  OUTPUT = 18,
  GAP = 19,
  EXIT = 20,
  HEARTBEAT = 21,
  ERROR = 22,
  QUERY_REQUEST = 23
}

/** True for client→server frame types (1–15). */
export function isClientFrame(type: number): boolean {
  return type >= 1 && type <= 15;
}
/** True for server→client frame types (16–31). */
export function isServerFrame(type: number): boolean {
  return type >= 16 && type <= 31;
}

/** INPUT flag bits (u8). BINARY set = onBinary raw bytes; unset = onData UTF-8 (§7.6). */
export const BpInputFlag = {
  BINARY: 1 << 0
} as const;

/**
 * EXIT ending kinds (u8) — the tag of the holder's outcome exactly as moor
 * reported it (the durable record's MoorExitOutcome). Each kind is followed by
 * its own payload: EXITED → u32 code; SIGNALLED → u32 signal; TERMINATED → u32
 * code + u8 BpTerminatedMethod; UNKNOWN → nothing. Widths follow moor's own
 * grammar (`code:u`, `signal:p` are u32), so a full-width Windows exit status
 * is carried whole. There is deliberately no numeric fallback: an ending the
 * grammar could not prove is UNKNOWN on the wire, never a zero.
 */
export enum BpExitKind {
  EXITED = 1,
  SIGNALLED = 2,
  TERMINATED = 3,
  UNKNOWN = 4
}

/** How a TERMINATED ending was brought about (u8), moor's `method` field. */
export enum BpTerminatedMethod {
  GRACEFUL = 1,
  FORCED = 2
}

/** Browser-protocol error codes (u16), carried in ERROR frames. */
export enum BpError {
  BAD_VERSION = 1,
  UNKNOWN_TYPE = 2,
  TRUNCATED = 3,
  PAYLOAD_TOO_LARGE = 4,
  BAD_CHANNEL = 5,
  STALE_GENERATION = 6,
  STALE_LEASE = 7,
  INTERNAL = 8,
  INPUT_UNAVAILABLE = 9
}
