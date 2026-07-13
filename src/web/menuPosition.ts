import { useLayoutEffect, useRef } from 'react';

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

export function clampMenuPosition(
  point: Point,
  menu: Size,
  viewport: Size,
  pad = 8
): { left: number; top: number } {
  const flippedLeft = point.x + menu.width > viewport.width - pad ? point.x - menu.width : point.x;
  const flippedTop = point.y + menu.height > viewport.height - pad ? point.y - menu.height : point.y;
  const maxLeft = Math.max(pad, viewport.width - pad - menu.width);
  const maxTop = Math.max(pad, viewport.height - pad - menu.height);
  return {
    left: Math.min(maxLeft, Math.max(pad, flippedLeft)),
    top: Math.min(maxTop, Math.max(pad, flippedTop))
  };
}

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
    const rect = element.getBoundingClientRect();
    const { left, top } = clampMenuPosition(
      point,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
  }, [point]);
  return ref as React.RefObject<HTMLDivElement>;
}
