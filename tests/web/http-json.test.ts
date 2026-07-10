import { describe, expect, it } from 'vitest';
import { readJson } from '../../src/web/httpJson';

const resp = (body: string, status = 200): Promise<Response> =>
  Promise.resolve(new Response(body, { status }));

describe('readJson', () => {
  it('returns parsed JSON on an ok response', async () => {
    await expect(readJson(resp(JSON.stringify({ a: 1 })))).resolves.toEqual({ a: 1 });
  });

  it('returns {} on an empty ok body instead of throwing a parse error', async () => {
    await expect(readJson(resp('', 200))).resolves.toEqual({});
  });

  it('throws the server-supplied error field on a not-ok JSON body', async () => {
    await expect(readJson(resp(JSON.stringify({ error: 'nope' }), 400))).rejects.toThrow('nope');
  });

  it('throws a status message (not a SyntaxError) on a not-ok non-JSON body', async () => {
    // Regression: previously response.json() threw SyntaxError and lost the real status.
    await expect(readJson(resp('<html>502 Bad Gateway</html>', 502))).rejects.toThrow('request failed (502)');
  });

  it('throws a status message on a not-ok empty body', async () => {
    await expect(readJson(resp('', 500))).rejects.toThrow('request failed (500)');
  });

  it('uses a caller-supplied error mapper when provided', async () => {
    class MissingScopeError extends Error {}
    const promise = readJson(resp(JSON.stringify({ missingScope: true, error: 'need scope' }), 403), ({ body }) =>
      body?.missingScope ? new MissingScopeError(typeof body.error === 'string' ? body.error : 'missing scope') : undefined
    );
    await expect(promise).rejects.toBeInstanceOf(MissingScopeError);
    await expect(promise).rejects.toThrow('need scope');
  });
});
