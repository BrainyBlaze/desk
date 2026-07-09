---
title: "Getting started"
description: "Install Desk, start the local server, and launch your first durable agent session."
---

This guide takes you from an empty machine to a running Desk workspace with one
managed agent session, using the prebuilt `desk` binary.

<Info>
Prefer a source checkout — it also installs the multi-command `desk` CLI
(`desk serve`, `desk up`, `desk init`, …)? Jump to [Build from
source](#build-from-source). The runtime is the same; the binary's `desk` just
starts the server, and you drive the rest from the UI.
</Info>

## Requirements

The binary is self-contained — UI and language servers embedded, Bun-native
terminals — so the runtime needs only:

- tmux
- curl (to run the installer)

Optional tools unlock additional features:

- `codex`, `claude`, or `opencode` for managed agent sessions
- `gh` for GitHub repository, pull request, and Projects features
- `rg` for fast file search in the editor
- `nvidia-smi` or `intel_gpu_top` for GPU telemetry

## Five-minute setup

<Steps>
  <Step title="Install Desk">
    ```bash
    curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
    ```

    The installer downloads the release binary for your platform, verifies its
    checksum, and installs it as `desk` (in `/usr/local/bin` or `~/.local/bin`).

    <Check>
    `command -v desk` prints the install path.
    </Check>
  </Step>

  <Step title="Authenticate external tools">
    Sign in through each tool's own CLI:

    ```bash
    codex
    claude
    opencode
    gh auth login
    gh auth refresh -s project
    ```

    Use only the tools you plan to launch. Desk degrades subsystem-by-subsystem
    when optional tools are absent.
  </Step>

  <Step title="Start the server">
    ```bash
    desk
    ```

    Desk starts the standalone server and prints the local URL. By default it
    binds to `127.0.0.1:5173`; override with `DESK_HOST` / `DESK_PORT`.

    <Check>
    Open `http://127.0.0.1:5173` and confirm the Desk UI loads.
    </Check>
  </Step>

  <Step title="Create your first session">
    In the UI, open **Add session** from the agents sidebar and choose:

    - session name: `first-codex`
    - agent: `codex`, `claude`, `opencode`, or `bash`
    - working directory: the repository you want the agent to use
    - permission bypass: enabled for a YOLO-style managed agent, disabled when
      you want tool prompts

    Desk writes the session to `~/.config/desk/desk.yml`, creates a
    deterministic tmux session, and attaches the cell — Codex, Claude, and
    OpenCode open as a native chat surface, bash and custom commands as a
    browser terminal.

    <Check>
    The cell should show the agent's chat composer (or the shell TUI for
    bash), and `tmux ls` should list a matching session.
    </Check>
  </Step>
</Steps>

## Build from source

A source checkout gives you the full **`desk` CLI** — `desk serve`, `desk up`,
`desk init`, `desk config`, `desk status`, and more — plus the Vite dev runtime.
You need **Node.js 20+**, **npm**, **tmux**, and a C/C++ toolchain for `node-pty`
(`build-essential` / Xcode CLT):

```bash
git clone https://github.com/BrainyBlaze/desk.git
cd desk
npm ci && npm run build && npm link
desk serve            # Vite runtime + UI on http://127.0.0.1:5173
```

`desk serve` runs the same backend as the binary, through a Vite server. See
[Distribution and deployment](/distribution-deployment) for how the two runtimes
differ, and [Run Desk securely](/guide-deploy-securely) before exposing either.

Want a specific prebuilt build instead of the installer? Download an artifact
(`desk-server-linux-x64`, `desk-server-linux-arm64`, `desk-server-darwin-arm64`)
from a [release](https://github.com/BrainyBlaze/desk/releases), `chmod +x`, and
run it directly:

```bash
DESK_HOST=127.0.0.1 DESK_PORT=5173 ./desk-server-linux-x64
```

## Bring a configured fleet up

When `desk.yml` contains multiple sessions, use **Up** in the UI. From a source
checkout you can also drive it from the CLI:

```bash
desk up --dry-run
desk up
desk status
```

`desk up` starts missing configured sessions without replacing running tmux
sessions. Use [Create an agent fleet](/guide-create-agent-fleet) to build a
larger manifest intentionally.

## Useful CLI commands (source checkout)

The multi-command `desk` CLI ships with a source checkout (`npm link`):

```bash
desk help
desk config
desk up --dry-run
desk status
desk attach <name|tmux-session|resume-id>
desk capture <name|tmux-session|resume-id> --lines 200
desk hooks install
```

`desk add` writes a manifest session from the CLI. For managed agent sessions
it requires a real `--resume` id today. Use the Add Session modal or edit
`desk.yml` when you want Desk to start fresh and harvest the id later.

```bash
desk add --group main --name api-codex --cwd ~/projects/product --agent codex --resume 00000000-0000-0000-0000-000000000000
desk add --group main --name dev-server --cwd ~/projects/product --command "npm run dev"
```

## Next steps

<Columns cols={2}>
  <Card title="Model a fleet" icon="layout-grid" href="/guide-create-agent-fleet">
    Configure projects, groups, sessions, layouts, permissions, and startup
    behavior.
  </Card>

  <Card title="Use channels" icon="messages-square" href="/guide-channels-collaboration">
    Add agents to rooms, mention them, read replies, and inspect delivery
    diagnostics.
  </Card>

  <Card title="Understand configuration" icon="file-cog" href="/configuration">
    Learn the full `desk.yml` manifest schema.
  </Card>

  <Card title="Troubleshoot setup" icon="wrench" href="/troubleshooting">
    Fix missing tmux sessions, absent agent CLIs, GitHub auth, LSP, and channel
    delivery issues.
  </Card>
</Columns>
