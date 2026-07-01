import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, hostname, loadavg, platform, release, uptime } from 'node:os';
import { promisify } from 'node:util';
import type { DiskMetrics, GpuMetrics, MemoryMetrics, NetworkMetrics, SystemSnapshot } from '../shared/systemMetrics.js';

const execFileAsync = promisify(execFile);
const NVIDIA_SMI_TIMEOUT_MS = 2500;

export interface CpuTimes {
  idle: number;
  total: number;
}

interface NetSample extends NetworkMetrics {
  sampledAtMs: number;
}

interface DiskIoSample {
  readBytes: number;
  writeBytes: number;
  sampledAtMs: number;
}

let previousCpu: CpuTimes | undefined;
let previousNet: NetSample | undefined;
let previousDiskIo: DiskIoSample | undefined;

/**
 * /proc reads + CPU/net/disk delta accounting are cheap (microseconds) and stay
 * synchronous; only the GPU readers shell out, so the core takes the already-read
 * GPU metrics and both the sync and async wrappers supply them their own way. The
 * delta state (previousCpu/net/disk) lives module-level and is touched once per
 * snapshot regardless of wrapper.
 */
function collectSystemSnapshotCore(gpu: { nvidia: GpuMetrics; intel: GpuMetrics }): SystemSnapshot {
  const currentCpu = parseProcStat(readText('/proc/stat'));
  const cpuUsage = currentCpu && previousCpu ? calculateCpuUsage(previousCpu, currentCpu) : undefined;
  if (currentCpu) {
    previousCpu = currentCpu;
  }

  const net = sampleNetwork();
  const loadAverage = loadavg() as [number, number, number];
  const threads = Math.max(cpus().length, 1);

  return {
    generatedAt: new Date().toISOString(),
    hostname: hostname(),
    platform: platform(),
    kernel: release(),
    uptimeSeconds: uptime(),
    cpu: {
      threads,
      usagePercent: cpuUsage,
      loadAverage,
      loadPercent: clampPercent((loadAverage[0] / threads) * 100)
    },
    memory: parseMemInfo(readText('/proc/meminfo')),
    network: net,
    disk: sampleDisk(),
    gpu
  };
}

export function collectSystemSnapshot(): SystemSnapshot {
  return collectSystemSnapshotCore({ nvidia: readNvidiaGpu(), intel: readIntelGpu() });
}

/**
 * Non-blocking snapshot: the GPU readers run as async child processes off the
 * event loop, so the background sampler never stalls the loop that carries every
 * terminal websocket byte (the round-2 finding — a synchronous nvidia-smi inside
 * the pulse blocked all streams ~70ms/tick).
 */
export async function collectSystemSnapshotAsync(): Promise<SystemSnapshot> {
  const [nvidia, intel] = await Promise.all([readNvidiaGpuAsync(), readIntelGpuAsync()]);
  return collectSystemSnapshotCore({ nvidia, intel });
}

export function calculateCpuUsage(previous: CpuTimes, current: CpuTimes): number {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) {
    return 0;
  }
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function parseProcStat(source: string): CpuTimes | undefined {
  const line = source.split('\n').find((candidate) => candidate.startsWith('cpu '));
  if (!line) {
    return undefined;
  }
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

export function parseMemInfo(source: string): MemoryMetrics {
  const fields = new Map<string, number>();
  for (const line of source.split('\n')) {
    const match = /^([^:]+):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match) {
      fields.set(match[1]!, Number(match[2]) * 1024);
    }
  }
  const totalBytes = fields.get('MemTotal') ?? 0;
  const availableBytes = fields.get('MemAvailable') ?? 0;
  const usedBytes = Math.max(totalBytes - availableBytes, 0);
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0
  };
}

