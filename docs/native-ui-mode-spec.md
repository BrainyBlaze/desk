# Native UI mode — implementation spec (draft 3, Phase 0)

Status: DRAFT — requires 3-way sign-off (@desk-multiplexor-claude author, @desk-multiplexor-codex + @desk-glm reviewers) before any schema/production edit.
Draft 2 folded codex review msg-20260705-151314: durable host token + unbounded post-hello reconnect (§5), host command correlation frames (§4), base-event typing + precise codex app-server methods (§4/§5).
Draft 3 folds glm review msg-20260705-151612/151628: attention-hint + history-boundary event kinds and 'answer' treatment (§4), host-owned replay buffer decision + hello-ack (§4/§6), switch idempotency (§7), frontend clarifications P2/P3/P4/V1/F1/F2/F4 incl. Composer SendResult contract (§9), manifest-parse validation G1 (§3), tests T1/T2/T3 (§11), dependency manifest (§10), Phase 0 commit scope (§12).
Worktree: `.worktrees/native-ui-mode`, branch `feat/native-ui-mode`, base `origin/main` @ `256cdd6`.

## 1. Requirements (from @human)

- Session-creation modal gains a **UI mode** option: `terminal` (today's TUI pane) or `native` (chat-style UI reusing desk's channels components).
- Edit modal can change UI mode; the change **automatically respawns** the session in the chosen mode.
- Sessions are the **same persistent sessions** in either mode (agent-native resume identity).
- In group layouts, native sessions behave exactly like terminal sessions (same cell contract).
- Production grade: no stubs, no silent error bypassing, typed errors, tests at every gate.

## 2. Locked decisions (3-way consensus 2026-07-05)

- **A1** — native-mode agent runs *inside the tmux session* via a desk-owned adapter host process. Preserves session==tmux invariant (liveness, kill/restart/killAll, attention polling, persistence across desk-server restarts).
- **B1** — uniform respawn-to-switch for all agents in v1. opencode live dual-view = v2.
- **C1** — one normalized desk event protocol; three server-side agent drivers produce it.
- **D1** — second multiplexed WS broker mirroring the terminal-broker idiom (seq + snapshot + replay ring + visibility).
- Codex constraint 1: mode switch is **one atomic server operation** (no edit-then-restart window).
- Codex constraint 2: Phase 0 lands this spec in the worktree before production code; TDD per phase (RED test named/posted before matching implementation).
- glm R2: hidden native cells must not churn (visibility-gated streaming). R5: tmux pane in native mode shows an explanatory banner + adapter log. R6: adapter failure → typed error + explicit "switch to terminal" affordance, never silent fallback.
- Defaults adopted per @human's "proceed" (flag to @human, revisit only if he objects): (1) opencode uses uniform respawn in v1; (2) no desk-side full transcript store in v1 — bounded replay ring + agent-native history refetch; (3) switching a session with no captured resume id is gated (see §7).

## 3. Data model (Phase 0)

`src/core/types.ts`:

```ts
export type DeskSessionUiMode = 'terminal' | 'native';

export interface DeskSession {
  // ... existing fields unchanged ...
  /** UI surface for this session's cell. Absent = 'terminal'. */
  uiMode?: DeskSessionUiMode;
}

export interface SessionSpec {
  // ... existing fields unchanged ...
  uiMode: DeskSessionUiMode; // resolved (defaulted) in buildSessionSpecs
}
```

Gating (`src/web/sessionAgentOptions.ts`):

```ts
export function supportsNativeUi(agent: string, hasCustomCommand: boolean): boolean {
  return !hasCustomCommand && (agent === 'codex' || agent === 'claude' || agent === 'opencode');
}
```

`bash` and custom-command sessions are terminal-only; the modal hides/disables the selector and the server rejects `uiMode: 'native'` for them with a typed error (validation in add/edit/switch routes — completeness rule: enumerate every field, negative test per field).

Defense in depth (G1): manifest **parse-time** validation also enforces the invariant — `validateSession` in `src/core/manifest.ts` rejects `uiMode: 'native'` when the agent is `bash`/undefined or `command` is set, so a hand-edited `desk.yml` cannot smuggle an unsupported native session past the API layer.

Manifest plumbing: `buildSessionSpecs` resolves `uiMode` (default `'terminal'`); YAML round-trips the field; `editSessionInManifest`/`replaceSession` preserve tmux-name pinning semantics unchanged.

