# Desk CLI installation and serve contract

**Status:** Approved design

**Date:** 2026-07-12

**Supersedes:** `docs/standalone-command-contract-spec.md`

## Summary

Desk will expose one user-facing command: `desk`. The curl installer will install
the complete source-backed CLI on supported macOS and Linux hosts, including WSL,
and will provision every missing required dependency. Native Windows is not
supported in this change.

The serve contract is explicit:

- `desk serve` starts the Node/Vite development runtime.
- `desk serve --standalone` starts the private Bun-compiled standalone runtime.
- Neither mode falls back to the other.
- The former public standalone executable and every release, installer, code,
  test, Docker, and documentation path that exposes it are removed.

Documentation is part of this contract. The refactor is incomplete while any
current user or contributor guide describes a different installer, executable,
runtime, dependency, or platform behavior.

## Context and root cause

Commit `6f75501483de53b5d0845f9569dca29aa780b5d0` replaced the source-build
installer with a downloader for a compiled Bun server. That server was installed
under the same command name already owned by the multi-command Node CLI, even
though it did not implement the CLI command dispatcher. Command resolution then
depended on whichever installation directory appeared first on `PATH`.

The later local repair gave the compiled server a separate public executable.
That avoided the name collision, but it did not meet the intended product
contract: a curl installation still did not provide the full Desk CLI, and users
had to understand two top-level commands and two incompatible argument models.

The underlying packaging constraint is that the default runtime is genuinely a
Vite source runtime. It requires the Desk source tree and its Node dependencies.
The standalone runtime is a separate Bun build because it embeds the UI and uses
the Bun PTY backend. A correct package must install both runtime shapes behind a
single CLI dispatcher instead of pretending either runtime is the whole CLI.

## Goals

1. Make a curl installation provide the complete `desk` CLI.
2. Support macOS and Linux on x64 and arm64; treat WSL as Linux.
3. Detect required host dependencies and install only missing or unsupported
   versions using the current host's supported package manager.
4. Install a versioned source tree, its locked Node dependencies, the built CLI,
   and a private Bun standalone executable.
5. Make `desk serve` deterministically select Vite and
   `desk serve --standalone` deterministically select Bun.
6. Remove the separate public standalone command and all legacy/fallback paths.
7. Keep upgrades atomic so a failed download, dependency installation, or build
   cannot replace the last working Desk installation.
8. Make the command available in the invoking shell's existing `PATH`, including
   the documented `curl ... | bash && desk serve` flow.
9. Update all user, operator, deployment, release, Docker, troubleshooting, and
   contributor documentation to match verified behavior.

## Non-goals

- Native Windows support. WSL uses the Linux path; a native Windows invocation
  fails with an explicit unsupported-platform message.
- Replacing tmux or porting Desk's Unix process model.
- Installing or authenticating optional agent CLIs, `gh`, GPU utilities, or
  other feature-specific tools without an explicit future contract.
- Making the Vite and Bun runtimes interchangeable or adding automatic fallback.
- Publishing a second user-facing server command or a compatibility alias.
- Changing the Desk HTTP API, browser UI, manifest format, or configured project
  and session behavior except where runtime startup requires it.

## User-facing command contract

| Command | Runtime | Required behavior |
| --- | --- | --- |
| `desk serve` | Node + Vite | Runs Vite from the active installed source tree with the Desk API middleware and HMR. |
| `desk serve --host H --port P` | Node + Vite | Runs the same Vite runtime with validated host and port overrides. |
| `desk serve --standalone` | Private Bun executable | Runs the embedded UI/API runtime without Vite. |
| `desk serve --standalone --host H --port P` | Private Bun executable | Runs Bun with the same validated host and port values. |
| `desk <other-command>` | Node CLI | Preserves the existing `up`, `status`, `init`, `add`, `attach`, `capture`, `hooks`, `channels`, and internal host behavior. |

`--standalone` is a boolean flag owned only by `serve`. It consumes no value.
Using it with another command, repeating it, or following it with an unexpected
positional argument is a usage error.

Host and port resolution is shared by both serve modes:

1. Explicit `--host` and `--port` flags.
2. `DESK_HOST` and `DESK_PORT` environment variables.
3. `127.0.0.1` and `5173` defaults.

The CLI validates that the host is non-empty and the port is an integer from 1
through 65535 before starting either runtime. This gives both modes one honest
configuration contract.

## Architecture

### 1. One CLI dispatcher

