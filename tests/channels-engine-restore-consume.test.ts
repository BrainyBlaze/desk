import { mkdirSync, mkdtempSync, rmSync as realRmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueuedPrompt } from '../src/server/channelsEngine.js';
import { claimDelivering, confirmDelivered } from '../src/server/channelsDurability.js';

const fsFaults = vi.hoisted(() => ({ failQueueJsonRm: false, failPersistQueueScan: false, queueDirReads: 0 }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], options?: Parameters<typeof actual.readdirSync>[1]) => {
      if (fsFaults.failPersistQueueScan && String(path).includes(`${join('_engine', 'queue', 'tmux-a')}`)) {
        fsFaults.queueDirReads += 1;
        if (fsFaults.queueDirReads === 3) {
          throw Object.assign(new Error('mock cleanup scan failure'), { code: 'EIO' });
        }
      }
      return actual.readdirSync(path, options as never);
    }) satisfies typeof actual.readdirSync,
    rmSync: ((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (fsFaults.failQueueJsonRm && String(path).includes(`${join('_engine', 'queue')}`) && String(path).endsWith('.json')) {
        throw Object.assign(new Error('mock rm failure'), { code: 'EPERM' });
      }
      return actual.rmSync(path, options);
    }) satisfies typeof actual.rmSync
  };
});

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!(await predicate()) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const durabilityCallback = (home: string) => ({
  onSubmitStateChange: (tmuxSession: string, state: string, context: { seq: number }) => {
    if (state === 'delivering') {
      claimDelivering(home, tmuxSession, context.seq);
    } else if (state === 'submitted' || state === 'delivery-ack-timeout') {
      confirmDelivered(home, tmuxSession, context.seq);
    }
  }
});

describe('ChannelsEngine restore consume safety', () => {
  let home: string | undefined;

  afterEach(() => {
    vi.resetModules();
    fsFaults.failQueueJsonRm = false;
    fsFaults.failPersistQueueScan = false;
    fsFaults.queueDirReads = 0;
    if (home) {
      realRmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('consumes queue files before parse so restore cleanup failure cannot duplicate after restart', async () => {
    home = mkdtempSync(join(tmpdir(), 'desk-restore-consume-'));
    const queueDir = join(home, '_engine', 'queue', 'tmux-a');
    mkdirSync(queueDir, { recursive: true });
    const queued: QueuedPrompt = {
      seq: 1,
      channel: 'ops',
      messageId: 'msg-restore-consume',
      author: 'human',
      prompt: 'prompt body for restore consume',
      queuedAt: '2026-06-18T20:00:00.000Z',
      file: 'root.md',
      member: 'alpha'
    };
    writeFileSync(join(queueDir, '0000000007.json'), JSON.stringify(queued));

    const { ChannelsEngine } = await import('../src/server/channelsEngine.js');

    let sends = 0;
    const engineOptions = {
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 100000,
      sendText: async () => {
        sends += 1;
        return true;
      },
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => '✻ Working… (esc to interrupt)',
      ...durabilityCallback(home)
    };

    fsFaults.failQueueJsonRm = true;
    fsFaults.failPersistQueueScan = true;
    const first = new ChannelsEngine(engineOptions);
    await waitFor(() => sends === 1);
    expect(first.lifecycleStates().find((entry) => entry.tmuxSession === 'tmux-a')?.queued).toBe(0);
    expect(sends).toBe(1);
    expect(fsFaults.queueDirReads).toBeGreaterThanOrEqual(2);
    first.dispose();

    fsFaults.failQueueJsonRm = false;
    fsFaults.failPersistQueueScan = false;
    const second = new ChannelsEngine(engineOptions);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second.lifecycleStates().find((entry) => entry.tmuxSession === 'tmux-a')?.queued).toBe(0);
    expect(sends).toBe(1);
    second.dispose();
  });

  it('re-enqueues a consumed queue file after a crash between rename and read', async () => {
    home = mkdtempSync(join(tmpdir(), 'desk-restore-consumed-replay-'));
    const queueDir = join(home, '_engine', 'queue', 'tmux-a');
    mkdirSync(queueDir, { recursive: true });
    const queued: QueuedPrompt = {
      seq: 7,
      channel: 'ops',
      messageId: 'msg-consumed-replay',
      author: 'human',
      prompt: 'prompt body from consumed restore file',
      queuedAt: '2026-06-18T20:05:00.000Z',
      file: 'root.md',
      member: 'alpha'
    };
    writeFileSync(join(queueDir, '0000000007.json.consumed'), JSON.stringify(queued));

    const { ChannelsEngine } = await import('../src/server/channelsEngine.js');
    let sends = 0;
    const restored = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 100000,
      sendText: async () => {
        sends += 1;
        return true;
      },
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => '✻ Working… (esc to interrupt)',
      ...durabilityCallback(home)
    });

    await waitFor(() => sends === 1);
    expect(restored.lifecycleStates().find((entry) => entry.tmuxSession === 'tmux-a')?.queued).toBe(0);
    expect(sends).toBe(1);
    restored.dispose();
  });

  it('dedupes by messageId when a consumed replay and queue snapshot both exist', async () => {
    home = mkdtempSync(join(tmpdir(), 'desk-restore-consumed-dedupe-'));
    const queueDir = join(home, '_engine', 'queue', 'tmux-a');
    mkdirSync(queueDir, { recursive: true });
    const queued: QueuedPrompt = {
      seq: 7,
      channel: 'ops',
      messageId: 'msg-consumed-dedupe',
      author: 'human',
      prompt: 'prompt body for duplicate replay',
      queuedAt: '2026-06-18T20:10:00.000Z',
      file: 'root.md',
      member: 'alpha'
    };
    writeFileSync(join(queueDir, '0000000007.json.consumed'), JSON.stringify(queued));
    writeFileSync(join(queueDir, '0000000008.json'), JSON.stringify({ ...queued, seq: 8 }));

    const { ChannelsEngine } = await import('../src/server/channelsEngine.js');
    let sends = 0;
    const restored = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 100000,
      sendText: async () => {
        sends += 1;
        return true;
      },
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
      capturePane: async () => '✻ Working… (esc to interrupt)',
      ...durabilityCallback(home)
    });

    await waitFor(() => sends === 1);
    expect(restored.lifecycleStates().find((entry) => entry.tmuxSession === 'tmux-a')?.queued).toBe(0);
    expect(sends).toBe(1);
    restored.dispose();
  });
});
