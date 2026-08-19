// Distribution contract for the bundled moor holder: the vendored source
// snapshot is PROVENANCE-pinned (repository/commit/version + a content
// digest), the build script refuses drift, and the release ships ONLY the
// `moor` name — no compatibility binary is ever built or shipped. Building is
// exercised by `npm run fetch:moor` on developer/CI hosts; this contract
// validates the pinned inputs and the release builder's executable output.

import { execFile, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  readProvenance,
  snapshotDigest,
  validateVendor
} from '../scripts/build-moor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor', 'moor');
const BUNDLED = join(ROOT, 'libexec', 'moor');
const REQUIRED_VENDOR_COMMIT = '161de09f691d3a1bcd7cfca34070e0ccf537b988';
const REQUIRED_SNAPSHOT_DIGEST = 'e9c8703ab67fd077d2b168b39e0b176c12575d448d82310fcb3462922541b08b';
const BUILD_MOOR_URL = new URL('../scripts/build-moor.mjs', import.meta.url).href;
const execFileAsync = promisify(execFile);

interface ReleaseBuildResult {
  provenance: { commit: string };
}

async function buildMoorInChild(outfile: string): Promise<ReleaseBuildResult> {
  const invocation = [
    `import { buildMoor } from ${JSON.stringify(BUILD_MOOR_URL)};`,
    `const result = buildMoor(${JSON.stringify({ root: ROOT, outfile })});`,
    'process.stdout.write(JSON.stringify(result));'
  ].join('\n');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', invocation],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout) as ReleaseBuildResult;
}

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

  it('does not depend on equivalent snapshot root spellings', () => {
    const relativeVendor = relative(process.cwd(), VENDOR);

    expect(snapshotDigest(`./${relativeVendor}`)).toBe(snapshotDigest(VENDOR));
  });

  it('distinguishes literal backslashes from directory separators in snapshot paths', () => {
    const literalRoot = mkdtempSync(join(tmpdir(), 'desk-moor-literal-path-'));
    const nestedRoot = mkdtempSync(join(tmpdir(), 'desk-moor-nested-path-'));
    try {
      writeFileSync(join(literalRoot, 'a\\b'), 'same contents\n');
      mkdirSync(join(nestedRoot, 'a'));
      writeFileSync(join(nestedRoot, 'a', 'b'), 'same contents\n');

      expect(snapshotDigest(literalRoot)).not.toBe(snapshotDigest(nestedRoot));
    } finally {
      rmSync(literalRoot, { recursive: true, force: true });
      rmSync(nestedRoot, { recursive: true, force: true });
    }
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
        // Keep the Vitest worker responsive while the release builder performs
        // its intentionally synchronous Cargo build in an isolated child.
        const { provenance } = await buildMoorInChild(outfile);
        expect(provenance.commit).toBe(REQUIRED_VENDOR_COMMIT);

        const artifact = statSync(outfile);
        expect(artifact.isFile()).toBe(true);
        expect(artifact.size).toBeGreaterThan(0);
        expect(artifact.mode & 0o111).not.toBe(0);

        const version = spawnSync(outfile, ['--version'], { encoding: 'utf8' });
        expect(version.status).toBe(0);
        expect(version.stdout.trim()).toBe(`moor ${EXPECTED_VERSION}`);

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
    120_000
  );
});

describe.skipIf(!existsSync(BUNDLED))('moor distribution contract — built artifact', () => {
  it('libexec/moor is the pinned holder and answers as moor', () => {
    const result = spawnSync(BUNDLED, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`moor ${EXPECTED_VERSION}`);
  });
});
