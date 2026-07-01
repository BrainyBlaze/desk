/**
 * Lane layout for the commit graph rail. Commits arrive in topological order
 * (git log --topo-order); each row gets a node lane plus the connector
 * segments needed to draw the rail without looking at neighboring rows.
 */

export interface GraphInput {
  sha: string;
  parents: string[];
}

export interface GraphRow {
  /** lane the commit dot sits on */
  nodeLane: number;
  /** lanes (in the row above's ordering) that merge into this node */
  intoNode: number[];
  /** lanes (in the row below's ordering) this node forks out to (its parents) */
  outOfNode: number[];
  /** continuing lanes: [laneAbove, laneBelow] pairs that pass this row by */
  through: Array<[number, number]>;
  /** widest lane index touched by this row (for svg sizing) */
  laneCount: number;
}

/** Assign lanes to a topo-ordered slice of history. */
export function computeGraph(commits: GraphInput[]): GraphRow[] {
  // Each active lane holds the sha it expects to see next.
  let lanes: string[] = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const firstMatch = lanes.indexOf(commit.sha);
    const nodeLane = firstMatch === -1 ? lanes.length : firstMatch;

    // Recompose the next row's lanes in order: lanes expecting this sha
    // collapse into the node; the node's slot continues as the first parent.
    // Every lane left of nodeLane survives (nodeLane is the first match), so
    // the first parent lands at index nodeLane in the next row.
    const next: string[] = [];
    const through: Array<[number, number]> = [];
    const intoNode: number[] = [];
    lanes.forEach((expected, index) => {
      if (index === nodeLane) {
        if (commit.parents.length > 0) {
          next.push(commit.parents[0]!);
        }
        return;
      }
      if (expected === commit.sha) {
        intoNode.push(index);
        return;
      }
      next.push(expected);
      through.push([index, next.length - 1]);
    });
    if (firstMatch === -1 && commit.parents.length > 0) {
      // brand-new tip: its first parent continues on the appended lane
      next.push(commit.parents[0]!);
    }

    const outOfNode: number[] = [];
    if (commit.parents.length > 0) {
      outOfNode.push(nodeLane);
    }
    for (const parent of commit.parents.slice(1)) {
      const existing = next.indexOf(parent);
      if (existing !== -1) {
        outOfNode.push(existing);
      } else {
        next.push(parent);
        outOfNode.push(next.length - 1);
      }
    }

    const laneCount = Math.max(nodeLane + 1, next.length, lanes.length);
    rows.push({ nodeLane, intoNode, outOfNode, through, laneCount });
    lanes = next;
  }

  return rows;
}

/** Stable per-lane color cycle for the rail strokes. */
export const GRAPH_LANE_COLORS = 6;

export function laneColorIndex(lane: number): number {
  return ((lane % GRAPH_LANE_COLORS) + GRAPH_LANE_COLORS) % GRAPH_LANE_COLORS;
}
