// Distribution contract for the bundled moor holder: the vendored source
// snapshot is PROVENANCE-pinned (repository/commit/version + a content
// digest), the build script refuses drift, and the release ships ONLY the
// `moor` name — no compatibility binary is ever built or shipped. Building is
// exercised by `npm run fetch:moor` on developer/CI hosts; this contract
// validates the pinned inputs and the release builder's executable output.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { posixMoorIdentity } from '../src/server/runtime/moorMasterClient.js';
import {
  MoorCodec,
  MoorKind,
  crc32c,
  encodeMoorDiscoveryHello
} from '../src/shared/moorWire/index.js';
import {
  EXPECTED_COMMIT,
  EXPECTED_REPOSITORY,
  EXPECTED_VERSION,
  buildMoor,
  readProvenance,
  snapshotDigest,
  validateVendor
} from '../scripts/build-moor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor', 'moor');
const BUNDLED = join(ROOT, 'libexec', 'moor');
const REQUIRED_VENDOR_COMMIT = '649ea81769591d0c4212af52803e7d69ab127f1c';
const REQUIRED_SNAPSHOT_DIGEST = '8ad04bde92132a5923796260414f097250cc9256c28303d920a4a0c114e5d9a6';

async function exchangeHello(
  sessionPath: string,
  version: number
): Promise<ReturnType<MoorCodec['feed']>[number]> {
  const codec = new MoorCodec();
  const frame = encodeMoorDiscoveryHello(
    codec,
    posixMoorIdentity(sessionPath)
  );
  frame[4] = version;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(
    20,
    crc32c(frame.subarray(0, 20)),
    true
  );

  return await new Promise<ReturnType<MoorCodec['feed']>[number]>((resolve, reject) => {
    const socket = createConnection({ path: sessionPath });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.destroy();
      action();
    };

    timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`timed out waiting for release-built holder to answer v${version}`))
        ),
      5_000
    );
    socket.on('data', (chunk: Buffer) => {
      try {
        const messages = codec.feed(Date.now(), chunk);
        if (messages.length > 0) finish(() => resolve(messages[0]!));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once('connect', () => socket.write(frame));
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('close', () =>
      finish(() => reject(new Error(`release-built holder closed before answering v${version}`)))
    );
  });
}

