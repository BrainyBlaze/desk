---
title: "Deploy and secure Desk"
description: "Run Desk locally, expose it deliberately, and choose the right security boundary for source and standalone deployments."
---

Desk is designed for local use on a developer machine or remote development
box. It has direct access to the host filesystem, tmux sessions, Git
repositories, agent CLIs, and credentials available to the server user.

<Warning>
Do not expose Desk directly to an untrusted network. Use SSH forwarding, a VPN,
an authenticated reverse proxy, or a plugin gate when remote access is needed.
</Warning>

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

## Keep the default local boundary

The default host is `127.0.0.1`. Keep that default when you use Desk from the
same machine.

For a remote development box, prefer SSH forwarding:

```bash
ssh -L 5173:127.0.0.1:5173 user@dev-box
```

Then open `http://127.0.0.1:5173` locally.

## If you bind beyond localhost

Before setting `--host 0.0.0.0` or `DESK_HOST=0.0.0.0`, decide how requests are
authenticated.

Supported patterns:

- SSH tunnel
- VPN-only network
- authenticated reverse proxy
- runtime plugin via `DESK_PLUGINS`
- embedded plugin in a downstream standalone build

Read [Security and plugin model](/security-plugin-model) for the plugin surface.

## Install agent hooks

Managed agents can report lifecycle and attention events through Desk-owned
hooks:

```bash
desk hooks install
```

This installs or merges hook configuration for Codex, Claude, and OpenCode
under the current home directory. Use `--home` when preparing another user's
home directory:

```bash
desk hooks install --home /home/dev
```

## Verify a deployment

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

## Operational safety checklist

- Bind to localhost unless a gate is in place.
- Run Desk as the user that owns the intended repositories and tmux sessions.
- Keep agent CLI credentials in their normal tool-managed locations.
- Use `desk up --dry-run` before starting a large manifest.
- Use the emergency kill switch only when you intend to stop all matching
  agent processes on the host.
- Back up `~/.config/desk/desk.yml` before large manifest edits.
- Treat `~/.config/desk/channels` and `~/.config/desk/notes` as local user data.

## Next steps

- Read [Distribution and deployment](/distribution-deployment) for artifact and
  build details.
- Read [Operations](/operations) for runtime monitoring and controls.
- Read [Troubleshooting and FAQ](/troubleshooting) for deployment symptoms.