## 4. Normalized protocol — `src/core/agentSurfaceProtocol.ts` (Phase 0, sign-off required)

Session FSM (drives every UI affordance; archpowers-proven shape):

```ts
export type AgentSurfaceState =
  | 'starting'            // adapter booting / driver connecting / resuming
  | 'idle'                // ready for input
  | 'processing'          // model turn in flight
  | 'tool-executing'      // tool/command running
  | 'awaiting-permission' // approval or AskUserQuestion pending
  | 'interrupted'
  | 'error'               // driver-level failure, recoverable by respawn
  | 'exited';             // adapter/agent process ended
```

Events — base interface + kind-specific extensions (`seq` assigned by the adapter host, monotonic per spawn; `ts` ISO):

```ts
export interface AgentSurfaceEventBase {
  seq: number;
  ts: string;
}

export type AgentSurfaceEvent = AgentSurfaceEventBase & (
  | { kind: 'session-info'; agentSessionId?: string; model?: string }
  | { kind: 'status'; state: AgentSurfaceState; detail?: string }
  | { kind: 'user-message'; id: string; text: string; source: 'ui' | 'channel' | 'external' }
  | { kind: 'assistant-delta'; turnId: string; text: string }            // transient; not in replay ring
  | { kind: 'assistant-message'; id: string; turnId: string; markdown: string } // committed
  | { kind: 'tool-start'; toolUseId: string; name: string; summary: string; detail?: string }
  | { kind: 'tool-output-delta'; toolUseId: string; text: string }       // transient; not in replay ring
  | { kind: 'tool-end'; toolUseId: string; status: 'ok' | 'error' | 'denied'; summary?: string; detail?: string }
  | { kind: 'permission-request'; requestId: string; variant: 'tool' | 'command' | 'file-edit' | 'question';
      title: string; detail?: string; diff?: { path: string; before?: string; after?: string };
      options: Array<{ id: string; label: string; treatment: 'allow' | 'allow-session' | 'deny' | 'answer' | 'custom' }> }
  | { kind: 'permission-resolved'; requestId: string; optionId: string; via: 'ui' | 'agent' | 'timeout' | 'respawn' }
  | { kind: 'turn-complete'; turnId: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }
  | { kind: 'attention-hint'; attention: 'idle-prompt' | 'elicitation' | 'session-status'; detail?: string }
  | { kind: 'history-boundary'; backfillComplete: true }
  | { kind: 'agent-error'; message: string; fatal: boolean }
);
```

- `treatment: 'answer'` carries AskUserQuestion-style responses (arbitrary answer options + custom text), keeping `variant: 'question'` inside the one permission-card flow without abusing allow/deny semantics.
- `attention-hint` carries per-agent attention nuances that are not FSM states (claude Notification matchers `idle_prompt`/`elicitation_dialog` and equivalents); the broker maps it to the existing `session-idle`/`input-requested`/`session-status` AgentEventV2 kinds so no nuance is dropped by broker-side synthesis.
- `history-boundary` is emitted exactly once per spawn, after committed-history backfill events and before any live event, so subscribers can distinguish "no history" from "still replaying history".

Committed-not-delta rule (archpowers pattern): the replay ring stores everything EXCEPT `assistant-delta` / `tool-output-delta`; late subscribers get committed history + current state, live subscribers additionally get deltas.

Browser ⇄ server frames (WS `/ws/agent-ui`), mirroring `terminalBrokerProtocol.ts` shapes and its strict parse-or-throw style:

```ts
export type AgentUiClientFrame =
  | { type: 'subscribe'; session: string; surfaceId: string; visible: boolean }
  | { type: 'visibility'; session: string; surfaceId: string; visible: boolean }
  | { type: 'unsubscribe'; session: string; surfaceId: string }
  | { type: 'send'; session: string; surfaceId: string; text: string }
  | { type: 'respond-permission'; session: string; surfaceId: string; requestId: string; optionId: string; note?: string }
  | { type: 'interrupt'; session: string; surfaceId: string };

export type AgentUiServerFrame =
  | { type: 'ready'; version: 1 }
  | { type: 'snapshot'; session: string; surfaceId: string; state: AgentSurfaceState; lastSeq: number; events: AgentSurfaceEvent[] }
  | { type: 'event'; session: string; event: AgentSurfaceEvent }
  | { type: 'error'; session?: string; code: AgentUiErrorCode; message: string }
  | { type: 'exit'; session: string; reason: 'killed' | 'crashed' | 'mode-switched' };

export type AgentUiErrorCode =
  | 'adapter-unavailable' | 'driver-start-failed' | 'not-native-session'
  | 'send-while-busy' | 'unknown-permission' | 'invalid-frame';
```

