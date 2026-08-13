import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpec } from '../../src/core/types.js';
import * as runner from '../../src/core/runner.js';
import {
  moorCommandFor,
  createNativeChannelsTransport,
  provisionNativeSession,
  restartSessionNativeAware,
  retireStaleIdentityForEdit,
  staleNativeIdentityAfterEdit,
  startSessionNativeAware,
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

const ENV_KEYS = ['DESK_DAEMON_URL'] as const;
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

describe('moorCommandFor', () => {
  it('runs the command in its cwd, matching tmux new-session -c cwd command', () => {
    expect(moorCommandFor(baseSpec)).toEqual(['sh', '-c', "cd '/tmp/work' || exit 1\nbash"]);
  });

  it('single-quote-escapes a cwd containing a quote', () => {
    expect(moorCommandFor({ ...baseSpec, cwd: "/tmp/o'brien" })).toEqual([
      'sh',
      '-c',
      "cd '/tmp/o'\\''brien' || exit 1\nbash"
    ]);
  });

  it('falls back to the login shell when there is no command', () => {
    expect(moorCommandFor({ ...baseSpec, command: '' })).toEqual(['sh', '-c', 'cd \'/tmp/work\' || exit 1\n"${SHELL:-bash}"']);
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
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
  });

  it('registers the canonical producer for an agent session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await provisionNativeSession({ ...baseSpec, agent: 'claude', uiMode: 'native' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).subject).toEqual({
      kind: 'agent',
      provider: 'claude',
      mode: 'native',
      producer: 'claude-native'
    });
  });

  it('sends an exact Claude continuity descriptor to the daemon before provision', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await provisionNativeSession({
      ...baseSpec,
      agent: 'claude',
      resume: '11111111-2222-4333-8444-555555555555',
      profileId: 'work'
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).continuity).toEqual({
      schemaVersion: 1,
      provider: 'claude',
      providerSessionId: '11111111-2222-4333-8444-555555555555',
      cwd: '/tmp/work',
      profileId: 'work'
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).providerSessionId).toBe(
      '11111111-2222-4333-8444-555555555555'
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).claudeMemory).toEqual({
      schemaVersion: 1,
      provider: 'claude',
      cwd: '/tmp/work',
      profileId: 'work'
    });
  });

  it('sends the exact Codex resume id as provider fence input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await provisionNativeSession({
      ...baseSpec,
      agent: 'codex',
      uiMode: 'native',
      resume: '11111111-2222-4333-8444-555555555555'
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      providerSessionId: '11111111-2222-4333-8444-555555555555',
      subject: {
        kind: 'agent',
        provider: 'codex',
        mode: 'native',
        producer: 'codex-native'
      }
    });
  });

  it('sends Claude profile memory ownership without a resume id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    await provisionNativeSession({
      ...baseSpec,
      agent: 'claude',
      profileId: 'work'
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.claudeMemory).toEqual({
      schemaVersion: 1,
      provider: 'claude',
      cwd: '/tmp/work',
      profileId: 'work'
    });
    expect(body.continuity).toBeUndefined();
  });


  it('surfaces a non-2xx daemon response as an error, not a silent ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => JSON.stringify({ ok: false, error: 'moor provision refused: cap-exceeded' }) });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await startSessionNativeAware(baseSpec);
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/control/provision');
  });

});

