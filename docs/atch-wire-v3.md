# atch v3 wire protocol — FROZEN CONTRACT (Phase A interlock)

Authoritative byte-exact contract for the atch↔desk socket. Both the atch C fork and the Desk TS codec implement THIS; conformance = the shared golden vectors (`tests/fixtures/atch-wire/`). Frozen 2026-07-20 for Phase A. Wire-incompatible changes require a cross-reviewed contract-version bump; an additive frame that old non-STRICT peers can skip may remain v3 only after cross-review and golden-vector coverage. Resolves the §19 wire open-items (7C#? / 8A–8J) noted inline as `[resolves 8X#n]`.

All integers little-endian. All offsets are byte offsets from the field's start.

## 0. Constants
| name | value | note |
|---|---|---|
|`MAGIC`|`0x41 0x54 0x56 0x33` ("ATV3")|frame magic|
|`PROTO_VERSION`|`3`|u16|
|`HEADER_LEN`|`36`|fixed header bytes|
|`MAX_PAYLOAD`|`1048576` (1 MiB)|per-frame payload cap; validate BEFORE alloc|
|`MAX_MSG`|`16777216` (16 MiB)|reassembled MORE-message cap [resolves 8E#3]|
|`MAX_UNACKED`|`8388608` (8 MiB)|master un-acked OUTPUT window|
|`MIN_ROWS`,`MAX_ROWS`|`1`,`1000`|geometry clamp [resolves 8E#3]|
|`MIN_COLS`,`MAX_COLS`|`1`,`1000`|geometry clamp|
|`MAX_CELLS`|`2000000`|rows×cols ceiling; reject before worker alloc|
|`MAX_STR16`|`65535`|str16 byte length ceiling|
|`MAX_CHECKPOINT`|`4194304` (4 MiB)|snapshot blob cap|
|`MAX_TERMINAL_REPLY`|`256`|TERMINAL_REPLY bytes cap|
|`MORE_TIMEOUT_MS`|`5000`|MORE reassembly timeout|
|`LEASE_TTL_MS`|`15000`|controller lease TTL (heartbeat)|
|`HEARTBEAT_MS`|`5000`|keepalive cadence|
|`CRC32`|IEEE 802.3, poly `0xEDB88320` reflected, init `0xFFFFFFFF`, final-XOR `0xFFFFFFFF`|journal records|
|`CHECKSUM`|`SHA-256` (32 bytes), domain-tagged (see §7)|checkpoint blobs|

## 1. Frame header (36 bytes, fixed, explicit field reads — never struct-cast) [resolves 8A#1: one final table]
| off | size | field | notes |
|----|----|----|----|
|0|4|`magic`|= `MAGIC`; else ERROR(BAD_MAGIC), close|
|4|2|`version` u16|= 3; else ERROR(BAD_VERSION)|
|6|2|`type` u16|§2|
|8|4|`flags` u32|§1.1|
|12|4|`payload_length` u32|≤ MAX_PAYLOAD; else ERROR(PAYLOAD_TOO_LARGE) pre-alloc|
|16|4|`generation` u32|frame's connection generation; `0` = pre-attach sentinel [resolves 8B#4/8J#1]|
|20|8|`sequence` u64|PER-DIRECTION monotonic (client→master and master→client each own one) [resolves 8B#4]|
|28|8|`aux` u64|type-specific: OUTPUT/RECORD → the record's `output_offset`; else 0 unless a payload uses it|

### 1.1 Flags (u32 bitfield)
`bit0 ROLE_CONTROLLER` · `bit1 ROLE_OBSERVER` · `bit2 MORE` · `bit3 STRICT` · `bit4 COMPRESSED`(reserved, must be 0). Reserved bits nonzero under STRICT → ERROR(BAD_FLAGS). Role bits are authoritative ONLY in ATTACH; ignored elsewhere [resolves 8E#2].

### 1.2 String / blob encodings
`str16` = `u16 len` + `len` UTF-8 bytes, `len ≤ MAX_STR16`. `blob32` = `u32 len` + bytes; a blob whose len > `MAX_PAYLOAD - HEADER_LEN - fixed_prefix` MUST be sent MORE-chunked to `MAX_MSG` (§1.3). `bytes[16]` = fixed 16 binary bytes. `id64` = u64.

### 1.3 MORE reassembly [resolves 8A#1/8C#6]
A logical message spanning MORE frames = the CONTIGUOUS run of same-`type` frames with `MORE` set, terminated by the first same-type frame with `MORE` clear. Fragments carry increasing `sequence`; reassembly aborts (ERROR(TRUNCATED), drop partial) on: a `sequence` gap, a `type` change mid-run, total > `MAX_MSG`, or a per-message timeout `MORE_TIMEOUT=5000ms`. Only the PAYLOAD is fragmented; each fragment has its own header.

### 1.4 Capability bits (u32, HELLO negotiation) [consensus w/ @codex 2026-07-20]
`bit0 RECORD` · `bit1 COMMAND` · `bit2 CHECKPOINT` · `bit3 SIGNAL` · `bit4 STATE_UPDATE` · `bit5 REDRAW` · bits 6-31 reserved (must be 0). Negotiated cap = intersection of both HELLOs; a REQUIRED cap the peer lacks → ERROR(CAP_UNSUPPORTED). A frame whose feature bit is not in the negotiated set → ERROR(CAP_UNSUPPORTED).

## 2. Frame types (u16) — FROZEN base plus reviewed compatible extensions, 31 types
`dir`: M=master→client, C=client→master, B=both.
| type | name | dir | §payload |
|----|----|----|----|
|1|HELLO|B|§3.1|
|2|ATTACH|C|§3.2|
|3|ATTACH_ACK|M|§3.3|
|4|DETACH|C|(empty)|
|5|ERROR|B|§3.4|
|6|HEARTBEAT|B|§3.5 (empty body; keepalive)|
|16|RECORD|M|§4 — the unified typed record envelope (live OUTPUT/RESIZE/EVENT/CHECKPOINT_MARK/TRUNCATION) [resolves 8C#3/8J: OUTPUT carries record_seq]|
|17|OUTPUT_ACK|C|§3.6|
|18|INPUT|C|§3.7|
|19|COMMAND|C|§3.8|
|20|COMMAND_ACK|M|§3.9|
|21|RESIZE|C|§3.10|
|32|LEASE_CLAIM|C|§3.11|
|33|LEASE_GRANT|M|§3.12 (carries `lease_epoch`) [resolves 8D#2]|
|34|LEASE_RELEASE|C|(empty)|
|48|EVENT_STREAM|M|§3.13 — out-of-band lifecycle (also mirrored as journal EVENT records)|
|50|SIGNAL_REQUEST|C|§3.14 [resolves 8E#1]|
|51|SIGNAL_ACK|M|§3.15|
|52|STATE_UPDATE|C|§3.16 (worker→master exactness) [resolves 8G#3/8I#3]|
|53|STATE_UPDATE_ACK|M|§3.17|
|64|CHECKPOINT_PUT|C|§3.18|
|65|CHECKPOINT_ACK|M|§3.19|
|66|JOURNAL_READ|C|§3.20|
|67|JOURNAL_DATA|M|§3.21 (streams RECORD envelopes)|
|68|CHECKPOINT_GET|C|§3.22|
|69|CHECKPOINT_DATA|M|§3.23|
|70|TERMINAL_REPLY|C|§3.27 — a fenceable, grammar-bound terminal-query reply [resolves 8I#6/8F, per @codex review]|
|80|GAP|M|§3.24 (2-D bounds + reason + exactness axes) [resolves 8B/8J]|
|82|FENCE|M|§3.25 (replay→live boundary, 2-D)|
|83|REDRAW|C|§3.26 (explicit method; NOT retired) [resolves 8E#1]|
|84|TERMINAL_STATE|M|§3.28 — connection-local parser-mode preamble before ATTACH_ACK|
Unknown type + valid header ⇒ skip `payload_length`, log once (STRICT ⇒ ERROR(UNKNOWN_TYPE)).

## 3. Payload layouts
- **3.1 HELLO** `client_version u16 · peer_role u8`(0 unset/1 daemon/2 cli) · `capabilities u32` · `incarnation bytes[16]`(unforgeable per-process nonce [resolves 8F#6/8H#2]). Sent by both at connect; the two HELLOs negotiate `capabilities = intersection`; an unsatisfiable REQUIRED cap → ERROR(CAP_UNSUPPORTED).
- **3.2 ATTACH** `role u8`(0 observer/1 controller) · `prev_generation u32`(the generation the client's cursor is scoped to; `0`=none) [resolves 8J#1] · `last_seen_offset u64` · `last_seen_record_seq u64` · `desired_rows u16` · `desired_cols u16` · `sessionId str16`. `role`+`sessionId` are CANONICAL here (header role bits ignored) [resolves 8E#2].
- **3.3 ATTACH_ACK** `generation u32`(live) · `retained_start_offset u64` · `retained_start_record_seq u64` · `retained_end_offset u64` · `retained_end_record_seq u64` · `controller_ack_offset u64` · `controller_ack_record_seq u64` · `has_checkpoint u8` · `checkpoint_set_id id64` · `checkpoint_offset u64` · `checkpoint_record_seq u64` · `tail_offset u64` · `tail_record_seq u64` · `rows u16` · `cols u16` · `current_state_exact u8` · `restart_recoverable u8` · `main_exact u8` · `alt_exact u8` · `active_buffer u8`(0 main/1 alt) · `caps u32`. If `prev_generation != 0` and `!= generation` → the master ALSO emits GAP(reason=GENERATION_CHANGED) and the client resets its cursor [resolves 8J#1].
- **3.4 ERROR** `code u16` (§6) · `detail str16`.
- **3.5 HEARTBEAT** empty; each side sends every `HEARTBEAT_MS`; `LEASE_TTL_MS` without a peer heartbeat frees the lease / drops the conn.
- **3.6 OUTPUT_ACK** `ack_offset u64` · `ack_record_seq u64` (2-D resume cursor) [resolves 8C#3]. Async + bounded (`MAX_UNACKED`); overflow → master disconnects the controller (reconnect+replay). NEVER gates the PTY read loop.
- **3.7 INPUT** `flags u8`(bit0 binary=onBinary channel) · `surface_id u32` · raw bytes. User-origin only (browser reply-suppression upstream) [resolves 8G#5/8C#6].
- **3.8 COMMAND** `txnId bytes[16]` · `step u8`(0 body/1 submit) · `step_key bytes[16]` · `generation u32` · `payload_digest bytes[32]`(SHA-256 of `payload`, binds the idempotency key to bytes) [resolves 8E#6] · `payload blob32`.
- **3.9 COMMAND_ACK** `txnId bytes[16]` · `step u8` · `result u8`(0 accepted/1 rejected/2 duplicate/3 ambiguous/4 key_conflict) [resolves 8A#2/8I#6]. `accepted` ⇒ complete PTY write + persisted WRITTEN (injection proven). `ambiguous` ⇒ PREPARED-not-WRITTEN on recovery → caller fail-closed. `key_conflict` ⇒ same step_key, different digest/txn → NEVER injected.
- **3.10 RESIZE** `lease_epoch u32` · `surface_id u32` · `generation u32` · `rows u16` · `cols u16`. Only the lease owner; stale `lease_epoch`/`generation` REJECTED not replayed [resolves 8G#5]. Geometry clamped to MIN/MAX + MAX_CELLS.
- **3.11 LEASE_CLAIM** `role u8` · `forced u8`. Allowed from an attached connection requesting the controller role BEFORE it owns the lease (attached-claimant) [resolves 8D#2].
- **3.12 LEASE_GRANT** `granted u8` · `owner_conn u32` · `lease_epoch u32`(increments each grant) · `ack_offset u64` · `ack_record_seq u64` [resolves 8D#2]. Controller catches up to `ack_*` before driving.
- **3.13 EVENT_STREAM** `event_type u8`(§5 enum) · `generation u32` · `event_seq u64` · `ts_ms u64` · `body str16`. Event IDENTITY = `(sessionId, generation, event_seq)`; this is a FAST-PATH mirror of the durable journal EVENT record (§4/§5) — the receiver DEDUPES by identity so an event delivered both via EVENT_STREAM and via journal replay is applied EXACTLY once [consensus w/ @codex: retain both + dedupe].
- **3.14 SIGNAL_REQUEST** `opId bytes[16]` · `signal u8`(1 TERM/2 KILL/3 INT/4 HUP) · `escalate_ms u32`(0=none; TERM→escalate_ms→KILL) [resolves 8E#1]. Idempotent by opId.
- **3.15 SIGNAL_ACK** `opId bytes[16]` · `result u8`(0 delivered/1 no-child/2 denied) · `child_status i32`(if reaped).
- **3.16 STATE_UPDATE** `state_record_seq u64` · `worker_incarnation bytes[16]` · `current_state_exact u8` · `restart_recoverable u8` · `main_exact u8` · `alt_exact u8` · `active_buffer u8` [resolves 8I#3]. Accept only GREATER `state_record_seq`; equal-seq identical=idempotent, mismatch→STATE_UPDATE_ACK(key_conflict); lower rejected.
- **3.17 STATE_UPDATE_ACK** `state_record_seq u64` · `result u8`(0 committed/1 stale/2 key_conflict) · `committed_state_record_seq u64`.
- **3.18 CHECKPOINT_PUT** `checkpoint_set_id id64` · `generation u32` · `output_offset u64` · `record_seq u64` · `geometry_rev u32` · `rows u16` · `cols u16` · `snapshot_kind u8`(0 authoritative-state / 1 terminal-display) · `format_version u32` · `xterm_version str16` · `patch_version str16` [resolves 8J#2] · `checksum bytes[32]`(SHA-256, domain `atch-ckpt-v3`) · `snapshot blob32`(≤ MAX_CHECKPOINT, MORE-chunked). Worker PUTs BOTH kinds at one set_id/offset; the SET commits atomically (§8.1 of the spec).
- **3.19 CHECKPOINT_ACK** `checkpoint_set_id id64` · `snapshot_kind u8` · `stored u8` · `at_offset u64` · `at_record_seq u64`.
- **3.20 JOURNAL_READ** `from_record_seq u64` · `max_records u32`(≤4096) · `max_bytes u32`(≤ MAX_PAYLOAD).
- **3.21 JOURNAL_DATA** `from_record_seq u64` · `eof u8` · `record_count u32` · `records[]` — each a length-prefixed (`u32 rec_len`) RECORD envelope (§4). `rec_len` bounds each; a record whose crc32 fails or whose header disagrees with the segment header → fail-closed GAP [resolves 8C#6].
- **3.22 CHECKPOINT_GET** `at_or_before_offset u64`(u64::MAX = latest) · `at_or_before_record_seq u64` · `snapshot_kind u8` · `accepted_format_versions u32`(bitset) · `accepted_patch_versions str16`(csv) — selects the latest COMPLETE set at/before the cursor WHOSE format/patch the caller accepts [resolves 8J#2].
- **3.23 CHECKPOINT_DATA** `checkpoint_set_id id64` · `present u8` · `snapshot_kind u8` · (if present) the CHECKPOINT_PUT body (from `generation` onward).
- **3.24 GAP** `from_offset u64` · `from_record_seq u64` · `to_offset u64` · `to_record_seq u64` · `reason u8`(1 truncated/2 backpressure-overflow/3 sink-failure/4 recovery-lost/5 generation-changed) · `current_state_exact u8` · `restart_recoverable u8` · `main_exact u8` · `alt_exact u8` · `active_buffer u8`. Bounds are `[from_exclusive, to_inclusive]` in BOTH dims.
- **3.25 FENCE** `at_offset u64` · `at_record_seq u64` · `phase u8`(0 replay-end→live). Client applies up to `(at_*)` then switches to live RECORD frames.
- **3.26 REDRAW** `method u8`(0 none/1 ctrl_l/2 winch) · `rows u16` · `cols u16`. Controller-only; asks the master to trigger an app repaint (mirrors the fork's `-r`). RETAINED (consensus).
- **3.27 TERMINAL_REPLY** `query_id u64`(stable id allocated at query interception; UNIQUE per outstanding query — offset alone is insufficient, 7C#2/8I#6) · `generation u32` · `lease_epoch u32` · `source u8`(0 worker/1 lease-surface) · `query_class u8`(1 DA1/2 DA2/3 DSR/4 CPR/5 DECRQM/6 XTVERSION/7 pixel-geom/8 color/9 focus) · `reply blob32`(bounded ≤ `MAX_TERMINAL_REPLY=256`). EXACT-ONCE grammar binding: the master records the outstanding query `{query_id, expected responder(source), query_class, generation, lease_epoch, allowed grammar per class, max len}`; accepts EXACTLY ONE matching reply, consumes it atomically, and REJECTS unsolicited / duplicate / cross-class / wrong-responder / stale-generation-or-epoch / oversized bytes (→ ERROR(KEY_CONFLICT) or silent drop per class). Prevents the reply path becoming arbitrary PTY injection.
- **3.28 TERMINAL_STATE** `preamble blob32`. Optional master→client frame sent at most once, immediately before ATTACH_ACK, when the tracked terminal-mode preamble is nonempty. It is connection-local and non-durable: header `generation=0`, `aux=0`, no `record_seq`, no `output_offset`, and it never enters a RECORD envelope. A client that recognizes it feeds the bytes only to its fresh emulator and drains asynchronous parser work before accepting the following ATTACH_ACK; it MUST NOT advance the durable output cursor or fan the preamble out as browser OUTPUT. Old non-STRICT clients skip type 84 by the unknown-type rule. This is a reviewed backward-compatible v3 extension (2026-07-27, @claude-1 + @codex).

## 4. Typed RECORD envelope (shared by live RECORD frames + journal + JOURNAL_DATA) [resolves 8C#3/8J]
One layout for a record whether streamed live (frame type 16) or replayed (inside JOURNAL_DATA / on disk):
`record_type u8`(1 OUTPUT/2 RESIZE/3 EVENT/4 CHECKPOINT_MARK/5 TRUNCATION) · `record_seq u64`(monotonic per session, THE total order) · `generation u32` · `output_offset u64`(stream offset this record begins/applies at) · `body_len u32` · `body[body_len]` · `crc32 u32`(over `record_type..body`).
Bodies: OUTPUT = raw pty bytes; RESIZE = `rows u16, cols u16, geometry_rev u32`; EVENT = the §5 event body; CHECKPOINT_MARK = `checkpoint_set_id id64, output_offset u64, record_seq u64, kind0_checksum[32], kind1_checksum[32]` (references a COMMITTED set); TRUNCATION = `from_offset u64, from_record_seq u64, to_offset u64, to_record_seq u64`.
Replay = apply by `record_seq` order (offset is a secondary index; RESIZE/EVENT/MARK interleave at a shared offset — `record_seq` disambiguates). A live RECORD frame's header `sequence` is the connection sequence; `record_seq`/`generation`/`output_offset` inside the envelope are the DURABLE identity.

## 5. EVENT record types (u8)
`1 start{pid u32, master_pid u32, started_at_ms u64, cmd_basename str16, launch_digest[32]}` [resolves 8G#3] · `2 exit{code i32, signal i32, wifsignaled u8}` [resolves 8E#7] · `3 signal{signal i32}` · `4 gap{...}` · `5 controller{owner_conn u32, lease_epoch u32}` · `6 truncation{...}` · `7 recovery_lost{from_offset u64, from_record_seq u64}` · `8 master_lost{last_offset u64, last_record_seq u64}` [resolves 8J#4]. Each dedupes by `(generation, record_seq)`.

## 6. Error codes (u16)
`1 BAD_MAGIC · 2 BAD_VERSION · 3 PAYLOAD_TOO_LARGE · 4 UNKNOWN_TYPE · 5 UNKNOWN_ROLE · 6 LEASE_DENIED · 7 BAD_SEQUENCE · 8 TRUNCATED · 9 PEER_UID_MISMATCH · 10 INTERNAL · 11 BAD_FLAGS · 12 CAP_UNSUPPORTED · 13 KEY_CONFLICT · 14 GENERATION_MISMATCH · 15 GEOMETRY_INVALID`. Never dropped blind (R1).

## 7. Checksums / digests
- Journal record `crc32`: §0 params, covers `record_type..body`.
- Checkpoint `checksum[32]`: `SHA-256(domain || snapshot)` where `domain = "atch-ckpt-v3\0" || snapshot_kind`.
- `payload_digest[32]` (COMMAND): `SHA-256("atch-cmd-v3\0" || txnId || step || payload)` — binds idempotency to exact bytes [resolves 8E#6].

## 8. Connection state machine + authorization
`CONNECTING → HELLO⇄ → ATTACH(role) → [TERMINAL_STATE] → ATTACH_ACK → ACTIVE → {DETACH | close}`; controller path adds `LEASE_CLAIM → LEASE_GRANT`. Peer-UID (`SO_PEERCRED`/`getpeereid`) checked at accept; mismatch → ERROR(PEER_UID_MISMATCH) [resolves 8C#8: helper addr'd desk-side]. Pre-attach frames carry `generation=0`; any post-ATTACH_ACK frame with `generation != live` → ERROR(GENERATION_MISMATCH).
**Authorization** by connection class: observer may send ATTACH/DETACH/OUTPUT_ACK/JOURNAL_READ/CHECKPOINT_GET/HEARTBEAT/HELLO; the lease-OWNING controller adds INPUT/COMMAND/RESIZE/LEASE_RELEASE/SIGNAL_REQUEST/STATE_UPDATE/CHECKPOINT_PUT/REDRAW/TERMINAL replies; an attached-claimant may send LEASE_CLAIM. Disallowed → ERROR(UNKNOWN_ROLE/LEASE_DENIED).

## 9. Golden vectors (the shared conformance suite) `tests/fixtures/atch-wire/`
Each vector = `{name, hex_bytes, expect: parsed|error(code)}`. REQUIRED coverage: every frame type at min+boundary field values; MORE reassembly (2-fragment, N-fragment, gap-abort, type-change-abort, timeout); invalid (bad magic, bad version, payload_length=MAX+1, truncated header, truncated payload, unknown type ±STRICT, bad sequence, reserved-flag ±STRICT, role-disallowed, generation mismatch, geometry > MAX_CELLS, str16 len>MAX, blob32 needing MORE); RECORD envelope crc pass/fail; checkpoint-set select present/absent/format-mismatch; every u64 at 0, 1, 2^53-1, 2^53, 2^64-1 (BigInt/decimal-string boundary) [resolves 8C#7]. The atch C encoder/decoder and the Desk TS codec both pass byte-for-byte; a vector mismatch fails CI in both lanes.

---
STATUS: **v3 FROZEN base + reviewed compatible extension** (base 2026-07-20; TERMINAL_STATE type 84 cross-reviewed 2026-07-27 by @claude-1 + @codex). EVENT_STREAM + durable journal EVENT records are both retained and deduped by `(sessionId,generation,event_seq)` (§3.13); REDRAW type 83 is retained (§3.26); capability bits are assigned (§1.4); TERMINAL_REPLY is type 70 (§3.27). Golden vectors live under `tests/fixtures/atch-wire/` and are generated by the reference TS codec (`src/shared/atchWire/`). Further wire-incompatible changes require a cross-reviewed version bump; compatible extensions require the same review and cross-language vectors.
