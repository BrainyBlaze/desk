# Desk CLI Installer and Serve Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS/Linux curl installer provide the complete `desk` CLI, make `desk serve` run only the private Bun runtime and `desk serve --dev` run Vite, and remove the public `desk-server` contract everywhere.

**Architecture:** Keep `src/cli/main.ts` as the only public dispatcher and move serve parsing/path planning into a focused CLI module. Tagged releases publish a source archive plus validated install/checksum metadata; `install.sh` provisions host dependencies and Desk-owned Node/Bun toolchains, builds into immutable release instances, then activates a stable launcher transactionally. Vite and Bun remain distinct, explicitly selected runtimes with no fallback.

**Tech Stack:** TypeScript/Node 22.23.1, Vite 7, Bun 1.3.14 compile mode, Bash, Vitest, GitHub Actions, Docker, Mintlify/MkDocs.

**Design spec:** `docs/desk-cli-install-and-serve-contract-spec.md`

**Worktree:** `/home/dev/projects/desk/.worktrees/desk-cli-installer-serve` on `refactor/desk-cli-installer-serve`

---

## Preconditions and file map

The baseline is clean under the repository's exact CI runtime:

```bash
. "$HOME/.nvm/nvm.sh"
nvm use 22.23.1
npm ci
npm run check
TMPDIR="$(mktemp -d /var/tmp/desk-vitest.XXXXXX)" npx vitest run
```

Baseline result: 199 test files passed, 3 skipped; 2,124 tests passed, 6 skipped. The neutral `TMPDIR` is required on this host because `/tmp/.git` and `/home/dev/.git` make `tests/fs-root.test.ts` correctly detect an ancestor Git root.

### New files

- `src/cli/serveCommand.ts` — parse and validate serve-only options; resolve Vite/private-Bun artifacts; construct and execute one explicit launch plan.
- `tests/serve-command.test.ts` — pure command parsing, environment precedence, path, no-fallback, and exit-status coverage.
- `tests/serve-runtime.integration.test.ts` — real Vite startup, strict-port, HTTP, and shutdown coverage.
- `scripts/distribution/toolchains.json` — pinned Node/Bun versions, canonical target asset names, and upstream SHA-256 values.
- `scripts/create-release-assets.mjs` — create the tagged source archive, install manifest, and `SHA256SUMS` deterministically.
- `tests/release-assets.test.ts` — release metadata/schema, safe archive, version validation, and checksum behavior.
- `tests/docker-contract.test.ts` — Dockerfile entrypoint/default command/private-runtime contract before image smoke.
- `tests/helpers/installerFixture.ts` — generic temporary release/toolchain/source fixtures and subprocess helpers; no developer-, company-, or checkout-specific paths.
- `scripts/smoke-serve-modes.mjs` — start the built CLI in each real serve mode, probe HTTP/Vite identity, and terminate without orphans.
- `.github/workflows/installer.yml` — disposable Linux dependency/install matrix and macOS installer smoke coverage.

### Modified files

- `src/cli/main.ts` — delegate `serve` to the new module and publish the exact help contract.
- `src/server/standalone-entry.ts` — private build entry that starts the embedded server directly.
- `scripts/build-standalone.ts` — emit only `libexec/desk-standalone`.
- `package.json`, `package-lock.json` — Node contract, distribution/release/smoke scripts, and v0.3.0 release version.
- `.gitignore`, `.dockerignore` — ignore the new private build output and remove the retired artifact rule.
- `install.sh` — complete platform/dependency/download/build/activation/uninstall implementation.
- `.github/workflows/ci.yml` — exact Node/Bun build and real serve smoke.
- `.github/workflows/release.yml` — source/install metadata release instead of public standalone binaries.
- `Dockerfile` — full CLI image with private Bun runtime and `ENTRYPOINT ["desk"]`.
- `tests/install-script.test.ts` — real shell behavior against generic local release fixtures.
- `tests/standalone-build-contract.test.ts` — private output/entry dependency contract.
- `tests/server-architecture.test.ts` — live legacy-path absence as supplemental architecture enforcement.
- `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/index.md`, `docs/getting-started.md`, `docs/distribution-deployment.md`, `docs/guide-deploy-securely.md`, `docs/troubleshooting.md`, `docs/operations.md`, `docs/concepts-architecture.md`, `docs/security-plugin-model.md`, `docs/release-notes.md`, `docs/native-ui-mode-spec.md` — truthful install/runtime/dependency/upgrade/uninstall/deployment guidance.
- Comments in `src/server/agentHostToken.ts`, `src/server/agents/host/cli.ts`, `src/server/agents/drivers/driver.ts`, and `src/web/httpJson.ts` — replace the retired executable term with “Desk server” where it describes the service.

### Deleted files

- `src/server/standaloneCommand.ts`
- `tests/standalone-command.test.ts`
- `docs/standalone-command-contract-spec.md`

## Task 1: Introduce a typed serve-command boundary

**Files:**
- Create: `src/cli/serveCommand.ts`
- Create: `tests/serve-command.test.ts`
- Modify: `src/cli/main.ts:1-105,153-220`

- [ ] **Step 1: Write failing serve-option tests**

Cover default standalone mode, boolean `--dev`, flag order, flag-over-environment precedence, environment defaults, empty host, nonnumeric/out-of-range port, duplicate flags, missing values, unknown flags, the retired `--standalone` flag, and unexpected positional arguments.

```ts
expect(parseServeOptions([], {})).toEqual({
  mode: 'standalone',
  host: '127.0.0.1',
  port: 5173
});
expect(parseServeOptions(['--dev', '--port', '6000'], {})).toEqual({
  mode: 'vite',
  host: '127.0.0.1',
  port: 6000
});
expect(() => parseServeOptions(['--dev', 'true'], {})).toThrow('unexpected argument true');
expect(() => parseServeOptions(['--standalone'], {})).toThrow('unknown option --standalone');
expect(() => parseServeOptions(['--port', '5173', '--port', '5174'], {})).toThrow(
  '--port may be specified only once'
);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/serve-command.test.ts
```

