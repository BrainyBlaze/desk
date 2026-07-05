import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleAgentSessionInjectRequest } from '../src/server/agentSessionsApi.js';

interface ApiResult {
  handled: boolean;
  status: number;
  body: any;
}

async function callAgentSessionInject(
  broker: { injectUserMessage(session: string, text: string, source: 'ui' | 'channel' | 'external'): Promise<void> },
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<ApiResult> {
  const req = Readable.from(body ? [JSON.stringify(body)] : []) as IncomingMessage;
  req.method = method;
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (payload?: unknown) => {
      if (payload !== undefined) {
        chunks.push(String(payload));
      }
    }
  } as unknown as ServerResponse;

  const handled = await handleAgentSessionInjectRequest(req, res, new URL(path, 'http://desk.local'), { broker });
  const raw = chunks.join('');
  return { handled, status: res.statusCode, body: raw ? JSON.parse(raw) : undefined };
}

describe('agent session inject API', () => {
  it('ignores unrelated paths', async () => {
    const result = await callAgentSessionInject({ injectUserMessage: async () => undefined }, 'POST', '/api/other', { text: 'hi' });

    expect(result.handled).toBe(false);
  });

  it('injects external text through the agent surface broker', async () => {
    const calls: Array<{ session: string; text: string; source: string }> = [];
    const result = await callAgentSessionInject(
      {
        injectUserMessage: async (session, text, source) => {
          calls.push({ session, text, source });
        }
      },
      'POST',
      '/api/agent-sessions/tmux-a/inject',
      { text: 'hello native' }
    );

    expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true } });
    expect(calls).toEqual([{ session: 'tmux-a', text: 'hello native', source: 'external' }]);
  });

  it('returns typed retry disposition when broker injection fails', async () => {
    const result = await callAgentSessionInject(
      {
        injectUserMessage: async () => {
          throw Object.assign(new Error('driver mid-turn'), { code: 'send-while-busy', retryable: true });
        }
      },
      'POST',
      '/api/agent-sessions/tmux-a/inject',
      { text: 'hello native' }
    );

    expect(result).toMatchObject({
      handled: true,
      status: 503,
      body: { error: 'driver mid-turn', code: 'send-while-busy', retryable: true }
    });
  });
});
