---
title: "Distribution and deployment"
sidebarTitle: "Distribution"
description: "Understand Desk's source-backed installer, explicit Bun and Vite server modes, release assets, and container contract."
---

Desk distributes one public CLI with two explicit server modes:

| Command | Runtime | Intended use |
| --- | --- | --- |
| `desk serve` | Private compiled Bun runtime with embedded UI | Default local operation |
| `desk serve --dev` | Node and Vite with source UI | Desk development and debugging |

Both mount the same backend API. Neither command falls back to the other when its
runtime is missing or fails.

## Source-backed installation

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
desk serve
```

The installer:

1. detects macOS or Linux, x64 or arm64, and the host libc;
2. acquires a sibling install lock before package provisioning;
3. provisions and rechecks the required host capabilities;
4. verifies the release checksum and install manifests;
5. downloads and verifies the source archive plus pinned Node/npm and Bun
   toolchains;
6. safely extracts each archive into an empty staging directory;
7. runs `npm ci` and `npm run build:distribution` with the Desk-owned toolchains;
8. smokes the staged CLI, activates it atomically, and smokes the public launcher.

The default install root is
`${XDG_DATA_HOME:-$HOME/.local/share}/desk`. `DESK_HOME` overrides that root.
`DESK_BIN_DIR` overrides the launcher directory only when that canonical, safe
directory is already on `PATH` and no earlier command shadows it.

```text
desk/
├── releases/<version>/<install-id>/
│   ├── .desk-release
│   ├── node_modules/
│   ├── runtime/node
│   ├── dist/cli/main.js
│   └── libexec/desk-standalone
├── toolchains/node-22.23.1/
├── toolchains/bun-1.3.14/
└── current -> releases/<version>/<install-id>
```

The stable `desk` launcher resolves `current`, verifies that the release remains
under the managed root, and executes the release-bound Node runtime and CLI.

## Install lifecycle

- A first install does not expose a launcher until staging and smoke checks pass.
- An upgrade or explicit downgrade preserves the active instance until the new
  instance is verified.
- A same-version reinstall creates a new install ID; it never mutates the active
  directory.
- After successful activation, Desk retains the current and immediately previous
  valid instances and their referenced toolchains.
- Latest-version resolution refuses to silently downgrade. Setting
  `DESK_VERSION=vX.Y.Z` explicitly permits a downgrade.
- Any activation failure restores the previous `current` target and launcher.

Rerun the installer to upgrade or repair. Use the same installer for ownership-
safe uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh \
  | bash -s -- --uninstall
```

Uninstall preserves user configuration, projects, tmux sessions, credentials,
and optional tools.

## Release assets

Tagged releases publish only:

- `desk-vX.Y.Z-source.tar.gz`
- `desk-install-manifest.json`
- `SHA256SUMS`

The install manifest declares the source digest and exact target-qualified Node
and Bun assets. It contains no caller-controlled URLs. The installer constructs
toolchain URLs only from the official Node and Bun release origins.

There is no separately installable server executable. The compiled runtime is a
private release component at `libexec/desk-standalone`.

## Build ordering

Contributors and CI pin Node 22.23.1, npm 10.9.8, and Bun 1.3.14.

```bash
npm ci
npm run check
npm test
npm run build:distribution
npm run smoke:serve-modes
npm run build
```

`build:distribution` runs the compiled-runtime build first and the TypeScript
CLI build last. This order matters because Vite clears `dist/`. Run `npm run
build` after any later UI build to restore the Node CLI.

The real smoke script proves:

- the default root responds without a Vite client route;
- `serve --dev` exposes the Vite client route;
- SIGINT and SIGTERM stop each supervised process group;
- an occupied port fails without an alternate listener or fallback;
- a controlled private-runtime exit status propagates through the CLI.

## Server options

Both modes accept flags:

```bash
desk serve --host 127.0.0.1 --port 5173
desk serve --dev --host 127.0.0.1 --port 5173
```

Precedence is flags, then `DESK_HOST` / `DESK_PORT`, then
`127.0.0.1:5173`.

## Container contract

The Docker image uses Node 22.23.1 in both build and runtime stages, builds the
full application at `/opt/desk`, and exposes the same CLI:

```bash
docker build -t desk:cli .
docker run --rm desk:cli help
docker run --rm -p 127.0.0.1:5173:5173 desk:cli
docker run --rm -p 127.0.0.1:5174:5174 \
  desk:cli serve --dev --host 0.0.0.0 --port 5174
```

The container binds `0.0.0.0` because port publication is controlled by Docker.
Publish it only on a trusted host interface. Desk has no built-in authentication.

## Host integrations

The installer owns core build/runtime requirements. These integrations remain
optional and use the host user's credentials:

- `codex`, `claude`, and `opencode` for agents
- `gh` for GitHub and Projects
- `rg` for fast search
- GPU telemetry commands

Read [Run Desk securely](/guide-deploy-securely) before remote access and
[Troubleshooting](/troubleshooting) for installer or runtime failures.
