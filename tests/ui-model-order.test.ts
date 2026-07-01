import { describe, expect, it } from 'vitest';
import { buildDeskViewModel } from '../src/ui/model';
import type { SessionSpec } from '../src/core/types';

function session(group: string, name: string, order?: number, groupOrder?: number, projectOrder?: number): SessionSpec {
  return {
    projectId: 'proj',
    projectLabel: 'proj',
    projectCwd: '/p',
    projectOrder,
    groupId: group,
    groupLabel: group,
    groupOrder,
    order,
    name,
    cwd: '/p',
    agent: 'bash',
    tmuxSession: `t-${group}-${name}`,
    command: 'bash'
  };
}

describe('view model layout: linear', () => {
  it('normalizes a linear layout to its explicit cell count', () => {
    const model = buildDeskViewModel([], new Set(), [
      { id: 'row', projectId: 'proj', projectLabel: 'proj', projectCwd: '/p', layout: { kind: 'linear', cells: 3 } }
    ]);
    const group = model.groups.find((g) => g.groupId === 'row');
    expect(group?.layout).toMatchObject({ kind: 'linear', cellCount: 3 });
  });

  it('passes persisted sizes through to the view', () => {
    const model = buildDeskViewModel([], new Set(), [
      { id: 'row', projectId: 'proj', projectLabel: 'proj', projectCwd: '/p', layout: { kind: '2x2', sizes: { rows: [60, 40] } } }
    ]);
    expect(model.groups[0]?.layout.sizes).toEqual({ rows: [60, 40] });
  });
});

describe('view model order', () => {
  it('sorts sessions by explicit order', () => {
    const model = buildDeskViewModel(
      [session('g', 'a', 2), session('g', 'b', 0), session('g', 'c', 1)],
      new Set()
    );
    const names = model.projects[0].groups[0].sessions.map((s) => s.spec.name);
    expect(names).toEqual(['b', 'c', 'a']);
  });

  it('falls back to manifest order when no order is set', () => {
    const model = buildDeskViewModel([session('g', 'a'), session('g', 'b'), session('g', 'c')], new Set());
    expect(model.projects[0].groups[0].sessions.map((s) => s.spec.name)).toEqual(['a', 'b', 'c']);
  });

  it('sorts groups within a project by order', () => {
    const model = buildDeskViewModel(
      [session('g1', 'x', undefined, 1), session('g2', 'y', undefined, 0)],
      new Set()
    );
    expect(model.projects[0].groups.map((g) => g.groupId)).toEqual(['g2', 'g1']);
  });
});
