import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemSnapshot } from '../src/shared/systemMetrics';

function snapshot(generatedAt: string, hostname = 'desk-test'): SystemSnapshot {
  return {
    generatedAt,
    hostname,
    platform: 'linux',
    kernel: 'test',
    uptimeSeconds: 1,
    cpu: { threads: 1, loadAverage: [0, 0, 0], loadPercent: 0 },
    memory: { totalBytes: 1, usedBytes: 0, availableBytes: 1, usedPercent: 0 },
    network: { rxBytes: 0, txBytes: 0, interfaces: [] },
    disk: { totalBytes: 1, usedBytes: 0, usedPercent: 0 },
    gpu: {
      nvidia: { available: false, reason: 'test' },
      intel: { available: false, reason: 'test' }
    }
  };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('system sampler health', () => {
  afterEach(() => {
    vi.doUnmock('../src/server/systemMetrics.js');
    vi.useRealTimers();
    vi.resetModules();
  });

  it('keeps the last good snapshot and exposes safe failure diagnostics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.100Z'));
    const initial = snapshot('2026-07-10T00:00:00.000Z');
    vi.doMock('../src/server/systemMetrics.js', () => ({
      collectSystemSnapshot: () => initial,
      collectSystemSnapshotAsync: () => Promise.reject(new Error('/secret/nvidia-smi failed'))
    }));
    const sampler = await import('../src/server/systemSampler');

    try {
      sampler.startSystemSampling(1_000);
      await settlePromises();

      expect(sampler.getSystemSnapshot()).toEqual({
        ...initial,
        sampler: {
          lastSampleAt: '2026-07-10T00:00:00.000Z',
          staleForMs: 100,
          consecutiveFailures: 1,
          lastError: 'sample-failed'
        }
      });
    } finally {
      sampler.stopSystemSampling();
    }
  });

  it('clears failure diagnostics after the next successful sample', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const initial = snapshot('2026-07-10T00:00:00.000Z');
    const recovered = snapshot('2026-07-10T00:00:01.000Z', 'desk-recovered');
    const collectAsync = vi
      .fn<() => Promise<SystemSnapshot>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(recovered);
    vi.doMock('../src/server/systemMetrics.js', () => ({
      collectSystemSnapshot: () => initial,
      collectSystemSnapshotAsync: collectAsync
    }));
    const sampler = await import('../src/server/systemSampler');

    try {
      sampler.startSystemSampling(1_000);
      await settlePromises();
      expect(sampler.getSystemSnapshot().sampler?.consecutiveFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sampler.getSystemSnapshot()).toEqual({
        ...recovered,
        sampler: {
          lastSampleAt: '2026-07-10T00:00:01.000Z',
          staleForMs: 0,
          consecutiveFailures: 0
        }
      });
    } finally {
      sampler.stopSystemSampling();
    }
  });
});
