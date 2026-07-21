// SessionManager (spec §3.2/§7.1) — the server-side composition that makes the
// daemon a complete session pipe: DaemonCore (pure registry) + a per-session
// MasterClient (the atch-master link) + browser fan-out. Ensures a session,
// attaches to its master socket, and wires master frames → SessionRuntime →
// browser and browser input → master. Node net lives only in MasterClient; the
// DaemonCore stays pure and is driven through its callbacks (no layering break).
//
// Testable against a fake v3 master today; the real atch binary drops in behind
// the same socket path once its master speaks v3.

import { GenerationLedger } from '../../shared/controlPlane/generationLedger.js';
import { WorkerSupervisor } from '../../shared/runtime/workerSupervisor.js';
import { type EmulatorFactory } from '../../shared/runtime/emulatorPort.js';
import { DaemonCore, type EnsureResult } from '../../shared/runtime/daemonCore.js';
import { type HookInput } from '../../shared/runtime/sessionRuntime.js';
import { type ControlState, type IntakeResult, type Source } from '../../shared/controlPlane/index.js';
import { type BpFrame } from '../../shared/browserProtocol/index.js';
import { MasterClient } from './masterClient.js';
import { spawnMaster } from './spawnMaster.js';
import { Role } from '../../shared/atchWire/frames.js';
import { spawn } from 'node:child_process';

export interface SessionManagerDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  /** Deliver a browser frame to a session's surface (the web-server WS wires this). */
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void;
}

export class SessionManager {
  private readonly core: DaemonCore;
  private readonly masters = new Map<string, MasterClient>();
  /** Per-session teardown: kill the tracked child, or run the atch-kill command for a detached master. */
  private readonly cleanups = new Map<string, () => void>();

  constructor(deps: SessionManagerDeps) {
    this.core = new DaemonCore({
      ledger: deps.ledger,
      supervisor: deps.supervisor,
      emulatorFactory: deps.emulatorFactory,
      now: deps.now,
      sendBrowser: deps.sendBrowser,
      // sendMaster routes to the session's attached master client, if any.
      sendMaster: (sessionId, frame) => this.masters.get(sessionId)?.send(frame)
    });
  }

  ensure(sessionId: string, geometry: { rows: number; cols: number }): EnsureResult {
    return this.core.ensure(sessionId, geometry);
  }

  /**
   * Attach to a session's atch master over its socket: connect, wire incoming
   * RECORD frames into the session runtime, do the v3 controller handshake. A
   * closed socket retires the session. Returns false if the session isn't
   * ensured yet.
   */
  async attachMaster(sessionId: string, sockPath: string, geometry: { rows: number; cols: number }): Promise<boolean> {
    if (this.core.state(sessionId) === undefined) return false;
    const client = new MasterClient(sockPath, {
      onRecord: (rec) => this.core.onMasterRecord(sessionId, rec),
      onClose: () => this.retire(sessionId)
    });
    await client.connect();
    client.handshake({ role: Role.CONTROLLER, sessionId, rows: geometry.rows, cols: geometry.cols });
    this.masters.set(sessionId, client);
    return true;
  }

  /**
   * Ensure a session, SPAWN its atch master with the ledger generation injected
   * as ATCH_GENERATION (§4.8.1 spawn contract), then attach. The generation the
   * master will own is exactly the durable-ledger value the daemon allocated, so
   * the fence is consistent across the join. Returns the ensure result.
   */
  async spawnAndAttach(
    sessionId: string,
    opts: {
      binPath: string;
      args: string[];
      sockPath: string;
      geometry: { rows: number; cols: number };
      readyTimeoutMs?: number;
      /** The launcher forks a detached master and exits (e.g. `atch start`). */
      detached?: boolean;
      /** For a detached master, the command to stop the session on retire (e.g. `atch kill -f NAME`). */
      killSpec?: { binPath: string; args: string[] };
    }
  ): Promise<EnsureResult> {
    const ens = this.ensure(sessionId, opts.geometry);
    if (!ens.ok) return ens;
    const { child } = await spawnMaster({
      binPath: opts.binPath,
      args: opts.args,
      sockPath: opts.sockPath,
      generation: ens.generation,
      readyTimeoutMs: opts.readyTimeoutMs,
      detached: opts.detached
    });
    if (opts.detached) {
      // A detached master: the launcher exits normally (do NOT retire on that);
      // teardown is the kill command, if provided.
      const ks = opts.killSpec;
      this.cleanups.set(sessionId, () => {
        if (ks !== undefined) {
          try {
            spawn(ks.binPath, ks.args, { stdio: 'ignore' });
          } catch {
            /* best effort */
          }
        }
      });
    } else {
      // A tracked foreground child: retire when it exits, kill it on retire.
      this.cleanups.set(sessionId, () => {
        if (child.exitCode === null) child.kill();
      });
      child.once('exit', () => this.retire(sessionId));
    }
    await this.attachMaster(sessionId, opts.sockPath, opts.geometry);
    return ens;
  }

  subscribe(sessionId: string, surfaceId: string, rows: number, cols: number): number | undefined {
    return this.core.subscribe(sessionId, surfaceId, rows, cols);
  }

  onBrowserInput(sessionId: string, channelId: number, binary: boolean, bytes: Uint8Array): void {
    // Route through the runtime (keeps it in the loop for lease enforcement); its
    // sendMaster callback forwards the built INPUT frame to the attached master.
    this.core.onBrowserInput(sessionId, channelId, binary, bytes);
  }

  ingestHook(sessionId: string, hook: HookInput): IntakeResult | undefined {
    return this.core.ingestHook(sessionId, hook);
  }

  state(sessionId: string): { state: ControlState; source: Source; generation: number } | undefined {
    return this.core.state(sessionId);
  }

  list(): { sessionId: string; generation: number; state: ControlState; source: Source }[] {
    return this.core.list();
  }

  retire(sessionId: string): void {
    this.masters.get(sessionId)?.close();
    this.masters.delete(sessionId);
    const cleanup = this.cleanups.get(sessionId);
    if (cleanup !== undefined) cleanup();
    this.cleanups.delete(sessionId);
    this.core.retire(sessionId);
  }

  get sessionCount(): number {
    return this.core.sessionCount;
  }
}
