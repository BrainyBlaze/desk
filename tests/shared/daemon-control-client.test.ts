import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  daemonControl,
  daemonHttpBase,
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

    expect(result).toEqual({ ok: true, body: { ok: true, lines: ['ready'] } });
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
      error: 'cap-exceeded'
    });
    await expect(daemonControl('/control/provision', {}, { baseUrl: 'http://daemon' })).resolves.toEqual({
      ok: false,
      error: 'terminal daemon returned an invalid JSON response (HTTP 200)'
    });
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

  it('collapses body-bearing results without leaking the response body', async () => {
    await expect(toOkResult(Promise.resolve({ ok: true, body: { ok: true, value: 1 } }))).resolves.toEqual({ ok: true });
    await expect(toOkResult(Promise.resolve({ ok: false, error: 'refused' }))).resolves.toEqual({
      ok: false,
      error: 'refused'
    });
  });
});
