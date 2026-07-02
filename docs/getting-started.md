---
title: "Getting started"
description: "Install Desk, start the local server, and launch your first agent session."
---

Desk runs agent sessions in tmux and serves the operator UI on localhost. You can run it from a source checkout during development or from a standalone release binary.

## Requirements

For a source checkout, you need:

- Node.js 20 or newer
- npm
- tmux
- git
- a C/C++ build toolchain for `node-pty`

Optional tools unlock additional subsystems:

- `codex`, `claude`, or `opencode` for managed agent sessions
- `gh` for GitHub repository, pull request, and Projects features
- `rg` for fast file-content search in the editor
- `nvidia-smi` or `intel_gpu_top` for GPU telemetry

The standalone binary embeds the built UI and TypeScript/Python language-server assets, but it still expects host tools such as `tmux`, `git`, `gh`, and the agent CLIs you choose to launch.

## Install from source

Use the installer when you want a global `desk` command linked to a checkout:

```bash
git clone https://github.com/BrainyBlaze/desk.git
cd desk
./install.sh
desk serve
```

The installer checks prerequisites, installs npm dependencies, builds the CLI, and runs `npm link`.

You can also run the same steps manually:

```bash
npm install
npm run build
npm link
desk serve
```

## Run a standalone binary

Standalone release artifacts are named by target, for example:

```text
desk-server-linux-x64
desk-server-linux-arm64
desk-server-darwin-arm64
```

After downloading the matching artifact from a GitHub Release, make it executable and run it:

```bash
chmod +x ./desk-server-linux-x64
./desk-server-linux-x64
```

The standalone server uses the same backend as `desk serve`, but it does not run Vite at runtime. It serves the embedded UI bundle and mounts the Desk API on a plain HTTP server.

## Start the server

`desk serve` starts the source-checkout runtime:

```bash
desk serve
```

By default Desk binds to `127.0.0.1:5173`. Open that URL in a browser.

Use flags for the source runtime:

```bash
desk serve --host 127.0.0.1 --port 5173
```

Use environment variables for the standalone runtime:

```bash
DESK_HOST=127.0.0.1 DESK_PORT=5173 ./desk-server-linux-x64
```

See [Distribution and deployment](/distribution-deployment) before exposing Desk beyond localhost.

## Authenticate external tools

Desk uses the tools already installed on the host. Sign in through each tool's own flow:

```bash
codex
claude
opencode
gh auth login
```

GitHub Projects requires the `project` scope:

```bash
gh auth refresh -s project
```

Desk degrades subsystem-by-subsystem when optional tools are unavailable.

## Create your first session

Open the UI and use **Add session** from the agents sidebar. Choose:

- a session name
- an agent: `codex`, `claude`, `opencode`, or `bash`
- a working directory
- whether to bypass agent permission prompts
- optional resume metadata

Desk writes the session to `~/.config/desk/desk.yml`, creates a deterministic tmux session, and attaches the browser terminal through the terminal broker.

You can also edit the manifest directly. See [Configuration](/configuration).

## Bring a fleet up

The **Up** control starts missing configured sessions without replacing running sessions.

The CLI equivalent is:

```bash
desk up
desk status
```

`desk status` shows which configured sessions have matching tmux sessions.

## Useful CLI commands

```bash
desk help
desk config
desk up --dry-run
desk attach <name|tmux-session|resume-id>
desk capture <name|tmux-session|resume-id> --lines 200
desk hooks install
```

`desk add` writes a manifest session from the CLI. For agent sessions it requires a real `--resume` id today; use the Add Session modal or edit `desk.yml` when you want Desk to start fresh and harvest the id later.

```bash
desk add --group main --name api-codex --cwd ~/projects/product --agent codex --resume 00000000-0000-0000-0000-000000000000
desk add --group main --name dev-server --cwd ~/projects/product --command "npm run dev"
```

## Next steps

- Configure projects, groups, sessions, layouts, and settings in [Configuration](/configuration).
- Read [Agent integrations](/agent-integrations) for per-agent launch, resume, permission, and attention behavior.
- Read [Security and plugin model](/security-plugin-model) before changing the bind host or adding access from another machine.
