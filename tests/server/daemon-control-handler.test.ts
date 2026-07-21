import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createDaemonControlHandler, isSafeDaemonSessionId } from '../../src/server/runtime/terminalDaemon.js';

interface Captured {
  status: number;
  body: { ok?: boolean; error?: string } | undefined;
}

function invoke(
  daemon: { provision: ReturnType<typeof vi.fn>; retire: ReturnType<typeof vi.fn> },
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Captured> {
  const handler = createDaemonControlHandler(daemon);
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  req.method = method;
  req.url = url;
  req.headers = headers ?? {};
  return new Promise<Captured>((resolve) => {
    let status = 0;
    const res = {
      set statusCode(value: number) {
        status = value;
      },
      setHeader() {
        /* sendJson sets content-type; irrelevant to these assertions */
      },
      end(payload?: string) {
        resolve({ status, body: payload ? (JSON.parse(payload) as Captured['body']) : undefined });
      }
    } as unknown as ServerResponse;
    handler(req, res);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function daemonMock(provisionResult: unknown = { ok: true, generation: 1, created: true }) {
  return {
    provision: vi.fn().mockResolvedValue(provisionResult),
    retire: vi.fn()
  };
}

describe('daemon control handler', () => {
  it('provisions a session and returns ok', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'spawntest',
      command: ['sh', '-c', 'bash'],
      geometry: { rows: 10, cols: 20 }
    });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(daemon.provision).toHaveBeenCalledWith('spawntest', {
      command: ['sh', '-c', 'bash'],
      geometry: { rows: 10, cols: 20 }
    });
  });

  it('defaults geometry when absent', async () => {
    const daemon = daemonMock();
    await invoke(daemon, 'POST', '/control/provision', { sessionId: 'sess-a', command: ['bash'] });
    expect(daemon.provision).toHaveBeenCalledWith('sess-a', { command: ['bash'], geometry: { rows: 24, cols: 80 } });
  });

  it('rejects a path-traversal sessionId without spawning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', { sessionId: '../escape', command: ['bash'] });
    expect(result.status).toBe(400);
    expect(result.body?.ok).toBe(false);
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('rejects an empty command without spawning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', { sessionId: 'sess-a', command: [] });
    expect(result.status).toBe(400);
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('surfaces a provision refusal as a non-2xx error, not a silent ok', async () => {
    const daemon = daemonMock({ ok: false, reason: 'cap-exceeded' });
    const result = await invoke(daemon, 'POST', '/control/provision', { sessionId: 'sess-a', command: ['bash'] });
    expect(result.status).toBe(503);
    expect(result.body?.ok).toBe(false);
    expect(result.body?.error).toContain('cap-exceeded');
  });

  it('reports a thrown provision error as HTTP 500', async () => {
    const daemon = { provision: vi.fn().mockRejectedValue(new Error('spawn failed')), retire: vi.fn() };
    const result = await invoke(daemon, 'POST', '/control/provision', { sessionId: 'sess-a', command: ['bash'] });
    expect(result.status).toBe(500);
    expect(result.body?.error).toContain('spawn failed');
  });

  it('retires a session', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/retire', { sessionId: 'sess-a' });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(daemon.retire).toHaveBeenCalledWith('sess-a');
  });

  it('answers the health probe', async () => {
    const result = await invoke(daemonMock(), 'GET', '/control/health');
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it('404s an unknown control path', async () => {
    const result = await invoke(daemonMock(), 'POST', '/control/bogus', {});
    expect(result.status).toBe(404);
  });

  it('maps an over-cap body to a typed 413 without spawning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', '{}', {
      'content-length': String(128 * 1024)
    });
    expect(result.status).toBe(413);
    expect(daemon.provision).not.toHaveBeenCalled();
  });
});

describe('isSafeDaemonSessionId', () => {
  it('accepts real session ids', () => {
    for (const id of ['shell', 'spawntest', 'agentdesk-canary-shell-002e06d4', 'a1_b-2']) {
      expect(isSafeDaemonSessionId(id)).toBe(true);
    }
  });

  it('rejects path separators, traversal, and non-strings', () => {
    for (const id of ['../escape', 'has/slash', 'has space', '', 'a', 42, null, undefined]) {
      expect(isSafeDaemonSessionId(id)).toBe(false);
    }
  });
});
