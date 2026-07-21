# atch refactor — DESK lane build status

Branch `atch-native`. This is the Desk-side (TypeScript) half of the
tmux→atch replacement specced in `desk-atch-refactor-spec.md`. The atch C fork
lane is owned by @codex on a separate worktree; the two lanes meet at the frozen
v3 wire contract.

Goal (per @human): completely replace tmux with the owned BrainyBlaze/atch C
fork, refactoring the architecture around a single screen/query authority — no
legacy fallbacks. Three tiers: **atch v3 master** (per-session C process) |
**desk-runtime daemon + xterm-worker** (HTTP-independent screen/query authority) |
**web server** (client).

## Status headline (honest)

**The real lane-join is PROVEN** — the daemon spawns a real atch session
(`atch start`, `ATCH_GENERATION` injected from the durable ledger), attaches over
the v3 socket, and a real terminal **round-trips multi-line input→output** through
the real binary, with the generation fence, v3 handshake, spawn contract, and
detached lifecycle all live (4-case smoke, stable over repeated runs, opt-in via
`RUN_REAL_JOIN=1`). Both the C master and the TS daemon are green together.

**The tmux replacement is NOT shipped.** The protocol + daemon + master link are
proven, but the running product still uses tmux. Shipping the replacement
requires the explicit remaining gates in "Integration boundary" below — the real
`@xterm/headless` worker, the frontend rewrite, the §10 FS-store transforms, and
the live cutover — none of which are done. Do not describe tmux as replaced until
those gates are closed.

## What this branch delivers — built, tested, reviewable

All pure logic is `src/shared` with persistence/IO expressed as **ports**, so the
correctness rules are unit-testable; the server-side runtime wires real sockets,
processes, and the atch binary. `tsc --noEmit` 0 errors, node v22.23.1; full
project suite **2630 passed, 0 failures** (real-binary tests opt-in), `npm run
check` clean.

**The daemon side is COMPLETE end-to-end** (tested against fakes + real sockets;
the real atch binary and `@xterm/headless` emulator drop in behind clean seams):
a runnable unix-socket RPC daemon (`daemonServer.ts` + `daemonClient.ts`), a
multi-session registry (`daemonCore.ts`), the atch-master v3 link
(`masterClient.ts`), the full session pipe (`sessionManager.ts` — ensure → attach
master → master OUTPUT to browser, browser INPUT to master), and durable
fsync'd/restart-surviving stores for the fence, exactly-once intake + consumer,
and CMD_CACHE (`fileGenerationLedger` / `fileIntakeStore` / `fileConsumerStore` /
`fileCmdCache`). A byte-level handshake trace fixture is the C-adapter oracle.

