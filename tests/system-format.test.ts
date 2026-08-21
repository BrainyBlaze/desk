import { describe, expect, it } from 'vitest';
import { type SparkSample, formatBytes, formatGpuMemory, formatRate, formatStorage, formatUptime, pushSparkSample, sparklinePath, telemetryPlaceholder, telemetryTileText } from '../src/web/systemFormat';

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

  it('distinguishes a failing pulse from a first load in tile placeholders', () => {
    expect(telemetryPlaceholder(null)).toBe('init');
    expect(telemetryPlaceholder(undefined)).toBe('init');
    expect(telemetryPlaceholder('HTTP 500')).toBe('no data');
  });

  it('resolves tile text by one shared precedence: measurement, then unmeasured label, then placeholder', () => {
    // Measured value always wins.
    expect(telemetryTileText('42%', 'unmeasured', true, 'no data')).toBe('42%');
    // Snapshot present but this metric absent → the domain's unmeasured label.
    expect(telemetryTileText(false, 'unmeasured', true, 'no data')).toBe('unmeasured');
    expect(telemetryTileText(undefined, 'io init', true, 'init')).toBe('io init');
    // No snapshot → the shared placeholder, never a per-tile loading string.
    expect(telemetryTileText(false, 'unmeasured', false, 'no data')).toBe('no data');
    expect(telemetryTileText(null, 'unmeasured', false, 'init')).toBe('init');
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

  it('pushes sparkline samples within a fixed window and keeps an unmeasured tick as a GAP, not a zero', () => {
    const samples: SparkSample[] = [];
    for (let i = 0; i < 70; i++) {
      pushSparkSample(samples, i);
    }
    expect(samples).toHaveLength(60);
    expect(samples[0]).toBe(10);
    // Not measured (first tick, unreadable /proc) is not "measured as zero":
    // the buffer carries the gap so the sparkline can leave it blank instead
    // of drawing a confident trough next to a tile that honestly says 'init'.
    pushSparkSample(samples, undefined);
    expect(samples.at(-1)).toBeUndefined();
    pushSparkSample(samples, Number.NaN);
    expect(samples.at(-1)).toBeUndefined();
    // A negative reading is a broken measurement, not a small one.
    pushSparkSample(samples, -5);
    expect(samples.at(-1)).toBeUndefined();
  });

  it('maps samples to a path with floor-anchored scaling', () => {
    expect(sparklinePath([50], 100)).toBe('');
    const points = sparklinePath([0, 100], 100).split(' ');
    expect(points[0]).toBe('M0.0,23.0'); // zero hugs the baseline
    expect(points[1]).toBe('L100.0,1.0'); // full scale reaches the top
    // rates autoscale: with floor 1, the window peak defines the top
    const rate = sparklinePath([0, 500], 1).split(' ');
    expect(rate[1]).toBe('L100.0,1.0');
  });

  it('draws gaps as breaks in the path instead of plotting them', () => {
    // Index 1 is unmeasured: the line stops at 0 and a NEW subpath starts at
    // 2 — the gap is blank, not a point at the floor and not a bridge.
    expect(sparklinePath([100, undefined, 100], 100)).toBe('M0.0,1.0 M100.0,1.0');
    // Gaps still take their x slot: three samples span the full width.
    expect(sparklinePath([undefined, 50, 100], 100)).toBe('M50.0,12.0 L100.0,1.0');
    // All-gap: nothing to draw.
    expect(sparklinePath([undefined, undefined], 100)).toBe('');
  });
});
