import { describe, expect, it } from 'vitest';
import {
  calculateCpuUsage,
  gpuCommandErrorReason,
  parseDiskStats,
  parseMemInfo,
  parseNetDev,
  parseNvidiaSmiCsv
} from '../src/server/systemMetrics';

describe('system metrics', () => {
  it('calculates cpu usage from proc stat deltas', () => {
    const previous = { idle: 100, total: 200 };
    const current = { idle: 150, total: 300 };

    expect(calculateCpuUsage(previous, current)).toBe(50);
  });

  it('parses memory usage from meminfo', () => {
    expect(
      parseMemInfo(`
MemTotal:       1000000 kB
MemAvailable:    250000 kB
`)
    ).toEqual({
      totalBytes: 1024000000,
      usedBytes: 768000000,
      availableBytes: 256000000,
      usedPercent: 75
    });
  });

  it('sums active network interface counters', () => {
    expect(
      parseNetDev(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0
  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
  eth1: 3000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0
`)
    ).toEqual({
      rxBytes: 4000,
      txBytes: 6000,
      interfaces: ['eth0', 'eth1']
    });
  });

  it('sums whole-disk io sectors, skipping partitions and virtual devices', () => {
    expect(
      parseDiskStats(`
   8       0 sda 100 0 1000 0 50 0 2000 0 0 0 0
   8       1 sda1 90 0 900 0 45 0 1800 0 0 0 0
 259       0 nvme0n1 10 0 500 0 5 0 100 0 0 0 0
 259       1 nvme0n1p1 9 0 450 0 4 0 90 0 0 0 0
   7       0 loop0 1 0 50 0 0 0 0 0 0 0 0
 252       0 ram0 1 0 50 0 0 0 0 0 0 0 0
`)
    ).toEqual({
      readBytes: (1000 + 500) * 512,
      writeBytes: (2000 + 100) * 512
    });
  });

  it('parses nvidia-smi csv output', () => {
    expect(parseNvidiaSmiCsv('RTX 4090, 72, 34, 8192, 24576, 61, 315.5, 450\n')).toEqual({
      available: true,
      name: 'RTX 4090',
      utilizationGpuPercent: 72,
      utilizationMemoryPercent: 34,
      memoryUsedMiB: 8192,
      memoryTotalMiB: 24576,
      temperatureC: 61,
      powerDrawW: 315.5,
      powerLimitW: 450
    });
  });

  it('summarizes nvidia-smi timeouts without leaking the raw command line', () => {
    expect(gpuCommandErrorReason({ code: 'ETIMEDOUT', message: 'spawnSync nvidia-smi ETIMEDOUT' }, 'nvidia-smi failed')).toBe(
      'nvidia-smi timed out'
    );
    expect(
      gpuCommandErrorReason(
        {
          killed: true,
          signal: 'SIGTERM',
          message:
            'Command failed: nvidia-smi --query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits\n'
        },
        'nvidia-smi failed'
      )
    ).toBe('nvidia-smi timed out');
  });

  it('summarizes command-failed GPU errors without exposing the full query', () => {
    expect(
      gpuCommandErrorReason(
        {
          message:
            'Command failed: nvidia-smi --query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits\n'
        },
        'nvidia-smi failed'
      )
    ).toBe('nvidia-smi failed');
  });
});
