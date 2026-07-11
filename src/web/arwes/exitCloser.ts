/**
 * Single-shot exit timer for modal/overlay dismissal. Desk overlays run a short
 * exit animation, then commit teardown (onClose) after the animation window.
 * Two triggers race here: the X button and the Escape key both call the dismiss
 * path, so the delayed commit must fire exactly once. request() is single-shot:
 * the first call arms a one-shot timer; later calls are ignored whether the timer
 * is still pending OR has already fired (a stray late Escape after onClose can
 * never schedule a second teardown). dispose() cancels a still-pending commit so
 * onExit never runs after unmount.
 *
 * Node-tested (tests/web/exit-closer.test.ts) — the React component just holds
 * one instance in a ref, calls request() from both triggers, and dispose()s on
 * unmount.
 */
export interface ExitCloser {
  /** Arm a one-shot onExit after delayMs; a no-op once armed (pending or fired). */
  request(onExit: () => void): void;
  /** Cancel a pending commit (unmount) so onExit does not run on a dead tree. */
  dispose(): void;
}

export function createExitCloser(delayMs: number): ExitCloser {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    request(onExit: () => void): void {
      if (timer !== null) {
        return;
      }
      timer = setTimeout(onExit, delayMs);
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