Expected: FAIL because `src/cli/serveCommand.ts` does not exist.

- [ ] **Step 3: Implement the minimal parser**

Create these public types/functions:

```ts
export type ServeMode = 'vite' | 'standalone';

export interface ServeOptions {
  mode: ServeMode;
  host: string;
  port: number;
}

export interface ServeEnvironment {
  DESK_HOST?: string;
  DESK_PORT?: string;
}

export function parseServeOptions(
  argv: readonly string[],
  env: ServeEnvironment = process.env
): ServeOptions;
```

Use one cursor loop and a `Set` for duplicate detection. Only `--dev` is boolean; `--host` and `--port` consume exactly one value. Validate before returning.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npx vitest run tests/serve-command.test.ts`

Expected: all parser tests PASS.

- [ ] **Step 5: Write failing launch-plan tests**

Use a generic `mkdtempSync` package tree. Prove the Vite plan selects `node_modules/vite/bin/vite.js`, the standalone plan selects `libexec/desk-standalone`, Vite includes `--strictPort`, and each missing artifact throws a mode-specific reinstall error without considering the other artifact.

```ts
expect(createServeLaunch(root, viteOptions, '/runtime/node')).toMatchObject({
  command: '/runtime/node',
  args: [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  cwd: root
});
```

- [ ] **Step 6: Run launch-plan tests and confirm RED**

Run: `npx vitest run tests/serve-command.test.ts`

Expected: FAIL because the launch-plan functions do not exist.

- [ ] **Step 7: Implement package-root and launch-plan functions**

Add:

```ts
export interface ServeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}

export function findPackageRoot(fromUrl: string): string;
export function createServeLaunch(
  root: string,
  options: ServeOptions,
  nodeExecutable?: string,
  parentEnv?: NodeJS.ProcessEnv
): ServeLaunch;
```

Resolve one artifact per mode. Do not probe or mention the other mode in an error path.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/serve-command.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 9: Commit the typed boundary**

```bash
git add src/cli/serveCommand.ts tests/serve-command.test.ts
git commit -m "refactor: isolate desk serve command planning"
```

## Task 2: Route the public CLI through the explicit serve plan

**Files:**
- Modify: `src/cli/main.ts:1-105,153-220`
- Modify: `tests/serve-command.test.ts`
- Create: `tests/serve-runtime.integration.test.ts`

- [ ] **Step 1: Write failing CLI-dispatch and supervised-child tests**

Spawn `npx tsx src/cli/main.ts` and prove `serve --dev true`, `serve
--port`, `serve --standalone`, and `status --dev` fail before opening a port. Assert `desk help`
documents both serve forms and no second public server command.

In `tests/serve-runtime.integration.test.ts`, start the current CLI with a real
Vite child, then send SIGINT and SIGTERM only to the CLI PID—not its process
group. Assert the runtime child also exits and the port closes. Add a controlled
child that exits nonzero and assert exact status propagation. Pre-bind a port and
assert Vite fails rather than selecting another one.

- [ ] **Step 2: Run both focused tests and confirm RED**

Run:

```bash
npx vitest run tests/serve-command.test.ts tests/serve-runtime.integration.test.ts
```

Expected: current generic parser mishandles the boolean flag/help and the
`spawnSync` implementation cannot satisfy CLI-PID-only signal supervision.

- [ ] **Step 3: Replace the old `serve` implementation with async supervision**

In `src/cli/main.ts`:

- remove local `findPackageRoot` and `serve`;
- detect `serve` before the manifest-dependent general command path;
- call `parseServeOptions`, `findPackageRoot(import.meta.url)`, `createServeLaunch`, and `runServeLaunch`;
- keep every non-serve command on the existing parser;
- reject `--dev` outside `serve` and reject retired `--standalone` everywhere as unknown options/arguments;
- update `HELP` to show both exact commands and host/port environment precedence.

`runServeLaunch` uses asynchronous `spawn` with inherited stdio. It registers
temporary SIGINT/SIGTERM handlers that forward the signal to the runtime child,
waits for the child's `close`, removes every handler, and resolves with the
child's exit code or the conventional signal code (`SIGINT` → 130, `SIGTERM` →
143). Spawn errors reject. Convert `main` to `async` and await it from the existing
top-level dispatcher so no path treats `status === null` as success.

- [ ] **Step 4: Run dispatch, signal, and real Vite tests and confirm GREEN**

Run:

```bash
npx vitest run tests/serve-command.test.ts tests/serve-runtime.integration.test.ts tests/agent-hooks-cli.test.ts
npm run check
```

Expected: PASS, no orphan listener, strict-port behavior, and existing CLI
commands remain intact.

- [ ] **Step 5: Commit public dispatch**

```bash
git add src/cli/main.ts src/cli/serveCommand.ts tests/serve-command.test.ts tests/serve-runtime.integration.test.ts
git commit -m "feat: make desk serve select explicit runtimes"
```

## Task 3: Make Bun standalone a private runtime artifact

**Files:**
- Delete: `src/server/standaloneCommand.ts`
- Delete: `tests/standalone-command.test.ts`
- Modify: `src/server/standalone-entry.ts:1-26`
- Modify: `scripts/build-standalone.ts:1-88`
- Modify: `tests/standalone-build-contract.test.ts:1-49`
- Modify: `package.json:17-38`
- Modify: `.gitignore:27-31`
- Create: `scripts/smoke-serve-modes.mjs`

- [ ] **Step 1: Rewrite the standalone contract test to fail on the public command layer**

Require `standalone-entry.ts` to dynamically load the server/plugins and start immediately, require the build output path to end in `libexec/desk-standalone`, and assert the retired argument module is not imported.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npx vitest run tests/standalone-build-contract.test.ts tests/standalone-command.test.ts
```

Expected: new assertions fail against the public server command/output.

- [ ] **Step 3: Delete the public standalone command and simplify the entrypoint**

