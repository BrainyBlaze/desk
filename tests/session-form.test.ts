import { describe, expect, it } from 'vitest';
import { buildSessionPayload } from '../src/web/sessionFormPayload';

describe('session form payload', () => {
  it('keeps edited cwd for project-owned sessions', () => {
    expect(
      buildSessionPayload({
        projectId: 'alpha',
        groupId: 'main',
        name: 'agent',
        cwd: '/tmp/override',
        agent: 'codex',
        resume: '',
        bypassPermissions: true,
        command: ''
      })
    ).toEqual({
      name: 'agent',
      cwd: '/tmp/override',
      agent: 'codex',
      bypassPermissions: true
    });
  });

  it('keeps edited cwd with explicit commands', () => {
    expect(
      buildSessionPayload({
        projectId: 'alpha',
        groupId: 'main',
        name: 'agent',
        cwd: '/tmp/override',
        agent: 'bash',
        resume: '',
        bypassPermissions: false,
        command: 'bash'
      })
    ).toEqual({
      name: 'agent',
      cwd: '/tmp/override',
      command: 'bash'
    });
  });

  it('keeps bypassPermissions for OpenCode because Desk maps it to yolo config', () => {
    expect(
      buildSessionPayload({
        projectId: 'alpha',
        groupId: 'main',
        name: 'open',
        cwd: '/tmp/override',
        agent: 'opencode',
        resume: 'ses_12a31855dffeHTCs6tcfOmsddP',
        bypassPermissions: true,
        command: ''
      })
    ).toEqual({
      name: 'open',
      cwd: '/tmp/override',
      agent: 'opencode',
      resume: 'ses_12a31855dffeHTCs6tcfOmsddP',
      bypassPermissions: true
    });
  });
});