Adapter host ⇄ server frames (WS `/ws/agent-host`, server-internal), with command correlation so callers get positive completion or a typed failure:

```ts
export type AgentHostServerFrame =
  | { type: 'hello-ack'; lastSeq: number }
  | { type: 'inject'; requestId: string; text: string; source: 'ui' | 'channel' | 'external' }
  | { type: 'respond-permission'; requestId: string; permissionRequestId: string; optionId: string; note?: string }
  | { type: 'interrupt'; requestId: string }
  | { type: 'shutdown'; requestId: string };

export type AgentHostClientFrame =
  | { type: 'hello'; session: string; token: string; agent: DeskAgent; pid: number }
  | { type: 'event'; event: AgentSurfaceEvent }
  | { type: 'command-result'; requestId: string; ok: true }
  | { type: 'command-result'; requestId: string; ok: false; error: { code: AgentUiErrorCode; message: string; retryable: boolean } };
```

**Ring ownership (T3 decision, 3-way agreed): the BROKER owns the ring for connected clients; there is no second authoritative host ring.** The host stays a stateless emitter; committed history in the agent-native store is the durability boundary. The server answers every `hello` with `hello-ack {lastSeq}` — the highest seq it currently holds for that session (0 after a server restart). If `lastSeq > 0` (broker kept its ring across a transient host-socket drop) the host resumes live emission with seq continuity and skips backfill. If `lastSeq === 0` (server restarted) the host runs the full reconnect-backfill sequence (§5 step 3). Deltas emitted during a server outage are non-replayable by design (documented). Committed events emitted during a transient broker socket drop (broker alive, `lastSeq > 0`) are recovered from the host's bounded committed-event buffer (Phase 2 refinement N1: host keeps the last K committed events, mirroring the broker ring size; on reconnect with `lastSeq > 0`, drain buffered events with `seq > lastSeq`; if the drop exceeded the buffer, fall back to agent-native backfill) — or lost only when both bounds are exceeded. During a broker restart (`lastSeq === 0`) committed messages are recovered via agent-native backfill. If a provider/version cannot backfill committed history, the host emits a typed `agent-error` diagnostic instead of pretending the snapshot is complete. The broker resets a session's ring when a new host instance (different pid/spawn) says `hello`.

Host auth: the token must be **verifiable after a desk-server restart** — either an HMAC derived from a persistent desk host secret + `tmuxSession`/`agent`, or a random token persisted (manifest-adjacent state file) before launch. In-memory-only tokens are forbidden: a server restart must never orphan a running native session. Frames from unauthenticated or token-mismatched connections are rejected and audited (honesty-in-surfaces rule).

## 5. Adapter host (A1) — `src/server/agents/` + CLI entry

Native launch command (built in `buildAgentCommand`): `cd <cwd> && exec desk agent-host` with env `DESK_TMUX_SESSION`, `DESK_AGENT`, `DESK_AGENT_RESUME`, `DESK_AGENT_BYPASS`, `DESK_SERVER_URL`, `DESK_AGENT_HOST_TOKEN`. The host:

1. prints a static pane banner ("native mode — view this session in the desk UI; logs follow") then structured one-line logs;
2. connects to `DESK_SERVER_URL`/ws/agent-host. Reconnect policy (persistence invariant): **before the first successful `hello`**, retry with backoff and exit nonzero after bounded retries (pane shows the failure, cell shows typed error). **After the first successful `hello`**, reconnect retries are UNBOUNDED with capped backoff — the agent session outlives desk-server restarts and the host re-attaches when the server returns;
3. loads the driver for `DESK_AGENT` and bridges driver events → normalized protocol. **Backfill ordering rule (every successful `hello` where `hello-ack.lastSeq === 0` — first connect AND every reconnect after a server restart):** emit `session-info` → emit current `status` → emit agent-native committed history as committed events (SDK `getSessionMessages` / `thread/read` / `GET /session/:id/message`) → emit `history-boundary` → resume live emission. Hosts that skip this on reconnect are non-conformant; the broker integration test asserts it.

