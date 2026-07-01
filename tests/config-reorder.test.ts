import { describe, expect, it } from 'vitest';
import {
  reorderProjectsInManifest,
  reorderGroupsInManifest,
  reorderSessionsInManifest,
  setGroupLayoutSizesInManifest
} from '../src/core/config';
import type { DeskManifest } from '../src/core/types';

function manifest(): DeskManifest {
  return {
    groups: [],
    projects: [
      {
        id: 'alpha',
        cwd: '/a',
        groups: [
          { id: 'g1', sessions: [{ name: 's1' }, { name: 's2' }, { name: 's3' }] },
          { id: 'g2', sessions: [] }
        ]
      },
      { id: 'beta', cwd: '/b', groups: [] }
    ]
  };
}

describe('reorderProjectsInManifest', () => {
  it('reorders projects and stamps explicit order', () => {
    const next = reorderProjectsInManifest(manifest(), ['beta', 'alpha']);
    expect(next.projects?.map((p) => p.id)).toEqual(['beta', 'alpha']);
    expect(next.projects?.map((p) => p.order)).toEqual([0, 1]);
  });
});

describe('reorderGroupsInManifest', () => {
  it('reorders groups within a project', () => {
    const next = reorderGroupsInManifest(manifest(), { projectId: 'alpha', orderedGroupIds: ['g2', 'g1'] });
    const alpha = next.projects?.find((p) => p.id === 'alpha');
    expect(alpha?.groups.map((g) => g.id)).toEqual(['g2', 'g1']);
    expect(alpha?.groups.map((g) => g.order)).toEqual([0, 1]);
  });
});

describe('reorderSessionsInManifest', () => {
  it('reorders sessions within a group', () => {
    const next = reorderSessionsInManifest(manifest(), {
      projectId: 'alpha',
      groupId: 'g1',
      orderedSessionNames: ['s3', 's1', 's2']
    });
    const g1 = next.projects?.find((p) => p.id === 'alpha')?.groups.find((g) => g.id === 'g1');
    expect(g1?.sessions.map((s) => s.name)).toEqual(['s3', 's1', 's2']);
    expect(g1?.sessions.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it('throws for an unknown group', () => {
    expect(() =>
      reorderSessionsInManifest(manifest(), { projectId: 'alpha', groupId: 'nope', orderedSessionNames: [] })
    ).toThrow();
  });
});

describe('setGroupLayoutSizesInManifest', () => {
  it('merges sizes without disturbing kind/cells', () => {
    const base = manifest();
    base.projects![0].groups[0].layout = { kind: 'linear', cells: 3 };
    const next = setGroupLayoutSizesInManifest(base, {
      projectId: 'alpha',
      groupId: 'g1',
      sizes: { rows: [60, 40], cols: [[50, 50]] }
    });
    const layout = next.projects?.find((p) => p.id === 'alpha')?.groups.find((g) => g.id === 'g1')?.layout;
    expect(layout?.kind).toBe('linear');
    expect(layout?.cells).toBe(3);
    expect(layout?.sizes).toEqual({ rows: [60, 40], cols: [[50, 50]] });
  });
});
