# Agent activity state — research (lane: @claude-1)

Scope of this lane: the official state mechanisms of Claude Code and OpenCode,
feasibility of hook / status-line / TUI / atch-level capture, and an adversarial
case against parsing agent state out of terminal output. @codex owns the Desk
inventory, Codex mechanisms, contribution rules, and the existing attention spec.

Every claim below is checked against ground truth on this machine — installed
type definitions, the shipped binaries, and the Desk source at
`dcaf090` — not against blog posts. Provenance is named per claim.

---

## 1. Verdict

A precise working/idle answer is available for all three agents **from typed
sources only**. No terminal parsing is required, and none should be admitted.

The problem is not a missing signal. It is that Desk already receives most of
the signal and then destroys it: the typed events are folded into a boolean
"attention" lamp for the UI, and the one real state machine that exists is
private to the channels engine, unreachable by any other subsystem, and its
expiry path is dead code.

---

## 2. Ground truth per agent

### 2.1 Claude Code

Evidence: `https://code.claude.com/docs/en/hooks`, `.../statusline`, both
fetched 2026-07-27; local CLI at `/home/dev/.local/bin/claude`.

| Signal | Hook / field | Meaning | Guarantee |
| --- | --- | --- | --- |
| work starts | `UserPromptSubmit` | before the model sees the prompt | fires once per turn |
| work ends | `Stop` | model finished responding | once per turn, **not on error** |
| work ends badly | `StopFailure` | turn ended on an API error; matcher carries `rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, … | only on error |
| blocked on user | `PermissionRequest`, `Notification[permission_prompt]`, `Notification[elicitation_dialog]` | approval dialog open | on the dialog |
| idle nudge | `Notification[idle_prompt]`, `Notification[agent_needs_input]`, `Notification[agent_completed]` | waiting on the human | on notification |
| **still working** | `PreToolUse`, `PostToolUse`, `PostToolBatch`, `MessageDisplay` | a tool ran / text is streaming | per tool call, per stream chunk |
| session bounds | `SessionStart` (`startup\|resume\|clear\|compact\|fork`), `SessionEnd` | | every session |

The status line is **not** a state source. Its stdin payload carries
`session_id`, `model`, `workspace`, `version`, `cost`, `context_window`,
`exceeds_200k_tokens` — and no activity field. It is event-driven, debounced at
300 ms, and an in-flight script is cancelled when a new update arrives. Its
firing *rate* correlates with activity, which is exactly the kind of inference
this document argues against. Verdict: display surface, never an input.

### 2.2 OpenCode

Evidence: `@opencode-ai/sdk@1.17.7` and `@opencode-ai/plugin@1.17.7` installed
under `/home/dev/.opencode/node_modules`; binary reports 1.17.18.

The plugin `event` hook is typed `event: Event` where `Event` is imported from
`@opencode-ai/sdk` — i.e. the **v1** union in `dist/gen/types.gen.d.ts`. That
union is authoritative for what a plugin can observe.

OpenCode is the only one of the three that publishes an explicit activity state:

```ts
export type SessionStatus = { type: "idle" } | { type: "retry"; attempt: number; message: string; next: number } | { type: "busy" };
export type EventSessionStatus = { type: "session.status"; properties: { sessionID: string; status: SessionStatus } };
```

There is also `GET /session/status` returning `{ [sessionID]: SessionStatus }` —
a **pollable** truth, which is what makes reconciliation after a Desk restart
possible without guessing.

Additional typed slots usable as work-start and heartbeat: the `chat.message`
hook ("called when a new message is received"), `tool.execute.before` /
`tool.execute.after`, and the `message.part.updated` event.

`permission.updated` and `permission.replied` are the real permission events;
the `permission.ask` **hook slot** (`Hooks["permission.ask"]`) is real and
separate.

### 2.3 Codex (cross-check only — @codex's lane)

Evidence: `codex-cli 0.145.0`; hook event names extracted from the native binary
at `…/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.

Present in the binary: `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PermissionRequest`,
`Notification`, `PreCompact`. Hook execution is gated by a persisted **trust**
record (`--dangerously-bypass-hook-trust`, `[hooks.state]` in `config.toml`),
which Desk already models as `codex-hook-untrusted`.

Correction to hand to @codex: `tests/agent-hooks.test.ts` pins the belief that
Codex has no `SessionEnd` ("does not invent unsupported SessionEnd hooks").
`SessionEnd` is present in 0.145.0 and is in active use in this machine's
`~/.codex/hooks.json` by an unrelated tool.

---

## 3. What Desk does with it today

Three parallel representations of one fact, fed by overlapping sources.

**A. `attentionTracker`** — [src/server/attention.ts](/home/dev/projects/desk/desk/src/server/attention.ts).
A boolean lamp plus a 200-entry event ring. Fed by the daemon's bell/OSC 9 ring
and by typed events after they are downgraded through
`eventToLegacySignal()` to one of four legacy kinds. This is the **only** model
that reaches the UI, via `/api/pulse`.

**B. `AgentPresenceModel`** — [src/server/agentPresence.ts](/home/dev/projects/desk/desk/src/server/agentPresence.ts).
The real state machine: `working | idle | blocked | offline`, colour, blocked
reason, degraded reason, staleness. Constructed at
[channelsEngine.ts:592](/home/dev/projects/desk/desk/src/server/channelsEngine.ts)
as a **private field**. Never exported, never serialised, never reaches an API.

**C. `runtime.busy` / `runtime.awaitingApproval`** — a third encoding, derived
from B inside the channels engine.

The UI therefore renders from two bits only:
`<StatusDot state={session.state} attention={boolean} />` — process liveness and
a lamp. "Working" is not representable, so it is not rendered anywhere.

---

## 4. Defects found in this lane

