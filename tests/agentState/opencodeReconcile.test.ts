import { describe, expect, it } from 'vitest';
import {
  MAX_RECONCILED_SESSIONS,
  reconcileOpencodeStatus
} from '../../src/core/agentState/opencodeReconcile.js';

/**
 * Reconciliation is what makes recovery honest: after a Desk or daemon restart
 * the authority holds no activity, and this is the only path that can fill it
 * in from what is true NOW rather than from what was recorded before the gap.
 * So its failure modes matter as much as its success: every one of them must
 * yield "no evidence", never a plausible guess.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

const fetchReturning = (response: Response | (() => never)): typeof globalThis.fetch =>
  (async () => (typeof response === 'function' ? response() : response)) as unknown as typeof globalThis.fetch;

describe('reconcileOpencodeStatus reads the present', () => {
  it('maps each live session status through the same table the push path uses', async () => {
    const result = await reconcileOpencodeStatus('http://127.0.0.1:4096', {
      fetch: fetchReturning(
        jsonResponse({
          ses_busy: { type: 'busy' },
          ses_idle: { type: 'idle' },
          ses_retry: { type: 'retry', attempt: 2, message: 'overloaded' }
        })
      )
    });

    expect(result.ok).toBe(true);
    expect(result.sessions.get('ses_busy')).toEqual([{ kind: 'activity', activity: 'working' }]);
    expect(result.sessions.get('ses_idle')).toEqual([{ kind: 'activity', activity: 'idle' }]);
    expect(result.sessions.get('ses_retry')).toEqual([
      { kind: 'blocked', wait: { kind: 'retry', owner: 'provider', detail: 'attempt 2 — overloaded' } }
    ]);
  });

  it('tolerates a trailing slash on the server url', async () => {
    let seen = '';
    const fetchImpl = (async (url: string) => {
      seen = url;
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    await reconcileOpencodeStatus('http://127.0.0.1:4096///', { fetch: fetchImpl });
    expect(seen).toBe('http://127.0.0.1:4096/session/status');
  });

  it('contributes nothing for a status shape it does not understand', async () => {
    const result = await reconcileOpencodeStatus('http://x', {
      fetch: fetchReturning(jsonResponse({ ses_1: { type: 'hibernating' }, ses_2: 'not-an-object' }))
    });
    expect(result.ok).toBe(true);
    expect(result.sessions.size).toBe(0);
  });
});

describe('every failure yields no evidence, never a guess', () => {
  it('reports unreachable when the server does not answer', async () => {
    const result = await reconcileOpencodeStatus('http://x', {
      fetch: fetchReturning(() => {
        throw new Error('ECONNREFUSED');
      })
    });
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(result.sessions.size).toBe(0);
  });

  it('refuses to parse a non-2xx body', async () => {
    const result = await reconcileOpencodeStatus('http://x', {
      fetch: fetchReturning(jsonResponse({ ses_1: { type: 'busy' } }, 500))
    });
    // The body would have parsed cleanly — checking status first is what stops
    // an error page from becoming a confident answer.
    expect(result).toMatchObject({ ok: false, reason: 'http-error', status: 500 });
    expect(result.sessions.size).toBe(0);
  });

  it('reports malformed for a body that is not a session map', async () => {
    for (const body of [null, [], 'busy', 42]) {
      const result = await reconcileOpencodeStatus('http://x', { fetch: fetchReturning(jsonResponse(body)) });
      expect(result, JSON.stringify(body)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('reports malformed when the body is not JSON at all', async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token <');
      }
    } as unknown as Response;
    expect(await reconcileOpencodeStatus('http://x', { fetch: fetchReturning(response) })).toMatchObject({
      ok: false,
      reason: 'malformed'
    });
  });

  it('aborts a server slower than the budget instead of hanging the caller', async () => {
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof globalThis.fetch;
    const result = await reconcileOpencodeStatus('http://x', { fetch: fetchImpl, timeoutMs: 10 });
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('the response is bounded before it is trusted', () => {
  it('caps the session map and reports what it dropped', async () => {
    const body: Record<string, unknown> = {};
    for (let i = 0; i < MAX_RECONCILED_SESSIONS + 25; i += 1) {
      body[`ses_${i}`] = { type: 'busy' };
    }
    const result = await reconcileOpencodeStatus('http://x', { fetch: fetchReturning(jsonResponse(body)) });
    expect(result.sessions.size).toBe(MAX_RECONCILED_SESSIONS);
    // Silent truncation would read as "these are all the sessions".
    expect(result.droppedForCap).toBe(25);
  });
});
