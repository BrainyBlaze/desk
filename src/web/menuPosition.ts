import { useLayoutEffect, useRef } from 'react';

/**
 * Keep a fixed-position context menu inside the viewport: menus opening near
 * the bottom flip upward from the cursor, and ones near the right edge slide
 * left. Attach the returned ref to the menu element; render it with the raw
 * cursor coordinates as left/top and this corrects them before paint.
 */
export function useClampedMenu(point: { x: number; y: number } | null): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !point) {
      return;
    }
    const pad = 8;
    const rect = element.getBoundingClientRect();
    let top = point.y;
    let left = point.x;
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, point.y - rect.height);
    }
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, point.x - rect.width);
    }
    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
  }, [point]);
  return ref as React.RefObject<HTMLDivElement>;
}
