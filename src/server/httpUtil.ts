import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ReadJsonBodyOptions {
  maxBytes?: number;
}

export interface HttpBodyError extends Error {
  code: 'body-too-large' | 'invalid-json' | 'body-read-failed';
  statusCode: number;
}

const DEFAULT_JSON_BODY_MAX_BYTES = 1_048_576;

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
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
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

export function readJsonBody(req: IncomingMessage, options: ReadJsonBodyOptions = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
    const contentLength = readContentLength(req.headers?.['content-length']);
    if (contentLength !== undefined && contentLength > maxBytes) {
      reject(bodyTooLargeError());
      req.resume();
      return;
    }
    let body = '';
    let bytes = 0;
    let settled = false;
    const fail = (error: HttpBodyError): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        fail(bodyTooLargeError());
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(bodyError('Invalid JSON body', 'invalid-json', 400));
      }
    });
    req.on('error', () => fail(bodyError('Request body read failed', 'body-read-failed', 400)));
  });
}

function readContentLength(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function bodyTooLargeError(): HttpBodyError {
  return bodyError('Request body too large', 'body-too-large', 413);
}

function bodyError(message: string, code: HttpBodyError['code'], statusCode: number): HttpBodyError {
  const error = new Error(message) as HttpBodyError;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
