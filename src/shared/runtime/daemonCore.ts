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
import { SessionRuntime, type CommandedGeometry } from './sessionRuntime.js';
import {
  InMemorySessionGeometryStore,
  SESSION_CREATION_GEOMETRY,
  type SessionGeometry,
  type SessionGeometryStore
} from './sessionGeometryStore.js';
import { createLeaseState, claim, release, type ClaimResult, type LeaseState } from '../lease/index.js';
import { decideStop } from './instanceLock.js';
import type { MoorExitOutcome, SessionExit } from '../controlPlane/contract.js';

/** desk#59 — the closed observation-failure vocabulary. */
export type ExitDiagnostic = NonNullable<SessionExit['diagnostic']>;

/**
 * desk#62 — the LOCAL screen a re-adopted session is rebuilt at when Desk never
 * commanded (journaled) a size for it. It is not a guess about the child: moor
 * creates a session with no viewer at exactly 80 columns by 24 rows (moor spec
 * §4.3), so an unrendered child's pty IS this size. It is used only to size
 * this daemon's own emulator; the adopting ATTACH carries
 * MOOR_PRESERVE_GEOMETRY, so the child is never told a size by the reconcile
 * pass.
 */
const UNRECORDED_SESSION_GEOMETRY: SessionGeometry = SESSION_CREATION_GEOMETRY;

