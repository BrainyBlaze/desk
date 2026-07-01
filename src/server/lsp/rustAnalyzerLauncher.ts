import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';

export const RUST_ANALYZER_RELEASE = {
  tag: '2026-06-15',
  upstreamVersion: '0.3.2937'
} as const;

const RELEASE_BASE_URL = `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE.tag}`;
const DEFAULT_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 96 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 25;

export interface RustAnalyzerAsset {
  key: string;
  platform: NodeJS.Platform | string;
  arch: NodeJS.Architecture | string;
  libc?: 'gnu' | 'musl';
  assetName: string;
  url: string;
  sha256: string;
  archiveKind: 'gzip' | 'zip';
  binaryName: string;
  maxDownloadBytes: number;
  maxDecompressedBytes: number;
}

export interface ResolveRustAnalyzerAssetInput {
  platform?: NodeJS.Platform | string;
  arch?: NodeJS.Architecture | string;
  libc?: 'gnu' | 'musl';
}

export interface EnsureRustAnalyzerBinaryOptions {
  cacheRoot?: string;
  asset?: RustAnalyzerAsset;
  platform?: NodeJS.Platform | string;
  arch?: NodeJS.Architecture | string;
  libc?: 'gnu' | 'musl';
  download?: (url: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<Buffer>;
  now?: () => number;
}

export interface EnsureRustAnalyzerBinaryResult {
  path: string;
  cacheHit: boolean;
  asset: RustAnalyzerAsset;
}

const RUST_ANALYZER_ASSETS: RustAnalyzerAsset[] = [
  gzipAsset({
    key: 'linux-x64-gnu',
    platform: 'linux',
    arch: 'x64',
    libc: 'gnu',
    assetName: 'rust-analyzer-x86_64-unknown-linux-gnu.gz',
    sha256: 'a295578310361680eda4116b90b113126253278b9806b176faa46af3c451905d'
  }),
  gzipAsset({
    key: 'linux-x64-musl',
    platform: 'linux',
    arch: 'x64',
    libc: 'musl',
    assetName: 'rust-analyzer-x86_64-unknown-linux-musl.gz',
    sha256: 'e05aaeb73deb773d23efaa78bea042b99523444f3244da1bd2bb798af5ecacb1'
  }),
  gzipAsset({
    key: 'linux-arm64-gnu',
    platform: 'linux',
    arch: 'arm64',
    libc: 'gnu',
    assetName: 'rust-analyzer-aarch64-unknown-linux-gnu.gz',
    sha256: '42a76674f75cf9cbb504e05738d881d00dba26c85ac2bbdc3719f423b0d0b558'
  }),
  gzipAsset({
    key: 'linux-arm-gnueabihf',
    platform: 'linux',
    arch: 'arm',
    libc: 'gnu',
    assetName: 'rust-analyzer-arm-unknown-linux-gnueabihf.gz',
    sha256: '0f653a273333cfe337818ab00592d96be5a5e6f949ca0141924180e6c055633a'
  }),
  gzipAsset({
    key: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    assetName: 'rust-analyzer-x86_64-apple-darwin.gz',
    sha256: 'bc97e13bc7747bcda7ae97173fad3f2b8ac32fab21c801684dded4e72871d17d'
  }),
  gzipAsset({
    key: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    assetName: 'rust-analyzer-aarch64-apple-darwin.gz',
    sha256: '626213c6c91ae76429942d713a53a95513e2fe9938110fecfcb50552f01d608a'
  }),
  zipAsset({
    key: 'win32-x64-msvc',
    platform: 'win32',
    arch: 'x64',
    assetName: 'rust-analyzer-x86_64-pc-windows-msvc.zip',
    sha256: '0f82e470220986a6b71202f135fe80233fc3baaffb84900f2f19388ba85cbb41'
  }),
  zipAsset({
    key: 'win32-arm64-msvc',
    platform: 'win32',
    arch: 'arm64',
    assetName: 'rust-analyzer-aarch64-pc-windows-msvc.zip',
    sha256: '71ca233a9994c4119d10fea2d9b4f891a938c9957e86568061a9d6993140fe87'
  })
];

function gzipAsset(input: {
  key: string;
  platform: NodeJS.Platform | string;
  arch: NodeJS.Architecture | string;
  libc?: 'gnu' | 'musl';
  assetName: string;
  sha256: string;
}): RustAnalyzerAsset {
  return {
    ...input,
    url: `${RELEASE_BASE_URL}/${input.assetName}`,
    archiveKind: 'gzip',
    binaryName: 'rust-analyzer',
    maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
    maxDecompressedBytes: DEFAULT_MAX_DECOMPRESSED_BYTES
  };
}

function zipAsset(input: {
  key: string;
  platform: NodeJS.Platform | string;
  arch: NodeJS.Architecture | string;
  assetName: string;
  sha256: string;
}): RustAnalyzerAsset {
  return {
    ...input,
    url: `${RELEASE_BASE_URL}/${input.assetName}`,
    archiveKind: 'zip',
    binaryName: 'rust-analyzer.exe',
    maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
    maxDecompressedBytes: DEFAULT_MAX_DECOMPRESSED_BYTES
  };
}

export function resolveRustAnalyzerAsset(input: ResolveRustAnalyzerAssetInput = {}): RustAnalyzerAsset | undefined {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const libc = input.libc ?? detectLinuxLibc();
  return RUST_ANALYZER_ASSETS.find(
    (asset) => asset.platform === platform && asset.arch === arch && (asset.platform !== 'linux' || asset.libc === libc)
  );
}

export function rustAnalyzerDefaultCacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim() !== '' ? process.env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return join(base, 'desk', 'lsp', 'rust-analyzer');
}

