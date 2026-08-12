// SessionManager (spec §3.2/§7.1) — the server-side composition that makes the
// daemon a complete session pipe: DaemonCore (pure registry) + a per-session
// MasterClient (the atch-master link) + browser fan-out. Ensures a session,
// attaches to its master socket, and wires master frames → SessionRuntime →
// browser and browser input → master. Node net lives only in MasterClient; the
// DaemonCore stays pure and is driven through its callbacks (no layering break).
//
// Testable against a fake v3 master today; the real atch binary drops in behind
// the same socket path once its master speaks v3.

import { createConnection } from 'node:net';
import { GenerationLedger } from '../../shared/controlPlane/generationLedger.js';
import { WorkerSupervisor } from '../../shared/runtime/workerSupervisor.js';
import { type EmulatorFactory } from '../../shared/runtime/emulatorPort.js';
import {
  DaemonCore,
  type DaemonAgentStateIntakeResult,
  type DaemonCoreDeps,
  type EnsureResult,
  type RestoreResult
} from '../../shared/runtime/daemonCore.js';
import {
  type AuthorityMutationResult,
  type SessionRegistration,
  type SessionStateSnapshot
} from '../../shared/controlPlane/index.js';
import { type BpFrame } from '../../shared/browserProtocol/index.js';
import { MasterClient } from './masterClient.js';
import { SpawnMasterError, spawnMaster } from './spawnMaster.js';
import { Role } from '../../shared/atchWire/frames.js';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { type AtchEvent } from './atchEvents.js';

interface KillCommandSpec {
  binPath: string;
  args: string[];
}

interface DetachedKillSpec extends KillCommandSpec {
  staleCleanupSpec?: KillCommandSpec;
}

interface DetachedKillRecord extends DetachedKillSpec {
  generation: number;
  sockPath: string;
  mustConfirm?: boolean;
}

export interface SessionSpawnPreparation {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SessionSpawnPreparationContext {
  sessionId: string;
  generation: number;
  args: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
}

export type PrepareSessionSpawn = (
  context: SessionSpawnPreparationContext
) => SessionSpawnPreparation | Promise<SessionSpawnPreparation>;

export type ProviderSessionProvisionRecoveryDetail =
  | 'not-authorized'
  | 'reset-incomplete'
  | 'authorization-consumed'
  | 'provider-mismatch'
  | 'generation-mismatch'
  | 'binding-mismatch'
  | 'invalid-provider-session-id'
  | 'session-not-found'
  | 'agent-mismatch';

export interface SessionSpawnPreallocationContext {
  sessionId: string;
  currentGeneration: number;
  nextGeneration: number;
  subject: SessionRegistration['subject'];
}

export type SessionSpawnPreallocationResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'provider-session-identity-missing';
      detail: ProviderSessionProvisionRecoveryDetail;
    };

export type PreallocateSessionSpawn = (
  context: SessionSpawnPreallocationContext
) => SessionSpawnPreallocationResult | Promise<SessionSpawnPreallocationResult>;

export type SessionSpawnResult =
  | EnsureResult
  | { ok: false; reason: 'spawn-failed' | 'attach-failed' }
  | Exclude<SessionSpawnPreallocationResult, { ok: true }>;

export interface TerminalObservationSnapshot {
  sessionId: string;
  generation: number;
  ready: boolean;
  readyAt: number | null;
  activity: 'working' | 'idle' | 'unknown';
  activityAt: number | null;
  title: string | null;
  link: { uri: string; at: number } | null;
  exit: { code: number; at: number } | null;
  updatedAt: number;
}

export type AtchObservationResult =
  | {
      ok: true;
      observation: TerminalObservationSnapshot;
      authority?: AuthorityMutationResult;
    }
  | {
      ok: false;
      reason:
        | 'session-not-found'
        | 'generation-mismatch'
        | 'lifecycle-exited'
        | 'invalid-event';
    };

export type RetireGenerationResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'session-not-found';
      expectedGeneration: number;
      error: string;
    }
  | {
      ok: false;
      reason: 'generation-mismatch';
      expectedGeneration: number;
      currentGeneration: number;
      error: string;
    }
  | {
      ok: false;
      reason: 'retire-failed';
      expectedGeneration: number;
      error: string;
    };

export type ProviderSessionResetLivenessResult<T> =
  | { ok: true; generation: number; value: T }
  | {
      ok: false;
      reason: 'session-live' | 'retire-failed';
      error: string;
    };

/**
 * Run a detached-master kill command to completion, BOUNDED: spawn error,
 * nonzero exit, or a hang past timeoutMs is a failure — an unbounded kill
 * would let retireAwaited hang before it ever reaches its socket poll.
 */
function runKillCommand(kill: KillCommandSpec, timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; error?: string }): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(kill.binPath, kill.args, { stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `kill spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      settle({ ok: false, error: `kill command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => settle({ ok: false, error: `kill spawn failed: ${error.message}` }));
    child.on('exit', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `kill command exited ${code ?? 'null'}` }));
  });
}

