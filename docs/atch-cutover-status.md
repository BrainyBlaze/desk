# atch-native — cutover-readiness status

Joint status from the two build lanes (@codex: the atch C fork; claude-1: the DESK
TypeScript lane). Honest accounting of what is **proven on the branch** versus the
**gated decisions @human owns**. No claim that tmux is replaced in the running
product — it is not.

Branch: `atch-native`. Verification baseline: **full suite 2679 passed / 12 skipped
/ 0 failed, `tsc` 0**, node v22.23.1. Opt-in real-binary tests pass against
@codex's rebuilt atch binary (`RUN_REAL_JOIN=1`).

---

## Proven on the branch

**Frozen wire contract, both codecs interlocked.** The atch v3 wire (36-byte header,
30 frame types, typed RECORD envelope) is frozen with 30/30 golden vectors that MY
TS codec and @codex's C codec both pass byte-for-byte. Cross-review of the peer
implementation caught real bugs on both sides (my `RESERVED_FLAG_MASK`, his
RESIZE/ATTACH_ACK/generation-source), all fixed and re-verified.

C lane (@codex, verbatim): "C atch v3 adapter, generation fence, framed
INPUT/RESIZE, dual output-path isolation, and progress-loop fix are verified by
clean C conformance/security/durable/spawn tests, legacy 229/229, and the real
daemon lane-join smoke; no live product cutover has been authorized or performed."

**Full DESK-lane daemon, unit + integration tested.** control plane (generation
fence, exactly-once intake), delivery phases (transport-vs-semantic, CMD_CACHE
horizon), browser protocol (loss-aware resync FSM, reply-suppression matrix), lease,
recovery, the multi-session DaemonCore + SessionRuntime, and durable fsync'd stores
(fence/exactly-once/delivery survive restart).

**Real lane-join — daemon ↔ real atch master.** The daemon spawns a real atch
session (`ATCH_GENERATION` injected), attaches over the v3 socket, and multi-line
input/output round-trips through the real binary; generation fence + v3 handshake +
spawn contract + detached lifecycle all live.

**Binary vertical proven end-to-end (minus the browser DOM).** @codex ran
`binaryBridgeRealJoin.integration.test.ts` 1/1 against real components: the actual
`BinaryTerminalBrokerClient` over a real ws socket → `installTerminalWsBridge` →
`TerminalWsRouter` → daemon `SessionManager` → real `@xterm/headless` → real atch
master, with a binary INPUT reaching the real shell and its echo returning as OUTPUT
the client applies through its resync FSM.

**Frontend + server bridge.** `binaryTerminalBrokerClient` (browser protocol +
resync), `TerminalSurface` two-input (onData/onBinary) + reply-suppression addon,
and `installTerminalWsBridge` mounting the router on a real `/ws/terminal` ws
upgrade (additive; the tmux `/ws/terminal-broker` route untouched).

**§10 migration — pure transform logic complete.** manifest transform (mints the
canonical tmuxSession→sessionId map, phase-4 validate), channelsPaused re-key, and
durability re-key + submit-repair (nothing legacy imports as `done`). Finding: only
paused + durability are separate keyed FS stores; the resume id is a manifest field
and AgentSurface identity is runtime-derived — neither is a separate store.

Commits (newest first): `bb7ee05`, `90f537c`, `98d1ec9`, `d96977b`, `afe82c2`,
`cca995a`, `eb7d67f`, `0252449`, `a817944`, plus the daemon/wire/control-plane
foundation before them.

---

## Gated — @human's decisions

**G1 — Live cutover authorization.** Making the binary path the product's terminal
transport requires: a product-wide `sessionId` schema change (`DeskSession` has no
`sessionId` field today), applying the §10 transforms to the running stores,
`deskRuntime` wiring + real session provisioning, flipping the default off tmux, and
deleting the tmux/string paths (R9.4, no fallbacks). The server still runs the tmux
path. This needs @human's go and a live browser/server env for final validation; we
will post the exact port/config/process footprint BEFORE booting anything.

**G2 — D-1 atch license.** The atch fork is GPL upstream. Building proceeds
(BrainyBlaze owns the fork), but public **distribution** is blocked until the GPL
grant / relicense is clarified. Legal/@human decision; it blocks distribution, not
the build.

---

## What we recommend

The non-gated buildable engineering on both lanes is complete and the binary vertical
is proven end-to-end. We are holding for @human on **(a)** cutover authorization —
after which we post the isolated footprint and execute the cutover behind it — and
**(b)** the atch license path for distribution. We are not starting the remaining
daemon productionization (HTTP hook-intake endpoint, native-host supervision) without
a cutover decision, since that design should inform them.
