// DaemonCore (spec §3.2/§3.6) — the multi-session registry that composes the
// pieces into a callable daemon: the generation ledger (§4.8.1), the worker
// supervisor's fail-closed cap (§3.3), a per-session SessionRuntime (§7.1), and
// the controller lease (§7.9). Pure over injected ports/callbacks — the actual
// unix-socket server + RPC transport + real host processes are the thin outer
// shell added at integration; this is the logic they drive.

import { GenerationLedger } from '../controlPlane/generationLedger.js';
import {
  AgentStateAuthority,
  InMemoryAgentStateIntakeStore,
  acceptAgentStateEvent,
  type AgentStateIntakeResult,
  type AgentStateIntakeStore,
  type AgentHealthInput,
  type AgentStateProducerRegistration,
  type AuthorityMutationResult,
  type SessionRegistration,
  type SessionStateSnapshot,
  type SessionStateTransition,
} from '../controlPlane/index.js';
import { InMemoryCmdCache } from '../delivery/index.js';
import { type BpFrame } from '../browserProtocol/index.js';
import { WorkerSupervisor } from './workerSupervisor.js';
import { type EmulatorFactory } from './emulatorPort.js';
import { SessionRuntime } from './sessionRuntime.js';
import { createLeaseState, claim, release, type ClaimResult, type LeaseState } from '../lease/index.js';
import { decideStop } from './instanceLock.js';
import type { MoorExitOutcome, SessionExit } from '../controlPlane/contract.js';

/** desk#59 — the closed observation-failure vocabulary. */
export type ExitDiagnostic = NonNullable<SessionExit['diagnostic']>;

export interface DaemonCoreDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  /** Route a browser frame to a session's surface (the socket shell wires the WS). */
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void;
  /** Typed master-bound sends, routed to the session's attached holder link. */
  sendMasterInput: (
    sessionId: string,
    bytes: Uint8Array,
    binary: boolean,
    surfaceId: number
  ) => boolean | void;
  sendMasterResize: (sessionId: string, rows: number, cols: number, surfaceId: number) => void;
  workingLeaseMs?: number;
  openToolLeaseMs?: number;
  initialAgentHealth?: (
    subject: Extract<SessionRegistration['subject'], { kind: 'agent' }>
  ) => AgentHealthInput | undefined;
  createAgentStateIntakeStore?: (dependencies: {
    currentGeneration: (sessionId: string) => number;
    expectedProducer: (
      sessionId: string,
      generation: number
    ) => AgentStateProducerRegistration | undefined;
    now: () => number;
  }) => AgentStateIntakeStore;
  onStateTransition?: (transition: SessionStateTransition) => void;
}

interface SessionEntry {
  runtime: SessionRuntime;
  lease: LeaseState;
  generation: number;
}

export type EnsureResult =
  | { ok: true; generation: number; created: boolean }
  | { ok: false; reason: 'cap-exceeded' };

export type RestoreResult =
  | { ok: true; generation: number }
  | { ok: false; reason: 'cap-exceeded' | 'no-generation' | 'already-live' };

export type DaemonAgentStateIntakeResult =
  | (Extract<AgentStateIntakeResult, { kind: 'accepted' }> & {
      mutation: AuthorityMutationResult;
    })
  | Exclude<AgentStateIntakeResult, { kind: 'accepted' }>;

/**
 * desk#59 — every teardown names itself, so an exit record can say WHO ended
 * the session. Deaths that Desk causes are otherwise indistinguishable from a
 * child that died on its own, which is exactly the ambiguity that made live
 * agent deaths untraceable.
 */
export type RetireReason =
  | 'control-retire'          // an explicit /control retire RPC
  | 'restore-superseded'      // a newer generation took the slot during restore
  | 'master-link-closed'      // the adopted moor link closed
  | 'spawn-prepare-failed'    // prepareSpawn threw before the master existed
  | 'spawn-failed'            // the master never came up
  | 'spawn-aborted'           // the spawn op was abandoned mid-flight
  | 'moor-reconcile-failed'   // the surviving holder's event store was unobservable
  | 'observer-terminal'       // the lifecycle observer failed; the session is not operable
  | 'store-authority-refused' // the holder's acknowledged store could not be trusted
  | 'observer-start-failed'   // the lifecycle observer could not be started at all
  | 'provider-session-reset'  // the session was torn down to re-establish provider identity
  | 'confirmed-holder-absence' // an authenticated probe positively established the holder is gone
  | 'operator-reboot'         // the operator restarted this session
  | 'session-deleted'         // the session was removed from the manifest
  | 'kill-switch'             // the operator's kill switch stopped everything
  | 'stale-identity-after-edit'; // an edit left the old identity's holder behind

