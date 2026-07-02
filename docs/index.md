---
title: "Desk"
description: "Local mission control for a fleet of coding agents"
---

Desk is a local mission-control app for running a fleet of coding agents from
one browser workspace. It keeps agent processes alive in tmux, gives the
operator a fast terminal multiplexer, and adds the surrounding tools needed to
coordinate real work: channels, an IDE, git, GitHub, project boards, notes, and
system telemetry.

Desk is built around a simple ownership model:

- **tmux owns process lifetime.** Agent sessions keep running when the browser
  closes, the network drops, or Desk restarts.
- **The browser owns the view.** The UI renders terminals, files, diffs,
  channels, boards, notes, and operational status without owning the agent
  process.
- **The manifest owns intent.** A YAML manifest defines groups, projects,
  sessions, layout, and UI settings.

## Shipped subsystems

### Agent multiplexer

Run Claude Code, OpenAI Codex, OpenCode, shell sessions, or custom commands in
durable tmux sessions. Group agents by project or role, lay them out in
configurable terminal grids, resume known conversations, and route attention
signals back to the UI when an agent finishes a turn or needs input.

### Channels

Channels are Slack-like rooms for agents and the operator. Messages are stored
as markdown files, dispatched to target agents by mention, and delivered through
each agent's terminal only when the agent is ready for the next prompt.

### IDE and LSP

The editor subsystem combines a file explorer, Monaco editor tabs, search, live
file watching, and Language Server Protocol support. The same language
intelligence can be exposed to managed agents through Desk's MCP server.

### Git and GitHub operations

Desk includes repository discovery, status, staging, commits, pull/push/fetch,
branch and worktree operations, history, diff views, and GitHub repository and
pull-request surfaces through your local `git` and `gh` tools.

### GitHub Projects

GitHub Projects v2 boards and tables can be managed from Desk: select projects,
move cards, edit fields, inspect items, work with drafts, and filter project
work without leaving the operator workspace.

### Notes

Notes are markdown files stored locally. Create quick scratch notes manually or
from selected terminal text, edit them in Monaco, and keep terminal context close
to the work it produced.

### System monitor and operational controls

Desk surfaces CPU, memory, disk, network, and GPU telemetry, agent attention
events, queue diagnostics, and operator controls for starting missing sessions,
repairing sessions, and stopping agent processes when necessary.

## Local-first by design

Desk is designed for developer machines and remote boxes where the code,
credentials, and agents already live. It runs locally, binds to localhost by
default, and uses the tools already installed on the host: `tmux`, `git`, `gh`,
agent CLIs, language servers, and filesystem state.

Use the rest of this documentation as the product reference for configuring,
operating, and extending Desk.
