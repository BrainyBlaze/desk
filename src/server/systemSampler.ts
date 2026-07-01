import { collectSystemSnapshot, collectSystemSnapshotAsync } from './systemMetrics.js';
import type { SystemSnapshot } from '../shared/systemMetrics.js';

/**
 * Background system-metrics sampler. The round-2 research found /api/pulse ran
 * nvidia-smi + `command -v` probes synchronously inside the request handler,
 * blocking the event loop ~70ms every tick and stuttering every terminal stream
 * (a bare-ws probe went from 0 gaps>60ms quiet to 133/146 under pulse load). The
 * fix: collect off the loop on a timer, async, and have the pulse serve the
 * cached snapshot. Collection cost is now independent of client count, and the
 * single sampler computes CPU/net/disk rates over uniform windows (the previous
 * per-request collection wobbled rates when two tabs ticked out of phase).
 */
let cachedSnapshot: SystemSnapshot | null = null;
let timer: NodeJS.Timeout | undefined;
let inFlight = false;

async function sample(): Promise<void> {
  if (inFlight) {
    return; // a slow nvidia-smi must not stack overlapping samples
  }
  inFlight = true;
  try {
    cachedSnapshot = await collectSystemSnapshotAsync();
  } catch {
    // keep the last good snapshot; a transient GPU/proc hiccup is not fatal
  } finally {
    inFlight = false;
  }
}

/** Starts the background sampler (idempotent). */
export function startSystemSampling(intervalMs = 2000): void {
  if (timer) {
    return;
  }
  // Seed synchronously so the very first pulse after boot has real data and the
  // CPU/net/disk deltas have a baseline; subsequent samples are async.
  cachedSnapshot = collectSystemSnapshot();
  void sample();
  timer = setInterval(() => void sample(), intervalMs);
  timer.unref?.();
}

/**
 * The latest cached snapshot. Falls back to a one-off synchronous collect only
 * if the sampler was never started (e.g. a unit test hitting the route directly).
 */
export function getSystemSnapshot(): SystemSnapshot {
  return cachedSnapshot ?? collectSystemSnapshot();
}

/** Test hook: stop the sampler and clear cached state. */
export function stopSystemSampling(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  cachedSnapshot = null;
}