export async function ensureRustAnalyzerBinary(
  options: EnsureRustAnalyzerBinaryOptions = {}
): Promise<EnsureRustAnalyzerBinaryResult> {
  const asset = options.asset ?? resolveRustAnalyzerAsset(options);
  if (!asset) {
    throw resolverError();
  }
  const cacheRoot = options.cacheRoot ?? rustAnalyzerDefaultCacheRoot();
  const dir = join(cacheRoot, RUST_ANALYZER_RELEASE.tag, asset.key);
  const finalPath = join(dir, asset.binaryName);
  if (isUsableBinary(finalPath)) {
    return { path: finalPath, cacheHit: true, asset };
  }

  await withInstallLock(`${finalPath}.lock`, options.now ?? Date.now, async () => {
    if (isUsableBinary(finalPath)) {
      return;
    }
    await installRustAnalyzerBinary({
      asset,
      finalPath,
      download: options.download ?? downloadBytes
    });
  });

  if (!isUsableBinary(finalPath)) {
    throw resolverError();
  }
  return { path: finalPath, cacheHit: false, asset };
}

async function installRustAnalyzerBinary(input: {
  asset: RustAnalyzerAsset;
  finalPath: string;
  download: (url: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<Buffer>;
}): Promise<void> {
  const { asset, finalPath, download } = input;
  const tempDir = `${finalPath}.install-${process.pid}-${Date.now()}`;
  const tempPath = join(tempDir, asset.binaryName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    mkdirSync(tempDir, { recursive: true });
    const archive = await download(asset.url, { signal: controller.signal, maxBytes: asset.maxDownloadBytes });
    if (archive.length > asset.maxDownloadBytes || sha256(archive) !== asset.sha256) {
      throw resolverError();
    }
    const binary = extractRustAnalyzerBinary(archive, asset);
    mkdirSync(dirname(finalPath), { recursive: true });
    await writeFile(tempPath, binary, { mode: 0o600 });
    await chmod(tempPath, 0o755);
    await rename(tempPath, finalPath);
  } catch {
    await rm(finalPath, { force: true }).catch(() => undefined);
    throw resolverError();
  } finally {
    clearTimeout(timeout);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extractRustAnalyzerBinary(archive: Buffer, asset: RustAnalyzerAsset): Buffer {
  if (asset.archiveKind === 'zip') {
    return extractZipBinary(archive, asset);
  }
  const binary = gunzipSync(archive);
  if (binary.length === 0 || binary.length > asset.maxDecompressedBytes) {
    throw resolverError();
  }
  return binary;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function extractZipBinary(archive: Buffer, asset: RustAnalyzerAsset): Buffer {
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) {
    throw resolverError();
  }
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  let selected: ZipEntry | undefined;
  let fileEntries = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw resolverError();
    }
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length) {
      throw resolverError();
    }
    const name = archive.subarray(nameStart, nameEnd).toString('utf8');
    offset = nameEnd + extraLength + commentLength;
    if (name.endsWith('/')) {
      continue;
    }
    fileEntries += 1;
    if (name !== asset.binaryName || isUnsafeZipName(name) || isZipSymlink(externalAttributes)) {
      throw resolverError();
    }
    selected = { name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset };
  }

  if (!selected || fileEntries !== 1 || selected.uncompressedSize > asset.maxDecompressedBytes) {
    throw resolverError();
  }
  const binary = readZipEntryBytes(archive, selected);
  if (binary.length === 0 || binary.length !== selected.uncompressedSize || binary.length > asset.maxDecompressedBytes) {
    throw resolverError();
  }
  return binary;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function readZipEntryBytes(archive: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) {
    throw resolverError();
  }
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) {
    throw resolverError();
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    return Buffer.from(compressed);
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressed);
  }
  throw resolverError();
}

