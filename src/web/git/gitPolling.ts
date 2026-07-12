export interface GitStatusPollingTimers {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(timer: number): void;
}

export function startGitStatusPolling(
  refresh: () => void,
  intervalMs: number,
  timers?: GitStatusPollingTimers
): () => void {
  const runtime =
    timers ??
    ({
      setInterval: (callback, delay) => window.setInterval(callback, delay),
      clearInterval: (timer) => window.clearInterval(timer)
    } satisfies GitStatusPollingTimers);
  refresh();
  const timer = runtime.setInterval(refresh, intervalMs);
  return () => runtime.clearInterval(timer);
}
