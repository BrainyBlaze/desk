---
title: "Workspace model"
description: "Understand projects, groups, sessions, layouts, tmux names, resume ids, and startup behavior."
---

Desk's workspace model is intentionally small. A manifest contains projects;
projects contain groups; groups contain sessions.

## Projects

A project represents a working tree or root directory. It gives Desk a stable
scope for sessions, editor roots, Git discovery, and group organization.

Use one project per repository when your agents work in different repos. Use
one project with multiple groups when several agents work in the same repo.

## Groups

A group is a terminal workspace inside a project. Groups are useful for:

- separating roles such as frontend, backend, reviewer, and release
- keeping noisy commands away from agent sessions
- switching between related terminal grids
- preserving layout and selected sessions per workstream

Each group has a layout such as one cell, a grid, or custom split sizes. Desk
persists layout changes to the manifest.

## Sessions

A session describes one tmux-backed process. It can be:

- a managed Codex session
- a managed Claude session
- a managed OpenCode session
- a Bash shell
- a custom command

Managed agent sessions get Desk launch flags, permission handling, resume
capture, attention hooks, and optional LSP MCP wiring. Custom commands run as
the command you provide.

## tmux session names

Desk computes deterministic tmux names from:

- the namespace
- project id
- group id
- session name
- resume id prefix, or a hash when no resume id exists

You can set `tmuxSession` explicitly when you need a stable legacy name. Avoid
renaming tmux sessions outside Desk unless you also update the manifest.

## Resume ids

Resume ids belong to the agent CLI, not to tmux. Desk stores known resume ids in
the manifest and can also harvest them after a first turn for managed agents.

Use resume ids when you want a restarted agent CLI to reconnect to the same
conversation. Bash and custom command sessions do not use agent resume ids.

## Startup behavior

`desk up` reads the manifest, checks for matching tmux sessions, and starts only
the missing sessions. It does not replace running sessions.

Use `desk up --dry-run` before changing a large fleet.

## Browser state

The browser stores selected views, open editor tabs, panel sizes, and UI
preferences separately from tmux process lifetime. If you reload the browser,
Desk reconnects to the running sessions through the broker.

## Next steps

- Build a real manifest in [Create an agent fleet](/guide-create-agent-fleet).
- Read [Configuration](/configuration) for every manifest field.
- Read [Operations](/operations) for session controls and health checks.
