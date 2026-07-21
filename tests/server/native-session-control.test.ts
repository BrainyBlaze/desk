import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpec } from '../../src/core/types.js';
import * as runner from '../../src/core/runner.js';
import {
  atchCommandFor,
  createNativeChannelsTransport,
  daemonHttpBase,
  nativeSessionsEnabled,
  provisionNativeSession,
  restartSessionNativeAware,
  retireStaleIdentityForEdit,
  staleNativeIdentityAfterEdit,
  startSessionNativeAware
} from '../../src/server/runtime/nativeSessionControl.js';

const baseSpec: SessionSpec = {
  groupId: 'g',
  groupLabel: 'G',
  name: 'shell',
  cwd: '/tmp/work',
  tmuxSession: 'agentdesk-g-shell-abc',
  sessionId: 'shell',
  command: 'bash',
  uiMode: 'terminal'
};

const ENV_KEYS = ['DESK_ATCH_NATIVE', 'DESK_DAEMON_URL'] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});
function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  saved[key] ??= process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('atchCommandFor', () => {
  it('runs the command in its cwd, matching tmux new-session -c cwd command', () => {
    expect(atchCommandFor(baseSpec)).toEqual(['sh', '-c', "cd '/tmp/work' || exit 1\nbash"]);
  });

  it('single-quote-escapes a cwd containing a quote', () => {
    expect(atchCommandFor({ ...baseSpec, cwd: "/tmp/o'brien" })).toEqual([
      'sh',
      '-c',
      "cd '/tmp/o'\\''brien' || exit 1\nbash"
    ]);
  });

  it('falls back to the login shell when there is no command', () => {
    expect(atchCommandFor({ ...baseSpec, command: '' })).toEqual(['sh', '-c', 'cd \'/tmp/work\' || exit 1\n"${SHELL:-bash}"']);
  });
});

describe('daemonHttpBase', () => {
  it('derives http from the ws daemon url', () => {
    setEnv('DESK_DAEMON_URL', 'ws://127.0.0.1:5178');
    expect(daemonHttpBase()).toBe('http://127.0.0.1:5178');
  });
  it('derives https from wss', () => {
    setEnv('DESK_DAEMON_URL', 'wss://daemon.example:443');
    expect(daemonHttpBase()).toBe('https://daemon.example:443');
  });
  it('defaults to the local daemon', () => {
    setEnv('DESK_DAEMON_URL', undefined);
    expect(daemonHttpBase()).toBe('http://127.0.0.1:5178');
  });
});

describe('nativeSessionsEnabled', () => {
  it('is true only when DESK_ATCH_NATIVE=1', () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    expect(nativeSessionsEnabled()).toBe(true);
    setEnv('DESK_ATCH_NATIVE', '0');
    expect(nativeSessionsEnabled()).toBe(false);
    setEnv('DESK_ATCH_NATIVE', undefined);
    expect(nativeSessionsEnabled()).toBe(false);
  });
});

describe('provisionNativeSession', () => {
  it('posts sessionId + command to the daemon control plane and returns ok', async () => {
    setEnv('DESK_DAEMON_URL', 'ws://127.0.0.1:5178');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provisionNativeSession(baseSpec);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5178/control/provision');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      sessionId: 'shell',
      command: ['sh', '-c', "cd '/tmp/work' || exit 1\nbash"],
      geometry: { rows: 24, cols: 80 }
    });
  });

  it('falls back to tmuxSession when no sessionId is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    await provisionNativeSession({ ...baseSpec, sessionId: undefined });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionId).toBe('agentdesk-g-shell-abc');
  });

  it('surfaces a non-2xx daemon response as an error, not a silent ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => JSON.stringify({ ok: false, error: 'atch provision refused: cap-exceeded' }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await provisionNativeSession(baseSpec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cap-exceeded');
  });

  it('surfaces an unreachable daemon as an error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await provisionNativeSession(baseSpec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unreachable');
  });
});

