// DaemonCore (spec §3.2/§3.6) — the multi-session registry that composes the
// pieces into a callable daemon: the generation ledger (§4.8.1), the worker
// supervisor's fail-closed cap (§3.3), a per-session SessionRuntime (§7.1), and
// the controller lease (§7.9). Pure over injected ports/callbacks — the actual
// unix-socket server + RPC transport + real host processes are the thin outer
// shell added at integration; this is the logic they drive.

import { GenerationLedger } from '../controlPlane/generationLedger.js';
import { InMemoryIntakeStore, type ControlState, type Source } from '../controlPlane/index.js';
import { InMemoryCmdCache } from '../delivery/index.js';
import { type BpFrame } from '../browserProtocol/index.js';
import { type RawFrame } from '../atchWire/codec.js';
import { type RecordEnvelope } from '../atchWire/messages.js';
import { WorkerSupervisor } from './workerSupervisor.js';
import { type EmulatorFactory } from './emulatorPort.js';
import { SessionRuntime, type HookInput } from './sessionRuntime.js';
import { createLeaseState, claim, release, type ClaimResult, type LeaseState } from '../lease/index.js';
import { decideStop } from './instanceLock.js';

export interface DaemonCoreDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  /** Route a browser frame to a session's surface (the socket shell wires the WS). */
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void;
  /** Send a frame to a session's atch master. */
  sendMaster: (sessionId: string, frame: RawFrame) => void;
}

interface SessionEntry {
  runtime: SessionRuntime;
  lease: LeaseState;
  generation: number;
}

export type EnsureResult =
  | { ok: true; generation: number; created: boolean }
  | { ok: false; reason: 'cap-exceeded' };

export class DaemonCore {
  private readonly d: DaemonCoreDeps;
  private readonly sessions = new Map<string, SessionEntry>();
  /** One shared intake store (keyed by sessionId internally, §6.5 single allocator). */
  private readonly intakeStore = new InMemoryIntakeStore();
  private readonly cmdCache = new InMemoryCmdCache();

  constructor(deps: DaemonCoreDeps) {
    this.d = deps;
  }

  /**
   * Get-or-create a session. Admission is the fail-closed chokepoint (§3.3): past
   * MAX_LIVE_WORKERS, refuse. A NEW session's generation is allocated from the
   * durable ledger (§4.8.1) — so a reused sessionId after retire gets a HIGHER
   * generation, never a reset that would defeat the §6.3 fence.
   */
  ensure(sessionId: string, geometry: { rows: number; cols: number }): EnsureResult {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return { ok: true, generation: existing.generation, created: false };

    const admit = this.d.supervisor.admit(sessionId, this.d.now());
    if (!admit.ok) return { ok: false, reason: 'cap-exceeded' };

    const generation = this.d.ledger.allocate(sessionId); // durable, fsync-before-spawn
    const emulator = this.d.emulatorFactory.create(geometry);
    const runtime = new SessionRuntime({
      sessionId,
      generation,
      emulator,
      intakeStore: this.intakeStore,
      cmdCache: this.cmdCache,
      now: this.d.now,
      sendBrowser: (channelId, frame) => this.d.sendBrowser(sessionId, channelId, frame),
      sendMaster: (frame) => this.d.sendMaster(sessionId, frame)
    });
    this.sessions.set(sessionId, { runtime, lease: createLeaseState(), generation });
    return { ok: true, generation, created: true };
  }

  /**
   * Retire a session (it ended). Frees the supervisor slot + disposes the
   * emulator; the ledger tombstone is DELIBERATELY kept so a recreate gets a
   * higher generation (§4.8.1).
   */
  retire(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.d.supervisor.release(sessionId);
  }

  /** Whether an explicit daemon stop may proceed (§11.4: refuse while sessions live unless forced). */
  canStop(forced: boolean): { action: 'stop' } | { action: 'refuse'; liveSessions: number } {
    return decideStop(this.sessions.size, forced);
  }

  list(): { sessionId: string; generation: number; state: ControlState; source: Source }[] {
    const out: { sessionId: string; generation: number; state: ControlState; source: Source }[] = [];
    for (const [sessionId, e] of this.sessions) {
      const s = e.runtime.currentState();
      out.push({ sessionId, generation: e.generation, state: s.state, source: s.source });
    }
    return out;
  }

  state(sessionId: string): { state: ControlState; source: Source; generation: number } | undefined {
    return this.sessions.get(sessionId)?.runtime.currentState();
  }

  // ---- routing to a session's runtime ---------------------------------------
  onMasterRecord(sessionId: string, rec: RecordEnvelope): void {
    this.sessions.get(sessionId)?.runtime.onMasterRecord(rec);
  }

  subscribe(sessionId: string, surfaceId: string, rows: number, cols: number): number | undefined {
    return this.sessions.get(sessionId)?.runtime.subscribe(surfaceId, rows, cols);
  }

  onBrowserInput(sessionId: string, channelId: number, binary: boolean, bytes: Uint8Array): void {
    this.sessions.get(sessionId)?.runtime.onBrowserInput(channelId, binary, bytes);
  }

  ingestHook(sessionId: string, hook: HookInput): ReturnType<SessionRuntime['ingestHook']> | undefined {
    return this.sessions.get(sessionId)?.runtime.ingestHook(hook);
  }

  // ---- controller lease (§7.9) ----------------------------------------------
  claimLease(sessionId: string, conn: string, forced: boolean, ackOffset: bigint): ClaimResult | undefined {
    const e = this.sessions.get(sessionId);
    if (e === undefined) return undefined;
    return claim(e.lease, conn, forced, this.d.now(), ackOffset);
  }

  releaseLease(sessionId: string, conn: string): boolean {
    const e = this.sessions.get(sessionId);
    return e !== undefined && release(e.lease, conn);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