function isUnsafeZipName(name: string): boolean {
  return name === '' || name.includes('/') || name.includes('\\') || name === '..' || name.startsWith('..');
}

function isZipSymlink(externalAttributes: number): boolean {
  return ((externalAttributes >>> 16) & 0o170000) === 0o120000;
}

async function withInstallLock(lockPath: string, now: () => number, action: () => Promise<void>): Promise<void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  while (true) {
    const fd = tryCreateLock(lockPath);
    if (fd !== undefined) {
      try {
        await action();
        return;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // The lock file descriptor is best-effort cleanup after the install attempt.
        }
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    }
    clearStaleLock(lockPath, now);
    await sleep(LOCK_POLL_MS);
  }
}

function tryCreateLock(lockPath: string): number | undefined {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, `${process.pid}\n`);
    return fd;
  } catch {
    return undefined;
  }
}

function clearStaleLock(lockPath: string, now: () => number): void {
  try {
    const stat = statSync(lockPath);
    if (now() - stat.mtimeMs > LOCK_STALE_MS) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // Another process may have removed the lock.
  }
}

async function downloadBytes(url: string, options: { signal: AbortSignal; maxBytes: number }): Promise<Buffer> {
  const response = await fetch(url, { signal: options.signal, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw resolverError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > options.maxBytes) {
      throw resolverError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function runLauncher(args: string[]): Promise<number> {
  try {
    const resolved = await ensureRustAnalyzerBinary();
    await new Promise<void>((resolve) => {
      const child = spawn(resolved.path, args, {
        stdio: 'inherit',
        shell: false
      });
      child.once('exit', (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 1;
        resolve();
      });
      child.once('error', () => {
        process.exitCode = 1;
        resolve();
      });
    });
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch {
    process.stderr.write('rust-analyzer resolver failed\n');
    return 1;
  }
}

function isUsableBinary(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function detectLinuxLibc(): 'gnu' | 'musl' {
  if (process.platform !== 'linux') {
    return 'gnu';
  }
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  const header = report?.header;
  return typeof header?.glibcVersionRuntime === 'string' ? 'gnu' : 'musl';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolverError(): Error {
  return new Error('rust-analyzer resolver failed');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLauncher(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
