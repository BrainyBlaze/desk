import { spawnSync } from 'node:child_process';
import { shellQuote } from '../shared/shell.js';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { readManifestFile, resolveManifestPath } from './config.js';
import { buildSessionSpecs } from './manifest.js';
import { createCaptureArgv, createKillSessionArgv, createStartSessionArgv } from './tmux.js';
import { resolveSessionUiMode } from './manifest.js';
import type { SessionSpec, TmuxPlanAction } from './types.js';

/**
 * Human-readable message when a `spawnSync('tmux', …)` never actually ran the
 * process (produced no exit status) — most commonly tmux missing from PATH,
 * which yields `{ status: null, error: ENOENT, stdout/stderr: undefined }`.
 * Returns undefined when tmux ran. Callers must check this BEFORE touching
 * `result.stderr` (undefined on this path → `.trim()` throws) and must not treat
 * `status ?? 0` as success. Returned message tells the user tmux is missing
 * instead of failing silently or with a cryptic TypeError.
 */
function tmuxSpawnError(result: { error?: Error }): string | undefined {
  if (!result.error) {
    return undefined;
  }
  const code = (result.error as NodeJS.ErrnoException).code;
  return code === 'ENOENT'
    ? 'tmux not found — is it installed and on your PATH?'
    : `tmux could not run: ${result.error.message}`;
}
import { ensureOpencodeConfigDir } from './opencodeConfig.js';
import { findOpencodeLaunchResume } from './opencodeResume.js';
import { upsertPendingResumeCapture } from './resumeCaptureState.js';

export interface LoadDeskOptions {
  manifestPath?: string;
  namespace?: string;
}

export interface LoadedDesk {
  manifestPath: string;
  sessions: SessionSpec[];
}

const RESUME_CAPTURE_CLOCK_SKEW_MS = 3_000;
const RESUME_CAPTURE_TIMEOUT_MS = 45_000;

export function loadDesk(options: LoadDeskOptions): LoadedDesk {
  const manifestPath = resolveManifestPath(options.manifestPath);
  const manifest = readManifestFile(manifestPath);
  const sessions = buildSessionSpecs(manifest, {
    homeDir: homedir(),
    namespace: options.namespace
  });

  return { manifestPath, sessions };
}

let deskCache: { path: string; mtimeMs: number; loaded: LoadedDesk } | null = null;

/**
 * Manifest-mtime-cached loadDesk for hot paths (every websocket connect parsed
 * + rebuilt the whole manifest). Namespaced loads bypass the cache — they are
 * rare and the cache holds a single default-namespace entry. The fs watcher and
 * the settings POST both rewrite the manifest, bumping its mtime, so the cache
 * self-invalidates on any real change.
 */
export function loadDeskCached(options: LoadDeskOptions = {}): LoadedDesk {
  if (options.namespace) {
    return loadDesk(options);
  }
  const manifestPath = resolveManifestPath(options.manifestPath);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    // missing manifest: fall through to a live load (which handles absence)
  }
  if (deskCache && deskCache.path === manifestPath && deskCache.mtimeMs === mtimeMs) {
    return deskCache.loaded;
  }
  const loaded = loadDesk(options);
  deskCache = { path: manifestPath, mtimeMs, loaded };
  return loaded;
}