Each is falsifiable; each is a deletion or a rewire, not a new layer.

**D1 — the state machine is unreachable.** B is private to the channels engine.
Sidebar, multiplexer, and the events subsystem cannot read it. Fixing indicators
by adding a fourth model would be the wrong repair.

**D2 — expiry is dead code.** `reconcileLiveness()` has no production call site
(only `tests/agent-presence.test.ts`). Presence therefore never expires: a
session whose agent is SIGKILLed keeps its last colour forever. An agent that
died mid-turn stays green/`working` indefinitely.

**D3 — no heartbeat exists.** `heartbeat` is a declared `AgentEventKindV2` that
nothing emits, because no `PreToolUse`/`PostToolUse` hooks are installed for
Claude or Codex and no `tool.execute.*` hook is registered for OpenCode. So a
turn is a single interval with no interior evidence, and the only defence
against a missed `Stop` is D2's dead timer.

**D4 — OpenCode has two dead branches.** In
[src/core/opencode/desk-attention.js](/home/dev/projects/desk/desk/src/core/opencode/desk-attention.js)
the `case "permission.asked"` and `case "question.asked"` arms match event names
that are absent from the v1 `Event` union the hook receives. They never run.
Approvals still work through the separate `permission.ask` hook slot; **input
requests do not** — OpenCode can never reach `blocked/input`.

**D5 — OpenCode can never reach `working`.** The plugin posts no work-start
event, and the one signal that carries the answer, `session.status` with
`{type:"busy"}`, is forwarded as a generic `session-status` string which
`AgentPresenceModel` explicitly ignores (`case 'session-status': break`). Desk
receives the exact truth and drops it.

**D6 — `stop-failure` reports the wrong thing.** A `StopFailure` whose matcher
is `rate_limit` or `overloaded` means the agent is alive and idle. The model
maps it to `offline` + red. Rate-limited agents are reported as dead.

**D7 — `blocked` is coloured `green`.** `approval-requested` and
`input-requested` set `color: 'green'` while setting `status: 'blocked'`. Green
reads as "working" to an operator, so the one state that actually demands the
human is styled as the one that does not.

**D8 — the typed→legacy downgrade is lossy by construction.**
`eventToLegacySignal()` collapses eleven typed kinds into four legacy signals and
returns `undefined` for `prompt-submitted`, `session-start`, `session-end`,
`heartbeat`, `delivery-ack`. Everything the UI could use to say "working" is
discarded at exactly this line.

---

## 5. The adversarial case against reading state from the TUI

Stated as the position this lane defends, so it can be attacked directly.

**Terminal output must not be a state source, and must not survive as a
fallback.**

1. *No contract.* A status word is UI text. Claude Code deliberately randomises
   its working word; Codex renders its own; both are free to change in any
   patch, and neither is versioned or documented as an interface.
2. *Frames, not transitions.* These are alt-screen TUIs that repaint. An
   emulator observes a screen, not an event boundary. Deriving "the turn ended"
   from a repaint means inventing an edge that the source never emitted.
3. *Failure direction is wrong.* A parser that stops matching does not report
   "unknown"; it reports "not working". Silent degradation to a plausible wrong
   answer is worse than an explicit gap, because nothing alerts.
4. *The existing bell path shows the shape of the problem.* BEL/OSC 9 is an edge
   with no author: any child process ringing the terminal produces the same
   byte. It cannot distinguish "the agent finished" from "grep hit an error".

The honest alternative for a source Desk cannot type: report `unknown`. An
operator who sees `unknown` investigates; an operator shown a confident wrong
`idle` does not.

Consequence for the refactor: the daemon's bell/OSC 9 attention ring is a
**candidate for deletion**, not for retention behind the typed path. It should
survive only if @codex's inventory shows a state it alone can observe.

---

## 6. Proposed model

One authority, one shape, one delivery path.

**Source precedence** (highest first), per session:
1. an explicit agent-published state — today only OpenCode `session.status`;
2. typed lifecycle edges — `prompt-submitted` / `stop` / `stop-failure` /
   permission / input / session bounds;
3. typed heartbeat — tool-use hooks, proving a long turn is still alive;
4. process liveness from the daemon — the floor that can only *demote*.

Liveness never promotes: a live process is not evidence of work. It can only
force `offline`.

**States:** `working` | `blocked(approval|input)` | `idle` | `offline` |
`unknown`. `unknown` is a first-class state, not a synonym for idle, and is what
a session shows before its first typed event and after its evidence goes stale.

**Freshness:** every snapshot carries the timestamp and kind of the evidence
that produced it. `working` without a heartbeat inside the heartbeat window
decays to `unknown`, never silently to `idle`. Decay is driven by a real timer
with a production call site — the defect in D2 is precisely the absence of one.

**Delivery:** the snapshot is part of the existing pulse payload, so sidebar,
multiplexer, channels footer, and the events subsystem all read the same bytes.
No subsystem derives state locally.

**Deletions this implies** (the point of the exercise — no parallel layers
survive): the boolean attention lamp as an independent model, the
typed→legacy signal downgrade, `runtime.busy`/`awaitingApproval` as an
independent encoding, and the bell/OSC 9 ring unless @codex justifies it.

---

## 7. Open questions for @codex

1. Does anything in your inventory read the daemon's bell/OSC 9 ring for a state
   that no typed source can produce? If not, it is deleted, not wrapped.
2. Where does the supervisor's stuck-detection watchdog get its evidence, and
   does it become a consumer of the authority or a fifth model?
3. Confirm the Codex hook trust gate: if hooks are untrusted, the correct
   displayed state is `unknown` with a visible reason, not `idle`.
4. Confirm whether any consumer needs a state *history* rather than a current
   snapshot; that decides whether the authority keeps a ring at all.