describe('restartSessionNativeAware', () => {
  it('retires then provisions via the daemon (same sessionId) when the flag is on', async () => {
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '{"ok":false,"error":"boom"}' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await restartSessionNativeAware(baseSpec);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/control/retire');
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

    const sent = await transport.sendText('shell', 'msg body');

    expect(sent).toBe(true);
    // An unobservable screen (the stub returns no lines) has no submit oracle,
    // so delivery stays the single open-loop press it always was.
    expect(bodies).toEqual([
      { sessionId: 'shell', rows: 200 },
      { sessionId: 'shell', text: 'msg body', paste: true },
      { sessionId: 'shell', rows: 200 },
      { sessionId: 'shell', text: '\r' }
    ]);
    expect(waits).toEqual([700]);
  });

  it('sendText works when passed as the detached terminal sender used by Channels', async () => {
    stubDesk();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200, text: async () => '{"ok":true}' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sendText } = createNativeChannelsTransport({ wait: async () => {} });

    expect(await sendText('shell', 'msg body')).toBe(true);
    expect(bodies).toEqual([
      { sessionId: 'shell', rows: 200 },
      { sessionId: 'shell', text: 'msg body', paste: true },
      { sessionId: 'shell', rows: 200 },
      { sessionId: 'shell', text: '\r' }
    ]);
  });

  /**
   * The operator-reported bug: the message lands in the composer but codex
   * never starts processing it until a human presses Enter. A fixed delay
   * cannot tell a swallowed keystroke from an accepted one — the screen can.
   */
  it('sendText repeats Enter while the screen does not move across the press', async () => {
    stubDesk();
    const bodies: Array<Record<string, unknown>> = [];
    const captures = ['ready', '> msg body', '> msg body', '> msg body', '> msg body'];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      const lines = body.rows === 200 ? [captures.shift() ?? '> msg body'] : undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(lines ? { ok: true, lines } : { ok: true })
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport({ enterAttempts: 3, wait: async () => {} });

    expect(await transport.sendText('shell', 'msg body')).toBe(true);

    const enters = bodies.filter((body) => body.text === '\r');
    expect(enters).toHaveLength(3);
  });

  it('waits for an asynchronously staged paste before using screen movement as submit proof', async () => {
    stubDesk();
    const bodies: Array<Record<string, unknown>> = [];
    const captures = ['ready', 'ready', '> msg body', '> msg body', 'working'];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      const lines = body.rows === 200 ? [captures.shift() ?? 'working'] : undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(lines ? { ok: true, lines } : { ok: true })
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport({ enterAttempts: 3, wait: async () => {} });

    expect(await transport.sendText('shell', 'msg body')).toBe(true);

    const firstEnter = bodies.findIndex((body) => body.text === '\r');
    expect(bodies.slice(0, firstEnter).filter((body) => body.rows === 200)).toHaveLength(3);
    expect(bodies.filter((body) => body.text === '\r')).toHaveLength(2);
  });

  it('sendText stops pressing Enter as soon as the screen moves', async () => {
    stubDesk();
    const bodies: Array<Record<string, unknown>> = [];
    const captures = ['ready', '> msg body', 'thinking…'];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      // The submit lands: the composer clears on the capture after the press.
      const lines = body.rows === 200 ? [captures.shift() ?? 'thinking…'] : undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(lines ? { ok: true, lines } : { ok: true })
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport({ enterAttempts: 3, wait: async () => {} });

    expect(await transport.sendText('shell', 'msg body')).toBe(true);

    expect(bodies.filter((body) => body.text === '\r')).toHaveLength(1);
  });

  it('sendText reports false (no Enter) when the paste fails', async () => {
    stubDesk();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport({ wait: async () => {} });
    expect(await transport.sendText('shell', 'msg')).toBe(false);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { sessionId: 'shell', rows: 200 },
      { sessionId: 'shell', text: 'msg', paste: true }
    ]);
  });

  it('capturePane joins the daemon tail lines and returns null when unobservable', async () => {
    stubDesk();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, lines: ['a', 'b'] }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"ok":false,"error":"no such session"}' });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport();
    expect(await transport.capturePane('shell')).toBe('a\nb');
    expect(await transport.capturePane('shell')).toBeNull();
  });

  it('sendEnter sends a bare CR keyed by sessionId', async () => {
    stubDesk();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport();
    expect(await transport.sendEnter('shell')).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sessionId: 'shell', text: '\r' });
  });

  it('sessionRunning reads the flag-aware running set', () => {
    const runningSpy = vi.spyOn(runner, 'runningSessionSet').mockReturnValue(new Set(['shell']));
    const transport = createNativeChannelsTransport();
    expect(transport.sessionRunning('shell')).toBe(true);
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

  it('sessionCreatedAt is the adopted holder wallStart in epoch seconds and null without a live link', async () => {
    stubDesk();
    const startedMs = Date.now() - 5_000;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/control/moor-status')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ ok: true, generation: 2, wallStartMs: startedMs, pid: 42, running: true })
        };
      }
      return { ok: false, status: 404, text: async () => '{"ok":false}' };
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = createNativeChannelsTransport();
    // #8: wire truth — the holder's own wallStart clock, never a socket stat.
    expect(await transport.sessionCreatedAt('shell')).toBe(Math.floor(startedMs / 1000));
    const statusCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/control/moor-status'));
    expect(String(statusCall?.[0])).toContain('sessionId=shell');

    // No live adopted link (daemon 404) → unobservable, никаких fs-догадок.
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '{"ok":false}' } as never);
    expect(await transport.sessionCreatedAt('agentdesk-g-ghost-999')).toBeNull();
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


  it('returns undefined when either spec is missing', () => {
    expect(staleNativeIdentityAfterEdit(undefined, baseSpec)).toBeUndefined();
    expect(staleNativeIdentityAfterEdit(baseSpec, undefined)).toBeUndefined();
  });
});

describe('retireStaleIdentityForEdit (fail-closed guard)', () => {
  const oldSpec = { ...baseSpec, sessionId: 'shell' };
  const renamed = { ...baseSpec, sessionId: 'renamed' };


  it('is a no-op (ok) when the identity is unchanged', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await retireStaleIdentityForEdit(oldSpec, { ...baseSpec, sessionId: 'shell', model: 'x' })).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retires the OLD identity and reports ok when the daemon accepts it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await retireStaleIdentityForEdit(oldSpec, renamed)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/control/retire');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionId).toBe('shell');
  });

  it('reports NOT-ok when the retire fails, so the caller aborts the edit (fail closed)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await retireStaleIdentityForEdit(oldSpec, renamed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not retire old identity shell');
    }
  });
});
