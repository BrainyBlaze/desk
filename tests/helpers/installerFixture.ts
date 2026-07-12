import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createInstallManifest } from '../../scripts/create-release-assets.mjs';

export const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function runChecked(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
}

function platformTarget(): { target: string; libc: string } {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return { target: `${os}-${arch}`, libc: os === 'darwin' ? 'system' : 'glibc' };
}

export interface InstallerRunOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export class InstallerFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'desk-installer-fixture-'));
  readonly deskHome = join(this.root, 'desk-home');
  readonly binDir = join(this.root, 'bin');
  readonly releaseDir = join(this.root, 'release');
  readonly userHome = join(this.root, 'user-home');
  readonly outside = join(this.root, 'outside');
  readonly configDir = join(this.userHome, '.config', 'desk');
  readonly toolchains = JSON.parse(
    readFileSync(new URL('../../scripts/distribution/toolchains.json', import.meta.url), 'utf8')
  );
  readonly target = platformTarget();

  constructor() {
    for (const path of [this.deskHome, this.binDir, this.releaseDir, this.userHome, this.outside, this.configDir]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(this.configDir, 'preserved.txt'), 'keep\n');
    this.createCachedToolchains();
    this.createRelease();
  }

  private createCachedToolchains(): void {
    const node = this.toolchains.node.targets[this.target.target];
    const bun = this.toolchains.bun.targets[this.target.target];
    const nodeRoot = join(this.deskHome, 'toolchains', 'node-22.23.1');
    const bunRoot = join(this.deskHome, 'toolchains', 'bun-1.3.14');
    mkdirSync(join(nodeRoot, 'bin'), { recursive: true });
    mkdirSync(bunRoot, { recursive: true });

    executable(
      join(nodeRoot, 'bin', 'node'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then printf 'v22.23.1\\n'; exit 0; fi
script="\${1:?missing script}"
shift
exec "$script" "$@"
`
    );
    executable(
      join(nodeRoot, 'bin', 'npm'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then printf '10.9.8\\n'; exit 0; fi
if [ "\${1:-}" = "ci" ]; then exit 0; fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build:distribution" ]; then
  mkdir -p dist/cli libexec
  printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'case "\${1:-help}" in' '  help) printf "Desk fixture help\\n" ;;' '  *) printf "Desk fixture command: %s\\n" "\${1:-}" ;;' 'esac' > dist/cli/main.js
  printf '%s\\n' '#!/usr/bin/env bash' 'exit 0' > libexec/desk-standalone
  chmod +x dist/cli/main.js libexec/desk-standalone
  exit 0
fi
printf 'unexpected fake npm invocation: %s\\n' "$*" >&2
exit 91
`
    );
    executable(
      join(bunRoot, 'bun'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then printf '1.3.14\\n'; exit 0; fi
if [ "\${1:-}" = "build" ]; then
  outfile=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--outfile" ]; then outfile="$2"; shift 2; else shift; fi
  done
  [ -n "$outfile" ]
  printf '%s\\n' '#!/usr/bin/env bash' 'exit 0' > "$outfile"
  chmod +x "$outfile"
  exit 0
fi
exit 92
`
    );

    writeFileSync(
      join(nodeRoot, '.desk-toolchain'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: 'desk-installer',
          kind: 'node',
          version: '22.23.1',
          npmVersion: '10.9.8',
          target: this.target.target,
          libc: this.target.libc,
          asset: node.asset,
          sha256: node.sha256
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      join(bunRoot, '.desk-toolchain'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: 'desk-installer',
          kind: 'bun',
          version: '1.3.14',
          target: this.target.target,
          libc: this.target.libc,
          asset: bun.asset,
          sha256: bun.sha256
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  }

  private createRelease(): void {
    const sourceParent = join(this.root, 'source');
    const sourceRoot = join(sourceParent, 'desk-v0.3.0');
    mkdirSync(sourceRoot, { recursive: true });
    chmodSync(sourceRoot, 0o775);
    writeFileSync(join(sourceRoot, 'package.json'), '{"name":"desk-fixture","version":"0.3.0"}\n');
    writeFileSync(join(sourceRoot, 'package-lock.json'), '{}\n');
    symlinkSync('package.json', join(sourceRoot, 'package-link.json'));
    const sourceAsset = 'desk-v0.3.0-source.tar.gz';
    const sourcePath = join(this.releaseDir, sourceAsset);
    runChecked('tar', ['-czf', sourcePath, '-C', sourceParent, 'desk-v0.3.0'], this.root);

    const manifest = createInstallManifest({
      version: 'v0.3.0',
      sourceAsset,
      sourceSha256: sha256(sourcePath),
      toolchains: this.toolchains
    });
    const manifestPath = join(this.releaseDir, 'desk-install-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    this.rewriteChecksums();
  }

  rewriteChecksums(): void {
    const names = readdirSync(this.releaseDir)
      .filter((name) => name !== 'SHA256SUMS')
      .sort();
    writeFileSync(
      join(this.releaseDir, 'SHA256SUMS'),
      `${names.map((name) => `${sha256(join(this.releaseDir, name))}  ${name}`).join('\n')}\n`
    );
  }

  readManifest(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(this.releaseDir, 'desk-install-manifest.json'), 'utf8'));
  }

  writeManifest(value: unknown): void {
    writeFileSync(join(this.releaseDir, 'desk-install-manifest.json'), `${JSON.stringify(value, null, 2)}\n`);
    this.rewriteChecksums();
  }

  run(options: InstallerRunOptions = {}): SpawnSyncReturns<string> {
    return spawnSync('bash', [INSTALLER, ...(options.args ?? [])], {
      cwd: this.outside,
      env: {
        ...process.env,
        HOME: this.userHome,
        PATH: `${this.binDir}:${process.env.PATH ?? ''}`,
        DESK_HOME: this.deskHome,
        DESK_BIN_DIR: this.binDir,
        DESK_VERSION: 'v0.3.0',
        DESK_RELEASE_BASE_URL: `file://${this.releaseDir}`,
        ...options.env
      },
      encoding: 'utf8',
      timeout: 30_000
    });
  }

  launcher(): string {
    return join(this.binDir, 'desk');
  }

  releaseInstances(): string[] {
    const version = join(this.deskHome, 'releases', 'v0.3.0');
    return existsSync(version) ? readdirSync(version).sort() : [];
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
