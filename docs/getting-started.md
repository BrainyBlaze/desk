---
title: "Getting started"
description: "Install Desk, start the local server, and launch your first durable agent session."
---

This guide takes you from an empty machine to a running Desk workspace with one
managed agent session. It uses the source-checkout runtime because that path
also installs the global `desk` CLI.

<Info>
If you already use a standalone release binary, skip to
[Run a standalone binary](#run-a-standalone-binary). The runtime behavior is
the same, but the launch command is different.
</Info>

## Requirements

Install the required host tools first:

- Node.js 20 or newer
- npm
- tmux
- git
- a C/C++ build toolchain for `node-pty`

Optional tools unlock additional features:

- `codex`, `claude`, or `opencode` for managed agent sessions
- `gh` for GitHub repository, pull request, and Projects features
- `rg` for fast file search in the editor
- `nvidia-smi` or `intel_gpu_top` for GPU telemetry

## Five-minute setup

<Steps>
  <Step title="Clone and install">
    ```bash
    git clone https://github.com/BrainyBlaze/desk.git
    cd desk
    ./install.sh
    ```

    The installer checks prerequisites, installs npm dependencies, builds the
    CLI, and runs `npm link`.

    <Check>
    `desk help` should print the CLI command list.
    </Check>
  </Step>

  <Step title="Create the manifest">
    ```bash
    desk init
    desk config
    ```

    Desk writes the user manifest to `~/.config/desk/desk.yml`. The command is
    safe to run before any sessions exist.

    <Check>
    `desk config` should print the active manifest path.
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
    desk serve
    ```

    Desk starts the source-checkout runtime and prints the local URL. By
    default it binds to `127.0.0.1:5173`.

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

    Desk writes the session to `desk.yml`, creates a deterministic tmux
    session, and attaches the browser terminal through the terminal broker.

    <Check>
    The new terminal cell should show the selected agent or shell TUI. `desk
    status` should show a matching tmux session.
    </Check>
  </Step>
</Steps>

## Run a standalone binary

Standalone release artifacts are named by target, for example:

```text
desk-server-linux-x64
desk-server-linux-arm64
desk-server-darwin-arm64
```

After downloading the matching artifact from a GitHub Release, make it
executable and run it:

```bash
chmod +x ./desk-server-linux-x64
./desk-server-linux-x64
```

The standalone server uses the same backend as `desk serve`, but it does not
run Vite at runtime. It serves the embedded UI bundle and mounts the Desk API on
a plain HTTP server.

Use environment variables for the standalone runtime:

```bash
DESK_HOST=127.0.0.1 DESK_PORT=5173 ./desk-server-linux-x64
```

See [Distribution and deployment](/distribution-deployment) and [Deploy and
secure Desk](/guide-deploy-securely) before exposing Desk beyond localhost.

## Bring a configured fleet up

When `desk.yml` contains multiple sessions, use **Up** in the UI or the CLI:

```bash
desk up --dry-run
desk up
desk status
```

`desk up` starts missing configured sessions without replacing running tmux
sessions. Use [Create an agent fleet](/guide-create-agent-fleet) to build a
larger manifest intentionally.

## Useful CLI commands

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
