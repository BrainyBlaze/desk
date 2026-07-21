// atch-native terminal daemon process entry (cutover). A STANDALONE process
// (not a `desk` subcommand — kept out of the public CLI dispatch): it starts the
// terminal daemon server and provisions an atch master for each manifest session,
// then runs until SIGINT/SIGTERM. The web server (DESK_ATCH_NATIVE=1) proxies
// browser /ws/terminal traffic to it. Config via env so the canary can fully
// isolate HOME / socket root / port.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadDesk } from '../../core/runner.js';
import { runTerminalDaemon, type ProvisionRequest, type RunningTerminalDaemon } from './terminalDaemon.js';

export interface TerminalDaemonMainConfig {
  homeRoot: string;
  atchBinPath: string;
  atchSocketRoot: string;
  host: string;
  port: number;
}

/** Read env into the daemon config (HOME drives the manifest + durable state root). */
export function resolveDaemonConfig(env: NodeJS.ProcessEnv = process.env): TerminalDaemonMainConfig {
  const home = env.DESK_DAEMON_HOME ?? join(homedir(), '.config', 'desk');
  return {
    homeRoot: home,
    atchBinPath: env.DESK_ATCH_BIN ?? 'atch',
    atchSocketRoot: env.DESK_ATCH_SOCKET_ROOT ?? join('/tmp', `desk-atch-${process.pid}`),
    host: env.DESK_DAEMON_HOST ?? '127.0.0.1',
    port: Number(env.DESK_DAEMON_PORT ?? 5178)
  };
}

/** Build a provisioning request per manifest session (run its command under a shell via atch). */
export function manifestProvisionRequests(): ProvisionRequest[] {
  return loadDesk({}).sessions.map((session) => ({
    sessionId: session.sessionId ?? session.tmuxSession,
    spec: { command: ['sh', '-c', session.command], geometry: { rows: 24, cols: 80 } }
  }));
}

/** Start the daemon, provision the manifest's sessions, and install signal shutdown. */
export async function runTerminalDaemonMain(config = resolveDaemonConfig()): Promise<RunningTerminalDaemon> {
  const running = await runTerminalDaemon({ ...config, sessions: manifestProvisionRequests() });
  const ok = running.provisioned.filter((p) => p.ok).length;
  // eslint-disable-next-line no-console
  console.log(`desk terminal daemon: ws://${config.host}:${running.port}/ws/terminal — provisioned ${ok}/${running.provisioned.length}`);
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
