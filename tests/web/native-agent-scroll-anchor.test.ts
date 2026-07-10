import { describe, expect, it } from 'vitest';

import {
  resolveFocusAnchorIndex,
  resolveNativeFocusAnchorIndex
} from '../../src/web/agentSurface/scrollAnchor.js';
import type { AgentFeedItem } from '../../src/web/agentSurface/rowsModel.js';

const rowItem = (rowIndex: number): AgentFeedItem => ({
  kind: 'row',
  id: `row-${rowIndex}`,
  row: { kind: 'system', id: `row-${rowIndex}`, text: `row ${rowIndex}` },
  rowIndex,
  firstRowIndex: rowIndex,
  lastRowIndex: rowIndex
});

describe('native agent focus scroll anchor', () => {
  it('anchors refocus at the latest seen row when unseen rows exist', () => {
    const items = [rowItem(0), rowItem(1), rowItem(2), rowItem(3)];

    expect(resolveNativeFocusAnchorIndex(items, { lastSeenRowCount: 2, rowCount: 4 })).toBe(1);
  });

  it('anchors refocus at the latest row when all rows are already seen', () => {
    const items = [rowItem(0), rowItem(1), rowItem(2)];

    expect(resolveNativeFocusAnchorIndex(items, { lastSeenRowCount: 3, rowCount: 3 })).toBe(2);
  });

  it('resolveFocusAnchorIndex lands on the first retained row when the last-seen boundary was evicted', () => {
    const items = [rowItem(0), rowItem(1), rowItem(2), rowItem(3)];
    // Seen through absolute position 5, but 6 top-level rows have been pruned, so
    // the boundary is below the retained window: everything on screen is unread.
    expect(resolveFocusAnchorIndex(items, { lastSeenAbsolute: 5, prunedRowCount: 6, rowCount: 4 })).toBe(0);
  });

  it('resolveFocusAnchorIndex converts an in-window absolute boundary to a local anchor', () => {
    const items = [rowItem(0), rowItem(1), rowItem(2), rowItem(3)];
    // Absolute 5 with 3 pruned -> local last-seen 2 -> anchor at the row before the first unread.
    expect(resolveFocusAnchorIndex(items, { lastSeenAbsolute: 5, prunedRowCount: 3, rowCount: 4 })).toBe(1);
  });

  it('resolveFocusAnchorIndex treats no history (absolute 0) as latest, not top', () => {
    const items = [rowItem(0), rowItem(1), rowItem(2)];
    expect(resolveFocusAnchorIndex(items, { lastSeenAbsolute: 0, prunedRowCount: 0, rowCount: 3 })).toBe(2);
  });
});
