import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daemonControl, type DaemonControlResult } from '../shared/daemonControlClient.js';
import { moorCommandFor as buildAtchCommand } from '../shared/moorCommand.js';
import { resolveMoorBinPath, resolveMoorSocketRoot } from '../shared/moorPaths.js';
import { readManifestFile, resolveManifestPath } from './config.js';
import { buildSessionSpecs } from './manifest.js';
import { ensureOpencodeConfigDir } from './opencodeConfig.js';
import type { SessionPlanAction, SessionSpec } from './types.js';
import { sessionStateSubjectFor } from '../shared/controlPlane/index.js';
import {
  claudeContinuityDescriptorFor,
  claudeProfileMemoryDescriptorFor
} from '../shared/claudeContinuityDescriptor.js';

export { moorCommandFor } from '../shared/moorCommand.js';

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
  moorBinPath?: string;
  fromUrl?: string;
  cwd?: string;
}

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
  return join(resolveMoorSocketRoot(env), sessionId); // moor rendezvous: no suffix
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
  let moorBin: string;
  try {
    moorBin = options.moorBinPath ?? resolveMoorBinPath(options.fromUrl ?? import.meta.url, env, options.cwd);
  } catch {
    return undefined;
  }
  const spawn = options.spawn ?? spawnSync;
  return (path) => {
    const result = spawn(moorBin, ['push', path], {
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
    return { type: 'start', session };
  });
}

function controlFor(options: RunnerLifecycleOptions): RunnerControl {
  return options.control ?? ((path, payload) => daemonControl(path, payload, { env: options.env }));
}

function directNativeStartError(session: SessionSpec): string | undefined {
  if (session.uiMode !== 'native') {
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
  const continuity = claudeContinuityDescriptorFor(session);
  const claudeMemory = claudeProfileMemoryDescriptorFor(session);
  const result = await controlFor(options)('/control/provision', {
    sessionId: session.sessionId,
    command: buildAtchCommand(session),
    geometry: { rows: 24, cols: 80 },
    subject: sessionStateSubjectFor(session),
    ...(session.resume === undefined
      ? {}
      : { providerSessionId: session.resume }),
    ...(continuity ? { continuity } : {}),
    ...(claudeMemory ? { claudeMemory } : {})
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function runPlan(
  plan: SessionPlanAction[],
  dryRun: boolean,
  options: RunnerLifecycleOptions = {}
): Promise<number> {
  // One unstartable session must not strand the rest of the fleet: a single
  // stale cwd used to abort the whole plan, leaving dozens of healthy
  // sessions down with only the first error reported. Every action is
  // attempted; failures are collected and reported together, and the exit
  // code still fails (never a silent partial success).
  const failures: string[] = [];
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
      failures.push(`${action.session.sessionId}: ${nativeError}`);
      continue;
    }

    const prepared = prepareSessionStart(action.session);
    if (!prepared.ok) {
      console.error(prepared.error);
      failures.push(`${action.session.sessionId}: ${prepared.error}`);
      continue;
    }
    const result = await provisionPreparedSession(action.session, options);
    if (!result.ok) {
      const error = result.error ?? `moor provision failed for ${action.session.sessionId}`;
      console.error(error);
      failures.push(`${action.session.sessionId}: ${error}`);
      continue;
    }
  }
  if (failures.length > 0) {
    console.error(`${failures.length} session(s) could not start:\n  ${failures.join('\n  ')}`);
    return 1;
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
  const result = await provisionPreparedSession(session, options);
  if (!result.ok) {
    return result;
  }
  return { ok: true };
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
  const moorBin = options.moorBinPath ?? resolveMoorBinPath(options.fromUrl ?? import.meta.url, env, options.cwd);
  const observed = await controlFor(options)('/control/tail', {
    sessionId: session.sessionId,
    rows: 1,
    offset: 0
  });
  if (!observed.ok) {
    throw new Error(observed.error ?? `session ${session.sessionId} is not available through the terminal daemon`);
  }
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(moorBin, ['attach', socketPath(session.sessionId, env)], {
    stdio: 'inherit',
    env
  });
  const failure = spawnFailure(result, moorBin);
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
