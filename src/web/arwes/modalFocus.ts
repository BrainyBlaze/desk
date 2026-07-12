const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function getModalFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest('[inert]') || element.closest('[aria-hidden="true"]')) {
      return false;
    }
    return element.getClientRects().length > 0;
  });
}

/** Returns the focus target only when native Tab would leave the dialog. */
export function nextModalFocusIndex(count: number, activeIndex: number, backwards: boolean): number | null {
  if (count <= 0) {
    return null;
  }
  if (backwards) {
    return activeIndex <= 0 ? count - 1 : null;
  }
  return activeIndex < 0 || activeIndex >= count - 1 ? 0 : null;
}

export function isTopLayer<T>(layer: T, layers: readonly T[]): boolean {
  return layers.length > 0 && layers[layers.length - 1] === layer;
}