/** desk#59 — the closed set, for validating a cause that arrives over the wire. */
export const RETIRE_REASONS = [
  'control-retire',
  'restore-superseded',
  'master-link-closed',
  'spawn-prepare-failed',
  'spawn-failed',
  'spawn-aborted',
  'moor-reconcile-failed',
  'observer-terminal',
  'store-authority-refused',
  'observer-start-failed',
  'provider-session-reset',
  'confirmed-holder-absence',
  'operator-reboot',
  'session-deleted',
  'kill-switch',
  'stale-identity-after-edit'
] as const satisfies readonly RetireReason[];

export function isRetireReason(value: unknown): value is RetireReason {
  return typeof value === 'string' && (RETIRE_REASONS as readonly string[]).includes(value);
}

export class DaemonCore {
  private readonly d: DaemonCoreDeps;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly authority: AgentStateAuthority;
  private readonly agentStateIntakeStore: AgentStateIntakeStore;
  private readonly cmdCache = new InMemoryCmdCache();
  /** Global monotonic channelId allocator (§7.4) — never reused across sessions. */
  private nextChannelId = 1;
  /** channelId → owning sessionId, for channelId-only INPUT routing. */
  private readonly channelToSession = new Map<number, string>();

  constructor(deps: DaemonCoreDeps) {
    this.d = deps;
    this.authority = new AgentStateAuthority({
      now: deps.now,
      workingLeaseMs: deps.workingLeaseMs ?? 15_000,
      openToolLeaseMs: deps.openToolLeaseMs ?? 30 * 60_000,
      ...(deps.onStateTransition === undefined ? {} : { onTransition: deps.onStateTransition })
    });
    const intakeDependencies = {
      currentGeneration: (sessionId: string) => this.d.ledger.current(sessionId),
      expectedProducer: (sessionId: string, generation: number) =>
        this.expectedProducer(sessionId, generation),
      now: deps.now
    };
    this.agentStateIntakeStore =
      deps.createAgentStateIntakeStore?.(intakeDependencies) ??
      new InMemoryAgentStateIntakeStore(intakeDependencies);
  }

  /**
   * Get-or-create a session. Admission is the fail-closed chokepoint (§3.3): past
   * MAX_LIVE_WORKERS, refuse. A NEW session's generation is allocated from the
   * durable ledger (§4.8.1) — so a reused sessionId after retire gets a HIGHER
   * generation, never a reset that would defeat the §6.3 fence.
   */
  ensure(
    sessionId: string,
    geometry: { rows: number; cols: number },
    subject: SessionRegistration['subject'] = { kind: 'terminal' }
  ): EnsureResult {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      this.registerAuthoritySession(sessionId, existing.generation, subject);
      return { ok: true, generation: existing.generation, created: false };
    }

    const admit = this.d.supervisor.admit(sessionId, this.d.now());
    if (!admit.ok) return { ok: false, reason: 'cap-exceeded' };

