export interface CpuMetrics {
  threads: number;
  usagePercent?: number;
  loadAverage: [number, number, number];
  loadPercent: number;
}

export interface MemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface NetworkMetrics {
  rxBytes: number;
  txBytes: number;
  rxBytesPerSecond?: number;
  txBytesPerSecond?: number;
  interfaces: string[];
}

export interface GpuMetrics {
  available: boolean;
  name?: string;
  utilizationGpuPercent?: number;
  utilizationMemoryPercent?: number;
  memoryUsedMiB?: number;
  memoryTotalMiB?: number;
  temperatureC?: number;
  powerDrawW?: number;
  powerLimitW?: number;
  reason?: string;
}

export interface DiskMetrics {
  totalBytes: number;
  usedBytes: number;
  usedPercent: number;
  readBytesPerSecond?: number;
  writeBytesPerSecond?: number;
}

export interface SystemSamplerHealth {
  /** Timestamp carried by the most recent successful snapshot. */
  lastSampleAt: string;
  /** Current wall-clock age of the most recent successful snapshot. */
  staleForMs: number;
  consecutiveFailures: number;
  /** Stable, redacted failure code. Raw process and filesystem errors never reach clients. */
  lastError?: 'sample-failed';
}

export interface SystemSnapshot {
  generatedAt: string;
  hostname: string;
  platform: string;
  kernel: string;
  uptimeSeconds: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  network: NetworkMetrics;
  disk: DiskMetrics;
  gpu: {
    nvidia: GpuMetrics;
    intel: GpuMetrics;
  };
  /** Present on cached snapshots served by the background sampler. */
  sampler?: SystemSamplerHealth;
}
