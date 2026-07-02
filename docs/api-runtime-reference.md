---
title: "API and runtime reference"
description: "Reference the main local API routes, WebSocket endpoints, and runtime contracts used by Desk's browser and CLI."
---

Desk's browser UI and CLI talk to a local HTTP server. The stock server has no built-in authentication, so the API is a local-trust surface.

Default base URL:

```text
http://127.0.0.1:5173
```

## Response shape

JSON routes return JSON with an appropriate status code.

Errors are usually:

```json
{ "error": "message" }
```

Unexpected failures are collapsed to a terse `request failed` response. Stack fields are redacted from JSON payloads.

## Core routes

```text
GET  /api/desk
GET  /api/system
GET  /api/settings
POST /api/settings
GET  /api/pulse
POST /api/kill-all
POST /api/up
POST /api/add
```

`/api/desk` returns the manifest-backed workspace snapshot.

`/api/system` returns the cached system metrics snapshot.

`/api/pulse` is the UI's regular heartbeat. It includes system metrics, running tmux sessions, attention state, unread event count, LSP status, and channel runtime state.

## Session and layout mutation routes

Desk uses API routes for UI mutations such as:

- add, edit, delete, move, reorder, and restart sessions
- add, edit, delete, move, and reorder groups
- add, edit, delete, move, and reorder projects
- update group layout and persisted split sizes

The server validates cwd values, layout kinds, custom cell counts, and split-size percentages before writing the manifest.

## Attention and agent events

```text
GET  /api/attention
POST /api/attention-clear
POST /api/attention-read
POST /api/agent-event
```

Use `/api/attention-read` to mark events as read. Send `{ "clear": true }` to the same route to clear the attention-event list.

Agent hooks and plugins post typed events to `/api/agent-event`. Desk uses those events for attention, resume capture, and channel-engine release signals.

## Terminal routes

```text
GET  /api/terminal-broker-metrics
POST /api/terminal-resize
POST /api/terminal-repaint
POST /api/terminal-scroll
POST /api/terminal-capture
```

`/api/terminal-broker-metrics` exposes broker counters:

- active browser clients
- active PTYs
- warm idle PTYs
- visible subscriptions
- hidden subscriptions
- dropped output frames

Terminal capture uses tmux `capture-pane` with bounded history and returns color-preserving lines for the frozen scrollback viewer.

## Terminal WebSockets

```text
WS /ws/terminal-broker
WS /ws/terminal
```

`/ws/terminal-broker` is the current browser path. One browser connection can subscribe to multiple terminal surfaces. Hidden surfaces stay subscribed but do not receive live output to parse.

`/ws/terminal` is the legacy direct terminal bridge.

Both bridges attach to tmux with `ignore-size` behavior and use resize guards to avoid corrupting tmux windows with tiny dimensions.

## Filesystem routes

Filesystem routes live under `/api/fs`.

They include:

- home/root discovery
- notes root and notes state
- path validation
- directory listing
- file read and raw media read
- filename and content search
- write, create, rename, copy, and delete operations
- LSP-aware preview/apply flows for create, rename, and delete

The server constrains paths to the active root, with a special allowance for the manifest file.

Writes are atomic and mtime-guarded so external edits can produce a conflict instead of being silently overwritten.

## Git routes

Git routes live under `/api/git`.

They cover:

- repository discovery
- status and status maps
- log/history
- line diffs
- worktree, index, commit, range, and branch diffs
- stage and unstage
- discard
- commit and amend
- fetch, pull, push, and publish
- branch checkout, create, and delete
- worktree removal
- commit revert
- GitHub repository and PR context
- open-on-GitHub URL resolution

Desk runs the host `git` and `gh` commands and reports failures through JSON errors.

## GitHub Projects routes

GitHub Projects routes live under `/api/projects`.

They cover:

- auth/scope checks
- project listing
- board data loading
- item detail loading
- owner listing
- field value updates
- item position changes
- adding items by URL
- draft item creation, edit, and conversion
- archive, unarchive, and delete
- status update create/delete
- issue and pull request edits/comments/state changes
- project create/edit/link-repo operations

The backend uses `gh api graphql`, `gh issue`, and `gh pr`.

## Channels routes

Channels routes live under `/api/channels`.

They cover:

- channel state
- engine diagnostics and actions
- channel listing and message windows
- threads
- reactions
- saved views
- paused sessions
- search
- featured messages
- uploads and file serving
- activity events
- export
- message create, edit, and delete
- member add and remove
- share-to-channel
- queue control

The CLI prefers these server routes when `DESK_API` is reachable, and falls back to direct markdown append for some post flows when the server is unavailable.

## LSP routes and sockets

```text
POST /api/lsp
WS   /ws/lsp
```

The HTTP endpoint requires a bearer token for session-scoped agent access. It validates file URIs against the configured workspace root and redacts sensitive command, environment, token, and path data from responses.

The browser uses LSP wiring for editor features and diagnostics. Managed agents use the MCP wrapper described in [Agent integrations](/agent-integrations).

## Plugins

Plugins can add middleware, routes, and WebSocket upgrade guards. See [Security and plugin model](/security-plugin-model) before relying on the API from another process or network boundary.
