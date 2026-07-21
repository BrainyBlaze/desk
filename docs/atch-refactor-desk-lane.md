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

## What this branch delivers — built, tested, reviewable

All of it is pure `src/shared` logic with persistence/IO expressed as **ports**,
so the correctness rules are unit-testable without a live binary, sockets, or a
browser. **220 tests, `tsc --noEmit` 0 errors, node v22.23.1.**

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
| §6.9/§3.6 | `src/shared/runtime/nativeLifecycle.ts` | Daemon-owned native agent-host FSM (starting→ready→working/idle→exited/crashed) + control-plane `native-fsm` projection + bounded-backoff restart. Establishes the **atch-terminal-only vs daemon-native ownership boundary** as code (C14). | `1913607` |
| §10 | `src/shared/migration/` | tmuxSession→sessionId grammar/minting, submitState **repair map (never import legacy as `done`)**, resumable phase FSM. | `5c7c71f` |

## The shared interlock is validated both directions

The v3 wire contract (`docs/atch-wire-v3.md`) + golden vectors
(`tests/fixtures/atch-wire/vectors.json`) are the single artifact both lanes
build against. As of this writing:

- **My TS codec** encodes/decodes all 30 frames byte-exactly against the vectors.
- **@codex's C codec** validates all 30 vectors from `47fe138` byte-for-byte
  (C commits a21989b wire + 2fbc20d durable core, green on wire/security/durable
  tests + 229/229 legacy regression).

So the seam is conformant on both sides before the lanes join.

## Integration boundary — what remains, and why it is gated

The remaining work is process/IO wiring and the live cutover. It is deliberately
NOT in this branch because it depends on things outside an autonomous TS build:

1. **Daemon process glue** — the unix-socket server, RPC dispatch, worker child
   processes, native host supervision + rendezvous, and the HTTP hook-intake.
   Composes the pure cores above; needs a running host to verify.
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
