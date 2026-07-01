/**
 * Per-key LEADING-EDGE + trailing-latest scheduler that tames rapid provider churn
 * (edit/scroll re-fires of semanticTokens, codeLens, documentSymbol, foldingRange, inlayHint,
 * codeAction) WITHOUT delaying the first result.
 *
 * Scheduling contract:
 *  - LEADING: the first call for an idle key runs IMMEDIATELY (no debounce) -> no first-paint regression;
 *  - while a run is in flight (or within the trailing-quiet window), further calls queue as the single
 *    trailing-latest; each new one SUPERSEDES the previously-queued caller, which settles via cancellation
 *    ({@link ProviderSupersededError}) -- never hangs, never receives data for a stale range/context;
 *  - exactly one trailing run fires after the in-flight settles AND a quiet window elapses, carrying the
 *    LATEST caller's exec (so coarse method+uri keys collapse scroll/codeAction churn while the delivered
 *    caller still gets data for its own range/context);
 *  - in-flight runs are NOT cancelled by supersession (the leading/trailing result is delivered); only
 *    queued-and-replaced callers are cancelled. Dispose cancels timers, aborts in-flight, and rejects all.
 *
 * It never DROPS work (no starvation): an idle key's first call always runs, and the last call in a burst
 * always runs. It only schedules read-only provider requests -- not document sync (didChange) or
 * latency-sensitive direct actions (hover/definition/completion/rename/formatting/references/signatureHelp).
 */

export class ProviderSupersededError extends Error {
  constructor() {
    super('provider request superseded');
    this.name = 'ProviderSupersededError';
  }
}

export interface ProviderScheduler {
  /**
   * Schedule a keyed provider call. `key` should be coarse (method + uri) so rapid churn collapses;
   * the delivered caller still runs its OWN exec (its own range/context). Returns that exec's result,
   * or rejects with {@link ProviderSupersededError} if superseded/disposed.
   */
  run<T>(key: string, exec: (signal: AbortSignal) => Promise<T>): Promise<T>;
  dispose(): void;
}

/** Per-key trailing-quiet-window bounds (provider scheduling): the adaptive delay is clamped into [minMs, maxMs]. */
export interface ProviderDelayBounds {
  minMs: number;
  maxMs: number;
}

export interface ProviderSchedulerOptions {
  /** Fixed-delay shorthand: equivalent to boundsFor = () => {min:delayMs,max:delayMs}. */
  delayMs?: number;
  /** Per-key adaptive bounds (provider scheduling). Takes precedence over delayMs. The key is the coarse method+uri string. */
  boundsFor?: (key: string) => ProviderDelayBounds;
  /** Sliding-window size for the per-key latency history (default 6). */
  windowSize?: number;
  /** Monotonic clock for latency measurement; injectable for tests. Defaults to performance.now/Date.now. */
  now?: () => number;
}

