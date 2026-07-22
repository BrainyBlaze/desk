// Production lifecycle for the atch terminal daemon (cutover item 1).
//
// Under DESK_ATCH_NATIVE the web server owns the daemon PROCESS: it spawns
// `desk terminal-daemon` (or the DESK_DAEMON_CMD override) as a child,
// restarts it on unexpected exit with capped backoff, and kills it on server
// close. The daemon stays a SEPARATE process — this module imports
// node:child_process only, never the daemon code, so the web server remains
// free of @xterm/headless (embedding it regressed serve startup timing).
//
// Fail-closed at the cap: after too many crashes in the window the supervisor
// STOPS restarting and logs loudly; the web server stays up and native
// sessions read MISSING rather than the supervisor thrashing forever.

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { findPackageRoot } from '../../shared/packageRoot.js';

/**
 * Env vars a launching agent session leaks into the server process. A daemon
 * child inheriting these mis-identifies itself (the canary misconfiguration
 * incident) — always scrubbed from the child env.
 */
const LEAKED_SESSION_ENV = [
  'DESK_AGENT',
  'DESK_TMUX_SESSION',
  'DESK_SERVER_URL',
  'DESK_HOST_TOKEN',
  'DESK_RESUME',
  'DESK_AGENT_MCP',
  'DESK_BYPASS_PERMISSIONS'
] as const;

