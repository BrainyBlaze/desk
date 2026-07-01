import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const partial = 'PARTIAL_QUEUE_JSON_BEFORE_CRASH';

describe('ChannelsEngine atomic queue snapshots', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-engine-atomic-'));
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  const crashOnQueueSnapshot = (): void => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1]) => {
          const content = typeof data === 'string' || Buffer.isBuffer(data) ? data.toString() : '';
          if (content.includes('new prompt')) {
            actual.writeFileSync(path, partial);
            throw new Error('simulated queue snapshot crash');
          }
          actual.writeFileSync(path, data);
        }) as typeof actual.writeFileSync
      };
    });
  };

  it('preserves an existing queued json file when persistQueue crashes while refreshing it', async () => {
    crashOnQueueSnapshot();
    const { ChannelsEngine } = await import('../src/server/channelsEngine.js');
    const engine = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 1_000_000,
      sendText: async () => true,
      sessionRunning: () => false,
      sessionCreatedAt: async () => 1,
      capturePane: async () => null
    });
    const queueDir = join(home, '_engine', 'queue', 'tmux-a');
    const queueFile = join(queueDir, '0000000001.json');
    const prior = JSON.stringify({
      seq: 1,
      channel: 'ops',
      messageId: 'old',
      author: 'desk',
      prompt: 'old prompt',
      queuedAt: '2026-06-18T16:00:00.000Z',
      kind: 'prompt'
    });
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(queueFile, prior);

    try {
      expect(() => engine.enqueuePrompt('tmux-a', 'ops', 'new prompt', 'nudge')).toThrow(/simulated queue snapshot crash/);
      expect(readFileSync(queueFile, 'utf8')).toBe(prior);
    } finally {
      engine.dispose();
    }
  });
});
