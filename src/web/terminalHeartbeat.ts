/**
 * Bridge-retry heartbeat. A terminal whose websocket exhausted its reconnect
 * backoff (5 attempts, ~15s) used to sit dead behind a manual Reconnect button
 * forever — waking a laptop after a sleep left a wall of dead cells. The pulse
 * already proves the server is reachable, so when a pulse SUCCEEDS after a run
 * of failures the App emits here and every stranded TerminalSurface re-arms.
 * Module-level pub/sub (same shape as gitRevision) so the surfaces subscribe
 * without prop-drilling through the whole mux tree.
 */
const listeners = new Set<() => void>();

export function subscribeBridgeRetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fire a retry signal to every subscribed terminal surface. */
export function emitBridgeRetry(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}