describe('startSessionNativeAware', () => {
  it('provisions via the daemon when the flag is on', async () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await startSessionNativeAware(baseSpec);
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/control/provision');
  });

  it('uses the legacy tmux startSession when the flag is off', async () => {
    setEnv('DESK_ATCH_NATIVE', undefined);
    const startSpy = vi.spyOn(runner, 'startSession').mockReturnValue({ ok: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await startSessionNativeAware(baseSpec);
    expect(result).toEqual({ ok: true });
    expect(startSpy).toHaveBeenCalledWith(baseSpec);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('restartSessionNativeAware', () => {
  it('retires then provisions via the daemon (same sessionId) when the flag is on', async () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    const urls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, text: async () => '{"ok":true}' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await restartSessionNativeAware(baseSpec);
    expect(result).toEqual({ ok: true });
    expect(urls[0]).toContain('/control/retire');
    expect(urls[1]).toContain('/control/provision');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionId).toBe('shell');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).sessionId).toBe('shell');
  });

  it('does not provision if the retire fails (fail-closed)', async () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '{"ok":false,"error":"boom"}' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await restartSessionNativeAware(baseSpec);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/control/retire');
  });

  it('uses the legacy tmux restartSession when the flag is off', async () => {
    setEnv('DESK_ATCH_NATIVE', undefined);
    const restartSpy = vi.spyOn(runner, 'restartSession').mockReturnValue({ ok: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await restartSessionNativeAware(baseSpec);
    expect(result).toEqual({ ok: true });
    expect(restartSpy).toHaveBeenCalledWith(baseSpec);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createNativeChannelsTransport', () => {
  function stubDesk(): void {
    vi.spyOn(runner, 'loadDeskCached').mockReturnValue({
      sessions: [{ ...baseSpec, tmuxSession: 'agentdesk-g-shell-abc', sessionId: 'shell' }]
    } as never);
  }

  it('sendText pastes via the daemon (paste flag on) then sends a delayed CR', async () => {
    stubDesk();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200, text: async () => '{"ok":true}' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const waits: number[] = [];
    const transport = createNativeChannelsTransport({ enterDelayMs: 700, wait: async (ms) => void waits.push(ms) });

    const sent = await transport.sendText('agentdesk-g-shell-abc', 'msg body');

    expect(sent).toBe(true);
    expect(bodies).toEqual([
      { sessionId: 'shell', text: 'msg body', paste: true },
      { sessionId: 'shell', text: '\r' }
    ]);
    expect(waits).toEqual([700]);
  });

  it('sendText reports false (no Enter) when the paste fails', async () => {
    stubDesk();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport({ wait: async () => {} });
    expect(await transport.sendText('agentdesk-g-shell-abc', 'msg')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('capturePane joins the daemon tail lines and returns null when unobservable', async () => {
    stubDesk();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, lines: ['a', 'b'] }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"ok":false,"error":"no such session"}' });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport();
    expect(await transport.capturePane('agentdesk-g-shell-abc')).toBe('a\nb');
    expect(await transport.capturePane('agentdesk-g-shell-abc')).toBeNull();
  });

  it('sendEnter sends a bare CR keyed by sessionId', async () => {
    stubDesk();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport();
    expect(await transport.sendEnter('agentdesk-g-shell-abc')).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sessionId: 'shell', text: '\r' });
  });

  it('sessionRunning reads the flag-aware running set', () => {
    const runningSpy = vi.spyOn(runner, 'runningSessionSet').mockReturnValue(new Set(['agentdesk-g-shell-abc']));
    const transport = createNativeChannelsTransport();
    expect(transport.sessionRunning('agentdesk-g-shell-abc')).toBe(true);
    expect(transport.sessionRunning('agentdesk-g-ghost-def')).toBe(false);
    expect(runningSpy).toHaveBeenCalled();
  });

  it('falls back to the tmuxSession as the daemon key for an unknown session', async () => {
    vi.spyOn(runner, 'loadDeskCached').mockReturnValue({ sessions: [] } as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport();
    await transport.sendEnter('agentdesk-g-orphan-xyz');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionId).toBe('agentdesk-g-orphan-xyz');
  });
});

describe('staleNativeIdentityAfterEdit', () => {
  it('returns the OLD identity when a rename changes the minted sessionId (prevents an orphan master)', () => {
    const oldSpec = { ...baseSpec, name: 'shell', sessionId: 'shell' };
    const renamed = { ...baseSpec, name: 'workbench', sessionId: 'workbench' };
    expect(staleNativeIdentityAfterEdit(oldSpec, renamed)).toBe('shell');
  });

  it('returns undefined when the identity is unchanged (e.g. a model-only edit)', () => {
    const oldSpec = { ...baseSpec, sessionId: 'shell', model: 'a' };
    const edited = { ...baseSpec, sessionId: 'shell', model: 'b' };
    expect(staleNativeIdentityAfterEdit(oldSpec, edited)).toBeUndefined();
  });

  it('falls back to tmuxSession when sessionId is absent', () => {
    const oldSpec = { ...baseSpec, sessionId: undefined, tmuxSession: 'agentdesk-g-old-abc' };
    const renamed = { ...baseSpec, sessionId: undefined, tmuxSession: 'agentdesk-g-new-def' };
    expect(staleNativeIdentityAfterEdit(oldSpec, renamed)).toBe('agentdesk-g-old-abc');
  });

  it('returns undefined when either spec is missing', () => {
    expect(staleNativeIdentityAfterEdit(undefined, baseSpec)).toBeUndefined();
    expect(staleNativeIdentityAfterEdit(baseSpec, undefined)).toBeUndefined();
  });
});

describe('retireStaleIdentityForEdit (fail-closed guard)', () => {
  const oldSpec = { ...baseSpec, sessionId: 'shell' };
  const renamed = { ...baseSpec, sessionId: 'renamed' };

  it('is a no-op (ok) when the flag is off', async () => {
    setEnv('DESK_ATCH_NATIVE', undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await retireStaleIdentityForEdit(oldSpec, renamed)).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op (ok) when the identity is unchanged', async () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await retireStaleIdentityForEdit(oldSpec, { ...baseSpec, sessionId: 'shell', model: 'x' })).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retires the OLD identity and reports ok when the daemon accepts it', async () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await retireStaleIdentityForEdit(oldSpec, renamed)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/control/retire');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionId).toBe('shell');
  });

  it('reports NOT-ok when the retire fails, so the caller aborts the edit (fail closed)', async () => {
    setEnv('DESK_ATCH_NATIVE', '1');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await retireStaleIdentityForEdit(oldSpec, renamed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not retire old identity shell');
    }
  });
});
