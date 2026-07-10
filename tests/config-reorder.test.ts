import { describe, expect, it } from 'vitest';
import {
  editGroupInManifest,
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

  it('falls back to a legacy top-level group when the project id is synthetic', () => {
    const base: DeskManifest = {
      groups: [{ id: 'legacy', sessions: [{ name: 's1' }, { name: 's2' }] }]
    };
    const next = reorderSessionsInManifest(base, {
      projectId: 'cwd-project',
      groupId: 'legacy',
      projectCwd: '/legacy',
      orderedSessionNames: ['s2', 's1']
    });

    expect(next.groups[0]?.sessions.map((session) => session.name)).toEqual(['s2', 's1']);
    expect(next.groups[0]?.sessions.map((session) => session.order)).toEqual([0, 1]);
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

  it('updates a legacy top-level group without creating project data', () => {
    const base: DeskManifest = {
      groups: [{ id: 'legacy', layout: { kind: '2x2', cells: 4 }, sessions: [] }]
    };
    const next = setGroupLayoutSizesInManifest(base, {
      projectId: 'cwd-project',
      groupId: 'legacy',
      projectCwd: '/legacy',
      sizes: { rows: [40, 60] }
    });

    expect(next.groups[0]?.layout).toEqual({ kind: '2x2', cells: 4, sizes: { rows: [40, 60] } });
    expect(next.projects).toBeUndefined();
  });
});

describe('editGroupInManifest target parity', () => {
  it('renames a legacy top-level group when the project id is synthetic', () => {
    const base: DeskManifest = {
      groups: [{ id: 'legacy', label: 'Old', sessions: [] }]
    };
    const next = editGroupInManifest(base, {
      projectId: 'cwd-project',
      currentGroupId: 'legacy',
      groupId: 'renamed',
      groupLabel: 'New',
      projectCwd: '/legacy'
    });

    expect(next.groups[0]).toMatchObject({ id: 'renamed', label: 'New' });
    expect(next.projects).toBeUndefined();
  });
});
