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
 * Spawn the atch master and resolve once its socket exists (ready) — or reject
 * if it exits first or times out. ATCH_GENERATION is the ledger value as a
 * bounded u32 decimal; the master owns the generation from here, so a reused
 * sessionId (higher ledger generation) can never be echoed down to a stale value.
 */
export async function spawnMaster(opts: SpawnMasterOptions): Promise<{ child: ChildProcess; sockPath: string }> {
  const genStr = String(opts.generation >>> 0); // bounded u32 decimal
  const child = spawn(opts.binPath, opts.args, {
    env: { ...process.env, ...opts.env, ATCH_GENERATION: genStr },
    stdio: 'ignore'
  });
  const timeout = opts.readyTimeoutMs ?? 5000;
  const poll = opts.pollMs ?? 20;

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const deadline = Date.now() + timeout;
    const iv = setInterval(check, poll);
    child.once('exit', onExit);
    function finish(err?: Error): void {
      if (done) return;
      done = true;
      clearInterval(iv);
      child.removeListener('exit', onExit);
      if (err) reject(err);
      else resolve();
    }
    function onExit(code: number | null): void {
      // Detached launcher: a clean exit is expected; keep polling for the socket.
      if (opts.detached) {
        if (existsSync(opts.sockPath)) finish();
        return;
      }
      finish(new Error(`atch exited before its socket appeared (code ${code})`));
    }
    function check(): void {
      if (existsSync(opts.sockPath)) finish();
      else if (Date.now() > deadline) finish(new Error(`timed out waiting for atch socket ${opts.sockPath}`));
    }
  });
  return { child, sockPath: opts.sockPath };
}
