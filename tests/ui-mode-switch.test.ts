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
                sessionId: 'chat',
                agent: 'claude',
                resume: '00000000-0000-7000-8000-000000000001',
                uiMode: 'terminal'
              },
              { name: 'fresh', sessionId: 'fresh', agent: 'codex', uiMode: 'terminal' },
              { name: 'shell', sessionId: 'shell', agent: 'bash' },
              { name: 'custom', sessionId: 'custom', command: 'htop' },
              {
                name: 'native-chat',
                sessionId: 'native-chat',
                agent: 'opencode',
                resume: 'ses_12a31855dffeHTCs6tcfOmsddP',
                uiMode: 'native'
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
  it('rejects unknown sessions with 404', () => {
    const result = validateUiModeSwitch(manifest(), {
      sessionId: 'ghost',
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: false, status: 404, code: 'unknown-session' });
  });

  it('rejects native mode for bash sessions with a typed 400', () => {
    const result = validateUiModeSwitch(manifest(), {
      sessionId: specFor('shell').sessionId,
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ui-mode-unsupported' });
  });

  it('rejects native mode for custom-command sessions with a typed 400', () => {
    const result = validateUiModeSwitch(manifest(), {
      sessionId: specFor('custom').sessionId,
      uiMode: 'native',
      homeDir: HOME
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'ui-mode-unsupported' });
  });

  it('gates switching a session with no captured resume id behind confirmDiscard', () => {
    const blocked = validateUiModeSwitch(manifest(), {
      sessionId: specFor('fresh').sessionId,
      uiMode: 'native',
      homeDir: HOME
    });
    expect(blocked).toMatchObject({ ok: false, status: 409, code: 'resume-not-captured' });

    const confirmed = validateUiModeSwitch(manifest(), {
      sessionId: specFor('fresh').sessionId,
      uiMode: 'native',
      confirmDiscard: true,
      homeDir: HOME
    });
    expect(confirmed).toMatchObject({ ok: true, noop: false });
  });

  it('accepts a resume-captured switch and pins identity while preserving fields', () => {
    const result = validateUiModeSwitch(manifest(), {
      sessionId: 'chat',
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
      sessionId: 'chat'
    });
  });

  it('switches native back to terminal by pinning the field so the native default cannot resurrect it', () => {
    const result = validateUiModeSwitch(manifest(), {
      sessionId: 'native-chat',
      uiMode: 'terminal',
      homeDir: HOME
    });
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.code}`);
    }
    expect(result.edit.session.uiMode).toBe('terminal');
    expect(result.edit.session.sessionId).toBe('native-chat');
  });

  it('treats a same-mode switch as a noop', () => {
    const result = validateUiModeSwitch(manifest(), {
      sessionId: 'native-chat',
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
  it('writes the manifest before restarting, restarts exactly once, and keeps durable identity', async () => {
    const calls: string[] = [];
    let written: DeskManifest | undefined;
    let restarted: SessionSpec | undefined;

    const validated = validateUiModeSwitch(manifest(), {
      sessionId: 'chat',
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
    expect(restarted?.sessionId).toBe('chat');
    expect(restarted?.uiMode).toBe('native');
    const persisted = written?.projects?.[0].groups[0].sessions.find((session) => session.name === 'chat');
    expect(persisted?.uiMode).toBe('native');
    // durable identity preserved; the legacy name key is never written back
    expect(persisted?.sessionId).toBe('chat');
    expect(persisted).not.toHaveProperty('tmuxSession');
  });

  it('propagates restart failures as a typed 500 without retrying', async () => {
    let restartCalls = 0;
    const validated = validateUiModeSwitch(manifest(), {
      sessionId: 'chat',
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

  it('awaits an async (native daemon) restart before reporting success', async () => {
    const order: string[] = [];
    const validated = validateUiModeSwitch(manifest(), {
      sessionId: 'chat',
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
        restart: async () => {
          order.push('restart-start');
          await Promise.resolve();
          order.push('restart-resolved');
          return { ok: true };
        },
        scheduleCapture: () => order.push('capture')
      }
    );

    expect(result.ok).toBe(true);
    // capture runs only after the async restart fully resolved
    expect(order).toEqual(['restart-start', 'restart-resolved', 'capture']);
  });

  it('propagates an async restart failure as a typed 500', async () => {
    const validated = validateUiModeSwitch(manifest(), {
      sessionId: 'chat',
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
        restart: () => Promise.resolve({ ok: false, error: 'daemon unreachable' })
      }
    );
    expect(result).toMatchObject({ ok: false, status: 500, error: 'daemon unreachable' });
  });
});
