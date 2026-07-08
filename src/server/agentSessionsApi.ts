import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentUiErrorCode } from '../core/agentSurfaceProtocol.js';
import { readJsonBody, sendJson } from './httpUtil.js';

interface AgentSessionInjector {
  injectUserMessage(session: string, text: string, source: 'ui' | 'channel' | 'external'): Promise<void>;
}

export async function handleAgentSessionInjectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: { broker: AgentSessionInjector }
): Promise<boolean> {
  const match = /^\/api\/agent-sessions\/([^/]+)\/inject$/.exec(url.pathname);
  if (!match) {
    return false;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const body = await readJsonBody(req);
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    sendJson(res, 400, { error: 'text is required', code: 'invalid-frame' });
    return true;
  }
  const source = parseSource(body.source);
  if (!source) {
    sendJson(res, 400, { error: 'source must be ui, channel, or external', code: 'invalid-frame' });
    return true;
  }
  try {
    await options.broker.injectUserMessage(decodeURIComponent(match[1]), body.text, source);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    const failure = typedInjectFailure(error);
    sendJson(res, statusForCode(failure.code), {
      error: failure.message,
      code: failure.code,
      retryable: failure.retryable
    });
  }
  return true;
}

function parseSource(value: unknown): 'ui' | 'channel' | 'external' | null {
  if (value === undefined) {
    return 'external';
  }
  return value === 'ui' || value === 'channel' || value === 'external' ? value : null;
}

function typedInjectFailure(error: unknown): { code: AgentUiErrorCode; message: string; retryable: boolean } {
  if (error instanceof Error) {
    const record = error as { code?: unknown; retryable?: unknown };
    return {
      code: typeof record.code === 'string' ? (record.code as AgentUiErrorCode) : 'adapter-unavailable',
      message: error.message,
      retryable: typeof record.retryable === 'boolean' ? record.retryable : true
    };
  }
  return { code: 'adapter-unavailable', message: String(error), retryable: true };
}

function statusForCode(code: AgentUiErrorCode): number {
  if (code === 'not-native-session') {
    return 404;
  }
  if (code === 'invalid-frame') {
    return 400;
  }
  return 503;
}
