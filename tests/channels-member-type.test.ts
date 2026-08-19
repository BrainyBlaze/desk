import { describe, expect, it } from 'vitest';
import { memberTypeForAgent } from '../src/server/channels/api.js';
import { AGENT_IDS } from '../src/shared/agentRegistry.js';

describe('channel member type for an agent', () => {
  it('gives every managed agent its own first-class kind', () => {
    expect(memberTypeForAgent('claude')).toBe('claude-code');
    expect(memberTypeForAgent('codex')).toBe('codex-cli');
    expect(memberTypeForAgent('opencode')).toBe('opencode');
    expect(memberTypeForAgent('qwen')).toBe('qwen');
    expect(memberTypeForAgent('kimi')).toBe('kimi');
    expect(memberTypeForAgent('grok')).toBe('grok');
  });

  it('falls back to bash for shell and command sessions', () => {
    expect(memberTypeForAgent('bash')).toBe('bash');
    expect(memberTypeForAgent(undefined)).toBe('bash');
    expect(memberTypeForAgent('')).toBe('bash');
  });

  it('never labels one of the new terminal agents as bash', () => {
    for (const agent of ['opencode', 'qwen', 'kimi', 'grok'] as const) {
      expect(AGENT_IDS).toContain(agent);
      expect(memberTypeForAgent(agent), `${agent} member type`).not.toBe('bash');
    }
  });
});
