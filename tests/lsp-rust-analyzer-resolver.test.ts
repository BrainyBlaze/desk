import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUST_ANALYZER_RELEASE,
  ensureRustAnalyzerBinary,
  resolveRustAnalyzerAsset,
  type RustAnalyzerAsset
} from '../src/server/lsp/rustAnalyzerLauncher';

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `desk-rust-analyzer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gzipAsset(bytes: Buffer): { asset: RustAnalyzerAsset; archive: Buffer } {
  const archive = gzipSync(bytes);
  return {
    archive,
    asset: {
      key: 'test-linux-x64',
      platform: 'linux',
      arch: 'x64',
      assetName: 'rust-analyzer-test.gz',
      url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE.tag}/rust-analyzer-test.gz`,
      sha256: cryptoHash(archive),
      archiveKind: 'gzip',
      binaryName: 'rust-analyzer',
      maxDownloadBytes: archive.length + 16,
      maxDecompressedBytes: bytes.length + 16
    }
  };
}

function zipAsset(name: string, bytes: Buffer, externalAttributes = 0): { asset: RustAnalyzerAsset; archive: Buffer } {
  const archive = createStoredZip(name, bytes, externalAttributes);
  return {
    archive,
    asset: {
      key: 'test-win32-x64',
      platform: 'win32',
      arch: 'x64',
      assetName: 'rust-analyzer-test.zip',
      url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE.tag}/rust-analyzer-test.zip`,
      sha256: cryptoHash(archive),
      archiveKind: 'zip',
      binaryName: 'rust-analyzer.exe',
      maxDownloadBytes: archive.length + 16,
      maxDecompressedBytes: bytes.length + 16
    }
  };
}

function cryptoHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('rust-analyzer built-in resolver metadata', () => {
  it('pins one exact official release and resolves the current Linux x64 asset without querying latest', () => {
    expect(RUST_ANALYZER_RELEASE).toMatchObject({
      tag: '2026-06-15',
      upstreamVersion: '0.3.2937'
    });
    const asset = resolveRustAnalyzerAsset({ platform: 'linux', arch: 'x64', libc: 'gnu' });
    expect(asset).toMatchObject({
      assetName: 'rust-analyzer-x86_64-unknown-linux-gnu.gz',
      archiveKind: 'gzip',
      binaryName: 'rust-analyzer',
      sha256: 'a295578310361680eda4116b90b113126253278b9806b176faa46af3c451905d'
    });
    expect(asset?.url).toBe(
      'https://github.com/rust-lang/rust-analyzer/releases/download/2026-06-15/rust-analyzer-x86_64-unknown-linux-gnu.gz'
    );
  });

  it('fails closed for unsupported platforms instead of falling back to PATH or rustup', () => {
    expect(resolveRustAnalyzerAsset({ platform: 'sunos', arch: 'x64', libc: 'gnu' })).toBeUndefined();
  });

  it('pins the official Windows zip asset metadata without making PATH a fallback', () => {
    const asset = resolveRustAnalyzerAsset({ platform: 'win32', arch: 'x64' });
    expect(asset).toMatchObject({
      assetName: 'rust-analyzer-x86_64-pc-windows-msvc.zip',
      archiveKind: 'zip',
      binaryName: 'rust-analyzer.exe',
      sha256: '0f82e470220986a6b71202f135fe80233fc3baaffb84900f2f19388ba85cbb41'
    });
  });
});

function createStoredZip(name: string, bytes: Buffer, externalAttributes: number): Buffer {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBytes.length + bytes.length);
  let offset = 0;
  local.writeUInt32LE(0x04034b50, offset);
  offset += 4;
  local.writeUInt16LE(20, offset);
  offset += 2;
  local.writeUInt16LE(0, offset);
  offset += 2;
  local.writeUInt16LE(0, offset);
  offset += 2;
  local.writeUInt16LE(0, offset);
  offset += 2;
  local.writeUInt16LE(0, offset);
  offset += 2;
  local.writeUInt32LE(0, offset);
  offset += 4;
  local.writeUInt32LE(bytes.length, offset);
  offset += 4;
  local.writeUInt32LE(bytes.length, offset);
  offset += 4;
  local.writeUInt16LE(nameBytes.length, offset);
  offset += 2;
  local.writeUInt16LE(0, offset);
  offset += 2;
  nameBytes.copy(local, offset);
  offset += nameBytes.length;
  bytes.copy(local, offset);

  const central = Buffer.alloc(46 + nameBytes.length);
  offset = 0;
  central.writeUInt32LE(0x02014b50, offset);
  offset += 4;
  central.writeUInt16LE(20, offset);
  offset += 2;
  central.writeUInt16LE(20, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt32LE(0, offset);
  offset += 4;
  central.writeUInt32LE(bytes.length, offset);
  offset += 4;
  central.writeUInt32LE(bytes.length, offset);
  offset += 4;
  central.writeUInt16LE(nameBytes.length, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt16LE(0, offset);
  offset += 2;
  central.writeUInt32LE(externalAttributes >>> 0, offset);
  offset += 4;
  central.writeUInt32LE(0, offset);
  offset += 4;
  nameBytes.copy(central, offset);

  const end = Buffer.alloc(22);
  offset = 0;
  end.writeUInt32LE(0x06054b50, offset);
  offset += 4;
  end.writeUInt16LE(0, offset);
  offset += 2;
  end.writeUInt16LE(0, offset);
  offset += 2;
  end.writeUInt16LE(1, offset);
  offset += 2;
  end.writeUInt16LE(1, offset);
  offset += 2;
  end.writeUInt32LE(central.length, offset);
  offset += 4;
  end.writeUInt32LE(local.length, offset);
  offset += 4;
  end.writeUInt16LE(0, offset);
  return Buffer.concat([local, central, end]);
}

describe('ensureRustAnalyzerBinary', () => {
  it('uses a verified cached binary without downloading', async () => {
    const { asset } = gzipAsset(Buffer.from('unused'));
    const finalPath = join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName);
    mkdirSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key), { recursive: true });
    writeFileSync(finalPath, 'cached');
    chmodSync(finalPath, 0o755);

    const result = await ensureRustAnalyzerBinary({
      cacheRoot: root,
      asset,
      download: async () => {
        throw new Error('download should not run');
      }
    });

    expect(result).toEqual({ path: finalPath, cacheHit: true, asset });
  });

  it('does not trust a non-executable cached file on Unix', async () => {
    const expectedBinary = Buffer.from('#!/bin/sh\nexit 0\n');
    const { asset, archive } = gzipAsset(expectedBinary);
    const finalPath = join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName);
    mkdirSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key), { recursive: true });
    writeFileSync(finalPath, 'partial');
    chmodSync(finalPath, 0o600);
    let downloads = 0;

    const result = await ensureRustAnalyzerBinary({
      cacheRoot: root,
      asset,
      download: async () => {
        downloads += 1;
        return archive;
      }
    });

    expect(downloads).toBe(process.platform === 'win32' ? 0 : 1);
    if (process.platform !== 'win32') {
      expect(result.cacheHit).toBe(false);
      expect(readFileSync(result.path)).toEqual(expectedBinary);
    }
  });

  it('downloads, verifies, extracts, chmods, and atomically installs a gzip binary', async () => {
    const expectedBinary = Buffer.from('#!/bin/sh\nexit 0\n');
    const { asset, archive } = gzipAsset(expectedBinary);

    const result = await ensureRustAnalyzerBinary({
      cacheRoot: root,
      asset,
      download: async (url) => {
        expect(url).toBe(asset.url);
        return archive;
      }
    });

    expect(result.cacheHit).toBe(false);
    expect(readFileSync(result.path)).toEqual(expectedBinary);
    expect(statSync(result.path).mode & 0o111).not.toBe(0);
    expect(existsSync(`${result.path}.tmp`)).toBe(false);
  });

  it('rejects checksum failures without leaving a final binary', async () => {
    const { asset, archive } = gzipAsset(Buffer.from('binary'));
    const badAsset = { ...asset, sha256: '0'.repeat(64) };

    await expect(
      ensureRustAnalyzerBinary({
        cacheRoot: root,
        asset: badAsset,
        download: async () => archive
      })
    ).rejects.toThrow('rust-analyzer resolver failed');

    expect(existsSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName))).toBe(false);
  });

  it('rejects oversized downloads and leaves no final binary', async () => {
    const { asset, archive } = gzipAsset(Buffer.from('binary'));
    await expect(
      ensureRustAnalyzerBinary({
        cacheRoot: root,
        asset: { ...asset, maxDownloadBytes: archive.length - 1 },
        download: async () => archive
      })
    ).rejects.toThrow('rust-analyzer resolver failed');

    expect(existsSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName))).toBe(false);
  });

  it('rejects oversized decompressed binaries and leaves no final binary', async () => {
    const { asset, archive } = gzipAsset(Buffer.from('binary'));
    await expect(
      ensureRustAnalyzerBinary({
        cacheRoot: root,
        asset: { ...asset, maxDecompressedBytes: 1 },
        download: async () => archive
      })
    ).rejects.toThrow('rust-analyzer resolver failed');

    expect(existsSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName))).toBe(false);
  });

  it('extracts exactly the expected binary from a valid zip archive', async () => {
    const expectedBinary = Buffer.from('MZ-binary');
    const { asset, archive } = zipAsset('rust-analyzer.exe', expectedBinary);

    const result = await ensureRustAnalyzerBinary({
      cacheRoot: root,
      asset,
      download: async () => archive
    });

    expect(result.cacheHit).toBe(false);
    expect(readFileSync(result.path)).toEqual(expectedBinary);
    expect(result.path.endsWith('rust-analyzer.exe')).toBe(true);
  });

  it('rejects zip path traversal entries and leaves no final binary', async () => {
    const { asset, archive } = zipAsset('../rust-analyzer.exe', Buffer.from('binary'));

    await expect(
      ensureRustAnalyzerBinary({
        cacheRoot: root,
        asset,
        download: async () => archive
      })
    ).rejects.toThrow('rust-analyzer resolver failed');

    expect(existsSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName))).toBe(false);
  });

  it('rejects zip symlink entries and leaves no final binary', async () => {
    const symlinkFileType = 0o120000 << 16;
    const { asset, archive } = zipAsset('rust-analyzer.exe', Buffer.from('target'), symlinkFileType);

    await expect(
      ensureRustAnalyzerBinary({
        cacheRoot: root,
        asset,
        download: async () => archive
      })
    ).rejects.toThrow('rust-analyzer resolver failed');

    expect(existsSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName))).toBe(false);
  });

  it('keeps offline/download failures sanitized and leaves no final binary', async () => {
    const { asset } = gzipAsset(Buffer.from('binary'));
    let error: Error | undefined;
    try {
      await ensureRustAnalyzerBinary({
        cacheRoot: root,
        asset,
        download: async () => {
          throw new Error(`network failed for ${asset.url} under ${root}`);
        }
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toBe('rust-analyzer resolver failed');
    expect(error?.message).not.toContain(asset.url);
    expect(error?.message).not.toContain(root);
    expect(existsSync(join(root, RUST_ANALYZER_RELEASE.tag, asset.key, asset.binaryName))).toBe(false);
  });

  it('serializes concurrent cache misses through a lock and downloads only once', async () => {
    const { asset, archive } = gzipAsset(Buffer.from('binary'));
    let downloads = 0;

    const download = async () => {
      downloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return archive;
    };

    const [first, second] = await Promise.all([
      ensureRustAnalyzerBinary({ cacheRoot: root, asset, download }),
      ensureRustAnalyzerBinary({ cacheRoot: root, asset, download })
    ]);

    expect(downloads).toBe(1);
    expect(first.path).toBe(second.path);
    expect(readFileSync(first.path)).toEqual(Buffer.from('binary'));
  });

  it('clears stale locks without executing or trusting partial files', async () => {
    const { asset, archive } = gzipAsset(Buffer.from('binary'));
    const finalDir = join(root, RUST_ANALYZER_RELEASE.tag, asset.key);
    const finalPath = join(finalDir, asset.binaryName);
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(`${finalPath}.lock`, 'stale lock');
    writeFileSync(`${finalPath}.install-partial`, 'partial');
    utimesSync(`${finalPath}.lock`, new Date(0), new Date(0));

    const result = await ensureRustAnalyzerBinary({
      cacheRoot: root,
      asset,
      now: () => 1_000_000_000,
      download: async () => archive
    });

    expect(result.path).toBe(finalPath);
    expect(readFileSync(result.path)).toEqual(Buffer.from('binary'));
    expect(existsSync(`${finalPath}.lock`)).toBe(false);
    expect(readFileSync(`${finalPath}.install-partial`, 'utf8')).toBe('partial');
  });
});
