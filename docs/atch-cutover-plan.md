# atch-native — live cutover plan (canary-gated)

G1 authorized by @human (2026-07-21). Joint plan (@codex C lane, claude-1 DESK TS
lane). **No live launch until the footprint is posted and reviewed.** The live
tmux/string server stays the default and untouched until the canary gate passes.

Rollback at every point: stop the canary process, restore the immutable store
backup. Nothing in the live product's stores is mutated before the gate.

---

## Phased sequence

**Phase 0 — freeze + backup.** Hash the current Desk manifest and the
paused/durability stores; take an immutable backup; quiesce writes for the window.

**Phase 1 — dry-run transforms.** Run the pure §10 transforms (manifest, paused,
durability) in plan/validate mode against COPIES of the real data. Require zero
unexpected unmapped entries before proceeding.

**Phase 2 — build the canary code (isolated, no live mutation).** Implement, each
step reviewed and behind green tests, exercised only against an isolated canary
data root:
- Step 1 — schema: add `sessionId` to `DeskSession`/`SessionSpec` as the identity;
  keep `tmuxSession` transitionally as a migration read-source only, dropped in
  Phase 5.
- Step 2 — store application: wire the pure transforms to the on-disk stores at
  startup through the phase FSM (quiesce → backup → transform → validate → commit),
  keyed off the manifest map.
- Step 3 — deskRuntime wiring: instantiate the daemon and mount
  `installTerminalWsBridge` on `/ws/terminal`; provision a daemon session on
  desk session-start via `SessionManager.spawnAndAttach` of the real atch master
  with `ATCH_GENERATION`, replacing the tmux `new-session` path.

**Phase 3 — canary boot behind a reviewed footprint.** Post the planned footprint
(below) for review; only then boot ONE isolated canary process; provision ONE
canary session through the sessionId schema + binary path; validate browser/WS,
input/output, resize, reconnect, snapshot, retire, and store durability. Then
publish the ACTUAL PID/port/socket/config/process footprint + evidence.

**Phase 4 — GATE.** Canary green + footprint/evidence reviewed by @codex and
@human → request authorization for the default flip + legacy deletion.

**Phase 5 — default flip + legacy deletion (post-gate only).** Make the binary
path the default terminal transport; delete the tmux `terminalBroker`,
`terminalBridge`, the string `terminalBrokerClient`/protocol, tmux options, the
tmux capture/resize/repaint routes, and the `channelsEngine` tmux send-keys, per
R9.4 (no fallbacks); drop the transitional `tmuxSession` field.

---

## Lane split

- **claude-1 (DESK TS):** the whole TS cutover — schema, store application,
  deskRuntime wiring, canary, default flip, legacy deletion.
- **@codex (atch C):** atch binary availability, the session provisioning CLI
  contract (below), C-side review.

---

## Provisioning contract (verified by @codex from the C source)

- **CREATE:** `atch start ABSOLUTE_SOCKET_PATH AGENT_COMMAND ARGS`. cwd/env are
  inherited from the spawned child; `ATCH_GENERATION` is injected by `spawnMaster`
  immediately before exec (not by the CLI). This fork defaults its session dir to
  `/tmp/.atch-UID`; a name containing a slash is treated as the socket path, so a
  dedicated ABSOLUTE socket root isolates the canary.
- **Readiness:** the socket file appears, then the v3 HELLO/ATTACH handshake.
- **KILL:** `atch kill -f ABSOLUTE_SOCKET_PATH` (force) or
  `atch kill ABSOLUTE_SOCKET_PATH` (graceful) for retire.
- **LIST:** `atch list [-a]` only covers the DEFAULT session dir and is NOT
  sufficient for custom absolute socket roots. Running-set detection must
  enumerate the manifest's known socket paths and probe socket/master state, not
  infer from global list output.

---

## Canary footprint (planned — posted for review before any boot)

- `HOME=<canary data root>` (e.g. `/tmp/desk-canary/home`) — isolates
  `~/.config/desk` manifest + `_engine` paused/durability stores from the live
  product.
- `DESK_HOST=127.0.0.1`, port **5174** (non-default; the live server's port is
  untouched).
- atch socket root: a dedicated absolute path per session (e.g.
  `/tmp/desk-canary/atch/<sessionId>.sock`), created + chmod'd, passed as the
  CREATE socket path.
- binary WS endpoint `/ws/terminal`; the tmux `/ws/terminal-broker` route stays
  live on the untouched server.
- `ATCH_GENERATION` — injected per session by `spawnMaster` from the ledger
  (internal, not a boot env).
- Agent credentials: the canary HOME lacks `~/.claude.json`/`~/.codex`/opencode
  auth (the known fixture-completeness gap). The canary validates the terminal
  path with a simple command (a shell / `cat`) so no agent creds are needed; if a
  real agent session is wanted, copy the credential set per the fixture protocol.
- The actual PID/port/socket paths are published as evidence AFTER the boot.
