import { describe, expect, it } from 'vitest';
import { computeGraph } from '../src/web/git/gitGraph';

describe('computeGraph', () => {
  it('keeps a linear history on lane 0', () => {
    const rows = computeGraph([
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: ['c0'] },
      { sha: 'c0', parents: [] }
    ]);
    expect(rows.map((row) => row.nodeLane)).toEqual([0, 0, 0]);
    expect(rows.every((row) => row.through.length === 0)).toBe(true);
    expect(rows[2]!.outOfNode).toEqual([]); // root commit has no parent edge
  });

  it('forks a merge commit into two lanes and joins them at the base', () => {
    // m -> (a, b); a -> base; b -> base; base -> root
    const rows = computeGraph([
      { sha: 'm', parents: ['a', 'b'] },
      { sha: 'a', parents: ['base'] },
      { sha: 'b', parents: ['base'] },
      { sha: 'base', parents: [] }
    ]);
    expect(rows[0]!.nodeLane).toBe(0);
    expect(rows[0]!.outOfNode).toEqual([0, 1]); // fans out to both parents
    expect(rows[1]!.nodeLane).toBe(0);
    expect(rows[1]!.through).toEqual([[1, 1]]); // b's lane passes by
    expect(rows[2]!.nodeLane).toBe(1);
    // base is now expected by both lane 0 and lane 1 — the first wins,
    // the second merges into the node.
    expect(rows[3]!.nodeLane).toBe(0);
    expect(rows[3]!.intoNode).toEqual([1]);
  });

  it('starts an unrelated branch tip on a fresh lane', () => {
    const rows = computeGraph([
      { sha: 'main2', parents: ['main1'] },
      { sha: 'feat1', parents: ['main1'] },
      { sha: 'main1', parents: [] }
    ]);
    expect(rows[0]!.nodeLane).toBe(0);
    expect(rows[1]!.nodeLane).toBe(1); // not expected by any lane -> new lane
    expect(rows[2]!.nodeLane).toBe(0);
    expect(rows[2]!.intoNode).toEqual([1]); // feature lane converges here
  });

  it('reports lane counts wide enough for every touched lane', () => {
    const rows = computeGraph([
      { sha: 'm', parents: ['a', 'b', 'c'] },
      { sha: 'a', parents: [] },
      { sha: 'b', parents: [] },
      { sha: 'c', parents: [] }
    ]);
    expect(rows[0]!.outOfNode).toEqual([0, 1, 2]);
    expect(rows[0]!.laneCount).toBe(3);
  });
});
