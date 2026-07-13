---
title: "Getting started"
description: "Install the complete Desk CLI, choose a server mode, and launch your first durable agent session."
---

The curl installer builds a versioned Desk release and makes the complete `desk`
CLI immediately available on your existing `PATH`.

## Requirements

You need a working `curl` with TLS trust to download the installer. Supported
release targets are:

- macOS x64 and arm64
- glibc Linux x64 and arm64, including WSL

Native Windows is unsupported. Alpine and other musl systems can provision host
packages, but installation stops before activation because Desk does not yet
publish a compatible Node toolchain.

The installer detects, installs, and rechecks the required host layer: CA
certificates, archive and checksum tools, tmux 3.2+, Git 2.30+, Python 3.6+, make,
and a working C++ compiler. It maintains its own checksum-verified Node 22.23.1,
npm 10.9.8, and Bun 1.3.14 under the Desk install root. It does not replace your
global runtimes.

Agent CLIs (`codex`, `claude`, and `opencode`), `gh`, and GPU telemetry commands
are optional. Install only the integrations you intend to use.

## Install and start Desk

<Steps>
  <Step title="Install the CLI">
    ```bash
    curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
    command -v desk
    desk help
    ```

    The installer refuses a launcher directory outside `PATH` and refuses to
    overwrite an unidentified `desk` command. A successful install therefore
    makes `curl ... | bash && desk serve` valid in the invoking shell.
  </Step>

  <Step title="Start the default server">
    ```bash
    desk serve
    ```

    Plain `serve` launches the private Bun runtime and embedded UI. It binds to
    `127.0.0.1:5173` by default.

    ```bash
    desk serve --host 127.0.0.1 --port 5173
    ```

    <Check>
    Open `http://127.0.0.1:5173` and confirm that the Desk UI loads.
    </Check>
  </Step>

  <Step title="Create your first session">
    In the UI, open **Add session** and choose a session name, agent or command,
    and repository directory. Desk writes the session to
    `~/.config/desk/desk.yml` and owns its tmux lifetime.
  </Step>
</Steps>

## Choose the Vite development mode

Use Vite only when you are developing Desk or need source-level UI behavior:

```bash
desk serve --dev
```

The modes are explicit and fail closed. Plain `desk serve` never falls back to
Vite, and `desk serve --dev` never falls back to Bun. Host and port precedence is:
flags, then `DESK_HOST` / `DESK_PORT`, then `127.0.0.1:5173`.

## Authenticate optional integrations

Sign in through each tool's own CLI:

```bash
codex
claude
opencode
gh auth login
gh auth refresh -s project
```

Missing optional tools disable only their related subsystem.

## Operate a configured fleet

```bash
desk up --dry-run
desk up
desk status
desk attach <name|tmux-session|resume-id>
desk capture <name|tmux-session|resume-id> --lines 200
desk hooks install
```

`desk up` starts missing configured sessions without replacing running tmux
sessions.

## Upgrade, reinstall, or downgrade

Rerun the installer to resolve and install the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
```

Pin a version for an explicit install or downgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh \
  | DESK_VERSION=v0.3.0 bash
```

A same-version run creates and verifies a new immutable instance instead of
modifying the active one. After activation, Desk retains the current and previous
instances for rollback.

## Uninstall the managed application

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh \
  | bash -s -- --uninstall
```

Uninstall verifies Desk ownership before removing the launcher, releases,
toolchains, and install metadata. It preserves `~/.config/desk`, projects, tmux
sessions, credentials, and optional host tools. To remove configuration too,
inspect it first and then delete it explicitly:

```bash
rm -rf ~/.config/desk
```

## Build from source

Contributors should use the same pins as CI: Node 22.23.1, npm 10.9.8, and Bun
1.3.14.

```bash
git clone https://github.com/BrainyBlaze/desk.git
cd desk
npm ci
npm run build:distribution
npm link
desk serve --dev
```

See [Distribution and deployment](/distribution-deployment) for the versioned
layout and release assets, and [Run Desk securely](/guide-deploy-securely) before
changing the bind address.

## Next steps

<Columns cols={2}>
  <Card title="Model a fleet" icon="layout-grid" href="/guide-create-agent-fleet">
    Configure projects, groups, sessions, layouts, permissions, and startup.
  </Card>
  <Card title="Use channels" icon="messages-square" href="/guide-channels-collaboration">
    Add agents to rooms, mention them, and inspect delivery diagnostics.
  </Card>
  <Card title="Understand configuration" icon="file-cog" href="/configuration">
    Learn the `desk.yml` manifest schema.
  </Card>
  <Card title="Troubleshoot setup" icon="wrench" href="/troubleshooting">
    Diagnose installer, PATH, server, and session failures.
  </Card>
</Columns>
