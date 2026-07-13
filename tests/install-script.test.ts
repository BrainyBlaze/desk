import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');
const roots: string[] = [];

interface RunInstallerOptions {
  legacyDesk?: string;
  legacyDeskSymlink?: string;
}

function runInstaller(options: RunInstallerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'desk-installer-'));
  roots.push(root);
  const fakeBin = join(root, 'fake-bin');
  const installDir = join(root, 'install');
  const asset = join(root, 'standalone-asset');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  writeFileSync(asset, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(asset, 0o755);

  const fakeCurl = join(fakeBin, 'curl');
  writeFileSync(
    fakeCurl,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [[ "$url" == */SHA256SUMS ]]; then
  exit 22
fi
cp "$FAKE_DESK_ASSET" "$out"
`
  );
  chmodSync(fakeCurl, 0o755);

  if (options.legacyDesk !== undefined) {
    writeFileSync(join(installDir, 'desk'), options.legacyDesk);
  }
  if (options.legacyDeskSymlink !== undefined) {
    symlinkSync(options.legacyDeskSymlink, join(installDir, 'desk'));
  }

  const result = spawnSync('bash', [INSTALLER], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      DESK_VERSION: 'v-test',
      DESK_INSTALL_DIR: installDir,
      FAKE_DESK_ASSET: asset
    },
    encoding: 'utf8'
  });

  return {
    installDir,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release installer command contract', () => {
  it('installs the standalone as desk-server and prints that launch command', () => {
    const result = runInstaller();
    const installed = join(result.installDir, 'desk-server');

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(installed)).toBe(true);
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(existsSync(join(result.installDir, 'desk'))).toBe(false);
    expect(result.stdout).toContain('Next:\n  desk-server');
  });

  it('warns about but does not mutate an existing desk executable', () => {
    const result = runInstaller({ legacyDesk: 'keep-this-cli' });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(result.installDir, 'desk'), 'utf8')).toBe('keep-this-cli');
    expect(result.stdout).toContain('existing');
    expect(result.stdout).toContain('/desk');
  });

  it('warns about but does not mutate a dangling desk symlink', () => {
    const result = runInstaller({ legacyDeskSymlink: 'missing-cli-target' });
    const legacyDesk = join(result.installDir, 'desk');

    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(legacyDesk).isSymbolicLink()).toBe(true);
    expect(readlinkSync(legacyDesk)).toBe('missing-cli-target');
    expect(result.stdout).toContain('existing');
    expect(result.stdout).toContain('/desk');
  });
});
