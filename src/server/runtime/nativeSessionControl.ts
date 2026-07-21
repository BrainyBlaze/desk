// Native (atch) session control for the web server (cutover spawn/boot/restart).
//
// The three-tier split means the web process never spawns atch itself — the
// separate daemon process owns the @xterm/headless screen authority. So when
// DESK_ATCH_NATIVE=1, session start/restart provisions via the daemon's HTTP
// control plane (createDaemonControlHandler) instead of `tmux new-session`.
// Every path returns a concrete {ok,error}; a daemon that is down or refuses a
// spawn surfaces as a non-ok result the route turns into a non-2xx JSON error,
// never a silent no-op.

import { restartSession, startSession } from '../../core/runner.js';
import type { SessionSpec } from '../../core/types.js';

export function nativeSessionsEnabled(): boolean {
  return process.env.DESK_ATCH_NATIVE === '1';
}

/** The daemon control-plane base (HTTP), derived from the WS DESK_DAEMON_URL. */
export function daemonHttpBase(): string {
  const raw = process.env.DESK_DAEMON_URL ?? 'ws://127.0.0.1:5178';
  return raw.replace(/^ws(s?):\/\//, 'http$1://');
}

/** Single-quote a value for safe interpolation into an `sh -c` script. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The atch child command for a session: run the session's command in its cwd,
 * exactly as `tmux new-session -c cwd command` would. A command-less session
 * falls back to the login shell. Matches the proven canary form `sh -c bash`.
 */
export function atchCommandFor(spec: SessionSpec): string[] {
  const command = (spec.command ?? '').trim();
  const cd = spec.cwd ? `cd ${shSingleQuote(spec.cwd)} || exit 1\n` : '';
  const run = command.length > 0 ? command : '"${SHELL:-bash}"';
  return ['sh', '-c', `${cd}${run}`];
}

async function daemonControl(path: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const url = `${daemonHttpBase()}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
    const text = await res.text();
    let parsed: { ok?: boolean; error?: string } = {};
    try {
      parsed = text ? (JSON.parse(text) as { ok?: boolean; error?: string }) : {};
    } catch {
      // non-JSON body; fall through to the HTTP-status verdict below
    }
    if (res.ok && parsed.ok !== false) {
      return { ok: true };
    }
    return { ok: false, error: parsed.error ?? `terminal daemon returned HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: `terminal daemon unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Provision (spawn + attach) a session's atch master via the daemon. */
export function provisionNativeSession(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> {
  const sessionId = spec.sessionId ?? spec.tmuxSession;
  return daemonControl('/control/provision', {
    sessionId,
    command: atchCommandFor(spec),
    geometry: { rows: 24, cols: 80 }
  });
}

/** Retire a session's atch master via the daemon (KILL contract). */
export function retireNativeSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return daemonControl('/control/retire', { sessionId });
}

/** Start a session: daemon-provisioned under the flag, else legacy tmux. */
export function startSessionNativeAware(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string } {
  return nativeSessionsEnabled() ? provisionNativeSession(spec) : startSession(spec);
}

/** Restart a session: daemon retire+provision under the flag, else legacy tmux. */
export async function restartSessionNativeAware(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> {
  if (!nativeSessionsEnabled()) {
    return restartSession(spec);
  }
  const sessionId = spec.sessionId ?? spec.tmuxSession;
  const retired = await retireNativeSession(sessionId);
  if (!retired.ok) {
    return retired;
  }
  return provisionNativeSession(spec);
}
