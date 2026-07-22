---
title: "Architecture"
description: "Understand Desk's runtime boundaries: manifest, atch, terminal daemon, server, browser, agents, and local tools."
---

Desk is a local system, not a hosted control plane. The server runs on the same
machine as the code, atch sessions, credentials, and agent CLIs. The browser is
an operator view over that local runtime.

## Runtime components

<Frame>
  <img
    src="/images/architecture-runtime.svg"
    alt="Desk runtime architecture. The browser operator view connects over a binary terminal WebSocket and REST /api to one local Desk server. The server supervises the terminal daemon, which manages atch sessions keyed by durable sessionId values, and coordinates channels, filesystem and editor APIs, git and gh operations, LSP and MCP, attention, telemetry, and UI assets. Agent hooks report typed events to /api/agent-event, and native-mode sessions stream through the agent surface broker. State lives on local disk under ~/.config/desk."
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

### atch and the terminal daemon

atch owns process lifetime. Every configured session has a durable `sessionId`
and a private master socket. The server supervises one terminal daemon, which
restores live masters after a restart, provisions missing sessions, generation-
fences terminal traffic, keeps emulator snapshots, and handles input, capture,
resize, restart, and retire. The browser never owns the agent process.

### Server

The server exposes the UI assets and local API. Plain `desk serve` launches the
release-private compiled Bun runtime, which serves the embedded UI without Vite.
`desk serve --dev` explicitly starts Vite and mounts the same backend routes as
server middleware. The CLI does not fall back between these runtime boundaries.

The server also coordinates:

- the supervised terminal daemon and binary terminal WebSocket
- agent surface sessions: native-mode agents run a `desk agent-host` process
  in their atch session that drives the agent SDK; the agent surface broker
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
theme state. Closing the browser does not stop atch sessions.

### Terminal transport

The browser uses one binary WebSocket at `/ws/terminal` for every visible
terminal surface in the tab. Hidden surfaces unsubscribe, and reveal requests a
fresh emulator snapshot before live output resumes. The WebSocket bridge routes
frames to the terminal daemon; the daemon owns the atch master connections and
per-session generation state.

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
  sessions, layouts, and durable session identities.
- Read [Agent integrations](/agent-integrations) for Codex, Claude, OpenCode,
  Bash, and custom command behavior.
- Read [Security and plugin model](/security-plugin-model) before adding local
  runtime extensions.
