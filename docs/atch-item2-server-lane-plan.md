# Item 2 — server/channels/runtime lane conversion plan (claude)

The no-tmux gate for this lane: zero references to `tmuxSession`,
`DESK_TMUX_SESSION`, or tmux invocations across `src/server/**`,
`src/core/resumeCaptureState.ts`, `src/core/agentHooks.ts`,
`src/core/opencode/desk-attention.js`, `src/cli/channelsCli.ts` — except
documented historical comments. Inventory at plan time: ~700 references in
45 files.

Everything key-bearing is FLIP-COUPLED: renaming a persisted field or
flipping a key value before the production migration re-keys the stores
mis-keys live data, and schema-touching renames break against core types
until the codex lane flips them. Work lands in the coordinated flip window,
in the dependency order below. Only additive daemon-consumer work (e.g.
adopting shared daemonControlClient) lands before the window.

## D — delete outright (legacy tmux transport)

| File | Notes |
|---|---|
| terminalBroker.ts | tmux pipe-pane WS broker; superseded by the daemon proxy (`/ws/terminal`) |
| terminalBridge.ts | legacy tmux attach bridge |
| tmuxOptions.ts | tmux set-option plumbing |
| channelsProbe.ts | capture-pane probe engine; probe snapshots come from `/control/tail` |
| ptyBackend.ts / ptyBackend.standalone.ts | audit: delete if only the tmux attach path consumes them |
| killSwitch.ts | rebuild as daemon retire-all via control plane (same route contract) |
| channelsEngine.ts tmux defaults | `sendTextToTmux`, `defaultSessionRunning`, `defaultCapturePane`, `sendEnterToTmux`, `defaultSessionCreatedAt`; the native transport becomes the unconditional engine binding |
| deskRuntime/deskServices legacy wiring | `installTerminalBroker`, tmux-gated branches, the `DESK_ATCH_NATIVE` flag itself at default-flip |

Route/UI consumers of deleted endpoints (`/ws/terminal-broker`) coordinate
with the codex web lane in the same window.

## R — re-key / rename (coordinated semantics)

| File(s) | Action |
|---|---|
| attention.ts | keys become sessionId; DELETE the tmux bell poller + `detectBellEdges`/`parseBellFlagsOutput`; the daemon attention drain becomes the only terminal-stream feeder; `tmuxSessionForNativeId` mapping becomes identity |
| channelsApi.ts, channelsEngine.ts, channelsDeliveryStrategy.ts, channelsDurability.ts, channelsPaused.ts, channelsStore.ts, channelsProtocol.ts, channelsEvents.ts | every `tmuxSession` param/field → `sessionId`; member manifests + events.jsonl records write the new field (migration transforms old data); `nativeIdForTmuxSession` boundary mapping becomes identity |
| resumeCapture.ts + resumeCaptureState.ts | `PendingResumeCapture.tmuxSession` → `sessionId` (field rename lands with the migration re-key; constructor in core runner is codex-lane — one window) |
| agents/host/toolJournal.ts | filename key → sessionId; old journals EXPIRE at migration (spec §201), no transform |
| agentHostLaunch.ts, agents/host/{cli,runner,logger,types,driver}.ts, agentHooks.ts, opencode/desk-attention.js | `DESK_TMUX_SESSION` → `DESK_SESSION_ID`, ATOMIC with the codex-lane producer (`agentEnvPrefix` in manifest.ts + native launch env): one commit or adjacent pair, no compatibility fallback; also the supervisor scrub list entry |
| routes/sessionsRoutes.ts, routes/systemRoutes.ts, uiModeSwitch.ts, editRespawn.ts | API request/response fields `tmuxSession` → `sessionId` (coordinated with codex web lane); spec lookups key on sessionId; `shouldRespawnAfterEdit` identity field flips; `staleNativeIdentityAfterEdit` + `killSessionTargets` fallbacks become identity |
| snapshot.ts, runner-facing helpers | `atchRunningTmuxSessions` mapping dies — the view model keys by sessionId (codex ui/web lane renders it) |
| lsp/managedAgentLspWiring.ts, agentSurfaceBroker.ts, agentPresence.ts, agentEvents.ts, agentHostToken.ts | opaque session-string keys: callers start passing sessionId; token derivation input changes are a breaking token rotation (sessions respawn at cutover anyway) |
| nativeSessionControl.ts | `sessionId ?? tmuxSession` fallbacks → `sessionId`; legacy `startSession`/`restartSession` branches deleted with the flag; adopt shared daemonControlClient (additive, pre-window) |
| cli/channelsCli.ts | member identity field rename |

## K — keep (already native / historical)

daemonSupervisor.ts, terminalDaemon.ts, terminalDaemonMain.ts (comments +
`atch kill` killSpecs), cutoverStoreMigration.ts (codex lane).

## Order inside the flip window (each step green before the next)

1. codex: schema flip (sessionId required on DeskSession/SessionSpec;
   tmuxSession still present, deprecated) + daemonControlClient landed.
2. me: opaque-key subsystems flip to sessionId feeds (attention, presence,
   surface broker, LSP wiring, tool journal) + env rename pair with codex.
3. me: channels engine/api/store field renames + native-transport-only
   binding; codex: migration executes member/events/resume/paused/
   durability transforms + tool-journal expiry behind the startup gate.
4. me: route/API field renames; codex: web/UI consumers same window.
5. me: D-category deletions; codex: core tmux.ts deletion + default-flip.
6. Both: per-lane no-tmux grep gates, then the repo-wide no-tmux
   architecture gate + full suite + supervised canary + real-join.

## Coordination invariants

- A persisted key/field changes only in the same window as the migration
  transform that re-keys existing data.
- The env identity rename is producer+consumer atomic; no dual-reading.
- The 5173 live desk is untouched; validation happens on the supervised
  canary and isolated ports only.
