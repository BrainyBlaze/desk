import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daemonControl, type DaemonControlResult } from '../shared/daemonControlClient.js';
import { atchCommandFor as buildAtchCommand } from '../shared/atchCommand.js';
import { resolveAtchBinPath, resolveAtchSocketRoot } from '../shared/atchPaths.js';
import { readManifestFile, resolveManifestPath } from './config.js';
import { buildSessionSpecs, resolveSessionUiMode } from './manifest.js';
import { ensureOpencodeConfigDir } from './opencodeConfig.js';
import { findOpencodeLaunchResume } from './opencodeResume.js';
import { upsertPendingResumeCapture } from './resumeCaptureState.js';
import type { SessionPlanAction, SessionSpec } from './types.js';
import { shellQuote } from '../shared/shell.js';

export { atchCommandFor } from '../shared/atchCommand.js';

export interface LoadDeskOptions {
  manifestPath?: string;
}

export interface LoadedDesk {
  manifestPath: string;
  sessions: SessionSpec[];
}

export type RunnerControl = (path: string, payload: unknown) => Promise<DaemonControlResult>;

export interface RunnerLifecycleOptions {
  env?: NodeJS.ProcessEnv;
  control?: RunnerControl;
  probeSession?: (socketPath: string) => boolean;
  spawn?: typeof spawnSync;
  atchBinPath?: string;
  fromUrl?: string;
  cwd?: string;
}

const RESUME_CAPTURE_CLOCK_SKEW_MS = 3_000;
const RESUME_CAPTURE_TIMEOUT_MS = 45_000;

export function loadDesk(options: LoadDeskOptions): LoadedDesk {
  const manifestPath = resolveManifestPath(options.manifestPath);
  const manifest = readManifestFile(manifestPath);
  const sessions = buildSessionSpecs(manifest, {
    homeDir: homedir()
  });

  return { manifestPath, sessions };
}

let deskCache: { path: string; mtimeMs: number; loaded: LoadedDesk } | null = null;

/** Manifest-mtime-cached load for hot read paths. */
export function loadDeskCached(options: LoadDeskOptions = {}): LoadedDesk {
  const manifestPath = resolveManifestPath(options.manifestPath);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    // A live load below owns the missing-manifest diagnostic.
  }
  if (deskCache && deskCache.path === manifestPath && deskCache.mtimeMs === mtimeMs) {
    return deskCache.loaded;
  }
  const loaded = loadDesk(options);
  deskCache = { path: manifestPath, mtimeMs, loaded };
  return loaded;
}

function socketPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAtchSocketRoot(env), `${sessionId}.sock`);
}

/** Running sessions keyed only by durable sessionId. */
export function runningSessionSet(
  sessions: readonly SessionSpec[] = loadDeskCached().sessions,
  options: RunnerLifecycleOptions = {}
): Set<string> {
  const probeSession = sessionProbeFor(options);
  const running = new Set<string>();
  if (!probeSession) {
    return running;
  }
  for (const session of sessions) {
    if (probeSession(socketPath(session.sessionId, options.env))) {
      running.add(session.sessionId);
    }
  }
  return running;
}

function sessionProbeFor(options: RunnerLifecycleOptions): ((socketPath: string) => boolean) | undefined {
  if (options.probeSession) {
    return options.probeSession;
  }
  const env = options.env ?? process.env;
  let atchBin: string;
  try {
    atchBin = options.atchBinPath ?? resolveAtchBinPath(options.fromUrl ?? import.meta.url, env, options.cwd);
  } catch {
    return undefined;
  }
  const spawn = options.spawn ?? spawnSync;
  return (path) => {
    const result = spawn(atchBin, ['push', path], {
      env,
      input: '',
      stdio: ['pipe', 'ignore', 'ignore']
    });
    return !result.error && result.status === 0;
  };
}

export function planDeskUp(
  sessions: SessionSpec[],
  options: RunnerLifecycleOptions = {}
): SessionPlanAction[] {
  const existing = runningSessionSet(sessions, options);
  return sessions.map((session) => {
    if (existing.has(session.sessionId)) {
      return { type: 'preserve', session };
    }
    const launch = prepareSessionForLaunchWithMetadata(session);
    return {
      type: 'start',
      session: launch.session,
      opencodeLaunchResumeId: launch.opencodeLaunchResumeId
    };
  });
}

function controlFor(options: RunnerLifecycleOptions): RunnerControl {
  return options.control ?? ((path, payload) => daemonControl(path, payload, { env: options.env }));
}

function directNativeStartError(session: SessionSpec): string | undefined {
  if (resolveSessionUiMode(session) !== 'native') {
    return undefined;
  }
  return (
    `session ${session.sessionId} is native-mode and needs a running desk server; ` +
    'start it through the web control plane after `desk serve`.'
  );
}

