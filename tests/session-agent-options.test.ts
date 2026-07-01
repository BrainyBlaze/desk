import { describe, expect, it } from 'vitest';
import { SESSION_AGENT_OPTIONS, supportsBypassPermissions } from '../src/web/sessionAgentOptions';

describe('session agent options', () => {
  it('includes every agent supported by the add-session modal', () => {
    expect(SESSION_AGENT_OPTIONS.map((option) => option.value)).toEqual(['codex', 'claude', 'opencode', 'bash']);
  });

  it('shows bypass permissions for agents Desk can launch in yolo mode', () => {
    expect(supportsBypassPermissions('codex')).toBe(true);
    expect(supportsBypassPermissions('claude')).toBe(true);
    expect(supportsBypassPermissions('opencode')).toBe(true);
    expect(supportsBypassPermissions('bash')).toBe(false);
  });
});