The private entrypoint should contain only startup/error handling:

```ts
try {
  const [{ startStandalone }, { embeddedPlugins }] = await Promise.all([
    import('./standalone.js'),
    import('./embeddedPlugins.js')
  ]);
  await startStandalone({ plugins: embeddedPlugins });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
```

Delete `src/server/standaloneCommand.ts` and its test.

- [ ] **Step 4: Change the private build output and build ordering**

Make `scripts/build-standalone.ts` create `libexec/` and emit `libexec/desk-standalone`. Add:

```json
"build:distribution": "npm run build:standalone && npm run build",
"smoke:serve-modes": "node scripts/smoke-serve-modes.mjs"
```

`build:distribution` intentionally runs the Node build last because Vite empties `dist/`.

- [ ] **Step 5: Implement the real two-mode smoke script**

The script must:

1. accept `--desk <absolute-command>` and `--cwd <outside-directory>` so the
   same script can probe either the checkout build or an installed launcher;
   default to the checkout's `dist/cli/main.js` only when `--desk` is omitted;
2. locate an unused port;
3. start the selected Desk command with `serve` and prove `/` is 200 but
   `/@vite/client` is not a Vite route;
4. stop it and prove the port closes;
5. start the selected Desk command with `serve --dev` and prove `/@vite/client`
   is available;
6. send SIGINT and SIGTERM only to the CLI PID in separate runs and prove the
   private Bun child exits and its port closes;
7. pre-bind the requested standalone port and prove Bun fails without an
   alternate listener or Vite fallback;
8. replace the private runtime with a controlled executable that exits nonzero
   and prove the CLI propagates that status;
9. stop every child and fail if either runtime remains alive.

- [ ] **Step 6: Run focused tests, distribution build, and real smoke**

Run:

```bash
. "$HOME/.nvm/nvm.sh"
nvm use 22.23.1
npx vitest run tests/standalone-build-contract.test.ts tests/serve-command.test.ts
npm run build:distribution
npm run smoke:serve-modes
npm run build
```

Expected: PASS; `libexec/desk-standalone` and `dist/cli/main.js` both exist.

- [ ] **Step 7: Commit the private runtime**

```bash
git add -A src/server/standalone-entry.ts src/server/standaloneCommand.ts scripts/build-standalone.ts scripts/smoke-serve-modes.mjs tests/standalone-build-contract.test.ts tests/standalone-command.test.ts package.json .gitignore
git commit -m "refactor: make bun server a private desk runtime"
```

## Task 4: Generate source-backed release assets

**Files:**
- Create: `scripts/distribution/toolchains.json`
- Create: `scripts/create-release-assets.mjs`
- Create: `tests/release-assets.test.ts`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Add the pinned toolchain manifest**

Pin Node 22.23.1 and Bun 1.3.14. Include only supported targets:

```json
{
  "schemaVersion": 1,
  "node": {
    "version": "22.23.1",
    "npmVersion": "10.9.8",
    "targets": {
      "darwin-arm64": { "os": "darwin", "arch": "arm64", "libc": "system", "asset": "node-v22.23.1-darwin-arm64.tar.gz", "sha256": "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953" },
      "darwin-x64": { "os": "darwin", "arch": "x64", "libc": "system", "asset": "node-v22.23.1-darwin-x64.tar.gz", "sha256": "b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81" },
      "linux-arm64": { "os": "linux", "arch": "arm64", "libc": "glibc", "asset": "node-v22.23.1-linux-arm64.tar.gz", "sha256": "543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d" },
      "linux-x64": { "os": "linux", "arch": "x64", "libc": "glibc", "asset": "node-v22.23.1-linux-x64.tar.gz", "sha256": "7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129" }
    }
  },
  "bun": {
    "version": "1.3.14",
    "tag": "bun-v1.3.14",
    "targets": {
      "darwin-arm64": { "os": "darwin", "arch": "arm64", "libc": "system", "asset": "bun-darwin-aarch64.zip", "sha256": "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620" },
      "darwin-x64": { "os": "darwin", "arch": "x64", "libc": "system", "asset": "bun-darwin-x64-baseline.zip", "sha256": "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076" },
      "linux-arm64": { "os": "linux", "arch": "arm64", "libc": "glibc", "asset": "bun-linux-aarch64.zip", "sha256": "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b" },
      "linux-x64": { "os": "linux", "arch": "x64", "libc": "glibc", "asset": "bun-linux-x64-baseline.zip", "sha256": "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7" }
    }
  }
}
```

Do not claim Alpine/musl support in the generated targets until a compatible Node musl asset is pinned and exercised.

- [ ] **Step 2: Write failing release-asset tests**

Test canonical version validation, manifest/schema contents (including Node,
bundled npm, Bun, target, and libc), archive prefix, exclusion of `.git`,
`node_modules`, `dist`, and local artifacts, SHA entries for the source and
install manifest, stable output across two runs, and refusal to package a
dirty/untracked runtime artifact.

- [ ] **Step 3: Run the test and confirm RED**

Run: `npx vitest run tests/release-assets.test.ts`

Expected: FAIL because the generator does not exist.

- [ ] **Step 4: Implement `scripts/create-release-assets.mjs`**

Use array-argument `spawnSync('git', ['archive', ...])`, not shell interpolation. Validate `vX.Y.Z[-prerelease]`, require it to match `package.json`, write a schema-versioned `desk-install-manifest.json`, calculate SHA-256 with Node `crypto`, and write sorted `SHA256SUMS`.

Expose small pure functions for tests:

```js
export function validateReleaseVersion(value) {}
export function createInstallManifest({ version, sourceAsset, sourceSha256, toolchains }) {}
export function writeReleaseAssets({ root, version, outDir }) {}
```

- [ ] **Step 5: Bump the release version and add the release script**

Update both package files to v0.3.0 and add:

```json
"release:assets": "node scripts/create-release-assets.mjs"
```

- [ ] **Step 6: Run tests and inspect a fixture release directory**

