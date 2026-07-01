import { describe, expect, it } from 'vitest';
import {
  AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX,
  AGENT_SIDEBAR_DEFAULT_SIZE,
  AGENT_SIDEBAR_MIN_SIZE,
  isAgentSidebarCollapseSize,
  readStoredSidebarCollapsed
} from '../src/web/sidebarPanel';

describe('agent sidebar panel state', () => {
  it('auto-collapses only when resized strictly below the threshold', () => {
    // The default width equals the threshold: resting there must NOT arm the
    // release-snap collapse, otherwise freshly opened sidebars snap shut on
    // the next click.
    expect(isAgentSidebarCollapseSize(AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX)).toBe(false);
    expect(isAgentSidebarCollapseSize(AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX - 1)).toBe(true);
    expect(isAgentSidebarCollapseSize(AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX + 1)).toBe(false);
  });

  it('opens at the minimal width by default (all subsystem sidebars)', () => {
    expect(AGENT_SIDEBAR_DEFAULT_SIZE).toBe(AGENT_SIDEBAR_MIN_SIZE);
    expect(AGENT_SIDEBAR_DEFAULT_SIZE).toBe(`${AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX}px`);
  });

  it('only restores a stored collapsed state from an explicit true value', () => {
    expect(readStoredSidebarCollapsed('true')).toBe(true);
    expect(readStoredSidebarCollapsed('false')).toBe(false);
    expect(readStoredSidebarCollapsed(null)).toBe(false);
  });
});
