import { describe, expect, it } from 'vitest';
import { SESSION_AGENT_OPTIONS, supportsBypassPermissions, supportsNativeUi } from '../src/web/sessionAgentOptions';

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

  it('offers native UI mode only for SDK-backed agents without a custom command', () => {
    expect(supportsNativeUi('codex', false)).toBe(true);
    expect(supportsNativeUi('claude', false)).toBe(true);
    expect(supportsNativeUi('opencode', false)).toBe(true);
    expect(supportsNativeUi('bash', false)).toBe(false);
    expect(supportsNativeUi('', false)).toBe(false);
  });

  it('forces terminal mode for custom-command sessions regardless of agent', () => {
    expect(supportsNativeUi('codex', true)).toBe(false);
    expect(supportsNativeUi('claude', true)).toBe(false);
    expect(supportsNativeUi('opencode', true)).toBe(false);
    expect(supportsNativeUi('bash', true)).toBe(false);
  });
});
