// atch-native terminal daemon process entry — the target of the internal
// `desk terminal-daemon` CLI subcommand (spawned + supervised by the web
// server's daemonSupervisor; not user-facing). Starts
// the terminal daemon server, RECONCILES with already-live atch masters, and
// runs until SIGINT/SIGTERM. Config via env so a canary can fully isolate
// HOME / socket root / port.
//
// Startup semantics are reconcile, not provision: `desk serve` never boots
// sessions (that is `desk up` / the Boot button, via /control/provision), so
// the daemon attaches ONLY to sessions whose atch socket already exists — a
// daemon restart re-binds running sessions instead of double-spawning them.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAtchBinPath, resolveAtchSocketRoot } from '../../shared/atchPaths.js';
import {
  sessionStateSubjectFor,
  type SessionRegistration
} from '../../shared/controlPlane/index.js';
import { loadDesk } from '../../core/runner.js';
import {
  runTerminalDaemon,
  type AgentProviderReconcileResult,
  type RunningTerminalDaemon,
  type TerminalDaemon
} from './terminalDaemon.js';

export interface TerminalDaemonMainConfig {
  homeRoot: string;
  atchBinPath: string;
  atchSocketRoot: string;
  host: string;
  port: number;
  /** Per-launch identity from the supervisor (DESK_DAEMON_NONCE), echoed by /control/health. */
  healthNonce?: string;
}

/** Read env into the daemon config (HOME drives the manifest + durable state root). */
export function resolveDaemonConfig(env: NodeJS.ProcessEnv = process.env): TerminalDaemonMainConfig {
  const home = env.DESK_DAEMON_HOME ?? join(homedir(), '.config', 'desk');
  return {
    homeRoot: home,
    // Resolve through the one audited resolver rather than reading the variable
    // raw. It preflights DESK_ATCH_BIN as an executable regular file, falls back
    // to the same-release libexec/atch, and yields an ABSOLUTE path from PATH —
    // never the bare name "atch", which would hand the daemon's exec to whatever
    // PATH happens to resolve and defer the failure to the first provision.
    atchBinPath: resolveAtchBinPath(import.meta.url, env),
    atchSocketRoot: resolveAtchSocketRoot(env),
    host: env.DESK_DAEMON_HOST ?? '127.0.0.1',
    port: Number(env.DESK_DAEMON_PORT ?? 5178),
    ...(env.DESK_DAEMON_NONCE !== undefined && env.DESK_DAEMON_NONCE.length > 0 ? { healthNonce: env.DESK_DAEMON_NONCE } : {})
  };
}

export interface ReconcileTarget {
  sessionId: string;
  sockPath: string;
  subject: SessionRegistration['subject'];
}

/** Manifest sessions whose atch master socket is already live under the root. */
export function manifestReconcileTargets(
  atchSocketRoot: string,
  socketExists: (path: string) => boolean = existsSync
): ReconcileTarget[] {
  return loadDesk({}).sessions.flatMap((session) => {
    const sessionId = session.sessionId;
    const sockPath = join(atchSocketRoot, `${sessionId}.sock`);
    return socketExists(sockPath)
      ? [{ sessionId, sockPath, subject: sessionStateSubjectFor(session) }]
      : [];
  });
}

/**
 * Re-adopt each already-live master (restore at the durable ledger generation
 * + attach + register the atch kill command — NEVER ensure/spawn: an allocate
 * here would fence the surviving master out, and a missing killSpec would
 * orphan it on the next retire). Failures are isolated per session.
 *
 * CONCURRENT with a bounded worker pool and a bounded per-attach ACK timeout:
 * sequential reconcile would stack one ACK timeout per wedged socket, and a
 * few silent sockets could exceed the supervisor's readiness budget — every
 * daemon incarnation then gets terminated pre-ready, taking the HEALTHY
 * sessions down with it. Total startup stays near one timeout window.
 */
export async function reconcileExistingSessions(
  daemon: Pick<TerminalDaemon, 'router'> &
    Partial<Pick<TerminalDaemon, 'reconcileAtchEvents'>>,
  targets: readonly ReconcileTarget[],
  atchBinPath: string,
  geometry = { rows: 24, cols: 80 },
  opts: { concurrency?: number; ackTimeoutMs?: number } = {}
): Promise<{ sessionId: string; ok: boolean; error?: string }[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, targets.length || 1));
  const ackTimeoutMs = opts.ackTimeoutMs ?? 4_000;
  const results: { sessionId: string; ok: boolean; error?: string }[] = new Array(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= targets.length) return;
      const { sessionId, sockPath, subject } = targets[index];
      try {
        const restored = await daemon.router.sessions.restoreAndAttach(sessionId, {
          sockPath,
          geometry,
          killSpec: {
            binPath: atchBinPath,
            args: ['kill', '-f', sockPath],
            staleCleanupSpec: { binPath: atchBinPath, args: ['rm', sockPath] }
          },
          ackTimeoutMs,
          subject
        });
        if (restored.ok) {
          daemon.reconcileAtchEvents?.(sessionId, restored.generation);
          results[index] = { sessionId, ok: true };
        } else {
          results[index] = { sessionId, ok: false, error: restored.reason };
        }
      } catch (error) {
        results[index] = { sessionId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export async function completeDaemonStartup(
  daemon: Pick<
    TerminalDaemon,
    'router' | 'reconcileAtchEvents' | 'reconcileAgentProviders' | 'markReady'
  >,
  targets: readonly ReconcileTarget[],
  atchBinPath: string
): Promise<{
  reconciled: { sessionId: string; ok: boolean; error?: string }[];
  providerRecovery: AgentProviderReconcileResult[];
}> {
  const reconciled = await reconcileExistingSessions(
    daemon,
    targets,
    atchBinPath
  );
  const providerRecovery = await daemon.reconcileAgentProviders(
    reconciled.filter((result) => result.ok).map((result) => result.sessionId)
  );
  daemon.markReady();
  return { reconciled, providerRecovery };
}

/** Start the daemon, re-attach to live masters, and install signal shutdown. */
export async function runTerminalDaemonMain(config = resolveDaemonConfig()): Promise<RunningTerminalDaemon> {
  // deferReady: every control route (health included) 503s until the reconcile
  // pass below reaches a terminal state — a provision accepted mid-reconcile
  // could allocate over a surviving master and then destroy it on the ACK
  // mismatch. Readiness must not lie about reconciliation.
  const running = await runTerminalDaemon({ ...config, sessions: [], deferReady: true });
  let reconciled: { sessionId: string; ok: boolean; error?: string }[];
  try {
    ({ reconciled } = await completeDaemonStartup(
      running.daemon,
      manifestReconcileTargets(config.atchSocketRoot),
      config.atchBinPath
    ));
  } catch (error) {
    // A post-listen startup failure (e.g. a malformed manifest) must be FATAL:
    // the bound server would otherwise hold the event loop open forever with
    // every control route answering 503 "starting" — a zombie the supervisor's
    // probe would eventually SIGTERM, but the process itself must exit
    // non-zero so restart accounting sees a crash, not a hang.
    await running.close();
    throw error;
  }
  const ok = reconciled.filter((r) => r.ok).length;
  for (const failure of reconciled.filter((r) => !r.ok)) {
    // eslint-disable-next-line no-console
    console.error(`desk terminal daemon: could not re-attach ${failure.sessionId}: ${failure.error}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `desk terminal daemon: ws://${config.host}:${running.port}/ws/terminal — re-attached ${ok}/${reconciled.length} live sessions`
  );
  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return running;
}

// Run when invoked directly (node/tsx), not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  void runTerminalDaemonMain().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`desk terminal daemon failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
