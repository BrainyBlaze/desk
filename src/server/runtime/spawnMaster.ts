// Daemon-side atch master spawn (spec §4.8.1 / §5.3 spawn contract). Spawns the
// atch binary for a session, injecting the ledger-allocated generation as the
// bounded-decimal ATCH_GENERATION env var (agreed contract with the atch C
// lane: the master parses it before socket creation and uses it for
// ATTACH_ACK/RECORD, never trusting the client's ATTACH header). Waits for the
// session socket to appear, then the caller attaches via MasterClient.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface SpawnMasterOptions {
  binPath: string;
  args: string[];
  /** Where the master will create its session socket. */
  sockPath: string;
  /** The durable-ledger generation for this session — injected as ATCH_GENERATION. */
  generation: number;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  pollMs?: number;
  /**
   * The launcher forks a DETACHED master and exits (e.g. `atch start`), so a
   * clean exit of the spawned process is expected and the socket appearing is
   * the sole readiness signal. When true, spawnMaster does not reject on the
   * launcher's exit; it polls the socket until timeout.
   */
  detached?: boolean;
}

/**
 * A spawn failure with its OWNERSHIP verdict: teardown (the atch kill command)
 * may only run when this operation could plausibly have created a master.
 * A pre-existing socket or a nonzero launcher exit never establishes
 * ownership — running a kill there would destroy a FOREIGN master.
 */
export class SpawnMasterError extends Error {
  constructor(
    message: string,
    readonly ownershipPossible: boolean
  ) {
    super(message);
    this.name = 'SpawnMasterError';
  }
}

/**
 * Spawn the atch master and resolve once ownership is PROVEN — or reject.
 * ATCH_GENERATION is the ledger value as a bounded u32 decimal; the master
 * owns the generation from here, so a reused sessionId (higher ledger
 * generation) can never be echoed down to a stale value.
 *
 * Detached ownership (`atch start` forks and exits): the socket must be
 * ABSENT before launch (an existing one belongs to someone else — real atch
 * fails EADDRINUSE there, but a stale socket would otherwise read as "ready"),
 * and readiness requires the launcher to exit 0 AND the socket to exist.
 */
export async function spawnMaster(opts: SpawnMasterOptions): Promise<{ child: ChildProcess; sockPath: string }> {
  if (opts.detached === true && existsSync(opts.sockPath)) {
    throw new SpawnMasterError(
      `socket already exists: ${opts.sockPath} — refusing to launch over a master this operation did not spawn`,
      false
    );
  }
  const genStr = String(opts.generation >>> 0); // bounded u32 decimal
  const child = spawn(opts.binPath, opts.args, {
    env: { ...process.env, ...opts.env, ATCH_GENERATION: genStr },
    stdio: 'ignore'
  });
  const timeout = opts.readyTimeoutMs ?? 5000;
  const poll = opts.pollMs ?? 20;

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let launcherExitedClean = false;
    const deadline = Date.now() + timeout;
    const iv = setInterval(check, poll);
    child.once('exit', onExit);
    child.once('error', onError);
    function finish(err?: Error): void {
      if (done) return;
      done = true;
      clearInterval(iv);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (err) {
        // Ownership: this call created the child — a failure must never leak a
        // live process the caller never receives (e.g. a binary that runs but
        // never creates its socket).
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* best effort */
          }
        }
        reject(err);
      } else resolve();
    }
    function onError(error: Error): void {
      // An unspawnable binary (ENOENT/EACCES) emits 'error', not 'exit' — a
      // controlled rejection, never an unhandled error event.
      finish(new SpawnMasterError(`atch spawn failed: ${error.message}`, false));
    }
    function onExit(code: number | null): void {
      if (opts.detached) {
        // Ownership needs BOTH: a clean launcher exit and the socket. A nonzero
        // exit means atch start failed (e.g. EADDRINUSE) and forked nothing.
        if (code !== 0) {
          finish(new SpawnMasterError(`atch launcher exited ${code ?? 'null'}`, false));
          return;
        }
        launcherExitedClean = true;
        if (existsSync(opts.sockPath)) finish();
        return;
      }
      finish(new SpawnMasterError(`atch exited before its socket appeared (code ${code})`, true));
    }
    function check(): void {
      if (existsSync(opts.sockPath)) {
        // Detached readiness waits for the clean launcher exit too — a socket
        // alone does not prove OUR launch created it.
        if (opts.detached !== true || launcherExitedClean) finish();
        if (Date.now() > deadline) {
          finish(new SpawnMasterError(`atch launcher still running past ${timeout}ms with socket present`, true));
        }
        return;
      }
      if (Date.now() > deadline) {
        finish(new SpawnMasterError(`timed out waiting for atch socket ${opts.sockPath}`, launcherExitedClean));
      }
    }
  });
  return { child, sockPath: opts.sockPath };
}
