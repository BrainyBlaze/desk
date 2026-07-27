import { describe, expect, it } from 'vitest';
import { sessionStateSubjectFor } from '../src/shared/controlPlane/index.js';

describe('sessionStateSubjectFor', () => {
  it.each([
    [{ uiMode: 'terminal' }, { kind: 'terminal' }],
    [{ agent: 'bash', uiMode: 'terminal' }, { kind: 'terminal' }],
    [{ agent: 'future-agent', uiMode: 'native' }, { kind: 'terminal' }],
    [{ agent: 'codex', uiMode: 'terminal', customCommand: true }, { kind: 'terminal' }]
  ] as const)('keeps non-canonical agent sessions terminal: %o', (input, expected) => {
    expect(sessionStateSubjectFor(input)).toEqual(expected);
  });

  it.each([
    ['codex', 'terminal', 'codex-hooks'],
    ['codex', 'native', 'codex-native'],
    ['claude', 'terminal', 'claude-hooks'],
    ['claude', 'native', 'claude-native'],
    ['opencode', 'terminal', 'opencode-terminal'],
    ['opencode', 'native', 'opencode-native']
  ] as const)('binds %s/%s to exactly %s', (provider, mode, producer) => {
    expect(sessionStateSubjectFor({ agent: provider, uiMode: mode })).toEqual({
      kind: 'agent',
      provider,
      mode,
      producer
    });
  });
});