Run:

```bash
npx vitest run tests/release-assets.test.ts
fixture_repo=$(mktemp -d /var/tmp/desk-release-repo.XXXXXX)
fixture_out=$(mktemp -d /var/tmp/desk-release-out.XXXXXX)
mkdir -p "$fixture_repo/scripts/distribution"
cp scripts/distribution/toolchains.json "$fixture_repo/scripts/distribution/toolchains.json"
printf '{"name":"desk-fixture","version":"0.3.0"}\n' > "$fixture_repo/package.json"
printf 'fixture\n' > "$fixture_repo/README.md"
git -C "$fixture_repo" init
git -C "$fixture_repo" add .
git -C "$fixture_repo" -c user.name=Desk -c user.email=desk@example.invalid \
  commit -m fixture
fixture_ref=$(git -C "$fixture_repo" rev-parse HEAD)
npm run release:assets -- --root "$fixture_repo" --version v0.3.0 \
  --ref "$fixture_ref" --out-dir "$fixture_out"
(cd "$fixture_out" && sha256sum -c SHA256SUMS)
tar -tzf "$fixture_out/desk-v0.3.0-source.tar.gz" | head
rm -rf "$fixture_repo" "$fixture_out"
```

Expected: checksum PASS; every archive entry is below `desk-v0.3.0/`. The test
fixture owns its temporary Git repository so the generator can require a clean,
committed ref without packaging uncommitted worktree state.

- [ ] **Step 7: Commit release generation**

```bash
git add scripts/distribution/toolchains.json scripts/create-release-assets.mjs tests/release-assets.test.ts package.json package-lock.json
git commit -m "build: generate source-backed desk release assets"
```

## Task 5: Rewrite installer bootstrap and dependency provisioning

**Files:**
- Modify: `install.sh:1-119`
- Create: `tests/helpers/installerFixture.ts`
- Modify: `tests/install-script.test.ts:1-132`

- [ ] **Step 1: Replace old installer tests with failing platform/dependency tests**

Build a generic temp harness that executes `bash install.sh` with a controlled
PATH and records package-manager invocations. Cover Darwin arm64/x64, Linux
arm64/x64, WSL-as-Linux, native Windows rejection, unsupported architecture,
glibc vs musl selection, apt/dnf/yum/pacman/zypper/apk selection, missing
sudo/root, missing commands, present-but-old tmux/Git/Python, a compiler that
exists but cannot build a trivial program, bootstrap capability ordering and
post-install re-probes, `xcode-select --install` completion/timeout, Homebrew
prefix discovery, post-install probe failure, and no package-manager case.

Add lock-order assertions now: the sibling lock must exist before the first
package-manager invocation and a second installer must be rejected while the
first is provisioning.

Do not embed `/home/dev`, `BrainyBlaze`, or a repository checkout path in fixtures or expectations.

- [ ] **Step 2: Run the installer tests and confirm RED**

Run: `npx vitest run tests/install-script.test.ts`

Expected: existing downloader does not provision dependencies and installs the wrong public surface.

- [ ] **Step 3: Implement strict installer argument and platform parsing**

Start `install.sh` with small functions and a single `main "$@"`:

```bash
info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

main() {
  case "${1:-}" in
    '') install_desk ;;
    --uninstall) [ "$#" -eq 1 ] || die "--uninstall accepts no arguments"; uninstall_desk ;;
    *) die "unexpected installer argument: $1" ;;
  esac
}
```

Validate canonical absolute `DESK_HOME`, `DESK_BIN_DIR`, and version strings before creating paths.

- [ ] **Step 4: Implement and acquire the sibling lock before provisioning**

Implement `acquire_install_lock` and matching-token cleanup at
`${DESK_HOME}.install-lock`. `install_desk` and `uninstall_desk` must acquire it
after argument/path validation but before creating `DESK_HOME`, invoking a
package manager, downloading, promoting a toolchain, or mutating any managed
path. All later installer tasks extend code already running under this lock.

- [ ] **Step 5: Implement capability probes and package maps**

Provide explicit functions:

```bash
detect_target
detect_package_manager
probe_bootstrap_capabilities
probe_host_capabilities
install_missing_packages
verify_host_capabilities
ensure_macos_tooling
```

Install the package set for missing or below-minimum capabilities. Use arrays for
package-manager arguments. Parse and enforce tmux >=3.2, Git >=2.30, and Python
>=3.8; compile and run a trivial C++ program rather than trusting `c++ --version`.
On macOS, verify `xcode-select -p`, invoke `xcode-select --install` only when
absent, poll the capability with a bounded timeout, bootstrap Homebrew from its
official installer only when absent, resolve `/opt/homebrew/bin/brew` vs
`/usr/local/bin/brew`, evaluate `brew shellenv` in the installer process, then
re-probe every capability.

Linux package maps must match the approved design. Alpine detection may provision host packages, but installation must later fail accurately when the release manifest has no compatible Node target.

- [ ] **Step 6: Run dependency and lock-order tests**

Run:

```bash
bash -n install.sh
npx vitest run tests/install-script.test.ts
```

Expected: platform/dependency tests PASS; download/activation tests remain pending.

- [ ] **Step 7: Commit dependency provisioning**

```bash
git add install.sh tests/helpers/installerFixture.ts tests/install-script.test.ts
git commit -m "feat: provision desk installer dependencies"
```

## Task 6: Add verified source/toolchain download and build staging

**Files:**
- Modify: `install.sh`
- Modify: `tests/helpers/installerFixture.ts`
- Modify: `tests/install-script.test.ts`

- [ ] **Step 1: Add failing integrity and extraction tests**