export function parseNetDev(source: string): NetworkMetrics {
  const interfaces: string[] = [];
  let rxBytes = 0;
  let txBytes = 0;

  for (const line of source.split('\n')) {
    if (!line.includes(':')) {
      continue;
    }
    const [rawName, rawCounters] = line.split(':');
    const name = rawName?.trim();
    if (!name || name === 'lo' || name.startsWith('loopback')) {
      continue;
    }
    const counters = rawCounters?.trim().split(/\s+/).map(Number) ?? [];
    const rx = counters[0];
    const tx = counters[8];
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) {
      continue;
    }
    interfaces.push(name);
    rxBytes += rx;
    txBytes += tx;
  }

  return { rxBytes, txBytes, interfaces };
}

export function parseNvidiaSmiCsv(source: string): GpuMetrics {
  const line = source.trim().split('\n').find(Boolean);
  if (!line) {
    return { available: false, reason: 'no output' };
  }
  const [name, gpu, memory, used, total, temp, power, limit] = line.split(',').map((value) => value.trim());
  return {
    available: true,
    name,
    utilizationGpuPercent: parseOptionalNumber(gpu),
    utilizationMemoryPercent: parseOptionalNumber(memory),
    memoryUsedMiB: parseOptionalNumber(used),
    memoryTotalMiB: parseOptionalNumber(total),
    temperatureC: parseOptionalNumber(temp),
    powerDrawW: parseOptionalNumber(power),
    powerLimitW: parseOptionalNumber(limit)
  };
}

/**
 * Whole-disk I/O counters from /proc/diskstats: physical devices only
 * (sda, nvme0n1, vda, mmcblk0...) — counting partitions too would double
 * every byte. Sectors are a fixed 512 bytes in this file regardless of the
 * device's real sector size.
 */
export function parseDiskStats(source: string): { readBytes: number; writeBytes: number } {
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of source.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) {
      continue;
    }
    const name = fields[2]!;
    if (!/^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)) {
      continue;
    }
    const sectorsRead = Number(fields[5]);
    const sectorsWritten = Number(fields[9]);
    if (Number.isFinite(sectorsRead)) {
      readBytes += sectorsRead * 512;
    }
    if (Number.isFinite(sectorsWritten)) {
      writeBytes += sectorsWritten * 512;
    }
  }
  return { readBytes, writeBytes };
}

function sampleDisk(): DiskMetrics {
  const usage = readRootUsage();
  const current: DiskIoSample = { ...parseDiskStats(readText('/proc/diskstats')), sampledAtMs: Date.now() };
  const previous = previousDiskIo;
  previousDiskIo = current;
  if (!previous) {
    return usage;
  }
  const seconds = Math.max((current.sampledAtMs - previous.sampledAtMs) / 1000, 0.001);
  return {
    ...usage,
    readBytesPerSecond: Math.max((current.readBytes - previous.readBytes) / seconds, 0),
    writeBytesPerSecond: Math.max((current.writeBytes - previous.writeBytes) / seconds, 0)
  };
}

function readRootUsage(): DiskMetrics {
  try {
    const stats = statfsSync('/');
    const totalBytes = stats.blocks * stats.bsize;
    // total - bfree counts the root reserve as used, matching df's % output.
    const usedBytes = Math.max((stats.blocks - stats.bfree) * stats.bsize, 0);
    return {
      totalBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0
    };
  } catch {
    return { totalBytes: 0, usedBytes: 0, usedPercent: 0 };
  }
}

function sampleNetwork(): NetworkMetrics {
  const current = { ...parseNetDev(readText('/proc/net/dev')), sampledAtMs: Date.now() };
  const previous = previousNet;
  previousNet = current;
  const { sampledAtMs: _sampledAtMs, ...network } = current;
  if (!previous) {
    return network;
  }
  const seconds = Math.max((current.sampledAtMs - previous.sampledAtMs) / 1000, 0.001);
  return {
    ...network,
    rxBytesPerSecond: Math.max((current.rxBytes - previous.rxBytes) / seconds, 0),
    txBytesPerSecond: Math.max((current.txBytes - previous.txBytes) / seconds, 0)
  };
}

