import { readFileSync } from 'node:fs';
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
        initialResume: '',
        bypassPermissions: true,
        command: '',
        uiMode: 'terminal'
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
        initialResume: '',
        bypassPermissions: false,
        command: 'bash',
        uiMode: 'terminal'
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
        initialResume: '',
        bypassPermissions: true,
        command: '',
        uiMode: 'terminal'
      })
    ).toEqual({
      name: 'open',
      cwd: '/tmp/override',
      agent: 'opencode',
      resume: 'ses_12a31855dffeHTCs6tcfOmsddP',
      bypassPermissions: true
    });
  });

  it('carries native uiMode for SDK-backed agents', () => {
    expect(
      buildSessionPayload({
        projectId: 'alpha',
        groupId: 'main',
        name: 'chat',
        cwd: '/tmp/override',
        agent: 'claude',
        resume: '',
        initialResume: '',
        bypassPermissions: false,
        command: '',
        uiMode: 'native'
      })
    ).toEqual({
      name: 'chat',
      cwd: '/tmp/override',
      agent: 'claude',
      bypassPermissions: false,
      uiMode: 'native'
    });
  });

  it('omits uiMode when terminal is selected so manifests stay lean', () => {
    const payload = buildSessionPayload({
      projectId: 'alpha',
      groupId: 'main',
      name: 'agent',
      cwd: '/tmp/override',
      agent: 'claude',
      resume: '',
        initialResume: '',
      bypassPermissions: false,
      command: '',
      uiMode: 'terminal'
    });
    expect('uiMode' in payload ? payload.uiMode : undefined).toBeUndefined();
  });

  it('drops native uiMode when an explicit command is present', () => {
    expect(
      buildSessionPayload({
        projectId: 'alpha',
        groupId: 'main',
        name: 'custom',
        cwd: '/tmp/override',
        agent: 'claude',
        resume: '',
        initialResume: '',
        bypassPermissions: false,
        command: 'htop',
        uiMode: 'native'
      })
    ).toEqual({
      name: 'custom',
      cwd: '/tmp/override',
      command: 'htop'
    });
  });

  it('marks a deliberate resume clear only when the field held a value at load', () => {
    const cleared = buildSessionPayload({
      projectId: 'alpha',
      groupId: 'main',
      name: 'agent',
      cwd: '/tmp/override',
      agent: 'claude',
      resume: '',
      initialResume: 'sess-uuid-1',
      bypassPermissions: false,
      command: '',
      uiMode: 'terminal'
    });
    expect(cleared.clearResume).toBe(true);

    const staleEmpty = buildSessionPayload({
      projectId: 'alpha',
      groupId: 'main',
      name: 'agent',
      cwd: '/tmp/override',
      agent: 'claude',
      resume: '',
      initialResume: '',
      bypassPermissions: false,
      command: '',
      uiMode: 'terminal'
    });
    expect(staleEmpty.clearResume).toBeUndefined();
    expect(staleEmpty.resume).toBeUndefined();
  });

  it('drops native uiMode for agents without SDK support', () => {
    const payload = buildSessionPayload({
      projectId: 'alpha',
      groupId: 'main',
      name: 'shell',
      cwd: '/tmp/override',
      agent: 'bash',
      resume: '',
        initialResume: '',
      bypassPermissions: false,
      command: '',
      uiMode: 'native'
    });
    expect('uiMode' in payload ? payload.uiMode : undefined).toBeUndefined();
  });
});

describe('session form modal source contract', () => {
  const source = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');

  it('renders a UI mode selector gated by supportsNativeUi', () => {
    expect(source).toContain('supportsNativeUi(');
    expect(source).toContain('UI mode');
  });

  it('tracks uiMode in the session form state with a terminal default', () => {
    expect(source).toMatch(/uiMode: DeskSessionUiMode/);
    expect(source).toMatch(/uiMode: 'terminal'/);
  });

  it('prefills the edit command field only for custom-command sessions', () => {
    expect(source).toMatch(/command: session\.spec\.customCommand \? session\.spec\.command : ''/);
  });

  it('routes edit-modal ui-mode changes through the atomic switch endpoint', () => {
    const apiSource = readFileSync(new URL('../src/web/api.ts', import.meta.url), 'utf8');
    expect(apiSource).toContain('/api/set-session-ui-mode');
    expect(apiSource).toMatch(/export async function setSessionUiMode/);
    expect(source).toContain("'switchUiMode'");
    expect(source).toContain('setSessionUiMode(');
    expect(source).toContain('resume-not-captured');
    expect(source).toMatch(/confirmDiscard/);
  });
});
