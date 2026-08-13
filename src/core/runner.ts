import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  daemonControl,
  daemonControlGet,
  MOOR_STATUS_NO_LIVE_LINK_ERROR,
  type DaemonControlResult
} from '../shared/daemonControlClient.js';
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
  /** Injectable transport for the authoritative status query; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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

/**
 * The one liveness verdict Desk is allowed to hold (moor#8 criterion 1).
 *
 * Three states, because the honest answer really has three values and
 * collapsing the third is what broke desk#50:
 *   `verified-live`  — the authority says a holder is running;
 *   `stale`          — the authority says no live holder exists;
 *   `indeterminate`  — nobody authoritative answered. NOT dead, NOT alive.
 */
export type SessionLiveness = 'verified-live' | 'stale' | 'indeterminate';

/**
 * Liveness from the daemon's authoritative §10 status, and from nothing else.
 *
 * Desk used to answer this by running `moor push <socket>` with empty stdin and
 * reading the outcome. That was a heuristic in both of its lives: first by exit
 * code (which reported every daemon-adopted — i.e. every normally working —
 * session as missing, desk#50), then by parsing moor's human-readable refusal
 * strings, which merely moved the guess from the exit status into the wording
 * of a CLI message. The daemon already publishes the real thing at
 * `/control/moor-status`: the adopted ATTACH_ACK descriptor, generation-fenced,
 * with the holder's own `running` flag. That is the authority; ask it.
 *
 * When no authority answers, the result is `indeterminate` — never a verdict.
 * Reintroducing a socket-level probe as a "fallback" would reintroduce exactly
 * the heuristic this replaces, and it would do so precisely in the situation
 * where nothing can be checked against the authority. A `desk status` run with
 * no daemon therefore prints `unknown`, which is true, instead of `missing`,
 * which was the bug.
 *
 * "Answered" means the route's own envelope, not merely an HTTP status. `stale`
 * authorises a start, so it is claimed only against proof: a descriptor this
 * function has validated field by field, or the route's own explicit negative.
 * A 200 with an unreadable body and a bare 404 are both `indeterminate` — see
 * `adoptedMoorDescriptor` and `provesNoLiveMoorLink` for why each is not proof.
 */
export async function sessionLivenessFor(
  sessionId: string,
  options: RunnerLifecycleOptions = {}
): Promise<SessionLiveness> {
  const result = await daemonControlGet(
    `/control/moor-status?sessionId=${encodeURIComponent(sessionId)}`,
    {
      env: options.env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    }
  );
  const descriptor = adoptedMoorDescriptor(result);
  if (descriptor !== undefined) {
    // A live adopted link exists; the holder's own flag decides.
    return descriptor.running ? 'verified-live' : 'stale';
  }
  if (provesNoLiveMoorLink(result)) {
    // The authority's negative verdict: no live moor link for this session.
    return 'stale';
  }
  // Unreachable daemon (no status at all), a 200 whose body is not a descriptor
  // this route could have produced, a 2xx that is not this route's 200, a bare
  // 404 from something that never spoke about moor links, or a daemon that
  // answered about something other than this session's liveness (400/5xx).
  // Either way nothing authoritative was said, so nothing is claimed.
  return 'indeterminate';
}

/** The adopted ATTACH_ACK descriptor as `/control/moor-status` publishes it. */
interface AdoptedMoorDescriptor {
  readonly generation: number;
  readonly wallStartMs: number;
  readonly pid: number;
  readonly running: boolean;
}

/**
 * A count moor decodes from a nonzero u32: `generation` and `pid`.
 *
 * `Number.isSafeInteger` is the whole test on the numeric side. It excludes
 * NaN and the infinities, fractions (a u32 never arrives with a decimal
 * point), and anything past 2^53-1 — a magnitude that cannot survive JSON
 * round-tripping intact, so a value Desk could not hold exactly is one it must
 * not act on. `> 0` carries moor's own fence: `decodeStatus` calls a descriptor
 * malformed when `generation === 0` or `pid === 0`, so a zero here did not come
 * from a moor holder.
 *
 * The u32 ceiling (2^32-1) is deliberately NOT enforced. It is authoritative
 * today, but it is a width, not an invariant: widening either field on the wire
 * would be a compatible change that a ceiling here would turn into a fleet-wide
 * `indeterminate`. The properties that actually make the value meaningful —
 * positive, integral, exactly representable — hold at any width.
 */
function isPositiveWireInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The holder's start clock: a u64 the route passes through `Number()`.
 *
 * Nonnegative rather than positive, and that bound is the honest one rather
 * than a weak one. A u64 cannot be negative and `Number()` cannot make it so,
 * so a negative `wallStartMs` proves the value never came from this route. Zero
 * is a different matter: `decodeStatus` fences `generation` and `pid` against
 * zero explicitly and fences `wallStart` against nothing, so moor itself
 * permits a zero start clock. Rejecting it would be Desk enforcing an invariant
 * its authority does not hold — inventing strictness, which is the same class
 * of error as inventing liveness, just pointed the other way. The safe-integer
 * bound is real: past 2^53-1 the route's own `Number(status.wallStart)` has
 * already lost precision, so such a value is not the holder's start clock.
 */
function isNonNegativeWireInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The descriptor, or `undefined` if this answer is not one.
 *
 * `ok:true` alone proves only that *something* returned JSON with that key —
 * an old daemon, a different route, a captive portal. So the answer is checked
 * on three axes, each of which a forgery has to satisfy at once:
 *
 * STATUS. `/control/moor-status` publishes a descriptor with HTTP 200 and with
 * no other code. A 202 or 204 carrying a perfect body did not come from this
 * route; something in between answered for it, and that something has not
 * looked at this session.
 *
 * TYPE. A missing `running`, or a `running` that arrives as the string
 * `'false'`, must not be read as "not true, so the holder is gone". That
 * reading turns a body Desk failed to understand into a licence to start a
 * second holder over a live one, which is precisely the class of guess desk#50
 * exists to remove.
 *
 * VALUE. Type alone is not enough, because the dangerous body is well-typed:
 * `{ok:true, generation:-1, wallStartMs:-1, pid:-1, running:false}` is the
 * route's exact shape and yields `stale`, which authorises a start. Numbers are
 * therefore held to what moor can actually emit — see the two predicates above.
 *
 * Every field is validated, not just the one being read, because a descriptor
 * missing its generation fence or its start clock is not this route's
 * descriptor at all.
 *
 * UNKNOWN KEYS ARE TOLERATED, deliberately. Strict rejection would buy almost
 * nothing here: each of the four fields is validated on its own authority, so
 * an unrecognised fifth key gives a foreign responder no way to lie about the
 * four that decide the verdict — anything that fabricates all four correctly
 * defeats a key census too. It would cost something real, though. The daemon
 * and the CLI are separately restartable processes whose versions do skew (the
 * 404 handling below exists for exactly that reason), so key-exact validation
 * would turn every future additive field on this route into a fleet-wide
 * `indeterminate` — a compatible change presenting as an outage. Authenticity
 * is proven by validating the fields that carry meaning, not by counting keys.
 */
function adoptedMoorDescriptor(
  result: DaemonControlResult
): AdoptedMoorDescriptor | undefined {
  const body = result.body;
  if (
    !result.ok ||
    result.status !== 200 ||
    body === undefined ||
    !isPositiveWireInteger(body.generation) ||
    !isNonNegativeWireInteger(body.wallStartMs) ||
    !isPositiveWireInteger(body.pid) ||
    typeof body.running !== 'boolean'
  ) {
    return undefined;
  }
  return {
    generation: body.generation,
    wallStartMs: body.wallStartMs,
    pid: body.pid,
    running: body.running
  };
}

/**
 * Did the route itself say this session has no live moor link?
 *
 * A 404 is not that statement. The same status comes from a daemon too old to
 * carry `/control/moor-status` at all, from a reverse proxy that never reached
 * a daemon, and from any generic not-found page — none of which have looked at
 * this session, yet all of which would license a start if their status code
 * were taken as the authority's negative verdict. Absence is proven only by the
 * negative envelope this route emits for it, so a 404 carrying HTML, no body,
 * or unrelated JSON stays `indeterminate` and `desk up` reports it as
 * unfinished business instead of silently double-starting a live session.
 */
function provesNoLiveMoorLink(result: DaemonControlResult): boolean {
  return (
    result.status === 404 &&
    result.body?.ok === false &&
    result.body.error === MOOR_STATUS_NO_LIVE_LINK_ERROR
  );
}

/** Authoritative liveness for each session, keyed by durable sessionId. */
export async function sessionLivenessMap(
  sessions: readonly SessionSpec[] = loadDeskCached().sessions,
  options: RunnerLifecycleOptions = {}
): Promise<Map<string, SessionLiveness>> {
  const verdicts = await Promise.all(
    sessions.map(async (session): Promise<[string, SessionLiveness]> => [
      session.sessionId,
      await sessionLivenessFor(session.sessionId, options)
    ])
  );
  return new Map(verdicts);
}

