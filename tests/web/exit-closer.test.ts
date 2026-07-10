import { describe, expect, it, vi } from 'vitest';
import { createExitCloser } from '../../src/web/arwes/exitCloser';

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe('createExitCloser single-shot exit timer', () => {
  it('runs onExit once after the delay', async () => {
    const onExit = vi.fn();
    const closer = createExitCloser(5);
    closer.request(onExit);
    expect(onExit).not.toHaveBeenCalled(); // not synchronous
    await delay(15);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('ignores repeat requests while pending (X + Escape double-fire)', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const closer = createExitCloser(5);
    closer.request(first);
    closer.request(second); // second trigger while the first is still pending
    await delay(15);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled(); // only the first-armed commit runs
  });

  it('ignores a late request after the timer already fired (stray late Escape)', async () => {
    const first = vi.fn();
    const late = vi.fn();
    const closer = createExitCloser(5);
    closer.request(first);
    await delay(15); // first fires
    closer.request(late); // stray trigger after teardown committed
    await delay(15);
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled(); // latched: no second teardown
  });

  it('dispose cancels a pending commit so onExit never runs (unmount)', async () => {
    const onExit = vi.fn();
    const closer = createExitCloser(5);
    closer.request(onExit);
    closer.dispose(); // unmount before the exit window elapses
    await delay(15);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('dispose is safe when nothing is pending', () => {
    const closer = createExitCloser(5);
    expect(() => closer.dispose()).not.toThrow();
  });
});