    const generation = this.d.ledger.allocate(sessionId); // durable, fsync-before-spawn
    this.admitSession(sessionId, geometry, generation, subject);
    return { ok: true, generation, created: true };
  }

  /** Shared session bring-up for ensure (fresh generation) + restore (adopted). */
  private admitSession(
    sessionId: string,
    geometry: { rows: number; cols: number },
    generation: number,
    subject: SessionRegistration['subject']
  ): void {
    this.registerAuthoritySession(sessionId, generation, subject);
    if (subject.kind === 'agent' && this.d.initialAgentHealth !== undefined) {
      let health: AgentHealthInput | undefined;
      try {
        health = this.d.initialAgentHealth(subject);
      } catch (error) {
        // The probe is optional diagnostics and must not block admission.
        // Authority or transition-journal failures below remain fatal.
        const detail = (
          error instanceof Error ? error.message : String(error)
        ).trim().slice(0, 2_000);
        health = {
          status: 'degraded',
          reason: 'hook-preflight-failed',
          ...(detail.length === 0 ? {} : { detail })
        };
      }
      if (health !== undefined) {
        this.assessAgentHealth(sessionId, generation, health);
      }
    }
    const emulator = this.d.emulatorFactory.create(geometry);
    const runtime = new SessionRuntime({
      sessionId,
      generation,
      emulator,
      cmdCache: this.cmdCache,
      now: this.d.now,
      sendBrowser: (channelId, frame) => this.d.sendBrowser(sessionId, channelId, frame),
      sendMasterInput: (bytes, binary, surfaceId) =>
        this.d.sendMasterInput(sessionId, bytes, binary, surfaceId),
      sendMasterResize: (rows, cols, surfaceId) =>
        this.d.sendMasterResize(sessionId, rows, cols, surfaceId),
      onExit: (exit) => {
        this.authority.markExited(sessionId, generation, {
          code: exit.code,
          signal: exit.signal === 0 ? null : String(exit.signal),
          origin: 'observed',
          reason: null,
          // The supervised worker path reports a POSIX code/signal pair
          // directly; the tagged outcome states which of the two it was.
          outcome:
            exit.signal === 0 || exit.signal === undefined
              ? { kind: 'exited', code: exit.code ?? 0 }
              : { kind: 'signalled', signal: Number(exit.signal) },
          diagnostic: null
        });
      }
    });
    this.sessions.set(sessionId, { runtime, lease: createLeaseState(), generation });
  }

  /**
   * Re-adopt a session whose moor holder SURVIVED a daemon restart: create the
   * runtime at the ledger's durable CURRENT generation without allocating. The
   * surviving master owns exactly that generation — an ensure() here would
   * allocate current+1 and the fence would reject every frame in both
   * directions. Fails closed when the ledger has no durable generation for the
   * sessionId (an unknown socket is not adoptable — its generation is
   * unknowable) or the session is already live.
   */
  restore(
    sessionId: string,
    geometry: { rows: number; cols: number },
    subject: SessionRegistration['subject'] = { kind: 'terminal' }
  ): RestoreResult {
    if (this.sessions.has(sessionId)) return { ok: false, reason: 'already-live' };
    const generation = this.d.ledger.current(sessionId);
    if (generation === 0) return { ok: false, reason: 'no-generation' };

    const admit = this.d.supervisor.admit(sessionId, this.d.now());
    if (!admit.ok) return { ok: false, reason: 'cap-exceeded' };

    this.admitSession(sessionId, geometry, generation, subject);
    return { ok: true, generation };
  }

  /**
   * Retire a session (it ended). Frees the supervisor slot + disposes the
   * emulator; the ledger tombstone is DELIBERATELY kept so a recreate gets a
   * higher generation (§4.8.1).
   */
  retire(sessionId: string, reason: RetireReason): void {
    const entry = this.sessions.get(sessionId);
    if (entry !== undefined) {
      this.authority.markExited(sessionId, entry.generation, {
        code: null,
        signal: null,
        origin: 'retired',
        reason,
        // Desk tore this session down without seeing how the child ended.
        // `unknown` states exactly that, instead of inventing a zero.
        outcome: { kind: 'unknown' },
        // Nothing has gone wrong with observation yet; a failed final drain
        // refines this afterwards without touching the reason above.
        diagnostic: null
      });
    }
    this.sessions.delete(sessionId);
    this.d.supervisor.release(sessionId);
    for (const [ch, sid] of this.channelToSession) if (sid === sessionId) this.channelToSession.delete(ch);
  }

  /** Whether an explicit daemon stop may proceed (§11.4: refuse while sessions live unless forced). */
  canStop(forced: boolean): { action: 'stop' } | { action: 'refuse'; liveSessions: number } {
    return decideStop(this.sessions.size, forced);
  }

  list(): SessionStateSnapshot[] {
    return this.authority.list();
  }

  state(sessionId: string): SessionStateSnapshot | undefined {
    return this.authority.snapshot(sessionId);
  }

  hasLiveSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  stateSnapshot(sessionId: string): SessionStateSnapshot | undefined {
    return this.authority.snapshot(sessionId);
  }

  stateSnapshots(): { revision: number; snapshots: SessionStateSnapshot[] } {
    return this.authority.snapshotView();
  }

  markRunning(sessionId: string, generation: number): AuthorityMutationResult {
    return this.authority.markRunning(sessionId, generation);
  }

  observeTitleActivity(
    sessionId: string,
    generation: number,
    activity: 'working' | 'idle',
    observedAt: number
  ): AuthorityMutationResult {
    return this.authority.observeTitleActivity(sessionId, generation, activity, observedAt);
  }

  refineExitDiagnostic(
    sessionId: string,
    generation: number,
    diagnostic: ExitDiagnostic,
    observedAt?: number
  ): AuthorityMutationResult {
    return this.authority.refineExitDiagnostic(sessionId, generation, diagnostic, observedAt);
  }

  markExited(
    sessionId: string,
    generation: number,
    exit: {
      code: number | null;
      signal: string | null;
      /** desk#59 — an exit must say whether it was seen or merely assumed. */
      origin: 'observed' | 'retired';
      reason: RetireReason | null;
      /** desk#59 — the raw ending, or `unknown` when none could be proved. */
      outcome: MoorExitOutcome;
      /** desk#59 — what observation failed to establish, if anything. */
      diagnostic: ExitDiagnostic | null;
    },
    observedAt?: number
  ): AuthorityMutationResult {
    return this.authority.markExited(sessionId, generation, exit, observedAt);
  }

  /** §8 CPR source: the authoritative emulator's cursor, if the session lives. */
  cursor(sessionId: string): { row: number; col: number } | undefined {
    return this.sessions.get(sessionId)?.runtime.cursor();
  }

  /** Fan a child-exit push to the session's subscribed browser surfaces. */
  /**
   * Announce the legacy numeric EXIT to a LIVE session's browser surfaces.
   *
   * desk#59 — deliberately live-only. A retired session's placeholder can still
   * be strengthened by the holder's real exit long after its runtime is gone;
   * that correction belongs in the durable record, not on a wire whose surfaces
   * were already torn down. The lookup makes it a no-op rather than relying on
   * callers to remember, and the number itself is a compatibility view derived
   * at this boundary — never the durable truth.
   */
  emitExit(sessionId: string, code: number, signal = 0): void {
    this.sessions.get(sessionId)?.runtime.emitExit(code, signal);
  }

  /**
   * §10: verified-live heartbeat evidence lapsed (false) or returned (true).
   * desk#64 — `reason` names which holder-link degradation this is; it defaults
   * to the liveness one inside the authority.
   */
  observeHolderLiveness(
    sessionId: string,
    generation: number,
    live: boolean,
    detail?: string,
    reason?: string
  ): AuthorityMutationResult {
    return this.authority.observeHolderLiveness(sessionId, generation, live, detail, reason);
  }

  assessAgentHealth(
    sessionId: string,
    generation: number,
    health: AgentHealthInput
  ): AuthorityMutationResult {
    return this.authority.assessAgentHealth(sessionId, generation, health);
  }

  ingestAgentState(input: unknown): DaemonAgentStateIntakeResult {
    const result = acceptAgentStateEvent(input, this.agentStateIntakeStore);
    if (result.kind !== 'accepted') return result;
    return {
      ...result,
      mutation: this.authority.ingest(result.event)
    };
  }

  private expectedProducer(
    sessionId: string,
    generation: number
  ): AgentStateProducerRegistration | undefined {
    const snapshot = this.authority.snapshot(sessionId);
    if (
      snapshot === undefined ||
      snapshot.generation !== generation ||
      snapshot.lifecycle === 'exited' ||
      snapshot.subject.kind !== 'agent'
    ) {
      return undefined;
    }
    return {
      provider: snapshot.subject.provider,
      mode: snapshot.subject.mode,
      producer: snapshot.subject.producer
    };
  }

  private registerAuthoritySession(
    sessionId: string,
    generation: number,
    subject: SessionRegistration['subject']
  ): void {
    if (subject.kind === 'terminal') {
      this.authority.registerSession({
        sessionId,
        generation,
        lifecycle: 'starting',
        subject
      });
      return;
    }
    this.authority.registerSession({
      sessionId,
      generation,
      lifecycle: 'starting',
      subject
    });
  }

  // ---- routing to a session's runtime ---------------------------------------
  /** Moor-native child output: absolute byte offset + raw bytes (§6.1). */
  onMoorOutput(sessionId: string, bytes: Uint8Array, offset: bigint): void {
    this.sessions.get(sessionId)?.runtime.onMoorOutput(bytes, offset);
  }

  /** Manager-originated channel error (for deferred input that lost its lease). */
  sendBrowserFrame(sessionId: string, channelId: number, frame: BpFrame): void {
    if (this.sessions.has(sessionId)) this.d.sendBrowser(sessionId, channelId, frame);
  }

  /** Apply non-durable terminal parser state before an attach becomes usable. */
  async onMasterTerminalState(sessionId: string, preamble: Uint8Array): Promise<boolean> {
    const runtime = this.sessions.get(sessionId)?.runtime;
    if (runtime === undefined) return false;
    await runtime.applyTerminalState(preamble);
    return true;
  }

  /**
   * Subscribe a surface, allocating a GLOBALLY-monotonic channelId (§7.4) so the
   * browser protocol's channelId-only frames route unambiguously even when one
   * WS subscribes to multiple sessions. The channelId→sessionId map lets INPUT
   * route by channelId alone; the WS-owner scoping is the router's job (§7.4 —
   * INPUT is accepted only from the connection that owns the channel).
   */
  subscribe(sessionId: string, surfaceId: string, rows: number, cols: number): number | undefined {
    const e = this.sessions.get(sessionId);
    if (e === undefined) return undefined;
    const channelId = this.nextChannelId++;
    e.runtime.subscribe(surfaceId, rows, cols, channelId);
    this.channelToSession.set(channelId, sessionId);
    return channelId;
  }

  /** The session that owns a channelId, or undefined if unknown/stale. */
  sessionOfChannel(channelId: number): string | undefined {
    return this.channelToSession.get(channelId);
  }

  onBrowserInput(sessionId: string, channelId: number, binary: boolean, bytes: Uint8Array): void {
    this.sessions.get(sessionId)?.runtime.onBrowserInput(channelId, binary, bytes);
  }

  /** Control-plane input injection (channels delivery). False if the session is unknown. */
  injectInput(sessionId: string, bytes: Uint8Array, paste = false): boolean {
    const e = this.sessions.get(sessionId);
    if (e === undefined) return false;
    return e.runtime.injectInput(bytes, paste);
  }

  /** The session's on-screen tail as plain text, or undefined if unknown. */
  tailText(sessionId: string, rows: number): string[] | undefined {
    return this.sessions.get(sessionId)?.runtime.tailText(rows);
  }

  /** Ranged history window (see SessionRuntime.historyText), undefined if unknown. */
  historyText(sessionId: string, rows: number, offset: number): { lines: string[]; totalAvailable: number } | undefined {
    return this.sessions.get(sessionId)?.runtime.historyText(rows, offset);
  }

  /** Route INPUT by channelId alone (the router validated ownership). No-op if stale. */
  onBrowserInputByChannel(channelId: number, binary: boolean, bytes: Uint8Array): boolean {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId === undefined) return false;
    return this.sessions.get(sessionId)?.runtime.onBrowserInput(channelId, binary, bytes) ?? false;
  }

  /** Unsubscribe a channel (drops the surface + the channel→session mapping). */
  unsubscribeChannel(channelId: number): void {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId !== undefined) this.sessions.get(sessionId)?.runtime.unsubscribe(channelId);
    this.channelToSession.delete(channelId);
  }

  /** Route a browser RESIZE by channelId (the router validated ownership). */
  onBrowserResizeByChannel(channelId: number, rows: number, cols: number): boolean {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId === undefined) return false;
    this.sessions.get(sessionId)?.runtime.onBrowserResize(channelId, rows, cols);
    return true;
  }

  /** Route a browser VISIBILITY by channelId. */
  onBrowserVisibilityByChannel(channelId: number, visible: boolean): boolean {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId === undefined) return false;
    this.sessions.get(sessionId)?.runtime.onBrowserVisibility(channelId, visible);
    return true;
  }

  /** Route a browser QUERY_REPLY by channelId (§7.7 — currently fail-closed drop). */
  onBrowserQueryReplyByChannel(channelId: number, queryOffset: bigint, leaseEpoch: number, bytes: Uint8Array): boolean {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId === undefined) return false;
    this.sessions.get(sessionId)?.runtime.onBrowserQueryReply(channelId, queryOffset, leaseEpoch, bytes);
    return true;
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