export async function planDeskUp(
  sessions: SessionSpec[],
  options: RunnerLifecycleOptions = {}
): Promise<SessionPlanAction[]> {
  const liveness = await sessionLivenessMap(sessions, options);
  return sessions.map((session) => {
    switch (liveness.get(session.sessionId)) {
      case 'verified-live':
        return { type: 'preserve', session };
      case 'stale':
        return { type: 'start', session };
      default:
        // Unknown liveness is not a licence to act: starting might duplicate a
        // live holder, preserving might silently leave the fleet down. The plan
        // says so out loud and the run reports it as unfinished business.
        return { type: 'skip', session };
    }
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
    if (action.type === 'skip') {
      // Unknown liveness: nothing was done, and `desk up` must not report that
      // as success. Reaching the authority is the fix, not guessing.
      failures.push(`${action.session.sessionId}: ${UNKNOWN_LIVENESS_REASON}`);
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

export const UNKNOWN_LIVENESS_REASON =
  'liveness is unknown — the terminal daemon did not answer /control/moor-status; ' +
  'start it with `desk serve` and retry';

export async function startSession(
  session: SessionSpec,
  options: RunnerLifecycleOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  // A native session is unstartable from the CLI whatever its liveness, so
  // that verdict is settled without asking the authority anything.
  const nativeError = directNativeStartError(session);
  if (nativeError) {
    return { ok: false, error: nativeError };
  }
  const liveness = await sessionLivenessFor(session.sessionId, options);
  if (liveness === 'verified-live') {
    return { ok: true };
  }
  if (liveness === 'indeterminate') {
    // Never start on top of a session that may already be alive.
    return { ok: false, error: `${session.sessionId}: ${UNKNOWN_LIVENESS_REASON}` };
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
  // Exact identity WINS (desk#57). Mixing the substring convenience into the
  // same precedence as the exact rules made an unambiguous session
  // unaddressable as soon as a neighbour's id contained its name: `claude-1`
  // is a substring of `claude-10`, so every operator command targeting
  // `claude-1` failed with "multiple sessions match" while the daemon
  // answered for it happily. A fleet hits this the moment it reaches ten
  // sessions of one kind.
  const exact = sessions.filter(
    (session) =>
      session.name === query || session.sessionId === query || session.resume === query
  );
  if (exact.length === 1) {
    return exact[0]!;
  }
  if (exact.length > 1) {
    // Genuinely ambiguous: two sessions really do carry this identifier.
    throw new Error(
      `multiple sessions match ${query}: ${exact.map((session) => session.sessionId).join(', ')}`
    );
  }
  // No exact identity — fall back to the substring convenience.
  const partial = sessions.filter((session) => session.sessionId.includes(query));
  if (partial.length === 1) {
    return partial[0]!;
  }
  if (partial.length === 0) {
    throw new Error(`no session matches ${query}`);
  }
  throw new Error(
    `${query} is not an exact session name or id and matches several: ${partial
      .map((session) => session.sessionId)
      .join(', ')}`
  );
}

export async function printStatus(
  sessions: SessionSpec[],
  options: RunnerLifecycleOptions = {}
): Promise<void> {
  const liveness = await sessionLivenessMap(sessions, options);
  for (const session of sessions) {
    // `unknown` is a first-class state, not a synonym for missing: desk#50 was
    // exactly this column lying about sessions nobody had actually checked.
    const state =
      liveness.get(session.sessionId) === 'verified-live'
        ? 'running'
        : liveness.get(session.sessionId) === 'stale'
          ? 'missing'
          : 'unknown';
    console.log(`${state.padEnd(8)} ${session.groupId.padEnd(8)} ${session.name.padEnd(18)} ${session.sessionId}`);
  }
}

function printPlanAction(action: SessionPlanAction): void {
  if (action.type === 'preserve') {
    console.log(`preserve ${action.session.sessionId}`);
    return;
  }
  if (action.type === 'skip') {
    console.log(`skip     ${action.session.sessionId}`);
    console.log(`         ${UNKNOWN_LIVENESS_REASON}`);
    return;
  }
  console.log(`start    ${action.session.sessionId}`);
  console.log(`         cwd: ${action.session.cwd}`);
  console.log(`         cmd: ${action.session.command}`);
}