export function listTmuxSessions(): Set<string> {
  const result = spawnSync('tmux', ['list-sessions', '-F', '#S'], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

let tmuxSessionsCache: { at: number; sessions: Set<string> } | null = null;
const TMUX_SESSIONS_TTL_MS = 1000;

/**
 * Short-TTL cache over `listTmuxSessions` for read-only hot paths (the 2s pulse
 * and the per-websocket-connect liveness gate). A killed/booted session reflects
 * within one TTL, except boot/kill explicitly invalidate so an intentional
 * mutation shows immediately. Correctness-critical callers (planDeskUp,
 * start/kill) keep the uncached list.
 */
export function listTmuxSessionsCached(now = Date.now()): Set<string> {
  if (tmuxSessionsCache && now - tmuxSessionsCache.at < TMUX_SESSIONS_TTL_MS) {
    return tmuxSessionsCache.sessions;
  }
  const sessions = listTmuxSessions();
  tmuxSessionsCache = { at: now, sessions };
  return sessions;
}

export function invalidateTmuxSessionsCache(): void {
  tmuxSessionsCache = null;
}

export function planDeskUp(sessions: SessionSpec[]): TmuxPlanAction[] {
  const existingSessions = listTmuxSessions();
  return sessions.map((session) => {
    if (existingSessions.has(session.tmuxSession)) {
      return {
        type: 'preserve',
        session,
        argv: []
      };
    }
    const launch = prepareSessionForLaunchWithMetadata(session);
    return {
      type: 'start',
      session: launch.session,
      argv: createStartSessionArgv(launch.session),
      opencodeLaunchResumeId: launch.opencodeLaunchResumeId
    };
  });
}

export function runPlan(plan: TmuxPlanAction[], dryRun: boolean): number {
  for (const action of plan) {
    printPlanAction(action);
    if (dryRun || action.type === 'preserve') {
      continue;
    }

    // Native-mode sessions run `exec desk agent-host`, which needs env the
    // running desk server injects at spawn (DESK_SERVER_URL, host token). The
    // bare CLI can't provide it, so the pane would exec, throw, and exit at once
    // — which used to leave `desk up` printing "start" and exiting 0 while the
    // session was already gone. Refuse up front with a clear pointer instead of
    // booting into silent death. (Terminal/bash/command sessions are fine.)
    if (resolveSessionUiMode(action.session) === 'native') {
      console.error(
        `session ${action.session.tmuxSession} is native-mode and needs a running desk server; ` +
          'start it with `desk serve` instead of `desk up`.'
      );
      return 1;
    }

    const prepared = prepareSessionStart(action.session);
    if (!prepared.ok) {
      console.error(prepared.error);
      return 1;
    }
    const pendingCapture = pendingCaptureForLaunch(action.session, action.opencodeLaunchResumeId);
    const result = spawnSync('tmux', action.argv, {
      stdio: 'inherit'
    });
    const spawnErr = tmuxSpawnError(result);
    if (spawnErr) {
      console.error(spawnErr);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
    if (pendingCapture) {
      upsertPendingResumeCapture(pendingCapture);
    }
  }

  return 0;
}

export function startSession(session: SessionSpec): { ok: boolean; error?: string } {
  if (listTmuxSessions().has(session.tmuxSession)) {
    return { ok: true };
  }
  const preparedStart = prepareSessionStart(session);
  if (!preparedStart.ok) {
    return preparedStart;
  }
  const launch = prepareSessionForLaunchWithMetadata(session);
  const pendingCapture = pendingCaptureForLaunch(launch.session, launch.opencodeLaunchResumeId);
  const result = spawnSync('tmux', createStartSessionArgv(launch.session), { encoding: 'utf8' });
  const spawnErr = tmuxSpawnError(result);
  if (spawnErr) {
    return { ok: false, error: spawnErr };
  }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? '').trim() || `tmux start failed for ${session.tmuxSession}` };
  }
  if (!listTmuxSessions().has(session.tmuxSession)) {
    return { ok: false, error: `tmux session exited during startup for ${session.tmuxSession}` };
  }
  applyTmuxSessionSettings(session.tmuxSession);
  if (pendingCapture) {
    upsertPendingResumeCapture(pendingCapture);
  }
  invalidateTmuxSessionsCache(); // a freshly booted session must show this tick
  return { ok: true };
}

export interface PrepareSessionForLaunchOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: number;
}

export function prepareSessionForLaunch(
  session: SessionSpec,
  options: PrepareSessionForLaunchOptions = {}
): SessionSpec {
  return prepareSessionForLaunchWithMetadata(session, options).session;
}

export interface PreparedSessionForLaunch {
  session: SessionSpec;
  opencodeLaunchResumeId?: string;
}

export function prepareSessionForLaunchWithMetadata(
  session: SessionSpec,
  options: PrepareSessionForLaunchOptions = {}
): PreparedSessionForLaunch {
  if (session.agent !== 'opencode' || session.resume) {
    return { session };
  }
  // BUG-7 fix: skip the auto-resume heuristic for native-mode sessions. Native mode
  // has explicit resume-id capture via session-info → persistSessionResume (broker
  // harvests the id and writes it to the manifest). The heuristic is redundant for
  // native mode and DANGEROUS on delete+recreate: a stale opencode session in the same
  // cwd gets silently resumed, leaking the deleted conversation into the new agent.
  // Terminal mode keeps the heuristic (it's the existing "restart picks up where you
  // left off" UX).
  if (session.uiMode === 'native') {
    return { session };
  }
  const resume = findOpencodeLaunchResume({
    cwd: session.cwd,
    env: options.env,
    homeDir: options.homeDir,
    nowMs: options.nowMs
  });
  if (!resume) {
    return { session };
  }
  return {
    session: {
      ...session,
      command: `DESK_OPENCODE_RESUME_ID=${shellQuote(resume)}; export DESK_OPENCODE_RESUME_ID; ${session.command}`
    },
    opencodeLaunchResumeId: resume
  };
}