`src/cli/main.ts` remains the only public Desk command dispatcher. Serve parsing
must distinguish boolean flags from value flags instead of treating every
`--name` as requiring a following value.

The serve path resolves the active Desk package root and creates one of two
explicit launch plans:

- **Vite plan:** invoke the installed Vite JavaScript entry with the same Node
  executable running the CLI, set the active release as `cwd`, and pass host and
  port as Vite arguments.
- **Standalone plan:** invoke the active release's private Bun executable and
  pass the resolved host and port through `DESK_HOST` and `DESK_PORT`.

The plans share argument validation and inherited stdio but do not share runtime
discovery. A missing Vite entry is a corrupt Vite installation error. A missing
private Bun executable is a corrupt standalone installation error. In both cases
the CLI exits nonzero and tells the user to reinstall; it never starts the other
mode.

The private Bun entrypoint starts the server directly. The module that implements
argument handling for a separate standalone command is deleted because that
public contract no longer exists.

### 2. Source-backed, versioned installation

The default data prefix is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/desk/
├── releases/
│   └── <version>/
│       ├── package.json
│       ├── package-lock.json
│       ├── vite.config.ts
│       ├── src/
│       ├── public/
│       ├── node_modules/
│       ├── dist/cli/main.js
│       └── libexec/desk-standalone
├── toolchains/
│   ├── node-<pinned-version>/
│   └── bun-<pinned-version>/
└── current -> releases/<version>
```

`DESK_HOME` may override the data prefix. `DESK_BIN_DIR` may override the
launcher directory. These are the supported install-location overrides; the
installer will not maintain old server-specific variables or layouts.

The installer maintains pinned Desk-owned Node/npm and Bun toolchains under the
data prefix. It reuses an already verified matching toolchain and downloads it
only when absent. This avoids modifying or depending on the user's unrelated
global Node and Bun versions while still ensuring that every application
dependency is installed. Upstream archives are versioned and checksum-verified.

The active release keeps the source and all locked dependencies because Vite is
a runtime requirement. The install must not prune development dependencies after
`npm ci`: Vite, its React plugin, the UI compiler inputs, and related packages
are required by `desk serve`.

### 3. Host dependency provisioning

The installer first detects `uname` OS and architecture. Supported values are:

- Darwin x64 and arm64.
- Linux x64 and arm64, including WSL distributions.

The required host layer includes TLS certificates, curl, archive/checksum tools,
tmux, git, Python, make, and a C/C++ compiler for native Node dependencies.
The implementation owns a package map for each supported package-manager family:

- macOS: Homebrew, bootstrapped after Command Line Tools when absent.
- Debian/Ubuntu and common WSL distributions: `apt-get`.
- Fedora/RHEL-family distributions: `dnf`, with `yum` only where it is the host's
  available manager.
- Arch-family distributions: `pacman`.
- openSUSE-family distributions: `zypper`.
- Alpine-family distributions: `apk`, provided the pinned Node and Bun
  toolchains have compatible musl assets; otherwise the installer fails before
  activation with an accurate unsupported-libc message.

For every dependency, the installer checks command presence and any required
minimum capability before invoking the package manager. It requests elevated
permissions only for host package installation or a system launcher directory.
It never runs `npm install -g` and never replaces the user's global Node/npm/Bun.

Optional integrations remain optional and are reported after installation:
agent CLIs (`codex`, `claude`, `opencode`), `gh`, GPU telemetry commands, and
other subsystem-specific tools. Missing optional tools do not make the Desk
installation fail, and the documentation must not call them core dependencies.

### 4. Release and build flow

Tagged releases publish one versioned source archive plus a mandatory checksum
manifest. The public platform-specific standalone artifacts are removed.

The installer performs the following flow:

1. Detect and validate OS, architecture, libc where relevant, and a supported
   dependency provider.
2. Resolve the requested `DESK_VERSION` or the latest release.
3. Download the versioned source archive and checksum manifest.
4. Refuse to continue if the checksum is missing, has no matching entry, or does
   not match. Checksum verification never degrades to a warning.
5. Provision missing host packages and pinned Desk toolchains.
6. Extract into a staging directory on the same filesystem as `releases/`.
7. Run `npm ci` with the pinned Node/npm toolchain.
8. Run a distribution build that produces the private Bun executable and then
   builds the Node CLI last. The final ordering preserves the CLI after Vite's
   output cleanup.
9. Run installation smoke checks from the staged tree.
10. Rename the completed staging directory into `releases/<version>` and
    atomically update `current`.
11. Atomically install or update the single `desk` launcher.
12. Remove the obsolete standalone executable from the managed launcher
    directory after the new CLI is active.

The existing active release is untouched until all staging and smoke checks
succeed. A failure cleans only the staging directory and preserves the old
`current` link and launcher target.

The build script still uses Bun compile mode, but writes only
`libexec/desk-standalone`. Its comments and output consistently describe a
private runtime component, not a separately installable command.

### 5. Launcher and PATH behavior

The public launcher is a small POSIX script or symlink named `desk` that resolves
the active release and executes its built Node CLI with the Desk-owned Node
runtime. It does not embed a version-specific absolute release path, so atomic
upgrades take effect through `current`.

Without `DESK_BIN_DIR`, the installer chooses an existing `PATH` directory it can
write, preferring the conventional user-local directory when it is already on
`PATH`, then a conventional system directory with `sudo` when required. If no
safe directory on the current `PATH` can be used, installation fails with a
specific remedy. Merely editing a shell profile would not make
`curl ... | bash && desk serve` work in the parent shell, so the installer must
not report success for that state.

An existing launcher known to point at a Desk source checkout or managed Desk
installation can be replaced atomically. An unrelated command collision fails
closed and reports the path; the installer does not overwrite an unidentified
executable.

### 6. Removal of the former public standalone surface

The implementation removes all live surfaces belonging to the retired command:

- the server-only argument module and its focused tests;
- the public executable name from build output;
- release assets and checksums under that name;
- installer constants, install paths, warnings, and launch instructions for it;
- Docker copies and entrypoints that bypass the full CLI;
- current README, Mintlify pages, contributor docs, examples, and help text that
  instruct users to invoke it;
- compatibility aliases, PATH fallbacks, and legacy runtime dispatch.

The previous design spec is deleted because it prescribes the contract being
removed. Historical explanation belongs only in this superseding design and the
changelog; it must not remain presented as current operating guidance.

The installer may clean the obsolete executable only in Desk's managed launcher
directory and known standard locations from the affected installer. It does not
scan or delete arbitrary files elsewhere on `PATH`. Cleanup is installer
migration work, never a CLI runtime fallback.

### 7. Docker contract

The Docker image must obey the same public command contract. Its runtime stage
contains the built full CLI, the source/dependencies required by Vite, Node, and
the private Bun executable. The image entrypoint starts:

```bash
desk serve --standalone
```

The private Bun executable remains useful in the image, but it is not copied to
a public bin directory and is not the image's documented entrypoint. This avoids
creating a second incompatible meaning for `desk` inside containers.

## Error handling

- Unsupported OS, architecture, libc, or dependency manager fails before any
  active installation is changed.
- A refused or unavailable privilege escalation names the missing packages and
  leaves the current release active.
- Release resolution, downloads, and checksums are fail-closed.
- `npm ci`, either build, or any smoke failure leaves the previous release active.
- A launcher collision with an unidentified executable is never overwritten.
- Invalid serve arguments fail before spawning Vite or Bun.
- Missing Vite files fail as a Vite installation error with no Bun fallback.
- Missing private Bun files fail as a standalone installation error with no Vite
  fallback.
- Child exit status and signals propagate through the CLI so startup failures,
  occupied ports, and Ctrl-C remain observable.
- Host resource failures such as `EMFILE` remain runtime errors; troubleshooting
  documentation explains diagnosis and OS-level remediation without hiding them
  behind another server mode.

## Documentation contract

Documentation changes ship in the same refactor and are verified against the
implemented behavior. At minimum, update or remove:

- `README.md`: one-line install, supported platforms, dependency behavior, both
  serve modes, CLI reference, and source contributor setup.
- `docs/getting-started.md`: empty-machine install through the full CLI and a
  first launch with `desk serve`.
- `docs/distribution-deployment.md`: versioned source-backed layout, Vite default,
  private standalone mode, releases, upgrades, uninstall, and Docker behavior.
- `docs/guide-deploy-securely.md`: correct commands for both modes while retaining
  the localhost/no-authentication warning.
- `docs/index.md`: homepage quickstart and runtime summary.
- `docs/troubleshooting.md`: command resolution, dependency provisioning,
  incomplete installs, missing Vite/private runtime, ports, file-watcher limits,
  clean reinstall, and legacy executable cleanup.
- `docs/operations.md`, `docs/concepts-architecture.md`, and
  `docs/security-plugin-model.md`: commands and runtime terminology where the
  selected mode matters.
- `CONTRIBUTING.md`: local Node 22.23.1 parity, build ordering, private standalone
  build, and complete verification commands.
- `CHANGELOG.md` and `docs/release-notes.md`: the final command and installer
  behavior, without presenting the superseded split-command repair as current.
- `install.sh`, CLI help, Docker comments, and release workflow comments: these
  are user-visible operational documentation and must be equally accurate.

The docs must clearly distinguish:

- required dependencies the installer owns;
- optional integrations the user installs/authenticates separately;
- installed-user workflow versus contributor source-checkout workflow;
- Vite runtime versus Bun standalone runtime;
- Linux/WSL support versus unsupported native Windows;
- upgrade, reinstall, and uninstall behavior.

No current guide may claim that curl installs only a server, that the full CLI
requires a separate checkout, or that the default serve command uses embedded
assets. A focused documentation audit is required after edits, but search-based
checks supplement rather than replace real runtime verification.

## Test strategy

Implementation follows red-green-refactor and uses generic temporary paths and
artifacts. Tests must not hardcode a developer username, checkout, company-local
path, or unrelated internal artifact.

### CLI behavior

- Parser tests prove `--standalone` is boolean, remains serve-only, and composes
  correctly with host and port flags in either order.
- Invalid flags, duplicate flags, missing values, extra positional arguments,
  and invalid ports fail before any child process starts.
- Launch-plan tests prove Vite and Bun resolve distinct required artifacts and
  that neither missing-artifact path selects the other runtime.
- Existing non-serve commands remain covered through the real CLI dispatcher.

### Runtime integration

- Start `desk serve` on an ephemeral port, fetch the root and `/@vite/client`,
  and prove both return successfully before terminating the process.
- Build the real private Bun executable, start
  `desk serve --standalone` on another ephemeral port, fetch the root, and prove
  the application loads without a Vite client route.
- Remove or relocate each required runtime artifact in an isolated staged
  installation and prove the requested mode fails without binding a listener or
  starting the other mode.
- Run both smoke paths under Node 22.23.1, matching CI.

### Installer and release integration

- Build a real versioned source archive and checksum manifest into a temporary
  release endpoint, then run the installer with temporary `HOME`, `DESK_HOME`,
  and `DESK_BIN_DIR` values.
- Prove the installed `desk help`, `desk serve`, and
  `desk serve --standalone` paths execute from outside the source checkout.
- Prove checksum absence and mismatch fail without changing `current`.
- Prove an injected build failure preserves the previous active release.
- Prove a recognized Desk launcher upgrades atomically and an unrelated command
  collision is not overwritten.
- Exercise dependency detection and installation in disposable Linux images for
  supported package-manager families. Exercise the macOS path on a macOS CI
  runner without relying on a developer's preconfigured machine.
- Prove the retired public executable is neither published nor installed.

### Repository verification

- `npm run check` under Node 22.23.1.
- Full Vitest suite under Node 22.23.1.
- UI build followed by the full Node build, respecting repository build-order
  rules.
- Real private standalone compilation and HTTP smoke test.
- Release archive creation and installer round trip.
- Docker build, health check, and command inspection.
- Mintlify/docs build and link validation.
- Focused audit of current docs, scripts, workflow, Dockerfile, help output, and
  tests for contradictory command names or runtime claims.

## Acceptance criteria

- On a supported clean macOS or Linux/WSL host, the documented curl command
  installs all required dependencies and a working full `desk` CLI.
- The command is resolvable immediately from the invoking shell's existing
  `PATH`; `curl ... | bash && desk serve` is a valid documented flow.
- `desk serve` starts the Vite runtime from the installed source tree.
- `desk serve --standalone` starts only the private Bun runtime.
- Host and port flags/environment behave identically in both modes.
- Neither runtime ever falls back to the other.
- No public standalone executable, compatibility alias, release asset, Docker
  entrypoint, or current documentation path remains.
- A failed upgrade leaves the previous installation usable.
- Installer checksums are mandatory and verified.
- Native Windows is rejected clearly; WSL follows the Linux installer path.
- Required and optional dependencies are documented accurately.
- Install, upgrade, uninstall, contributor, Docker, security, and troubleshooting
  documentation matches verified behavior.
- Tests use portable temporary fixtures and real behavior paths rather than
  developer-specific or organization-internal artifacts.
- Type checking, the full suite, both runtime smokes, installer round trip,
  release build, Docker check, and documentation validation pass in their stated
  environments.
