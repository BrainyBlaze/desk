/**
 * Concurrency gate for full channel-detail refetches.
 *
 * The live poll re-triggers a full `refreshDetail` whenever the polled summary's
 * content revision differs from the loaded detail's — and it does so on EVERY
 * tick until the refetch lands. Without a guard two hazards appear:
 *
 *   1. Overlap — a slow refetch launched on tick N is still pending when tick
 *      N+1 fires another, so the same reconcile runs two (or more) times.
 *   2. Stale-overwrite — `channelsDetail` reads server state when the request is
 *      handled (~launch time) but applies it when it resolves. Two in-flight
 *      reads can resolve in the opposite order they launched, so an OLDER
 *      snapshot overwrites a newer mutation and the feed regresses.
 *
 * This gate makes reconcile refetches single-flight per channel (dedupe → only
 * one request) and sequences every refetch (only the latest-STARTED response
 * for a channel may apply → a stale response can never win). It is a pure,
 * framework-free helper so the race is unit-testable without a DOM harness.
 */
export interface DetailRefreshGate {
  /**
   * Register the start of a refresh for `key`.
   * @param dedupe when true (the poll's reconcile path), returns `null` if a
   *   refresh is already in flight for `key` — the caller must NOT launch a
   *   request. When false (an explicit user/anchor reload), always proceeds so a
   *   deliberate reload is never dropped; it still gets a fresh token so it
   *   supersedes any older in-flight response.
   * @returns a monotonic token to pass to {@link isCurrent}/{@link end}, or
   *   `null` when the call was deduped.
   */
  begin(key: string, dedupe: boolean): number | null;
  /** True only if `token` is still the latest-started refresh for `key` — i.e.
   *  no newer refresh has begun since. Gate `setDetail` behind this. */
  isCurrent(key: string, token: number): boolean;
  /** Mark the refresh for `key` finished (frees the single-flight slot). Call in
   *  a `finally`, whether or not the response was applied. */
  end(key: string, token: number): void;
}

export function createDetailRefreshGate(): DetailRefreshGate {
  const latestToken = new Map<string, number>();
  // The SET of tokens currently in flight per key — not a single bit. end() must
  // remove only its own token, so that ending an older request (e.g. a settled
  // reconcile) can never free the slot held by a newer request still pending
  // (e.g. an explicit reload). A key is "in flight" iff its set is non-empty.
  const inFlight = new Map<string, Set<number>>();

  return {
    begin(key, dedupe) {
      const active = inFlight.get(key);
      if (dedupe && active && active.size > 0) {
        return null;
      }
      const token = (latestToken.get(key) ?? 0) + 1;
      latestToken.set(key, token);
      if (active) {
        active.add(token);
      } else {
        inFlight.set(key, new Set([token]));
      }
      return token;
    },
    isCurrent(key, token) {
      return latestToken.get(key) === token;
    },
    end(key, token) {
      const active = inFlight.get(key);
      if (!active) {
        return;
      }
      active.delete(token); // remove ONLY the ending token — never a newer one
      if (active.size === 0) {
        inFlight.delete(key);
      }
    }
  };
}
