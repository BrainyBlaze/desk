import type { SystemSnapshot } from './types.js';

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = Math.max(value, 0);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return index === 0 ? `${Math.round(size)} ${units[index]}` : `${size.toFixed(1)} ${units[index]}`;
}

export function formatRate(value: number | undefined): string {
  return value === undefined ? 'init' : `${formatBytes(value)}/s`;
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? 'init' : `${Math.round(value)}%`;
}

/** "14.2/31.5G" VRAM summary from nvidia-smi's MiB figures. */
export function formatGpuMemory(usedMiB: number | undefined, totalMiB: number | undefined): string {
  if (usedMiB === undefined || totalMiB === undefined) {
    return 'mem n/a';
  }
  return `${(usedMiB / 1024).toFixed(1)}/${(totalMiB / 1024).toFixed(1)}G`;
}

/** "218/512G" root-volume summary; terabyte volumes get decimals. */
export function formatStorage(usedBytes: number | undefined, totalBytes: number | undefined): string {
  if (usedBytes === undefined || totalBytes === undefined || totalBytes <= 0) {
    return 'init';
  }
  const gib = 1024 ** 3;
  if (totalBytes >= 1024 * gib) {
    return `${(usedBytes / (1024 * gib)).toFixed(2)}/${(totalBytes / (1024 * gib)).toFixed(2)}T`;
  }
  return `${Math.round(usedBytes / gib)}/${Math.round(totalBytes / gib)}G`;
}

/** Append a sample to a fixed-window history ring (mutates in place). */
/**
 * One sparkline tick: a measured value, or `undefined` for a tick that was
 * NOT measured (first tick without a delta baseline, an unreadable /proc, a
 * probe that failed). The gap is carried, never invented as zero — a zero is
 * a measurement, and drawing one for an unmeasured tick puts a confident
 * trough on screen next to a tile that honestly says 'init'.
 */
export type SparkSample = number | undefined;

export function pushSparkSample(samples: SparkSample[], value: SparkSample, window = 60): void {
  // A non-finite or negative reading is a broken measurement, not a small
  // one: it enters the buffer as a gap.
  samples.push(value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined);
  if (samples.length > window) {
    samples.splice(0, samples.length - window);
  }
}

/**
 * SVG path data (`d`) for a 100x24 viewBox: one polyline per measured run,
 * with gaps (unmeasured ticks) left BLANK — a new `M` starts each run, so the
 * renderer neither bridges nor plots the span nobody measured. The scale
 * ceiling is the larger of floorMax and the window peak, so percent series
 * stay 0-100 anchored while rate series (network) autoscale to their own
 * recent peak.
 */
export function sparklinePath(samples: SparkSample[], floorMax: number): string {
  if (samples.length < 2) {
    return '';
  }
  const measured = samples.filter((value): value is number => value !== undefined);
  if (measured.length === 0) {
    return '';
  }
  const top = Math.max(floorMax, ...measured) || 1;
  // Every sample, gap or not, keeps its x slot so time stays linear across
  // the window; a run of measured samples is one M…L… subpath.
  const parts: string[] = [];
  let inRun = false;
  samples.forEach((value, index) => {
    if (value === undefined) {
      inRun = false;
      return;
    }
    const x = ((index / (samples.length - 1)) * 100).toFixed(1);
    const y = (23 - (Math.min(value, top) / top) * 22).toFixed(1);
    parts.push(`${inRun ? 'L' : 'M'}${x},${y}`);
    inRun = true;
  });
  return parts.join(' ');
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatLoad(systemSnapshot: SystemSnapshot | null): string {
  if (!systemSnapshot) {
    return 'load init';
  }
  return `load ${systemSnapshot.cpu.loadAverage[0].toFixed(2)} / ${systemSnapshot.cpu.threads}t`;
}

/** Usage and VRAM together — the two numbers that matter while agents run models. */
export function formatGpuValue(gpu: SystemSnapshot['gpu']['nvidia'] | undefined): string {
  if (!gpu?.available) {
    return 'N/A';
  }
  return `${formatPercent(gpu.utilizationGpuPercent)} | ${formatGpuMemory(gpu.memoryUsedMiB, gpu.memoryTotalMiB)}`;
}

/** Thermals and power; the marketing name lives in the tooltip instead of
 * eating the line (it used to truncate the memory readout away). */
export function formatGpuDetail(gpu: SystemSnapshot['gpu']['nvidia'] | undefined): string {
  if (!gpu?.available) {
    return gpu?.reason ?? 'unavailable';
  }
  const parts: string[] = [];
  if (gpu.temperatureC !== undefined) {
    parts.push(`${gpu.temperatureC}°C`);
  }
  if (gpu.powerDrawW !== undefined) {
    parts.push(gpu.powerLimitW !== undefined ? `${Math.round(gpu.powerDrawW)}/${Math.round(gpu.powerLimitW)}W` : `${Math.round(gpu.powerDrawW)}W`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'sensors n/a';
}
