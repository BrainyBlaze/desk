# Changelog

## Unreleased

- **Source-backed full CLI distribution.** The curl installer now provisions
  required macOS/Linux host capabilities, verifies release and toolchain
  checksums, builds an immutable source release with pinned Node 22.23.1/npm
  10.9.8 and Bun 1.3.14, and atomically installs the complete `desk` CLI. Plain
  `desk serve` runs the private Bun component; `desk serve --dev` opts into Vite,
  with no fallback. Releases publish source, install-manifest, and checksum
  assets. Upgrade, explicit downgrade, same-version repair, retention, rollback,
  PATH ownership, and uninstall are lock-protected and fail closed.
- **Terminal transport cleanup.** Removed the retired direct `/ws/terminal`
  bridge; the multiplexed `/ws/terminal-broker` is now the only terminal
  WebSocket. Global tmux mouse and OSC-passthrough policy is applied through one
  retryable helper instead of three independent setup paths.
- **Native agents — native UI is the default surface.** Codex, Claude, and
  OpenCode sessions start in the native chat surface, with streaming
  assistant output, inspectable tool rows, permission/question cards, file
  attachments, slash-command palettes, stop/send controls, and theme-aware
  transcripts. Terminal UI is selectable per session for raw TUI commands,
  login flows, custom commands, and terminal-only slash commands. Native channel
  delivery now injects queued messages through the agent surface instead of
  scraping the terminal path.
- **Channels — delivery reliability fix.** The engine read an agent's tmux pane
  on the spawned child's `exit` event, before the stdout pipe had drained. Under
  the burst of concurrent captures the restore/pump path generates, larger panes
  truncated to an empty string, which the readiness gate misread as "not ready"
  — so idle, ready agents had their queues held indefinitely (messages piled up,
  undelivered). Pane captures now read on `close` (fires only once stdout is
  fully drained). Every engine tmux spawn also gained a hard timeout that always
  settles, and a watchdog reclaims any drain lock held longer than a bounded
  spawn sequence — so no spawn anomaly can strand a queue again.
- **Channels — engine ops console.** A diagnostics-and-recovery drawer in the
  channels header. A live pane probe classifies each session (`ready` / `busy` /
  `booting` / `empty-capture` / `offline` / `unobservable`) so you can see why a
  queue is held; expand a session to inspect and drop individual queued messages.
  Recovery actions: per-session force-deliver (bypasses the gates), mark-idle,
  drop-queue; global drain-ready and an in-process **rebuild engine** that
  recovers a wedged engine without restarting the server. New endpoints
  `GET /api/channels/engine` and `POST /api/channels/engine/action`. See
  [docs/channels-protocol.md](docs/channels-protocol.md).
- **Channels — notification delivery made operator-forced and idempotent.**
  Regular notification delivery now uses the same force-delivery mechanics as
  the operator recovery path: queue items are injected without depending on
  agent-status gates, retries are bounded by acknowledgement state instead of
  stale busy flags, and stale `.delivering` / stuck artifacts are reconciled so a
  bad status classification cannot leave messages permanently undelivered. The
  prompt body remains notification-only, pointing agents back to `desk channels
  read` instead of duplicating conversation text.
- **Channels — agent-event and hook plumbing.** Added a Desk-owned agent event
  path and hook installation surface for Claude, Codex, and OpenCode, with typed
  session lifecycle, prompt-submitted, stop, approval/input-requested, delivery
  ack, and status events. The channels engine now treats hook trust and liveness
  as explicit evidence instead of silently assuming a written hook is active.
- **Channels — CLI read/post ergonomics.** `desk channels read` gained
  single-message reads (`--message <msg-id>`), and generated delivery prompts now
  include both the one-message read command and the full-conversation fallback.
  The CLI routing and prompt copy continue to require explicit `--as`
  attribution for agent posts.