function prepareSessionStart(session: SessionSpec): { ok: true } | { ok: false; error: string } {
  if (session.agent !== 'opencode') {
    return { ok: true };
  }
  try {
    ensureOpencodeConfigDir(process.env.DESK_OPENCODE_CONFIG_DIR || undefined);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `failed to prepare opencode config for ${session.tmuxSession}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function pendingCaptureForLaunch(session: SessionSpec, launchResumeId?: string) {
  if (session.agent !== 'opencode' || session.resume) {
    return null;
  }
  const now = Date.now();
  return {
    tmuxSession: session.tmuxSession,
    agent: 'opencode' as const,
    cwd: session.cwd,
    sinceMs: now - RESUME_CAPTURE_CLOCK_SKEW_MS,
    deadlineMs: now + RESUME_CAPTURE_TIMEOUT_MS,
    launchResumeId
  };
}

/**
 * Per-session tmux options from manifest settings, applied at launch. With
 * `settings.tmux.statusLine: off` the desk-owned session drops tmux's status
 * line — every cell already names its session in the tab and the topbar has
 * the clock, so the green bar is duplicated chrome costing one terminal row
 * per cell. Default keeps tmux's own default (status on) for people who also
 * `tmux attach` from a real terminal.
 */
function applyTmuxSessionSettings(tmuxSession: string): void {
  try {
    const statusLine = readManifestFile(resolveManifestPath()).settings?.tmux?.statusLine;
    // YAML parses a bare `off` as boolean false — accept both spellings.
    if (statusLine === 'off' || statusLine === false) {
      spawnSync('tmux', ['set-option', '-t', tmuxSession, 'status', 'off'], { encoding: 'utf8' });
    }
  } catch {
    // launch must not fail over a cosmetic option
  }
}

export function killSession(tmuxSession: string): { ok: boolean; error?: string } {
  if (!listTmuxSessions().has(tmuxSession)) {
    return { ok: true };
  }
  const result = spawnSync('tmux', createKillSessionArgv(tmuxSession), { encoding: 'utf8' });
  const spawnErr = tmuxSpawnError(result);
  if (spawnErr) {
    return { ok: false, error: spawnErr };
  }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? '').trim() || `tmux kill failed for ${tmuxSession}` };
  }
  invalidateTmuxSessionsCache(); // a killed session must flip to MISSING this tick
  return { ok: true };
}

export function restartSession(session: SessionSpec): { ok: boolean; error?: string } {
  const killed = killSession(session.tmuxSession);
  if (!killed.ok) {
    return killed;
  }
  return startSession(session);
}

export function captureSession(session: SessionSpec, lines: number): number {
  const result = spawnSync('tmux', createCaptureArgv(session.tmuxSession, lines), {
    encoding: 'utf8'
  });

  const spawnErr = tmuxSpawnError(result);
  if (spawnErr) {
    process.stderr.write(`${spawnErr}\n`);
    return 1; // never report success (exit 0) when tmux never ran
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.status ?? 1;
}

export function findSession(sessions: SessionSpec[], query: string): SessionSpec {
  const matches = sessions.filter(
    (session) =>
      session.name === query ||
      session.tmuxSession === query ||
      session.resume === query ||
      session.tmuxSession.includes(query)
  );

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new Error(`no session matches ${query}`);
  }
  throw new Error(`multiple sessions match ${query}: ${matches.map((session) => session.name).join(', ')}`);
}

export function printStatus(sessions: SessionSpec[]): void {
  const existing = listTmuxSessions();
  for (const session of sessions) {
    const state = existing.has(session.tmuxSession) ? 'running' : 'missing';
    console.log(`${state.padEnd(8)} ${session.groupId.padEnd(8)} ${session.name.padEnd(18)} ${session.tmuxSession}`);
  }
}

function printPlanAction(action: TmuxPlanAction): void {
  if (action.type === 'preserve') {
    console.log(`preserve ${action.session.tmuxSession}`);
    return;
  }

  console.log(`start    ${action.session.tmuxSession}`);
  console.log(`         cwd: ${action.session.cwd}`);
  console.log(`         cmd: ${action.session.command}`);
}

// shellQuote now lives in ../shared/shell.ts (single audited copy).
