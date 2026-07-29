import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initChannelsRuntime,
  resetChannelsRuntime
} from '../src/server/channelsApi.js';

describe('channels unified event feed bridge', () => {
  let home: string | undefined;

  afterEach(() => {
    resetChannelsRuntime();
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('publishes one typed channel-message event through the daemon gateway', async () => {
    home = mkdtempSync(join(tmpdir(), 'channels-event-feed-'));
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const runtime = initChannelsRuntime({
      home,
      channelEventPublisher: publish
    });

    runtime.engine.handleMessage(
      {
        channel: 'desk',
        file: 'thread-msg-root.md',
        message: {
          id: 'msg-2',
          author: 'claude-1',
          timestamp: '2026-07-27 12:00:00',
          body: '@human  Please   review\nthis result.',
          hasEndTurn: true
        }
      },
      []
    );

    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledWith({
        channel: 'desk',
        messageId: 'msg-2',
        thread: 'msg-root',
        author: 'claude-1',
        mentionsOperator: true,
        message: '@human Please review this result.'
      });
    });
    expect(publish).toHaveBeenCalledOnce();
  });
});