Use generic local `file://` release fixtures through a documented
`DESK_RELEASE_BASE_URL` override. Cover missing/mismatched
source/install/toolchain checksums, wrong target/libc, interrupted partial files,
invalid manifest schema, version traversal, and adversarial TAR and ZIP archives:
absolute/traversing names, escaping symlinks/hardlinks, devices/FIFOs, unsafe
modes, duplicate normalized paths, and multiple roots. Add RED cases for exact
Node 22.23.1, npm 10.9.8, and Bun 1.3.14 probes; Bun trivial compilation; cached
toolchain target/libc/ownership mismatch; and a cached binary that no longer
passes its probe. Reject manifest `url`/`baseUrl` fields and hostile scheme,
host, userinfo, query, fragment, version-path, or asset-path attempts; prove only
the exact official Node and Bun origin templates reach curl.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npx vitest run tests/install-script.test.ts`

Expected: current installer warns/skips checksums and has no source/toolchain staging.

- [ ] **Step 3: Implement fail-closed release resolution and downloads**

Add:

```bash
resolve_release_version
download_release_metadata
validate_install_manifest
download_and_verify_asset
ensure_node_toolchain
ensure_bun_toolchain
```

Use `mktemp` files in the canonical Desk parent, mandatory SHA-256, canonical
asset-character validation, and atomic promotion. The install manifest contains
no URL/base-origin fields. Construct URLs only from hardcoded official templates:

```text
https://nodejs.org/dist/v${nodeVersion}/${nodeAsset}
https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunAsset}
```

Validate the exact HTTPS scheme, host, version-derived path prefix, canonical
asset basename, and absence of userinfo, query, or fragment before curl. Reject
unknown manifest keys that could smuggle an origin or URL.

- [ ] **Step 4: Implement structured safe extraction for every archive**

Use the already provisioned Python 3 runtime and embedded `tarfile`/`zipfile`
logic from `install.sh`; do not parse human-formatted `tar -tv` output. For the
Desk source TAR, Node TAR, and Bun ZIP, inspect structured members, normalize each
path, and reject absolute/traversing/duplicate names, devices/FIFOs, unsafe
modes, multiple roots, and links escaping the extraction root. Manually
materialize allowed directories/files/links into an empty staging directory,
never call unrestricted `extractall`, and post-walk canonical paths before
executing a binary or source script.

- [ ] **Step 5: Verify and promote exact toolchains**

Before promotion and on every cached reuse, require a `.desk-toolchain` manifest
with schema, kind, version, npm version where applicable, target, libc, source
asset, and digest. Verify:

```bash
node --version        # exactly v22.23.1
npm --version         # exactly 10.9.8
bun --version         # exactly 1.3.14
```

Compile and run a trivial Bun executable. Promote with temp-plus-rename only
after every probe passes. A directory name alone is never trusted.

- [ ] **Step 6: Implement the staged source build**

In the verified source root:

```bash
PATH="$node_bin_dir:$bun_bin_dir:$PATH" "$node_bin_dir/npm" ci
PATH="$node_bin_dir:$bun_bin_dir:$PATH" "$node_bin_dir/npm" run build:distribution
```

Create `.desk-release`, bind `runtime/node` to the verified toolchain, and smoke the staged CLI with `help`. Never prune `node_modules`.

- [ ] **Step 7: Run installer integrity tests**

Run:

```bash
bash -n install.sh
npx vitest run tests/install-script.test.ts tests/release-assets.test.ts
```

Expected: all download, checksum, extraction, and build-stage cases PASS.

- [ ] **Step 8: Commit verified staging**

```bash
git add install.sh tests/helpers/installerFixture.ts tests/install-script.test.ts
git commit -m "feat: stage verified source-backed desk installs"
```

## Task 7: Implement atomic lifecycle, PATH ownership, and uninstall

**Files:**
- Modify: `install.sh`
- Modify: `tests/helpers/installerFixture.ts`
- Modify: `tests/install-script.test.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Cover first install, upgrade, explicit downgrade, latest-resolution refusal to
silently downgrade, same-version reinstall with a new install ID, clean reinstall
(uninstall then first install) with preserved config, failed-build rollback,
launcher-write failure, post-activation smoke failure, current+previous
retention, unreferenced-toolchain pruning, concurrent same/different versions,
stale/live/foreign lock handling, uninstall/install racing, unidentified release
or install-root ownership refusal, and removal of `DESK_HOME` only when every
remaining entry is fully owned.

- [ ] **Step 2: Add failing PATH and ownership tests**