export interface DaemonCoreDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  /** Route a browser frame to a session's surface (the socket shell wires the WS). */
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void;
  onSubscriberFailure?: (sessionId: string, channelId: number) => void;
  /** Typed master-bound sends, routed to the session's attached holder link. */
  sendMasterInput: (
    sessionId: string,
    bytes: Uint8Array,
    binary: boolean,
    surfaceId: number
  ) => boolean | void;
  sendMasterResize: (sessionId: string, rows: number, cols: number, surfaceId: number) => void;
  /**
   * desk#62 — where the last COMMANDED geometry is remembered across daemon
   * incarnations. Every commanded resize is recorded here, and restore() reads
   * it, so a re-adopted session comes back at the last commanded size — the
   * best available approximation of the pty until the protocol carries the
   * holder's pair (moor owns that truth). Defaults to a process-local store
   * (correct within one incarnation; a durable one is injected by the real
   * daemon).
   */
  sessionGeometry?: SessionGeometryStore;
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
  onStateTransitionError?: (error: unknown, transition: SessionStateTransition) => void;
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
  private readonly sessionGeometry: SessionGeometryStore;
  /** Global monotonic channelId allocator (§7.4) — never reused across sessions. */
  private nextChannelId = 1;
  /** channelId → owning sessionId, for channelId-only INPUT routing. */
  private readonly channelToSession = new Map<number, string>();

  constructor(deps: DaemonCoreDeps) {
    this.d = deps;
    this.sessionGeometry = deps.sessionGeometry ?? new InMemorySessionGeometryStore();
    this.authority = new AgentStateAuthority({
      now: deps.now,
      workingLeaseMs: deps.workingLeaseMs ?? 15_000,
      openToolLeaseMs: deps.openToolLeaseMs ?? 30 * 60_000,
      ...(deps.onStateTransition === undefined ? {} : { onTransition: deps.onStateTransition }),
      onTransitionError:
        deps.onStateTransitionError ??
        ((error, transition) => {
          console.error(
            `[desk] state transition sink failed for ${transition.sessionId} generation ${transition.generation} revision ${transition.revision}: ${error instanceof Error ? error.message : String(error)}`
          );
        })
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
    // desk#62: a NEW session's child is created at exactly this geometry —
    // Desk commanded it into existence at this size — so it is journaled like
    // any other commanded geometry; without this, a session that is booted and
    // never resized would come back with no record after a restart.
    this.sessionGeometry.record(sessionId, geometry);
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
        // Authority mutation failures below remain fatal; transition-sink
        // failures are reported after the committed state is retained.
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
      onSubscriberFailure: (channelId) => {
        try {
          // Core owns the channel mapping, resize-owner election, and durable
          // commanded-geometry journal. Complete that transition before the
          // outer socket shell drops its browser-local bookkeeping.
          this.unsubscribeChannels([channelId]);
        } finally {
          this.d.onSubscriberFailure?.(sessionId, channelId);
        }
      },
      sendMasterInput: (bytes, binary, surfaceId) =>
        this.d.sendMasterInput(sessionId, bytes, binary, surfaceId),
      sendMasterResize: (rows, cols, surfaceId) =>
        this.d.sendMasterResize(sessionId, rows, cols, surfaceId),
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
    subject: SessionRegistration['subject'] = { kind: 'terminal' }
  ): RestoreResult {
    if (this.sessions.has(sessionId)) return { ok: false, reason: 'already-live' };
    const generation = this.d.ledger.current(sessionId);
    if (generation === 0) return { ok: false, reason: 'no-generation' };

    const admit = this.d.supervisor.admit(sessionId, this.d.now());
    if (!admit.ok) return { ok: false, reason: 'cap-exceeded' };

    // desk#62: re-adoption takes NO geometry from its caller. The only size
    // this session may come back at is one Desk actually COMMANDED and
    // journaled; with no record, the local screen is built at moor's own
    // no-viewer creation size (spec §4.3) because that is exactly what an
    // unrendered child's pty is — and the ATTACH that adopts the holder
    // carries preserve either way, so neither value reaches the child.
    this.admitSession(
      sessionId,
      this.sessionGeometry.get(sessionId) ?? UNRECORDED_SESSION_GEOMETRY,
      generation,
      subject
    );
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
      entry.runtime.dispose();
    }
    this.sessions.delete(sessionId);
    // desk#62: retire is the ONE authoritative end of a session, so it is the
    // only place the remembered geometry may be dropped. A daemon detach or
    // shutdown must NOT reach here — a holder that survives this daemon must
    // come back at the last commanded size (the best approximation Desk has;
    // moor owns the pty's real size), which is the whole feature.
    this.sessionGeometry.forget(sessionId);
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
   * callers to remember. The outcome crosses this boundary as-is: the same
   * tagged value the durable record persists, `unknown` included.
   */
  emitExit(sessionId: string, outcome: MoorExitOutcome, outputEnd: bigint): void | Promise<void> {
    return this.sessions.get(sessionId)?.runtime.emitExit(outcome, outputEnd);
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
  onMoorOutput(sessionId: string, bytes: Uint8Array, offset: bigint): void | Promise<void> {
    return this.sessions.get(sessionId)?.runtime.onMoorOutput(bytes, offset);
  }

  pendingAuthoritativeWork(sessionId: string): Promise<void> | undefined {
    return this.sessions.get(sessionId)?.runtime.pendingAuthoritativeWork();
  }

  hasPendingExitBoundary(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.runtime.hasPendingExitBoundary() ?? false;
  }

  truncatePendingExit(
    sessionId: string
  ): { outputOffset: bigint; outputEnd: bigint } | undefined {
    return this.sessions.get(sessionId)?.runtime.truncatePendingExit();
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
  subscribe(
    sessionId: string,
    surfaceId: string,
    rows: number,
    cols: number
  ): { channelId: number; commanded?: CommandedGeometry } | undefined {
    const e = this.sessions.get(sessionId);
    if (e === undefined) return undefined;
    const channelId = this.nextChannelId++;
    this.channelToSession.set(channelId, sessionId);
    const result = e.runtime.subscribe(surfaceId, rows, cols, channelId);
    if (result === undefined || !this.channelToSession.has(channelId)) {
      this.channelToSession.delete(channelId);
      return undefined;
    }
    // desk#68: a subscribe that ACQUIRED ownership commanded the subscriber's
    // geometry; journal it like any other commanded resize, so the record
    // follows what was actually sent — never what a surface merely reported.
    if (result.commanded !== undefined) {
      this.recordCommandedGeometry(sessionId, result.commanded);
    }
    return result;
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

  /**
   * Unsubscribe a channel (drops the surface + the channel→session mapping).
   * Returns the geometry a resulting resize handoff commanded, if any (desk#68).
   */
  unsubscribeChannel(channelId: number): CommandedGeometry | undefined {
    return this.unsubscribeChannels([channelId])[0]?.commanded;
  }

  /**
   * Unsubscribe a SET of channels — one closing browser connection's — grouped
   * per session so each session's runtime removes ALL of its affected channels
   * before electing at most once (desk#68). Sequential per-channel removal
   * would transiently promote a dying sibling of the same connection and
   * command the child through it. Returns, per session that handed off, the
   * geometry the single election commanded (already journaled here).
   */
  unsubscribeChannels(channelIds: number[]): { sessionId: string; commanded: CommandedGeometry }[] {
    const bySession = new Map<string, number[]>();
    for (const channelId of channelIds) {
      const sessionId = this.channelToSession.get(channelId);
      this.channelToSession.delete(channelId);
      if (sessionId === undefined) continue;
      const group = bySession.get(sessionId);
      if (group === undefined) bySession.set(sessionId, [channelId]);
      else group.push(channelId);
    }
    const handoffs: { sessionId: string; commanded: CommandedGeometry }[] = [];
    for (const [sessionId, ids] of bySession) {
      const commanded = this.sessions.get(sessionId)?.runtime.unsubscribeMany(ids);
      if (commanded !== undefined) {
        this.recordCommandedGeometry(sessionId, commanded);
        handoffs.push({ sessionId, commanded });
      }
    }
    return handoffs;
  }

  /**
   * Route a browser RESIZE by channelId (the router validated ownership).
   * `commanded` carries the geometry the runtime selected and sent — absent for
   * an OBSERVER's resize, which the runtime records but never commands
   * (desk#68). `routed` keeps the old boolean meaning: whether the channel maps
   * to a known session. `accepted: false` distinguishes a mapped channel whose
   * runtime is already draining or fenced from an accepted observer resize.
   */
  onBrowserResizeByChannel(
    channelId: number,
    rows: number,
    cols: number
  ): { routed: boolean; accepted?: boolean; commanded?: CommandedGeometry } {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId === undefined) return { routed: false };
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return { routed: true };
    if (!entry.runtime.acceptsBrowserResize(channelId)) {
      return { routed: true, accepted: false };
    }
    const commanded = entry.runtime.onBrowserResize(channelId, rows, cols);
    if (commanded === undefined) return { routed: true };
    this.recordCommandedGeometry(sessionId, commanded);
    return { routed: true, commanded };
  }

  /**
   * Route a browser VISIBILITY by channelId. `commanded` carries the geometry a
   * resize handoff sent, if hiding the owner caused one (desk#68).
   */
  onBrowserVisibilityByChannel(
    channelId: number,
    visible: boolean
  ): { routed: boolean; commanded?: CommandedGeometry } {
    const sessionId = this.channelToSession.get(channelId);
    if (sessionId === undefined) return { routed: false };
    const commanded = this.sessions.get(sessionId)?.runtime.onBrowserVisibility(channelId, visible);
    if (commanded === undefined) return { routed: true };
    this.recordCommandedGeometry(sessionId, commanded);
    return { routed: true, commanded };
  }

  /**
   * desk#62: remember the size the moment it is COMMANDED, not at shutdown — a
   * daemon that is killed never runs shutdown code, and this journal is the only
   * thing that can tell the next incarnation how big this session was.
   *
   * What is stored is the geometry Desk commanded, which is all this journal has
   * ever held: the moor holder is the authority on the child's real pty, and
   * once the protocol carries the holder's pair in ATTACH_ACK/STATUS_REPLY this
   * journal is deleted outright. Read a record as "what the owner last asked
   * for", never as "the child is at this size now".
   *
   * desk#68: a surface that is not the resize owner produces no record at all —
   * persisting its reported size would write the resize war into a durable file.
   */
  private recordCommandedGeometry(sessionId: string, commanded: CommandedGeometry): void {
    this.sessionGeometry.record(sessionId, { rows: commanded.rows, cols: commanded.cols });
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