interface QueuedCall {
  exec: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface KeyState {
  inFlight: boolean;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  trailing: QueuedCall | null;
}

/**
 * Per-method adaptive-window bounds for the six scheduled burst providers (provider scheduling). Floors come from the
 * VS Code research (inlay fastest, documentSymbol slowest); ceilings cap the trailing wait so a slow
 * server never stalls the coalesced run indefinitely. The key is the coarse `${method}|${uri}` string;
 * an unrecognized method falls back to a conservative default. Pure + exported for unit tests.
 */
const PROVIDER_DELAY_BOUNDS: Record<string, ProviderDelayBounds> = {
  inlayHint: { minMs: 25, maxMs: 400 },
  semanticTokens: { minMs: 100, maxMs: 600 },
  foldingRange: { minMs: 200, maxMs: 600 },
  codeLens: { minMs: 250, maxMs: 800 },
  codeAction: { minMs: 250, maxMs: 800 },
  documentSymbol: { minMs: 350, maxMs: 1000 }
};
const DEFAULT_PROVIDER_DELAY_BOUNDS: ProviderDelayBounds = { minMs: 150, maxMs: 600 };

export function providerDelayBounds(key: string): ProviderDelayBounds {
  const method = key.slice(0, key.indexOf('|') === -1 ? key.length : key.indexOf('|'));
  return PROVIDER_DELAY_BOUNDS[method] ?? DEFAULT_PROVIDER_DELAY_BOUNDS;
}

export function createImmediateProviderScheduler(): ProviderScheduler {
  return {
    run: <T>(_key: string, exec: (signal: AbortSignal) => Promise<T>): Promise<T> => exec(new AbortController().signal),
    dispose: (): void => undefined
  };
}

const DEFAULT_WINDOW_SIZE = 6;
const DEFAULT_DELAY_MS = 150;

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function createProviderScheduler(options: ProviderSchedulerOptions = {}): ProviderScheduler {
  const keys = new Map<string, KeyState>();
  // Per-key latency history (provider scheduling). Persists across bursts/idle so the adaptive window survives key churn,
  // unlike the transient KeyState which is deleted when a key goes idle. Bounded to windowSize.
  const latencies = new Map<string, number[]>();
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const now = options.now ?? defaultNow;
  const boundsFor =
    options.boundsFor ??
    (() => {
      const fixed = options.delayMs ?? DEFAULT_DELAY_MS;
      return { minMs: fixed, maxMs: fixed };
    });
  let disposed = false;

  const recordLatency = (key: string, ms: number): void => {
    const ring = latencies.get(key);
    if (ring) {
      ring.push(ms);
      if (ring.length > windowSize) {
        ring.shift();
      }
    } else {
      latencies.set(key, [ms]);
    }
  };

  // Adaptive trailing-quiet window: the average of recent observed latencies for this key, clamped into
  // the per-method [minMs, maxMs] bounds. With no history yet, fall back to the floor (minMs).
  const delayForKey = (key: string): number => {
    const bounds = boundsFor(key);
    const ring = latencies.get(key);
    if (!ring || ring.length === 0) {
      return bounds.minMs;
    }
    const avg = ring.reduce((sum, value) => sum + value, 0) / ring.length;
    return Math.min(bounds.maxMs, Math.max(bounds.minMs, avg));
  };

  const startRun = (key: string, state: KeyState, call: QueuedCall): void => {
    state.inFlight = true;
    state.controller = new AbortController();
    const signal = state.controller.signal;
    const startedAt = now();
    const settle = (): void => {
      state.inFlight = false;
      state.controller = null;
      // Record the observed exec latency for this key's adaptive window (timing only; never affects the
      // delivered value or the fresh-result/resultId invariants, which live in the provider exec).
      recordLatency(key, Math.max(0, now() - startedAt));
    };
    Promise.resolve(call.exec(signal)).then(
      (value) => {
        settle();
        // Disposed while in flight (e.g. root switch / session close): never deliver a late result --
        // settle the caller as cancellation instead, per the dispose/root-switch cleanup contract.
        if (disposed) {
          call.reject(new ProviderSupersededError());
          return;
        }
        call.resolve(value);
        afterSettle(key, state);
      },
      (error: unknown) => {
        settle();
        if (disposed) {
          call.reject(new ProviderSupersededError());
          return;
        }
        call.reject(error instanceof Error ? error : new Error(String(error)));
        afterSettle(key, state);
      }
    );
  };

  // Run the trailing-latest once the in-flight has settled and the quiet window has elapsed; otherwise
  // wait. When nothing is queued and nothing is running, the key goes idle (so the next call leads again).
  const afterSettle = (key: string, state: KeyState): void => {
    if (state.inFlight || state.timer !== null) {
      return;
    }
    if (state.trailing) {
      const next = state.trailing;
      state.trailing = null;
      startRun(key, state, next);
      return;
    }
    if (keys.get(key) === state) {
      keys.delete(key);
    }
  };

  const armTrailingTimer = (key: string, state: KeyState): void => {
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      afterSettle(key, state);
    }, delayForKey(key));
  };

  const run = <T>(key: string, exec: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const promise = new Promise<T>((resolve, reject) => {
      if (disposed) {
        reject(new ProviderSupersededError());
        return;
      }
      const call: QueuedCall = {
        exec: exec as (signal: AbortSignal) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      };
      const existing = keys.get(key);
      if (!existing) {
        // LEADING edge: idle key -> run immediately, no delay.
        const state: KeyState = { inFlight: false, controller: null, timer: null, trailing: null };
        keys.set(key, state);
        startRun(key, state, call);
        return;
      }
      // Busy key: become the trailing-latest; supersede any previously-queued caller.
      if (existing.trailing) {
        existing.trailing.reject(new ProviderSupersededError());
      }
      existing.trailing = call;
      armTrailingTimer(key, existing);
    });
    // A superseded caller may reject before the consumer attaches a handler; keep it from being an
    // *unhandled* rejection while the returned promise still rejects for the caller.
    promise.catch(() => undefined);
    return promise;
  };

  const dispose = (): void => {
    disposed = true;
    for (const state of keys.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.controller) {
        state.controller.abort();
      }
      if (state.trailing) {
        state.trailing.reject(new ProviderSupersededError());
        state.trailing = null;
      }
    }
    keys.clear();
  };

  return { run, dispose };
}
