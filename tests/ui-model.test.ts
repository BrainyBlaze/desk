import { describe, expect, it } from 'vitest';
import { buildDeskViewModel } from '../src/ui/model';
import type { SessionSpec } from '../src/core/types';

const sessions: SessionSpec[] = [
  {
    groupId: 'group-1',
    groupLabel: 'Group 1',
    name: 'alpha',
    cwd: '/workspace/projects/alpha',
    agent: 'codex',
    resume: '00000000-0000-7000-8000-000000000001',
    tmuxSession: 'agentdesk-group-1-alpha-00000000',
    command:
      'codex --dangerously-bypass-approvals-and-sandbox resume 00000000-0000-7000-8000-000000000001'
  },
  {
    groupId: 'group-2',
    groupLabel: 'Group 2',
    name: 'beta',
    cwd: '/workspace/projects/beta',
    agent: 'codex',
    resume: '00000000-0000-7000-8000-000000000002',
    tmuxSession: 'agentdesk-group-2-beta-00000000',
    command:
      'codex --dangerously-bypass-approvals-and-sandbox resume 00000000-0000-7000-8000-000000000002'
  }
];

describe('desk view model', () => {
  it('groups sessions and derives running/missing counters', () => {
    const model = buildDeskViewModel(sessions, new Set(['agentdesk-group-1-alpha-00000000']));

    expect(model.totals).toEqual({
      projects: 2,
      groups: 2,
      sessions: 2,
      running: 1,
      missing: 1
    });
    expect(model.groups.map((group) => [group.groupId, group.running, group.missing])).toEqual([
      ['group-1', 1, 0],
      ['group-2', 0, 1]
    ]);
  });

  it('keeps configured empty groups visible', () => {
    const model = buildDeskViewModel([], new Set(), [{ id: 'empty', label: 'Empty Group' }]);

    expect(model.totals).toEqual({
      projects: 1,
      groups: 1,
      sessions: 0,
      running: 0,
      missing: 0
    });
    expect(model.groups).toEqual([
      {
        id: 'empty',
        groupId: 'empty',
        label: 'Empty Group',
        projectId: 'workspace',
        projectLabel: 'Workspace',
        projectCwd: '',
        running: 0,
        missing: 0,
        layout: { kind: '1x1', cellCount: 1 },
        sessions: []
      }
    ]);
  });

  it('keeps configured empty projects visible', () => {
    const model = buildDeskViewModel([], new Set(), [], [{ id: 'new-project', label: 'New Project', cwd: '~/projects/new' }]);

    expect(model.totals).toEqual({
      projects: 1,
      groups: 0,
      sessions: 0,
      running: 0,
      missing: 0
    });
    expect(model.projects).toEqual([
      {
        id: 'new-project',
        label: 'New Project',
        cwd: '~/projects/new',
        configured: true,
        running: 0,
        missing: 0,
        groups: []
      }
    ]);
  });

  it('combines configured project seeds with their group seeds', () => {
    const model = buildDeskViewModel(
      [],
      new Set(),
      [{ id: 'main', label: 'Main', projectId: 'new-project', projectLabel: 'New Project', projectCwd: '~/projects/new' }],
      [{ id: 'new-project', label: 'New Project', cwd: '~/projects/new' }]
    );

    expect(model.projects).toHaveLength(1);
    expect(model.projects[0]?.groups.map((group) => group.groupId)).toEqual(['main']);
  });

  it('builds a project hierarchy and preserves group layout metadata', () => {
    const model = buildDeskViewModel(
      [
        {
          ...sessions[0]!,
          projectId: 'alpha',
          projectLabel: 'Alpha',
          projectCwd: '/workspace/projects/alpha',
          groupLayout: { kind: '2x2' }
        },
        {
          ...sessions[1]!,
          projectId: 'beta',
          projectLabel: 'Beta',
          projectCwd: '/workspace/projects/beta'
        }
      ],
      new Set(['agentdesk-group-1-alpha-00000000'])
    );

    expect(model.totals.projects).toBe(2);
    expect(model.projects.map((project) => [project.id, project.cwd, project.groups.length])).toEqual([
      ['alpha', '/workspace/projects/alpha', 1],
      ['beta', '/workspace/projects/beta', 1]
    ]);
    expect(model.projects[0]!.groups[0]!.layout).toEqual({ kind: '2x2', cellCount: 4 });
  });
});
