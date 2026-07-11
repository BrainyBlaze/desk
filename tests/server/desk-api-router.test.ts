import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createDeskApiMiddleware } from '../../src/server/deskApiRouter.js';
import type { DeskRoute } from '../../src/server/plugin.js';

function request(url: string): IncomingMessage {
  return { method: 'GET', url } as IncomingMessage;
}

function response(): ServerResponse & { body?: string } {
  const value = {
    statusCode: 0,
    setHeader: vi.fn(),
    end(body?: string) {
      this.body = body;
    }
  };
  return value as unknown as ServerResponse & { body?: string };
}

describe('createDeskApiMiddleware', () => {
  it('passes non-API requests through without consulting routes', async () => {
    const route = vi.fn<DeskRoute>();
    const next = vi.fn();

    await createDeskApiMiddleware([route])(request('/assets/app.js'), response(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(route).not.toHaveBeenCalled();
  });

  it('checks routes in order and stops after the first handler', async () => {
    const calls: string[] = [];
    const routes: DeskRoute[] = [
      async () => {
        calls.push('first');
        return false;
      },
      async (_req, res) => {
        calls.push('second');
        res.statusCode = 204;
        res.end();
        return true;
      },
      async () => {
        calls.push('third');
        return true;
      }
    ];
    const res = response();

    await createDeskApiMiddleware(routes)(request('/api/example'), res, vi.fn());

    expect(calls).toEqual(['first', 'second']);
    expect(res.statusCode).toBe(204);
  });

  it('returns JSON 404 for an unknown API route', async () => {
    const res = response();

    await createDeskApiMiddleware([])(request('/api/missing'), res, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '')).toEqual({ error: 'unknown API route /api/missing' });
  });

  it('logs and returns JSON 500 when a route throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw new Error('route failed');
    };

    await createDeskApiMiddleware([route])(request('/api/fail'), res, vi.fn());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body ?? '')).toEqual({ error: 'Internal server error' });
    expect(error).toHaveBeenCalledWith('[desk-api] %s %s failed:', 'GET /api/fail', expect.any(Error));
    error.mockRestore();
  });
});
