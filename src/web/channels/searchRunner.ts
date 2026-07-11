// Debounced "latest wins" search controller, extracted from SearchView so the async
// race is testable without a component harness (there is no RTL/jsdom in-repo).
//
// The sequence is bumped on EVERY request (and on cancel), not when the debounced
// fetch fires — so an in-flight fetch that resolves after a newer request, after the
// query is cleared, or after the modal closes/unmounts is always ignored. `request(null)`
// means "no active query" (empty input or closed): clear results and stop searching.

export interface SearchRunner<Params, Result> {
  /** Call on every open/query/filter change. `null` params = clear + invalidate. */
  request(params: Params | null): void;
  /** Unmount: clear the pending timer and invalidate any in-flight fetch (no callbacks). */
  cancel(): void;
}

export interface SearchRunnerConfig<Params, Result> {
  search: (params: Params) => Promise<Result[]>;
  onResults: (results: Result[]) => void;
  onError: (message: string | null) => void;
  onSearching: (searching: boolean) => void;
  debounceMs?: number;
}

export function createSearchRunner<Params, Result>(
  config: SearchRunnerConfig<Params, Result>
): SearchRunner<Params, Result> {
  const debounceMs = config.debounceMs ?? 300;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    request(params): void {
      seq += 1;
      const mySeq = seq;
      clearTimer();
      if (params === null) {
        config.onResults([]);
        config.onError(null);
        config.onSearching(false);
        return;
      }
      timer = setTimeout(() => {
        config.onSearching(true);
        void config
          .search(params)
          .then((results) => {
            if (mySeq !== seq) {
              return;
            }
            config.onResults(results);
            config.onError(null);
          })
          .catch((error: unknown) => {
            if (mySeq === seq) {
              config.onError(error instanceof Error ? error.message : String(error));
            }
          })
          .finally(() => {
            if (mySeq === seq) {
              config.onSearching(false);
            }
          });
      }, debounceMs);
    },
    cancel(): void {
      seq += 1;
      clearTimer();
    }
  };
}