async function provisionPreparedSession(
  session: SessionSpec,
  options: RunnerLifecycleOptions
): Promise<{ ok: boolean; error?: string }> {
  const result = await controlFor(options)('/control/provision', {
    sessionId: session.sessionId,
    command: buildAtchCommand(session),
    geometry: { rows: 24, cols: 80 }
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function runPlan(
  plan: SessionPlanAction[],
  dryRun: boolean,
  options: RunnerLifecycleOptions = {}
): Promise<number> {
  for (const action of plan) {
    printPlanAction(action);
    if (dryRun || action.type === 'preserve') {
      continue;
    }

    // The CLI has no agent-host token. Native sessions must be launched by the
    // web control plane, which enriches the static command before provisioning.
    const nativeError = directNativeStartError(action.session);
    if (nativeError) {
      console.error(nativeError);
      return 1;
    }

    const prepared = prepareSessionStart(action.session);
    if (!prepared.ok) {
      console.error(prepared.error);
      return 1;
    }
    const result = await provisionPreparedSession(action.session, options);
    if (!result.ok) {
      console.error(result.error ?? `atch provision failed for ${action.session.sessionId}`);
      return 1;
    }
    const pendingCapture = pendingCaptureForLaunch(action.session, action.opencodeLaunchResumeId);
    if (pendingCapture) {
      upsertPendingResumeCapture(pendingCapture);
    }
  }
  return 0;
}

export async function startSession(
  session: SessionSpec,
  options: RunnerLifecycleOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  if (runningSessionSet([session], options).has(session.sessionId)) {
    return { ok: true };
  }
  const nativeError = directNativeStartError(session);
  if (nativeError) {
    return { ok: false, error: nativeError };
  }
  const preparedStart = prepareSessionStart(session);
  if (!preparedStart.ok) {
    return preparedStart;
  }
  const launch = prepareSessionForLaunchWithMetadata(session);
  const result = await provisionPreparedSession(launch.session, options);
  if (!result.ok) {
    return result;
  }
  const pendingCapture = pendingCaptureForLaunch(launch.session, launch.opencodeLaunchResumeId);
  if (pendingCapture) {
    upsertPendingResumeCapture(pendingCapture);
  }
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
  if (session.customCommand || session.agent !== 'opencode' || session.resume) {
    return { session };
  }
  // Native mode persists explicit resume ids through the agent surface. The
  // terminal heuristic would risk resurrecting an unrelated deleted session.
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
      error: `failed to prepare opencode config for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function pendingCaptureForLaunch(session: SessionSpec, launchResumeId?: string) {
  if (session.customCommand || session.agent !== 'opencode' || session.resume) {
    return null;
  }
  const now = Date.now();
  return {
    sessionId: session.sessionId,
    agent: 'opencode' as const,
    cwd: session.cwd,
    sinceMs: now - RESUME_CAPTURE_CLOCK_SKEW_MS,
    deadlineMs: now + RESUME_CAPTURE_TIMEOUT_MS,
    launchResumeId
  };
}

export async function killSession(
  sessionId: string,
  options: RunnerLifecycleOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  const result = await controlFor(options)('/control/retire', { sessionId });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function restartSession(
  session: SessionSpec,
  options: RunnerLifecycleOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  const nativeError = directNativeStartError(session);
  if (nativeError) {
    return { ok: false, error: nativeError };
  }
  const retired = await killSession(session.sessionId, options);
  if (!retired.ok) {
    return retired;
  }
  return startSession(session, options);
}

export async function captureSession(
  session: SessionSpec,
  lines: number,
  options: RunnerLifecycleOptions = {}
): Promise<number> {
  const result = await controlFor(options)('/control/tail', {
    sessionId: session.sessionId,
    rows: lines,
    offset: 0
  });
  if (!result.ok) {
    process.stderr.write(`${result.error ?? `capture failed for ${session.sessionId}`}\n`);
    return 1;
  }
  const output = result.body?.lines;
  if (!Array.isArray(output) || !output.every((line) => typeof line === 'string')) {
    process.stderr.write(`terminal daemon returned invalid capture data for ${session.sessionId}\n`);
    return 1;
  }
  if (output.length > 0) {
    process.stdout.write(`${output.join('\n')}\n`);
  }
  return 0;
}

function spawnFailure(result: Pick<SpawnSyncReturns<Buffer>, 'error'>, executable: string): string | undefined {
  if (!result.error) {
    return undefined;
  }
  const code = (result.error as NodeJS.ErrnoException).code;
  return code === 'ENOENT'
    ? `${executable} not found or no longer executable`
    : `${executable} could not run: ${result.error.message}`;
}

export async function attachSession(
  session: SessionSpec,
  options: RunnerLifecycleOptions = {}
): Promise<number> {
  const env = options.env ?? process.env;
  const atchBin = options.atchBinPath ?? resolveAtchBinPath(options.fromUrl ?? import.meta.url, env, options.cwd);
  const observed = await controlFor(options)('/control/tail', {
    sessionId: session.sessionId,
    rows: 1,
    offset: 0
  });
  if (!observed.ok) {
    throw new Error(observed.error ?? `session ${session.sessionId} is not available through the terminal daemon`);
  }
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(atchBin, ['attach', socketPath(session.sessionId, env)], {
    stdio: 'inherit',
    env
  });
  const failure = spawnFailure(result, atchBin);
  if (failure) {
    throw new Error(failure);
  }
  return result.status ?? 1;
}

export function findSession(sessions: SessionSpec[], query: string): SessionSpec {
  const matches = sessions.filter(
    (session) =>
      session.name === query ||
      session.sessionId === query ||
      session.resume === query ||
      session.sessionId.includes(query)
  );

  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length === 0) {
    throw new Error(`no session matches ${query}`);
  }
  throw new Error(`multiple sessions match ${query}: ${matches.map((session) => session.name).join(', ')}`);
}

export function printStatus(
  sessions: SessionSpec[],
  options: RunnerLifecycleOptions = {}
): void {
  const existing = runningSessionSet(sessions, options);
  for (const session of sessions) {
    const state = existing.has(session.sessionId) ? 'running' : 'missing';
    console.log(`${state.padEnd(8)} ${session.groupId.padEnd(8)} ${session.name.padEnd(18)} ${session.sessionId}`);
  }
}

function printPlanAction(action: SessionPlanAction): void {
  if (action.type === 'preserve') {
    console.log(`preserve ${action.session.sessionId}`);
    return;
  }
  console.log(`start    ${action.session.sessionId}`);
  console.log(`         cwd: ${action.session.cwd}`);
  console.log(`         cmd: ${action.session.command}`);
}
