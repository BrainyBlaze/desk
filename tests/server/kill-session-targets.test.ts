import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpec } from '../../src/core/types.js';
import * as runner from '../../src/core/runner.js';
import { killSessionTargets } from '../../src/server/routes/sessionsRoutes.js';

function spec(name: string, sessionId: string | undefined, tmuxSession: string): SessionSpec {
  return {
    groupId: 'canary',
    groupLabel: 'Canary',
    name,
    cwd: '/tmp/work',
    tmuxSession,
    sessionId,
    command: 'bash',
    uiMode: 'terminal'
  };
}

const saved = process.env.DESK_ATCH_NATIVE;
afterEach(() => {
  if (saved === undefined) delete process.env.DESK_ATCH_NATIVE;
  else process.env.DESK_ATCH_NATIVE = saved;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('killSessionTargets under DESK_ATCH_NATIVE', () => {
  it('retires each target via the daemon and never calls tmux', async () => {
    process.env.DESK_ATCH_NATIVE = '1';
    process.env.DESK_DAEMON_URL = 'ws://127.0.0.1:5178';
    const killSpy = vi.spyOn(runner, 'killSession');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await killSessionTargets([spec('shell', 'shell', 'agentdesk-canary-shell-abc'), spec('two', 'two', 'agentdesk-canary-two-def')]);

    expect(result).toEqual({ ok: true });
    expect(killSpy).not.toHaveBeenCalled();
    const retiredIds = fetchMock.mock.calls.map((call) => {
      expect(call[0]).toBe('http://127.0.0.1:5178/control/retire');
      return JSON.parse(call[1].body).sessionId;
    });
    expect(retiredIds).toEqual(['shell', 'two']);
  });

  it('retires by sessionId, not tmuxSession', async () => {
    process.env.DESK_ATCH_NATIVE = '1';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    await killSessionTargets([spec('shell', 'shell', 'agentdesk-canary-shell-abc')]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionId).toBe('shell');
  });

  it('fails closed when the daemon retire is unreachable, leaving the manifest untouched', async () => {
    process.env.DESK_ATCH_NATIVE = '1';
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await killSessionTargets([spec('shell', 'shell', 'agentdesk-canary-shell-abc')]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unreachable');
  });
});

