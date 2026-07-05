import { describe, expect, it } from 'vitest';
import type { DeskManifest, SessionSpec } from '../src/core/types';
import { buildSessionSpecs } from '../src/core/manifest';
import { createInFlightGuard, performUiModeSwitch, validateUiModeSwitch } from '../src/server/uiModeSwitch';
import { homedir } from 'node:os';

// Samples use ~ expansion against the real home — never hardcode it (CI runs as /home/runner).
const HOME = homedir();

function manifest(): DeskManifest {
  return {
    groups: [],
    projects: [
      {
        id: 'alpha',
        cwd: '~/projects/alpha',
        groups: [
          {
            id: 'main',
            sessions: [
              {
                name: 'chat',
                agent: 'claude',
                resume: '00000000-0000-7000-8000-000000000001',
                tmuxSession: 'agentdesk-alpha-main-chat-00000000'
              },
              { name: 'fresh', agent: 'codex' },
              { name: 'shell', agent: 'bash' },
              { name: 'custom', command: 'htop' },
              {
                name: 'native-chat',
                agent: 'opencode',
                resume: 'ses_12a31855dffeHTCs6tcfOmsddP',
                uiMode: 'native',
                tmuxSession: 'agentdesk-alpha-main-native-chat-pinned01'
              }
            ]
          }
        ]
      }
    ]
  };
}

function specFor(name: string): SessionSpec {
  const spec = buildSessionSpecs(manifest(), { homeDir: HOME }).find((candidate) => candidate.name === name);
  if (!spec) {
    throw new Error(`no spec for ${name}`);
  }
  return spec;
}

describe('validateUiModeSwitch', () => {
  it('rejects unknown tmux sessions with 404', () => {
    const result = validateUiModeSwitch(manifest(), {
      tmuxSession: 'agentdesk-alpha-main-ghost-00000000',
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: false, status: 404, code: 'unknown-session' });
  });

  it('rejects native mode for bash sessions with a typed 400', () => {
    const result = validateUiModeSwitch(manifest(), {
      tmuxSession: specFor('shell').tmuxSession,
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ui-mode-unsupported' });
  });

  it('rejects native mode for custom-command sessions with a typed 400', () => {
    const result = validateUiModeSwitch(manifest(), {
      tmuxSession: specFor('custom').tmuxSession,
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ui-mode-unsupported' });
  });

  it('gates switching a session with no captured resume id behind confirmDiscard', () => {
    const blocked = validateUiModeSwitch(manifest(), {
      tmuxSession: specFor('fresh').tmuxSession,
      uiMode: 'native',
      homeDir: HOME
    });
    expect(blocked).toMatchObject({ ok: false, status: 409, code: 'resume-not-captured' });

    const confirmed = validateUiModeSwitch(manifest(), {
      tmuxSession: specFor('fresh').tmuxSession,
      uiMode: 'native',
      confirmDiscard: true,
      homeDir: HOME
    });
    expect(confirmed).toMatchObject({ ok: true, noop: false });
  });

  it('accepts a resume-captured switch and pins identity while preserving fields', () => {
    const result = validateUiModeSwitch(manifest(), {
      tmuxSession: 'agentdesk-alpha-main-chat-00000000',
      uiMode: 'native',
      homeDir: HOME
    });
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.code}`);
    }
    expect(result.noop).toBe(false);
    expect(result.edit.session).toMatchObject({
      name: 'chat',
      agent: 'claude',
      resume: '00000000-0000-7000-8000-000000000001',
      uiMode: 'native',
      tmuxSession: 'agentdesk-alpha-main-chat-00000000'
    });
  });

  it('switches native back to terminal by removing the manifest field', () => {
    const result = validateUiModeSwitch(manifest(), {
      tmuxSession: 'agentdesk-alpha-main-native-chat-pinned01',
      uiMode: 'terminal',
      homeDir: HOME
    });
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.code}`);
    }
    expect(result.edit.session.uiMode).toBeUndefined();
    expect(result.edit.session.tmuxSession).toBe('agentdesk-alpha-main-native-chat-pinned01');
  });

  it('treats a same-mode switch as a noop', () => {
    const result = validateUiModeSwitch(manifest(), {
      tmuxSession: 'agentdesk-alpha-main-native-chat-pinned01',
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: true, noop: true });
  });
});

describe('createInFlightGuard', () => {
  it('admits one switch per session until released', () => {
    const guard = createInFlightGuard();
    expect(guard.begin('s1')).toBe(true);
    expect(guard.begin('s1')).toBe(false);
    expect(guard.begin('s2')).toBe(true);
    guard.end('s1');
    expect(guard.begin('s1')).toBe(true);
  });
});

describe('performUiModeSwitch', () => {
  it('writes the manifest before restarting, restarts exactly once, and keeps the pinned name', async () => {
    const calls: string[] = [];
    let written: DeskManifest | undefined;
    let restarted: SessionSpec | undefined;

    const validated = validateUiModeSwitch(manifest(), {
      tmuxSession: 'agentdesk-alpha-main-chat-00000000',
      uiMode: 'native',
      homeDir: HOME
    });
    if (!validated.ok || validated.noop) {
      throw new Error('expected an actionable switch');
    }

    const result = await performUiModeSwitch(
      { manifest: manifest(), validated, homeDir: HOME },
      {
        write: (next) => {
          calls.push('write');
          written = next;
        },
        restart: (spec) => {
          calls.push('restart');
          restarted = spec;
          return { ok: true };
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['write', 'restart']);
    expect(restarted?.tmuxSession).toBe('agentdesk-alpha-main-chat-00000000');
    expect(restarted?.uiMode).toBe('native');
    const persisted = written?.projects?.[0].groups[0].sessions.find((session) => session.name === 'chat');
    expect(persisted?.uiMode).toBe('native');
    expect(persisted?.tmuxSession).toBe('agentdesk-alpha-main-chat-00000000');
  });

  it('propagates restart failures as a typed 500 without retrying', async () => {
    let restartCalls = 0;
    const validated = validateUiModeSwitch(manifest(), {
      tmuxSession: 'agentdesk-alpha-main-chat-00000000',
      uiMode: 'native',
      homeDir: HOME
    });
    if (!validated.ok || validated.noop) {
      throw new Error('expected an actionable switch');
    }

    const result = await performUiModeSwitch(
      { manifest: manifest(), validated, homeDir: HOME },
      {
        write: () => undefined,
        restart: () => {
          restartCalls += 1;
          return { ok: false, error: 'tmux exploded' };
        }
      }
    );

    expect(restartCalls).toBe(1);
    expect(result).toMatchObject({ ok: false, status: 500, error: 'tmux exploded' });
  });
});