- **Channels — viewport and read-state stability.** Channel opens now anchor to
  the latest message, while channel/subsystem switches preserve already-rendered
  message windows and scroll anchors instead of reloading and re-windowing the
  feed. Visible-read acknowledgement clears NEW/unread markers when messages have
  actually been viewed.
- **Channels — action-panel navigation.** Search, Featured messages, Delivery
  timeline, Saved views, Operator inbox, Live delivery feed, and related action
  panels now navigate to the requested message consistently, including
  cross-channel targets. Cached target channels suppress saved-scroll restoration
  for a specific message jump so the message cursor wins over old scroll
  position.
- **Channels — modal and picker UX fixes.** Action modals no longer trap clicks
  behind stale overlays, share/edit/delete flows close and refresh predictably,
  and the "Add agent to channel" modal now has search plus project, agent-type,
  and running/missing filters. The add-agent filter toolbar wraps inside the
  modal, uses an icon-only clear control, and prevents horizontal overflow in the
  candidate list.
- **Channels — diagnostics and documentation.** Added runtime delivery
  diagnosis, shared channel-system model, stale-stuck cleanup tooling, protocol
  updates, and regression samples/tests covering the delivery wedge, hook/event
  plumbing, CLI prompts, viewport memoization, cross-channel navigation, and
  agent-picker filters.
- **LSP — full Desk editor and managed-agent integration.** Added the shared LSP
  runtime, HTTP/WebSocket/MCP surfaces, Monaco adapter/provider wiring,
  server/session pool, diagnostics/completion/hover/rename/file-operation
  services, safe workspace-edit application, capability tokens, managed-agent LSP
  wiring, and architecture documentation.
- **LSP — automatic TypeScript server detection.** Desk can now detect and
  surface TypeScript LSP support automatically when the local project has the
  server dependency available, with settings normalization and language-detection
  tests updated to cover the default path.

## 0.1.0 — 2026-06-12

First public release.

- **Terminals** — manifest-driven tmux sessions (`~/.config/desk/desk.yml`,
  atomic writes) rendered through xterm.js; tmux owns process lifetime, so
  Desk restarts, browser reloads, and reboots reattach to running agents.
  Conversation ids are auto-harvested on an agent's first turn so restarts
  resume the same conversation. Per-group multiplexer grid (1–16 cells),
  drag-to-cell, color-faithful scrollback, capture and search.
- **Editor** — file explorer over any root + Monaco tabs (IntelliSense for
  TS/JS/JSON/CSS/HTML), live file watching, conflict-safe saves, ripgrep
  filename/content search.
- **Git** — CLI-driven (`git`/`gh`) source control: stage/unstage/discard,
  commit/amend, pull/push/publish, lane-colored history graph, branches &
  worktrees explorer, branch compare without checkout, Monaco diff tabs,
  GitHub repo/PR card.
- **Projects** — GitHub Projects v2 kanban board and table over the gh CLI:
  drag between columns, inline edits, item drawer with comments, drafts,
  status updates, GitHub-style filter bar.
- **Notes** — markdown notes in `~/.config/desk/notes` with autosave, Monaco +
  rendered preview, and create-note-from-terminal-selection.
- **Channels** — Slack-like messaging between agents over a markdown file
  protocol (`~/.config/desk/channels`): @mention dispatch into per-agent
  prompt queues gated on turn-complete signals, digest delivery for backlogs,
  threads, uploads, onboarding briefings, `desk channels` CLI. See
  [docs/channels-protocol.md](docs/channels-protocol.md).
- **Notifications** — turn-complete/approval signals raise session dots,
  sounds, and an Events drawer with click-to-navigate cards.
- **UI** — sci-fi/HUD design system, 12 contrast-audited themes that retint the
  terminals, sound effects, mobile overlay drawers, emergency kill switch.
- **Security** — binds `127.0.0.1` only; single-user local-trust model
  (documented in the README); path-fenced fs API; uploads served with
  `Content-Security-Policy: sandbox`.
