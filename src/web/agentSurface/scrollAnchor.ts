import type { AgentFeedItem } from './rowsModel.js';

export interface NativeFocusAnchorState {
  lastSeenRowCount: number;
  rowCount: number;
}

export interface NativeFocusAnchorScrollOptions {
  targetIndex: number;
  latestIndex: number;
  scrollToIndex: (index: number, options: { align: 'end' }) => void;
  getScrollElement: () => { scrollHeight: number; scrollTop: number } | null;
  requestFrame?: (callback: FrameRequestCallback) => number;
  maxPasses?: number;
}

export interface NativeFeedScrollGeometry {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNativeFeedDetachedFromBottom(geometry: NativeFeedScrollGeometry, threshold = 80): boolean {
  const bottomGap = Math.max(0, geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight);
  return bottomGap >= threshold;
}

export function resolveNativeFocusAnchorIndex(
  items: AgentFeedItem[],
  state: NativeFocusAnchorState
): number | null {
  if (items.length === 0) {
    return null;
  }
  const lastSeen = Math.max(0, Math.min(state.lastSeenRowCount, state.rowCount));
  if (lastSeen > 0 && state.rowCount > lastSeen) {
    const firstUnreadItem = items.findIndex((item) => item.lastRowIndex >= lastSeen);
    if (firstUnreadItem > 0) {
      return firstUnreadItem - 1;
    }
  }
  return items.length - 1;
}

export function settleNativeFocusAnchorScroll(options: NativeFocusAnchorScrollOptions): () => void {
  const maxPasses = Math.max(1, options.maxPasses ?? 3);
  const requestFrame = options.requestFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  let cancelled = false;
  let pass = 0;
  let lastScrollTop: number | null = null;

  const scroll = (): void => {
    if (cancelled) return;
    pass += 1;
    options.scrollToIndex(options.targetIndex, { align: 'end' });
    const el = options.getScrollElement();
    if (el && options.targetIndex === options.latestIndex) {
      el.scrollTop = el.scrollHeight;
    }
    const scrollTop = el?.scrollTop ?? null;
    const stable = scrollTop !== null && lastScrollTop !== null && Math.abs(scrollTop - lastScrollTop) < 1;
    lastScrollTop = scrollTop;
    if (pass < maxPasses && !stable) {
      requestFrame(scroll);
    }
  };

  scroll();
  return () => {
    cancelled = true;
  };
}