describe('moor distribution contract — provenance-pinned vendor snapshot', () => {
  it('carries a provenance that names the fork, the frozen commit, and the version', () => {
    const provenance = readProvenance(VENDOR);
    expect(provenance.repository).toBe(EXPECTED_REPOSITORY);
    expect(provenance.commit).toBe(EXPECTED_COMMIT);
    expect(provenance.commit).toBe(REQUIRED_VENDOR_COMMIT);
    expect(provenance.version).toBe(EXPECTED_VERSION);
    expect(provenance.license).toBe('MIT OR Apache-2.0');
    expect(provenance.snapshotDigest).toBe(REQUIRED_SNAPSHOT_DIGEST);
  });

  it('the snapshot content digest matches the recorded provenance exactly', () => {
    const provenance = readProvenance(VENDOR);
    expect(snapshotDigest(VENDOR)).toBe(provenance.snapshotDigest);
    expect(() => validateVendor(VENDOR)).not.toThrow();
  });

  it('refuses a tampered snapshot (digest drift fails closed)', () => {
    const copy = mkdtempSync(join(tmpdir(), 'desk-moor-contract-'));
    try {
      cpSync(VENDOR, copy, { recursive: true });
      writeFileSync(join(copy, 'src', 'tampered.rs'), '// drifted\n');
      expect(() => validateVendor(copy)).toThrow(/snapshot digest mismatch/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('Desk builds and ships ONLY the moor name from the pinned snapshot', () => {
    const manifest = readFileSync(join(VENDOR, 'Cargo.toml'), 'utf8');
    expect(manifest).toContain('name = "moor"');
    expect(manifest).toContain('license = "MIT OR Apache-2.0"');
    expect(existsSync(join(VENDOR, 'LICENSE-MIT'))).toBe(true);
    expect(existsSync(join(VENDOR, 'LICENSE-APACHE'))).toBe(true);
    expect(existsSync(join(VENDOR, 'vendor', 'windows-spawn', 'Cargo.toml'))).toBe(true);
    // The build script pins `--bin moor`, so only that target is ever built,
    // and the release ships no second binary under the compatibility name.
    const builder = readFileSync(join(ROOT, 'scripts', 'build-moor.mjs'), 'utf8');
    expect(builder).toContain("'--bin', 'moor'");
    expect(existsSync(join(ROOT, 'libexec', 'atch'))).toBe(false);
    expect(manifest).not.toContain('name = "atch"');
  });

  it('the vendored holder consumes the supervisor-independent carriers Desk emits', () => {
    const runtime = readFileSync(join(VENDOR, 'src', 'runtime', 'private.rs'), 'utf8');
    expect(runtime).toContain('environment_key(invoked, "_LAUNCH_CHANNEL")');
    expect(runtime).toContain('std::env::var_os("MOOR_SESSION_GENERATION")');
    expect(runtime).not.toContain('std::env::var_os("DESK_MOOR_LAUNCH_CHANNEL")');
    expect(runtime).not.toContain('std::env::var_os("DESK_SESSION_GENERATION")');
  });

  it(
    'builds a protocol-v4 holder through the release builder',
    async () => {
      const outputRoot = mkdtempSync(join(tmpdir(), 'desk-moor-release-build-'));
      const outfile = join(outputRoot, 'moor');
      const sessionPath = join(outputRoot, 'distribution-v4');
      const storeRoot = join(
        moorEventStoreRoot(outfile, { tmpdir: outputRoot }),
        'distribution-v4.events'
      );
      const runtimeEnv = { ...process.env, TMPDIR: outputRoot };
      let holderStarted = false;
      try {
        const { provenance } = buildMoor({ root: ROOT, outfile });
        expect(provenance.commit).toBe(REQUIRED_VENDOR_COMMIT);

        const artifact = statSync(outfile);
        expect(artifact.isFile()).toBe(true);
        expect(artifact.size).toBeGreaterThan(0);
        if (process.platform !== 'win32') expect(artifact.mode & 0o111).not.toBe(0);

        const version = spawnSync(outfile, ['--version'], { encoding: 'utf8' });
        expect(version.status).toBe(0);
        expect(version.stdout.trim()).toBe(`moor ${EXPECTED_VERSION}`);

        // The rendezvous wire witness is POSIX-only. Linux CI exercises the
        // freshly built binary's protocol dialect rather than its host-specific bytes.
        if (process.platform === 'win32') return;

        const started = spawnSync(
          outfile,
          ['start', '-T', storeRoot, sessionPath, 'sh', '-c', 'cat'],
          {
            encoding: 'utf8',
            env: runtimeEnv,
            timeout: 10_000
          }
        );
        expect(started.error).toBeUndefined();
        expect(started.status, started.stderr).toBe(0);
        holderStarted = true;

        const firstV4 = await exchangeHello(sessionPath, 4);
        expect(firstV4.kind).toBe(MoorKind.HELLO_ACK);
        expect(firstV4.scope).toBeGreaterThan(0);
        expect(firstV4.payload[0]).toBe(4);

        const v3Refusal = await exchangeHello(sessionPath, 3);
        expect(v3Refusal).toMatchObject({
          scope: firstV4.scope,
          kind: MoorKind.ERROR
        });
        expect(
          new DataView(
            v3Refusal.payload.buffer,
            v3Refusal.payload.byteOffset,
            v3Refusal.payload.byteLength
          ).getUint16(
            0,
            true
          )
        ).toBe(1);

        const secondV4 = await exchangeHello(sessionPath, 4);
        expect(secondV4).toMatchObject({
          scope: firstV4.scope,
          kind: MoorKind.HELLO_ACK
        });
        expect(secondV4.payload[0]).toBe(4);
      } finally {
        if (holderStarted) {
          spawnSync(outfile, ['kill', '-f', sessionPath], {
            encoding: 'utf8',
            env: runtimeEnv,
            timeout: 10_000
          });
        }
        rmSync(outputRoot, { recursive: true, force: true });
      }
    },
    90_000
  );
});

describe.skipIf(!existsSync(BUNDLED))('moor distribution contract — built artifact', () => {
  it('libexec/moor is the pinned holder and answers as moor', () => {
    const result = spawnSync(BUNDLED, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`moor ${EXPECTED_VERSION}`);
  });
});
