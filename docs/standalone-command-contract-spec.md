# Desk command contract repair

**Status:** Approved design
**Date:** 2026-07-12

## Context

Commit `6f75501483de53b5d0845f9569dca29aa780b5d0` changed `install.sh` from a source-build installer into a release-binary downloader. The release asset remained a server-only executable named `desk-server-<target>`, but the installer renamed it to `desk`. The source package already exposes a different executable named `desk`: the multi-command CLI in `dist/cli/main.js`.

The two executables therefore have incompatible contracts under one command name:

- the source CLI accepts `serve`, `channels`, `up`, `status`, and the other CLI commands;
- the standalone executable starts the embedded server unconditionally and does not dispatch CLI arguments.

Whichever installation directory appears first on `PATH` determines what `desk` means. In the reproduced failure, a `desk channels read <channel>` invocation resolved to the standalone binary and silently started a server on port 5173. A later `desk` invocation then failed with `EADDRINUSE`. The earlier `proper-lockfile` failure came from a stale source checkout and was not the release defect.

## Goals

1. Give each executable one stable, non-overlapping command name.
2. Preserve `desk` as the full source-checkout CLI.
3. Install and document the standalone server as `desk-server`.
4. Make the standalone entrypoint reject unsupported arguments before it imports or starts the server.
5. Cover the installer name and fail-closed argument behavior with regression tests.
6. Give existing users a safe, non-destructive migration warning.

## Non-goals

- Bundling the full multi-command CLI into the standalone executable.
- Changing the standalone HTTP API, UI assets, PTY backend, plugin loading, host defaults, or port defaults.
- Automatically deleting or overwriting an existing `desk` executable during migration.
- Solving host-wide file-watcher or inotify exhaustion in the source development environment.

## Command contract

| Command | Owner | Behavior |
| --- | --- | --- |
| `desk <command>` | Source-checkout Node CLI | Existing commands remain unchanged, including `desk serve` and `desk channels ...`. |
| `desk-server` | Standalone Bun executable | Starts the embedded UI and API, honoring `DESK_HOST`, `DESK_PORT`, and existing plugin configuration. |
| `desk-server --help` or `desk-server -h` | Standalone Bun executable | Prints concise standalone usage and environment-variable help, exits 0, and opens no listener. |
| `desk-server <anything-else>` | Standalone Bun executable | Prints a clear usage error, exits 2, and opens no listener. |

`desk-server serve` is intentionally rejected. The distinct executable name is itself the server command; accepting the source CLI's subcommand would blur the repaired contract again.

## Design

### 1. Preserve the full CLI as `desk`

The `package.json` `bin.desk` mapping remains pointed at `dist/cli/main.js`. No source CLI command behavior changes. Source-development documentation continues to use `npm ci`, `npm run build`, `npm link`, and `desk serve`.

### 2. Install the standalone as `desk-server`

`install.sh` keeps its current platform detection, release resolution, checksum verification, install-directory selection, and sudo fallback. Only the installed command contract changes:

- the downloaded `desk-server-<target>` asset is installed as `${dir}/desk-server`;
- success and next-step output tells the user to run `desk-server`;
- PATH diagnostics refer to `desk-server`;
- the script never creates, replaces, or removes `${dir}/desk`.

If `${dir}/desk` already exists, the installer prints a migration warning explaining that earlier binary installers used that name. It does not assume ownership of the file. The warning tells users to inspect `command -v desk` and remove or rename the legacy standalone only after confirming what it is.

### 3. Reject standalone arguments before server startup

Argument handling lives in a small server-layer module with no imports from the server runtime. It maps an argv array to one of three results: start, help, or usage error.

The standalone entrypoint performs this check before loading `standalone.ts` or `embeddedPlugins.ts`. Valid server startup uses dynamic imports after validation. This ordering matters: unsupported commands must not initialize SDKs, extract assets, register watchers, load plugins, or attempt to bind a port.

