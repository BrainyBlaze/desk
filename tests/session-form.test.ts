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
      bypassPermissions: true,
      uiMode: 'terminal'
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
      agent: 'bash',
      command: 'bash'
    });
  });

  it('keeps visible agent and resume edits with an explicit command', () => {
    expect(
      buildSessionPayload({
        projectId: 'alpha',
        groupId: 'main',
        name: 'custom-agent',
        cwd: '/tmp/override',
        agent: 'claude',
        resume: 'sess-edited',
        initialResume: 'sess-original',
        bypassPermissions: true,
        command: 'claude-wrapper',
        uiMode: 'terminal'
      })
    ).toEqual({
      name: 'custom-agent',
      cwd: '/tmp/override',
      agent: 'claude',
      resume: 'sess-edited',
      bypassPermissions: true,
      command: 'claude-wrapper'
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
      bypassPermissions: true,
      uiMode: 'terminal'
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

  it('emits an explicit terminal uiMode so the choice survives the native default', () => {
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
    expect(payload.uiMode).toBe('terminal');
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
      agent: 'claude',
      bypassPermissions: false,
      command: 'htop'
    });
  });

  it('passes a model only when one is set', () => {
    const base = {
      projectId: 'alpha', groupId: 'main', name: 'chat', cwd: '/tmp/x', agent: 'opencode',
      resume: '', initialResume: '', bypassPermissions: false, command: '', uiMode: 'native' as const
    };
    expect(buildSessionPayload({ ...base, model: 'zai-coding-plan/glm-5.2' }).model).toBe('zai-coding-plan/glm-5.2');
    expect('model' in buildSessionPayload({ ...base, model: '' })).toBe(false);
  });

  it('carries a selected profile for a managed Claude or Codex launch', () => {
    const payload = buildSessionPayload({
      projectId: 'alpha',
      groupId: 'main',
      name: 'profiled',
      cwd: '/tmp/profiled',
      agent: 'claude',
      profileId: 'work-claude',
      resume: '',
      initialResume: '',
      bypassPermissions: false,
      command: '',
      uiMode: 'native'
    });
    expect(payload.profileId).toBe('work-claude');
  });

  it('omits profile selection for ambient and custom-command launches', () => {
    const base = {
      projectId: 'alpha',
      groupId: 'main',
      name: 'agent',
      cwd: '/tmp/profiled',
      agent: 'codex',
      resume: '',
      initialResume: '',
      bypassPermissions: false,
      uiMode: 'terminal' as const
    };
    expect('profileId' in buildSessionPayload({ ...base, profileId: '', command: '' })).toBe(false);
    expect('profileId' in buildSessionPayload({ ...base, profileId: 'work-codex', command: 'codex-wrapper' })).toBe(false);
  });

  it('never turns an emptied resume field into an unaudited reset request', () => {
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
    expect('clearResume' in cleared).toBe(false);
    expect(cleared.resume).toBeUndefined();

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
    expect('clearResume' in staleEmpty).toBe(false);
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

  // Terminal is the mode that works for every agent Desk drives, so it is what
  // a new session starts as. Native is richer but narrower, and defaulting to
  // it made the operator's first session the least predictable one.
  it('defaults a new session to TERMINAL ui mode', () => {
    expect(source).toMatch(/uiMode: DeskSessionUiMode/);
    expect(source).toMatch(/uiMode: 'terminal',\n {2}model: ''/);
  });

  it('marks native as experimental where the mode is CHOSEN, not in a tooltip', () => {
    expect(source).toMatch(/value: 'native', label: 'native \(experimental\)'/);
  });

  // "Store" named the manifest write. The operator is creating or saving.
  it('labels the submit by what the operator is doing', () => {
    expect(source).toContain("mode === 'edit' ? 'Save session' : 'Create session'");
    expect(source).not.toContain('Store session');
  });

  // Creating a profile from inside the wizard is a DETOUR: openAddSession
  // resets the form, so a plain jump to Settings would discard what was typed.
  it('returns to the session form after the create-profile detour', () => {
    expect(source).toContain('onCreateProfile');
    expect(source).toMatch(/setModalReturn\('addSession'\)/);
    expect(source).toMatch(/setModalReturn\('editSession'\)/);
    expect(source).toMatch(/const back = modalReturn;/);
  });

  it('prefills the edit command field only for custom-command sessions', () => {
    expect(source).toMatch(/command: session\.spec\.customCommand \? session\.spec\.command : ''/);
  });

  it('brands the ui-mode switch confirm as a switch, not a delete', () => {
    expect(source).toContain("'Switch UI mode'");
    expect(source).toMatch(/confirmLabel\?: string/);
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

  it('does not replay the preliminary edit after the resume-discard switch gate', () => {
    expect(source).toMatch(/if \(!uiModeSwitchDiscard\) \{\n\s+editedSnapshot = await editProjectSession/);
    expect(source).toContain('setSnapshot(editedSnapshot)');
  });

  it('renders profile selection in both add and edit session modals', () => {
    const sessionForms = source.match(/<SessionFormView[\s\S]*?\/>/g) ?? [];
    expect(source).toContain('profileId: string');
    expect(source).toMatch(/profileId: session\.spec\.profileId \?\? ''/);
    expect(sessionForms).toHaveLength(2);
    expect(sessionForms.every((form) => form.includes('profiles={agentProfiles}'))).toBe(true);
    expect(source).toContain('<span>Profile</span>');
    expect(source).toContain("value: '', label: 'Ambient account'");
  });
});
