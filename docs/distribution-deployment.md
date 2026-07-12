---
title: "Distribution and deployment"
sidebarTitle: "Distribution"
description: "Run Desk from the standalone binary or a source checkout, and understand what each runtime includes."
---

Desk has two runtime shapes:

- the standalone binary (installed as `desk-server`) — the default
- a source checkout with the `desk` CLI (`desk serve`)

They share the same backend API and browser UI. The difference is how the UI, language-server assets, and PTY backend are packaged.

## Standalone runtime

The standalone server is built with Bun's compile mode. It is self-contained and does not run Vite at runtime. Install it with the one-liner — it lands as `desk-server`:

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
desk-server
```

Host and port come from environment variables:

```bash
DESK_HOST=127.0.0.1 DESK_PORT=5173 desk-server
```

`desk-server` is intentionally server-only and rejects CLI subcommands. Use the
source checkout's `desk` command for `serve`, `up`, `channels`, and other CLI
operations.

The standalone server:

- starts the same Desk backend API on a plain HTTP server
- serves the embedded UI bundle with SPA fallback
- honors runtime `DESK_PLUGINS`
- can include build-time embedded plugins in downstream builds
- uses a Bun-native PTY backend instead of `node-pty`

Downloaded a release artifact directly instead of using the installer? Make it executable and run it by its target name:

```bash
chmod +x ./desk-server-linux-x64
DESK_HOST=127.0.0.1 DESK_PORT=5173 ./desk-server-linux-x64
```

## Source-checkout runtime

Use this when you are developing Desk or want the multi-command `desk` CLI. It needs Node.js 20+, npm, and a C/C++ toolchain for `node-pty`:

```bash
npm ci && npm run build && npm link
desk serve
```

`desk serve` starts a Vite server bound to `127.0.0.1:5173` by default. Desk mounts its API, WebSocket bridges, file watchers, terminal broker, LSP endpoint, and plugin routes into Vite server middleware.

The Vite server is the supported source runtime. It is not only a development preview.

Change host and port with flags:

```bash
desk serve --host 127.0.0.1 --port 5173
```

The source runtime uses:

- Node.js for the CLI and server
- Vite for serving the UI
- `node-pty` for PTY sessions
- dependencies installed in `node_modules`

## Release artifacts

The release workflow builds standalone binaries for:

- `linux-x64`
- `linux-arm64`
- `darwin-arm64`

Tagged releases publish:

- `desk-server-linux-x64`
- `desk-server-linux-arm64`
- `desk-server-darwin-arm64`
- `SHA256SUMS`

The release job only publishes on version tags that match `package.json`.

## Embedded assets

The standalone build creates tarballs before compiling the binary:

- `ui.tar.gz`: the Vite UI bundle from `dist/public`
- `lsp.tar.gz`: TypeScript Language Server, TypeScript, and Pyright in `node_modules` layout

On first use, the binary extracts these assets under `~/.cache/desk/...` and reuses the cache for later starts of the same binary.

Rust analyzer is handled separately. Desk downloads a pinned upstream Rust Analyzer release on demand, verifies SHA-256, and caches it under `~/.cache/desk/lsp/rust-analyzer`.

## Host dependencies

The standalone binary still calls host tools:

- `tmux` for session lifetime
- `git` for Git operations
- `gh` for GitHub and Projects operations
- agent CLIs such as `codex`, `claude`, and `opencode`
- `tar` for extracting embedded assets
- optional telemetry tools such as `nvidia-smi` and `intel_gpu_top`

Install and authenticate those tools on the host before expecting the corresponding Desk subsystem to work.

## Build commands

Source build:

```bash
npm run build
```

UI build check:

```bash
npm run build:ui
```

Standalone build:

```bash
npm run build:standalone
```

The standalone build runs the UI build, creates asset tarballs, and compiles `desk-server`.

## Choosing a runtime

Use `desk serve` when:

- you are working from a clone
- you want normal Node/Vite development behavior
- you need source-level debugging

Use the standalone binary when:

- you want a single executable server artifact
- you do not want Vite or the UI source tree at runtime
- you are deploying Desk as a local operator tool on a machine that already has tmux and the agent CLIs

Keep Desk bound to localhost. If you work on a remote development box, use the
SSH forwarding model in [Run Desk securely](/guide-deploy-securely).

## Next steps

- Follow [Deploy and secure Desk](/guide-deploy-securely) for a deployment
  checklist.
- Read [Architecture](/concepts-architecture) to understand what source and
  standalone runtimes share.
- Use [Troubleshooting and FAQ](/troubleshooting) for startup and local
  connection issues.
