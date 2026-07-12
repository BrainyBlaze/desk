# Desk CLI installation and serve contract

**Status:** Implemented in Desk 0.3.0

**Date:** 2026-07-12

**Supersedes:** `docs/standalone-command-contract-spec.md`

## Summary

Desk exposes one user-facing command: `desk`. The curl installer installs
the complete source-backed CLI on supported macOS and Linux hosts, including WSL,
and provisions every missing required dependency. Native Windows is not
supported.

The serve contract is explicit:

- `desk serve` starts the private Bun-compiled standalone runtime.
- `desk serve --dev` starts the Node/Vite development runtime.
- Neither mode falls back to the other.
- The former public `desk-server` executable and every release, installer, code,
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

The underlying packaging constraint is that the development runtime is genuinely
a Vite source runtime. It requires the Desk source tree and its Node dependencies.
The default standalone runtime is a separate Bun build because it embeds the UI
and uses the Bun PTY backend. A correct package must install both runtime shapes
behind a single CLI dispatcher instead of pretending either runtime is the whole
CLI.

## Goals

1. Make a curl installation provide the complete `desk` CLI.
2. Support macOS and Linux on x64 and arm64; treat WSL as Linux.
3. Detect required host dependencies and install only missing or unsupported
   versions using the current host's supported package manager.
4. Install a versioned source tree, its locked Node dependencies, the built CLI,
   and a private Bun standalone executable.
5. Make `desk serve` deterministically select Bun and
   `desk serve --dev` deterministically select Vite.
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
| `desk serve` | Private Bun executable | Runs the embedded UI/API runtime without Vite. |
| `desk serve --host H --port P` | Private Bun executable | Runs Bun with validated host and port overrides. |
| `desk serve --dev` | Node + Vite | Runs Vite from the active installed source tree with the Desk API middleware and HMR. |
| `desk serve --dev --host H --port P` | Node + Vite | Runs Vite with the same validated host and port values. |
| `desk <other-command>` | Node CLI | Preserves the existing `up`, `status`, `init`, `add`, `attach`, `capture`, `hooks`, `channels`, and internal host behavior. |

