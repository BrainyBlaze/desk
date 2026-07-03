---
title: "Run Desk securely"
sidebarTitle: "Run securely"
description: "Desk is single-user, local, self-hosted software. Run it on your own machine, keep it on localhost, and reach a remote box over SSH."
---

Desk is **local, single-user, self-hosted software**. It runs on your own
machine (or your own remote development box) for you — the person who owns the
code, the tmux sessions, the agent CLIs, and the credentials on that host. It
is not a multi-tenant service and is not meant to be hosted for other people.

<Note>
Desk has direct access to the host filesystem, tmux, Git, and any credentials
available to the user that runs it. Run it as yourself, on a machine you
control, and keep it bound to localhost.
</Note>

## Choose a runtime

<Tabs>
  <Tab title="Source runtime">
    Use `desk serve` when you work from a checkout:

    ```bash
    desk serve --host 127.0.0.1 --port 5173
    ```

    This starts Vite and the Desk API from the source tree.
  </Tab>

  <Tab title="Standalone runtime">
    Use the standalone binary from a release artifact:

    ```bash
    DESK_HOST=127.0.0.1 DESK_PORT=5173 ./desk-server-linux-x64
    ```

    This serves the embedded UI and backend without Vite.
  </Tab>
</Tabs>

Both bind to `127.0.0.1:5173` by default. Keep that default.

## Working on a remote development box

If your code and agents live on a remote box, you still run Desk **as yourself
on that box** and reach it over an SSH tunnel — Desk stays on localhost at both
ends, and nothing is exposed to the network:

```bash
ssh -L 5173:127.0.0.1:5173 user@dev-box
```

Then start Desk on the box (bound to `127.0.0.1`) and open
`http://127.0.0.1:5173` in your local browser. The tunnel is authenticated by
SSH; Desk itself never listens on a public interface.

<Warning>
Do not bind Desk to `0.0.0.0` or put it on a shared address. It has no user
accounts, no login, and no request authentication — it trusts whoever can
reach the port. The supported way to use Desk from elsewhere is an SSH tunnel
to your own machine, not network exposure.
</Warning>

## Install agent hooks

Managed agents report lifecycle and attention events through Desk-owned hooks:

```bash
desk hooks install
```

This installs or merges hook configuration for Codex, Claude, and OpenCode
under the current home directory. Use `--home` when preparing another user's
home directory:

```bash
desk hooks install --home /home/dev
```

## Verify your setup

After starting the server, check:

```bash
desk status
desk capture <session-name> --lines 50
```

In the UI, verify:

- the agents sidebar lists expected sessions
- terminal cells connect
- the system segment updates
- channels load
- Git and GitHub panels use the expected repository
- notes and editor roots are the expected local paths

## Local safety checklist

- Keep the default `127.0.0.1` bind; never use `0.0.0.0`.
- Run Desk as the user that owns the intended repositories and tmux sessions.
- Reach a remote box over SSH forwarding, not by exposing the port.
- Keep agent CLI credentials in their normal tool-managed locations.
- Use `desk up --dry-run` before starting a large manifest.
- Use the emergency kill switch only when you intend to stop all matching
  agent processes on the host.
- Back up `~/.config/desk/desk.yml` before large manifest edits.
- Treat `~/.config/desk/channels` and `~/.config/desk/notes` as local user
  data.

## Next steps

- Read [Distribution and deployment](/distribution-deployment) for artifact and
  build details.
- Read [Operations](/operations) for runtime monitoring and controls.
- Read [Troubleshooting and FAQ](/troubleshooting) for setup symptoms.