Drivers (Phase 1, one file each, strict ownership):
- `claudeDriver.ts` (owner: claude) — `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode; options: `resume`, `systemPrompt: {type:'preset', preset:'claude_code'}`, default `settingSources`, existing MCP/LSP wiring reused via `managedAgentLspWiring.prepare`; `canUseTool` → `permission-request`; `interrupt()`; AskUserQuestion → `permission-request` variant `question`.
- `codexDriver.ts` (owner: codex) — child `codex app-server` (stdio JSON-RPC), typed bindings via `codex app-server generate-ts` checked into the worktree with the codex version pinned. Protocol use, precisely: `initialize`/`initialized` handshake; `thread/start` (fresh) or `thread/resume` (explicit id); `thread/read` for committed-history backfill; `turn/start` when idle; `turn/steer` only with the current `expectedTurnId` when a turn is active; `turn/interrupt`; approval notifications `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput` → `permission-request`; `serverRequest/resolved` → `permission-resolved` cleanup; `item/*` deltas → delta events. Docs: https://developers.openai.com/codex/app-server.
- `opencodeDriver.ts` (owner: glm) — child `opencode serve --port 0` (one server per session, owner of that project store); SDK/generated client + SSE `/event`; fetch pending permissions on (re)connect; `prompt_async`, `abort`.

Channels-access parity (C1): **every driver exposes the desk-channels surface identically to terminal mode.** claudeDriver reuses the existing MCP/LSP wiring via `managedAgentLspWiring.prepare`; codexDriver passes the same `mcp_servers` config the terminal launch injects; opencodeDriver installs the same `OPENCODE_CONFIG_DIR` plugin/config set. A native-mode agent can post to channels, read feeds, and mention members exactly as its terminal-mode twin; a driver that cannot wire this is a `driver-start-failed`, not a degraded launch.

Permission mapping (`bypassPermissions` parity):

| agent | bypass=true (terminal today) | bypass=true (native) | bypass=false (native) |
|---|---|---|---|
| claude | `--dangerously-skip-permissions` | `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions` | default mode + `canUseTool` → UI cards |
| codex | `--dangerously-bypass-approvals-and-sandbox` | app-server sandbox/approval policy full-access | workspace-write + requestApproval → UI cards |
| opencode | inline allow-all permission config | same config on the serve instance | `ask` ruleset + permission events → UI cards |

## 6. Server broker — `src/server/agentSurfaceBroker.ts` (Phase 2)

Mirrors `terminalBroker.ts`: keyed by `tmuxSession`; fans events to N subscribed surfaces; bounded replay ring (default 2000 committed events, FIFO) for snapshots; visibility-gated delta forwarding (hidden surfaces receive committed events only — R2). Installed alongside the two existing WS bridges in `installDeskApi`.

**Attention synthesis lives in the broker, not the drivers** (amendment to R3, signed off by glm — the `attention-hint` event kind carries per-agent nuances): one mapping from normalized events → `AttentionTracker`/`agentEvents` (`status: awaiting-permission` → `approval-requested`; `turn-complete` → `stop`; `agent-error` → `input-requested`+detail; `session-info` → resume-id persist via the existing `persistSessionResume` path). Rationale: three drivers × one mapping beats three duplicated mappings; drivers stay pure protocol producers. Channels engine, lamps, sounds, pulse behave identically to terminal mode with zero driver-specific code.

## 7. Mode switch — atomic endpoint (Phase 2)

New `POST /api/set-session-ui-mode` `{ tmuxSession, uiMode, confirmDiscard?: boolean }`:

1. Validate: session exists; agent supports native; if switching a session with **no captured resume id** and `!confirmDiscard` → typed 409 `resume-not-captured` (UI offers "wait for capture" or destructive "start fresh"). Never silently switch.
2. Manifest edit (uiMode) with tmux-name pinning (existing `replaceSession` semantics).
3. `managedAgentLsp.cleanup` + `prepare` (as restart does today).
4. `killSession` → `startSession` with the rebuilt command; respond with fresh `DeskSnapshot`.
5. Client bumps `terminalRevisions[tmuxSession]` (remount works for both surface kinds).

Idempotency/serialization (T2): the endpoint holds a per-`tmuxSession` in-flight switch guard; a second request while one is running gets typed 409 `switch-in-progress` (never a second kill+start). Scope note: the guard is an in-process mutex, which is safe here because exactly one desk server process owns tmux lifecycle for a manifest; if that assumption ever changes, the guard must move to a shared medium.

Edit modal: changing UI mode routes through this endpoint (with confirm dialog reusing the restart-warning pattern); all other edits keep the existing manifest-only path. Pending permission requests die with the respawn by design; the new spawn re-surfaces pending state where the agent supports it (opencode pending fetch).

## 8. Channels-engine delivery to native sessions (Phase 3, owner: codex)

`channelsEngine` currently delivers via tmux send-keys. Fork per spec: sessions with `uiMode: 'native'` deliver via the broker's server-internal `injectUserMessage(tmuxSession, text, source: 'channel')` (host `inject` frame → driver send). `injectUserMessage` resolves **only after the host's `command-result ok:true`**; on `ok:false` with `retryable:true` the channels engine keeps/requeues the delivery; with `retryable:false` it reverts the delivering state and surfaces typed diagnostics (no silent drop). Thin HTTP wrapper `POST /api/agent-sessions/:tmuxSession/inject` for external callers, same validation and result semantics.

Membership & routing (C2): channel membership and dispatch routing key on the **tmux session name**, which §7 pins across mode switches — so a session keeps its channel identity, memberships, @mention handle, and routing rules through any number of terminal↔native switches with **no new registration step**. The only uiMode-sensitive hop is the final delivery (send-keys vs inject). codex validates this identity assumption against the channels-engine internals in Phase 3; if any engine path resolves members by something other than the session name, that path is fixed to the pinned name, not worked around.

Bidirectional parity invariant (C3): channel ↔ agent dispatch is bidirectional and uiMode-agnostic from the channels-engine's point of view — the engine routes to native and terminal sessions uniformly via the uiMode-forked delivery hop, and agents post to channels via the same desk-channels CLI/HTTP surface regardless of uiMode. This invariant is locked by a Phase 3 test (channel message → native session → agent reply posted back to the channel) so future changes cannot quietly break it. Busy semantics: if driver is mid-turn, queue (claude streaming input + codex turn/steer allow live append; opencode uses prompt_async) — driver-specific but hidden behind the one inject contract.

## 9. Frontend — `src/web/agentSurface/` (Phase 2, owner: glm)

- `agentSurfaceClient.ts`: mirror of `terminalBrokerClient.ts` (one WS per tab, resubscribeAll on reconnect, visibility frames).
- `NativeAgentSurface.tsx`: session-scoped container consuming snapshot+events; renders reused `MessageList` + `ChannelMarkdown` + `Composer`; new `ToolCallBlock`, `PermissionCard` (near composer, keyboard-first 1/Enter/2/Esc), `AskUserQuestionCard`, `AgentStatusBadge` — all modeled on `ref/archpowers-ui/components/chat/*`.
- **MessageList reuse path (F1 = option b):** `MessageList.tsx` stays UNCHANGED for channels; `NativeAgentSurface` owns a pure adapter function mapping `AgentSurfaceEvent[]` → ChannelMessage-shaped rows. No `Row<V>` generic refactor.
- **Streaming accumulation (P3):** `NativeAgentSurface` keeps one in-progress assistant row keyed by `turnId`, accumulating `assistant-delta.text`; the matching `assistant-message` (same `turnId`) commits and replaces it. This state machine is surface-local, not a broker concern.
- **Tool grouping (P2):** `tool-start`/`tool-output-delta`/`tool-end` render as a child `ToolCallBlock` of the current turn's assistant row when a turn is in progress (grouped by `turnId`), otherwise as standalone rows — matching `ref/archpowers-ui` tool-call-block composition.
- **Turn grouping (P4):** turns separate with a thin turn divider (turn id, optional cost from `turn-complete.usage`) instead of the channels day-separator.
- **Visibility, React layer (V1):** in addition to broker-side delta gating, `NativeAgentSurface` short-circuits row reconciliation when its cell is hidden (memo + visibility flag, the `TerminalSurface` `cellVisibleRef` pattern) — a hidden cell must not pay virtualization/DOM costs for committed events either.
- **Composer contract (F2):** `Composer` gains two injected props — `uploadFn` (channels passes `channelsUpload`; native passes its own or defers uploads in v1) and `onSend(text): Promise<SendResult>` where `SendResult = {ok: true} | {ok: false; error: {code; message; retryable}}`. Composer surfaces non-retryable failures INLINE (failed-message row + retry affordance, mirroring channels durability UX) and toasts retryable ones. Channels use-site adapts `channelsPost`; native use-site adapts `agentSurfaceClient.send` + `command-result` mapping. The Composer edit lands with channels-subsystem review.
- **Interrupt placement (F4):** stop/interrupt button in the `AgentStatusBadge` status bar, enabled during `processing`/`tool-executing` (ref: chat-panel.tsx).
- `App.tsx` fork at the `terminalCellBody` branch only; cell chrome/tabs/drag/layout untouched. Modal: `UI mode` DeskSelect after Agent (pattern: `supportsBypassPermissions` conditional).
- Transcript on mount: broker snapshot (which, per §5 backfill ordering, already contains committed history up to `history-boundary` after any fresh spawn or server restart).

## 10. Failure policy

Typed errors end-to-end: driver start failure → `agent-error {fatal:true}` + host exit code + pane log; broker forwards `error {code:'driver-start-failed'}`; cell renders the error with actions [Retry] [Switch to terminal mode]. No fallback happens without the user seeing it. Version-drift guards: codex bindings regenerated + pinned; opencode client generated from pinned version `/doc`; claude SDK version pinned in package.json (dependency additions require channel notice per hard rule).

### Dependency manifest (PF1 — planned package.json additions, reviewed here in one pass)

| package | kind | phase | owner |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (pinned exact) | runtime dep | 1 | claude |
| codex app-server typed bindings | NO dep — generated via `codex app-server generate-ts`, committed under `src/server/agents/codexBindings/` with the codex version recorded | 1 | codex |
| `@opencode-ai/sdk` (pinned exact) OR client generated from pinned `/doc` OpenAPI (glm's call, announce before adding) | runtime dep or generated code | 1 | glm |
| WS server/client for the two new endpoints | NO new dep — reuse the existing terminal-broker WS infrastructure | 2 | glm |

Anything beyond this table requires a fresh channel notice + owner sign-off before `npm install`.

## 11. Testing gates

- Phase 0: unit — protocol parse-or-throw (every frame kind, negative per field), manifest round-trip with uiMode, spec derivation defaulting, gating matrix (bash/custom/native), switch-endpoint validation incl. `resume-not-captured`. RED first.
- Phase 1: driver integration probes against real binaries under an **isolated HOME fixture** (existing agents-fixture protocol — never attach to the user's tmux); each driver proves: spawn→session-info with resume id, one full turn with deltas+commit, one tool event pair, one permission round-trip, interrupt, clean shutdown.
- Phase 2: broker unit (ring, visibility, seq, auth token incl. verify-after-server-restart, command correlation timeout/failure paths) + broker INTEGRATION test (T1: two subscriber surfaces + one host — visible surface gets deltas+committed, hidden surface committed only; ring snapshot on late subscribe; unauthenticated hello rejected) + reconnect-backfill test (T3: simulate server restart → host `hello` gets `lastSeq: 0` → asserts session-info → status → committed backfill → history-boundary ordering; transient socket drop with `lastSeq > 0` → no duplicate backfill) + switch idempotency test (T2: two rapid set-session-ui-mode calls → exactly one kill+start, second gets 409 switch-in-progress) + Playwright e2e on :5190 — create native claude session from modal, streaming chat visible, switch native→terminal→native, group layout mixing terminal+native cells.
- Phase 3: channels→native inject e2e; failure-path e2e (driver binary missing → error card → switch-to-terminal works).
- Every gate: `npm test` + `npm run check` green in the worktree; results posted to channel.

## 12. Ownership & sequence (agreed roles)

- Phase 0 (claude, sequential): this spec + `agentSurfaceProtocol.ts` + types/manifest/gating/modal-field plumbing + switch-endpoint validation with real validation logic (no broker yet). Commit scope (PF2, agreed): the OPENING commit carries the signed-off spec + pure type surface (`DeskSessionUiMode` on `DeskSession`/`SessionSpec`, `agentSurfaceProtocol.ts` type definitions, `supportsNativeUi` with its unit test) so Phase 1 driver work can start against frozen contracts; parse/validation logic, manifest plumbing, and modal UI land in subsequent commits, each preceded by its named RED tests. Gate: 3-way review.
- Phase 1 (parallel, disjoint files): claude=claudeDriver, codex=codexDriver+bindings, glm=opencodeDriver+agent-host runner. Gate: real-binary probes green.
- Phase 2 (glm): broker + frontend + switch flow e2e. claude reviews.
- Phase 3 (parallel): codex=channels inject; glm=failure UI+visibility+narrow viewport; claude=cross-validation vs spec.
- Phase 4: cross-review of non-owned phases, merge prep. No pushes to the public remote without @human's go.
