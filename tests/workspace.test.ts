import { describe, expect, it } from 'vitest';
import { buildWorkspaceState } from '../src/ui/workspace';
import type { DeskViewModel } from '../src/ui/model';

const view: DeskViewModel = {
  totals: { projects: 1, groups: 2, sessions: 3, running: 1, missing: 2 },
  groups: [
    {
      id: 'alpha',
      label: 'Alpha',
      projectId: 'project-a',
      projectLabel: 'Project A',
      projectCwd: '/tmp',
      layout: { kind: '2x2', cellCount: 4 },
      running: 1,
      missing: 1,
      sessions: [
        {
          state: 'running',
          spec: {
            groupId: 'alpha',
            groupLabel: 'Alpha',
            name: 'a1',
            cwd: '/tmp/a1',
            agent: 'codex',
            resume: '00000000-0000-7000-8000-000000000001',
            tmuxSession: 'agentdesk-alpha-a1-00000000',
            command: 'codex resume 00000000-0000-7000-8000-000000000001'
          }
        },
        {
          state: 'missing',
          spec: {
            groupId: 'alpha',
            groupLabel: 'Alpha',
            name: 'a2',
            cwd: '/tmp/a2',
            agent: 'codex',
            resume: '00000000-0000-7000-8000-000000000002',
            tmuxSession: 'agentdesk-alpha-a2-00000000',
            command: 'codex resume 00000000-0000-7000-8000-000000000002'
          }
        }
      ]
    },
    {
      id: 'beta',
      label: 'Beta',
      projectId: 'project-a',
      projectLabel: 'Project A',
      projectCwd: '/tmp',
      layout: { kind: '1x1', cellCount: 1 },
      running: 0,
      missing: 1,
      sessions: [
        {
          state: 'missing',
          spec: {
            groupId: 'beta',
            groupLabel: 'Beta',
            name: 'b1',
            cwd: '/tmp/b1',
            agent: 'codex',
            resume: '00000000-0000-7000-8000-000000000003',
            tmuxSession: 'agentdesk-beta-b1-00000000',
            command: 'codex resume 00000000-0000-7000-8000-000000000003'
          }
        }
      ]
    }
  ],
  projects: [
    {
      id: 'project-a',
      label: 'Project A',
      cwd: '/tmp',
      running: 1,
      missing: 2,
      groups: []
    }
  ]
};

describe('workspace state', () => {
  it('selects group tabs and session tabs from the view model', () => {
    const state = buildWorkspaceState(view, {
      groupId: 'beta',
      tmuxSession: undefined
    });

    expect(state.activeGroup.id).toBe('beta');
    expect(state.activeSession?.spec.name).toBe('b1');
    expect(state.sessionTabs.map((session) => session.spec.name)).toEqual(['b1']);
    expect(state.multiplexerCells.map((cell) => cell.sessions.map((session) => session.spec.name))).toEqual([['b1']]);
  });

  it('falls back to the first available group and session', () => {
    const state = buildWorkspaceState(view, {});

    expect(state.activeGroup.id).toBe('alpha');
    expect(state.activeSession?.spec.name).toBe('a1');
    expect(state.sessionTabs.map((session) => session.spec.name)).toEqual(['a1', 'a2']);
    expect(state.multiplexerCells).toHaveLength(4);
    expect(state.multiplexerCells[0]!.sessions.map((session) => session.spec.name)).toEqual(['a1']);
    expect(state.multiplexerCells[1]!.sessions.map((session) => session.spec.name)).toEqual(['a2']);
  });
});
