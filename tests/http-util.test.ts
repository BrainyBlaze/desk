import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readJsonBody, sendJson } from '../src/server/httpUtil.js';

function makeResponse(): ServerResponse & {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: '',
    headers: {},
    statusCode: 0,
    setHeader(name: string, value: number | string | readonly string[]) {
      this.headers[name.toLowerCase()] = String(value);
      return this;
    },
    end(chunk?: unknown) {
      this.body = String(chunk ?? '');
      return this;
    }
  } as ServerResponse & { body: string; headers: Record<string, string> };
}

describe('sendJson', () => {
  it('redacts stack fields before sending a JSON response', () => {
    const res = makeResponse();

    sendJson(res, 500, {
      error: 'request failed',
      detail: {
        stack: 'Error: boom\n    at internal.ts:1:1',
        nested: [{ stack: 'secret stack' }]
      }
    });

    expect(JSON.parse(res.body)).toEqual({
      error: 'request failed',
      detail: {
        nested: [{}]
      }
    });
    expect(res.body).not.toContain('internal.ts');
    expect(res.body).not.toContain('secret stack');
  });

  it('preserves non-plain JSON-serializable objects', () => {
    const res = makeResponse();

    sendJson(res, 200, { at: new Date('2026-07-01T12:00:00.000Z') });

    expect(JSON.parse(res.body)).toEqual({ at: '2026-07-01T12:00:00.000Z' });
  });

  it('serializes direct Error payloads without stack data', () => {
    const res = makeResponse();
    const error = new Error('boom');

    sendJson(res, 500, { error });

    expect(JSON.parse(res.body)).toEqual({ error: { name: 'Error', message: 'boom' } });
    expect(res.body).not.toContain('stack');
    expect(res.body).not.toContain('http-util.test');
  });
});

describe('readJsonBody', () => {
  function makeRequest(headers: Record<string, string> = {}) {
    return Object.assign(new PassThrough(), { headers }) as unknown as Parameters<typeof readJsonBody>[0];
  }

  it('rejects invalid JSON with a generic public error', async () => {
    const req = makeRequest();
    const promise = readJsonBody(req);

    req.end('{');

    await expect(promise).rejects.toThrow('Invalid JSON body');
    await expect(promise).rejects.not.toThrow(/Unexpected end/);
  });

  it('rejects a payload that grows beyond the configured byte cap', async () => {
    const req = makeRequest();
    const promise = readJsonBody(req, { maxBytes: 8 });

    req.end('{"value":true}');

    await expect(promise).rejects.toMatchObject({
      code: 'body-too-large',
      statusCode: 413,
      message: 'Request body too large'
    });
  });

  it('rejects oversized content-length before reading the body', async () => {
    const req = makeRequest({ 'content-length': '9' });
    const promise = readJsonBody(req, { maxBytes: 8 });

    req.end('ignored');

    await expect(promise).rejects.toMatchObject({
      code: 'body-too-large',
      statusCode: 413
    });
  });
});