`--dev` is a boolean flag owned only by `serve`. It consumes no value. Using it
with another command, repeating it, or following it with an unexpected positional
argument is a usage error. The retired `--standalone` flag is rejected rather
than retained as an alias.

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
  executable running the CLI, set the active release as `cwd`, and pass host,
  port, and Vite strict-port arguments. An occupied requested port is an error;
  Vite must not silently select another port.
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
│       └── <install-id>/
│           ├── .desk-release
│           ├── package.json
│           ├── package-lock.json
│           ├── vite.config.ts
│           ├── src/
│           ├── public/
│           ├── node_modules/
│           ├── runtime/node -> ../../../../toolchains/node-<version>/bin/node
│           ├── dist/cli/main.js
│           └── libexec/desk-standalone
├── toolchains/
│   ├── node-<pinned-version>/
│   └── bun-<pinned-version>/
└── current -> releases/<version>/<install-id>
```

`DESK_HOME` may override the data prefix. `DESK_BIN_DIR` may override the
launcher directory. These are the supported install-location overrides; the
installer does not maintain old server-specific variables or layouts.

The installer maintains pinned Desk-owned Node/npm and Bun toolchains under the
data prefix. It reuses an already verified matching toolchain and downloads it
only when absent. This avoids modifying or depending on the user's unrelated
global Node and Bun versions while still ensuring that every application
dependency is installed. Upstream archives are versioned and checksum-verified.

Each immutable release instance contains a validated `.desk-release` ownership
manifest and a release-local `runtime/node` link to the exact pinned Node runtime
used to build it. The public launcher resolves `current` to one physical release
directory once, verifies that directory remains under `DESK_HOME/releases`, and
executes that release's `runtime/node` and `dist/cli/main.js`. It never chooses a
toolchain independently of the active release, so a Node-pin-changing upgrade
cannot pair a new CLI with an old runtime.

The active release keeps the source and all locked dependencies because Vite is
a runtime requirement. The install must not prune development dependencies after
`npm ci`: Vite, its React plugin, the UI compiler inputs, and related packages
are required by `desk serve`.

### 3. Host dependency provisioning

The advertised one-liner necessarily assumes a working `curl` with usable TLS
trust because that command downloads the installer itself. That is the sole
bootstrap prerequisite and is stated explicitly in the quickstart. Once the
script is running, it provisions and re-probes the bootstrap host capabilities
(CA trust, archive extraction, and SHA-256) before downloading the Desk release
metadata. Release-declared Node and Bun assets are downloaded, verified,
promoted, and probed only after that metadata is resolved.

The installer first detects `uname` OS and architecture. Supported values are:

- Darwin x64 and arm64.
- Linux x64 and arm64, including WSL distributions.

The required host layer includes TLS certificates, archive/checksum tools, tmux,
git, Python, make, and a C/C++ compiler for native Node dependencies. Detection
is capability-based and every package-manager action is followed by the same
probe that triggered it:

| Capability | Required probe/capability |
| --- | --- |
| TLS download | The already-running `curl` can fetch HTTPS using host trust; installed CA certificates are re-probed before later downloads. |
| Archive extraction | `tar` can list and extract gzip-compressed archives into an explicit directory. |
| SHA-256 | Either `sha256sum` or `shasum -a 256` produces a valid digest. |
| tmux | `tmux -V` succeeds and reports version 3.2 or newer. |
| Git | `git --version` succeeds with Git 2.30 or newer. |
| Native build | Python 3.8 or newer, `make`, and a C++ compiler can build a trivial native program. |
| Node/npm | The Desk-owned Node version declared by the release (CI baseline 22.23.1) and its bundled npm pass exact version checks. |
| Bun | The Desk-owned Bun version declared by the release passes an exact version check and can compile a trivial executable. |

The implementation owns this minimum package map:

| Host family | Packages/capabilities installed when missing |
| --- | --- |
| macOS | Command Line Tools, then Homebrew; `tmux`, Git, Python, and required archive/checksum utilities are installed or upgraded through the detected Brew prefix. |
| Debian/Ubuntu/WSL (`apt-get`) | `ca-certificates curl tar gzip coreutils tmux git python3 make g++` |
| Fedora/RHEL (`dnf` or host-provided `yum`) | `ca-certificates curl tar gzip coreutils tmux git python3 make gcc-c++` |
| Arch (`pacman`) | `ca-certificates curl tar gzip coreutils tmux git python make gcc` |
| openSUSE (`zypper`) | `ca-certificates curl tar gzip coreutils tmux git python3 make gcc gcc-c++` |
| Alpine (`apk`) | `ca-certificates curl tar gzip coreutils tmux git python3 make build-base`, only with compatible musl toolchain assets |

Package names are implemented in one installer dependency table rather than
duplicated branches. If a distribution changes a package name or the post-install
probe still fails, the installer reports the exact unsatisfied capability and
does not activate Desk.

The supported package-manager families are:

- macOS: Homebrew, bootstrapped after Command Line Tools when absent. The
  installer locates a newly installed Brew via `brew --prefix` or the canonical
  `/opt/homebrew` arm64 and `/usr/local` x64 bootstrap locations, evaluates its
  `shellenv` for the installer process, and re-probes it instead of assuming the
  parent shell has reloaded. If Command Line Tools requires interactive system
  confirmation, the installer waits for `xcode-select -p` to succeed or exits
  with the exact unfinished step.
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

Tagged releases publish one versioned source archive, a machine-readable install
manifest, and a mandatory checksum manifest. The validated install manifest
declares the source asset plus the exact Node and Bun versions and platform asset
names for each supported OS, architecture, and libc. The public
platform-specific standalone artifacts are removed.

The installer performs the following flow:

1. Detect and validate OS, architecture, libc where relevant, and a supported
   dependency provider.
2. Acquire an installation lock at the canonical sibling path
   `${DESK_HOME}.install-lock`, before creating or modifying `DESK_HOME`.
3. Provision and re-probe CA trust, archive extraction, and checksum capability.
4. Provision and re-probe the remaining host packages.
5. Resolve the requested release tag. `DESK_VERSION` must match the canonical
   version grammar `v<major>.<minor>.<patch>` with an optional ASCII prerelease;
   slashes, traversal, whitespace, control characters, leading options, and
   other URL/path syntax are rejected before network or filesystem use.
6. Download and schema-validate the release's install and checksum manifests,
   then download the declared source, Node, and Bun assets into uniquely named
   temporary files. Asset names may contain only the canonical version, target,
   and archive character set; URLs are constructed from the validated tag and
   names rather than accepted from arbitrary manifest URLs.
7. Refuse to continue if any asset or checksum is missing, has no matching entry,
   or does not match. Checksum verification never degrades to a warning. Promote
   a toolchain into `toolchains/` only after its own verification and smoke probe.
8. Preflight the archive table before extraction. Reject absolute paths, `..`
   components, device entries, and any symlink or hardlink whose resolved target
   can escape the empty staging root. Extract with ownership/permission
   sanitization, then verify every extracted path remains inside staging.
9. Extract into a unique staging directory on the same filesystem as
   `releases/`, create the ownership manifest and release-local Node binding, and
   run `npm ci` with the pinned Node/npm toolchain.
10. Run a distribution build that produces the private Bun executable and then
    builds the Node CLI last. The final ordering preserves the CLI after Vite's
    output cleanup.
11. Run installation smoke checks from the staged tree, including launcher
    resolution with the release-bound Node runtime.
12. Rename the completed staging directory into a new immutable
    `releases/<version>/<install-id>` instance.
13. Preflight the version-independent public launcher, its destination, and the
    exact rollback operations before changing active state.
14. Activate the release and launcher as one recoverable transaction, then run a
    post-activation `desk help` smoke. Any failure restores the previous
    `current` target and launcher bytes; first-install failure removes the partial
    launcher and leaves no active release.
15. Remove the obsolete `desk-server` executable only when Desk ownership is
    proven, then prune release instances according to the retention rules.

The existing active release is untouched until all staging and smoke checks
succeed. A failure cleans only owned temporary paths and preserves the old
`current` link and launcher target. The installer never reuses a staging name.

The lock is acquired by atomically creating the canonical sibling directory
`${DESK_HOME}.install-lock`; it is never nested inside the install root. It
records PID, host, start time, installer version, and a random ownership token. A
live owner makes a second installer fail immediately. A lock is stale only when
it belongs to the same host, its process is absent, and its age exceeds ten
minutes; otherwise manual inspection is required. Signal/exit traps release only
a lock whose ownership token matches the current installer. During uninstall,
the sibling lock remains held until the install root has been fully removed; the
lock is the final path removed, so another installer cannot enter the deletion
window. Package-manager-native locks are still honored separately.

The build script still uses Bun compile mode, but writes only
`libexec/desk-standalone`. Its comments and output consistently describe a
private runtime component, not a separately installable command.

### 5. Install, upgrade, reinstall, downgrade, and uninstall states

Release instances are immutable and uniquely identified, even when two installs
use the same Desk version. State transitions are normative:

- **First install:** build and verify a new instance, create the stable launcher,
  then activate it transactionally. Failure leaves neither an active instance
  nor a launcher that claims success.
- **Upgrade or explicit downgrade:** build a new instance, retain the active
  instance as the rollback candidate, then swap `current`. `DESK_VERSION`
  explicitly permits a lower valid version; the installer never silently
  downgrades latest resolution.
- **Same-version reinstall:** build a new install-id rather than mutating the
  active directory. This repairs missing dependencies or corrupt files through
  the same activation and rollback path as an upgrade.
- **Clean reinstall:** uninstall the managed application while retaining user
  data, then run a normal first install.
- **Retention:** after a successful post-activation smoke, retain the current and
  immediately previous valid release instances and every toolchain they
  reference. Remove older owned instances and unreferenced toolchains. Failed
  staging paths are removed by the owning installer.
- **Uninstall:**
  `curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash -s -- --uninstall`
  acquires the same lock, verifies the
  launcher's Desk ownership and resolved `DESK_HOME`, removes the managed
  launcher, releases, toolchains, current link, and install metadata, and then
  removes the empty install root. It preserves `~/.config/desk`, project files,
  tmux sessions, agent credentials, and all optional host tools. Documentation
  gives a separate explicit command for users who intentionally want to purge
  Desk configuration after inspecting it.

Uninstall refuses to delete an unidentified launcher, a release without a valid
Desk ownership manifest, or a path that escapes the canonical install root. It
reports remaining owned paths rather than broadening deletion.

### 6. Launcher and PATH behavior

The public launcher is a small POSIX script named `desk` that resolves the active
release once and executes its built Node CLI with the release-bound Desk Node
runtime. It does not embed a version-specific release instance, so atomic
upgrades take effect through `current`.

The installer inspects `PATH` in command-resolution order before choosing a
destination. Empty entries, `.`, relative paths, directories outside their
canonical path, and group/world-writable directories not protected and owned as
expected are never installation targets. Symlinked directories are canonicalized
before ownership and permission checks.

Selection is fail-closed:

1. If the effective `desk` executable already resolves to a recognized Desk
   source link or managed launcher, update that location atomically after
   checking every earlier executable candidate through the shell-independent
   PATH scan.
2. If any earlier `desk` candidate is unidentified, stop and report every
   conflicting path. Installing later on `PATH` is forbidden because it would
   reproduce the original shadowing failure.
3. If no command exists, choose the first safe writable PATH directory; otherwise
   choose a safe conventional system directory already present on PATH and use
   `sudo` only for its final launcher operation.
4. If no effective safe destination exists, fail with a specific remedy. Merely
   editing a shell profile would not make `curl ... | bash && desk serve` work in
   the parent shell, so that state is never reported as success.

`DESK_BIN_DIR` must be an absolute canonical directory already present on the
invoking `PATH`, and no earlier unidentified `desk` candidate may shadow it. An
explicit override outside PATH is rejected rather than exempted from the
immediate-resolution contract.

An existing launcher known to point at a Desk source checkout or managed Desk
installation can be replaced atomically. An unrelated command collision fails
closed and reports the path; the installer does not overwrite an unidentified
executable.

### 7. Removal of `desk-server`

The implementation removes all live surfaces belonging to the retired
`desk-server` command:

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

The installer may clean `desk-server` only in Desk's managed launcher directory
and known standard locations from the affected installer, and only when a
published legacy checksum, a managed symlink target, or another deterministic
Desk ownership marker matches. An unidentified file is reported with an explicit
manual inspection command and is never deleted. Cleanup is installer migration
work, never a CLI runtime fallback.

Negative audits require the exact `desk-server` token to be absent from current
release asset names, checksum entries, install paths, PATH launchers, Docker
entrypoints, help output, and current operating documentation. Historical
explanation and ownership-migration fixtures are limited to this superseding
spec, the changelog, and focused installer tests; they cannot expose a live
command or compatibility path.

### 8. Docker contract

The Docker image must obey the same public command contract. Its runtime stage
contains the built full CLI, the source/dependencies required by Vite, Node, and
the private Bun executable. It uses this exec-form contract:

```dockerfile
ENTRYPOINT ["desk"]
CMD ["serve", "--host", "0.0.0.0", "--port", "5173"]
```

Arguments supplied to `docker run` replace `CMD`, so `docker run IMAGE status`,
`docker run IMAGE serve --host 0.0.0.0`, and
`docker run IMAGE serve --dev --host 0.0.0.0` all go through the same full CLI.
The container-only `0.0.0.0` default makes the published port reachable;
host installs retain the secure `127.0.0.1` default. Documentation must state
that publishing this unauthenticated port is safe only on a trusted local bind or
behind an authenticated tunnel/proxy.

The private Bun executable remains useful in the image, but it is not copied to
a public bin directory and is not the image's documented entrypoint. This avoids
creating a second incompatible meaning for `desk` inside containers.

## Error handling

- Unsupported OS, architecture, libc, or dependency manager fails before any
  active installation is changed.
- A refused or unavailable privilege escalation names the missing packages and
  leaves the current release active.
- Release resolution, downloads, and checksums are fail-closed.
- Version strings and archive entries are validated before they become URL or
  filesystem inputs; extraction cannot escape its unique staging root.
- `npm ci`, either build, or any smoke failure leaves the previous release active.
- A concurrent installer cannot enter staging or activation while the owned
  install lock is live.
- A launcher collision with an unidentified executable is never overwritten.
- Invalid serve arguments fail before spawning Vite or Bun.
- Missing Vite files fail as a Vite installation error with no Bun fallback.
- Missing private Bun files fail as a standalone installation error with no Vite
  fallback.
- An occupied requested port fails in both modes; Vite strict-port mode prevents
  automatic port reassignment.
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
- `docs/distribution-deployment.md`: versioned source-backed layout, standalone
  default, opt-in Vite development mode, releases, upgrade/downgrade/reinstall retention,
  ownership-safe uninstall, and Docker behavior.
- `docs/guide-deploy-securely.md`: correct commands for both modes while retaining
  the localhost/no-authentication warning.
- `docs/index.md`: homepage quickstart and runtime summary.
- `docs/troubleshooting.md`: command resolution, dependency provisioning,
  incomplete installs, missing Vite/private runtime, ports, file-watcher limits,
  clean reinstall, and safe handling of unidentified command collisions reported
  by the installer.
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

- Parser tests prove `--dev` is boolean, remains serve-only, and composes
  correctly with host and port flags in either order.
- Invalid flags, duplicate flags, missing values, extra positional arguments,
  and invalid ports fail before any child process starts.
- Launch-plan tests prove Vite and Bun resolve distinct required artifacts and
  that neither missing-artifact path selects the other runtime.
- Existing non-serve commands remain covered through the real CLI dispatcher.

### Runtime integration

- Build the real private Bun executable, start `desk serve` on an ephemeral port,
  fetch the root, and prove the application loads without a Vite client route.
- Start `desk serve --dev` on another ephemeral port, fetch the root and
  `/@vite/client`, and prove both return successfully before terminating the
  process.
- Pre-bind the requested port and prove both Vite and Bun fail without selecting
  another port.
- Remove or relocate each required runtime artifact in an isolated staged
  installation and prove the requested mode fails without binding a listener or
  starting the other mode.
- Prove child nonzero exits and signal termination are returned by the CLI,
  Ctrl-C reaches the active child, and neither mode leaves an orphan process.
- Run both smoke paths under Node 22.23.1, matching CI.

### Installer and release integration

- Build a real versioned source archive and checksum manifest into a temporary
  release endpoint, then run the installer with temporary `HOME`, `DESK_HOME`,
  and `DESK_BIN_DIR` values.
- Prove the installed `desk help`, `desk serve`, and `desk serve --dev` paths
  execute from outside the source checkout.
- Prove source, Node, and Bun checksum absence, mismatch, wrong-platform assets,
  and interrupted downloads fail without changing `current` or promoting a
  partial toolchain.
- Prove a real failed build and real filesystem failures at launcher/activation
  boundaries preserve the previous active release without production-only test
  hooks.
- Prove a recognized Desk launcher upgrades atomically and an unrelated command
  collision is not overwritten.
- Exercise first install, upgrade, explicit downgrade, same-version reinstall,
  clean reinstall, retention pruning, uninstall with retained user data, and
  refusal to uninstall unidentified paths.
- Run concurrent same-version and different-version installers and prove the
  lock permits only one owner, including stale-lock recovery cases.
- Race uninstall against a new install and prove the sibling lock excludes the
  new installer until the old install root is completely removed.
- Exercise earlier and later PATH collisions, unsafe PATH entries, invalid
  `DESK_BIN_DIR` values, and the literal
  `curl ... | bash && desk serve` executable-resolution flow.
- Reject adversarial versions and archives containing traversal, absolute paths,
  escaping links, devices, or unsafe permissions.
- Exercise dependency detection and installation in disposable Linux images for
  supported package-manager families. Exercise the macOS path on a macOS CI
  runner without relying on a developer's preconfigured machine. Minimal-image
  cases remove one bootstrap capability at a time and verify provisioning order
  and the post-install probes.
- Prove `desk-server` is neither published nor installed and an unidentified
  same-named file is not deleted.

### Repository verification

- `npm run check` under Node 22.23.1.
- Full Vitest suite under Node 22.23.1.
- UI build followed by the full Node build, respecting repository build-order
  rules.
- Real private standalone compilation and HTTP smoke test.
- Release archive creation and installer round trip.
- Docker build, host-to-container health check, exact entrypoint/CMD inspection,
  and explicit Vite, standalone, and non-serve CLI invocations.
- Mintlify/docs build and link validation.
- Focused audit of current docs, scripts, workflow, Dockerfile, help output, and
  tests for contradictory command names or runtime claims.

## Acceptance criteria

- On a supported clean macOS or Linux/WSL host, the documented curl command
  installs all required dependencies and a working full `desk` CLI.
- The command is resolvable immediately from the invoking shell's existing
  `PATH`; `curl ... | bash && desk serve` is a valid documented flow.
- `desk serve` starts only the private Bun runtime.
- `desk serve --dev` starts the Vite runtime from the installed source tree.
- Host and port flags/environment behave identically in both modes.
- An occupied requested port fails in both modes.
- Neither runtime ever falls back to the other.
- No public `desk-server` executable, compatibility alias, release asset,
  checksum entry, Docker entrypoint, help path, or current operating-guide path
  remains.
- A failed upgrade leaves the previous installation usable.
- First install, upgrade, explicit downgrade, same-version reinstall, clean
  reinstall, rollback retention, and ownership-safe uninstall follow the defined
  state transitions.
- Concurrent installers serialize through the owned install lock.
- Source and toolchain checksums are mandatory and verified.
- Native Windows is rejected clearly; WSL follows the Linux installer path.
- Required and optional dependencies are documented accurately.
- Install, upgrade, uninstall, contributor, Docker, security, and troubleshooting
  documentation matches verified behavior.
- Tests use portable temporary fixtures and real behavior paths rather than
  developer-specific or organization-internal artifacts.
- Type checking, the full suite, both runtime smokes, installer round trip,
  release build, Docker check, and documentation validation pass in their stated
  environments.
