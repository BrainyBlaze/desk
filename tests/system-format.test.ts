import { describe, expect, it } from 'vitest';
import { formatBytes, formatGpuMemory, formatRate, formatStorage, formatUptime, pushSparkSample, sparklinePoints } from '../src/web/systemFormat';

describe('system formatting', () => {
  it('formats bytes compactly', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1073741824)).toBe('1.0 GiB');
  });

  it('formats network rates', () => {
    expect(formatRate(undefined)).toBe('init');
    expect(formatRate(2048)).toBe('2.0 KiB/s');
  });

  it('formats uptime as compact days and hours', () => {
    expect(formatUptime(3661)).toBe('1h 1m');
    expect(formatUptime(90000)).toBe('1d 1h');
  });

  it('formats storage volumes compactly', () => {
    const gib = 1024 ** 3;
    expect(formatStorage(218 * gib, 512 * gib)).toBe('218/512G');
    expect(formatStorage(1.5 * 1024 * gib, 2 * 1024 * gib)).toBe('1.50/2.00T');
    expect(formatStorage(undefined, 512 * gib)).toBe('init');
    expect(formatStorage(0, 0)).toBe('init');
  });

  it('formats GPU memory in GiB from MiB figures', () => {
    expect(formatGpuMemory(14541, 32768)).toBe('14.2/32.0G');
    expect(formatGpuMemory(undefined, 32768)).toBe('mem n/a');
    expect(formatGpuMemory(1024, undefined)).toBe('mem n/a');
  });

  it('pushes sparkline samples within a fixed window', () => {
    const samples: number[] = [];
    for (let i = 0; i < 70; i++) {
      pushSparkSample(samples, i);
    }
    expect(samples).toHaveLength(60);
    expect(samples[0]).toBe(10);
    pushSparkSample(samples, Number.NaN);
    expect(samples.at(-1)).toBe(0);
    pushSparkSample(samples, -5);
    expect(samples.at(-1)).toBe(0);
  });

  it('maps samples to polyline points with floor-anchored scaling', () => {
    expect(sparklinePoints([50], 100)).toBe('');
    const points = sparklinePoints([0, 100], 100).split(' ');
    expect(points[0]).toBe('0.0,23.0'); // zero hugs the baseline
    expect(points[1]).toBe('100.0,1.0'); // full scale reaches the top
    // rates autoscale: with floor 1, the window peak defines the top
    const rate = sparklinePoints([0, 500], 1).split(' ');
    expect(rate[1]).toBe('100.0,1.0');
  });
});