function readNvidiaGpu(): GpuMetrics {
  if (!commandExists('nvidia-smi')) {
    return { available: false, reason: 'nvidia-smi unavailable' };
  }
  const result = spawnSync(
    'nvidia-smi',
    [
      '--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
      '--format=csv,noheader,nounits'
    ],
    { encoding: 'utf8', timeout: NVIDIA_SMI_TIMEOUT_MS }
  );
  if (result.error) {
    return { available: false, reason: gpuCommandErrorReason(result.error, 'nvidia-smi failed') };
  }
  if (result.status !== 0 || !result.stdout.trim()) {
    return { available: false, reason: result.stderr.trim() || 'nvidia-smi failed' };
  }
  return parseNvidiaSmiCsv(result.stdout);
}

function readIntelGpu(): GpuMetrics {
  if (!commandExists('intel_gpu_top')) {
    return { available: false, reason: 'intel_gpu_top unavailable' };
  }
  const result = spawnSync('intel_gpu_top', ['-J', '-s', '250', '-o', '-'], { encoding: 'utf8', timeout: 1200 });
  if (result.status !== 0 || !result.stdout.trim()) {
    return { available: false, reason: result.stderr.trim() || 'intel_gpu_top failed' };
  }
  return parseIntelGpuTop(result.stdout);
}

async function readNvidiaGpuAsync(): Promise<GpuMetrics> {
  if (!commandExists('nvidia-smi')) {
    return { available: false, reason: 'nvidia-smi unavailable' };
  }
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
        '--format=csv,noheader,nounits'
      ],
      { encoding: 'utf8', timeout: NVIDIA_SMI_TIMEOUT_MS }
    );
    if (!stdout.trim()) {
      return { available: false, reason: 'nvidia-smi produced no output' };
    }
    return parseNvidiaSmiCsv(stdout);
  } catch (error) {
    return { available: false, reason: gpuCommandErrorReason(error, 'nvidia-smi failed') };
  }
}

async function readIntelGpuAsync(): Promise<GpuMetrics> {
  if (!commandExists('intel_gpu_top')) {
    return { available: false, reason: 'intel_gpu_top unavailable' };
  }
  try {
    const { stdout } = await execFileAsync('intel_gpu_top', ['-J', '-s', '250', '-o', '-'], {
      encoding: 'utf8',
      timeout: 1200
    });
    if (!stdout.trim()) {
      return { available: false, reason: 'intel_gpu_top produced no output' };
    }
    return parseIntelGpuTop(stdout);
  } catch (error) {
    return { available: false, reason: gpuCommandErrorReason(error, 'intel_gpu_top failed') };
  }
}

function parseIntelGpuTop(source: string): GpuMetrics {
  const busyValues = [...source.matchAll(/"busy"\s*:\s*([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (busyValues.length === 0) {
    return { available: true, name: 'Intel GPU', reason: 'no busy counters' };
  }
  return {
    available: true,
    name: 'Intel GPU',
    utilizationGpuPercent: clampPercent(Math.max(...busyValues))
  };
}

export function gpuCommandErrorReason(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr) {
      return stderr;
    }
  }
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; killed?: unknown; message?: unknown; signal?: unknown };
    const command = fallback.endsWith(' failed') ? fallback.slice(0, -' failed'.length) : fallback;
    if (record.code === 'ETIMEDOUT' || record.killed === true || record.signal === 'SIGTERM') {
      return `${command} timed out`;
    }
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (message.startsWith('Command failed:')) {
      return fallback;
    }
  }
  return error instanceof Error ? error.message || fallback : fallback;
}

const commandExistsCache = new Map<string, boolean>();

/** Whether a command resolves on PATH — memoized: PATH does not change mid-run. */
function commandExists(command: string): boolean {
  const cached = commandExistsCache.get(command);
  if (cached !== undefined) {
    return cached;
  }
  const result = spawnSync('sh', ['-c', `command -v ${quoteShell(command)}`], { encoding: 'utf8', timeout: 500 });
  const exists = result.status === 0;
  commandExistsCache.set(command, exists);
  return exists;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || value === '[N/A]') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