Cover ordered PATH lookup, recognized npm link/managed launcher replacement,
earlier unknown collision, later collision, empty/relative/dot/group-writable/
world-writable entries, sticky-vs-untrusted permissions, symlink-directory
canonicalization, a lexical PATH entry whose canonical path differs from
`DESK_BIN_DIR`, safe system-directory fallback, unavailable sudo, proof that sudo
is used only for the final launcher rename (never application files),
`DESK_BIN_DIR` outside PATH, immediate same-shell execution, public legacy
checksum cleanup, and unidentified same-named file preservation.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npx vitest run tests/install-script.test.ts`

- [ ] **Step 4: Reassert the existing lock across every lifecycle path**

Extend the Task 5 lock tests to prove upgrade, reinstall, activation rollback,
pruning, legacy cleanup, and uninstall never release the sibling lock early. Use
atomic `mkdir`, PID/host/time/version/random token ownership, same-host dead-lock
reclamation after ten minutes, and matching-token traps. Keep it through final
uninstall deletion and remove it last.

- [ ] **Step 5: Implement immutable instances and activation transaction**

Add:

```bash
create_install_id
promote_release_instance
write_launcher_candidate
resolve_effective_bin_dir
activate_release_transaction
rollback_activation
prune_owned_releases
```

`resolve_effective_bin_dir` scans PATH in order, rejects empty/relative/dot or
unsafe writable entries, canonicalizes every directory before comparing it,
refuses any earlier unknown `desk`, and accepts `DESK_BIN_DIR` only when its
canonical directory is already effective on PATH. If no safe user-writable entry
exists, it may select a canonical system directory already on PATH and preflight
sudo, but elevation is scoped to the final temp-plus-rename launcher operation.
Application/toolchain/release paths remain owned and written by the invoking
user.

The launcher resolves `current` once, verifies containment/ownership, and executes
that physical instance's `runtime/node` plus `dist/cli/main.js`. Use
temp-plus-rename for current/launcher swaps. Snapshot the previous entry's file
type, symlink target or complete bytes, mode, and ownership before mutation; only
entries owned by the invoking user/Desk may be changed. Restore the full metadata
on rollback, and remove all first-install launcher/current fragments when there
was no previous state.

After successful activation and post-activation smoke, run a dedicated legacy
cleanup that removes a retired launcher only when its published checksum or
managed marker proves Desk ownership. Preserve and report every unidentified
file. Cleanup is never part of CLI runtime dispatch.

- [ ] **Step 6: Implement ownership-safe uninstall**

`--uninstall` removes only a recognized launcher, valid owned
releases/toolchains/current metadata, then `DESK_HOME` only when the remaining
tree is empty and fully owned; it refuses unidentified releases/install-root
entries. It preserves `~/.config/desk`, project files, tmux sessions,
credentials, optional tools, and unidentified paths. Remove the sibling lock
last.

- [ ] **Step 7: Run focused lifecycle/PATH tests**

Run:

```bash
bash -n install.sh
npx vitest run tests/install-script.test.ts
```

Expected: focused lifecycle, ownership, PATH, concurrency, rollback, and
uninstall tests PASS.

- [ ] **Step 8: Commit lifecycle behavior before release packaging**

```bash
git add install.sh tests/helpers/installerFixture.ts tests/install-script.test.ts
git commit -m "feat: activate and uninstall desk atomically"
git status --porcelain
```

Expected: the commit succeeds and status is empty. The release generator can now
archive a clean HEAD containing the complete Task 7 implementation.

- [ ] **Step 9: Run a real local release/install round trip from clean HEAD**

Run:

```bash
roundtrip_root=$(mktemp -d /var/tmp/desk-roundtrip.XXXXXX)
repo_root=$(pwd)
release_dir="$roundtrip_root/release"
desk_home="$roundtrip_root/home"
desk_bin="$roundtrip_root/bin"
user_home="$roundtrip_root/user-home"
outside_cwd="$roundtrip_root/outside"
mkdir -p "$release_dir" "$desk_bin" "$user_home" "$outside_cwd"
npm run release:assets -- --version v0.3.0 --out-dir "$release_dir"
HOME="$user_home" PATH="$desk_bin:$PATH" DESK_VERSION=v0.3.0 \
  DESK_RELEASE_BASE_URL="file://$release_dir" \
  DESK_HOME="$desk_home" DESK_BIN_DIR="$desk_bin" bash install.sh
(
  cd "$outside_cwd"
  HOME="$user_home" PATH="$desk_bin:$PATH" DESK_HOME="$desk_home" \
    "$desk_bin/desk" help
  HOME="$user_home" PATH="$desk_bin:$PATH" DESK_HOME="$desk_home" \
    node "$repo_root/scripts/smoke-serve-modes.mjs" \
      --desk "$desk_bin/desk" --cwd "$outside_cwd"
)
```

Keep the same temporary HOME and PATH for every command; do not add either after
installation. Then run same-version reinstall, clean reinstall, and
`bash install.sh --uninstall` with the same overrides. Expected: the absolute
installed launcher works from outside the checkout in both modes; config remains;
unidentified paths are refused; managed install paths are gone. Remove only
`roundtrip_root` in the final test cleanup.

- [ ] **Step 10: Convert any round-trip defect into a regression test**

If the real round trip exposes a defect, first add a failing focused case to
`tests/install-script.test.ts`, confirm RED, implement the minimal fix, rerun the
focused suite and full round trip, then commit only those corrections as
`fix: close desk installer round-trip gap`. If no defect appears, make no extra
commit.

## Task 8: Replace release and CI contracts

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `.github/workflows/installer.yml`
- Modify: `tests/server-architecture.test.ts`

- [ ] **Step 1: Add failing workflow/architecture assertions**

Extend architecture tests to require the private build path and reject current release workflow/install paths containing the retired public executable. Keep these as supplemental contract checks; real builds/smokes remain required.

- [ ] **Step 2: Run the architecture test and confirm RED**

Run: `npx vitest run tests/server-architecture.test.ts`

- [ ] **Step 3: Update CI to build both installed modes**

Pin Node 22.23.1 and Bun 1.3.14, run typecheck/full tests, `npm run build:distribution`, then `npm run smoke:serve-modes`. Always run `npm run build` after any UI build.

- [ ] **Step 4: Replace the release workflow**

On PRs, generate v0.3.0-shaped source/install assets, verify `SHA256SUMS`, install into a temp prefix, and smoke both modes. On matching version tags, publish only:

- `desk-vX.Y.Z-source.tar.gz`
- `desk-install-manifest.json`
- `SHA256SUMS`

No public standalone server artifact is staged, uploaded, or checksummed.

- [ ] **Step 5: Add the installer platform matrix**

Use disposable Ubuntu, Fedora, Arch, openSUSE, and Alpine containers for
dependency detection/provisioning; Alpine must reach the explicit unsupported
musl Node-toolchain result rather than activate. The matrix must exercise missing
and present-but-old capabilities, the real trivial compiler probe, bootstrap
ordering/re-probes, and libc-qualified target selection. Use `macos-15` for
arm64 and `macos-15-intel` for x64, verify the reported architecture in each job,
and exercise Homebrew prefix plus `xcode-select` behavior without mutating an
unrelated developer host. Test WSL classification as Linux in the shell test
harness because hosted Actions does not provide WSL.

Avoid mutating a developer machine and cache upstream toolchain downloads by URL+digest.

- [ ] **Step 6: Run local workflow-adjacent verification**

Run:

```bash
npx vitest run tests/server-architecture.test.ts tests/install-script.test.ts tests/release-assets.test.ts
npm run build:distribution
npm run smoke:serve-modes
```

- [ ] **Step 7: Commit CI/release contracts**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/installer.yml tests/server-architecture.test.ts
git commit -m "ci: verify source installer and both serve modes"
```