export interface DaemonSupervisorOptions {
  /** argv to spawn, e.g. ['desk', 'terminal-daemon']. Never run through a shell. */
  command: readonly string[];
  /** Extra child env (DESK_DAEMON_PORT etc.); merged over the scrubbed process env. */
  env?: Record<string, string>;
  /** Max unexpected exits inside restartWindowMs before giving up (fail closed). */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Backoff before restart attempt n (1-based); capped by the default. */
  backoffMs?: (attempt: number) => number;
  log?: (message: string) => void;
  /**
   * Health endpoint of the daemon (GET, 200 = ready). When set, each launched
   * child is probed until it answers; `status().ready` reflects the result.
   * Readiness is observability, not gating — the WS proxy buffers until the
   * daemon binds, and crash accounting stays with the exit handler.
   */
  healthUrl?: string;
  healthProbe?: { attempts?: number; intervalMs?: number };
  /** Test seam: replaces the fetch-based probe. Resolves true when healthy. */
  probeFn?: (url: string) => Promise<boolean>;
  /** Test seam. */
  spawnFn?: typeof spawn;
  /** Test seam for the restart timer. */
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export interface DaemonSupervisorStatus {
  state: 'running' | 'restarting' | 'gave-up' | 'disposed';
  pid?: number;
  restarts: number;
  /** True once the CURRENT child answered the health probe; reset per launch. */
  ready: boolean;
}

export interface DaemonSupervisor {
  status(): DaemonSupervisorStatus;
  dispose(): void;
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const defaultBackoff = (attempt: number): number => Math.min(500 * 2 ** (attempt - 1), 8_000);

/** True when a path plausibly names a Node runtime (not the Bun-compiled standalone). */
function looksLikeNodeRuntime(execPath: string): boolean {
  const base = execPath.split(/[\\/]/).pop() ?? '';
  return base === 'node' || base === 'node.exe';
}

/**
 * The release root: the module's package root when the module lives on a real
 * release filesystem, else the process cwd when IT is a release root. The
 * second branch exists for the Bun-compiled standalone, whose import.meta.url
 * is a bundle-internal path — `desk serve` launches it with cwd = the release
 * root (serveCommand), so cwd is the authoritative fallback there.
 */
export function resolveReleaseRoot(fromUrl: string, cwd: string = process.cwd()): string {
  try {
    return findPackageRoot(fromUrl);
  } catch {
    if (existsSync(join(cwd, 'package.json')) && existsSync(join(cwd, 'dist', 'cli', 'main.js'))) {
      return cwd;
    }
    throw new Error('cannot locate the desk release root for the terminal daemon — set DESK_DAEMON_CMD');
  }
}

/**
 * The child argv. NEVER an ambient `desk` from PATH — an installed standalone
 * can outlive an activation swap, so PATH may resolve a DIFFERENT release.
 * The default derives the same-release pair from the release root:
 * `<root>/runtime/node` when present (the installed layout — the running
 * process there is the Bun-compiled standalone, whose execPath would
 * recursively launch the HTTP entrypoint), else this process's execPath when
 * it IS a node runtime (dev / npm-linked). Anything else fails closed. The
 * DESK_DAEMON_CMD env is an explicit override only (canary / debugging).
 */
export function resolveDaemonCommand(
  fromUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  processExecPath: string = process.execPath,
  cwd: string = process.cwd()
): string[] {
  const override = env.DESK_DAEMON_CMD?.trim();
  if (override !== undefined && override.length > 0) {
    return override.split(/\s+/);
  }
  const root = resolveReleaseRoot(fromUrl, cwd);
  const cliEntry = join(root, 'dist', 'cli', 'main.js');
  if (!existsSync(cliEntry)) {
    throw new Error(`desk CLI entry missing at ${cliEntry} — run npm run build, or set DESK_DAEMON_CMD`);
  }
  const releaseNode = join(root, 'runtime', 'node');
  if (isExecutableFile(releaseNode)) {
    return [releaseNode, cliEntry, 'terminal-daemon'];
  }
  if (looksLikeNodeRuntime(processExecPath)) {
    return [processExecPath, cliEntry, 'terminal-daemon'];
  }
  throw new Error(
    `no node runtime for the terminal daemon: ${releaseNode} is missing and ${processExecPath} is not node — reinstall desk or set DESK_DAEMON_CMD`
  );
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The atch binary for the daemon child: DESK_ATCH_BIN wins, then the
 * same-release bundled libexec/atch when present and executable, then PATH.
 * The licensing/packaging decision (bundle vs user-installed) changes only
 * which branch fires, never the runtime semantics.
 */
export function resolveAtchBinPath(fromUrl: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const explicit = env.DESK_ATCH_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    // An explicit setting is preflighted, not trusted: a daemon that reports
    // healthy with an unusable atch would fail only at first provision.
    if (!isExecutableFile(explicit)) {
      throw new Error(`DESK_ATCH_BIN is not an executable file: ${explicit}`);
    }
    return explicit;
  }
  try {
    const bundled = join(resolveReleaseRoot(fromUrl, cwd), 'libexec', 'atch');
    if (isExecutableFile(bundled)) {
      return bundled;
    }
  } catch {
    // no resolvable release root — PATH is still a legitimate source
  }
  // PATH scan yields an ABSOLUTE preflighted path (never the bare string
  // 'atch', which would defer the failure to the first provision).
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, 'atch');
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new Error('no atch binary found: set DESK_ATCH_BIN, ship libexec/atch, or install atch on PATH');
}

/**
 * Child env derived from DESK_DAEMON_URL so the daemon binds exactly where the
 * web server's /ws/terminal proxy points — one source of truth for the port.
 */
export function daemonChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.DESK_DAEMON_URL ?? 'ws://127.0.0.1:5178';
  let host = '127.0.0.1';
  let port = '5178';
  try {
    const url = new URL(raw);
    if (url.hostname) host = url.hostname;
    if (url.port) port = url.port;
  } catch {
    // an unparseable DESK_DAEMON_URL falls back to the defaults the proxy also uses
  }
  return { DESK_DAEMON_HOST: host, DESK_DAEMON_PORT: port };
}

