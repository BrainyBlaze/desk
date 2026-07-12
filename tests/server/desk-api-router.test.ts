import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLockBusyError } from '../../src/shared/fileLock.js';
import { ManifestMutationError } from '../../src/core/config.js';
import { ManifestValidationError } from '../../src/core/manifest.js';
import { ApiConflictError, ApiNotFoundError, readRequiredString } from '../../src/server/apiValidation.js';
import { createDeskApiMiddleware } from '../../src/server/deskApiRouter.js';
import { readJsonBody } from '../../src/server/httpUtil.js';
import type { DeskRoute } from '../../src/server/plugin.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function request(url: string): IncomingMessage {
  return { method: 'GET', url } as IncomingMessage;
}

function bodyRequest(url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Object.assign(new PassThrough(), { method: 'POST', url, headers }) as unknown as IncomingMessage;
  req.end(body);
  return req;
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

  it('preserves the status, code, and safe message from HttpBodyError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async (req) => {
      await readJsonBody(req, { maxBytes: 8 });
      return true;
    };

    await createDeskApiMiddleware([route])(
      bodyRequest('/api/body', 'ignored', { 'content-length': '9' }),
      res,
      vi.fn()
    );

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'Request body too large',
      code: 'body-too-large'
    });
  });

  it('returns a safe 400 for typed API validation errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      readRequiredString(undefined, 'session');
      return true;
    };

    await createDeskApiMiddleware([route])(request('/api/validate'), res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'session must be a non-empty string',
      code: 'invalid-input'
    });
  });

  it('returns a safe retryable conflict for a busy file lock', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw new FileLockBusyError('/home/user/.config/desk/desk.yml', 10_000);
    };

    await createDeskApiMiddleware([route])(request('/api/save'), res, vi.fn());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'Desk data is busy; retry the request',
      code: 'FILE_LOCK_BUSY'
    });
    expect(res.body).not.toContain('/home/user');
  });

  it('preserves typed API conflicts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw new ApiConflictError('target already exists');
    };

    await createDeskApiMiddleware([route])(request('/api/conflict'), res, vi.fn());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'target already exists',
      code: 'conflict'
    });
  });

  it('preserves typed not-found failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw new ApiNotFoundError('source does not exist');
    };

    await createDeskApiMiddleware([route])(request('/api/missing'), res, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'source does not exist',
      code: 'not-found'
    });
  });

  it('preserves safe manifest mutation conflicts without exposing arbitrary errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw new ManifestMutationError('group alpha already exists');
    };

    await createDeskApiMiddleware([route])(request('/api/add-group'), res, vi.fn());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'group alpha already exists',
      code: 'manifest-conflict'
    });
  });

  it('surfaces manifest validation failures without treating them as server faults', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw new ManifestValidationError('project alpha requires cwd');
    };

    await createDeskApiMiddleware([route])(request('/api/desk'), res, vi.fn());

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'project alpha requires cwd',
      code: 'manifest-invalid'
    });
  });

  it('maps known filesystem errno failures to safe actionable responses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const route: DeskRoute = async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/home/user/secret'"), { code: 'ENOENT' });
    };

    await createDeskApiMiddleware([route])(request('/api/fs/read'), res, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: 'File or directory not found',
      code: 'not-found'
    });
    expect(res.body).not.toContain('/home/user');
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
