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
    if (firstUnreadItem > 0) {
      return firstUnreadItem - 1;
    }
  }
  return items.length - 1;
}
