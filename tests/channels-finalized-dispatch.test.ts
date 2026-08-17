import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initChannelsRuntime,
  resetChannelsRuntime
} from '../src/server/channels/api.js';
import type { ChannelMember } from '../src/server/channels/protocol/format.js';
import type { IncomingChannelMessage } from '../src/server/channels/store/fileStore.js';
import { FileChannelStore } from '../src/server/channels/ports.js';

type FinalizedHandler = (incoming: IncomingChannelMessage) => void | Promise<void>;

class CapturingStore extends FileChannelStore {
  private finalizedHandler: FinalizedHandler | undefined;

  override onFinalized(handler: FinalizedHandler): () => void {
    this.finalizedHandler = handler;
    return () => {
      this.finalizedHandler = undefined;
    };
  }

  override async listMembers(_channel: string): Promise<ChannelMember[]> {
    throw new Error('member read failed');
  }

  async dispatch(incoming: IncomingChannelMessage): Promise<void> {
    if (!this.finalizedHandler) {
      throw new Error('finalized handler was not registered');
    }
    await this.finalizedHandler(incoming);
  }
}

describe('finalized channel dispatch', () => {
  let home: string | undefined;

  afterEach(() => {
    resetChannelsRuntime();
    vi.restoreAllMocks();
    if (home) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('propagates dispatch rejection so the store can retry the message', async () => {
    home = mkdtempSync(join(tmpdir(), 'desk-finalized-dispatch-'));
    const store = new CapturingStore(home);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initChannelsRuntime({
      home,
      providers: [{ store: () => store }]
    });

    await expect(
      store.dispatch({
        channel: 'ops',
        file: 'root.md',
        message: {
          id: 'msg-finalized-retry-1',
          author: 'human',
          body: 'retry this dispatch',
          createdAt: '2026-08-17T00:00:00.000Z',
          reactions: []
        }
      })
    ).rejects.toThrow('member read failed');
    expect(consoleError).toHaveBeenCalledWith(
      '[desk-channels] dispatch failed for ops/msg-finalized-retry-1:',
      expect.objectContaining({ message: 'member read failed' })
    );
  });
});
