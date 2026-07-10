// Small helpers for fire-and-forget side effects and error stringification.
//
// The codebase had no central place to route dropped promises, so ~40 call
// sites did `.catch(() => undefined)` and lost every failure silently. For
// cosmetic side effects (clipboard) that is fine; for state-persistence paths
// (settings, read-state) a silent failure is a real UX bug. `fireAndForget`
// keeps the fire-and-forget ergonomics but at least surfaces the failure to the
// console (and gives us one seam to route to real telemetry later).

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fireAndForget(promise: Promise<unknown>, context: string): void {
  void promise.catch((error: unknown) => {
    console.warn(`[desk] ${context} failed: ${toErrorMessage(error)}`);
  });
}