For a usage error, the entrypoint writes one deterministic diagnostic to stderr, sets exit code 2, and returns. For help, it writes usage to stdout, sets exit code 0, and returns. Only the start result imports the runtime and calls `startStandalone`.

Server startup failures keep the existing error reporting and nonzero exit behavior.

### 4. Align docs and release messaging

Binary-install documentation uses `desk-server`; source-checkout documentation uses `desk`. At minimum, update:

- `README.md`
- `install.sh` comments and output
- `docs/getting-started.md`
- `docs/distribution-deployment.md`
- `docs/guide-deploy-securely.md`
- `docs/index.md`
- `docs/troubleshooting.md`
- `CHANGELOG.md`

The documentation must state that versions of `install.sh` introduced around v0.2.0 may have placed a standalone executable at `~/.local/bin/desk` or `/usr/local/bin/desk`, and provide a non-destructive inspection/migration sequence.

## Control flow

### Installer

1. Resolve platform and release exactly as today.
2. Download and verify `desk-server-<target>`.
3. Install it to `${dir}/desk-server`.
4. Warn, without mutating, if `${dir}/desk` also exists.
5. Print `desk-server` as the launch command.

### Standalone executable

1. Read `process.argv.slice(2)`.
2. Return help for `-h` or `--help` when it is the only argument.
3. Return a usage error for every other non-empty argv.
4. With empty argv, dynamically load the standalone runtime and embedded plugins.
5. Start the server with the existing environment-based configuration.

## Error handling and safety

- Unsupported arguments fail closed before any listener or side effect.
- Usage errors identify the standalone contract and point to the source CLI for `desk <command>` workflows.
- Installer migration behavior is warning-only; it never guesses whether an existing `desk` belongs to Desk, another package, or a user-managed link.
- Existing checksum mismatch and download-failure behavior remains unchanged.
- The source CLI and standalone binary can coexist on the same `PATH` because their basenames differ.

## Test strategy

Implementation follows red-green-refactor.

### Standalone argument tests

Add focused tests that first fail against the current unconditional entrypoint behavior, then prove:

- empty argv selects server startup;
- `-h` and `--help` select help and exit successfully;
- `serve`, `channels read example-channel`, and arbitrary flags select a usage error;
- rejected arguments do not invoke an injected server-start function;
- the usage error uses exit code 2 and names `desk-server`.

The parser/runner boundary must be testable without importing Bun-only embedded assets.

### Installer behavior test

Run `install.sh` in a temporary directory with `DESK_VERSION` and `DESK_INSTALL_DIR` set and network/system commands supplied by a deterministic fake PATH. Prove that:

- the installed file is `${DESK_INSTALL_DIR}/desk-server` and is executable;
- `${DESK_INSTALL_DIR}/desk` is not created or replaced;
- output names `desk-server` as the next command;
- an existing `${DESK_INSTALL_DIR}/desk` is left byte-for-byte unchanged and produces the migration warning.

### Verification

- Run the focused new tests and observe the required red-to-green transition.
- Run `npm run check` and the full Vitest suite under Node 22.23.1.
- Run `npm run build:standalone`.
- Execute the compiled binary with an unsupported command and confirm exit 2 with no listener.
- Start the compiled binary with no arguments on a temporary port, confirm an HTTP 200 response, then terminate it.
- Audit docs with a focused search so binary quickstarts do not instruct users to run standalone `desk`, and source CLI examples still use `desk`.

## Acceptance criteria

- A fresh `install.sh` run installs `desk-server`, not `desk`.
- `npm link` continues to provide the full `desk` CLI without PATH ambiguity from the installer.
- `desk-server channels read example-channel` exits 2 promptly and cannot occupy port 5173.
- `desk-server` still serves the embedded application with the same defaults and environment overrides.
- Existing `desk` files are never deleted or overwritten by migration logic.
- Tests, type checking, the full suite, the standalone build, and compiled-binary smoke checks pass under the repository's supported toolchain.
