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
    ['opencode', 'native', 'opencode-native'],
    ['qwen', 'terminal', 'qwen-hooks'],
    ['kimi', 'terminal', 'kimi-hooks'],
    ['grok', 'terminal', 'grok-hooks']
  ] as const)('binds %s/%s to exactly %s', (provider, mode, producer) => {
    expect(sessionStateSubjectFor({ agent: provider, uiMode: mode })).toEqual({
      kind: 'agent',
      provider,
      mode,
      producer
    });
  });

  // A producer-less native request must degrade to the provider's terminal
  // producer, not to a bare terminal subject — dropping the fallback would
  // silently detach these agents' state reporting.
  it.each([
    ['qwen', 'qwen-hooks'],
    ['kimi', 'kimi-hooks'],
    ['grok', 'grok-hooks']
  ] as const)('degrades %s native requests to its terminal producer', (provider, producer) => {
    expect(sessionStateSubjectFor({ agent: provider, uiMode: 'native' })).toEqual({
      kind: 'agent',
      provider,
      mode: 'terminal',
      producer
    });
  });
});
