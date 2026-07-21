// Native (atch) session control for the web server (cutover spawn/boot/restart).
//
// The three-tier split means the web process never spawns atch itself — the
// separate daemon process owns the @xterm/headless screen authority. So when
// DESK_ATCH_NATIVE=1, session start/restart provisions via the daemon's HTTP
// control plane (createDaemonControlHandler) instead of `tmux new-session`.
// Every path returns a concrete {ok,error}; a daemon that is down or refuses a
// spawn surfaces as a non-ok result the route turns into a non-2xx JSON error,
// never a silent no-op.

import { loadDeskCached, restartSession, runningSessionSet, startSession } from '../../core/runner.js';
import type { SessionSpec } from '../../core/types.js';
import { shellQuote } from '../../shared/shell.js';

export function nativeSessionsEnabled(): boolean {
  return process.env.DESK_ATCH_NATIVE === '1';
}

/** The daemon control-plane base (HTTP), derived from the WS DESK_DAEMON_URL. */
export function daemonHttpBase(): string {
  const raw = process.env.DESK_DAEMON_URL ?? 'ws://127.0.0.1:5178';
  return raw.replace(/^ws(s?):\/\//, 'http$1://');
}

/**
 * The atch child command for a session: run the session's command in its cwd,
 * exactly as `tmux new-session -c cwd command` would. A command-less session
 * falls back to the login shell. Matches the proven canary form `sh -c bash`.
 * The cwd is escaped through the single audited quoter (R6.1); the command is
 * the session's own shell command, run as-is exactly as the tmux path does.
 */
export function atchCommandFor(spec: SessionSpec): string[] {
  const command = (spec.command ?? '').trim();
  const cd = spec.cwd ? `cd ${shellQuote(spec.cwd)} || exit 1\n` : '';
  const run = command.length > 0 ? command : '"${SHELL:-bash}"';
  return ['sh', '-c', `${cd}${run}`];
}

interface DaemonControlResult {
  ok: boolean;
  error?: string;
  /** The daemon's parsed JSON response (present on ok for payload-bearing calls). */
  body?: Record<string, unknown>;
}

async function daemonControl(path: string, payload: unknown): Promise<DaemonControlResult> {
  const url = `${daemonHttpBase()}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // non-JSON body; fall through to the HTTP-status verdict below
    }
    if (res.ok && parsed.ok !== false) {
      return { ok: true, body: parsed };
    }
    return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : `terminal daemon returned HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: `terminal daemon unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Collapse a control call to its public {ok, error?} contract (no body leak). */
async function toOkResult(call: Promise<DaemonControlResult>): Promise<{ ok: boolean; error?: string }> {
  const result = await call;
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Provision (spawn + attach) a session's atch master via the daemon. */
export function provisionNativeSession(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> {
  const sessionId = spec.sessionId ?? spec.tmuxSession;
  return toOkResult(
    daemonControl('/control/provision', {
      sessionId,
      command: atchCommandFor(spec),
      geometry: { rows: 24, cols: 80 }
    })
  );
}

/** Retire a session's atch master via the daemon (KILL contract). */
export function retireNativeSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return toOkResult(daemonControl('/control/retire', { sessionId }));
}

/**
 * The native identity a session edit leaves behind, or undefined if unchanged.
 *
 * A session's atch master is keyed by `sessionId ?? tmuxSession`. A persisted
 * sessionId survives renames, so only a LEGACY entry lacking one (whose id is
 * minted from the name) can change identity on rename — leaving the running
 * master keyed by the old id. The edit path retires the returned id so that
 * master does not orphan (nothing references it again). Returns undefined when
 * nothing changed or either spec is missing.
 */
export function staleNativeIdentityAfterEdit(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): string | undefined {
  if (!oldSpec || !newSpec) {
    return undefined;
  }
  const oldId = oldSpec.sessionId ?? oldSpec.tmuxSession;
  const newId = newSpec.sessionId ?? newSpec.tmuxSession;
  return oldId !== newId ? oldId : undefined;
}

/**
 * Fail-closed guard for an identity-changing native edit (a legacy entry whose
 * name-minted id changes on rename; a persisted sessionId never does): retire
 * the pre-edit identity BEFORE the manifest rename commits. Returns `ok: false`
 * (the caller MUST abort the edit, leaving the manifest untouched and
 * provisioning nothing) when the retire fails — so a rename can never orphan
 * the old atch master nor desync the manifest against a still-running master.
 * A no-op (ok) when the flag is off or the identity is unchanged. (R2.1.)
 */
export async function retireStaleIdentityForEdit(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!nativeSessionsEnabled()) {
    return { ok: true };
  }
  const stale = staleNativeIdentityAfterEdit(oldSpec, newSpec);
  if (stale === undefined) {
    return { ok: true };
  }
  const retired = await retireNativeSession(stale);
  if (retired.ok) {
    return { ok: true };
  }
  return { ok: false, error: `could not retire old identity ${stale}: ${retired.error}` };
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

/** The daemon key for a session the channels engine names by tmuxSession. */
function nativeIdForTmuxSession(tmuxSession: string): string {
  const spec = loadDeskCached({}).sessions.find((candidate) => candidate.tmuxSession === tmuxSession);
  return spec?.sessionId ?? tmuxSession;
}

/**
 * The channels-delivery transport for atch-native terminal sessions: the four
 * engine deps that default to tmux (paste/has-session/capture-pane/send-keys),
 * reimplemented over the daemon control plane. The engine keeps keying by
 * tmuxSession; the sessionId mapping happens here at the boundary — same
 * derivation as provisioning and the running-set, so the three stay coherent.
 * The uiMode=native broker path is unaffected (it never used tmux).
 */
export interface NativeChannelsTransport {
  /** Paste text then a delayed Enter — mirrors sendTextToTmux semantics. */
  sendText: (tmuxSession: string, text: string) => Promise<boolean>;
  /** Running iff the session's atch master socket exists. */
  sessionRunning: (tmuxSession: string) => boolean;
  /** The emulator's on-screen tail (plain text), null when unobservable. */
  capturePane: (tmuxSession: string) => Promise<string | null>;
  /** Bare Enter (the submit-verification retry). */
  sendEnter: (tmuxSession: string) => Promise<boolean>;
}

export function createNativeChannelsTransport(
  options: { enterDelayMs?: number; wait?: (ms: number) => Promise<void> } = {}
): NativeChannelsTransport {
  const enterDelayMs = options.enterDelayMs ?? 1200;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async sendText(tmuxSession, text) {
      const sessionId = nativeIdForTmuxSession(tmuxSession);
      // paste:true mirrors tmux `paste-buffer -p` — the daemon wraps in
      // bracketed-paste codes only when the app enabled the mode.
      const delivered = await daemonControl('/control/input', { sessionId, text, paste: true });
      if (!delivered.ok) {
        return false;
      }
      await wait(enterDelayMs);
      return (await daemonControl('/control/input', { sessionId, text: '\r' })).ok;
    },
    sessionRunning(tmuxSession) {
      // runningSessionSet is already flag-aware (atch socket probe) and cached.
      return runningSessionSet().has(tmuxSession);
    },
    async capturePane(tmuxSession) {
      const result = await daemonControl('/control/tail', { sessionId: nativeIdForTmuxSession(tmuxSession), rows: 200 });
      const lines = result.ok ? result.body?.lines : undefined;
      return Array.isArray(lines) && lines.every((line) => typeof line === 'string') ? lines.join('\n') : null;
    },
    async sendEnter(tmuxSession) {
      return (await daemonControl('/control/input', { sessionId: nativeIdForTmuxSession(tmuxSession), text: '\r' })).ok;
    }
  };
}
