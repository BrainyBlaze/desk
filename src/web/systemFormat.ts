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
export function pushSparkSample(samples: number[], value: number, window = 60): void {
  samples.push(Number.isFinite(value) ? Math.max(0, value) : 0);
  if (samples.length > window) {
    samples.splice(0, samples.length - window);
  }
}

/**
 * SVG polyline points for a 100x24 viewBox. The scale ceiling is the larger
 * of floorMax and the window peak, so percent series stay 0-100 anchored
 * while rate series (network) autoscale to their own recent peak.
 */
export function sparklinePoints(samples: number[], floorMax: number): string {
  if (samples.length < 2) {
    return '';
  }
  const top = Math.max(floorMax, ...samples) || 1;
  return samples
    .map((value, index) => {
      const x = ((index / (samples.length - 1)) * 100).toFixed(1);
      const y = (23 - (Math.min(value, top) / top) * 22).toFixed(1);
      return `${x},${y}`;
    })
    .join(' ');
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
