import type { ProviderSessionProvider } from './providerSessionIdentity.js';

export interface DaemonControlResult {
  ok: boolean;
  error?: string;
  /** Parsed response object for payload-bearing success or semantic rejection. */
  body?: Record<string, unknown>;
  /**
   * The daemon's HTTP status when a response was received at all; absent on
   * transport failure (unreachable/timeout). Lets route wrappers preserve
   * semantic statuses (404 unknown-session) instead of flattening to 500.
   */
  status?: number;
}

export interface DaemonControlOptions {
  /** Explicit HTTP(S) origin, primarily for isolated callers and tests. */
  baseUrl?: string;
  /** Defaults to process.env when deriving the HTTP origin. */
  env?: NodeJS.ProcessEnv;
  /** Hard request deadline. Defaults to ten seconds. */
  timeoutMs?: number;
  /** Injectable transport for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Optional caller lifetime, combined with the hard request deadline. */
  signal?: AbortSignal;
}

export interface CompleteProviderSessionLaunchRequest {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  providerSessionId: string;
  generation: number;
}

/**
 * The exact negative envelope `/control/moor-status` emits when a session has
 * no live adopted moor link.
 *
 * It lives here, next to the client, because it is a two-sided contract: the
 * route emits it and callers read it to tell the authority's own "this session
 * is gone" apart from any other 404 (an old daemon without the route, a proxy,
 * a generic not-found page). Two copies of the literal would drift, and the
 * drift would surface as callers quietly deciding a live session is absent.
 */
export const MOOR_STATUS_NO_LIVE_LINK_ERROR = 'session has no live moor link';
export interface ObserveProviderSessionIdentityRequest {
  deskSessionId: string;
  provider: Exclude<ProviderSessionProvider, 'opencode'>;
  providerSessionId: string;
  generation: number;
  launchProof: string;
  hook: string;
}

export interface RebindProviderSessionRequest {
  sessionId: string;
  targetProviderSessionId: string;
}

/** Derive the daemon's HTTP control origin from its websocket endpoint. */
export function daemonHttpBase(env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(env.DESK_DAEMON_URL ?? 'ws://127.0.0.1:5178');
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported terminal daemon URL protocol: ${url.protocol}`);
  }
  return url.origin;
}

function parseResponseObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** POST one bounded JSON request to the daemon control plane. */
export async function daemonControl(
  path: string,
  payload: unknown,
  options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
  return daemonRequest(path, options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export function requestProviderSessionReset(
  sessionId: string,
  options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
  return daemonControl('/control/provider-session/reset', { sessionId }, options);
}

export function completeProviderSessionLaunch(
  input: CompleteProviderSessionLaunchRequest,
  options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
  return daemonControl('/control/provider-session/complete', input, options);
}

export function observeProviderSessionIdentity(
  input: ObserveProviderSessionIdentityRequest,
  options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
  return daemonControl('/control/provider-session/observe', input, options);
}

export function requestProviderSessionRebind(
  input: RebindProviderSessionRequest,
  options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
  return daemonControl('/control/provider-session/rebind', input, options);
}

/**
 * GET one payload-bearing control resource (the canonical state snapshots).
 *
 * Shares the POST path's response handling rather than repeating it: the rules
 * that matter — a body is trusted only on a 2xx AND `ok:true`, and an
 * unreachable daemon is a transport error rather than an empty success — are
 * the ones a second hand-written copy would eventually get wrong.
 */
export async function daemonControlGet(
  path: string,
  options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
  return daemonRequest(path, options, { method: 'GET' });
}

async function daemonRequest(
  path: string,
  options: DaemonControlOptions,
  init: RequestInit
): Promise<DaemonControlResult> {
  const baseUrl = options.baseUrl ?? daemonHttpBase(options.env);
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
      ...init,
      signal
    });
    const parsed = parseResponseObject(await response.text());
    if (response.ok && parsed?.ok === true) {
      return { ok: true, body: parsed, status: response.status };
    }
    if (parsed !== undefined) {
      const error =
        typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.reason === 'string'
            ? parsed.reason
            : `terminal daemon returned HTTP ${response.status}`;
      return { ok: false, error, status: response.status, body: parsed };
    }
    if (parsed === undefined && response.ok) {
      return {
        ok: false,
        error: `terminal daemon returned an invalid JSON response (HTTP ${response.status})`,
        status: response.status
      };
    }
    return { ok: false, error: `terminal daemon returned HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: `terminal daemon unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** Collapse a payload-bearing control call to the public result contract. */
export async function toOkResult(
  call: Promise<DaemonControlResult>
): Promise<{ ok: boolean; error?: string }> {
  const result = await call;
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
