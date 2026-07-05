import { describe, expect, it } from 'vitest';
import { parseAgentHostEnv } from '../../../../src/server/agents/host/cli';

const VALID_ENV: NodeJS.ProcessEnv = {
  DESK_TMUX_SESSION: 'agentdesk-main-codex-abc12345',
  DESK_AGENT: 'codex',
  DESK_AGENT_BYPASS: '1',
  DESK_SERVER_URL: 'http://127.0.0.1:5173',
  DESK_AGENT_HOST_TOKEN: 'a]bH4shHex0123=',
  DESK_AGENT_RESUME: 'ses_abc',
  DESK_AGENT_CWD: '/tmp/proj',
  DESK_AGENT_HOST_LOG_LEVEL: 'info'
};

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...VALID_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe('parseAgentHostEnv — required keys', () => {
  it('accepts a fully populated env', () => {
    expect(parseAgentHostEnv(makeEnv())).toEqual({
      DESK_TMUX_SESSION: 'agentdesk-main-codex-abc12345',
      DESK_AGENT: 'codex',
      DESK_AGENT_BYPASS: '1',
      DESK_SERVER_URL: 'http://127.0.0.1:5173',
      DESK_AGENT_HOST_TOKEN: 'a]bH4shHex0123=',
      DESK_AGENT_RESUME: 'ses_abc',
      DESK_AGENT_CWD: '/tmp/proj',
      DESK_AGENT_HOST_LOG_LEVEL: 'info'
    });
  });

  it('accepts minimum required env (no optional keys)', () => {
    const env = parseAgentHostEnv(
      makeEnv({
        DESK_AGENT_RESUME: undefined,
        DESK_AGENT_CWD: undefined,
        DESK_AGENT_HOST_LOG_LEVEL: undefined
      })
    );
    expect(env.DESK_AGENT_RESUME).toBeUndefined();
    expect(env.DESK_AGENT_CWD).toBeUndefined();
    expect(env.DESK_AGENT_HOST_LOG_LEVEL).toBeUndefined();
  });

  it('rejects missing DESK_TMUX_SESSION', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_TMUX_SESSION: undefined }))).toThrow(/DESK_TMUX_SESSION/);
  });

  it('rejects empty DESK_TMUX_SESSION', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_TMUX_SESSION: '' }))).toThrow(/DESK_TMUX_SESSION/);
  });

  it('rejects missing DESK_AGENT', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT: undefined }))).toThrow(/DESK_AGENT/);
  });

  it('rejects unsupported DESK_AGENT', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT: 'mistral' }))).toThrow(/DESK_AGENT/);
  });

  it('accepts claude, codex, opencode, bash', () => {
    for (const agent of ['claude', 'codex', 'opencode', 'bash']) {
      expect(parseAgentHostEnv(makeEnv({ DESK_AGENT: agent })).DESK_AGENT).toBe(agent);
    }
  });

  it('rejects missing DESK_AGENT_BYPASS', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT_BYPASS: undefined }))).toThrow(/DESK_AGENT_BYPASS/);
  });

  it('rejects non-binary DESK_AGENT_BYPASS', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT_BYPASS: 'true' }))).toThrow(/DESK_AGENT_BYPASS/);
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT_BYPASS: '0x1' }))).toThrow(/DESK_AGENT_BYPASS/);
  });

  it('rejects missing DESK_SERVER_URL', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_SERVER_URL: undefined }))).toThrow(/DESK_SERVER_URL/);
  });

  it('rejects missing DESK_AGENT_HOST_TOKEN', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT_HOST_TOKEN: undefined }))).toThrow(/DESK_AGENT_HOST_TOKEN/);
  });
});

describe('parseAgentHostEnv — optional keys', () => {
  it('carries DESK_AGENT_RESUME when present', () => {
    expect(parseAgentHostEnv(makeEnv({ DESK_AGENT_RESUME: 'ses_xyz' })).DESK_AGENT_RESUME).toBe('ses_xyz');
  });

  it('carries DESK_AGENT_CWD when present', () => {
    expect(parseAgentHostEnv(makeEnv({ DESK_AGENT_CWD: '/home/user/project' })).DESK_AGENT_CWD).toBe('/home/user/project');
  });

  it('accepts each log level', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(parseAgentHostEnv(makeEnv({ DESK_AGENT_HOST_LOG_LEVEL: level })).DESK_AGENT_HOST_LOG_LEVEL).toBe(level);
    }
  });

  it('rejects unknown log level', () => {
    expect(() => parseAgentHostEnv(makeEnv({ DESK_AGENT_HOST_LOG_LEVEL: 'trace' }))).toThrow(/DESK_AGENT_HOST_LOG_LEVEL/);
  });
});
