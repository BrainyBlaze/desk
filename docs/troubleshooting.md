---
title: "Troubleshooting and FAQ"
sidebarTitle: "Troubleshooting"
description: "Diagnose common Desk setup, terminal, agent, channel, GitHub, LSP, and deployment issues."
---

Use this page when the UI does not show the state you expect. Start with the
symptom, then run the checks in order.

## Server and UI

### `desk` unexpectedly starts the server or reports port 5173 in use

Versions of `install.sh` introduced around v0.2.0 may have placed the standalone
server at `~/.local/bin/desk` or `/usr/local/bin/desk`, shadowing the full CLI.
The current installer names that server `desk-server`; `desk` belongs to the
source checkout's multi-command CLI.

Find every command candidate before changing anything:

```bash
type -a desk
command -v desk
```

Inspect the resolved file or symlink. Do not blindly move or remove it: an npm
link or checkout-provided `desk` is the full CLI and should stay named `desk`.
After confirming that an old regular file is the standalone server, preserve it
under the new name and refresh the shell lookup cache, for example:

```bash
mv -i ~/.local/bin/desk ~/.local/bin/desk-server
hash -r
```

Use the corresponding `/usr/local/bin` paths (and appropriate permissions) if
that is where the old installer wrote the binary. If `desk-server` already
exists, keep it and move the old file to a backup name instead of overwriting
the current install.

### `desk serve` cannot find Vite

Cause: dependencies are missing in the Desk checkout.

Fix:

```bash
npm install
npm run build
desk serve
```

### Browser still shows old docs or UI

Cause: the browser or docs host is serving cached assets.

Fix:

- hard-refresh the browser
- confirm the expected Git commit is deployed
- for docs, check the GitHub Pages or deployment workflow result

## Sessions and terminals

### A configured session is missing

Check:

```bash
desk status
desk up --dry-run
desk up
```

Common causes:

- invalid `cwd`
- missing agent CLI
- custom command exits immediately
- tmux is not installed

### A terminal cell is blank

Check:

```bash
desk capture <session-name> --lines 100
tmux ls
```

If capture has output but the browser is blank, inspect terminal broker health
in [Operations](/operations). If capture is empty, inspect the tmux session
directly:

```bash
desk attach <session-name>
```

### Scrolling behaves differently for OpenCode

OpenCode is a full-screen TUI. Its conversation scroll lives inside the app,
not in tmux scrollback like append-style Codex or Claude output. Desk routes
scroll based on terminal state so full-screen TUIs receive page-scroll keys
instead of the tmux-backed scrollback overlay.

## Agents

### Agent CLI not found

Make sure the CLI is on the server user's `PATH`:

```bash
command -v codex
command -v claude
command -v opencode
```

OpenCode also supports `DESK_OPENCODE_BIN` when the executable is installed in
a non-standard path.

### Permission prompts are not what you expected

Check the session's `bypassPermissions` value in `desk.yml`.

- Codex uses its bypass approvals and sandbox flag.
- Claude uses its skip-permissions flag.
- OpenCode receives per-session permission configuration through
  `OPENCODE_CONFIG_CONTENT`.

Restart an already-running pane after changing permission behavior.

### Attention events do not appear

Run:

```bash
desk hooks install
```

Then restart managed agent sessions so their launch environment and hook
configuration are active. Custom commands may require manual event integration.

## Channels

### Agent did not receive a channel mention

Open the channel delivery diagnostics console. Check whether the item is queued,
delivering, acknowledged, failed, or held by diagnostic state.

Useful CLI checks:

```bash
desk channels read <channel>
desk channels read <channel> --message <msg-id>
```

If needed, use the operator recovery actions in the diagnostics console:

- force-deliver
- mark idle
- drop queue
- drain ready sessions
- rebuild engine

### Agent reply has the wrong author

Agents must post with explicit attribution:

```bash
desk channels post <channel> --as <member> "message"
```

Thread replies also need `--thread <parent-msg-id>`.

## Git and GitHub

### GitHub Projects do not load

Check `gh` authentication and scopes:

```bash
gh auth status
gh auth refresh -s project
```

The Projects backend uses the local `gh` CLI and GitHub GraphQL APIs. It can
only show what that authenticated account can access.

### Git panel shows the wrong repo

Desk discovers owning repositories from the selected root. Switch the editor
root or selected project to the directory you expect, then refresh the Git
panel.

## LSP and editor

### No language intelligence appears

Check that LSP is enabled in settings and that the project has a supported
language server path. Desk includes TypeScript, Python, and Rust integration
logic, but language servers still depend on the host environment and project
layout.

### Agent MCP LSP tools fail

Managed agents receive scoped MCP access through Desk launch wiring. Restart
the managed session after enabling LSP settings or changing project roots.

## Deployment and security

### Browser over an SSH tunnel cannot connect

Check the bind host:

```bash
desk serve --host 127.0.0.1 --port 5173
```

For a remote development box, use SSH forwarding:

```bash
ssh -L 5173:127.0.0.1:5173 user@dev-box
```

Keep Desk bound to `127.0.0.1` on the remote host. Do not expose the Desk port
on a shared or public interface.

## FAQ

### Does Desk host my agents?

No. Desk launches local tmux sessions on the host where the server runs.

### Does Desk store my model credentials?

No. Agent CLIs authenticate through their own configuration.

### Can I run multiple browsers?

Yes, but remember each browser is a view onto the same local tmux and manifest
state. Coordinate operator actions when multiple people access the same server.

### Can I edit the manifest by hand?

Yes. Desk uses `~/.config/desk/desk.yml`. Keep YAML valid and run `desk status`
or reload the UI afterward.

### What should I back up?

Back up `~/.config/desk/desk.yml`, `~/.config/desk/channels`, and
`~/.config/desk/notes` if you care about local configuration, conversations,
and notes.
