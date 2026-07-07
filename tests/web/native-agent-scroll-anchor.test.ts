import { describe, expect, it } from 'vitest';

import { resolveNativeFocusAnchorIndex } from '../../src/web/agentSurface/scrollAnchor.js';
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
});