/** Spawn + supervise the terminal daemon. Returns a disposable handle. */
export function startDaemonSupervisor(options: DaemonSupervisorOptions): DaemonSupervisor {
  const log = options.log ?? ((message: string) => console.error(message));
  const spawnFn = options.spawnFn ?? spawn;
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const restartWindowMs = options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const backoffMs = options.backoffMs ?? defaultBackoff;

  let child: ChildProcess | undefined;
  let disposed = false;
  let gaveUp = false;
  let ready = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let restarts = 0;
  const exitTimestamps: number[] = [];
  /** Children whose demise was already accounted (an 'error' + a late 'exit' fire for ONE child). */
  const handled = new WeakSet<ChildProcess>();

  const childEnv = (): NodeJS.ProcessEnv => {
    const merged: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const key of LEAKED_SESSION_ENV) {
      if (options.env?.[key] === undefined) {
        delete merged[key];
      }
    }
    return merged;
  };

  const probeHealth = (self: ChildProcess): void => {
    if (options.healthUrl === undefined) {
      return;
    }
    const url = options.healthUrl;
    const probe =
      options.probeFn ??
      (async (target: string): Promise<boolean> => {
        try {
          const res = await fetch(target, { signal: AbortSignal.timeout(2_000) });
          return res.ok;
        } catch {
          return false;
        }
      });
    const attempts = options.healthProbe?.attempts ?? 30;
    const intervalMs = options.healthProbe?.intervalMs ?? 500;
    let attempt = 0;
    const tick = (): void => {
      if (disposed || child !== self) {
        return; // a dead or replaced child's probe stops silently
      }
      attempt += 1;
      void probe(url).then((healthy) => {
        if (disposed || child !== self) {
          return;
        }
        if (healthy) {
          ready = true;
          log(`terminal daemon ready (${url})`);
          return;
        }
        if (attempt >= attempts) {
          // A child that never becomes ready is as dead as a crashed one:
          // terminate it so the exit handler's bounded-restart accounting
          // decides (restart or give up) — never leave a permanently-unready
          // daemon running unsupervised. Identity-guarded above, so a stale
          // probe can never kill a replacement child.
          log(`terminal daemon not ready after ${attempts} probes (${url}) — terminating it for restart accounting`);
          self.kill('SIGTERM');
          return;
        }
        const timer = setTimeoutFn(tick, intervalMs);
        timer.unref?.();
      });
    };
    tick();
  };

  const launch = (): void => {
    const [bin, ...args] = options.command;
    const next = spawnFn(bin, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child = next;
    ready = false;
    next.stdout?.on('data', (chunk: Buffer) => log(`[terminal-daemon] ${String(chunk).trimEnd()}`));
    next.stderr?.on('data', (chunk: Buffer) => log(`[terminal-daemon] ${String(chunk).trimEnd()}`));
    next.on('error', (error) => {
      // ENOENT (DESK_DAEMON_CMD not resolvable) lands here — surface it and
      // route through the same bounded-restart accounting as a crash.
      log(`terminal daemon spawn failed: ${error.message}`);
      handleExit(next);
    });
    next.on('exit', (code, signal) => {
      log(`terminal daemon exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      handleExit(next);
    });
    probeHealth(next);
  };

  /**
   * Account ONE demise of ONE child. Identity-bound: a late 'exit' from an old
   * child (after its 'error' was handled, or after the restart timer already
   * launched a replacement) must neither clear the live child nor schedule a
   * second concurrent daemon.
   */
  const handleExit = (which: ChildProcess): void => {
    if (handled.has(which)) {
      return;
    }
    handled.add(which);
    if (child === which) {
      child = undefined;
      ready = false;
    } else {
      return; // a replaced child's late demise: already accounted for by its own handling
    }
    if (disposed || gaveUp || restartTimer !== undefined) {
      return;
    }
    const now = Date.now();
    exitTimestamps.push(now);
    while (exitTimestamps.length > 0 && now - exitTimestamps[0] > restartWindowMs) {
      exitTimestamps.shift();
    }
    if (exitTimestamps.length > maxRestarts) {
      gaveUp = true;
      log(
        `terminal daemon crashed ${exitTimestamps.length} times within ${restartWindowMs}ms — giving up. ` +
          'Native terminals will read MISSING until the server restarts.'
      );
      return;
    }
    restarts += 1;
    const delay = backoffMs(restarts);
    log(`terminal daemon restarting in ${delay}ms (attempt ${restarts})`);
    restartTimer = setTimeoutFn(() => {
      restartTimer = undefined;
      if (!disposed && !gaveUp) {
        launch();
      }
    }, delay);
    restartTimer.unref?.();
  };

  launch();

  return {
    status() {
      if (disposed) return { state: 'disposed', restarts, ready: false };
      if (gaveUp) return { state: 'gave-up', restarts, ready: false };
      if (child !== undefined) return { state: 'running', pid: child.pid, restarts, ready };
      return { state: 'restarting', restarts, ready: false };
    },
    dispose() {
      disposed = true;
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      child?.kill('SIGTERM');
      child = undefined;
      ready = false;
    }
  };
}
