import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { INSTALLER, InstallerFixture } from './helpers/installerFixture.js';

const fixtures: InstallerFixture[] = [];

function fixture(): InstallerFixture {
  const value = new InstallerFixture();
  fixtures.push(value);
  return value;
}

afterEach(() => {
  for (const value of fixtures.splice(0)) {
    value.cleanup();
  }
});

describe('source-backed installer contract', () => {
  it('owns dependency provisioning, verified staging, activation, and uninstall without a public server binary', () => {
    const source = readFileSync(INSTALLER, 'utf8');
    for (const functionName of [
      'detect_target',
      'detect_package_manager',
      'probe_bootstrap_capabilities',
      'probe_host_capabilities',
      'install_missing_packages',
      'verify_host_capabilities',
      'ensure_macos_tooling',
      'resolve_release_version',
      'download_release_metadata',
      'validate_install_manifest',
      'download_and_verify_asset',
      'ensure_node_toolchain',
      'ensure_bun_toolchain',
      'acquire_install_lock',
      'uninstall_desk'
    ]) {
      expect(source).toContain(`${functionName}()`);
    }
    expect(source.indexOf('acquire_install_lock')).toBeLessThan(source.indexOf('probe_host_capabilities', source.indexOf('main()')));
    expect(source).toContain('${DESK_HOME}.install-lock');
    expect(source).not.toContain('DESK_INSTALL_DIR');
    expect(source).not.toContain(['desk', 'server'].join('-'));
    expect(source).not.toMatch(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/u);
  });

  it('has valid Bash syntax', () => {
    const result = spawnSync('bash', ['-n', INSTALLER], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects unexpected arguments before installing anything', () => {
    const value = fixture();
    const result = value.run({ args: ['--standalone'] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected installer argument');
    expect(existsSync(value.launcher())).toBe(false);
  });

  it('rejects native Windows explicitly', () => {
    const value = fixture();
    const uname = join(value.binDir, 'uname');
    writeFileSync(uname, '#!/usr/bin/env bash\nprintf "MINGW64_NT-10.0\\n"\n');
    chmodSync(uname, 0o755);

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/native Windows.*unsupported/i);
  });

  it('rejects noncanonical install paths before network or activation', () => {
    const value = fixture();
    const result = value.run({ env: { DESK_HOME: `${value.root}/parent/../escape` } });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/canonical/i);
    expect(existsSync(value.launcher())).toBe(false);
  });

  it('rejects a hostile release version before acquiring the lock', () => {
    const value = fixture();
    const result = value.run({ env: { DESK_VERSION: 'v0.3.0/../../payload' } });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/canonical.*release tag/i);
    expect(existsSync(`${value.deskHome}.install-lock`)).toBe(false);
  });

  it('compares numeric prerelease identifiers numerically before refusing a silent downgrade', () => {
    const value = fixture();
    const installed = value.run();
    expect(installed.status, installed.stderr).toBe(0);

    const release = realpathSync(join(value.deskHome, 'current'));
    const metadataPath = join(release, '.desk-release');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, version: 'v0.3.0-rc.10' }, null, 2)}\n`);

    const curl = join(value.binDir, 'curl');
    writeFileSync(
      curl,
      '#!/usr/bin/env bash\nset -euo pipefail\ndestination=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then destination="$2"; shift 2; else shift; fi\ndone\n[ -n "$destination" ]\nprintf \'{"tag_name":"v0.3.0-rc.2"}\\n\' > "$destination"\n'
    );
    chmodSync(curl, 0o755);

    const result = value.run({ env: { DESK_VERSION: '', DESK_RELEASE_BASE_URL: '' } });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/older than installed v0\.3\.0-rc\.10.*silent downgrade/i);
  }, 20_000);

  it('rejects a live sibling lock before release staging', () => {
    const value = fixture();
    const lock = `${value.deskHome}.install-lock`;
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner'),
      `token=other\npid=${process.pid}\nhost=${hostname()}\nstarted=${Math.floor(Date.now() / 1000)}\ninstaller=fixture\n`
    );

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('another Desk install or uninstall owns');
    expect(existsSync(value.launcher())).toBe(false);
  });

  it('holds the sibling lock before invoking the host package manager', () => {
    const value = fixture();
    const log = join(value.root, 'package-manager.log');
    const tmux = join(value.binDir, 'tmux');
    const packageManager = join(value.binDir, process.platform === 'darwin' ? 'brew' : 'apt-get');
    const sudo = join(value.binDir, 'sudo');
    writeFileSync(tmux, '#!/usr/bin/env bash\nprintf "tmux 2.9\\n"\n');
    writeFileSync(
      packageManager,
      '#!/usr/bin/env bash\n[ "${1:-}" = "shellenv" ] && exit 0\n[ -d "${DESK_HOME}.install-lock" ] || exit 95\nprintf "%s\\n" "$*" >> "$PACKAGE_LOG"\nexit 73\n'
    );
    writeFileSync(sudo, '#!/usr/bin/env bash\nexec "$@"\n');
    chmodSync(tmux, 0o755);
    chmodSync(packageManager, 0o755);
    chmodSync(sudo, 0o755);

    const result = value.run({ env: { PACKAGE_LOG: log } });

    expect(result.status).toBe(73);
    expect(readFileSync(log, 'utf8')).toMatch(/update|install/);
    expect(existsSync(`${value.deskHome}.install-lock`)).toBe(false);
  });
});

describe('installer lifecycle', () => {
  it('installs the full desk launcher and activates a release-bound Node runtime', () => {
    const value = fixture();
    const result = value.run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('desk serve');
    expect(result.stdout).toContain('desk serve --dev');
    expect(readFileSync(value.launcher(), 'utf8')).toContain('# desk-managed-launcher-v1');
    expect(readlinkSync(join(value.deskHome, 'current'))).toMatch(/^releases\/v0\.3\.0\//);
    expect(value.releaseInstances()).toHaveLength(1);

    const help = spawnSync(value.launcher(), ['help'], {
      env: { ...process.env, DESK_HOME: value.deskHome },
      encoding: 'utf8'
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Desk fixture help');
  });

  it('reinstalls the same version into a new immutable instance and retains the previous one', () => {
    const value = fixture();
    const first = value.run();
    expect(first.status, first.stderr).toBe(0);
    const firstTarget = readlinkSync(join(value.deskHome, 'current'));

    const second = value.run();

    expect(second.status, second.stderr).toBe(0);
    expect(readlinkSync(join(value.deskHome, 'current'))).not.toBe(firstTarget);
    expect(value.releaseInstances()).toHaveLength(2);
  }, 20_000);

  it('prunes the oldest instance after a third successful activation', () => {
    const value = fixture();
    expect(value.run().status).toBe(0);
    expect(value.run().status).toBe(0);
    const before = value.releaseInstances();
    expect(before).toHaveLength(2);

    const third = value.run();

    expect(third.status, third.stderr).toBe(0);
    expect(value.releaseInstances()).toHaveLength(2);
    expect(value.releaseInstances()).not.toContain(before[0]);
  }, 20_000);

  it('uninstalls only managed application paths and preserves user configuration', () => {
    const value = fixture();
    const installed = value.run();
    expect(installed.status, installed.stderr).toBe(0);

    const removed = value.run({ args: ['--uninstall'] });

    expect(removed.status, removed.stderr).toBe(0);
    expect(existsSync(value.launcher())).toBe(false);
    expect(existsSync(value.deskHome)).toBe(false);
    expect(readFileSync(join(value.configDir, 'preserved.txt'), 'utf8')).toBe('keep\n');
  });

  it('refuses uninstall when an unidentified install-root path is present', () => {
    const value = fixture();
    const installed = value.run();
    expect(installed.status, installed.stderr).toBe(0);
    writeFileSync(join(value.deskHome, 'unidentified.txt'), 'preserve\n');

    const removed = value.run({ args: ['--uninstall'] });

    expect(removed.status).not.toBe(0);
    expect(removed.stderr).toMatch(/refusing uninstall|ownership validation/i);
    expect(readFileSync(join(value.deskHome, 'unidentified.txt'), 'utf8')).toBe('preserve\n');
    expect(existsSync(value.launcher())).toBe(true);
  });

  it('fails closed on an unidentified command collision', () => {
    const value = fixture();
    writeFileSync(value.launcher(), '#!/usr/bin/env bash\necho unrelated\n');
    chmodSync(value.launcher(), 0o755);

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unidentified.*command|refusing.*unidentified/i);
    expect(readFileSync(value.launcher(), 'utf8')).toContain('unrelated');
    expect(existsSync(join(value.deskHome, 'current'))).toBe(false);
  });

  it('fails closed when the source checksum no longer matches', () => {
    const value = fixture();
    appendFileSync(join(value.releaseDir, 'desk-v0.3.0-source.tar.gz'), 'tampered');

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum mismatch/i);
    expect(existsSync(value.launcher())).toBe(false);
  });

  it('rejects unknown manifest keys even when the checksum manifest is updated', () => {
    const value = fixture();
    const manifest = value.readManifest();
    manifest.url = 'https://invalid.example/override';
    value.writeManifest(manifest);

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/manifest is invalid/i);
    expect(existsSync(value.launcher())).toBe(false);
  });

  it('rejects an archive traversal even when both release checksums match it', () => {
    const value = fixture();
    const source = join(value.releaseDir, 'desk-v0.3.0-source.tar.gz');
    const archive = spawnSync(
      'python3',
      [
        '-c',
        'import io,sys,tarfile; p=sys.argv[1]; t=tarfile.open(p,"w:gz"); i=tarfile.TarInfo("desk-v0.3.0/../../escape"); b=b"bad"; i.size=len(b); i.mode=0o644; t.addfile(i,io.BytesIO(b)); t.close()',
        source
      ],
      { encoding: 'utf8' }
    );
    expect(archive.status, archive.stderr).toBe(0);
    const manifest = value.readManifest() as { source: { sha256: string } };
    manifest.source.sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
    value.writeManifest(manifest);

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe or invalid Desk source archive/i);
    expect(existsSync(join(value.root, 'escape'))).toBe(false);
    expect(existsSync(value.launcher())).toBe(false);
  });

  it('rejects a cached toolchain whose ownership manifest no longer matches the host', () => {
    const value = fixture();
    const manifestPath = join(value.deskHome, 'toolchains', 'node-22.23.1', '.desk-toolchain');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.target = manifest.target === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = value.run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cached Desk Node toolchain is invalid/i);
    expect(existsSync(value.launcher())).toBe(false);
  });
});
