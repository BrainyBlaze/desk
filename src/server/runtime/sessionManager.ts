// SessionManager (spec §3.2/§7.1) — the server-side composition that makes the
// daemon a complete session pipe: DaemonCore (pure registry) + a per-session
// Moor master link + browser fan-out. Ensures a session,
// attaches to its master socket, and wires master frames → SessionRuntime →
// browser and browser input → master. Unexpected controller loss creates one
// generation/owner-fenced recovery slot; only explicit control or positively
// proved holder absence ends authority. Node net lives only in the moor client;
// DaemonCore stays pure and is driven through callbacks (no layering break).
//
// The fake holder and the vendored Moor binary exercise the same v4 socket path.

import { createConnection } from 'node:net';
import { GenerationLedger } from '../../shared/controlPlane/generationLedger.js';
import { WorkerSupervisor } from '../../shared/runtime/workerSupervisor.js';
import { type EmulatorFactory } from '../../shared/runtime/emulatorPort.js';
import { type CommandedGeometry } from '../../shared/runtime/sessionRuntime.js';
import {
  DaemonCore,
  type DaemonAgentStateIntakeResult,
  type DaemonCoreDeps,
  type EnsureResult,
  type RestoreResult,
  type RetireReason,
  type ExitDiagnostic
} from '../../shared/runtime/daemonCore.js';
import {
  MOOR_UNADOPTED_REASON,
  type AuthorityMutationResult,
  type MoorExitOutcome,
  type SessionRegistration,
  type SessionStateSnapshot
} from '../../shared/controlPlane/index.js';
import { BpError, BpFrameType, type BpFrame } from '../../shared/browserProtocol/index.js';
import {
  MoorMasterClient,
  posixMoorIdentity,
  type MoorReconnectSnapshot
} from './moorMasterClient.js';
import { MOOR_PRESERVE_GEOMETRY, type MoorStatus } from '../../shared/moorWire/messages.js';
import { spawnMoorMaster } from './moorSpawnMaster.js';
import {
  rendezvousPathWithinCapacity,
  unixSocketPathCapacity
} from '../../shared/moorPaths.js';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { type MoorSessionEvent } from './moorEventObserver.js';

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
  | 'agent-mismatch'
  | 'provider-session-rebind-required'
  | 'continuity-store-failed';

export interface SessionSpawnPreallocationContext {
  sessionId: string;
  currentGeneration: number;
  nextGeneration: number;
  subject: SessionRegistration['subject'];
}

export type SessionSpawnPreallocationResult =
  | {
      ok: true;
      launchContext?: { providerLaunchProof: string };
    }
  | {
      ok: false;
      reason: 'provider-session-identity-missing';
      detail: ProviderSessionProvisionRecoveryDetail;
      action?: string;
    };

export type PreallocateSessionSpawn = (
  context: SessionSpawnPreallocationContext
) => SessionSpawnPreallocationResult | Promise<SessionSpawnPreallocationResult>;

export type SessionSpawnResult =
  | (EnsureResult & {
      /** OB-39: the holder's ATTACH_ACK descriptor for a successful moor join. */
      moorStatus?: MoorStatus;
    })
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
  exit: { code: number | null; at: number } | null;
  updatedAt: number;
}

export type MoorObservationResult =
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
 * The durable numeric view of an ending, derived where the record is written
 * and persisted ALONGSIDE the tagged outcome, never in its place: exited passes
 * its code through, signalled follows the POSIX shell 128+signal convention,
 * and an unprovable ending has no code at all -- null, not zero, because a zero
 * would be indistinguishable from a clean exit. Nothing on the browser path
 * reads this; the EXIT frame carries the outcome itself.
 */
function durableExitCode(outcome: MoorExitOutcome): number | null {
  switch (outcome.kind) {
    case 'exited':
      return outcome.code;
    case 'signalled':
      return 128 + outcome.signal;
    case 'unknown':
      return null;
  }
}

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
  onSubscriberFailure?: (channelId: number) => void;
  /** desk#62 — durable last-COMMANDED geometry per session (see DaemonCoreDeps). */
  sessionGeometry?: DaemonCoreDeps['sessionGeometry'];
  workingLeaseMs?: DaemonCoreDeps['workingLeaseMs'];
  openToolLeaseMs?: DaemonCoreDeps['openToolLeaseMs'];
  initialAgentHealth?: DaemonCoreDeps['initialAgentHealth'];
  createAgentStateIntakeStore?: DaemonCoreDeps['createAgentStateIntakeStore'];
  onStateTransition?: DaemonCoreDeps['onStateTransition'];
  /**
   * Accept an ATTACH_ACK-authorized late adoption only after its durable Moor
   * observer is installed. TerminalWsRouter requires this dependency; omission
   * is reserved for direct low-level, observer-free SessionManager compositions.
   */
  onLateMoorAdoption?: (sessionId: string, generation: number) => Promise<boolean>;
}

/**
 * The session's holder link: the typed master-bound surface the runtime sends
 * through. The link owns the wire (supervised moor frames) so neither the
 * runtime nor the core ever sees an encoded frame.
 */
export interface SessionMasterLink {
  sendInput(bytes: Uint8Array, binary: boolean, surfaceId: number, queuedAt: number): boolean;
  /** Re-send only the exact pending tuple whose lease this recovered link resumed. */
  retryPendingInput?(): void;
  cancelQueuedInput(surfaceId: number): void;
  sealInput(): void;
  sendResize(rows: number, cols: number, surfaceId: number): void;
  close(): void;
  /**
   * §9 wire terminate over the LIVE link — identity+generation+incarnation
   * fenced by the holder, so a stale request can never kill a successor.
   * Resolves the holder's outcome; a deadline expiry rejects (indeterminate).
   */
  terminateHolder?(opts?: {
    force?: boolean;
  }): Promise<'terminated' | 'already-gone' | 'refused' | 'indeterminate' | 'failed'>;
  /** §7.4 graceful release of the owned input lease. */
  releaseLease?(): Promise<'released' | 'refused'>;
  /**
   * §10.2.13 committed-log clear at the observed frontier. Success has TWO
   * normative shapes — cleared and already-empty-or-disabled; refused is a
   * COMPLETED holder decision, distinct from an indeterminate submission
   * (deadline, transport loss, malformed response).
   */
  clearHolderLog?(): Promise<HolderLogClearOutcome>;
  acquireViewerLease?(): Promise<'granted' | 'busy'>;
  hasViewerLease?(): boolean;
}

/** The full §10.2.13 result algebra a control-plane consumer branches on. */
export type HolderLogClearOutcome =
  | 'cleared'
  | 'already-clear'
  | 'refused'
  | 'indeterminate';

interface MoorRecoverySlot {
  readonly sessionId: string;
  readonly generation: number;
  readonly owner: symbol;
  readonly sessionPath: string;
  readonly geometry: { rows: number; cols: number };
  snapshot: MoorReconnectSnapshot | undefined;
  episode: number;
  attempt: number;
  timer?: NodeJS.Timeout;
  timerDueAt?: number;
  candidate?: MoorMasterClient;
  frontierWait?: Promise<void>;
  retainedInputQueuedAt?: number;
  inputQueue: Array<{
    bytes: Uint8Array;
    binary: boolean;
    surfaceId: number;
    queuedAt: number;
  }>;
  inputBytes: number;
  /** The one durable-observer acceptance transaction for this exact slot episode. */
  observerAcceptance?: Promise<boolean>;
  observer?: boolean;
  pendingResize?: { rows: number; cols: number; surfaceId: number };
}

const RECOVERY_BACKOFF_MS = [0, 100, 250, 500, 1_000, 2_000] as const;
const RECOVERY_INPUT_MAX_BYTES = 64 * 1024;
const RECOVERY_INPUT_MAX_AGE_MS = 10_000;

