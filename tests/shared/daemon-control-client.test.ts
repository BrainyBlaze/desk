import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  daemonControl,
  daemonControlGet,
  daemonHttpBase,
  observeProviderSessionIdentity,
  requestProviderSessionRebind,
  toOkResult
} from '../../src/shared/daemonControlClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daemonHttpBase', () => {
  it('derives bounded HTTP control origins from websocket endpoints', () => {
    expect(daemonHttpBase({ DESK_DAEMON_URL: 'ws://127.0.0.1:5178' })).toBe('http://127.0.0.1:5178');
    expect(daemonHttpBase({ DESK_DAEMON_URL: 'wss://daemon.example:443/' })).toBe('https://daemon.example');
    expect(daemonHttpBase({})).toBe('http://127.0.0.1:5178');
  });
});

describe('daemonControl', () => {
  it('posts JSON to the control route and returns the parsed success body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, lines: ['ready'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await daemonControl(
      '/control/tail',
      { sessionId: 'session-one', rows: 20 },
      { baseUrl: 'http://127.0.0.1:6123' }
    );

    expect(result).toEqual({ ok: true, body: { ok: true, lines: ['ready'] }, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:6123/control/tail');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: 'session-one', rows: 20 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed on daemon errors and malformed successful responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'cap-exceeded' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(daemonControl('/control/provision', {}, { baseUrl: 'http://daemon' })).resolves.toEqual({
      ok: false,
      error: 'cap-exceeded',
      status: 503,
      body: { ok: false, error: 'cap-exceeded' }
    });
    await expect(daemonControl('/control/provision', {}, { baseUrl: 'http://daemon' })).resolves.toEqual({
      ok: false,
      error: 'terminal daemon returned an invalid JSON response (HTTP 200)',
      status: 200
    });
  });

  it('preserves semantic rejection bodies and reasons for route passthrough', async () => {
    const body = {
      ok: false,
      reason: 'generation-fence',
      carried: 1,
      current: 2
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { 'content-type': 'application/json' }
      })
    );

    const result = await daemonControl('/control/agent-event', {}, {
      baseUrl: 'http://daemon',
      fetchImpl: fetchMock
    });

    expect(result).toEqual({
      ok: false,
      error: 'generation-fence',
      status: 409,
      body
    });
  });

  it('gets payload-bearing control resources through the shared transport', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, revision: 3, snapshots: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    await expect(
      daemonControlGet('/control/agent-states', {
        baseUrl: 'http://daemon',
        fetchImpl: fetchMock
      })
    ).resolves.toEqual({
      ok: true,
      status: 200,
      body: { ok: true, revision: 3, snapshots: [] }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://daemon/control/agent-states',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('aborts a hung request at the configured deadline', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await daemonControl('/control/retire', { sessionId: 'session-one' }, {
      baseUrl: 'http://127.0.0.1:6123',
      timeoutMs: 10
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('terminal daemon unreachable');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('uses exact typed observe and rebind payloads and honors caller cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, kind: 'matching' }), {
        status: 200
      })
    );
    const controller = new AbortController();
    const observation = {
      deskSessionId: 'session-one',
      provider: 'codex' as const,
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      generation: 2,
      launchProof: 'A'.repeat(43),
      hook: 'SessionStart'
    };

    await observeProviderSessionIdentity(observation, {
      baseUrl: 'http://daemon',
      fetchImpl: fetchMock,
      signal: controller.signal,
      timeoutMs: 900
    });
    await requestProviderSessionRebind(
      {
        sessionId: 'session-one',
        targetProviderSessionId: '22222222-2222-4222-8222-222222222222'
      },
      { baseUrl: 'http://daemon', fetchImpl: fetchMock }
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      observation
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      sessionId: 'session-one',
      targetProviderSessionId: '22222222-2222-4222-8222-222222222222'
    });
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort('caller disconnected');
    expect(signal.aborted).toBe(true);
  });

  it('collapses body-bearing results without leaking the response body', async () => {
    await expect(toOkResult(Promise.resolve({ ok: true, body: { ok: true, value: 1 } }))).resolves.toEqual({ ok: true });
    await expect(toOkResult(Promise.resolve({ ok: false, error: 'refused' }))).resolves.toEqual({
      ok: false,
      error: 'refused'
    });
  });
});
