---
title: "Architecture"
description: "Understand Desk's runtime boundaries: manifest, tmux, server, browser, broker, agents, and local tools."
---

Desk is a local system, not a hosted control plane. The server runs on the same
machine as the code, tmux sessions, credentials, and agent CLIs. The browser is
an operator view over that local runtime.

## Runtime components

<Frame>
  <img
    src="/images/architecture-runtime.svg"
    alt="Desk runtime architecture. The browser operator view (terminals, channels, editor, git, projects, notes) connects over a WebSocket and the REST /api to a single local Desk server. The server coordinates the terminal broker, channels store, filesystem and editor APIs, git and gh operations, the LSP manager and MCP bridge, attention and agent events, telemetry, and UI assets. It drives the local runtime — the desk.yml manifest to the Desk runner to tmux sessions to agents (Codex, Claude, OpenCode, Bash, custom commands) — which report back through agent hooks that POST to /api/agent-event. Native-mode agent sessions run a desk agent-host process that drives the agent SDK and streams transcript events through the agent surface broker to the browser. State lives on local disk under ~/.config/desk."
  />
</Frame>


## Ownership boundaries

### Manifest

`~/.config/desk/desk.yml` describes desired state:

- projects and working directories
- groups and cell layouts
- sessions and agent kinds
- custom commands
- permission bypass settings
- resume identifiers
- UI settings

Desk writes the manifest atomically when you edit sessions or layout from the
UI.

### tmux

tmux owns process lifetime. Every configured session maps to a deterministic
tmux session name unless you set one explicitly. Desk can start missing
sessions, attach to existing sessions, capture scrollback, and resize tmux
windows, but the agent process is not owned by the browser.

### Server

The server exposes the UI assets and local API. Plain `desk serve` launches the
release-private compiled Bun runtime, which serves the embedded UI without Vite.
`desk serve --dev` explicitly starts Vite and mounts the same backend routes as
server middleware. The CLI does not fall back between these runtime boundaries.

The server also coordinates:

- terminal broker connections
- agent surface sessions: native-mode agents run a `desk agent-host` process
  in their tmux session that drives the agent SDK; the agent surface broker
  relays its transcript events to every subscribed browser and replays history
  on reconnect
- filesystem and editor operations
- Git and GitHub operations through `git` and `gh`
- channels storage and delivery
- LSP sessions and MCP access for managed agents
- attention and agent events
- system telemetry

### Browser

The browser renders the operator workspace. It owns layout, selected views,
native agent chats, terminal surfaces, channels panels, editor tabs, project boards, notes, and
theme state. Closing the browser does not stop tmux sessions.

### Terminal broker

The broker multiplexes terminal traffic through one browser WebSocket. It keeps
warm PTYs bounded, renders visible output, snapshots hidden sessions on reveal,
and exposes metrics through `/api/terminal-broker-metrics`.

### Agent event hooks

Codex, Claude, and OpenCode are launched with Desk-owned hooks or configuration
that POST typed events to `/api/agent-event`. Desk uses these events for
attention signals, resume capture, channel delivery evidence, and operator
notifications.

## Data locations

| Data | Default location |
| --- | --- |
| Manifest | `~/.config/desk/desk.yml` |
| Channels | `~/.config/desk/channels` |
| Notes | `~/.config/desk/notes` |
| Resume capture state | `~/.config/desk/resume-captures.json` |
| OpenCode Desk config | `~/.config/desk/opencode` |
| Agent event hooks | `~/.local/share/desk/hooks` |

## What is not centralized

Desk does not copy your repositories, replace GitHub, proxy agent model traffic,
or store agent credentials. Agent CLIs authenticate through their own
configuration. GitHub access is whatever the local `gh` command can do.

## Next steps

- Read [Workspace model](/concepts-workspace-model) for projects, groups,
  sessions, layouts, and tmux naming.
- Read [Agent integrations](/agent-integrations) for Codex, Claude, OpenCode,
  Bash, and custom command behavior.
- Read [Security and plugin model](/security-plugin-model) before adding local
  runtime extensions.
