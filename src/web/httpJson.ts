// Shared browser->desk-server JSON response reader.
//
// Reads the body as text FIRST, then parses defensively, and only then branches
// on response.ok. This avoids the historical bug where `await response.json()`
// ran before the status check, so a non-JSON error body (a proxy 502 HTML page,
// an empty 204/500) threw a cryptic SyntaxError and discarded the real HTTP
// status. An optional `mapError` lets a caller throw a domain-specific error
// (e.g. a missing-scope error) for particular not-ok payloads.

export interface HttpErrorInfo {
  status: number;
  body: Record<string, unknown> | undefined;
}

export async function readJson<T>(
  request: Promise<Response>,
  mapError?: (info: HttpErrorInfo) => Error | undefined
): Promise<T> {
  const response = await request;
  const text = await response.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  if (!response.ok) {
    const mapped = mapError?.({ status: response.status, body: record });
    if (mapped) {
      throw mapped;
    }
    const message =
      record && typeof record.error === 'string' && record.error
        ? record.error
        : `request failed (${response.status})`;
    throw new Error(message);
  }
  return (parsed ?? {}) as T;
}