## Task 9: Align Docker with the one-CLI contract

**Files:**
- Modify: `Dockerfile:1-101`
- Modify: `.dockerignore:1-30`
- Create: `tests/docker-contract.test.ts`

- [ ] **Step 1: Write a failing Dockerfile contract test**

Assert the exact Node 22.23.1 builder/runtime bases, `npm run
build:distribution`, full application copy, private `libexec/desk-standalone`,
`ENTRYPOINT ["desk"]`, default standalone CMD, and absence of a public private-
runtime copy. This supplements rather than replaces the real image smoke.

- [ ] **Step 2: Run the Docker contract test and confirm RED**

Run: `npx vitest run tests/docker-contract.test.ts`

Expected: FAIL against the server-only image contract.

- [ ] **Step 3: Rewrite the Docker stages**

Use `node:22.23.1-bookworm-slim` for both builder and runtime, install Bun
1.3.14 in the builder, run `npm ci` plus `npm run build:distribution`, and copy
the source-backed built application to `/opt/desk`. Install host tools/agent CLIs
as before.

Set:

```dockerfile
RUN ln -s /opt/desk/dist/cli/main.js /usr/local/bin/desk
ENTRYPOINT ["desk"]
CMD ["serve", "--host", "0.0.0.0", "--port", "5173"]
```

- [ ] **Step 4: Remove retired Docker artifact names**

Update `.dockerignore` and all Docker comments. Preserve the no-authentication warning.

- [ ] **Step 5: Run the contract test, then build and smoke every CLI shape**

Run:

```bash
npx vitest run tests/docker-contract.test.ts
docker build -t desk:cli-contract .
docker image inspect desk:cli-contract --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'
docker run --rm desk:cli-contract help
docker run --rm -d --name desk-cli-contract-standalone -p 127.0.0.1:55173:5173 desk:cli-contract
curl -fsS http://127.0.0.1:55173/
docker rm -f desk-cli-contract-standalone
docker run --rm -d --name desk-cli-contract-vite -p 127.0.0.1:55174:5174 \
  desk:cli-contract serve --host 0.0.0.0 --port 5174
curl -fsS http://127.0.0.1:55174/@vite/client
docker rm -f desk-cli-contract-vite
docker run --rm desk:cli-contract hooks install --home /tmp/desk-hooks
```

Expected: the contract test passes; entrypoint is `["desk"]`; help/hooks use the
full CLI; standalone root and Vite client HTTP probes pass; cleanup succeeds.

- [ ] **Step 6: Commit Docker parity**

```bash
git add Dockerfile .dockerignore tests/docker-contract.test.ts
git commit -m "build: run docker through the full desk cli"
```

## Task 10: Rewrite user and contributor documentation from verified behavior

**Files:**
- Delete: `docs/standalone-command-contract-spec.md`
- Modify: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- Modify: `docs/index.md`, `docs/getting-started.md`, `docs/distribution-deployment.md`, `docs/guide-deploy-securely.md`, `docs/troubleshooting.md`, `docs/operations.md`, `docs/concepts-architecture.md`, `docs/security-plugin-model.md`, `docs/release-notes.md`, `docs/native-ui-mode-spec.md`
- Modify: `src/server/agentHostToken.ts`, `src/server/agents/host/cli.ts`, `src/server/agents/drivers/driver.ts`, `src/web/httpJson.ts`

- [ ] **Step 1: Build a documentation truth matrix from actual commands**

Create a fresh isolated install fixture first; never resolve a global `desk` or
use default install paths:

```bash
docs_root=$(mktemp -d /var/tmp/desk-docs-truth.XXXXXX)
repo_root=$(pwd)
mkdir -p "$docs_root/bin" "$docs_root/release" "$docs_root/user-home" "$docs_root/outside"
npm run release:assets -- --version v0.3.0 --out-dir "$docs_root/release"
HOME="$docs_root/user-home" PATH="$docs_root/bin:$PATH" DESK_HOME="$docs_root/home" \
  DESK_BIN_DIR="$docs_root/bin" DESK_VERSION=v0.3.0 \
  DESK_RELEASE_BASE_URL="file://$docs_root/release" bash install.sh
(
  cd "$docs_root/outside"
  HOME="$docs_root/user-home" PATH="$docs_root/bin:$PATH" DESK_HOME="$docs_root/home" \
    "$docs_root/bin/desk" help
  HOME="$docs_root/user-home" PATH="$docs_root/bin:$PATH" DESK_HOME="$docs_root/home" \
    node "$repo_root/scripts/smoke-serve-modes.mjs" \
      --desk "$docs_root/bin/desk" --cwd "$docs_root/outside"
)
HOME="$docs_root/user-home" PATH="$docs_root/bin:$PATH" DESK_HOME="$docs_root/home" \
  DESK_BIN_DIR="$docs_root/bin" bash install.sh --uninstall
```

Use that output—not the superseded docs—as the source of truth, then remove only
`docs_root`.

- [ ] **Step 2: Rewrite install and getting-started surfaces**

Document:

- curl prerequisite and supported macOS/Linux x64/arm64 targets;
- WSL uses Linux; native Windows is unsupported;
- required dependencies automatically provisioned vs optional integrations;
- versioned layout and immediate PATH behavior;
- `desk serve` default private Bun mode;
- `desk serve --dev` opt-in Vite mode;
- no fallback between modes.

- [ ] **Step 3: Rewrite distribution, upgrade, uninstall, Docker, and security docs**

Include exact rerun/`DESK_VERSION` upgrade and downgrade behavior, same-version repair, two-instance retention, ownership-safe uninstall command, preserved user data, explicit optional purge guidance, container `0.0.0.0` exception, and localhost/no-authentication warnings.

- [ ] **Step 4: Rewrite contributor/release docs**

Document Node 22.23.1, Bun 1.3.14, `npm run build:distribution`, build ordering, release assets, real smoke commands, and installer matrix. Replace the current Unreleased split-command entry with the final one-CLI contract and v0.3.0 release notes.