| Spec | Module | What it is | Commit |
|---|---|---|---|
| §4 wire | `src/shared/atchWire/` | Frozen v3 wire codec — 36-byte header, 30 frame types, MORE reassembly, typed RECORD envelope, 2 variable-shape frames (CHECKPOINT_DATA present-discriminator, JOURNAL_DATA record-array). Complete **30/30 golden vectors** + 2 invalid. | `32ce420`, `47fe138` |
| §6 (C16) | `src/shared/controlPlane/` | Source-tagged lifecycle (`unknown`-extended), precedence + **staleness-drop** resolution, **generation fence**, **exactly-once** intake (invocationId dedup + atomic sourceSeq) and consumer (cursor + receipt outbox). | `0c7e8e3` |
| §4.8.1 (H8) | `src/shared/controlPlane/generationLedger.ts` | Durable **tombstone generation ledger** backing the fence — generation survives delete+recreate (never reset/reissued), so a reused sessionId can't admit a stale hook. | `8c4f59c` |
| §7.4 | `src/shared/browserProtocol/resync.ts` | Loss-aware per-subscription resync FSM — contiguity-gated live, gap→dirty→resnapshot, stale-vs-advanced generation/revision discard. | `b2fca49` |
| §8.1 (C3) | `src/shared/recovery/checkpointSelect.ts` | The **R-xterm-patch recovery ladder** — exact pinned-patch checkpoint → full replay → fail-closed degrade; kind-1 display never used for authoritative recovery. | `3a4fe18` |
| §4.9 | `src/shared/journal/journalReplay.ts` | `record_seq` **total-order replay projector** (recovery + history); per-type projection, EVENT dedup, TRUNCATION gap vs undeclared-loss discontinuity. | `4bf5388` |
| §6.10 (H1) | `src/shared/delivery/` | Transport-vs-semantic phase FSM (accepted ≠ delivered), marked/unmarked confirm, CMD_CACHE PREPARED/WRITTEN/ACKED with a fail-closed retry horizon. | `63ca2b0` |
| §7.4/§7.7 | `src/shared/browserProtocol/` | Loss-aware binary WS framing (14 frames, channelId multiplex, generation+revision) + reply-suppression responder matrix / CSI-OSC query classifier (set-vs-query, no over-suppression). | `33940cf` |
| §7.5/§7.9 | `src/shared/lease/` | Controller/resize lease — epoch-fenced handoff, forced-takeover demotion, TTL auto-release, catch-up ack-offset. | `eea031d` |
| §8.2 (C4) | `src/shared/recovery/` | Two independent trust axes (`current_state_exact` vs `restart_recoverable`) + per-buffer provenance + hidden-state re-establishment oracle. | `8e97255` |
| §3.2/§3.3 | `src/shared/runtime/` | Daemon pure cores — worker supervisor (fail-closed cap, bounded backoff, sharding, visible-first restore), PID+start-time instance lock, versioned RPC, emulator port. | `0ba6ee3` |
| §7.1 | `src/shared/runtime/sessionRuntime.ts` | **SessionRuntime** — composes all five layers; an integration test drives REAL wire records + REAL browser frames through it end-to-end. | `3c785ee` |
| §3.2/§3.6 | `src/shared/runtime/daemonCore.ts` | **DaemonCore** — the multi-session registry composing the generation ledger + fail-closed cap + per-session runtimes + lease into a callable daemon. The fence holds across delete+recreate at the daemon level. | `39db2f3` |
| §3.2/§3.7 | `src/server/runtime/daemonServer.ts` | **DaemonServer — the RUNNABLE daemon**: a real single-instance unix-socket server (PID+start-time lock, stale-lock repair, 0700/0600) framing versioned RPC (ping/ensure/retire/list/state/stop) into DaemonCore. Node stdlib only; runs + tested over a real socket today. | `4d51718` |
| §4.8.1 | `src/server/runtime/fileGenerationLedger.ts` | **Durable fsync'd** append-only generation ledger — the fence survives a daemon RESTART (torn-tail safe, monotonic guard). Demonstrates the durable-adapter pattern the intake/consumer/CMD_CACHE stores follow. | `83b88c3` |
| §7.8/§7.6/§15 | `tests/byteIntegrity.gate.test.ts` | Shipping gate: OUTPUT byte-integrity across EVERY split boundary + one-byte-at-a-time (binary end-to-end), and the 256-value two-channel INPUT gate. | `d1f96ec` |
| §6.9/§3.6 | `src/shared/runtime/nativeLifecycle.ts` | Daemon-owned native agent-host FSM (starting→ready→working/idle→exited/crashed) + control-plane `native-fsm` projection + bounded-backoff restart. Establishes the **atch-terminal-only vs daemon-native ownership boundary** as code (C14). | `1913607` |
| §10 | `src/shared/migration/` | tmuxSession→sessionId grammar/minting, submitState **repair map (never import legacy as `done`)**, resumable phase FSM. | `5c7c71f` |
| §7.1/§4 | `src/server/runtime/masterClient.ts` + `spawnMaster.ts` + `sessionManager.ts` | The **atch-master v3 link + spawn**: MasterClient (handshake, generation-stamped post-attach frames, RECORD intake), spawnMaster (`ATCH_GENERATION` inject, detached mode), SessionManager (detached spawn/kill lifecycle). | `a529c91`, `bffc660`, `cc63634` |
| §7.1/§4 | `tests/realJoin.integration.test.ts` | **The proven real join** (opt-in `RUN_REAL_JOIN=1`): real atch spawn + v3 attach + multi-line round-trip + RESIZE + production detached spawn/kill, all against the real binary. | `a529c91`, `cc63634` |

