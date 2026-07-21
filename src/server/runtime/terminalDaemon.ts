// Terminal daemon assembly (cutover Phase 2 Step 3, core). Composes the durable
// terminal daemon the web server mounts at cutover: a TerminalWsRouter backed by
// a fsync'd generation ledger and the real @xterm/headless emulator, the binary
// WS bridge on /ws/terminal, and atch session provisioning via @codex's verified
// contract (CREATE = `atch start ABSOLUTE_SOCKET_PATH cmd`, KILL = `atch kill -f
// ABSOLUTE_SOCKET_PATH`; a slash-bearing name is the socket path, which isolates
// the canary under a dedicated socket root).
//
// Additive: instantiating this does NOT touch the live tmux path. Mounting it as
// the product's terminal transport (and provisioning real sessions) is the
// gated, flag-guarded cutover; this is the composable piece that step wires.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { GenerationLedger } from '../../shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../../shared/runtime/index.js';
import { TerminalWsRouter } from './terminalWsRouter.js';
import { XtermEmulatorFactory } from './xtermEmulator.js';
import { FileGenerationLedgerStore } from './fileGenerationLedger.js';
import { installTerminalWsBridge } from '../terminalWsBridge.js';
import type { EnsureResult } from '../../shared/runtime/daemonCore.js';

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off?(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface TerminalDaemonOptions {
  /** Durable state root (the generation ledger lives under <root>/_engine). */
  homeRoot: string;
  /** Path to the atch binary. */
  atchBinPath: string;
  /** Dedicated ABSOLUTE socket root; a session's socket is <root>/<sessionId>.sock. */
  atchSocketRoot: string;
  httpServer: UpgradeServer;
  /** WS path (default /ws/terminal). */
  wsPath?: string;
}

/** A provisionable session: the command to run and its initial geometry. */
export interface TerminalDaemonSessionSpec {
  command: string[];
  geometry: { rows: number; cols: number };
}

export interface TerminalDaemon {
  readonly router: TerminalWsRouter;
  /** Spawn + attach the atch master for a session (CREATE contract). */
  provision(sessionId: string, spec: TerminalDaemonSessionSpec): Promise<EnsureResult>;
  /** Retire a session (KILL contract runs via the SessionManager cleanup). */
  retire(sessionId: string): void;
  /** Tear down the WS bridge + its timers. */
  dispose(): void;
}

/** Assemble the durable terminal daemon + mount its binary WS bridge (additive). */
export function createTerminalDaemon(options: TerminalDaemonOptions): TerminalDaemon {
  const ledger = new GenerationLedger(new FileGenerationLedgerStore(join(options.homeRoot, '_engine', 'generation-ledger.json')));
  const router = new TerminalWsRouter({
    ledger,
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: new XtermEmulatorFactory(),
    now: Date.now
  });
  const disposeBridge = installTerminalWsBridge(options.httpServer, router, options.wsPath !== undefined ? { path: options.wsPath } : {});

  const socketPath = (sessionId: string): string => join(options.atchSocketRoot, `${sessionId}.sock`);

  return {
    router,
    provision(sessionId, spec) {
      const sockPath = socketPath(sessionId);
      return router.sessions.spawnAndAttach(sessionId, {
        binPath: options.atchBinPath,
        args: ['start', sockPath, ...spec.command], // CREATE: atch start ABSOLUTE_SOCKET_PATH cmd
        sockPath,
        geometry: spec.geometry,
        detached: true,
        killSpec: { binPath: options.atchBinPath, args: ['kill', '-f', sockPath] } // KILL contract
      });
    },
    retire(sessionId) {
      router.sessions.retire(sessionId);
    },
    dispose() {
      disposeBridge();
    }
  };
}

export interface ProvisionRequest {
  sessionId: string;
  spec: TerminalDaemonSessionSpec;
}

/**
 * Provision atch masters for a set of sessions (the daemon process's startup
 * loop). Sequential so a burst of spawns does not thundering-herd the host; each
 * failure is isolated and reported, never aborting the rest.
 */
export async function provisionSessions(
  daemon: Pick<TerminalDaemon, 'provision'>,
  requests: readonly ProvisionRequest[]
): Promise<{ sessionId: string; ok: boolean; error?: string }[]> {
  const results: { sessionId: string; ok: boolean; error?: string }[] = [];
  for (const { sessionId, spec } of requests) {
    try {
      const ens = await daemon.provision(sessionId, spec);
      results.push({ sessionId, ok: ens.ok });
    } catch (error) {
      results.push({ sessionId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export interface TerminalDaemonServer {
  daemon: TerminalDaemon;
  server: Server;
  /** The bound port (0 in options → an OS-assigned port). */
  port: number;
  close(): Promise<void>;
}

/**
 * Start the terminal daemon in its OWN http server (the separate-process entry).
 * This is the whole point of the three-tier split: the @xterm/headless emulator
 * and the master links live in the daemon process, NEVER in the web-server
 * process (embedding them there regressed serve startup timing). The web server
 * connects out to this via daemonClient / a WS proxy.
 */
export async function startTerminalDaemonServer(
  options: Omit<TerminalDaemonOptions, 'httpServer'> & { host?: string; port: number }
): Promise<TerminalDaemonServer> {
  const server = createServer();
  const daemon = createTerminalDaemon({ ...options, httpServer: server });
  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    daemon,
    server,
    port,
    close() {
      daemon.dispose();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