export class SessionManager {
  private readonly core: DaemonCore;
  private readonly ledger: GenerationLedger;
  private readonly now: () => number;
  private readonly onLateMoorAdoption: SessionManagerDeps['onLateMoorAdoption'];
  private readonly masters = new Map<string, SessionMasterLink>();
  /** OB-39: the last adopted ATTACH_ACK descriptor per session (holder truth). */
  private readonly moorStatuses = new Map<string, MoorStatus>();
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
  /** One exact-generation controller re-adoption slot per live session. */
  private readonly recoveries = new Map<string, MoorRecoverySlot>();
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
    this.onLateMoorAdoption = deps.onLateMoorAdoption;
    this.core = new DaemonCore({
      ledger: deps.ledger,
      supervisor: deps.supervisor,
      emulatorFactory: deps.emulatorFactory,
      now: deps.now,
      sendBrowser: deps.sendBrowser,
      onSubscriberFailure: (_sessionId, channelId) => {
        deps.onSubscriberFailure?.(channelId);
      },
      // Typed master-bound sends route to the session's attached holder link.
      sendMasterInput: (sessionId, bytes, binary, surfaceId) =>
        this.dispatchMasterInput(sessionId, bytes, binary, surfaceId),
      sendMasterResize: (sessionId, rows, cols, surfaceId) => {
        const recovery = this.recoveries.get(sessionId);
        if (
          recovery !== undefined &&
          this.recoveryCurrent(recovery, recovery.episode)
        ) {
          return;
        }
        this.masters.get(sessionId)?.sendResize(rows, cols, surfaceId);
      },
      ...(deps.sessionGeometry !== undefined ? { sessionGeometry: deps.sessionGeometry } : {}),
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
   * Re-adopt a SURVIVING moor holder after a daemon restart: restore the
   * session at its durable ledger generation (never allocate — the holder owns
   * exactly that generation, and the native client fences the adoption on it),
   * attach over the moor rendezvous, and register the detached-holder kill
   * command first so a close racing the attach can never leave an adopted-but-
   * unkillable holder. The adopted ATTACH_ACK status rides on the result — it
   * is the OB-39 event-store authority for restart reconciliation.
   *
   * desk#64 — a FAILED ATTACH IS NOT AN ENDED SESSION. This used to retire the
   * session as `restore-superseded` while deliberately NOT killing the holder:
   * the same code path admitted the holder might be alive and recorded the
   * session as over. `exited` then made channel delivery refuse it as
   * `offline` forever, with the queue held against a session that could never
   * become deliverable again — a live agent, deaf, with nothing reporting it.
   * The attach failure is now what it actually is: no link. The session stays
   * non-terminal with the unadopted health reason, and the SAME
   * generation/owner-fenced recovery slot the controller-link path uses keeps
   * trying. Only the probe's positive absence ends it.
   */
  async restoreAndAttachMoor(
    sessionId: string,
    opts: {
      /** Moor rendezvous path — `<root>/<sessionId>`, no suffix. */
      sessionPath: string;
      /** The detached-holder stop command (e.g. `moor kill -f SESSION`). */
      killSpec: DetachedKillSpec;
      subject?: SessionRegistration['subject'];
      /** §10 verified-live window override (default: the spec's 15 s). */
      livenessWindowMs?: number;
    }
  ): Promise<
    | (RestoreResult & { moorStatus?: MoorStatus })
    | {
        ok: false;
        reason: 'attach-failed';
        /**
         * desk#64 — true when the session was KEPT (non-terminal, unadopted,
         * re-attachment registered) instead of retired. The caller has no
         * adopted link and no ATTACH_ACK descriptor either way; this only says
         * whether a session still exists to be adopted later.
         *
         * FALSE is not a rollback: it means this operation no longer owns the
         * session (the authority refused the transition, or a newer operation
         * took over during the attach). It is reported rather than assumed,
         * because a caller told `retained: true` will describe a live,
         * retrying session to an operator — a claim this path must earn.
         */
        retained: boolean;
        generation: number;
      }
  > {
    const restored = this.core.restore(sessionId, opts.subject ?? { kind: 'terminal' });
    if (!restored.ok) return restored;
    this.ensureTerminalObservation(sessionId, restored.generation);
    const token = Symbol('restore-op');
    this.owners.set(sessionId, token); // stale prior-op callbacks go inert
    this.detachedKills.set(sessionId, {
      ...opts.killSpec,
      generation: restored.generation,
      sockPath: opts.sessionPath
    });
    /**
     * The geometry THIS re-adoption puts on the wire — and, when the attach
     * fails, the one its retry inherits. Deliberately ONE value: a retry that
     * asserted a different size than the adoption it is retrying would be
     * inventing a measurement nobody made. desk#62 replaces this expression
     * with `MOOR_PRESERVE_GEOMETRY` (the daemon cannot know a re-adopted
     * child's pty size — the §5 status descriptor carries none), and the retry
     * below picks that up with no change of its own.
     */
    const attachGeometry = MOOR_PRESERVE_GEOMETRY;
    let attached = false;
    try {
      // The native client fences the WHOLE §3/§6 exchange on the restored
      // ledger generation — a holder carrying any other generation fails the
      // attach instead of splitting the fence.
      attached = await this.moorAttachMaster(sessionId, opts.sessionPath, attachGeometry, {
        generation: restored.generation,
        stillValid: () => this.owners.get(sessionId) === token,
        ...(opts.livenessWindowMs === undefined
          ? {}
          : { livenessWindowMs: opts.livenessWindowMs })
      });
    } catch {
      attached = false;
    }
    if (!attached) {
      // Defensive, GENERATION-BOUND clear: adoption publishes authority only
      // after its final commit, so normally there is nothing to remove here.
      // If one is present anyway, it survives ONLY when it PROVABLY belongs to
      // another (successor) generation — an unattributable or same-generation
      // descriptor left behind by this failed restore is never authority.
      const stale = this.moorStatuses.get(sessionId);
      const successorAuthority =
        stale !== undefined &&
        Number.isInteger(stale.generation) &&
        stale.generation !== restored.generation;
      if (stale !== undefined && !successorAuthority) {
        this.moorStatuses.delete(sessionId);
      }
      // The kill record is KEPT: the session lives on, so the operator's
      // explicit retire must still have a teardown for this exact holder.
      // Dropping it here would leave a live holder nothing can stop.
      //
      // Lifecycle stays non-terminal AND becomes `running`, because lifecycle
      // states whether a session exists to receive — not whether Desk holds
      // its link. The controller-link recovery path already says exactly this:
      // a session whose link died stays `running` while its slot re-attaches.
      // `starting` would be the worse lie of the two: it reads as "booting,
      // wait", and the channels engine holds the queue on it just as silently
      // as on `exited`. The uncertainty belongs on the health axis, which is
      // where the operator reads it, and where the probe resolves it.
      //
      // The authority's ANSWER decides whether retention happened — this must
      // not assert a state it merely asked for. `rejected` is reachable here:
      // the attach above awaited real I/O, and in that window a concurrent
      // retire can have exited the session ('lifecycle-exited') or a successor
      // operation can have registered a newer generation
      // ('generation-mismatch'). ('session-not-found' cannot: the authority
      // never deletes a record it registered.) A `noop` — already running — is
      // success, not failure, and must stay that way.
      const running = this.core.markRunning(sessionId, restored.generation);
      if (running.kind === 'rejected') {
        return {
          ok: false,
          reason: 'attach-failed',
          retained: false,
          generation: restored.generation
        };
      }
      // Ownership is the second claim this path makes. A newer operation that
      // took the session during the attach owns its state and its recovery
      // slot; degrading health or arming a retry underneath it would fight a
      // successor with stale intentions.
      if (this.owners.get(sessionId) !== token) {
        return {
          ok: false,
          reason: 'attach-failed',
          retained: false,
          generation: restored.generation
        };
      }
      // `observeHolderLiveness` cannot be rejected here: no await separates it
      // from the checks above, the generation is the one the authority just
      // accepted, and the lifecycle it just committed is `running`. It is NOT
      // inert, though — committing a transition calls the authority's
      // `onTransition` consumer SYNCHRONOUSLY, and a consumer that re-enters
      // this manager (retiring, say) changes the world between here and the
      // slot below. That window is the only one left, which is exactly why
      // `retained` is read back from the map rather than taken on trust.
      this.core.observeHolderLiveness(
        sessionId,
        restored.generation,
        false,
        'restore-attach-failed',
        MOOR_UNADOPTED_REASON
      );
      this.beginRestoreRecovery({
        sessionId,
        sessionPath: opts.sessionPath,
        geometry: attachGeometry,
        generation: restored.generation,
        owner: token
      });
      // `retained` is the FACT, read back from the map — not the helper's
      // report of it. The two differ exactly when a guard inside declines
      // after this operation has already decided it is retaining the session,
      // and the caller repeats `retained: true` to an operator as "alive and
      // being re-attached to". A claim this operation can verify locally is
      // one it must never take on trust: the slot is retained only if it is
      // THERE, at this generation, under this operation's token.
      const slot = this.recoveries.get(sessionId);
      return {
        ok: false,
        reason: 'attach-failed',
        retained:
          slot !== undefined &&
          slot.owner === token &&
          slot.generation === restored.generation,
        generation: restored.generation
      };
    }
    const moorStatus = this.moorStatuses.get(sessionId);
    return moorStatus === undefined ? restored : { ...restored, moorStatus };
  }

  /**
   * Attach to a session's MOOR holder: supervised handshake at the
   * ledger-allocated generation (the frozen client enforces the §6 prefix,
   * identity, generation scope, and lease). Installs a MoorMasterLink whose
   * input path honors §7.3 one-in-flight by coalescing bytes queued behind
   * the outstanding request and flushing them on its receipt.
   */
  async moorAttachMaster(
    sessionId: string,
    sessionPath: string,
    geometry: { rows: number; cols: number },
    opts: {
      generation: number;
      stillValid?: () => boolean;
      livenessWindowMs?: number;
      resumeSnapshot?: MoorReconnectSnapshot;
      recoverySlot?: MoorRecoverySlot;
      recoveryEpisode?: number;
    }
  ): Promise<boolean> {
    if (!this.core.hasLiveSession(sessionId)) return false;
    let owner = this.owners.get(sessionId);
    if (owner === undefined) {
      owner = Symbol('attach-op');
      this.owners.set(sessionId, owner);
    }
    let link: SessionMasterLink | undefined;
    // Capture before any connect/attach await: visibility or unsubscribe can
    // revoke the mutable recovery snapshot after the client constructor copies
    // this tuple but before ATTACH finishes.
    const resumedPendingInput = opts.resumeSnapshot?.lease?.pendingInput;
    let attached = false;
    /** §6: parser preamble work must DRAIN before adoption is complete. */
    let terminalStateReady: Promise<boolean> = Promise.resolve(true);
    /** Frozen adoption order: no replay/live OUTPUT may touch the emulator
     *  before the preamble drains — buffer until the barrier passes. */
    let preambleDrained = false;
    const bufferedOutput: Array<{ bytes: Uint8Array; offset: bigint; sequence: bigint }> = [];
    /** §10 liveness episode: monotonically scoped so a LATE probe result can
     *  never mutate a restored or replaced episode. */
    let livenessEpisode = 0;
    let livenessEpisodeResolved = true;
    let armLivenessProbe: (episode: number) => void = () => undefined;
    /** Bytes queued behind the outstanding §7.3 input request. */
    let inputQueue: Array<{ bytes: Uint8Array; surfaceId: number; queuedAt: number }> = [];
    let inputSealed = false;
    let leaseReset: Promise<void> | undefined;
    let discardLeaseOnClose = false;
    let leaseResetResize: { rows: number; cols: number; surfaceId: number } | undefined;
    const queueInput = (bytes: Uint8Array, surfaceId: number, queuedAt: number): boolean => {
      const queuedBytes = inputQueue.reduce((sum, pending) => sum + pending.bytes.length, 0);
      if (queuedBytes + bytes.length > RECOVERY_INPUT_MAX_BYTES) return false;
      inputQueue.push({ bytes: bytes.slice(), surfaceId, queuedAt });
      return true;
    };
    const flushQueue = (client: MoorMasterClient): void => {
      if (inputSealed) return;
      const next = inputQueue.shift();
      if (next === undefined) return;
      if (this.now() - next.queuedAt >= RECOVERY_INPUT_MAX_AGE_MS) {
        this.sendInputUnavailable(sessionId, next.surfaceId);
        flushQueue(client);
        return;
      }
      try {
        client.sendInput(next.bytes, next.surfaceId);
      } catch {
        // Lease lost or link closed between receipt and flush: the queued
        // bytes cannot be delivered; the caller-visible state is the closed/
        // observer link, which every later send reports.
      }
    };
    const client: MoorMasterClient = new MoorMasterClient(
      sessionPath,
      opts.generation,
      {
        onOutput: (output) => {
          if (!preambleDrained) {
            bufferedOutput.push({
              bytes: output.bytes.slice(),
              offset: output.offset,
              sequence: output.sequence
            });
            return;
          }
          const acknowledge = (): void => {
            // Consumption is DELIVERY: acknowledge only after the record
            // actually reached the authoritative emulator, never at receipt —
            // an acked-but-undelivered record could be permanently dropped.
            try {
              client.ackOutput(output.sequence);
            } catch {
              /* link closed mid-batch: nothing to acknowledge */
            }
          };
          const delivered = this.core.onMoorOutput(sessionId, output.bytes, output.offset);
          if (delivered instanceof Promise) return delivered.then(acknowledge);
          acknowledge();
        },
        onTerminalState: (preamble: Uint8Array) => {
          terminalStateReady = terminalStateReady
            .then((ready) =>
              ready ? this.core.onMasterTerminalState(sessionId, preamble) : false
            )
            .catch(() => false);
          return terminalStateReady.then((ready) => {
            // The Moor client serializes this promise before the remaining
            // prefix and replay frames. Mark the barrier open here so replay
            // and later live OUTPUT cannot overtake terminal-state handling.
            if (ready) preambleDrained = true;
          });
        },
        onInputReceipt: () => flushQueue(client),
        onInputContinuityLost: (pending) => {
          const retained = opts.resumeSnapshot?.lease?.pendingInput;
          if (retained?.requestId === pending.requestId) {
            // A completed holder refusal is final for this exact retained
            // request. Recovery retries reuse the snapshot, so consume the
            // tuple before reporting its single caller-visible loss.
            delete opts.resumeSnapshot!.lease!.pendingInput;
          }
          console.error(
            `[desk] input continuity lost for ${sessionId} generation ${opts.generation} request ${pending.requestId} surface ${pending.surfaceId ?? 'unknown'}`
          );
          if (pending.surfaceId !== undefined && pending.surfaceId !== 0) {
            this.sendInputUnavailable(sessionId, pending.surfaceId);
          }
        },
        // §8 query arbitration: this controller is the lease-owning VT viewer
        // — the sole 250 ms responder. Cursor position (class 05) is
        // viewer-only and comes from the authoritative emulator (1-based on
        // the wire). Desk did NOT inject the terminal identity, so every
        // other class is honestly left to the holder's own
        // synthesis-or-silence rule.
        onQuery: (query) => {
          if (query.class !== 5) return;
          const cursor = this.core.cursor(sessionId);
          if (cursor === undefined) return;
          try {
            client.sendQueryReply(
              query.correlation,
              5,
              new TextEncoder().encode(`\u001b[${cursor.row + 1};${cursor.col + 1}R`)
            );
          } catch {
            // Lease or link lost between query and reply: §8 silence.
          }
        },
        onClose: () => {
          // A controller transport is not the holder. Losing the CURRENT link
          // replaces only link/status state with an exact-generation recovery
          // slot; it never retires, terminates, kills, or allocates.
          if (attached && link !== undefined && this.masters.get(sessionId) === link) {
            const reconnectSnapshot = client.reconnectSnapshot();
            this.beginControllerRecovery({
              sessionId,
              sessionPath,
              geometry,
              generation: opts.generation,
              owner,
              link,
              snapshot:
                discardLeaseOnClose && reconnectSnapshot !== undefined
                  ? {
                      output: {
                        sequence: reconnectSnapshot.output.sequence,
                        incarnation: reconnectSnapshot.output.incarnation.slice()
                      }
                    }
                  : reconnectSnapshot,
              queuedInput: inputQueue.map((pending) => ({
                bytes: pending.bytes.slice(),
                binary: false,
                surfaceId: pending.surfaceId,
                queuedAt: pending.queuedAt
              })),
              ...(leaseResetResize === undefined
                ? {}
                : { pendingResize: { ...leaseResetResize } })
            });
          }
        },
        // §10 (OB-30): losing the 15 s verified-live window never proves the
        // holder is gone — no teardown. The session becomes INDETERMINATE
        // immediately and STAYS indeterminate until the fresh bounded
        // IDENTITY probe (HELLO/HELLO_ACK on a new connection, identity +
        // generation fenced by the decoder) either completes an authenticated
        // exchange (→ restore) or positively establishes listener absence
        // (→ close, which retires through the identity-bound onClose). A
        // heartbeat alone NEVER clears the degradation — it only re-arms the
        // probe. Every application is fenced by the link identity AND a
        // monotonic episode token, so a late probe result can neither mutate
        // a successor nor re-degrade a later episode.
        onLivenessLost: () => {
          if (!attached || link === undefined || this.masters.get(sessionId) !== link) return;
          livenessEpisode += 1;
          livenessEpisodeResolved = false;
          this.core.observeHolderLiveness(sessionId, opts.generation, false, 'probe-pending');
          armLivenessProbe(livenessEpisode);
        },
        onLivenessRestored: () => {
          if (!attached || link === undefined || this.masters.get(sessionId) !== link) return;
          if (livenessEpisodeResolved) return;
          armLivenessProbe(livenessEpisode);
        }
      },
      // NOTE deliberately NO autoAckOutput: with the preamble barrier
      // buffering records, a receipt-time ack would confirm consumption
      // before delivery — the watermark is acknowledged manually above,
      // strictly after core delivery.
      {
        ...(opts.livenessWindowMs === undefined ? {} : { livenessWindowMs: opts.livenessWindowMs }),
        ...(opts.resumeSnapshot === undefined
          ? {}
          : {
              resumeCursor: {
                sequence: opts.resumeSnapshot.output.sequence,
                incarnation: opts.resumeSnapshot.output.incarnation
              },
              resumeLease: opts.resumeSnapshot.lease,
              requireSameIncarnation: true,
              requireReplayContinuity: true
            })
      }
    );
    if (
      opts.recoverySlot !== undefined &&
      opts.recoveryEpisode !== undefined &&
      this.recoveryCurrent(opts.recoverySlot, opts.recoveryEpisode)
    ) {
      opts.recoverySlot.candidate = client;
    }
    armLivenessProbe = (episode: number): void => {
      void probeMoorHolder(sessionPath, opts.generation).then((outcome) => {
        // Fenced twice: only the CURRENT link's CURRENT unresolved episode may
        // consume a probe result.
        if (this.masters.get(sessionId) !== link) return;
        if (episode !== livenessEpisode || livenessEpisodeResolved) return;
        if (outcome === 'authenticated-live') {
          // A completed authenticated exchange — the ONLY thing that restores.
          livenessEpisodeResolved = true;
          const recovery = this.recoveries.get(sessionId);
          if (
            recovery !== undefined &&
            this.recoveryCurrent(recovery, recovery.episode)
          ) {
            return;
          }
          this.core.observeHolderLiveness(sessionId, opts.generation, true);
          return;
        }
        if (outcome === 'absent') {
          livenessEpisodeResolved = true;
          this.endAuthorityForConfirmedAbsence(sessionId, opts.generation, owner);
          return;
        }
        this.core.observeHolderLiveness(sessionId, opts.generation, false, 'probe-indeterminate');
      });
    };
    let adopted: MoorStatus;
    try {
      await client.connect();
      adopted = await client.attach({ columns: geometry.cols, rows: geometry.rows, requestLease: true });
    } catch {
      client.close();
      return false;
    }
    // The §6 status ACK precedes terminal state on the wire. The client chains
    // terminal-state handling before every later prefix/replay frame; adoption
    // completes only after that work drains clean, then buffered replay/live
    // output reaches the emulator in arrival order. A failed drain discards it.
    if (!(await terminalStateReady)) {
      client.close();
      return false;
    }
    let deliveredWatermark = 0n;
    for (const pending of bufferedOutput.splice(0)) {
      await this.core.onMoorOutput(sessionId, pending.bytes, pending.offset);
      deliveredWatermark = pending.sequence;
    }
    if (deliveredWatermark > 0n) {
      try {
        client.ackOutput(deliveredWatermark); // one coalesced ack per released buffer
      } catch {
        /* link closed: nothing to acknowledge */
      }
    }
    // Re-check AFTER the await: a concurrent retire may have torn the session
    // down while the attach prefix was in flight.
    if (
      client.attached === false ||
      (opts.stillValid !== undefined && !opts.stillValid()) ||
      !this.core.hasLiveSession(sessionId)
    ) {
      client.close();
      return false;
    }
    attached = true;
    const retainedPendingInput =
      client.leaseContinuity === 'resumed'
        ? resumedPendingInput
        : undefined;
    let retainedInputRetried = false;
    const resetRevokedRetainedInputLease = (): void => {
      if (leaseReset !== undefined || retainedPendingInput === undefined) return;
      const copiedPending = client.reconnectSnapshot()?.lease?.pendingInput;
      if (copiedPending?.requestId !== retainedPendingInput.requestId) return;
      // Once the retained request loses browser authority, its old lease epoch
      // is also unusable: skipping the identical retry while keeping the
      // client's private pending slot would block every later request. Release
      // that epoch, acquire a fresh viewer lease, then flush only still-
      // authorized bytes. Any indeterminate exchange reconnects from output
      // continuity alone so the revoked tuple cannot be resurrected.
      discardLeaseOnClose = true;
      leaseReset = (async () => {
        try {
          const released = await client.releaseLease();
          if (released !== 'released') throw new Error('holder refused the revoked input lease release');
          const acquired = await client.acquireViewerLease();
          if (acquired !== 'granted') throw new Error('fresh viewer lease is busy after revoked input');
          if (inputSealed || this.masters.get(sessionId) !== link) {
            client.close();
            return;
          }
          discardLeaseOnClose = false;
          const pendingResize = leaseResetResize;
          leaseResetResize = undefined;
          if (pendingResize !== undefined) {
            client.sendResize(pendingResize.cols, pendingResize.rows);
          }
          flushQueue(client);
        } catch (error) {
          console.error(
            `[desk] revoked retained input lease reset failed for ${sessionId} generation ${opts.generation}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          client.close();
        } finally {
          leaseReset = undefined;
        }
      })();
    };
    const retryPendingInput =
      retainedPendingInput === undefined
        ? undefined
        : (): void => {
            if (retainedInputRetried) return;
            retainedInputRetried = true;
            // Input expiry or a completed continuity refusal consumes this
            // exact snapshot tuple; never recreate it from the client copy.
            if (opts.resumeSnapshot?.lease?.pendingInput !== retainedPendingInput) {
              resetRevokedRetainedInputLease();
              return;
            }
            try {
              client.retryPendingInput();
            } catch (error) {
              console.error(
                `[desk] pending input retry failed for ${sessionId} generation ${opts.generation}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          };
    link = {
      sendInput: (bytes, _binary, surfaceId, queuedAt) => {
        if (inputSealed) return false;
        if (leaseReset !== undefined || discardLeaseOnClose) {
          return queueInput(bytes, surfaceId, queuedAt);
        }
        try {
          client.sendInput(bytes, surfaceId);
          return true;
        } catch (error) {
          if (error instanceof Error && /in flight/.test(error.message)) {
            return queueInput(bytes, surfaceId, queuedAt);
          }
          return false;
        }
      },
      ...(retryPendingInput === undefined ? {} : { retryPendingInput }),
      cancelQueuedInput: (surfaceId) => {
        inputQueue = inputQueue.filter((pending) => pending.surfaceId !== surfaceId);
      },
      sealInput: () => {
        if (inputSealed) return;
        inputSealed = true;
        const queued = inputQueue;
        inputQueue = [];
        for (const pending of queued) {
          if (pending.surfaceId !== 0) {
            this.sendInputUnavailable(sessionId, pending.surfaceId);
          }
        }
      },
      sendResize: (rows, cols, surfaceId) => {
        if (inputSealed) return;
        if (leaseReset !== undefined || discardLeaseOnClose) {
          leaseResetResize = { rows, cols, surfaceId };
          return;
        }
        try {
          client.sendResize(cols, rows);
        } catch {
          // Observer or closed link: geometry stays local-only.
        }
      },
      close: () => client.close(),
      terminateHolder: async (terminateOpts) => {
        const result = await client.terminate(
          terminateOpts?.force === undefined ? {} : { force: terminateOpts.force }
        );
        switch (result.outcome) {
          case 0:
            return 'terminated';
          case 1:
            return 'already-gone';
          case 2:
            return 'refused';
          case 4:
            return 'failed';
          default:
            return 'indeterminate';
        }
      },
      releaseLease: () => client.releaseLease(),
      clearHolderLog: async () => {
        // §10.2.13 outcome algebra: 0 cleared, 1 already-empty-or-disabled
        // (BOTH are success), 2 refused (a completed holder decision).
        // Anything else — deadline, transport loss, malformed result — threw
        // before this point and maps to indeterminate at the caller.
        const result = await client.clearLog();
        switch (result.outcome) {
          case 0:
            return 'cleared';
          case 1:
            return 'already-clear';
          default:
            return 'refused';
        }
      },
      acquireViewerLease: () => client.acquireViewerLease(),
      hasViewerLease: () => client.leaseContinuity !== 'observer'
    };
    this.masters.set(sessionId, link);
    const snapshot = this.core.stateSnapshot(sessionId);
    const drainingObservedExit =
      snapshot?.generation === opts.generation &&
      snapshot.lifecycle === 'exited' &&
      this.core.hasPendingExitBoundary(sessionId);
    if (
      snapshot === undefined ||
      (!drainingObservedExit &&
        this.core.markRunning(sessionId, snapshot.generation).kind === 'rejected')
    ) {
      this.masters.delete(sessionId);
      attached = false;
      client.close();
      return false;
    }
    // The adopted descriptor becomes observable ONLY after the final
    // markRunning commit: a failed adoption never publishes authority, so no
    // failure path can leak a descriptor without a live adopted link.
    this.moorStatuses.set(sessionId, adopted);
    if (opts.recoverySlot?.candidate === client) opts.recoverySlot.candidate = undefined;
    return true;
  }

  private beginControllerRecovery(input: {
    sessionId: string;
    sessionPath: string;
    geometry: { rows: number; cols: number };
    generation: number;
    owner: symbol;
    link: SessionMasterLink;
    snapshot: MoorReconnectSnapshot | undefined;
    queuedInput: MoorRecoverySlot['inputQueue'];
    pendingResize?: MoorRecoverySlot['pendingResize'];
  }): void {
    if (this.masters.get(input.sessionId) !== input.link) return;
    if (this.owners.get(input.sessionId) !== input.owner) return;
    const state = this.core.stateSnapshot(input.sessionId);
    if (
      state === undefined ||
      state.generation !== input.generation ||
      (state.lifecycle === 'exited' && !this.core.hasPendingExitBoundary(input.sessionId))
    ) {
      return;
    }
    this.masters.delete(input.sessionId);
    this.moorStatuses.delete(input.sessionId);
    this.core.observeHolderLiveness(
      input.sessionId,
      input.generation,
      false,
      'controller-link-recovery'
    );
    this.openRecoverySlot(input);
  }

  /**
   * desk#64 — a restart re-adoption that never attached enters the SAME
   * re-attachment machinery as a lost controller link. It is the same
   * situation (a session with no link and a holder that may well be alive)
   * with the same fencing requirements, so it gets the same generation- and
   * owner-fenced slot rather than a second, subtly different one. There is no
   * resume snapshot and no queued input: nothing was ever adopted to resume.
   *
   * Deliberately returns nothing. An earlier revision returned "did I install
   * one?" and the caller reported that as retention — which put the caller's
   * honesty at the mercy of this function's control flow, when the caller can
   * simply LOOK. Both guards below can only fail through one window: the
   * synchronous `onTransition` consumer that the health degradation just
   * before this call invokes. They stay because the window is real, not
   * because the caller depends on their answer.
   */
  private beginRestoreRecovery(input: {
    sessionId: string;
    sessionPath: string;
    geometry: { rows: number; cols: number };
    generation: number;
    owner: symbol;
  }): void {
    if (this.owners.get(input.sessionId) !== input.owner) return;
    const state = this.core.stateSnapshot(input.sessionId);
    if (
      state === undefined ||
      state.generation !== input.generation ||
      state.lifecycle === 'exited'
    ) {
      return;
    }
    this.openRecoverySlot({ ...input, snapshot: undefined, queuedInput: [] });
  }

  /** Install (or replace) the session's single re-attachment slot and run it. */
  private openRecoverySlot(input: {
    sessionId: string;
    sessionPath: string;
    geometry: { rows: number; cols: number };
    generation: number;
    owner: symbol;
    snapshot: MoorReconnectSnapshot | undefined;
    queuedInput: MoorRecoverySlot['inputQueue'];
    pendingResize?: MoorRecoverySlot['pendingResize'];
  }): void {
    const previous = this.recoveries.get(input.sessionId);
    if (previous?.timer !== undefined) clearTimeout(previous.timer);
    const slot: MoorRecoverySlot = {
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      geometry: { ...input.geometry },
      generation: input.generation,
      owner: input.owner,
      snapshot: input.snapshot,
      episode: (previous?.episode ?? 0) + 1,
      attempt: 0,
      inputQueue: [...(previous?.inputQueue ?? []), ...input.queuedInput],
      inputBytes:
        (previous?.inputBytes ?? 0) +
        input.queuedInput.reduce((sum, pending) => sum + pending.bytes.length, 0),
      ...(previous?.retainedInputQueuedAt !== undefined
        ? { retainedInputQueuedAt: previous.retainedInputQueuedAt }
        : input.snapshot?.lease?.pendingInput === undefined
          ? {}
          : { retainedInputQueuedAt: this.now() }),
      ...(previous?.pendingResize !== undefined
        ? { pendingResize: { ...previous.pendingResize } }
        : input.pendingResize === undefined
          ? {}
          : { pendingResize: { ...input.pendingResize } })
    };
    this.recoveries.set(input.sessionId, slot);
    void this.runControllerRecovery(slot, slot.episode).catch((error) => {
      console.error(
        `[desk] controller recovery failed for ${input.sessionId} generation ${input.generation}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (this.recoveryCurrent(slot, slot.episode)) this.scheduleControllerRecovery(slot);
    });
  }

  private recoveryCurrent(slot: MoorRecoverySlot, episode: number): boolean {
    if (this.recoveries.get(slot.sessionId) !== slot || slot.episode !== episode) return false;
    if (this.owners.get(slot.sessionId) !== slot.owner) return false;
    const state = this.core.stateSnapshot(slot.sessionId);
    return (
      state !== undefined &&
      state.generation === slot.generation &&
      (state.lifecycle !== 'exited' || this.core.hasPendingExitBoundary(slot.sessionId))
    );
  }

  private async runControllerRecovery(slot: MoorRecoverySlot, episode: number): Promise<void> {
    if (!this.recoveryCurrent(slot, episode)) return;
    this.expireRecoveryInput(slot);
    if (slot.observerAcceptance !== undefined) {
      await slot.observerAcceptance;
      return;
    }
    if (this.waitForAuthoritativeWork(slot, episode)) return;
    const probe = await probeMoorHolder(slot.sessionPath, slot.generation, (candidate) => {
      if (this.recoveryCurrent(slot, episode)) slot.candidate = candidate;
    });
    if (slot.candidate !== undefined) slot.candidate = undefined;
    if (!this.recoveryCurrent(slot, episode)) return;
    if (probe === 'absent') {
      this.endAuthorityForConfirmedAbsence(slot.sessionId, slot.generation, slot.owner);
      return;
    }
    if (probe === 'indeterminate') {
      this.scheduleControllerRecovery(slot);
      return;
    }
    const attached = await this.moorAttachMaster(
      slot.sessionId,
      slot.sessionPath,
      MOOR_PRESERVE_GEOMETRY,
      {
        generation: slot.generation,
        resumeSnapshot: slot.snapshot,
        recoverySlot: slot,
        recoveryEpisode: episode,
        stillValid: () => this.recoveryCurrent(slot, episode)
      }
    );
    // `candidate` fences only an operation that is still in flight. A failed
    // attach closes its client before resolving, so retaining it here would
    // make the shared retry/deadline timer mistake a settled failure for live
    // work and suppress every later retry.
    if (slot.candidate !== undefined) slot.candidate = undefined;
    if (!this.recoveryCurrent(slot, episode)) return;
    if (!attached) {
      this.scheduleControllerRecovery(slot);
      return;
    }
    // The ATTACH_ACK descriptor is now published, but recovery is not yet
    // accepted: a daemon composition must install/reuse the durable event
    // observer before health, queued input, or pending geometry can advance.
    // Observer-only lease retries keep this exact slot and its acceptance promise,
    // so they never start a duplicate observer for one recovery episode.
    if (this.onLateMoorAdoption !== undefined) {
      await this.beginLateMoorAdoption(slot, episode);
      return;
    }
    // Explicit low-level observer-free compositions have no observer
    // transaction. Production routers require the callback at their boundary.
    this.continueRecoveredViewer(slot, episode);
  }

  /** Install one immutable acceptance promise before invoking the callback. */
  private beginLateMoorAdoption(
    slot: MoorRecoverySlot,
    episode: number
  ): Promise<boolean> {
    const existing = slot.observerAcceptance;
    if (existing !== undefined) return existing;
    const acceptance = Promise.resolve().then(() =>
      this.completeLateMoorAdoption(slot, episode)
    );
    slot.observerAcceptance = acceptance;
    return acceptance;
  }

  /** Own the callback, failure retirement, and sole successful slot release. */
  private async completeLateMoorAdoption(
    slot: MoorRecoverySlot,
    episode: number
  ): Promise<boolean> {
    let accepted = false;
    try {
      accepted = await this.onLateMoorAdoption!(slot.sessionId, slot.generation);
    } catch (error) {
      console.error(
        `[desk] late Moor adoption observer failed for ${slot.sessionId} generation ${slot.generation}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    // The callback was fenced when it began and is fenced again after its
    // await. A retire, replacement slot, new owner, successor generation, or
    // replayed exit makes this completion inert.
    if (!this.recoveryCurrent(slot, episode)) return false;
    if (!accepted) {
      const retired = await this.retireGenerationAwaited(
        slot.sessionId,
        slot.generation,
        { reason: 'moor-reconcile-failed' }
      );
      if (!retired.ok) {
        console.error(
          `[desk] could not retire unreconciled Moor adoption for ${slot.sessionId} generation ${slot.generation}: ${retired.error}`
        );
      }
      // Retirement failure retains its exact teardown record and retired
      // authority. Never resume recovery or release queued viewer work.
      return false;
    }
    if (!this.recoveryCurrent(slot, episode)) return false;
    this.continueRecoveredViewer(slot, episode);
    return true;
  }

  private continueRecoveredViewer(slot: MoorRecoverySlot, episode: number): void {
    if (!this.recoveryCurrent(slot, episode)) return;
    const link = this.masters.get(slot.sessionId);
    if (link?.hasViewerLease?.() === false) {
      slot.observer = true;
      this.scheduleControllerRecovery(slot);
      return;
    }
    this.finishRecoveredViewer(slot, link);
  }

  private waitForAuthoritativeWork(slot: MoorRecoverySlot, episode: number): boolean {
    const work = this.core.pendingAuthoritativeWork(slot.sessionId);
    if (work === undefined) return false;
    if (slot.frontierWait === work) return true;
    slot.frontierWait = work;
    this.armRecoveryInputExpiry(slot);
    void work.then(
      () => {
        if (slot.frontierWait !== work) return;
        slot.frontierWait = undefined;
        if (!this.recoveryCurrent(slot, episode)) return;
        void this.runControllerRecovery(slot, episode).catch((error) => {
          console.error(
            `[desk] controller recovery failed for ${slot.sessionId} generation ${slot.generation}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          if (this.recoveryCurrent(slot, episode)) this.scheduleControllerRecovery(slot);
        });
      },
      () => {
        // A rejected parser frontier is an indeterminate emulator state. Keep
        // the single slot-level marker and let queued-input expiry continue;
        // retrying the same bytes would multiply side effects without proof.
        if (slot.frontierWait === work) this.expireRecoveryInput(slot);
      }
    );
    return true;
  }

  private finishRecoveredViewer(
    slot: MoorRecoverySlot,
    link: SessionMasterLink | undefined
  ): void {
    if (this.core.hasPendingExitBoundary(slot.sessionId)) {
      for (const pending of slot.inputQueue.splice(0)) {
        slot.inputBytes -= pending.bytes.length;
        this.sendInputUnavailable(slot.sessionId, pending.surfaceId);
      }
      if (slot.timer !== undefined) clearTimeout(slot.timer);
      this.recoveries.delete(slot.sessionId);
      return;
    }
    link?.retryPendingInput?.();
    if (link !== undefined && slot.pendingResize !== undefined) {
      const resize = slot.pendingResize;
      link.sendResize(resize.rows, resize.cols, resize.surfaceId);
    }
    for (const pending of slot.inputQueue.splice(0)) {
      slot.inputBytes -= pending.bytes.length;
      if (
        this.now() - pending.queuedAt >= RECOVERY_INPUT_MAX_AGE_MS ||
        link === undefined ||
        !link.sendInput(pending.bytes, pending.binary, pending.surfaceId, pending.queuedAt)
      ) {
        this.sendInputUnavailable(slot.sessionId, pending.surfaceId);
      }
    }
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    this.recoveries.delete(slot.sessionId);
    this.core.observeHolderLiveness(slot.sessionId, slot.generation, true);
  }

  private async runObserverLeaseRecovery(slot: MoorRecoverySlot, episode: number): Promise<void> {
    if (!this.recoveryCurrent(slot, episode)) return;
    this.expireRecoveryInput(slot);
    const link = this.masters.get(slot.sessionId);
    if (link?.acquireViewerLease === undefined) {
      this.scheduleControllerRecovery(slot);
      return;
    }
    const outcome = await link.acquireViewerLease();
    if (!this.recoveryCurrent(slot, episode)) return;
    if (outcome === 'busy') {
      this.scheduleControllerRecovery(slot);
      return;
    }
    slot.observer = false;
    this.finishRecoveredViewer(slot, link);
  }

  /**
   * Positive authenticated-probe absence ends authority without using either
   * destructive path. `core.retire` records the exact reason and triggers the
   * existing issue-59 final observer drain; no cleanup, TERMINATE, or retained
   * CLI kill is invoked.
   */
  private endAuthorityForConfirmedAbsence(
    sessionId: string,
    generation: number,
    owner: symbol
  ): void {
    if (this.owners.get(sessionId) !== owner) return;
    const state = this.core.stateSnapshot(sessionId);
    if (state === undefined || state.generation !== generation) return;
    const finalOutputPending =
      state.lifecycle === 'exited' && this.core.hasPendingExitBoundary(sessionId);
    if (state.lifecycle === 'exited' && !finalOutputPending) return;
    if (finalOutputPending) {
      const truncated = this.core.truncatePendingExit(sessionId);
      if (truncated === undefined) return;
      this.core.refineExitDiagnostic(sessionId, generation, {
        code: 'moor-final-output-truncated',
        detail:
          `holder unavailable at output offset ${truncated.outputOffset}; ` +
          `expected ${truncated.outputEnd}`
      });
    }
    const recovery = this.recoveries.get(sessionId);
    if (recovery?.timer !== undefined) clearTimeout(recovery.timer);
    this.recoveries.delete(sessionId);
    this.owners.delete(sessionId);
    const link = this.masters.get(sessionId);
    this.masters.delete(sessionId);
    this.moorStatuses.delete(sessionId);
    this.cleanups.delete(sessionId);
    this.detachedKills.delete(sessionId);
    link?.close();
    this.core.retire(sessionId, 'confirmed-holder-absence');
  }

  private scheduleControllerRecovery(slot: MoorRecoverySlot): void {
    this.expireRecoveryInput(slot);
    if (!this.recoveryCurrent(slot, slot.episode)) return;
    slot.attempt += 1;
    const delay = RECOVERY_BACKOFF_MS[Math.min(slot.attempt, RECOVERY_BACKOFF_MS.length - 1)]!;
    this.armControllerRecoveryTimer(slot, delay);
  }

  private armControllerRecoveryTimer(slot: MoorRecoverySlot, delay: number): void {
    if (!this.recoveryCurrent(slot, slot.episode)) return;
    const dueAt = this.now() + delay;
    if (
      slot.timer !== undefined &&
      slot.timerDueAt !== undefined &&
      slot.timerDueAt <= dueAt
    ) {
      return;
    }
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    const episode = slot.episode;
    slot.timerDueAt = dueAt;
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      slot.timerDueAt = undefined;
      if (!this.recoveryCurrent(slot, episode)) return;
      this.expireRecoveryInput(slot);
      // Keep the same single timer armed at the oldest queued input's exact
      // deadline while a bounded probe/attach candidate owns the slot.
      this.armRecoveryInputExpiry(slot);
      if (slot.candidate !== undefined) return;
      const run = slot.observer
        ? this.runObserverLeaseRecovery(slot, episode)
        : this.runControllerRecovery(slot, episode);
      void run.catch((error) => {
        console.error(
          `[desk] controller recovery retry failed for ${slot.sessionId} generation ${slot.generation}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (this.recoveryCurrent(slot, episode)) this.scheduleControllerRecovery(slot);
      });
    }, delay);
    slot.timer.unref?.();
  }

  private dispatchMasterInput(
    sessionId: string,
    bytes: Uint8Array,
    binary: boolean,
    surfaceId: number
  ): boolean {
    const recovery = this.recoveries.get(sessionId);
    if (
      recovery !== undefined &&
      this.recoveryCurrent(recovery, recovery.episode)
    ) {
      // Control-plane input must answer synchronously; it cannot claim success
      // for bytes merely deferred behind uncertain lease ownership.
      if (surfaceId === 0) return false;
      if (bytes.length === 0 || recovery.inputBytes + bytes.length > RECOVERY_INPUT_MAX_BYTES) {
        return false;
      }
      recovery.inputQueue.push({
        bytes: bytes.slice(),
        binary,
        surfaceId,
        queuedAt: this.now()
      });
      recovery.inputBytes += bytes.length;
      this.armRecoveryInputExpiry(recovery);
      return true;
    }
    const link = this.masters.get(sessionId);
    return link?.sendInput(bytes, binary, surfaceId, this.now()) ?? false;
  }

  private armRecoveryInputExpiry(slot: MoorRecoverySlot): void {
    const oldest = slot.inputQueue[0];
    const oldestQueuedAt =
      oldest === undefined
        ? slot.retainedInputQueuedAt
        : slot.retainedInputQueuedAt === undefined
          ? oldest.queuedAt
          : Math.min(oldest.queuedAt, slot.retainedInputQueuedAt);
    if (oldestQueuedAt === undefined) return;
    this.armControllerRecoveryTimer(
      slot,
      Math.max(0, oldestQueuedAt + RECOVERY_INPUT_MAX_AGE_MS - this.now())
    );
  }

  private expireRecoveryInput(slot: MoorRecoverySlot): void {
    const cutoff = this.now() - RECOVERY_INPUT_MAX_AGE_MS;
    if (slot.retainedInputQueuedAt !== undefined && slot.retainedInputQueuedAt <= cutoff) {
      const retained = slot.snapshot?.lease?.pendingInput;
      if (retained !== undefined) {
        delete slot.snapshot!.lease!.pendingInput;
        if (retained.surfaceId !== undefined && retained.surfaceId !== 0) {
          this.sendInputUnavailable(slot.sessionId, retained.surfaceId);
        }
      }
      slot.retainedInputQueuedAt = undefined;
    }
    while (slot.inputQueue[0]?.queuedAt <= cutoff) {
      const expired = slot.inputQueue.shift()!;
      slot.inputBytes -= expired.bytes.length;
      this.sendInputUnavailable(slot.sessionId, expired.surfaceId);
    }
  }

  private sealInputForObservedExit(sessionId: string): void {
    this.masters.get(sessionId)?.sealInput();
    const recovery = this.recoveries.get(sessionId);
    if (recovery === undefined || !this.recoveryCurrent(recovery, recovery.episode)) return;
    for (const pending of recovery.inputQueue.splice(0)) {
      recovery.inputBytes -= pending.bytes.length;
      this.sendInputUnavailable(sessionId, pending.surfaceId);
    }
    recovery.pendingResize = undefined;
  }

  private sendInputUnavailable(sessionId: string, channelId: number): void {
    try {
      this.core.sendBrowserFrame(sessionId, channelId, {
        type: BpFrameType.ERROR,
        channelId,
        code: BpError.INPUT_UNAVAILABLE
      });
    } catch (error) {
      console.error(
        `[desk] could not report unavailable terminal input for ${sessionId}/${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Ensure a session, SPAWN its supervised moor holder, and attach natively.
   *
   * The moor contract this encodes:
   * - the ledger generation travels as the fd-3 launch record plus both env
   *   carriers (spawnMoorMaster), never as bare env supervision;
   * - the launcher awaits store adoption → ready internally, so its EXIT 0 is
   *   the readiness signal — there is no socket polling;
   * - the rendezvous is `<root>/<sessionId>` (no suffix), published by rename,
   *   so a listener-less leftover node is a reclaimable tombstone exactly as
   *   before, and a live listener is a foreign holder to refuse;
   * - teardown is the moor `kill` command via the same confirmed-kill records.
   */
  async spawnAndAttachMoor(
    sessionId: string,
    opts: {
      binPath: string;
      /** Interpreter/loader argv BEFORE the moor CLI (empty for the native binary). */
      binArgs?: string[];
      /** The moor rendezvous path `<root>/<sessionId>` — no `.sock` suffix. */
      sessionPath: string;
      /** The child command line (moor start operands after the session path). */
      command: string[];
      geometry: { rows: number; cols: number };
      env?: NodeJS.ProcessEnv;
      /** Launcher-completion budget (adoption → ready happens inside it). */
      readyTimeoutMs?: number;
      killSpec?: DetachedKillSpec;
      subject?: SessionRegistration['subject'];
      preallocateSpawn?: PreallocateSessionSpawn;
      /** Prepare the per-generation `-T` committed-store directory. */
      prepareSpawn?: (input: {
        sessionId: string;
        generation: number;
      }) => Promise<{ storeDir?: string }> | { storeDir?: string };
      /** §10 verified-live window override (default: the spec's 15 s). */
      livenessWindowMs?: number;
    }
  ): Promise<SessionSpawnResult> {
    const pending = this.inflight.get(sessionId);
    if (pending !== undefined) return pending;
    const operation = this.runSerializedLifecycle(sessionId, () =>
      this.doSpawnAndAttachMoor(sessionId, opts)
    ).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, operation);
    return operation;
  }

  private async doSpawnAndAttachMoor(
    sessionId: string,
    opts: Parameters<SessionManager['spawnAndAttachMoor']>[1]
  ): Promise<SessionSpawnResult> {
    if (this.recoveries.has(sessionId)) {
      return { ok: false, reason: 'attach-failed' };
    }
    if (this.core.hasLiveSession(sessionId) && this.masters.has(sessionId)) {
      return this.ensure(sessionId, opts.geometry, opts.subject ?? { kind: 'terminal' });
    }
    if (this.core.hasLiveSession(sessionId)) {
      return { ok: false, reason: 'attach-failed' };
    }
    // A launch this daemon cannot tear down must not happen — and the refusal
    // must precede EVERY effect: no rendezvous mutation, no stateful
    // preallocation hook (the provider path consumes an authorization there),
    // no durable allocation. (The type stays optional only so the refusal is
    // observable behavior, not a compile error.)
    if (opts.killSpec === undefined) {
      return { ok: false, reason: 'spawn-failed' };
    }
    // The rendezvous path IS the §1.2 canonical session identity: a
    // noncanonical spelling would spawn a holder Desk can never attach to —
    // refuse it before any allocation or launch, as a result, not a throw.
    try {
      posixMoorIdentity(opts.sessionPath);
    } catch {
      return { ok: false, reason: 'spawn-failed' };
    }
    // A rendezvous whose ABSOLUTE path exceeds the platform Unix-domain sun_path
    // capacity (macOS 103, Linux 107 bytes) is bindable by the holder relative
    // to its parent (spec 2.2) yet unreachable by Desk's absolute node:net
    // connect: libuv truncates the address into sun_path and connect(2) then
    // fails ENOENT on a spelling no holder published. Refuse before any
    // allocation or launch, as a result -- so a ready-but-unaddressable holder
    // is never created -- and name the cause explicitly, since the generic
    // spawn-failed reason cannot carry it.
    if (!rendezvousPathWithinCapacity(opts.sessionPath)) {
      console.error(
        `moor rendezvous is unaddressable by node:net on ${process.platform}: ` +
          `${Buffer.byteLength(opts.sessionPath, 'utf8')} bytes exceeds the ` +
          `${unixSocketPathCapacity()}-byte sun_path ceiling; shorten ` +
          `DESK_MOOR_SOCKET_ROOT or the session name — ${opts.sessionPath}`
      );
      return { ok: false, reason: 'spawn-failed' };
    }
    // Foreign-rendezvous preflight BEFORE any durable allocation (same wedge
    // logic as ever), with the no-follow type/identity fence: only a SOCKET
    // node can be a moor tombstone. Anything else at the path — a regular
    // file, directory, or symlink — is foreign data this daemon must never
    // delete; staleness must be POSITIVE (socket + no listener), not assumed.
    let rendezvousNode: ReturnType<typeof lstatSync> | undefined;
    try {
      rendezvousNode = lstatSync(opts.sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: 'spawn-failed' };
      }
    }
    if (rendezvousNode !== undefined) {
      if (!rendezvousNode.isSocket()) {
        return { ok: false, reason: 'spawn-failed' };
      }
      // Staleness must be POSITIVE: only a refused connect proves the owner is
      // gone. A live listener or ANY indeterminate outcome (permissions,
      // timeout) preserves the node and refuses the spawn.
      if ((await probeRendezvous(opts.sessionPath)) !== 'stale') {
        return { ok: false, reason: 'spawn-failed' };
      }
      // TOCTOU identity fence: re-lstat immediately before unlink and require
      // the SAME socket (dev+inode+type) the probe judged stale — a node
      // republished in the probe window is not ours to delete.
      try {
        const recheck = lstatSync(opts.sessionPath);
        if (
          !recheck.isSocket() ||
          recheck.dev !== rendezvousNode.dev ||
          recheck.ino !== rendezvousNode.ino
        ) {
          return { ok: false, reason: 'spawn-failed' };
        }
        unlinkSync(opts.sessionPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, reason: 'spawn-failed' };
        }
        // ENOENT: the tombstone vanished on its own — the path is free.
      }
    }
    const subject = opts.subject ?? { kind: 'terminal' };
    let launchContext: Extract<SessionSpawnPreallocationResult, { ok: true }>['launchContext'];
    if (opts.preallocateSpawn !== undefined) {
      const decision = await opts.preallocateSpawn({
        sessionId,
        currentGeneration: this.ledger.current(sessionId),
        // The fence must see EXACTLY the generation the spawn will own
        // (OB-18: a fresh lineage allocates 2), or the provider claim
        // contract is broken before the real allocation.
        nextGeneration: this.ledger.next(sessionId),
        subject
      });
      if (!decision.ok) return decision;
      launchContext = decision.launchContext;
    }
    const ens = this.ensure(sessionId, opts.geometry, subject);
    if (!ens.ok) return ens;
    const token = Symbol('spawn-op');
    this.owners.set(sessionId, token);
    let storeDir: string | undefined;
    if (opts.prepareSpawn !== undefined) {
      try {
        ({ storeDir } = await opts.prepareSpawn({ sessionId, generation: ens.generation }));
      } catch {
        if (this.owners.get(sessionId) === token) this.owners.delete(sessionId);
        if (ens.created) {
          this.core.retire(sessionId, 'spawn-prepare-failed');
          this.dropTerminalObservation(sessionId, ens.generation);
        }
        return { ok: false, reason: 'spawn-failed' };
      }
    }
    const args = [
      ...(opts.binArgs ?? []),
      'start',
      ...(storeDir === undefined ? [] : ['-T', storeDir]),
      opts.sessionPath,
      ...opts.command
    ];
    // Launch + readiness: the moor launcher validates the record, forks the
    // holder, awaits store adoption then ready, and exits 0 — or reports the
    // failure with a nonzero exit leaving no published rendezvous behind.
    const ready = await new Promise<'ready' | 'failed' | 'timeout'>((resolve) => {
      let launcher: ReturnType<typeof spawnMoorMaster>['child'];
      try {
        ({ child: launcher } = spawnMoorMaster({
          binPath: opts.binPath,
          args,
          generation: ens.generation,
          ...(launchContext === undefined
            ? {}
            : { providerLaunchProof: launchContext.providerLaunchProof }),
          ...(opts.env === undefined ? {} : { env: opts.env })
        }));
      } catch {
        resolve('failed');
        return;
      }
      const timer = setTimeout(() => {
        try {
          launcher.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve('timeout');
      }, opts.readyTimeoutMs ?? 10_000);
      timer.unref?.();
      launcher.once('error', () => {
        clearTimeout(timer);
        resolve('failed');
      });
      launcher.once('exit', (code: number | null) => {
        clearTimeout(timer);
        resolve(code === 0 ? 'ready' : 'failed');
      });
    });
    if (ready !== 'ready') {
      // A clean nonzero exit means the launcher itself rolled back (no
      // rendezvous is left behind) — a kill is needed only if one is visible.
      // A TIMEOUT means the holder's fate is UNCERTAIN even when the path is
      // absent at this instant: the launcher may have forked a holder that
      // publishes late. Retain the kill record unconditionally there and arm
      // a bounded reaper for a late publication — instantaneous absence must
      // never drop the only teardown authority.
      const uncertain = ready === 'timeout';
      if (uncertain || existsSync(opts.sessionPath)) {
        const record = {
          ...opts.killSpec,
          generation: ens.generation,
          sockPath: opts.sessionPath,
          mustConfirm: true
        };
        this.detachedKills.set(sessionId, record);
        const confirmed = await this.confirmKill(sessionId, record, 5_000);
        if (uncertain && !confirmed.ok) {
          this.armLatePublicationReaper(sessionId, record);
        }
      }
      if (ens.created) {
        this.core.retire(sessionId, 'spawn-failed');
        this.dropTerminalObservation(sessionId, ens.generation);
      }
      return { ok: false, reason: 'spawn-failed' };
    }
    if (opts.killSpec !== undefined) {
      this.detachedKills.set(sessionId, {
        ...opts.killSpec,
        generation: ens.generation,
        sockPath: opts.sessionPath
      });
    }
    const attached = await this.moorAttachMaster(sessionId, opts.sessionPath, opts.geometry, {
      generation: ens.generation,
      stillValid: () => this.owners.get(sessionId) === token,
      ...(opts.livenessWindowMs === undefined
        ? {}
        : { livenessWindowMs: opts.livenessWindowMs })
    });
    if (!attached) {
      await this.teardownFailedSpawn(sessionId, ens.created);
      return { ok: false, reason: 'attach-failed' };
    }
    const moorStatus = this.moorStatuses.get(sessionId);
    return moorStatus === undefined ? ens : { ...ens, moorStatus };
  }

  /** OB-39: the last adopted ATTACH_ACK descriptor, if this session joined moor. */
  moorStatus(sessionId: string): MoorStatus | undefined {
    return this.moorStatuses.get(sessionId);
  }

  /**
   * Shutdown fence: settle every in-flight spawn/lifecycle operation that
   * could still INSTALL a master link. Called after the control plane stops
   * admitting new work, so once this resolves the master map is final and
   * the lease handover snapshot below cannot miss a late grant.
   */
  async awaitInflightSpawns(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }

  /**
   * Shutdown link closure (AFTER the awaited lease handover): every viewer
   * connection is closed so the departing process leaves no half-open
   * sockets. The map is cleared FIRST — each link's onClose retires only
   * while it is still the registered link, so this mass closure detaches
   * without retiring: the holders survive the daemon by design.
   */
  closeAllLinks(): void {
    for (const recovery of this.recoveries.values()) {
      if (recovery.timer !== undefined) clearTimeout(recovery.timer);
      recovery.candidate?.close();
    }
    this.recoveries.clear();
    const links = [...this.masters.values()];
    this.masters.clear();
    this.moorStatuses.clear();
    for (const link of links) {
      try {
        link.close();
      } catch {
        // Already torn down.
      }
    }
  }

  /**
   * §7.4 graceful handover on daemon departure: release every owned lease AND
   * WAIT for the released results (each bounded by the client's 2 s release
   * deadline) so the holders — which SURVIVE this daemon — can grant the next
   * incarnation a fresh lease immediately instead of waiting out the 10 s
   * responsiveness expiry. Every outcome is reported to the caller:
   * 'refused' is the holder's completed decision, 'indeterminate' a release
   * whose result never arrived — neither is silently dropped.
   */
  async releaseAllLeases(): Promise<
    Array<{ sessionId: string; outcome: 'released' | 'refused' | 'indeterminate' }>
  > {
    const owners = [...this.masters.entries()].filter(
      ([, link]) => link.releaseLease !== undefined
    );
    return Promise.all(
      owners.map(async ([sessionId, link]) => {
        try {
          return { sessionId, outcome: await link.releaseLease!() };
        } catch {
          return { sessionId, outcome: 'indeterminate' as const };
        }
      })
    );
  }

  /**
   * §10.2.13: clear the surviving holder's committed log at the frontier this
   * controller observed. The FULL algebra is preserved for the control-plane
   * caller: 'no-link' (nothing attached that could clear), the holder's own
   * cleared / already-clear / refused decisions, and 'indeterminate' when a
   * submission got no valid complete result (deadline, transport loss,
   * malformed echo) — nothing may be assumed about it.
   */
  async clearHolderLog(
    sessionId: string
  ): Promise<HolderLogClearOutcome | 'no-link'> {
    const link = this.masters.get(sessionId);
    if (link?.clearHolderLog === undefined) return 'no-link';
    try {
      return await link.clearHolderLog();
    } catch {
      return 'indeterminate';
    }
  }

  /**
   * Bounded late-publication reaper for a TIMED-OUT launch: the holder may
   * surface its rendezvous after the launcher was killed. While the record is
   * still the CURRENT one for the session, watch the path; the moment it
   * appears, run the confirmed kill. Past the window the record simply stays
   * registered (retriable by control retire) — it is never dropped here.
   */
  private armLatePublicationReaper(
    sessionId: string,
    record: DetachedKillRecord,
    windowMs = 5_000
  ): void {
    const deadline = Date.now() + windowMs;
    const tick = async (): Promise<void> => {
      if (this.detachedKills.get(sessionId) !== record) return; // superseded
      if (existsSync(record.sockPath)) {
        await this.confirmKill(sessionId, record, 5_000);
        return;
      }
      if (Date.now() < deadline) {
        const timer = setTimeout(() => void tick(), 100);
        timer.unref?.();
      }
    };
    const timer = setTimeout(() => void tick(), 100);
    timer.unref?.();
  }

  /**
   * Ownership-complete cleanup after a post-spawn failure: kill what THIS op
   * created. The kill record is deleted only on a CONFIRMED kill + socket
   * disappearance — a failed teardown keeps it registered so a later control
   * retire can retry, instead of stranding a detached master with no
   * teardown path at all (fail closed on the record, not just the verdict).
   */
  private async teardownFailedSpawn(sessionId: string, createdSlot: boolean): Promise<void> {
    // No moorStatuses clear here: adoption publishes authority only AFTER its
    // final markRunning commit, so a failed spawn never published one — and a
    // session-wide delete could erase a racing successor's authority.
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
      this.core.retire(sessionId, 'spawn-aborted');
      if (generation !== undefined) this.dropTerminalObservation(sessionId, generation);
    }
  }

  subscribe(sessionId: string, surfaceId: string, rows: number, cols: number): number | undefined {
    const result = this.core.subscribe(sessionId, surfaceId, rows, cols);
    if (result === undefined) return undefined;
    // desk#68: a subscribe that ACQUIRED ownership commanded the subscriber's
    // geometry — carry it into an in-flight link recovery like any other
    // commanded resize, so the recovered link is told the owner's real size.
    if (result.commanded !== undefined) {
      this.noteCommandedGeometry(sessionId, result.commanded);
    }
    return result.channelId;
  }

  onBrowserInput(sessionId: string, channelId: number, binary: boolean, bytes: Uint8Array): void {
    // Route through the runtime (keeps it in the loop for lease enforcement); its
    // sendMaster callback forwards the built INPUT frame to the attached master.
    this.core.onBrowserInput(sessionId, channelId, binary, bytes);
  }

  /** Route INPUT by channelId alone (the router validated WS ownership, §7.4). */
  onBrowserInputByChannel(channelId: number, binary: boolean, bytes: Uint8Array): boolean {
    return this.dispatchBrowserInputByChannel(channelId, binary, bytes) === undefined;
  }

  /** Return the caller-visible ERROR code, or undefined when INPUT was accepted. */
  dispatchBrowserInputByChannel(
    channelId: number,
    binary: boolean,
    bytes: Uint8Array
  ): BpError | undefined {
    const sessionId = this.core.sessionOfChannel(channelId);
    if (sessionId === undefined) return BpError.BAD_CHANNEL;
    if (this.core.hasPendingExitBoundary(sessionId)) return BpError.INPUT_UNAVAILABLE;
    if (this.core.onBrowserInputByChannel(channelId, binary, bytes)) return undefined;
    const link = this.masters.get(sessionId);
    return link?.hasViewerLease?.() === false
      ? BpError.STALE_LEASE
      : BpError.INPUT_UNAVAILABLE;
  }

  /** Unsubscribe a channel (surface + channel→session mapping). */
  unsubscribeChannel(channelId: number): void {
    this.unsubscribeChannels([channelId]);
  }

  /**
   * Unsubscribe a SET of channels — one closing browser connection's — in bulk
   * (desk#68): per-channel queue cleanup first, then the core removes every
   * channel before any resize handoff election runs, so a dying sibling of the
   * same connection can never be transiently promoted and command the child.
   */
  unsubscribeChannels(channelIds: number[]): void {
    for (const channelId of channelIds) {
      const sessionId = this.core.sessionOfChannel(channelId);
      if (sessionId !== undefined) this.revokeQueuedBrowserInput(sessionId, channelId);
    }
    for (const handoff of this.core.unsubscribeChannels(channelIds)) {
      // A departing owner handed off: the successor's geometry is what a
      // recovered link must be told (desk#68).
      this.noteCommandedGeometry(handoff.sessionId, handoff.commanded);
    }
  }

  /** Route a browser RESIZE by channelId (ownership validated by the router). */
  onBrowserResizeByChannel(channelId: number, rows: number, cols: number): boolean {
    const sessionId = this.core.sessionOfChannel(channelId);
    if (sessionId === undefined) return false;
    const outcome = this.core.onBrowserResizeByChannel(channelId, rows, cols);
    if (!outcome.routed || outcome.accepted === false) return false;
    // desk#68: replay only what was COMMANDED. An observer's resize was never
    // sent anywhere, so queueing it for the recovered link would put the very
    // size the runtime refused onto the child the moment the link came back.
    if (outcome.commanded !== undefined) {
      this.noteCommandedGeometry(sessionId, outcome.commanded);
    }
    return true;
  }

  /** Route a browser VISIBILITY by channelId. */
  onBrowserVisibilityByChannel(channelId: number, visible: boolean): boolean {
    const sessionId = this.core.sessionOfChannel(channelId);
    const outcome = this.core.onBrowserVisibilityByChannel(channelId, visible);
    if (!visible && sessionId !== undefined && outcome.routed) {
      this.revokeQueuedBrowserInput(sessionId, channelId);
    }
    if (sessionId !== undefined && outcome.commanded !== undefined) {
      this.noteCommandedGeometry(sessionId, outcome.commanded);
    }
    return outcome.routed;
  }

  /** Revoke bytes accepted while this browser surface still held input authority. */
  private revokeQueuedBrowserInput(sessionId: string, channelId: number): void {
    const recovery = this.recoveries.get(sessionId);
    if (recovery !== undefined) {
      recovery.inputQueue = recovery.inputQueue.filter((pending) => {
        if (pending.surfaceId !== channelId) return true;
        recovery.inputBytes -= pending.bytes.length;
        return false;
      });
      const retained = recovery.snapshot?.lease?.pendingInput;
      if (retained?.surfaceId === channelId) {
        delete recovery.snapshot!.lease!.pendingInput;
        recovery.retainedInputQueuedAt = undefined;
      }
    }
    this.masters.get(sessionId)?.cancelQueuedInput(channelId);
  }

  /** Carry a COMMANDED geometry into an in-flight link recovery (§7.5, desk#68). */
  private noteCommandedGeometry(sessionId: string, commanded: CommandedGeometry): void {
    const recovery = this.recoveries.get(sessionId);
    if (recovery === undefined || !this.recoveryCurrent(recovery, recovery.episode)) return;
    recovery.geometry.rows = commanded.rows;
    recovery.geometry.cols = commanded.cols;
    // The surfaceId is the OWNING channel the runtime resized under — after a
    // handoff that is the promoted surface, not the one that hid or left.
    recovery.pendingResize = { rows: commanded.rows, cols: commanded.cols, surfaceId: commanded.surfaceId };
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

  observeMoorEvent(
    sessionId: string,
    generation: number,
    event: MoorSessionEvent
  ): MoorObservationResult {
    const state = this.core.stateSnapshot(sessionId);
    if (state === undefined) return { ok: false, reason: 'session-not-found' };
    if (state.generation !== generation) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    // desk#59: the holder's real exit routinely lands AFTER Desk tore the
    // session down, and retire() deletes the runtime entry — so a live-session
    // guard here discarded the only evidence of how the child actually died.
    // A retired generation stays observable for exactly one purpose: letting
    // its own exit strengthen the placeholder. The generation check above still
    // fences a successor, so this can never reach into N+1.
    if (!this.core.hasLiveSession(sessionId)) {
      const retired =
        state.lifecycle === 'exited' && state.exit?.origin === 'retired';
      if (!retired || event.type !== 'exit') {
        return { ok: false, reason: 'session-not-found' };
      }
    }
    // desk#59: an exited session is settled EXCEPT for the one correction that
    // matters — the holder's own exit strengthening a teardown placeholder.
    const strengthening =
      state.lifecycle === 'exited' &&
      state.exit?.origin === 'retired' &&
      event.type === 'exit';
    if (state.lifecycle === 'exited' && !strengthening) {
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
      case 'exit': {
        // desk#59: an unprovable ending has no honest number. Persisting 0
        // would make it indistinguishable from a clean exit; null says "no
        // code". The browser is not told this number at all -- its EXIT frame
        // carries the tagged outcome, so `unknown` reaches the surface as the
        // word, never as a zero.
        const code = durableExitCode(event.outcome);
        authority = this.core.markExited(
          sessionId,
          generation,
          {
            code,
            signal:
              event.outcome.kind === 'signalled' ? String(event.outcome.signal) : null,
            origin: 'observed',
            reason: null,
            // desk#59: the raw ending as moor reported it. `code` stays only as
            // the legacy numeric view for consumers that still read a number.
            outcome: event.outcome,
            // The exit was observed: observation did not fail.
            diagnostic: null
          },
          at
        );
        // Cutover parity: an APPLIED exit transition also pushes an explicit
        // EXIT frame to every subscribed browser surface — replayed or
        // duplicate exits (authority noop/rejected) never re-announce.
        if (authority.kind === 'applied') {
          if (event.outputEnd === undefined) {
            console.error(
              `[desk] observed Moor exit for ${sessionId} generation ${generation} has no validated output boundary`
            );
          } else {
            const delivery = this.core.emitExit(sessionId, event.outcome, event.outputEnd);
            this.sealInputForObservedExit(sessionId);
            if (delivery instanceof Promise) {
              void delivery
                .then(() => this.cancelRecoveryForObservedExit(sessionId, generation))
                .catch((error) =>
                  console.error(
                    `[desk] Moor exit delivery failed for ${sessionId} generation ${generation}: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  )
                );
            } else {
              this.cancelRecoveryForObservedExit(sessionId, generation);
            }
          }
        }
        next.exit = { code, at };
        break;
      }
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

  private cancelRecoveryForObservedExit(sessionId: string, generation: number): void {
    const recovery = this.recoveries.get(sessionId);
    if (recovery !== undefined && recovery.generation === generation) {
      if (recovery.timer !== undefined) clearTimeout(recovery.timer);
      recovery.candidate?.close();
      this.recoveries.delete(sessionId);
    }
    const state = this.core.stateSnapshot(sessionId);
    if (state?.generation !== generation || state.lifecycle !== 'exited') return;
    this.owners.delete(sessionId);
    const link = this.masters.get(sessionId);
    this.masters.delete(sessionId);
    this.moorStatuses.delete(sessionId);
    link?.close();
  }

  state(sessionId: string): SessionStateSnapshot | undefined {
    return this.core.state(sessionId);
  }

  /**
   * desk#59 — record what observation failed to establish, leaving the reason
   * that initiated the retirement exactly as written. Generation-fenced and
   * monotonic: it fills an absent diagnostic once and never replaces one.
   */
  refineExitDiagnostic(
    sessionId: string,
    generation: number,
    diagnostic: ExitDiagnostic,
    observedAt?: number
  ): AuthorityMutationResult {
    return this.core.refineExitDiagnostic(sessionId, generation, diagnostic, observedAt);
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
  /**
   * desk#59 — the reason is REQUIRED, deliberately without a default. A default
   * would hand an unnamed teardown a confident, plausible label ('the operator
   * asked'), which is worse than no provenance at all: the record states a
   * wrong cause instead of admitting it does not know. It also stops the type
   * from forcing new call sites to declare themselves, letting the regression
   * back in silently.
   */
  retire(sessionId: string, reason: RetireReason): void {
    const kill = this.beginRetire(sessionId, reason);
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
  async retireAwaited(
    sessionId: string,
    opts: { timeoutMs?: number; reason: RetireReason }
  ): Promise<{ ok: boolean; error?: string }> {
    return this.runSerializedLifecycle(sessionId, () =>
      this.retireAwaitedUnlocked(sessionId, opts)
    );
  }

  private async retireAwaitedUnlocked(
    sessionId: string,
    opts: { timeoutMs?: number; reason: RetireReason }
  ): Promise<{ ok: boolean; error?: string }> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    await this.terminateOverLiveLink(sessionId);
    const kill = this.beginRetire(sessionId, opts.reason);
    if (kill === undefined) {
      return { ok: true };
    }
    return this.confirmKill(sessionId, kill, timeoutMs);
  }

  /**
   * §9 wire terminate as the FIRST retire step when the link is live: the
   * holder fences identity+generation+incarnation atomically, exits its child
   * gracefully (5 s, then escalates per §12.4), and unlinks its rendezvous on
   * TERMINATED/ALREADY_GONE. This is not a fallback pair with the CLI kill —
   * the wire path serves a LIVE adopted link, the CLI kill serves a detached
   * record, and the CLI confirm after a wire-terminated holder is an
   * idempotent double-check that observes an already-unlinked rendezvous. An
   * indeterminate/failed wire outcome changes nothing: the confirmed-kill
   * machinery below still owns the truth.
   */
  private async terminateOverLiveLink(sessionId: string): Promise<void> {
    const link = this.masters.get(sessionId);
    if (link?.terminateHolder === undefined) return;
    try {
      await link.terminateHolder();
    } catch {
      // Deadline/link loss: outcome indeterminate — nothing may be assumed,
      // and nothing is: the confirmed kill decides.
    }
  }

  /**
   * Retire one exact native generation. A stale caller may observe a successor
   * under the same Desk session id, but it can never tear that successor down.
   */
  async retireGenerationAwaited(
    sessionId: string,
    expectedGeneration: number,
    opts: { timeoutMs?: number; reason: RetireReason }
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
    opts: { timeoutMs?: number; reason: RetireReason }
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

    if (snapshot !== undefined) await this.terminateOverLiveLink(sessionId);
    const kill =
      snapshot === undefined
        ? retainedKill
        : this.beginRetire(sessionId, opts.reason);
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
      // A provider-session reset tears the session down to re-establish its
      // identity — that is what ended it, and the record says so.
      const retired = await this.retireAwaitedUnlocked(sessionId, {
        ...opts,
        reason: 'provider-session-reset'
      });
      if (!retired.ok) {
        return {
          ok: false,
          reason: 'retire-failed',
          error: retired.error ?? `session ${sessionId} could not be retired`
        };
      }
      if (existsSync(sockPath)) {
        // The socket exists (stat has no sun_path limit), but if the absolute
        // path is over-capacity a node:net connect would be truncated to a
        // different spelling, so socketHasListener could never prove THIS socket
        // is unlistened. Refuse the unlink rather than delete a possibly-live
        // holder's rendezvous on unprovable absence.
        if (!rendezvousPathWithinCapacity(sockPath)) {
          return {
            ok: false,
            reason: 'retire-failed',
            error: `cannot clean up session ${sessionId}: its rendezvous path exceeds the ${unixSocketPathCapacity()}-byte sun_path ceiling, so a connect cannot prove the socket is unlistened`
          };
        }
        if (await socketHasListener(sockPath)) {
          return {
            ok: false,
            reason: 'session-live',
            error: `session ${sessionId} still has a listening master`
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
      // A known, previously attached master can die before `moor kill` connects,
      // leaving a stale socket that makes kill exit 1. `moor rm` is the safe
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
      return { ok: false, error: `moor socket still present after kill: ${kill.sockPath}` }; // record retained
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
  private beginRetire(sessionId: string, reason: RetireReason): DetachedKillRecord | undefined {
    this.owners.delete(sessionId); // any deferred old-operation callback goes stale
    const recovery = this.recoveries.get(sessionId);
    if (recovery?.timer !== undefined) clearTimeout(recovery.timer);
    recovery?.candidate?.close();
    this.recoveries.delete(sessionId);
    this.masters.get(sessionId)?.close();
    this.masters.delete(sessionId);
    // Generation-bound authority dies with the link it was adopted from.
    this.moorStatuses.delete(sessionId);
    const cleanup = this.cleanups.get(sessionId);
    if (cleanup !== undefined) cleanup();
    this.cleanups.delete(sessionId);
    this.core.retire(sessionId, reason);
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
 * True when a unix socket path has a live listener. A stale node left by a
 * dead master refuses the connection (ECONNREFUSED); anything else that is
 * not a successful connect is treated as "no listener" so a permission or
 * path error can never masquerade as a live foreign owner.
 */
/**
 * Tri-valued moor-rendezvous liveness: 'live' on a successful connect,
 * 'stale' ONLY on POSITIVE staleness (ECONNREFUSED — a socket nobody
 * listens on — or ENOENT — the node vanished), and 'indeterminate' for
 * everything else (EACCES, timeouts, resource errors). Indeterminate
 * evidence must PRESERVE the node: deleting on a permission error would
 * unlink a live foreign holder this daemon merely cannot reach.
 */
/**
 * §10 bounded IDENTITY probe: a fresh connection running the HELLO/HELLO_ACK
 * exchange — the decoder fences the canonical identity and the generation
 * scope, so 'authenticated-live' means the SAME session's holder answered.
 * 'absent' is a positively-established missing listener (connection refused /
 * no rendezvous object). Everything else — timeout, handshake failure,
 * identity or generation mismatch — is 'indeterminate': nothing may be
 * assumed, per OB-30.
 */
async function probeMoorHolder(
  sessionPath: string,
  generation: number,
  onClient?: (client: MoorMasterClient) => void
): Promise<'authenticated-live' | 'absent' | 'indeterminate'> {
  // An over-capacity path is truncated by node:net, so its ENOENT is a FALSE
  // absence. Unaddressable is never positively absent: classify indeterminate
  // before connecting. (MoorMasterClient.connect enforces the same ceiling; the
  // explicit check here keeps the classification legible and independently
  // testable.)
  if (!rendezvousPathWithinCapacity(sessionPath)) return 'indeterminate';
  const probe = new MoorMasterClient(sessionPath, generation);
  onClient?.(probe);
  try {
    await probe.connect();
  } catch (error) {
    probe.close();
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ECONNREFUSED' || code === 'ENOENT' ? 'absent' : 'indeterminate';
  }
  try {
    await probe.authenticate();
    return 'authenticated-live';
  } catch {
    return 'indeterminate';
  } finally {
    probe.close();
  }
}

/**
 * Tri-valued rendezvous liveness, EXPORTED because it is the one probe the
 * daemon owns and desk#50b needed a second caller for it — the holder-presence
 * question `/control/moor-status` answers when no adopted link exists. A
 * parallel probe written for that route would be a second definition of
 * "alive", and the two would disagree the first time either was tuned.
 *
 * Non-destructive and non-adopting by construction: it connects, reads the
 * kernel's answer, and destroys its own socket. It writes no protocol bytes
 * (so it cannot fence or steal a live holder's supervised link) and it unlinks
 * nothing (desk#42 — the caller that DOES unlink adds its own TOCTOU identity
 * fence on top of a `stale` verdict; the presence probe never unlinks at all).
 */
export async function probeRendezvous(
  path: string,
  timeoutMs = 250
): Promise<'live' | 'stale' | 'indeterminate'> {
  // An over-capacity absolute path is truncated by libuv before connect, so its
  // ENOENT would be a FALSE positive-absence. It is unaddressable, never proven
  // stale: classify indeterminate before any Node connect (moor spec 2.2 lets a
  // holder bind such a path relative to its parent).
  if (!rendezvousPathWithinCapacity(path)) return 'indeterminate';
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const settle = (result: 'live' | 'stale' | 'indeterminate'): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle('indeterminate'));
    socket.once('connect', () => settle('live'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'stale' : 'indeterminate');
    });
  });
}

async function socketHasListener(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path });
    const settle = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}
