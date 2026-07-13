import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskPulse } from '../src/web/api.js';

const runtime = vi.hoisted(() => ({
  fetchPulse: vi.fn(),
  cleanups: [] as Array<() => void>
}));

vi.mock('react', () => ({
  useEffect(effect: () => void | (() => void)) {
    const cleanup = effect();
    if (cleanup) {
      runtime.cleanups.push(cleanup);
    }
  },
  useRef<T>(initial: T) {
    return { current: initial };
  },
  useState<T>(initial: T) {
    return [initial, vi.fn()];
  }
}));

vi.mock('../src/web/api.js', () => ({
  fetchPulse: runtime.fetchPulse
}));

import { usePulse } from '../src/web/usePulse.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function pulse(unread: number): DeskPulse {
  return {
    system: {
      cpu: { usagePercent: 12 },
      memory: { usedPercent: 34 },
      gpu: { nvidia: {} },
      network: {},
      disk: {}
    } as DeskPulse['system'],
    attention: {
      sessions: { 'agent-1': { attention: true, since: '2026-07-12T22:00:00.000Z' } },
      events: [
        {
          id: 'event-1',
          tmuxSession: 'agent-1',
          kind: 'turn-complete',
          at: '2026-07-12T22:00:00.000Z',
          read: false
        }
      ],
      unread
    },
    running: []
  };
}

describe('usePulse attention reconciliation', () => {
  beforeEach(() => {
    runtime.fetchPulse.mockReset();
    runtime.cleanups.length = 0;
    vi.stubGlobal('window', {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn()
    });
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
  });

  afterEach(() => {
    for (const cleanup of runtime.cleanups.splice(0).reverse()) {
      cleanup();
    }
    vi.unstubAllGlobals();
  });

  it('ignores stale attention from an in-flight pulse without suppressing liveness', async () => {
    const pending = deferred<DeskPulse>();
    runtime.fetchPulse.mockReturnValueOnce(pending.promise);
    const setSnapshot = vi.fn();
    const setAttention = vi.fn();
    const setAgentEvents = vi.fn();
    const setUnreadEvents = vi.fn();

    const result = usePulse({ setSnapshot, setAttention, setAgentEvents, setUnreadEvents });
    (result as typeof result & { invalidateAttentionPulse?: () => void }).invalidateAttentionPulse?.();
    pending.resolve(pulse(1));
    await pending.promise;
    await Promise.resolve();

    expect(setAttention).not.toHaveBeenCalled();
    expect(setAgentEvents).not.toHaveBeenCalled();
    expect(setUnreadEvents).not.toHaveBeenCalled();
    expect(setSnapshot).toHaveBeenCalledTimes(1);
  });
});
