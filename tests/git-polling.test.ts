import { describe, expect, it, vi } from 'vitest';
import { startGitStatusPolling } from '../src/web/git/gitPolling.js';

describe('startGitStatusPolling', () => {
  it('refreshes immediately on activation, then on the interval, and cleans up', () => {
    const refresh = vi.fn();
    let scheduled: (() => void) | undefined;
    const clearInterval = vi.fn();

    const stop = startGitStatusPolling(refresh, 3_000, {
      setInterval(callback, delay) {
        scheduled = callback;
        expect(delay).toBe(3_000);
        return 17;
      },
      clearInterval
    });

    expect(refresh).toHaveBeenCalledOnce();
    scheduled?.();
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    expect(clearInterval).toHaveBeenCalledWith(17);
  });
});
