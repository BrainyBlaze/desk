---
title: "Agents and terminals"
description: "Durable tmux sessions, the multiplexer, terminal rendering, attention signals, native agent chat, and fleet controls"
---

The agent multiplexer is Desk's core surface. It lets one operator supervise
many coding-agent sessions without losing process lifetime, terminal state, or
attention signals.

<Frame caption="A 2x2 group of durable tmux sessions with the sidebar tree and fleet telemetry">
  <img src="/images/agents-multiplexer.png" alt="A 2x2 group of durable tmux sessions with the sidebar tree and fleet telemetry" />
</Frame>

## Supported agents

Desk has built-in profiles for:

- Claude Code
- OpenAI Codex
- OpenCode
- bash (or any custom command)

Each profile prepares the agent-specific launch command, environment, resume
metadata, and attention-signal integration for that CLI. Sessions for agents
that support it can be launched with permission bypass enabled from a checkbox
in the session form. Resume behavior is agent-specific: Claude Code
conversation ids are harvested from the session and validated before reuse,
OpenCode sessions are recaptured from the CLI's own session list with a picker
on restart, and Codex sessions accept an explicit resume id.

Claude Code, Codex, and OpenCode sessions render as a native chat surface;
bash and custom-command sessions render as terminals. Each SDK-backed session
can instead run in terminal mode — the raw CLI TUI in a terminal cell — by
setting `uiMode: terminal` on the session, and the edit modal switches a
session between modes in place.

## The native chat surface

<Frame caption="Native agent sessions: markdown transcripts, tool rows, and a composer per cell">
  <img src="/images/native-agent-chat.png" alt="Three native agent sessions with markdown transcripts, tool call rows, and per-cell composers" />
</Frame>

In native mode Desk speaks to the agent through its SDK and renders the
conversation itself, instead of showing the CLI's terminal UI:

- **Transcript** — user and assistant turns render as markdown with
  role-accented rows and turn separators. Long feeds are virtualized, so
  thousand-row histories scroll smoothly; an unread marker shows what arrived
  since you last looked, and a jump pill returns you to the live tail after
  scrolling up.
- **Tool calls** — every tool invocation is a compact row with a status dot,
  elapsed time, and a disclosure that opens the exact input and output the
  agent saw. Sub-agent activity nests under the tool row that spawned it.
- **Composer** — a resizable input with file attachments (button, paste, or
  drag-and-drop), a slash-command palette fed by the commands the agent
  actually advertises, and a Send control that becomes Stop while a turn
  runs. A pulsing indicator marks the whole time the agent is working —
  from the moment you send until the reply, including tool execution.
- **Permissions** — approval requests dock above the composer with the
  proposed command or file diff, and resolve inline.
- **Continuity** — transcripts survive reloads and browser switches: the
  server keeps the session's event history and replays it to every surface,
  and the agent process itself lives in its tmux session, so nothing
  dies with the tab.

<Frame caption="The slash palette lists the commands the connected agent advertises">
  <img src="/images/native-composer-slash.png" alt="Native composer with the slash command palette open" />
</Frame>

Messages sent from [channels](/channels) reach native sessions through the
same injection path the composer uses, so agent-to-agent delivery works
identically in both modes.

## Durable tmux sessions

Every managed session runs inside a deterministic tmux session. This gives Desk
three important properties:

- closing the browser does not kill the agent
- restarting Desk reattaches to running work
- sessions can be captured, restarted, or booted without changing the UI model

The browser terminal is a view of a tmux-backed process, not the process
owner. Attaching never resurrects a dead session — booting is always an
explicit action — so an externally killed agent shows as missing instead of
being silently restarted.

Desk-launched sessions can drop tmux's own status line (reclaiming a terminal
row per cell) with the manifest setting `settings.tmux.statusLine: off`.

## The sidebar

The sidebar is a projects → groups → sessions tree:

- Session rows show a live status lamp: running, needs input (pulsing), or
  missing. Attention bubbles up to collapsed group and project rows.
- Group rows show running/total counts and a boot-missing action when some
  sessions are down.
- A filter row narrows the tree by session, group, or project substring, and
  a needs-input chip filters to sessions waiting on you, with a count.
- Projects, groups, and sessions reorder by drag and drop, and a session can
  be dragged into another group to move it. Order persists to the manifest.
- Row actions cover add, edit, info, restart (with confirmation — it kills the
  running agent), and delete.

## Groups and layouts

