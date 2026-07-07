import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../src/core/types';
import { rewriteNativeLaunchCommand } from '../src/server/agentHostLaunch';

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    groupId: 'main',
    groupLabel: 'main',
    name: 'chat',
    cwd: '/home/dev/projects/my app',
    agent: 'claude',
    resume: 'sess-uuid-1',
    bypassPermissions: false,
    tmuxSession: 'agentdesk-alpha-main-chat-00000000',
    command: "cd '/home/dev/projects/my app' && exec desk agent-host",
    uiMode: 'native',
    ...overrides
  };
}

const ctx = { serverUrl: 'http://127.0.0.1:5190', token: 'tok123' };

describe('rewriteNativeLaunchCommand', () => {
  it('leaves terminal-mode specs untouched', () => {
    const terminal = spec({ uiMode: 'terminal', command: 'cd /x && exec claude' });
    expect(rewriteNativeLaunchCommand(terminal, ctx)).toBe(terminal);
  });

  it('injects the six locked env keys into the native launch command', () => {
    const rewritten = rewriteNativeLaunchCommand(spec(), ctx);
    expect(rewritten.command).toBe(
      "cd '/home/dev/projects/my app' && " +
        "DESK_TMUX_SESSION='agentdesk-alpha-main-chat-00000000' " +
        "DESK_AGENT='claude' " +
        "DESK_AGENT_RESUME='sess-uuid-1' " +
        "DESK_AGENT_BYPASS='0' " +
        "DESK_SERVER_URL='http://127.0.0.1:5190' " +
        "DESK_AGENT_HOST_TOKEN='tok123' " +
        'exec desk agent-host'
    );
    expect(rewritten).not.toBe(spec());
  });

  it('omits the resume key when no resume id is captured and maps bypass to 1', () => {
    const rewritten = rewriteNativeLaunchCommand(spec({ resume: undefined, bypassPermissions: true }), ctx);
    expect(rewritten.command).not.toContain('DESK_AGENT_RESUME');
    expect(rewritten.command).toContain("DESK_AGENT_BYPASS='1'");
  });

  it('injects DESK_AGENT_MODEL only when the spec carries a model', () => {
    const withModel = rewriteNativeLaunchCommand(spec({ model: 'zai-coding-plan/glm-5.2' }), ctx);
    expect(withModel.command).toContain("DESK_AGENT_MODEL='zai-coding-plan/glm-5.2'");
    const without = rewriteNativeLaunchCommand(spec(), ctx);
    expect(without.command).not.toContain('DESK_AGENT_MODEL');
  });

  it('passes managed LSP env into native agent-host launches when present', () => {
    const rewritten = rewriteNativeLaunchCommand(spec(), { ...ctx, lspEnvFilePath: '/tmp/desk-lsp/env.json' });
    expect(rewritten.command).toContain("DESK_LSP_ENV_FILE='/tmp/desk-lsp/env.json'");
  });

  it('shell-quotes hostile values', () => {
    const rewritten = rewriteNativeLaunchCommand(spec({ resume: "it's" }), { serverUrl: ctx.serverUrl, token: "to'k" });
    expect(rewritten.command).toContain("DESK_AGENT_RESUME='it'\\''s'");
    expect(rewritten.command).toContain("DESK_AGENT_HOST_TOKEN='to'\\''k'");
  });
});
