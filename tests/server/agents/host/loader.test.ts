import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostEnv } from '../../../../src/server/agents/host/runner.js';

const mocks = vi.hoisted(() => {
  const fakeDriver = {
    onEvent: vi.fn(),
    start: vi.fn(),
    inject: vi.fn(),
    respondPermission: vi.fn(),
    interrupt: vi.fn(),
    fetchHistory: vi.fn(),
    shutdown: vi.fn()
  };
  return {
    fakeDriver,
    createClaudeDriver: vi.fn(() => fakeDriver),
    createCodexDriver: vi.fn(() => fakeDriver),
    OpencodeDriver: vi.fn(() => fakeDriver)
  };
});

vi.mock('../../../../src/server/agents/drivers/claudeDriver.js', () => ({
  createClaudeDriver: mocks.createClaudeDriver
}));

vi.mock('../../../../src/server/agents/drivers/codexDriver.js', () => ({
  createCodexDriver: mocks.createCodexDriver
}));

vi.mock('../../../../src/server/agents/drivers/opencodeDriver.js', () => ({
  OpencodeDriver: mocks.OpencodeDriver
}));

import { loadDriver } from '../../../../src/server/agents/host/loader.js';

function env(overrides: Partial<AgentHostEnv> = {}): AgentHostEnv {
  return {
    DESK_TMUX_SESSION: 'sess-test',
    DESK_AGENT: 'codex',
    DESK_AGENT_BYPASS: '0',
    DESK_SERVER_URL: 'http://127.0.0.1:5173',
    DESK_AGENT_HOST_TOKEN: 'token-test',
    DESK_AGENT_CWD: '/repo',
    ...overrides
  };
}

describe('loadDriver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the bypass permission flag into the Codex native driver', () => {
    const driver = loadDriver(
      env({
        DESK_AGENT: 'codex',
        DESK_AGENT_BYPASS: '1',
        DESK_AGENT_RESUME: 'thread-1',
        DESK_AGENT_MODEL: 'gpt-5.5'
      }),
      {} as never
    );

    expect(driver).toBe(mocks.fakeDriver);
    expect(mocks.createCodexDriver).toHaveBeenCalledWith({
      cwd: '/repo',
      resumeId: 'thread-1',
      model: 'gpt-5.5',
      bypassPermissions: true
    });
  });
});
