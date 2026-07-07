import { describe, expect, it, vi } from 'vitest';

import { resolveNativeFocusAnchorIndex, settleNativeFocusAnchorScroll } from '../../src/web/agentSurface/scrollAnchor.js';
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

  it('retries the focus anchor scroll until measured row heights settle', () => {
    const frames: FrameRequestCallback[] = [];
    const measuredTops = [100, 240, 240];
    let pass = 0;
    const scrollEl = { scrollHeight: 1200, scrollTop: 0 };
    const scrollToIndex = vi.fn(() => {
      scrollEl.scrollTop = measuredTops[Math.min(pass, measuredTops.length - 1)];
      pass += 1;
    });

    settleNativeFocusAnchorScroll({
      targetIndex: 7,
      latestIndex: 9,
      scrollToIndex,
      getScrollElement: () => scrollEl,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      maxPasses: 5
    });

    expect(scrollToIndex).toHaveBeenCalledTimes(1);

    frames.shift()?.(16);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);

    frames.shift()?.(32);
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
    expect(frames).toHaveLength(0);
  });

  it('pins the latest target to the physical bottom on each pass', () => {
    const frames: FrameRequestCallback[] = [];
    const scrollToIndex = vi.fn();
    const scrollEl = { scrollHeight: 1200, scrollTop: 0 };

    settleNativeFocusAnchorScroll({
      targetIndex: 9,
      latestIndex: 9,
      scrollToIndex,
      getScrollElement: () => scrollEl,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      maxPasses: 1
    });

    expect(scrollToIndex).toHaveBeenCalledWith(9, { align: 'end' });
    expect(scrollEl.scrollTop).toBe(1200);
    expect(frames).toHaveLength(0);
  });
});
