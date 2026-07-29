import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTerminalRoutes } from '../../src/server/routes/terminalRoutes.js';

const ENV_KEYS = ['DESK_ATCH_NATIVE', 'DESK_DAEMON_URL'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function invoke(body: unknown): Promise<{ status: number; payload: any }> {
  const route = createTerminalRoutes({ metrics: () => ({}) } as never);
  const req = {
    method: 'POST',
    setEncoding() {
      return req;
    },
    on(event: string, cb: (chunk?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
      return req;
    }
  } as unknown as IncomingMessage;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {
      return res;
    },
    end(data?: string) {
      payload = data ? JSON.parse(data) : undefined;
    }
  } as unknown as ServerResponse;
  const handled = await route(req, res, new URL('http://x/api/terminal-capture'));
  expect(handled).toBe(true);
  return { status: res.statusCode, payload };
}

describe('terminal-capture native proxy', () => {
  it('proxies the ranged read to /control/tail on the SAME request shape and adds totalAvailable', async () => {
    process.env.DESK_ATCH_NATIVE = '1';
    process.env.DESK_DAEMON_URL = 'ws://127.0.0.1:59998';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, lines: ['h1', 'h2'], totalAvailable: 321 })
    });
    vi.stubGlobal('fetch', fetchMock);

    const { status, payload } = await invoke({ sessionId: 'sess-web', rows: 2, offset: 40 });
    expect(status).toBe(200);
    expect(payload).toEqual({ lines: ['h1', 'h2'], totalAvailable: 321 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/control/tail');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ sessionId: 'sess-web', rows: 2, offset: 40 });
  });

  it('preserves the daemon 404 for an unknown session (client-addressable, not a 500)', async () => {
    process.env.DESK_ATCH_NATIVE = '1';
    process.env.DESK_DAEMON_URL = 'ws://127.0.0.1:59998';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ ok: false, error: 'no such session: ghost' })
      })
    );
    const { status, payload } = await invoke({ sessionId: 'ghost', rows: 5, offset: 0 });
    expect(status).toBe(404);
    expect(String(payload.error)).toContain('no such session');
  });

  it('surfaces a daemon failure as a 500 with the error, never a silent empty capture', async () => {
    process.env.DESK_ATCH_NATIVE = '1';
    process.env.DESK_DAEMON_URL = 'ws://127.0.0.1:59998';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('daemon down')));
    const { status, payload } = await invoke({ sessionId: 'sess-web', rows: 5, offset: 0 });
    expect(status).toBe(500);
    expect(String(payload.error)).toContain('daemon');
  });
});
