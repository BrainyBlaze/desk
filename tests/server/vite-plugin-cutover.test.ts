import { describe, expect, it, vi } from 'vitest';
import { installDeskApi } from '../../src/server/vitePlugin.js';

describe('Desk API ownership gate', () => {
  it('fails before registering middleware when Channels ownership is unavailable', () => {
    const use = vi.fn();
    const failure = new Error('another Desk server owns Channels');

    expect(() => installDeskApi(
      { httpServer: null, middlewares: { use } },
      {
        acquireChannelsOwner: () => {
          throw failure;
        }
      }
    )).toThrow(failure);

    expect(use).not.toHaveBeenCalled();
  });
});