/** Poll until the master's socket disappears (bounded). */
async function waitForSocketGone(sockPath: string, timeoutMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(sockPath)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

export interface SessionManagerDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  /** Deliver a browser frame to a session's surface (the web-server WS wires this). */
  sendBrowser: (sessionId: string, channelId: number, frame: BpFrame) => void;
  workingLeaseMs?: DaemonCoreDeps['workingLeaseMs'];
  openToolLeaseMs?: DaemonCoreDeps['openToolLeaseMs'];
  initialAgentHealth?: DaemonCoreDeps['initialAgentHealth'];
  createAgentStateIntakeStore?: DaemonCoreDeps['createAgentStateIntakeStore'];
  onStateTransition?: DaemonCoreDeps['onStateTransition'];
}

export class SessionManager {
  private readonly core: DaemonCore;
  private readonly ledger: GenerationLedger;
  private readonly now: () => number;
  private readonly masters = new Map<string, MasterClient>();
  private readonly terminalObservations = new Map<string, TerminalObservationSnapshot>();
  /** Per-session teardown for a tracked FOREGROUND child (kill it on retire). */
  private readonly cleanups = new Map<string, () => void>();
  /**
   * Per-session stop command for a DETACHED master (+ its socket), so the
   * control-plane retire can AWAIT the kill's completion and the socket's
   * disappearance — a retire that returns before the master is gone lets an
   * immediate re-provision adopt the STALE socket at the old generation.
   */
  private readonly detachedKills = new Map<string, DetachedKillRecord>();
  /**
   * Ownership token per session, minted fresh by each spawn/restore operation.
   * Deferred callbacks from an OLD operation (a killed child's late 'exit', a
   * replaced master's close) must compare their token before retiring — a
   * plain sessionId callback would retire the SUCCESSOR session.
   */
  private readonly owners = new Map<string, symbol>();
  /**
   * In-flight provision per session: concurrent calls COALESCE onto one
   * operation (two Boot clicks = one spawn, both get its result). Interleaved
   * provisions would otherwise double-spawn against one socket, overwrite each
   * other's owner/cleanup, or kill the shared master from the loser's rollback.
   */
  private readonly inflight = new Map<string, Promise<SessionSpawnResult>>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(deps: SessionManagerDeps) {
    this.now = deps.now;
    this.ledger = deps.ledger;
    this.core = new DaemonCore({
      ledger: deps.ledger,
      supervisor: deps.supervisor,
      emulatorFactory: deps.emulatorFactory,
      now: deps.now,
      sendBrowser: deps.sendBrowser,
      // sendMaster routes to the session's attached master client, if any.
      sendMaster: (sessionId, frame) => this.masters.get(sessionId)?.send(frame),
      ...(deps.workingLeaseMs !== undefined ? { workingLeaseMs: deps.workingLeaseMs } : {}),
      ...(deps.openToolLeaseMs !== undefined
        ? { openToolLeaseMs: deps.openToolLeaseMs }
        : {}),
      ...(deps.initialAgentHealth !== undefined
        ? { initialAgentHealth: deps.initialAgentHealth }
        : {}),
      ...(deps.createAgentStateIntakeStore !== undefined
        ? { createAgentStateIntakeStore: deps.createAgentStateIntakeStore }
        : {}),
      ...(deps.onStateTransition !== undefined ? { onStateTransition: deps.onStateTransition } : {})
    });
  }

  ensure(
    sessionId: string,
    geometry: { rows: number; cols: number },
    subject: SessionRegistration['subject'] = { kind: 'terminal' }
  ): EnsureResult {
    const result = this.core.ensure(sessionId, geometry, subject);
    if (result.ok) this.ensureTerminalObservation(sessionId, result.generation);
    return result;
  }

