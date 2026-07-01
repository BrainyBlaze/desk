export const DESK_DURATIONS = Object.freeze({ enter: 0.32, exit: 0.18, stagger: 0.05 });

/** Reveal cadence for long data-driven lists (file trees, sessions, changes,
 * commits, channels, board cards). The ramp caps hard — rows past the limit
 * enter together — and each row's own enter is shortened, so a 200-row
 * directory expand reads as one ~250ms cascade instead of a multi-second
 * drip. Small fixed sets (context menus, rail buttons) keep the defaults. */
export const LIST_REVEAL = Object.freeze({ stagger: 0.012, limit: 8 });
export const LIST_ROW_DURATION = Object.freeze({ enter: 0.18 });

/** True when the user prefers reduced motion. Injectable for tests; safe without a window. */
export function isReducedMotion(matchMediaFn?: typeof window.matchMedia): boolean {
  try {
    const mm = matchMediaFn ?? (typeof window !== 'undefined' ? window.matchMedia.bind(window) : undefined);
    return mm ? mm('(prefers-reduced-motion: reduce)').matches : false;
  } catch {
    return false;
  }
}
