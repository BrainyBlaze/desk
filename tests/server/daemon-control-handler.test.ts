import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createDaemonControlHandler, isSafeDaemonSessionId } from '../../src/server/runtime/terminalDaemon.js';

interface Captured {
  status: number;
  body: { ok?: boolean; error?: string; lines?: string[] } | undefined;
}

interface DaemonMock {
  provision: ReturnType<typeof vi.fn>;
  retire: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  tail: ReturnType<typeof vi.fn>;
}

function invoke(
  daemon: DaemonMock,
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

function daemonMock(provisionResult: unknown = { ok: true, generation: 1, created: true }): DaemonMock {
  return {
    provision: vi.fn().mockResolvedValue(provisionResult),
    retire: vi.fn(),
    input: vi.fn().mockReturnValue(true),
    tail: vi.fn().mockReturnValue(['line-a', 'line-b'])
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
    const daemon = { ...daemonMock(), provision: vi.fn().mockRejectedValue(new Error('spawn failed')) };
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

  it('injects input for a known session, threading the paste flag', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/input', { sessionId: 'sess-a', text: 'hi\n', paste: true });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    const [sessionId, bytes, paste] = daemon.input.mock.calls[0];
    expect(sessionId).toBe('sess-a');
    expect(new TextDecoder().decode(bytes)).toBe('hi\n');
    expect(paste).toBe(true);
  });

  it('404s input for an unknown session (a concrete failure, not a silent ok)', async () => {
    const daemon = { ...daemonMock(), input: vi.fn().mockReturnValue(false) };
    const result = await invoke(daemon, 'POST', '/control/input', { sessionId: 'ghost', text: 'hi' });
    expect(result.status).toBe(404);
    expect(result.body?.ok).toBe(false);
  });

  it('400s empty input text without touching the daemon', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/input', { sessionId: 'sess-a', text: '' });
    expect(result.status).toBe(400);
    expect(daemon.input).not.toHaveBeenCalled();
  });

  it('returns the tail lines for a known session, clamping rows', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a', rows: 5000 });
    expect(result.status).toBe(200);
    expect(result.body?.lines).toEqual(['line-a', 'line-b']);
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 1000);
  });

  it('defaults tail rows when absent and 404s an unknown session', async () => {
    const daemon = daemonMock();
    await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a' });
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 200);
    const unknown = { ...daemonMock(), tail: vi.fn().mockReturnValue(undefined) };
    const result = await invoke(unknown, 'POST', '/control/tail', { sessionId: 'ghost' });
    expect(result.status).toBe(404);
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