  /**
   * Re-adopt a SURVIVING atch master after a daemon restart: restore the
   * session at its durable ledger generation (never allocate — the master owns
   * exactly that generation), attach over its socket, and register the
   * detached-master kill command so a later retire kills the master instead of
   * orphaning it. Fails closed (and rolls the restore back) when the attach
   * fails or the ledger has no generation for the sessionId.
   */
  async restoreAndAttach(
    sessionId: string,
    opts: {
      sockPath: string;
      geometry: { rows: number; cols: number };
      /** The detached-master stop command (e.g. `atch kill -f SOCK`). */
      killSpec: DetachedKillSpec;
      ackTimeoutMs?: number;
      subject?: SessionRegistration['subject'];
    }
  ): Promise<RestoreResult | { ok: false; reason: 'attach-failed' }> {
    const restored = this.core.restore(sessionId, opts.geometry, opts.subject ?? { kind: 'terminal' });
    if (!restored.ok) return restored;
    this.ensureTerminalObservation(sessionId, restored.generation);
    const token = Symbol('restore-op');
    this.owners.set(sessionId, token); // stale prior-op callbacks go inert
    // Register the kill command BEFORE the attach so a close that races the
    // attach's success can never leave an attached-but-unkillable master; the
    // attach itself only validates (it never closes a healthy master).
    this.detachedKills.set(sessionId, {
      ...opts.killSpec,
      generation: restored.generation,
      sockPath: opts.sockPath
    });
    let attached = false;
    try {
      // The ACK generation MUST equal the restored ledger generation — the
      // runtime stamps frames with it; any other ACK would split the fence.
      attached = await this.attachMaster(sessionId, opts.sockPath, opts.geometry, {
        expectGeneration: restored.generation,
        stillValid: () => this.owners.get(sessionId) === token,
        ...(opts.ackTimeoutMs !== undefined ? { ackTimeoutMs: opts.ackTimeoutMs } : {})
      });
    } catch {
      attached = false;
    }
    if (!attached) {
      // Roll back WITHOUT running the kill: a failed attach means we could not
      // adopt the master, not license to destroy it (it may be healthy and
      // rejecting us). Idempotent against a racing close-retire.
      this.detachedKills.delete(sessionId);
      this.core.retire(sessionId);
      this.dropTerminalObservation(sessionId, restored.generation);
      return { ok: false, reason: 'attach-failed' };
    }
    return restored;
  }