Groups organize agents by project, lane, or responsibility. Layout kinds are
`1x1`, `2x2`, `3x3`, `4x4`, `linear` (all cells in one row), and `custom`,
with 1–16 cells. The layout badge in the multiplexer header switches kinds
in place; +/− buttons add and remove cells.

Cells are resizable: drag the separators and the split proportions persist per
group in the manifest, restoring exactly after a reload. Sessions map to cells
by assignment — drag a session tab onto a cell, or tap an empty cell to assign
one from an inline picker.

Group switches are cheap by design: recently visited groups stay mounted with
live terminals (a warm budget of roughly 40 sessions on desktop), so flipping
between groups opens no new connections and loses no terminal state.

## Terminal rendering

Terminal cells — bash sessions, custom commands, and SDK agents running with
`uiMode: terminal` — use xterm.js in the browser and a server-side terminal
broker for transport. The broker keeps one WebSocket per browser for all terminals,
maintains one PTY per tmux session fanned out to every viewer (a desktop tab
and a phone share the same PTY — keystrokes from one appear on the other),
replays recent output on attach, and renders only visible cells.

Rendering uses hardware WebGL where available, under a shared budget of 8
contexts — cells beyond the budget (and machines with software-only GL) fall
back to the DOM renderer. Hidden cells release their context to visible ones,
and only the focused cell blinks its cursor.

Scrollback: append-style agent output opens a frozen scrollback viewer fed by
tmux capture (colors and layout preserved, native scrolling and selection);
full-screen TUI programs get application-owned scrolling with agent-aware key
encoding. A custom scroll rail on the cell edge tracks position.

Terminals self-heal: if the connection drops, cells show a reconnect overlay
and automatically re-arm on tab return, network recovery, or the first
successful poll after an outage — waking a laptop reconnects the whole wall
without a click.

## Attention signals

Desk watches each session for turn-complete, approval-requested, and
input-needed signals — parsed from OSC 9 terminal notifications when the agent
emits them, with bare terminal bells as the generic fallback (a bell poller
covers sessions no browser is watching). Signals surface as:

- a pulsing lamp on the session row and its collapsed ancestors,
- an entry in the events drawer with kind filters, unread tracking, and
  mark-all-read,
- an attention sound (respecting the mute toggle),
- and input to the channels delivery engine, which uses turn-complete signals
  to pace prompt delivery.

Typing into a session clears its attention state; acknowledged events stop
lighting up.

## Command palette and keyboard

`Ctrl+K` opens the session quick-switcher — attention-needing sessions first,
then recent, then tree order, fuzzy-matched across session, group, project,
and tmux names. `Ctrl+Shift+K` opens it even while a terminal has focus.
`Ctrl+Alt+1..9` focuses cell N; `Ctrl+Alt+←/→` cycles sessions tree-wide.
See [Keyboard shortcuts](/keyboard-shortcuts) for the full map, including
in-terminal copy, paste, and find.

## The header

The header carries fleet stats (project/group/agent counts, RUN and MISS
chips — MISS is clickable and boots the missing sessions), host telemetry
cells with sparklines (CPU, RAM, GPU, network, disk), a clock, and the
toolbar: Refresh, Up (start all missing), the emergency kill switch, sound
toggle, events drawer, and settings. The config-path button opens `desk.yml`
directly in the editor. On phones the toolbar collapses into a burger menu
and telemetry into a compact strip.

## Mobile

Below 860 px the active subsystem owns the screen: sidebars become slide-over
drawers with a tap-to-close scrim, and the multiplexer becomes a swipeable
one-cell-per-screen pager whose indicator diamonds are state-tinted — the
active cell expands into a named pill, and attention pulses so you can see
who is screaming from the pager alone.

## Operational controls

- **Refresh** re-reads fleet state; a 2-second pulse keeps liveness, attention,
  and telemetry current in between (paused while the tab is hidden), so an
  externally killed session flips to missing within a tick — no manual refresh.
- **Up** starts every missing session from the manifest without touching
  running ones; groups and individual cells have their own boot actions.
- **Restart** kills and relaunches one session (confirmed first).
- **KILL** is the emergency stop: it kills **all** Claude Code and Codex CLI
  processes and tmux sessions on the host — including ones Desk did not
  launch. It confirms with an alarm before acting. Use it as a last resort,
  not a routine control.

The status bar keeps the selected session's identity (agent, working
directory, copyable tmux target) and app-wide signals — agents needing input,
unread events and messages, mute, and sync state — visible at all times.
