import type { AgentFeedItem } from './rowsModel.js';

export interface NativeFocusAnchorState {
  lastSeenRowCount: number;
  rowCount: number;
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
    if (firstUnreadItem === 0) {
      // Everything on screen is unread: land at the top, not the latest.
      return 0;
    }
    if (firstUnreadItem > 0) {
      return firstUnreadItem - 1;
    }
  }
  return items.length - 1;
}

export interface PrunedFocusAnchorState {
  /** Last-seen row position in the model's ABSOLUTE (eviction-invariant) space. */
  lastSeenAbsolute: number;
  /** Top-level rows evicted from the front so far (RowModel.prunedRowCount). */
  prunedRowCount: number;
  /** Current retained top-level row count. */
  rowCount: number;
}

/**
 * Prune-aware focus anchor. Converts an absolute last-seen position to a local
 * index. If the last-seen boundary was ITSELF evicted (absolute > 0 but the local
 * index is <= 0), every retained row is unread → land at the first retained row
 * (index 0). Passing the clamped 0 straight into resolveNativeFocusAnchorIndex
 * would instead read as no-history and jump to the LATEST row.
 */
export function resolveFocusAnchorIndex(items: AgentFeedItem[], state: PrunedFocusAnchorState): number | null {
  if (items.length === 0) {
    return null;
  }
  const rawLocal = state.lastSeenAbsolute - state.prunedRowCount;
  if (state.lastSeenAbsolute > 0 && rawLocal <= 0) {
    return 0;
  }
  return resolveNativeFocusAnchorIndex(items, { lastSeenRowCount: Math.max(0, rawLocal), rowCount: state.rowCount });
}