  /**
   * Attach to a session's atch master over its socket: connect, do the v3
   * controller handshake, and resolve ONLY on a validated ATTACH_ACK — a
   * written handshake is not an accepted one (the master may reject, error,
   * or close). With `expectGeneration`, an ACK carrying any other generation
   * fails the attach: the core runtime stamps frames with the restored ledger
   * generation, so adopting a different ACK generation would split the fence
   * (core INPUT at N, MasterClient RESIZE at M). A socket close AFTER a
   * successful attach retires the session; a close DURING the attach only
   * fails the attach — the master may be healthy and merely rejecting us, so
   * it must not be retired/killed.
   */
  async attachMaster(
    sessionId: string,
    sockPath: string,
    geometry: { rows: number; cols: number },
    opts: { expectGeneration?: number; ackTimeoutMs?: number; stillValid?: () => boolean } = {}
  ): Promise<boolean> {
    if (!this.core.hasLiveSession(sessionId)) return false;
    let attached = false;
    let terminalStateReady: Promise<boolean> = Promise.resolve(true);
    let settle: (ok: boolean) => void = () => undefined;
    const acked = new Promise<boolean>((resolve) => {
      let settled = false;
      settle = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
    });
    const client = new MasterClient(sockPath, {
      onRecord: (rec) => this.core.onMasterRecord(sessionId, rec),
      onTerminalState: (preamble) => {
        terminalStateReady = terminalStateReady
          .then((ready) => (ready ? this.core.onMasterTerminalState(sessionId, preamble) : false))
          .catch(() => false);
      },
      onAttachAck: (ack) => {
        const generation = (ack as { generation: number }).generation;
        const generationMatches = opts.expectGeneration === undefined || generation === opts.expectGeneration;
        void terminalStateReady.then(
          (ready) => settle(ready && generationMatches),
          () => settle(false)
        );
      },
      onError: () => settle(false),
      onClose: () => {
        settle(false);
        // Identity-bound: only the CURRENTLY-installed client's close retires;
        // a replaced client's late close must not tear down its successor.
        if (attached && this.masters.get(sessionId) === client) {
          this.retire(sessionId);
        }
      }
    });
    try {
      await client.connect();
    } catch {
      return false;
    }
    client.handshake({ role: Role.CONTROLLER, sessionId, rows: geometry.rows, cols: geometry.cols });
    const timeoutMs = opts.ackTimeoutMs ?? 5_000;
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    const ok = await acked;
    clearTimeout(timer);
    // Re-check AFTER the await: a concurrent retire may have torn the session
    // down while the ACK was in flight — installing the client then would
    // resurrect a retired session with its teardown already consumed.
    if (!ok || (opts.stillValid !== undefined && !opts.stillValid()) || !this.core.hasLiveSession(sessionId)) {
      client.close();
      return false;
    }
    attached = true;
    this.masters.set(sessionId, client);
    const snapshot = this.core.stateSnapshot(sessionId);
    if (snapshot === undefined || this.core.markRunning(sessionId, snapshot.generation).kind === 'rejected') {
      this.masters.delete(sessionId);
      attached = false;
      client.close();
      return false;
    }
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
      env?: NodeJS.ProcessEnv;
      sockPath: string;
      geometry: { rows: number; cols: number };
      readyTimeoutMs?: number;
      /** The launcher forks a detached master and exits (e.g. `atch start`). */
      detached?: boolean;
      /** For a detached master, the command to stop the session on retire (e.g. `atch kill -f NAME`). */
      killSpec?: DetachedKillSpec;
      subject?: SessionRegistration['subject'];
      preallocateSpawn?: PreallocateSessionSpawn;
      prepareSpawn?: PrepareSessionSpawn;
    }
  ): Promise<SessionSpawnResult> {
    const pending = this.inflight.get(sessionId);
    if (pending !== undefined) {
      return pending;
    }
    const operation = this.runSerializedLifecycle(sessionId, () =>
      this.doSpawnAndAttach(sessionId, opts)
    ).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, operation);
    return operation;
  }

  private async doSpawnAndAttach(
    sessionId: string,
    opts: {
      binPath: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
      sockPath: string;
      geometry: { rows: number; cols: number };
      readyTimeoutMs?: number;
      detached?: boolean;
      killSpec?: DetachedKillSpec;
      subject?: SessionRegistration['subject'];
      preallocateSpawn?: PreallocateSessionSpawn;
      prepareSpawn?: PrepareSessionSpawn;
    }
  ): Promise<SessionSpawnResult> {
    if (this.core.hasLiveSession(sessionId) && this.masters.has(sessionId)) {
      return this.ensure(sessionId, opts.geometry, opts.subject ?? { kind: 'terminal' }); // already provisioned AND attached — idempotent no-op
    }
    // Foreign-socket preflight BEFORE any durable allocation: ensure() would
    // advance the ledger to N+1 over a surviving generation-N master, fencing
    // it out of every future reconcile even though we never touch it.
    // spawnMaster repeats this check as the race-closing second gate.
    //
    // The test is whether a master is LISTENING, not whether the file exists.
    // A master that dies leaves its socket node behind, and treating that
    // leftover as a live owner wedges the session permanently: every later
    // start refuses until a human deletes the file. Refuse only for a socket
    // that actually accepts a connection; a refused connect means the owner
    // is gone and the stale node is ours to replace.
    if (opts.detached === true && existsSync(opts.sockPath)) {
      const probe = await probeSocketListener(opts.sockPath);
      if (probe !== 'dead') {
        // 'listener' — a live owner; 'unknown' — POSSIBLY a live owner that
        // was too slow to accept (desk#42): reclaiming on uncertainty
        // destroys a live session's rendezvous irreversibly. Refuse the
        // spawn instead; a later attempt under lower load will see the truth.
        return { ok: false, reason: 'spawn-failed' };
      }
      // No listener: the previous master is gone but its socket NODE survived —
      // e.g. a reboot that killed every holder yet kept /tmp (WSL preserves it
      // across restarts). This tombstone is not an owner, and both atch's own
      // bind() ("session is already running") and spawnMaster's existence gate
      // refuse an existing node regardless of liveness — so without removing it
      // here the session can NEVER respawn until a human deletes the file, which
      // is exactly the permanent wedge the comment above forbids. Reclaim it.
      // The root is private (0700, this user) and the spawn is serialized per
      // sessionId (inflight), so no concurrent owner can appear in the gap.
      try {
        unlinkSync(opts.sockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, reason: 'spawn-failed' };
        }
      }
    }
    const subject = opts.subject ?? { kind: 'terminal' };
    if (opts.preallocateSpawn !== undefined) {
      const currentGeneration = this.ledger.current(sessionId);
      const decision = await opts.preallocateSpawn({
        sessionId,
        currentGeneration,
        nextGeneration: currentGeneration + 1,
        subject
      });
      if (!decision.ok) return decision;
    }
    const ens = this.ensure(sessionId, opts.geometry, subject);
    if (!ens.ok) return ens;
    const token = Symbol('spawn-op');
    this.owners.set(sessionId, token);
    let spawnArgs = opts.args;
    let spawnEnv = opts.env;
    if (opts.prepareSpawn !== undefined) {
      try {
        const prepared = await opts.prepareSpawn({
          sessionId,
          generation: ens.generation,
          args: [...opts.args],
          env: { ...opts.env }
        });
        spawnArgs = prepared.args ?? spawnArgs;
        spawnEnv = { ...spawnEnv, ...prepared.env };
      } catch {
        if (this.owners.get(sessionId) === token) this.owners.delete(sessionId);
        if (ens.created) {
          this.core.retire(sessionId);
          this.dropTerminalObservation(sessionId, ens.generation);
        }
        return { ok: false, reason: 'spawn-failed' };
      }
    }
    let child: Awaited<ReturnType<typeof spawnMaster>>['child'];
    try {
      ({ child } = await spawnMaster({
        binPath: opts.binPath,
        args: spawnArgs,
        env: spawnEnv,
        sockPath: opts.sockPath,
        generation: ens.generation,
        readyTimeoutMs: opts.readyTimeoutMs,
        detached: opts.detached
      }));
    } catch (error) {
      // The master never came up. Run the kill ONLY when this operation could
      // have created one (SpawnMasterError.ownershipPossible): a clean-exit
      // timeout may have half-forked a master, but a pre-existing socket or a
      // nonzero launcher exit is a FOREIGN or never-forked master — killing
      // there would destroy someone else's session. Then free the slot THIS
      // call allocated so provision never leaks capacity.
      const ownershipPossible = error instanceof SpawnMasterError ? error.ownershipPossible : true;
      if (opts.detached === true && opts.killSpec !== undefined && ownershipPossible) {
        // Register FIRST, then attempt to confirmed completion: a failed or
        // unconfirmed cleanup RETAINS the record so a later control retire can
        // finish the job (a half-forked master may surface its socket late).
        const record = {
          ...opts.killSpec,
          generation: ens.generation,
          sockPath: opts.sockPath,
          mustConfirm: true
        };
        this.detachedKills.set(sessionId, record);
        await this.confirmKill(sessionId, record, 5_000);
      }
      if (ens.created) {
        this.core.retire(sessionId);
        this.dropTerminalObservation(sessionId, ens.generation);
      }
      return { ok: false, reason: 'spawn-failed' };
    }
    if (opts.detached) {
      // A detached master: the launcher exits normally (do NOT retire on that);
      // teardown is the kill command, if provided.
      if (opts.killSpec !== undefined) {
        this.detachedKills.set(sessionId, {
          ...opts.killSpec,
          generation: ens.generation,
          sockPath: opts.sockPath
        });
      }
    } else {
      // A tracked foreground child: retire when it exits, kill it on retire.
      // Token-bound: after retire + immediate respawn, the OLD child's late
      // exit must not retire the successor session.
      this.cleanups.set(sessionId, () => {
        if (child.exitCode === null) child.kill();
      });
      child.once('exit', () => {
        if (this.owners.get(sessionId) === token) {
          this.retire(sessionId);
        }
      });
    }
    // The ACK must carry exactly the generation this daemon injected at spawn
    // (§4.8.1) — anything else is a fenced/foreign master, not a success.
    const attached = await this.attachMaster(sessionId, opts.sockPath, opts.geometry, {
      expectGeneration: ens.generation,
      stillValid: () => this.owners.get(sessionId) === token
    });
    if (!attached) {
      // Kill ONLY the master this operation spawned — foreground child OR the
      // detached master it registered — wait for its socket to vanish, clear
      // every teardown entry this op made (no stale detachedKills), and free
      // the slot if this call allocated it. Never report ok for an unattached
      // session.
      await this.teardownFailedSpawn(sessionId, ens.created);
      return { ok: false, reason: 'attach-failed' };
    }
    return ens;
  }

  /**
   * Ownership-complete cleanup after a post-spawn failure: kill what THIS op
   * created. The kill record is deleted only on a CONFIRMED kill + socket
   * disappearance — a failed teardown keeps it registered so a later control
   * retire can retry, instead of stranding a detached master with no
   * teardown path at all (fail closed on the record, not just the verdict).
   */
  private async teardownFailedSpawn(sessionId: string, createdSlot: boolean): Promise<void> {
    const cleanup = this.cleanups.get(sessionId);
    this.cleanups.delete(sessionId);
    cleanup?.(); // foreground child kill (sync)
    const kill = this.detachedKills.get(sessionId);
    if (kill !== undefined) {
      // This op's master fate is uncertain — attempt to confirmed completion;
      // failure retains the record so a later control retire can retry it.
      kill.mustConfirm = true;
      await this.confirmKill(sessionId, kill, 5_000);
    }
    if (createdSlot) {
      const generation = this.terminalObservations.get(sessionId)?.generation;
      this.core.retire(sessionId);
      if (generation !== undefined) this.dropTerminalObservation(sessionId, generation);
    }
  }

  subscribe(sessionId: string, surfaceId: string, rows: number, cols: number): number | undefined {
    return this.core.subscribe(sessionId, surfaceId, rows, cols);
  }

  onBrowserInput(sessionId: string, channelId: number, binary: boolean, bytes: Uint8Array): void {
    // Route through the runtime (keeps it in the loop for lease enforcement); its
    // sendMaster callback forwards the built INPUT frame to the attached master.
    this.core.onBrowserInput(sessionId, channelId, binary, bytes);
  }

  /** Route INPUT by channelId alone (the router validated WS ownership, §7.4). */
  onBrowserInputByChannel(channelId: number, binary: boolean, bytes: Uint8Array): boolean {
    return this.core.onBrowserInputByChannel(channelId, binary, bytes);
  }

  /** Unsubscribe a channel (surface + channel→session mapping). */
  unsubscribeChannel(channelId: number): void {
    this.core.unsubscribeChannel(channelId);
  }

  /** Route a browser RESIZE by channelId (ownership validated by the router). */
  onBrowserResizeByChannel(channelId: number, rows: number, cols: number): boolean {
    return this.core.onBrowserResizeByChannel(channelId, rows, cols);
  }

  /** Route a browser VISIBILITY by channelId. */
  onBrowserVisibilityByChannel(channelId: number, visible: boolean): boolean {
    return this.core.onBrowserVisibilityByChannel(channelId, visible);
  }

  /** Route a browser QUERY_REPLY by channelId (§7.7). */
  onBrowserQueryReplyByChannel(channelId: number, queryOffset: bigint, leaseEpoch: number, bytes: Uint8Array): boolean {
    return this.core.onBrowserQueryReplyByChannel(channelId, queryOffset, leaseEpoch, bytes);
  }

  /** The session that owns a channelId, or undefined if unknown/stale. */
  sessionOfChannel(channelId: number): string | undefined {
    return this.core.sessionOfChannel(channelId);
  }

  /** Control-plane input injection (channels delivery). False if the session is unknown. */
  injectInput(sessionId: string, bytes: Uint8Array, paste = false): boolean {
    return this.core.injectInput(sessionId, bytes, paste);
  }

  /** The session's on-screen tail as plain text (capture-pane equivalent), or undefined. */
  tailText(sessionId: string, rows: number): string[] | undefined {
    return this.core.tailText(sessionId, rows);
  }

  historyText(sessionId: string, rows: number, offset: number): { lines: string[]; totalAvailable: number } | undefined {
    return this.core.historyText(sessionId, rows, offset);
  }

  observeAtchEvent(
    sessionId: string,
    generation: number,
    event: AtchEvent
  ): AtchObservationResult {
    if (!this.core.hasLiveSession(sessionId)) {
      return { ok: false, reason: 'session-not-found' };
    }
    const state = this.core.stateSnapshot(sessionId);
    if (state === undefined) return { ok: false, reason: 'session-not-found' };
    if (state.generation !== generation) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    if (state.lifecycle === 'exited') {
      return { ok: false, reason: 'lifecycle-exited' };
    }
    const at = Math.round(event.ts * 1_000);
    if (!Number.isSafeInteger(at) || at < 0) {
      return { ok: false, reason: 'invalid-event' };
    }

    const current = this.ensureTerminalObservation(sessionId, generation);
    const next = structuredClone(current);
    let authority: AuthorityMutationResult | undefined;

    switch (event.type) {
      case 'ready':
        if (next.readyAt !== null) {
          return { ok: true, observation: structuredClone(current) };
        }
        next.ready = true;
        next.readyAt = at;
        break;
      case 'state':
        if (next.activityAt !== null && at < next.activityAt) {
          return { ok: true, observation: structuredClone(current) };
        }
        authority = this.core.observeTitleActivity(
          sessionId,
          generation,
          event.state === 'busy' ? 'working' : 'idle',
          at
        );
        next.activity = event.state === 'busy' ? 'working' : 'idle';
        next.activityAt = at;
        next.title = event.title;
        break;
      case 'link':
        if (next.link !== null && at < next.link.at) {
          return { ok: true, observation: structuredClone(current) };
        }
        next.link = { uri: event.uri, at };
        break;
      case 'exit':
        authority = this.core.markExited(
          sessionId,
          generation,
          { code: event.code, signal: null },
          at
        );
        next.exit = { code: event.code, at };
        break;
    }

    next.updatedAt = Math.max(next.updatedAt, at);
    this.terminalObservations.set(sessionId, next);
    return {
      ok: true,
      observation: structuredClone(next),
      ...(authority === undefined ? {} : { authority })
    };
  }

  terminalObservation(sessionId: string): TerminalObservationSnapshot | undefined {
    const observation = this.terminalObservations.get(sessionId);
    return observation === undefined ? undefined : structuredClone(observation);
  }

  state(sessionId: string): SessionStateSnapshot | undefined {
    return this.core.state(sessionId);
  }

  stateSnapshot(sessionId: string): SessionStateSnapshot | undefined {
    return this.core.stateSnapshot(sessionId);
  }

  stateSnapshots(): { revision: number; snapshots: SessionStateSnapshot[] } {
    return this.core.stateSnapshots();
  }

  ingestAgentState(input: unknown): DaemonAgentStateIntakeResult {
    return this.core.ingestAgentState(input);
  }

  list(): SessionStateSnapshot[] {
    return this.core.list();
  }

  /**
   * Internal/synchronous teardown (socket-close, child-exit, dispose paths):
   * fire-and-forget the detached kill. The kill RECORD is retained — only a
   * CONFIRMED kill (retireAwaited) may consume it, so an unconfirmed teardown
   * never strands a master without a retriable teardown path. A retained
   * record after a successful fire-and-forget kill is harmless: the next
   * control retire sees the socket already gone and reads clean.
   */
  retire(sessionId: string): void {
    const kill = this.beginRetire(sessionId);
    if (kill !== undefined) {
      void runKillCommand(kill); // best effort — no caller to report to
    }
  }

  /**
   * Control-plane retire: AWAIT the kill command's completion AND the socket's
   * disappearance before reporting success — and consume the kill record ONLY
   * on that confirmation. Returning earlier lets an immediate re-provision see
   * the STALE socket as ready; deleting the record earlier means one failed
   * retire loses the ONLY teardown and the next retire reads falsely clean.
   */
  async retireAwaited(sessionId: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
    return this.runSerializedLifecycle(sessionId, () =>
      this.retireAwaitedUnlocked(sessionId, opts)
    );
  }

  private async retireAwaitedUnlocked(
    sessionId: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const kill = this.beginRetire(sessionId);
    if (kill === undefined) {
      return { ok: true };
    }
    return this.confirmKill(sessionId, kill, timeoutMs);
  }

  /**
   * Retire one exact native generation. A stale caller may observe a successor
   * under the same Desk session id, but it can never tear that successor down.
   */
  async retireGenerationAwaited(
    sessionId: string,
    expectedGeneration: number,
    opts: { timeoutMs?: number } = {}
  ): Promise<RetireGenerationResult> {
    return this.runSerializedLifecycle(sessionId, () =>
      this.retireGenerationAwaitedUnlocked(
        sessionId,
        expectedGeneration,
        opts
      )
    );
  }

  private async retireGenerationAwaitedUnlocked(
    sessionId: string,
    expectedGeneration: number,
    opts: { timeoutMs?: number } = {}
  ): Promise<RetireGenerationResult> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const snapshot = this.stateSnapshot(sessionId);
    const retainedKill = this.detachedKills.get(sessionId);
    const currentGeneration = snapshot?.generation ?? retainedKill?.generation;
    if (currentGeneration === undefined) {
      return {
        ok: false,
        reason: 'session-not-found',
        expectedGeneration,
        error: `session ${sessionId} has no native generation`
      };
    }
    if (currentGeneration !== expectedGeneration) {
      return {
        ok: false,
        reason: 'generation-mismatch',
        expectedGeneration,
        currentGeneration,
        error: `session ${sessionId} is generation ${currentGeneration}, not ${expectedGeneration}`
      };
    }

    const kill = snapshot === undefined ? retainedKill : this.beginRetire(sessionId);
    if (kill === undefined) {
      return { ok: true };
    }
    if (kill.generation !== expectedGeneration) {
      return {
        ok: false,
        reason: 'retire-failed',
        expectedGeneration,
        error: `session ${sessionId} retained kill generation ${kill.generation}, not ${expectedGeneration}`
      };
    }
    const result = await this.confirmKill(sessionId, kill, timeoutMs);
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          reason: 'retire-failed',
          expectedGeneration,
          error: result.error ?? 'retire failed'
        };
  }

  async resetForProviderSession<T>(
    sessionId: string,
    sockPath: string,
    transaction: (generation: number) => T | Promise<T>,
    opts: { timeoutMs?: number } = {}
  ): Promise<ProviderSessionResetLivenessResult<T>> {
    return this.runSerializedLifecycle(sessionId, async () => {
      const retired = await this.retireAwaitedUnlocked(sessionId, opts);
      if (!retired.ok) {
        return {
          ok: false,
          reason: 'retire-failed',
          error: retired.error ?? `session ${sessionId} could not be retired`
        };
      }
      if (existsSync(sockPath)) {
        const probe = await probeSocketListener(sockPath);
        if (probe === 'listener') {
          return {
            ok: false,
            reason: 'session-live',
            error: `session ${sessionId} still has a listening master`
          };
        }
        if (probe === 'unknown') {
          // Silence is not death (desk#42): never delete a rendezvous whose
          // owner might merely be slow. The retire fails closed and can be
          // retried when the probe can actually decide.
          return {
            ok: false,
            reason: 'retire-failed',
            error: `session ${sessionId} liveness is indeterminate under load — refusing to remove its socket`
          };
        }
        try {
          unlinkSync(sockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return {
              ok: false,
              reason: 'retire-failed',
              error: `could not remove stale socket for session ${sessionId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            };
          }
        }
      }
      const generation = this.ledger.current(sessionId);
      const value = await transaction(generation);
      return { ok: true, generation, value };
    });
  }

  private runSerializedLifecycle<T>(
    sessionId: string,
    operation: () => T | Promise<T>
  ): Promise<T> {
    const previous = this.lifecycleTails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.lifecycleTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(sessionId) === tail) {
        this.lifecycleTails.delete(sessionId);
      }
    });
    return current;
  }

  /**
   * Run a retained kill to CONFIRMATION: socket already gone reads clean; a
   * confirmed kill + disappearance consumes the record; any failure keeps it
   * for the next retry.
   */
  private async confirmKill(
    sessionId: string,
    kill: DetachedKillRecord,
    timeoutMs: number
  ): Promise<{ ok: boolean; error?: string }> {
    // The socket-absent shortcut applies ONLY to records whose master's fate
    // is certain. A mustConfirm record (an uncertain half-forked master, or a
    // record whose prior kill attempt failed) may see the socket ABSENT merely
    // because the master has not surfaced yet — reading that as clean would
    // delete the only teardown record and strand the late master.
    const wasUncertain = kill.mustConfirm === true;
    if (!wasUncertain && !existsSync(kill.sockPath)) {
      if (this.detachedKills.get(sessionId) === kill) {
        this.detachedKills.delete(sessionId);
      }
      return { ok: true };
    }
    const killed = await runKillCommand(kill, timeoutMs); // bounded: a hung kill fails, never blocks forever
    if (!killed.ok) {
      // A known, previously attached master can die before `atch kill` connects,
      // leaving a stale socket that makes kill exit 1. `atch rm` is the safe
      // discriminator here: it removes only a refused/dead socket and refuses a
      // live listener. Never use it for an already-uncertain half-forked master,
      // whose socket may not have surfaced yet.
      if (!wasUncertain) {
        if (!existsSync(kill.sockPath)) {
          if (this.detachedKills.get(sessionId) === kill) {
            this.detachedKills.delete(sessionId);
          }
          return { ok: true };
        }
        if (kill.staleCleanupSpec !== undefined) {
          const cleaned = await runKillCommand(kill.staleCleanupSpec, timeoutMs);
          if (cleaned.ok && (await waitForSocketGone(kill.sockPath, timeoutMs))) {
            if (this.detachedKills.get(sessionId) === kill) {
              this.detachedKills.delete(sessionId);
            }
            return { ok: true };
          }
        }
      }
      kill.mustConfirm = true; // fate now uncertain — no shortcut on later retries
      return killed; // record retained for retry
    }
    const gone = await waitForSocketGone(kill.sockPath, timeoutMs);
    if (!gone) {
      kill.mustConfirm = true;
      return { ok: false, error: `atch socket still present after kill: ${kill.sockPath}` }; // record retained
    }
    if (this.detachedKills.get(sessionId) === kill) {
      this.detachedKills.delete(sessionId);
    }
    return { ok: true };
  }

  /**
   * Shared teardown core: detach state, run the foreground cleanup, free the
   * slot. PEEKS the kill record without consuming it — consumption is the
   * confirming caller's decision.
   */
  private beginRetire(sessionId: string): DetachedKillRecord | undefined {
    this.owners.delete(sessionId); // any deferred old-operation callback goes stale
    this.masters.get(sessionId)?.close();
    this.masters.delete(sessionId);
    const cleanup = this.cleanups.get(sessionId);
    if (cleanup !== undefined) cleanup();
    this.cleanups.delete(sessionId);
    this.core.retire(sessionId);
    return this.detachedKills.get(sessionId);
  }

  private ensureTerminalObservation(
    sessionId: string,
    generation: number
  ): TerminalObservationSnapshot {
    const current = this.terminalObservations.get(sessionId);
    if (current !== undefined && current.generation === generation) return current;
    const observation: TerminalObservationSnapshot = {
      sessionId,
      generation,
      ready: false,
      readyAt: null,
      activity: 'unknown',
      activityAt: null,
      title: null,
      link: null,
      exit: null,
      updatedAt: this.now()
    };
    this.terminalObservations.set(sessionId, observation);
    return observation;
  }

  private dropTerminalObservation(sessionId: string, generation: number): void {
    if (this.terminalObservations.get(sessionId)?.generation === generation) {
      this.terminalObservations.delete(sessionId);
    }
  }

  get sessionCount(): number {
    return this.core.sessionCount;
  }
}

/**
 * Tri-state liveness probe for a unix socket path. 'listener' — a connect
 * succeeded, the owner is alive. 'dead' — the owner is PROVEN gone: only an
 * explicit ECONNREFUSED (bound node, nobody accepting) or ENOENT (no node)
 * counts. 'unknown' — everything else, including a timeout: a live master
 * under host load can simply be slow to accept, and silence proves nothing.
 * Callers MUST treat 'unknown' as possibly-live and MUST NOT destroy state
 * on it.
 */
type SocketProbeResult = 'listener' | 'dead' | 'unknown';

async function probeSocketListener(path: string, timeoutMs = 2000): Promise<SocketProbeResult> {
  return new Promise<SocketProbeResult>((resolve) => {
    const socket = createConnection({ path });
    const settle = (result: SocketProbeResult): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    // desk#42 (directly observed on the re-provisioned main-3): a live holder
    // under host load blew the old 250 ms budget, the boolean probe answered
    // "no listener", and the reclaim path unlinked the rendezvous socket of a
    // RUNNING session — permanently, since a deleted unix-socket path cannot
    // be re-linked. A probe can prove death only by an explicit refusal;
    // silence proves nothing. Timeout therefore maps to 'unknown', and only
    // ECONNREFUSED or ENOENT count as 'dead'.
    socket.setTimeout(timeoutMs, () => settle('unknown'));
    socket.once('connect', () => settle('listener'));
    socket.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      settle(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'dead' : 'unknown');
    });
  });
}
