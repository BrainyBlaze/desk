import { describe, expect, it } from 'vitest';
import {
  applyNetworkRates,
  calculateCpuUsage,
  cpuTimesFromOsCpus,
  gpuCommandErrorReason,
  parseDiskStats,
  parseMemInfo,
  parseNetDev,
  parseNvidiaSmiCsv,
  parseVmStat
} from '../src/server/systemMetrics';

describe('system metrics', () => {
  it('calculates cpu usage from proc stat deltas', () => {
    const previous = { idle: 100, total: 200 };
    const current = { idle: 150, total: 300 };

    expect(calculateCpuUsage(previous, current)).toBe(50);
  });

  it('folds os.cpus() core times into the CpuTimes shape the delta math consumes', () => {
    expect(
      cpuTimesFromOsCpus([
        { times: { user: 100, nice: 10, sys: 50, idle: 800, irq: 0 } },
        { times: { user: 200, nice: 0, sys: 100, idle: 700, irq: 5 } }
      ])
    ).toEqual({ idle: 1500, total: 1965 });
  });

  it('reports cpu times as unmeasured on an empty or non-finite core list, never as zero', () => {
    expect(cpuTimesFromOsCpus([])).toBeUndefined();
    expect(
      cpuTimesFromOsCpus([{ times: { user: Number.NaN, nice: 0, sys: 0, idle: 0, irq: 0 } }])
    ).toBeUndefined();
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

  it('parses memory usage from vm_stat page counts and the host total', () => {
    const source = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1000.
Pages active:                            250000.
Pages inactive:                          200000.
Pages speculative:                          500.
Pages throttled:                              0.
Pages wired down:                        180000.
Pages purgeable:                           1500.
"Translation faults":                1874826008.
`;
    const totalBytes = 16384 * 1000000;
    const availableBytes = 16384 * (1000 + 200000 + 500 + 1500);
    expect(parseVmStat(source, totalBytes)).toEqual({
      totalBytes,
      usedBytes: totalBytes - availableBytes,
      availableBytes,
      usedPercent: 80
    });
  });

  it('reports vm_stat memory as unmeasured on missing pages, foreign output, or a zero total, never as zero', () => {
    const source = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\n';
    expect(parseVmStat('', 1000)).toBeUndefined();
    expect(parseVmStat('Pages free: 1000.\n', 1000)).toBeUndefined();
    expect(parseVmStat(source, 0)).toBeUndefined();
    expect(
      parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"Translation faults": 5.\n', 1000)
    ).toBeUndefined();
  });

  it('reports vm_stat memory as unmeasured when page accounting meets or exceeds the host total, never as a fabricated 0% used', () => {
    // os.totalmem() and vm_stat's page counts are independent sources; if the
    // available pages alone reach the reported total, the two disagree and
    // "used" is not measurable — clamping it to 0 would print a confident 0%.
    const source =
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 600.\nPages inactive: 500.\n';
    const totalBytes = 16384 * 1000; // available (1100 pages) already exceeds it
    expect(parseVmStat(source, totalBytes)).toBeUndefined();
  });

  it('reports memory as unmeasured when meminfo lacks its load-bearing fields, never as zero', () => {
    // An empty or foreign meminfo (non-Linux, a container quirk) used to
    // yield {totalBytes: 0, usedPercent: 0} in NON-optional fields — a
    // measurement nobody took. Now it is simply absent, like CPU usage on a
    // tick with no delta baseline.
    expect(parseMemInfo('')).toBeUndefined();
    expect(parseMemInfo('MemTotal:       1000000 kB\n')).toBeUndefined();
    expect(parseMemInfo('MemFree:        1000000 kB\nMemAvailable:    250000 kB\n')).toBeUndefined();
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

  it('computes network rates from counter deltas over elapsed time', () => {
    const previous = { rxBytes: 1000, txBytes: 500, interfaces: ['en0'], sampledAtMs: 0 };
    const current = { rxBytes: 3000, txBytes: 1500, interfaces: ['en0'], sampledAtMs: 2000 };
    expect(applyNetworkRates(previous, current)).toEqual({
      rxBytes: 3000,
      txBytes: 1500,
      interfaces: ['en0'],
      rxBytesPerSecond: 1000,
      txBytesPerSecond: 500
    });
  });

  it('reports network rates as unmeasured when no interface was parsed, never as a fabricated 0 B/s', () => {
    // An unreadable /proc/net/dev (a darwin host) parses to zero totals across
    // an EMPTY interface list — deltas of those zeros would print a confident
    // "0 B/s" for traffic nobody measured.
    const previous = { rxBytes: 0, txBytes: 0, interfaces: [], sampledAtMs: 0 };
    const current = { rxBytes: 0, txBytes: 0, interfaces: [], sampledAtMs: 2000 };
    expect(applyNetworkRates(previous, current)).toEqual({ rxBytes: 0, txBytes: 0, interfaces: [] });
    expect(applyNetworkRates(undefined, current)).toEqual({ rxBytes: 0, txBytes: 0, interfaces: [] });
  });

  it('does not spike when the previous sample was an unmeasured empty read', () => {
    // A transient empty read must not become the baseline: pairing a real
    // counter against a zero baseline would divide the whole absolute counter
    // over one interval and report an enormous phantom throughput.
    const empty = { rxBytes: 0, txBytes: 0, interfaces: [], sampledAtMs: 0 };
    const real = { rxBytes: 9_000_000, txBytes: 6_000_000, interfaces: ['en0'], sampledAtMs: 2000 };
    expect(applyNetworkRates(empty, real)).toEqual({ rxBytes: 9_000_000, txBytes: 6_000_000, interfaces: ['en0'] });
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