## The shared interlock is validated both directions

The v3 wire contract (`docs/atch-wire-v3.md`) + golden vectors
(`tests/fixtures/atch-wire/vectors.json`) are the single artifact both lanes
build against. As of this writing:

- **My TS codec** encodes/decodes all 30 frames byte-exactly against the vectors.
- **@codex's C codec** validates all 30 vectors from `47fe138` byte-for-byte
  (C commits a21989b wire + 2fbc20d durable core, green on wire/security/durable
  tests + 229/229 legacy regression).

So the seam is conformant on both sides before the lanes join.

## Integration boundary — the explicit remaining gates to ship the replacement

The protocol, daemon, and master link are **proven live** (see the status
headline). What remains before tmux is actually replaced in the running product —
each an explicit gate, none done:

1. **Daemon process glue** — the unix-socket RPC server+client, registry, master
   v3 link, session pipe, spawn, and fsync'd persistence adapters are DONE and
   the real-atch join is proven. What remains behind the seams: the worker child
   processes, native host supervision + rendezvous, and the HTTP hook-intake
   endpoint.
2. **Real `@xterm/headless` emulator adapter** — the `EmulatorPort`
   implementation. `@xterm/headless` is a new runtime dep (§3.3, H10) not yet
   installed; adding it is a packaging step (lockfile, `npm ci`, ~500-pkg tree).
   The port + fake keep everything else testable meanwhile.
3. **FS-store transforms** — the §10 per-store transforms (manifest,
   channelsPaused, resume state, LSP wiring, AgentSurface re-mint) that the
   repair map + phase FSM here drive.
4. **Frontend integration** — the `terminalBrokerClient` binary rewrite, the
   xterm reply-suppression addon (registerCsiHandler wiring), and the
   TerminalSurface two-input-channel wiring.
5. **The live tmux→atch cutover** — replacing the terminalBroker /
   channelsEngine seams in the running product.

Items 1, 4, and 5 fundamentally require @codex's real atch binary (the master to
talk to) and a live browser/server environment to validate — i.e. they land when
the lanes join, not before.

## Cross-review

- @codex validated the wire vectors against his C codec byte-for-byte (above).
- **I reviewed @codex's C wire codec** (`atch_wire_v3.c`) for memory safety +
  malformed-input robustness (what vectors can't cover): traced every decode path
  — verdict **memory-safe and well-bounded**, no memory bugs; four minor
  defense-in-depth notes returned. That review also surfaced a **real bug in MY
  TS codec**: `RESERVED_FLAG_MASK` excluded bit4 (COMPRESSED) while his C (and
  doc §1.1) treat it reserved — my decoder silently accepted a reserved bit. The
  30 vectors missed it (no reserved-flag invalid vector). Fixed in `0677e3f`:
  mask aligned to `0xfffffff0` + backfilled the missing invalid vectors.
- @codex will cross-review these DESK commits against the frozen seam after his
  Task 3; findings will be addressed here.
- Next: review @codex's framing/registry/journal seams at his named commit.

Lesson: shared conformance vectors only validate what they exercise — reading
the peer implementation caught a divergence the vectors did not.

### Native-ownership consensus (§6.9 / C14)

@codex's atch Task4 (terminal launch/process integration) broke 39 legacy tests.
Grounding it in the spec resolved ownership: **atch is terminal-PTY-only (§5.2
C14 "native is not atch's"); native session lifecycle is daemon-owned (§6.9,
§3.6).** @codex confirmed and is holding his green terminal-only gate (dropping
the corrective changes) while the daemon owns native lifecycle. I delivered that
boundary as executable code (`nativeLifecycle.ts`, `1913607`) so both lanes agree
on ownership. The live daemon glue that runs real host processes lands at
lane-join.

## Blocker for @human at delivery

**D-1 (license).** The atch fork is GPL upstream. BrainyBlaze owns the fork, so
the **build** proceeds; **public DISTRIBUTION** of the atch binary stays gated on
the upstream GPL grant — the one item that cannot be cleared autonomously
(external/legal). This blocks distribution, NOT the build, and is flagged for
@human at delivery.
