import { describe, expect, it } from 'vitest';
import { createSaveQueue } from '../src/web/editor/saveQueue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createSaveQueue', () => {
  it('runs one trailing save instead of dropping a request made during an in-flight write', async () => {
    const queue = createSaveQueue();
    const gate = deferred();
    const writes: boolean[] = [];
    const task = async (overwrite: boolean): Promise<void> => {
      writes.push(overwrite);
      if (writes.length === 1) {
        await gate.promise;
      }
    };

    const first = queue.run('/a.ts', false, task);
    void queue.run('/a.ts', true, task);

    expect(writes).toEqual([false]);
    gate.resolve();
    await first;
    expect(writes).toEqual([false, true]);
  });

  it('coalesces repeated trailing requests and preserves overwrite intent', async () => {
    const queue = createSaveQueue();
    const gate = deferred();
    const writes: boolean[] = [];
    const task = async (overwrite: boolean): Promise<void> => {
      writes.push(overwrite);
      if (writes.length === 1) {
        await gate.promise;
      }
    };

    const first = queue.run('/a.ts', false, task);
    void queue.run('/a.ts', false, task);
    void queue.run('/a.ts', true, task);
    void queue.run('/a.ts', false, task);

    gate.resolve();
    await first;
    expect(writes).toEqual([false, true]);
  });
});
