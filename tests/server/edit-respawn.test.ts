import { describe, expect, it } from 'vitest';
import { shouldRespawnAfterEdit } from '../../src/server/editRespawn.js';
import type { SessionSpec } from '../../src/core/types.js';

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    groupId: 'val',
    groupLabel: 'Val',
    projectId: 'validation',
    name: 'g',
    cwd: '/tmp/ws',
    agent: 'opencode',
    tmuxSession: 'agentdesk-validation-val-g-0f4ac21b',
    command: 'cd /tmp/ws && exec desk agent-host',
    uiMode: 'native',
    ...overrides
  };
}

const running = () => true;
const stopped = () => false;

describe('shouldRespawnAfterEdit', () => {
  it('respawns a running session when only the model changed (same tmux name)', () => {
    expect(shouldRespawnAfterEdit(spec(), spec({ model: 'zai-coding-plan/glm-5.2' }), running)).toBe(true);
  });

  it('respawns a running session when the command changed under the same name', () => {
    expect(shouldRespawnAfterEdit(spec(), spec({ command: 'cd /tmp/ws && exec other' }), running)).toBe(true);
  });

  it('does not respawn when nothing launch-relevant changed', () => {
    expect(shouldRespawnAfterEdit(spec(), spec(), running)).toBe(false);
  });

  it('does not respawn a stopped session — the edit applies on next boot', () => {
    expect(shouldRespawnAfterEdit(spec(), spec({ model: 'zai-coding-plan/glm-5.2' }), stopped)).toBe(false);
  });

  it('does not respawn on identity change (tmux name differs — missing-session reconcile owns it)', () => {
    expect(
      shouldRespawnAfterEdit(
        spec(),
        spec({ tmuxSession: 'agentdesk-validation-val-g2-deadbeef', model: 'x/y' }),
        running
      )
    ).toBe(false);
  });

  it('does not respawn on uiMode change — the dedicated switch endpoint owns it', () => {
    expect(
      shouldRespawnAfterEdit(spec(), spec({ uiMode: 'terminal', command: 'cd /tmp/ws && exec claude' }), running)
    ).toBe(false);
  });

  it('does not respawn when either spec is missing', () => {
    expect(shouldRespawnAfterEdit(undefined, spec(), running)).toBe(false);
    expect(shouldRespawnAfterEdit(spec(), undefined, running)).toBe(false);
  });
});
