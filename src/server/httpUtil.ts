import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(redactStackFields(payload)));
}

function redactStackFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactStackFields(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'stack') {
      continue;
    }
    redacted[key] = redactStackFields(child);
  }
  return redacted;
}

export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
