import { describe, expect, it } from 'vitest';
import { countSidebarAgents } from '../src/web/sidebarCounts';

describe('sidebar counts', () => {
  it('counts sessions, not projects', () => {
    expect(
      countSidebarAgents([
        { groups: [{ sessions: [{}, {}, {}] }] },
        { groups: [{ sessions: [{}] }, { sessions: [{}, {}] }] },
        { groups: [] }
      ])
    ).toBe(6);
  });
});
