---
title: "Troubleshooting and FAQ"
sidebarTitle: "Troubleshooting"
description: "Diagnose common Desk setup, terminal, agent, channel, GitHub, LSP, and deployment issues."
---

Use this page when the UI does not show the state you expect. Start with the
symptom, then run the checks in order.

## Server and UI

### The installer reports a shadowing `desk` command

Desk scans `PATH` in command-resolution order and refuses to install behind an
unidentified executable. Inspect every candidate:

```bash
type -a desk
command -v desk
```

An npm link or checkout-provided command may already be the full CLI. Remove or
move only files whose ownership you have verified, then refresh shell lookup:

```bash
hash -r
```

If you set `DESK_BIN_DIR`, it must be an absolute canonical directory already on
`PATH`, with no earlier conflicting command.

### `desk serve` reports that the private runtime is missing

Plain `desk serve` requires `libexec/desk-standalone` in the active immutable
release. Rerun the installer to create and activate a fresh instance:

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
```

Desk does not switch to Vite when this artifact is absent.

### Desk refuses a store written by Desk v0.3.1 or older

The manifest, the Channels paused store, the delivery-events ring and member
manifests changed shape at v0.3.2, and v0.3.2 is the last release that migrates
the older shape in place. The current release does not migrate: a reader that
meets the older shape refuses it and names the remedy, for example
`session codex carries the retired tmuxSession key: this manifest was written by
Desk v0.3.1 or older; this version does not migrate stores written by Desk
v0.3.1 or older; boot Desk v0.3.2 once against this store (the last release
that migrates it in place), then upgrade`. Install v0.3.2 with the pinned
installer (`DESK_VERSION=v0.3.2`), start it once, then rerun the installer for
the latest release. A session you wrote into `desk.yml` by hand needs a
`sessionId` matching `^[a-z][a-z0-9-]{2,63}$`, unique across the manifest;
sessions added through Desk receive one.

### `desk serve --dev` cannot find Vite

Cause: dependencies are missing in the Desk checkout.

Fix:

```bash
npm ci
npm run build:distribution
desk serve --dev
```

The development command does not switch to the private Bun runtime when Vite is
missing.

### Terminals report missing because Desk cannot find `atch`

Desk preflights the atch executable before starting the terminal daemon. It
logs the failure and keeps non-terminal workspace features available. Resolution
is `DESK_ATCH_BIN`, same-release `libexec/atch`, then `PATH`, in that order.
Managed releases and the Docker image include the pinned same-release binary.
Reinstall or rebuild a missing or corrupt bundle; use an absolute override only
when intentionally testing another build:

```bash
DESK_ATCH_BIN=/opt/atch/bin/atch desk serve
```

Terminal transport fails closed rather than reporting a healthy runtime that
cannot provision sessions.

### Startup reports `EMFILE: too many open files`

This is an operating-system watcher limit, not a reason to change server modes.
Close unnecessary watcher-heavy processes and inspect the current limits. On
Linux, increase the user or inotify limits through your system configuration,
then restart the shell and `desk serve --dev`. The default Bun mode does not run
Vite's source watcher.

### Port 5173 is already in use

Desk fails closed on the requested port; it does not select another port. Stop
the existing listener or choose an explicit port:

```bash
desk serve --port 5174
desk serve --dev --port 5174
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
- `atch` is missing or not executable

### A terminal cell is blank

Check:

```bash
desk capture <session-name> --lines 100
```

If capture has output but the browser is blank, inspect terminal transport
health in [Operations](/operations). If capture is empty, attach to the atch
session directly through Desk:

```bash
desk attach <session-name>
```

### Scrolling behaves differently for OpenCode

OpenCode is a full-screen TUI. Its conversation scroll lives inside the app,
not in the daemon's frozen scrollback like append-style Codex or Claude output.
Desk routes scroll based on terminal state so full-screen TUIs receive
page-scroll keys instead of the frozen scrollback overlay.

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

Restart an already-running session after changing permission behavior.

### Attention events do not appear

Run:

```bash
desk hooks install
```

Then restart managed agent sessions so their launch environment and hook
configuration are active. Custom commands may require manual event integration.

## Channels

### Desk refuses to start: "obsolete Channels ownership artifact at …/_engine/engine.pid"

A Desk server older than the ownership lease ran against this channels home
and left its pid record behind (that engine removed the file only when it
recovered from a crash; an orderly stop kept it). The file carries no
authority any more, and nothing removes it for you: stop every Desk server
for this home (`pgrep -f desk-standalone` should print nothing), delete
`~/.config/desk/channels/_engine/engine.pid`, then start Desk again.

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

No. Desk launches local atch sessions on the host where the server runs.

### Does Desk store my model credentials?

Desk never reads, transmits, or proxies them — but with **agent profiles** it
does own the directory they sit in, so the honest answer depends on how the
session runs.

- **Without a profile**, the agent CLI authenticates into its own normal
  location (`~/.claude`, `~/.codex`) and Desk touches nothing.
- **With a profile**, Desk points the CLI at `~/.config/desk/profiles/<id>`
  by setting `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. The CLI writes its own
  credential files (`.credentials.json`, `auth.json`) there. Desk creates the
  directory `0700` and does not parse what the CLI puts in it.

The practical consequences: those files are as sensitive as the ones in your
home directory, and **they are not covered by a backup of `~/.claude`** — see
the backup answer below.

### Can I run multiple browsers?

Yes, but remember each browser is a view onto the same local atch sessions and
manifest state. Coordinate operator actions when multiple people access the
same server.

### Can I edit the manifest by hand?

Yes. Desk uses `~/.config/desk/desk.yml`. Keep YAML valid, preserve each
session's durable `sessionId`, and run `desk status` or reload the UI afterward.

### What should I back up?

Back up the whole of `~/.config/desk` — that is the simplest correct answer,
because everything Desk owns lives under it:

| Path | Holds |
| --- | --- |
| `desk.yml` | the manifest: projects, groups, sessions, profiles |
| `channels/` | every conversation, thread, upload, and delivery queue |
| `notes/` | markdown notes |
| `profiles/` | **agent credentials** for profiled sessions |
| `claude/settings.json` | the hook settings Desk hands Claude at launch |

<Warning>
`profiles/` is the one that hurts to lose. A profiled session authenticates
*into* its profile directory, so a backup that copies only `desk.yml`,
`channels`, and `notes` restores a workspace whose agents are all logged out.
</Warning>
