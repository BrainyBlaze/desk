import { describe, expect, it } from 'vitest';
import { createSearchRunner } from '../../src/web/channels/searchRunner';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

interface Harness {
  runner: ReturnType<typeof createSearchRunner<string, string>>;
  applied: string[][];
  searching: boolean[];
  fulfil: (index: number, results: string[]) => void;
}

function harness(): Harness {
  const deferreds: Array<ReturnType<typeof deferred<string[]>>> = [];
  const applied: string[][] = [];
  const searching: boolean[] = [];
  const runner = createSearchRunner<string, string>({
    search: () => {
      const d = deferred<string[]>();
      deferreds.push(d);
      return d.promise;
    },
    onResults: (r) => applied.push(r),
    onError: () => {},
    onSearching: (s) => searching.push(s),
    debounceMs: 1
  });
  return { runner, applied, searching, fulfil: (index, results) => deferreds[index]!.resolve(results) };
}

describe('createSearchRunner latest-wins invalidation', () => {
  it('ignores an in-flight fetch superseded by a newer request', async () => {
    const h = harness();
    h.runner.request('A');
    await delay(5); // A fetch fires
    h.runner.request('B'); // supersede A while it is in flight
    await delay(5); // B fetch fires
    h.fulfil(0, ['A-stale']); // A resolves LATE
    h.fulfil(1, ['B-fresh']);
    await delay(5);
    expect(h.applied).toEqual([['B-fresh']]); // A's stale result never applied
  });

  it('ignores an in-flight fetch after the query is cleared, and stops searching', async () => {
    const h = harness();
    h.runner.request('A');
    await delay(5); // A fetch fires (searching -> true)
    h.runner.request(null); // clear
    h.fulfil(0, ['A-stale']); // A resolves after the clear
    await delay(5);
    expect(h.applied).toEqual([[]]); // only the clear's empty results; A ignored
    expect(h.searching.at(-1)).toBe(false); // not stuck searching
  });

  it('ignores an in-flight fetch after cancel (close/unmount), with no late apply', async () => {
    const h = harness();
    h.runner.request('A');
    await delay(5); // A fetch fires
    h.runner.cancel();
    h.fulfil(0, ['A-stale']);
    await delay(5);
    expect(h.applied).toEqual([]); // nothing applied after cancel
  });
});
