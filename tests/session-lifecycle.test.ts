import { describe, expect, it } from 'vitest';
import type { DeskManifest } from '../src/core/types';
import { moveSessionInManifest } from '../src/core/config';
import {
  collectMoveSourceSessions,
  collectGroupDeleteSessions,
  collectProjectDeleteSessions,
  collectSessionDeleteTargets,
  findSessionForStart,
  validateSessionCwd
} from '../src/server/vitePlugin';
import { homedir } from 'node:os';

// Samples use ~ expansion against the real home — never hardcode it (CI runs as /home/runner).
const HOME = homedir();

const manifest: DeskManifest = {
  groups: [
    {
      id: 'legacy',
      sessions: [
        { name: 'keep', cwd: '~/projects/keep', command: 'bash' },
        { name: 'drop', cwd: '~/projects/drop', command: 'bash' }
      ]
    }
  ],
  projects: [
    {
      id: 'drop-project',
      cwd: '~/projects/drop',
      groups: [
        {
          id: 'main',
          sessions: [
            { name: 'bash', agent: 'bash' },
            { name: 'agent', agent: 'codex', resume: 'abc' }
          ]
        },
        {
          id: 'target',
          sessions: []
        }
      ]
    },
    {
      id: 'keep-project',
      cwd: '~/projects/keep',
      groups: [{ id: 'main', sessions: [{ name: 'bash', agent: 'bash' }] }]
    }
  ]
};

describe('server session lifecycle helpers', () => {
  it('finds newly added project sessions before config is written', () => {
    const session = findSessionForStart(manifest, {
      groupId: 'main',
      sessionName: 'bash',
      projectId: 'drop-project',
      homeDir: `${HOME}`
    });

    expect(session?.tmuxSession).toMatch(/^agentdesk-drop-project-main-bash-[a-f0-9]{8}$/);
    expect(session?.command).toBe(`cd '${HOME}/projects/drop' && exec bash`);
  });

  it('rejects missing launch directories before writing stale config entries', () => {
    const session = findSessionForStart(manifest, {
      groupId: 'main',
      sessionName: 'bash',
      projectId: 'drop-project',
      homeDir: `${HOME}`
    });

    expect(validateSessionCwd(session!, () => undefined)).toEqual({
      ok: false,
      error: `cwd does not exist for bash: ${HOME}/projects/drop`
    });
  });

  it('collects every tmux session removed by project deletion', () => {
    expect(
      collectProjectDeleteSessions(manifest, {
        projectId: 'drop-project',
        cwd: `${HOME}/projects/drop`,
        homeDir: `${HOME}`
      }).map((session) => session.name)
    ).toEqual(['drop', 'bash', 'agent']);
  });

  it('collects every tmux session removed by group and session deletion', () => {
    expect(
      collectGroupDeleteSessions(manifest, {
        projectId: 'drop-project',
        groupId: 'main',
        projectCwd: `${HOME}/projects/drop`,
        homeDir: `${HOME}`
      }).map((session) => session.name)
    ).toEqual(['bash', 'agent']);

    expect(
      collectSessionDeleteTargets(manifest, {
        projectId: 'drop-project',
        groupId: 'main',
        sessionName: 'bash',
        projectCwd: `${HOME}/projects/drop`,
        homeDir: `${HOME}`
      }).map((session) => session.name)
    ).toEqual(['bash']);
  });

  it('preserves actual cwd and tmux identity when moving across projects', () => {
    const moveOptions = {
      sourceProjectId: 'keep-project',
      sourceGroupId: 'main',
      sourceSessionName: 'bash',
      targetProjectId: 'drop-project',
      targetGroupId: 'target'
    };

    const [source] = collectMoveSourceSessions(manifest, { ...moveOptions, homeDir: `${HOME}` });

    expect(source?.cwd).toBe(`${HOME}/projects/keep`);

    const updated = moveSessionInManifest(manifest, moveOptions);
    const moved = findSessionForStart(updated, {
      projectId: 'drop-project',
      groupId: 'target',
      sessionName: 'bash',
      homeDir: `${HOME}`
    });

    expect(moved.cwd).toBe(`${HOME}/projects/keep`);
    expect(moved.command).toBe(`cd '${HOME}/projects/keep' && exec bash`);
    expect(moved.tmuxSession).toBe(source?.tmuxSession);
  });
});
