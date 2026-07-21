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

import type { IncomingMessage } from 'node:http';
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
