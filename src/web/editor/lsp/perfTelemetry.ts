/**
 * Opt-in, read-only LSP performance telemetry. Gated by `globalThis.DESK_LSP_PERF`; when
 * off, every record call is a cheap no-op so there is ZERO behavior or scheduling change. It only
 * collects safe fields -- LSP method names, counts, and millisecond timings relative to file-open --
 * never document text, diagnostic messages, command/env/init, payloads, or paths beyond the open uri.
 *
 * This is measurement only. No debounce/defer/coalescing/backpressure lives here.
 */

export type RequestStage = 'start' | 'finish' | 'cancel';

interface MethodCount {
  start: number;
  finish: number;
  cancel: number;
}

export interface PerfSnapshot {
  t0: number | null;
  methodCounts: Record<string, MethodCount>;
  /**
   * First-arrival timings (ms from open) keyed by a precise event name. NOTE: `semanticTokensResponse`
   * is the provider request-finish/apply proxy, NOT visible paint -- the Playwright proof observes the
   * actual rendered `.mtk*` token spans for the true "first visible semantic token" metric.
   */
  firstResultMs: Record<string, number>;
  /** Client-side session create -> ready (browser roundtrip). */
  sessionReadyMs: number | null;
  /** Backend ready-envelope timing (only when the bridge is connected with lspTelemetry=1). */
  backendCreateSessionMs: number | null;
  backendAcceptToReadyMs: number | null;
  /** Long-task observer signal; count 0 means no long tasks observed (treat as inconclusive, not "responsive"). */
  longTasks: { count: number; totalMs: number; supported: boolean };
  /** Heartbeat lag over the sample window -- max timer drift (scheduled vs actual) is the simple
   *  responsiveness signal; works headless where requestAnimationFrame/longtask may not fire. */
  uiLag: { samples: number; maxMs: number };
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

let enabled = false;
let initialized = false;
const PERF_RUNTIME_KEY = '__deskLspPerfRuntime';
let nowFn: () => number = defaultNow;
let t0: number | null = null;
let methodCounts: Record<string, MethodCount> = {};
let firstResultMs: Record<string, number> = {};
let sessionCreateAt: number | null = null;
let sessionReadyMs: number | null = null;
let backendCreateSessionMs: number | null = null;
let backendAcceptToReadyMs: number | null = null;
const longTasks = { count: 0, totalMs: 0, supported: false };
const uiLag = { samples: 0, maxMs: 0 };

/** Enable/disable at runtime (production reads the global via initPerfTelemetry; tests call directly). */
export function setPerfEnabled(value: boolean): void {
  enabled = value;
}

export function isPerfEnabled(): boolean {
  return enabled;
}

/** Test seam: inject a deterministic clock, or pass null to restore the real one. */
export function __setPerfNow(fn: (() => number) | null): void {
  nowFn = fn ?? defaultNow;
}

export function perfReset(): void {
  t0 = null;
  methodCounts = {};
  firstResultMs = {};
  sessionCreateAt = null;
  sessionReadyMs = null;
  backendCreateSessionMs = null;
  backendAcceptToReadyMs = null;
  longTasks.count = 0;
  longTasks.totalMs = 0;
  // Preserve longTasks.supported across reset: the observer stays installed, so its support status is
  // a session capability, not per-measurement state.
  uiLag.samples = 0;
  uiLag.maxMs = 0;
}

/** Mark the file-open moment; the first call sets the t0 all first-result timings are relative to. */
export function perfMarkOpen(): void {
  if (!enabled) {
    return;
  }
  if (t0 === null) {
    t0 = nowFn();
  }
}

export function perfMarkRequest(method: string, phase: RequestStage): void {
  if (!enabled) {
    return;
  }
  const count = (methodCounts[method] ??= { start: 0, finish: 0, cancel: 0 });
  count[phase] += 1;
}

/** Record the first time a visible result of `kind` (diagnostic/semanticTokens/problems) arrived. */
export function perfMarkFirst(kind: string): void {
  if (!enabled || t0 === null) {
    return;
  }
  if (firstResultMs[kind] === undefined) {
    firstResultMs[kind] = nowFn() - t0;
  }
}

export function perfMarkSessionCreate(): void {
  if (!enabled) {
    return;
  }
  sessionCreateAt = nowFn();
}

export function perfMarkSessionReady(): void {
  if (!enabled || sessionCreateAt === null) {
    return;
  }
  sessionReadyMs = nowFn() - sessionCreateAt;
}

/** Record the backend ready-envelope timing (from the bridge when lspTelemetry=1). Safe numbers only. */
export function perfMarkBackendReady(createSessionMs: number, acceptToReadyMs: number): void {
  if (!enabled) {
    return;
  }
  backendCreateSessionMs = createSessionMs;
  backendAcceptToReadyMs = acceptToReadyMs;
}

/** Internal: record a browser long task (main-thread block) -- the UI-responsiveness signal. */
function recordLongTask(durationMs: number): void {
  if (!enabled) {
    return;
  }
  longTasks.count += 1;
  longTasks.totalMs += durationMs;
}

export function perfSnapshot(): PerfSnapshot {
  return {
    t0,
    methodCounts: structuredCloneSafe(methodCounts),
    firstResultMs: { ...firstResultMs },
    sessionReadyMs,
    backendCreateSessionMs,
    backendAcceptToReadyMs,
    longTasks: { ...longTasks },
    uiLag: { ...uiLag }
  };
}

function structuredCloneSafe(value: Record<string, MethodCount>): Record<string, MethodCount> {
  const out: Record<string, MethodCount> = {};
  for (const [key, count] of Object.entries(value)) {
    out[key] = { ...count };
  }
  return out;
}

/**
 * Production init (browser only): reads the opt-in global, installs a longtask observer for the
 * UI-responsiveness signal, and exposes the snapshot on window for the Playwright proof to read.
 * Safe to call when the global is unset -- it leaves telemetry disabled and installs nothing.
 */
export function initPerfTelemetry(): void {
  const flag = (globalThis as Record<string, unknown>).DESK_LSP_PERF;
  if (flag !== true && flag !== '1') {
    return;
  }
  // A second call within the SAME module instance is a no-op.
  if (initialized) {
    return;
  }
  initialized = true;
  // But Vite HMR re-evaluates the module (resetting `initialized`) while the prior
  // instance's observer + heartbeat stay alive on globalThis. Dispose that prior runtime
  // before installing a fresh one so resources never stack.
  const priorRuntime = (globalThis as Record<string, unknown>)[PERF_RUNTIME_KEY] as
    | { dispose?: () => void }
    | undefined;
  priorRuntime?.dispose?.();
  setPerfEnabled(true);
  (globalThis as Record<string, unknown>).__deskLspPerfSnapshot = () => perfSnapshot();
  (globalThis as Record<string, unknown>).__deskLspPerfReset = () => perfReset();
  let perfObserver: PerformanceObserver | undefined;
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          recordLongTask(entry.duration);
        }
      });
      perfObserver.observe({ entryTypes: ['longtask'] });
      longTasks.supported = true;
    }
  } catch {
    /* longtask not supported: rafLag below is the fallback responsiveness signal */
  }
  // Heartbeat: schedule a timer every intervalMs for ~180s (the whole measurement session) and
  // record the worst drift (actual minus scheduled). A large max drift = the main thread was
  // blocked (poor responsiveness). Timer-drift is used instead of requestAnimationFrame because
  // RAF/longtask do not fire reliably in headless Chromium, so this signal is available in both
  // the Playwright proof and a real browser.
  let heartbeatStopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof setTimeout === 'function') {
      const windowMs = 180000;
      const intervalMs = 50;
      const startedAt = nowFn();
      let expected = startedAt + intervalMs;
      const tick = (): void => {
        if (heartbeatStopped) {
          return;
        }
        const t = nowFn();
        const drift = t - expected;
        uiLag.samples += 1;
        if (drift > uiLag.maxMs) {
          uiLag.maxMs = drift;
        }
        expected += intervalMs;
        if (t - startedAt < windowMs) {
          heartbeatTimer = setTimeout(tick, intervalMs);
        }
      };
      heartbeatTimer = setTimeout(tick, intervalMs);
    }
  } catch {
    /* no setTimeout: skip the heartbeat */
  }
  // Publish a disposer so the next module instance (HMR) can tear this runtime down.
  (globalThis as Record<string, unknown>)[PERF_RUNTIME_KEY] = {
    dispose: (): void => {
      heartbeatStopped = true;
      if (heartbeatTimer !== undefined) {
        clearTimeout(heartbeatTimer);
      }
      perfObserver?.disconnect();
    }
  };
}