- [ ] **Step 5: Remove the superseded spec and exact live terminology**

Delete `docs/standalone-command-contract-spec.md`. Replace hyphenated executable terminology in current code comments and operating docs with “Desk server” where it describes the service. Historical mentions remain only in the approved design spec, changelog, and focused ownership-migration test fixtures.

- [ ] **Step 6: Run documentation validators and focused audit**

Run:

```bash
cd docs
npm exec -y --package=mint@4.2.660 -- mint validate
npm exec -y --package=mint@4.2.660 -- mint broken-links
npm exec -y --package=mint@4.2.660 -- mint a11y
cd ..
docs_venv=$(mktemp -d /var/tmp/desk-docs-venv.XXXXXX)
python3 -m venv "$docs_venv"
"$docs_venv/bin/pip" install mkdocs==1.6.1
"$docs_venv/bin/python" -m mkdocs build --strict
rm -rf "$docs_venv"
audit=$(rg -n 'desk-server' README.md CONTRIBUTING.md Dockerfile install.sh .github src docs tests \
  | rg -v '^(docs/desk-cli-install-and-serve-contract-spec\.md|docs/desk-cli-installer-serve-implementation-plan\.md|CHANGELOG\.md|tests/install-script\.test\.ts|tests/helpers/installerFixture\.ts):' \
  || true)
test -z "$audit" || { printf '%s\n' "$audit" >&2; exit 1; }
```

Expected: validators PASS. During execution, the focused search uses an explicit
allowlist for the approved design spec, changelog, focused ownership-migration
tests, and this temporary implementation plan. It must never find a live command,
artifact, help path, Docker path, or operating guide. Task 11 deletes this plan
before the final audit so the final allowlist exactly matches the design spec.

- [ ] **Step 7: Commit documentation truth**

```bash
git add -A README.md CONTRIBUTING.md CHANGELOG.md docs src/server/agentHostToken.ts src/server/agents/host/cli.ts src/server/agents/drivers/driver.ts src/web/httpJson.ts
git commit -m "docs: publish the full desk cli install contract"
```

## Task 11: Run the complete verification and simplify

**Files:**
- Modify only files required by failures attributable to this branch.

- [ ] **Step 1: Run formatting/diff hygiene**

```bash
git diff --check main...HEAD
git status --short
```

Expected: no whitespace errors and only intentional changes.

- [ ] **Step 2: Run exact Node verification**

```bash
. "$HOME/.nvm/nvm.sh"
nvm use 22.23.1
npm ci
npm run check
test_tmp=$(mktemp -d /var/tmp/desk-vitest.XXXXXX)
TMPDIR="$test_tmp" npx vitest run
status=$?
rm -rf "$test_tmp"
test "$status" -eq 0
```

Expected: full suite PASS.

- [ ] **Step 3: Run both real build/runtime paths**

```bash
npm run build:distribution
npm run smoke:serve-modes
npm run build
```

Expected: CLI restored after UI build; both runtime smokes PASS.

- [ ] **Step 4: Run release and installer round trip**

Generate assets, verify checksums, install outside the checkout, execute `desk help`, smoke both modes, reinstall the same version, then uninstall and verify user config is preserved.

- [ ] **Step 5: Run Docker and docs gates**

Run the Task 9 Docker smoke and Task 10 Mintlify/MkDocs commands.

- [ ] **Step 6: Audit no-fallback and no-legacy behavior**

Corrupt only the private Bun artifact and prove default serve fails without Vite fallback. Corrupt only the Vite artifact and prove `serve --dev` fails without Bun fallback. Audit public paths/artifacts/help/docs for the retired command and flag.

- [ ] **Step 7: Review complexity and remove test-only production hooks**

Ensure installer testability comes from documented inputs (`DESK_HOME`, `DESK_BIN_DIR`, `DESK_VERSION`, `DESK_RELEASE_BASE_URL`) and real filesystem/process behavior. Remove any production branch that exists solely to make a unit test pass.

- [ ] **Step 8: Remove this temporary implementation plan and run the final legacy audit**

This plan is a working artifact, not public operating documentation. Delete
`docs/desk-cli-installer-serve-implementation-plan.md` after every task above is
complete, then run the retired-token audit with only the approved design spec,
changelog, and focused ownership-migration tests allowlisted. Expected: no live
code, release, installer, Docker, help, or operating-doc match.

```bash
git rm docs/desk-cli-installer-serve-implementation-plan.md
audit=$(rg -n 'desk-server' README.md CONTRIBUTING.md Dockerfile install.sh .github src docs tests \
  | rg -v '^(docs/desk-cli-install-and-serve-contract-spec\.md|CHANGELOG\.md|tests/install-script\.test\.ts|tests/helpers/installerFixture\.ts):' \
  || true)
test -z "$audit" || { printf '%s\n' "$audit" >&2; exit 1; }
```

- [ ] **Step 9: Commit final verification fixes and plan cleanup if needed**

```bash
git add -A
git diff --cached --check
git commit -m "test: close desk distribution verification"
```

Skip a standalone verification commit only if an earlier final commit already
contains the plan deletion and verification required no other changes.

## Completion evidence

Do not claim completion until all are true:

- Worktree branch is clean.
- Exact Node 22.23.1 typecheck/full suite passes.
- `npm run build:distribution` and real two-mode smoke pass.
- Source archive/install manifest/SHA round trip passes.
- Supported installer matrix passes; Alpine fails only at the documented unsupported toolchain gate.
- Docker full-CLI entrypoint and HTTP health pass.
- Mintlify/MkDocs validation passes.
- `desk serve` and `desk serve --dev` each fail closed when their own artifact is absent.
- No public `desk-server` executable, release asset, installer path, Docker path, help contract, or operating-doc instruction remains.
- Required/optional dependency, platform, upgrade, reinstall, downgrade, uninstall, and security docs match observed behavior.
