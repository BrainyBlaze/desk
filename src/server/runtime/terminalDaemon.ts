// Terminal daemon assembly (cutover Phase 2 Step 3, core). Composes the durable
// terminal daemon the web server mounts at cutover: a TerminalWsRouter backed by
// a fsync'd generation ledger and the real @xterm/headless emulator, the binary
// WS bridge on /ws/terminal, and moor session provisioning via @codex's verified
// contract (CREATE = `moor start ABSOLUTE_SOCKET_PATH cmd`, KILL = `moor kill -f
// ABSOLUTE_SOCKET_PATH`; a slash-bearing name is the socket path, which isolates
// the canary under a dedicated socket root).
//
// This IS the product's terminal transport: the daemon supervisor spawns it
// and the web server proxies /ws/terminal to it. Instantiating it directly is
// how tests and a hand-run daemon (DESK_DAEMON_EXTERNAL) compose the pieces.

import { isRealSessionGeometry, type SessionGeometry } from '../../shared/runtime/sessionGeometryStore.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { readManifestFile, resolveManifestPath } from '../../core/config.js';
import { buildSessionSpecs } from '../../core/manifest.js';
import {
  ensurePrivateSocketRoot,
  moorRendezvousPath
} from '../../shared/moorPaths.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  AGENT_PRODUCER_BINDINGS,
  GenerationLedger,
  parseAgentStateEnvelope,
  parseChannelMessageDeskEventInput,
  parseDeskEventReadRequest,
  type AgentProducer,
  type AgentStateEnvelope,
  type ChannelMessageDeskEventInput,
  type DeskEventFeedResponse,
  type DeskEventReadRequest,
  type SessionRegistration,
  type SessionStateSnapshot,
  type SessionStateTransition
} from '../../shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../../shared/runtime/index.js';
import { TerminalWsRouter } from './terminalWsRouter.js';
import { XtermEmulatorFactory } from './xtermEmulator.js';
import { FileGenerationLedgerStore } from './fileGenerationLedger.js';
import { FileSessionGeometryStore } from './fileSessionGeometryStore.js';
import { FileSessionScreenCheckpointStore } from './fileSessionScreenCheckpointStore.js';
import { installTerminalWsBridge } from '../terminalWsBridge.js';
import { HttpBodyError, readJsonBody, sendJson } from '../httpUtil.js';
import type { DaemonAgentStateIntakeResult } from '../../shared/runtime/daemonCore.js';
import { isRetireReason, type RetireReason } from '../../shared/runtime/daemonCore.js';
import {
  FileIntakeStore,
  type FileIntakeStoreDependencies
} from './fileIntakeStore.js';
import {
  FileAgentEndpointStore,
  type AgentEndpointActivationResult,
  type AgentEndpointStoreResult
} from './fileAgentEndpointStore.js';
import { reconcileOpencodeStatus } from '../../core/agentState/opencodeReconcile.js';
import {
  readClaudeContinuityDescriptor,
  readClaudeProfileMemoryDescriptor,
  type ClaudeContinuityDescriptor,
  type ClaudeProfileMemoryDescriptor
} from '../../shared/claudeContinuityDescriptor.js';
import { prepareClaudeSessionStart as prepareClaudeSessionStartDefault } from '../claudeProfileContinuity.js';
import {
  recordClaudeProfileMemorySyncFailure,
  syncClaudeProfileMemory as syncClaudeProfileMemoryDefault,
  type SyncClaudeProfileMemoryResult
} from '../claudeProfileMemory.js';
import {
  probeHookInstallation,
  type HookInstallationProbe,
  type HookProbeProvider
} from '../../core/agentHooks.js';
import {
  FileDeskEventJournal,
  type AppendChannelDeskEventResult,
  type DeskEventJournalHealth
} from './fileDeskEventJournal.js';
import {
  MoorEventObserver,
  moorEventStoreDir,
  moorEventStoreRoot,
  type MoorEventDiagnostic
} from './moorEventObserver.js';
import type { MoorStatus } from '../../shared/moorWire/messages.js';
import {
  MOOR_STATUS_NO_LIVE_LINK_ERROR,
  type MoorHolderPresence
} from '../../shared/daemonControlClient.js';
import type {
  HolderLogClearOutcome,
  ProviderSessionProvisionRecoveryDetail,
  RetireGenerationResult,
  SessionSpawnPreallocationContext,
  SessionSpawnPreallocationResult,
  SessionSpawnResult,
  TerminalObservationSnapshot
} from './sessionManager.js';
import type { AgentObservationScope } from '../../core/agentState/providerAdapter.js';
import {
  isHookIdentityProvider,
  isProviderSessionProvider,
  isValidProviderSessionId,
  type ProviderSessionProvider
} from '../../shared/providerSessionIdentity.js';
import type {
  CompleteProviderSessionLaunchInput,
  CompleteProviderSessionLaunchResult
} from './providerSessionLaunchLedger.js';
import { FileProviderSessionLaunchLedger } from './providerSessionLaunchLedger.js';
import {
  authorizeProviderSessionReset,
  type ProviderSessionResetResult as ProviderSessionAuthorizationResetResult
} from '../providerSessionReset.js';
import {
  bindProviderSessionIdentity,
  readProviderSessionBinding,
  replaceProviderSessionIdentity
} from '../providerSessionBinding.js';
import {
  archiveMoorGenerationStores,
  MoorCurrentExitEvidenceError,
  readCurrentMoorGenerationExitEvidence,
  readMoorGenerationExitEvidence,
  type MoorGenerationExitEvidence
} from './moorGenerationStores.js';
import {
  isEvidenceCapableProvider,
  verifyProviderSessionEvidence,
  type ProviderSessionEvidenceResult
} from '../providerSessionEvidence.js';
import {
  FileProviderSessionContinuityLedger,
  type ProviderSessionContinuityProvider
} from './providerSessionContinuityLedger.js';

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off?(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface TerminalDaemonOptions {
  /** Durable state root (the generation ledger lives under <root>/_engine). */
  homeRoot: string;
  /** Path to the moor binary. */
  moorBinPath: string;
  /** Dedicated ABSOLUTE socket root; a session's socket is <root>/<sessionId>.sock. */
  moorSocketRoot: string;
  httpServer: UpgradeServer;
  /** WS path (default /ws/terminal). */
  wsPath?: string;
  /**
   * Per-launch identity echoed by /control/health (from DESK_DAEMON_NONCE).
   * The supervisor requires an exact match before marking a child ready — on
   * a shared port an OLD daemon still draining its SIGTERM answers the same
   * URL, and a nonce-less 200 would mark the NEW child ready from it.
   */
  healthNonce?: string;
  /** Injectable daemon clock for deterministic recovery and route tests. */
  now?: () => number;
  /** Injectable loopback provider transport for deterministic recovery tests. */
  fetch?: typeof globalThis.fetch;
  /** Per-provider recovery request timeout. */
  agentReconcileTimeoutMs?: number;
  /** Maximum provider recovery polls in flight. */
  agentReconcileConcurrency?: number;
  /** Read-only hook wiring probe; injectable for deterministic composition tests. */
  hookInstallationProbe?: (
    provider: HookProbeProvider
  ) => HookInstallationProbe;
  /** Poll cadence for generation-bound moor event sinks. */
  moorEventPollIntervalMs?: number;
  /** Injectable structured diagnostic sink for moor event ingestion. */
  onMoorEventDiagnostic?: (context: {
    sessionId: string;
    generation: number;
    path: string;
    diagnostic: MoorEventDiagnostic;
  }) => void;
  /** Active manifest path override for isolated daemon composition tests. */
  manifestPath?: string;
  /** Home directory used to resolve manifest session cwd values in tests. */
  homeDir?: string;
  /** Injectable worker admission policy for deterministic composition tests. */
  supervisor?: WorkerSupervisor;
  /** Injectable durable evidence verifier for boundary-failure tests. */
  verifyProviderSessionEvidence?: typeof verifyProviderSessionEvidence;
  /** Injectable continuity ledger for deterministic durability-failure tests. */
  providerSessionContinuityLedger?: FileProviderSessionContinuityLedger;
  /** Injectable manifest CAS boundary for deterministic persistence tests. */
  replaceProviderSessionIdentity?: typeof replaceProviderSessionIdentity;
}

/** A provisionable session: the command to run and its initial geometry. */
export interface TerminalDaemonSessionSpec {
  command: string[];
  geometry: { rows: number; cols: number };
  subject: SessionRegistration['subject'];
  providerSessionId?: string;
}

/** Provision outcome: ensure result, or the spawn/attach failure that rolled back. */
export type ProvisionResult = SessionSpawnResult;

export type AgentProviderReconcileResult =
  | { sessionId: string; kind: 'reconciled' }
  | {
      sessionId: string;
      kind: 'skipped';
      reason:
        | 'not-opencode-session'
        | 'endpoint-unregistered'
        | 'provider-session-unregistered'
        | 'producer-unbound'
         | 'producer-instance-mismatch'
         | 'poll-failed'
         | 'no-facts'
         | 'intake-rejected'
         | 'recovery-error';
    };

export type TerminalAgentEventResult =
  | DaemonAgentStateIntakeResult
  | {
      kind: 'rejected';
      reason:
        | 'invalid-provider-scope'
        | 'provider-session-unregistered'
        | 'provider-session-mismatch';
      carried?: never;
      current?: never;
    };

export type ProviderSessionResetResult =
  | ProviderSessionAuthorizationResetResult
  | {
      ok: false;
      reason: 'session-live' | 'retire-failed';
      error: string;
    };

export interface ObserveProviderSessionIdentityInput {
  deskSessionId: string;
  provider: ProviderSessionContinuityProvider;
  providerSessionId: string;
  generation: number;
  launchProof: string;
  hook: string;
}

export interface RebindProviderSessionInput {
  deskSessionId: string;
  targetProviderSessionId: string;
}

export type ProviderSessionContinuityMutationResult =
  | {
      ok: true;
      kind: 'bound' | 'matching' | 'rebound' | 'already-rebound';
      provider: ProviderSessionContinuityProvider;
      providerSessionId: string;
    }
  | {
      ok: false;
      reason:
        | 'provider-session-not-found'
        | 'provider-session-agent-mismatch'
        | 'provider-session-id-invalid'
        | 'provider-session-id-conflict'
        | 'provider-session-mismatch'
        | 'provider-session-provider-mismatch'
        | 'provider-session-generation-mismatch'
        | 'provider-session-not-live'
        | 'provider-session-proof-invalid'
        | 'provider-session-start-required'
        | 'provider-session-evidence-missing'
        | 'provider-session-evidence-stale'
        | 'provider-session-evidence-invalid'
        | 'provider-session-rebind-required'
        | 'provider-session-transition-missing'
        | 'provider-session-transition-mismatch'
        | 'provider-session-store-failed';
      error: string;
      currentProviderSessionId?: string;
      targetProviderSessionId?: string;
      action?: string;
    };

export interface TerminalDaemon {
  readonly router: TerminalWsRouter;
  /** Spawn + attach the moor holder for a session (CREATE contract). */
  provision(sessionId: string, spec: TerminalDaemonSessionSpec): Promise<ProvisionResult>;
  /**
   * Retire a session (KILL contract), resolving only after the kill command
   * completed AND the master's socket disappeared — the restart flow provisions
   * immediately after, and a stale socket would be adopted at the old
   * generation. A failed kill is a failure, never a silent 200.
   */
  retire(sessionId: string, reason: RetireReason): Promise<{ ok: boolean; error?: string }>;
  /** Retire exactly one native generation without touching a successor. */
  retireGeneration(
    sessionId: string,
    generation: number
  ): Promise<RetireGenerationResult>;
  /** Stop one session and authorize exactly one fresh provider launch. */
  resetProviderSession(sessionId: string): Promise<ProviderSessionResetResult>;
  /** Complete one exact claimed launch after its identity is durably bound. */
  completeProviderSessionLaunch(
    input: CompleteProviderSessionLaunchInput
  ): CompleteProviderSessionLaunchResult;
  /** Validate and reconcile one launch-scoped provider hook identity. */
  observeProviderSessionIdentity(
    input: ObserveProviderSessionIdentityInput
  ): Promise<ProviderSessionContinuityMutationResult>;
  /** Explicitly authorize the exact current pending provider transition. */
  rebindProviderSession(
    input: RebindProviderSessionInput
  ): Promise<ProviderSessionContinuityMutationResult>;
  /** Control-plane input injection (channels delivery). False if unknown. */
  input(sessionId: string, bytes: Uint8Array, paste?: boolean): boolean;
  /** Atomic prompt submission resolved only by a complete Moor INPUT receipt. */
  prompt(sessionId: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * Ranged plain-text window into the session's screen + scrollback. `offset`
   * counts lines back from the live edge (0/absent = the live tail); reads at
   * or beyond the top yield empty lines with totalAvailable telling the
   * caller where the top is. Undefined when the session is unknown.
   */
  tail(sessionId: string, rows: number, offset?: number): { lines: string[]; totalAvailable: number } | undefined;
  /** Latest generation-bound terminal observation, independent of semantic authority. */
  terminalObservation(sessionId: string): TerminalObservationSnapshot | undefined;
  /** Retained predecessor lifecycle exits, newest generation first. */
  moorExitEvidence(sessionId: string): Promise<readonly MoorGenerationExitEvidence[]>;
  /** Re-open a surviving generation's event sink after daemon restart. */
  reconcileMoorEvents(sessionId: string, generation: number): Promise<boolean>;
  /** §10.2.13 committed-log clear over the live moor link — full result algebra. */
  clearSessionLog(
    sessionId: string
  ): Promise<HolderLogClearOutcome | 'no-link'>;
  /** #8: the adopted ATTACH_ACK descriptor while a live moor link exists. */
  moorSessionStatus(sessionId: string): MoorStatus | undefined;
  /**
   * desk#50b: is a holder there, INDEPENDENTLY of whether this daemon has
   * adopted it? Meaningful precisely when `moorSessionStatus` is undefined —
   * the re-adoption window and the post-link-loss state, where "no adopted
   * link" says nothing about the holder.
   */
  moorHolderPresence(sessionId: string): Promise<MoorHolderPresence>;
  /**
   * Enter the DRAINING state (idempotent, synchronous): from this instant the
   * control plane refuses every state-changing request, so a graceful
   * shutdown's lease-handover snapshot cannot race a late provision.
   */
  beginDrain(): void;
  isDraining(): boolean;
  /**
   * Mutation drain barrier: a state-changing control request acquires this
   * BEFORE its first awaited body read (registering how to ABORT itself) and
   * releases it when its response finishes. Returns undefined once draining —
   * the atomically-checked refusal. close() truly awaits the barrier: no
   * shutdown step past it can run while an admitted mutation can still run.
   */
  enterMutation(abort: () => void): (() => void) | undefined;
  /** Resolves when no admitted mutation remains in flight (draining only). */
  awaitMutationDrain(): Promise<void>;
  /**
   * Sever every still-open admitted mutation (bounded-shutdown escalation):
   * each registered abort destroys its connection, which fires the request's
   * close-path release — so the barrier ALWAYS empties instead of the
   * shutdown proceeding past a live mutation. Returns how many were severed.
   */
  abortOpenMutations(): number;
  /** Bind durable provider transport metadata to the canonical producer sequence. */
  agentEndpoint(input: unknown): AgentEndpointStoreResult;
  /** Activate one exact staged provider registration after durable identity binding. */
  activateAgentEndpoint(input: unknown): Promise<AgentEndpointActivationResult>;
  /** Recover present OpenCode state from the exact registered provider session. */
  reconcileAgentProviders(
    sessionIds?: readonly string[]
  ): Promise<AgentProviderReconcileResult[]>;
  /** Accept one canonical, generation-fenced agent-state observation. */
  agentEvent(
    input: unknown,
    scope?: AgentObservationScope
  ): TerminalAgentEventResult;
  /** One atomic view shared by every canonical state consumer. */
  agentStates(): { revision: number; snapshots: SessionStateSnapshot[] };
  /** Durable unified agent/channel event projection, newest first. */
  events(limit?: number): DeskEventFeedResponse;
  /** Append one idempotent channel notification to the daemon-owned journal. */
  channelEvent(
    input: ChannelMessageDeskEventInput
  ): AppendChannelDeskEventResult;
  /** Acknowledge journal records only; canonical activity is untouched. */
  readEvents(input: DeskEventReadRequest): number;
  /** Hide all current journal records only; future events remain unread. */
  clearEvents(): 0;
  /**
   * Startup completeness: /control/health answers 503 until markReady, so the
   * supervisor's probe cannot report a daemon ready while its startup
   * reconcile is still pending or failed — readiness must not lie.
   */
  isReady(): boolean;
  /** Recoverable projection-store faults that do not make session IO unavailable. */
  health(): DeskEventJournalHealth;
  markReady(): void;
  /** Tear down the WS bridge + its timers. */
  dispose(): void;
}

/** Assemble the durable terminal daemon + mount its binary WS bridge (additive). */
export function createTerminalDaemon(options: TerminalDaemonOptions): TerminalDaemon {
  const now = options.now ?? Date.now;
  const ledger = new GenerationLedger(new FileGenerationLedgerStore(join(options.homeRoot, '_engine', 'generation-ledger.json')));
  const providerLaunchLedger = new FileProviderSessionLaunchLedger(
    join(options.homeRoot, '_engine', 'provider-session-launch.ndjson')
  );
  const providerContinuityLedger =
    options.providerSessionContinuityLedger ??
    new FileProviderSessionContinuityLedger(
      join(options.homeRoot, '_engine', 'provider-session-continuity.ndjson')
    );
  const replaceProviderIdentity =
    options.replaceProviderSessionIdentity ?? replaceProviderSessionIdentity;
  const evidenceVerifier =
    options.verifyProviderSessionEvidence ?? verifyProviderSessionEvidence;
  const continuityQueues = new Map<string, Promise<void>>();
  const runProviderContinuity = async <T>(
    deskSessionId: string,
    operation: () => Promise<T> | T
  ): Promise<T> => {
    const prior = continuityQueues.get(deskSessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    continuityQueues.set(deskSessionId, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (continuityQueues.get(deskSessionId) === tail) {
        continuityQueues.delete(deskSessionId);
      }
    }
  };
  const rebindAction = (
    deskSessionId: string,
    providerSessionId: string
  ): string =>
    `desk rebind-provider-session ${deskSessionId} --to ${providerSessionId} --force`;
  const providerProvisionFailure = (
    detail: ProviderSessionProvisionRecoveryDetail,
    action?: string
  ): SessionSpawnPreallocationResult => ({
    ok: false,
    reason: 'provider-session-identity-missing',
    detail,
    ...(action === undefined ? {} : { action })
  });
  const authorizeProviderSessionLaunch = (
    context: SessionSpawnPreallocationContext,
    spec: TerminalDaemonSessionSpec
  ): SessionSpawnPreallocationResult => {
    if (
      context.subject.kind !== 'agent' ||
      !isProviderSessionProvider(context.subject.provider)
    ) {
      return { ok: true };
    }
    const provider = context.subject.provider;
    if (
      spec.providerSessionId !== undefined &&
      !isValidProviderSessionId(provider, spec.providerSessionId)
    ) {
      return providerProvisionFailure('invalid-provider-session-id');
    }
    const binding = readProviderSessionBinding({
      deskSessionId: context.sessionId,
      ...(options.manifestPath === undefined
        ? {}
        : { manifestPath: options.manifestPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir })
    });
    if (!binding.ok) {
      if (binding.code === 'provider-session-not-found') {
        return providerProvisionFailure('session-not-found');
      }
      if (binding.code === 'provider-session-agent-mismatch') {
        return providerProvisionFailure('agent-mismatch');
      }
      return providerProvisionFailure('invalid-provider-session-id');
    }
    if (binding.provider !== provider) {
      return providerProvisionFailure('provider-mismatch');
    }
    const requestedBinding = spec.providerSessionId ?? null;
    if (binding.providerSessionId !== requestedBinding) {
      return providerProvisionFailure('binding-mismatch');
    }
    if (binding.providerSessionId !== null) {
      const completion = providerLaunchLedger.completeForResumedLaunch({
        deskSessionId: context.sessionId,
        provider,
        providerSessionId: binding.providerSessionId,
        generation: context.currentGeneration
      });
      if (completion.ok) return { ok: true };
      if (completion.reason === 'invalid-provider-session-id') {
        return providerProvisionFailure('invalid-provider-session-id');
      }
      if (completion.reason === 'provider-mismatch') {
        return providerProvisionFailure('provider-mismatch');
      }
      if (completion.reason === 'generation-mismatch') {
        return providerProvisionFailure('generation-mismatch');
      }
      if (completion.reason === 'provider-session-mismatch') {
        return providerProvisionFailure('binding-mismatch');
      }
      if (completion.reason === 'reset-incomplete') {
        return providerProvisionFailure('reset-incomplete');
      }
      return providerProvisionFailure('not-authorized');
    }
    const currentAuthorization = providerLaunchLedger.current(context.sessionId);
    // The fence exists to stop a relaunch from silently orphaning an existing
    // provider conversation. There is nothing to orphan when no live
    // authorization stands: either the ledger never recorded this session, or
    // its last launch already completed — and the binding is null (checked
    // above), so no addressable conversation survives. Both admit the launch.
    //
    // desk#47: the generation used to stand in for "never launched", and it is
    // not one. The generation ledger is monotonic and tombstone-surviving by
    // §4.8.1, so it advances on every ATTEMPT — including one that died before
    // the child ever ran (an agent CLI missing from PATH is the common case).
    // The manifest entry was rolled back, so the session did not exist, yet
    // the counter had moved: every later attempt on that name was refused as
    // an unauthorized relaunch, and `reset-provider-session` could not clear
    // it either, because that command requires the session to be IN the
    // manifest. The name was dead with no way back from the UI or the CLI.
    if (
      currentAuthorization === undefined ||
      currentAuthorization.state === 'completed'
    ) {
      return { ok: true };
    }
    const claim = providerLaunchLedger.claim({
      deskSessionId: context.sessionId,
      provider,
      currentGeneration: context.currentGeneration,
      nextGeneration: context.nextGeneration
    });
    if (claim.ok) return { ok: true };
    return providerProvisionFailure(claim.reason);
  };
  const preallocateProviderSession = (
    context: SessionSpawnPreallocationContext,
    spec: TerminalDaemonSessionSpec
  ): Promise<SessionSpawnPreallocationResult> | SessionSpawnPreallocationResult => {
    // Continuity (proofs + observation) is for providers whose HOOKS can carry
    // an identity back; a plugin-reporting provider (opencode) still gets its
    // launch-ledger authorization above but must not receive proofs nothing
    // can present, nor have its launches coupled to continuity-store health.
    if (
      context.subject.kind !== 'agent' ||
      !isHookIdentityProvider(context.subject.provider)
    ) {
      return authorizeProviderSessionLaunch(context, spec);
    }
    const provider = context.subject.provider;
    return runProviderContinuity(context.sessionId, () => {
      try {
        const launchAuthorization = providerLaunchLedger.current(
          context.sessionId
        );
        const transition = providerContinuityLedger.currentTransition(
          context.sessionId
        );
        const requiresRebind =
          transition !== undefined &&
          transition.state !== 'cancelled-by-reset' &&
          (transition.state === 'pending' ||
            spec.providerSessionId !==
              transition.observedProviderSessionId);
        if (
          launchAuthorization?.state === 'prepared' &&
          requiresRebind
        ) {
          return providerProvisionFailure('reset-incomplete');
        }
        if (requiresRebind) {
          return providerProvisionFailure(
            'provider-session-rebind-required',
            rebindAction(
              context.sessionId,
              transition.observedProviderSessionId
            )
          );
        }
        const authorized = authorizeProviderSessionLaunch(context, spec);
        if (!authorized.ok) return authorized;
        const issued = providerContinuityLedger.issueLaunchProof({
          deskSessionId: context.sessionId,
          provider,
          generation: context.nextGeneration,
          issuedAt: now()
        });
        return {
          ok: true,
          launchContext: { providerLaunchProof: issued.launchProof }
        };
      } catch {
        return providerProvisionFailure('continuity-store-failed');
      }
    });
  };
  const eventJournal = new FileDeskEventJournal(
    join(options.homeRoot, '_engine', 'desk-events.ndjson')
  );
  let intakeStore: FileIntakeStore | undefined;
  let intakeDependencies: FileIntakeStoreDependencies | undefined;
  const hookInstallationProbe =
    options.hookInstallationProbe ?? probeHookInstallation;
  let ready = false;
  let draining = false;
  const openMutations = new Set<{ abort: () => void }>();
  let mutationDrainWaiters: Array<() => void> = [];
  let scheduleMoorObserverCleanup = (
    _sessionId: string,
    _generation: number,
    _origin: 'observed' | 'retired'
  ): void => {};
  const replayingMoorTransitions = new Set<string>();
  const moorTransitionKey = (sessionId: string, generation: number): string =>
    `${sessionId}\0${generation}`;
  /**
   * Downtime catch-up: replay re-projects the WHOLE retained store into a
   * fresh authority, so publishing every replayed transition would storm the
   * journal with history it already carries. But swallowing them all loses
   * every change that happened WHILE the daemon was down (an agent's
   * completion, most notably). The compromise is a summary: remember the LAST
   * suppressed transition per (session, generation) and publish exactly that
   * one when the replay finishes — downstream sees one event carrying the
   * final caught-up state.
   */
  const suppressedReplayTransitions = new Map<string, SessionStateTransition>();
  // desk#62: the daemon's journal of the last COMMANDED geometry per session
  // (moor owns the pty's real size). It holds a persistent append descriptor,
  // so it is a resource this daemon OWNS and must release in dispose()
  // alongside the other durable stores below.
  const sessionGeometryStore = new FileSessionGeometryStore(
    join(options.homeRoot, '_engine', 'session-geometry.ndjson')
  );
  const sessionScreenCheckpointStore = new FileSessionScreenCheckpointStore(
    join(options.homeRoot, '_engine', 'session-screens')
  );
  const router = new TerminalWsRouter({
    ledger,
    supervisor:
      options.supervisor ?? new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: new XtermEmulatorFactory(),
    now,
    onLateMoorAdoption: reconcileMoorEvents,
    // desk#62: the daemon's journal of the last COMMANDED geometry. Written on
    // every commanded resize, read by every re-adoption — without it a restart
    // has nothing to approximate a surviving session's size with.
    sessionGeometry: sessionGeometryStore,
    screenCheckpoints: sessionScreenCheckpointStore,
    initialAgentHealth: (subject) => {
      if (subject.mode !== 'terminal') return undefined;
      const probe = hookInstallationProbe(subject.provider);
      if (!probe.installed) {
        return {
          status: 'degraded',
          reason: 'hook-not-installed',
          ...(probe.detail === undefined ? {} : { detail: probe.detail })
        };
      }
      if (subject.provider === 'codex' && probe.trust === 'absent') {
        return {
          status: 'degraded',
          reason: 'codex-hook-untrusted',
          detail: 'no Codex trust record names Desk hooks.json'
        };
      }
      return undefined;
    },
    onStateTransition: (transition) => {
      if (transition.cause === 'lifecycle-exited') {
        // desk#59: an OBSERVED exit already carries the truth, so its observer
        // may stop at once. A RETIRED placeholder is Desk tearing the session
        // down without knowing how the child died — stopping there is what
        // discarded the evidence, so that path drains first. Queue this before
        // the downstream journal so cleanup survives a rejected feed write.
        scheduleMoorObserverCleanup(
          transition.sessionId,
          transition.generation,
          transition.to.exit?.origin === 'observed' ? 'observed' : 'retired'
        );
      }
      const key = moorTransitionKey(transition.sessionId, transition.generation);
      if (replayingMoorTransitions.has(key)) {
        // Replay: keep only the LAST transition — it carries the final
        // caught-up state and is published once the replay completes.
        suppressedReplayTransitions.set(key, transition);
      } else {
        eventJournal.appendTransition(transition);
      }
    },
    createAgentStateIntakeStore: (dependencies) => {
      intakeDependencies = dependencies;
      intakeStore = new FileIntakeStore(
        join(options.homeRoot, '_engine', 'agent-state-intake.ndjson'),
        dependencies
      );
      return intakeStore;
    }
  });
  if (intakeStore === undefined || intakeDependencies === undefined) {
    throw new Error('terminal daemon did not initialize its agent-state intake');
  }
  const canonicalIntakeStore = intakeStore;
  const canonicalIntakeDependencies = intakeDependencies;
  const endpointStore = new FileAgentEndpointStore(
    join(options.homeRoot, '_engine', 'agent-endpoints.json'),
    {
      currentGeneration: canonicalIntakeDependencies.currentGeneration,
      expectedProducer: canonicalIntakeDependencies.expectedProducer,
      claimProducerSequence: (claim) =>
        canonicalIntakeStore.claimProducerSequence(claim)
    }
  );
  const providerFetch = options.fetch ?? globalThis.fetch;
  const reconcileConcurrency = Math.max(
    1,
    Math.min(options.agentReconcileConcurrency ?? 8, 64)
  );

  const reconcileOne = async (
    sessionId: string
  ): Promise<AgentProviderReconcileResult> => {
    const snapshot = router.sessions.stateSnapshot(sessionId);
    if (
      snapshot === undefined ||
      snapshot.lifecycle === 'exited' ||
      snapshot.subject.kind !== 'agent' ||
      snapshot.subject.provider !== 'opencode' ||
      snapshot.subject.mode !== 'terminal' ||
      snapshot.subject.producer !== 'opencode-terminal'
    ) {
      return { sessionId, kind: 'skipped', reason: 'not-opencode-session' };
    }
    const registration = endpointStore.getActive(
      sessionId,
      snapshot.generation,
      'opencode-terminal'
    );
    if (registration === undefined) {
      return { sessionId, kind: 'skipped', reason: 'endpoint-unregistered' };
    }
    if (registration.providerSessionId === undefined) {
      return {
        sessionId,
        kind: 'skipped',
        reason: 'provider-session-unregistered'
      };
    }
    const producerInstanceId = canonicalIntakeStore.producerInstance(
      sessionId,
      snapshot.generation,
      'opencode-terminal'
    );
    if (producerInstanceId === undefined) {
      return { sessionId, kind: 'skipped', reason: 'producer-unbound' };
    }
    if (producerInstanceId !== registration.producerInstanceId) {
      return {
        sessionId,
        kind: 'skipped',
        reason: 'producer-instance-mismatch'
      };
    }
    const reserved = endpointStore.reservePollSequence(
      sessionId,
      snapshot.generation,
      'opencode-terminal'
    );
    if (reserved === undefined) {
      return { sessionId, kind: 'skipped', reason: 'endpoint-unregistered' };
    }
    const observation = await reconcileOpencodeStatus(registration.endpoint, {
      fetch: providerFetch,
      ...(options.agentReconcileTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.agentReconcileTimeoutMs })
    });
    if (!observation.ok) {
      return { sessionId, kind: 'skipped', reason: 'poll-failed' };
    }
    const facts = observation.sessions.get(registration.providerSessionId);
    if (facts === undefined || facts.length === 0) {
      return { sessionId, kind: 'skipped', reason: 'no-facts' };
    }
    const observedAt = now();
    const envelope: AgentStateEnvelope = {
      schemaVersion: AGENT_STATE_SCHEMA_VERSION,
      sessionId,
      generation: snapshot.generation,
      provider: 'opencode',
      mode: 'terminal',
      producer: 'opencode-terminal',
      producerInstanceId,
      transport: 'poll',
      producerSeq: reserved.pollSeq,
      eventId: `poll:${reserved.pollSeq}`,
      invocationId: `poll:${reserved.pollSeq}`,
      occurredAt: observedAt,
      observedAt,
      facts
    };
    const result = router.sessions.ingestAgentState(envelope);
    return result.kind === 'accepted' || result.kind === 'duplicate'
      ? { sessionId, kind: 'reconciled' }
      : { sessionId, kind: 'skipped', reason: 'intake-rejected' };
  };

  const reconcileAgentProviders = async (
    sessionIds?: readonly string[]
  ): Promise<AgentProviderReconcileResult[]> => {
    const candidates = [
      ...new Set(
        sessionIds ??
          router.sessions.stateSnapshots().snapshots.map(
            (snapshot) => snapshot.sessionId
          )
      )
    ];
    const results = new Array<AgentProviderReconcileResult>(candidates.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const sessionId = candidates[index];
        if (sessionId === undefined) return;
        try {
          results[index] = await reconcileOne(sessionId);
        } catch {
          results[index] = {
            sessionId,
            kind: 'skipped',
            reason: 'recovery-error'
          };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(reconcileConcurrency, candidates.length) },
        worker
      )
    );
    return results;
  };
  const disposeBridge = installTerminalWsBridge(options.httpServer, router, options.wsPath !== undefined ? { path: options.wsPath } : {});

  // Moor rendezvous: `<root>/<sessionId>` — the holder publishes exactly this
  // name (no suffix); every consumer resolves it through this one function.
  const socketPath = (sessionId: string): string =>
    moorRendezvousPath(options.moorSocketRoot, sessionId);
  interface EventObserver {
    sessionId: string;
    generation: number;
    /** The per-generation committed event-store DIRECTORY. */
    path: string;
    observer: MoorEventObserver;
    /** One shared start/replay readiness result for every exact duplicate. */
    readonly ready: Promise<void>;
    /** Pending from map publication until the shared readiness is settled. */
    readiness: 'pending' | 'settled';
    /** A replaced pending registration can never later report readiness. */
    superseded: boolean;
    /**
     * desk#59 — the ONE final drain for this registration. Both the retired
     * transition's microtask and the awaited control wrapper join this same
     * promise, so the store is read exactly once no matter who asks first.
     */
    drainPromise?: Promise<void>;
  }
  const eventObservers = new Map<string, EventObserver>();
  const reportMoorDiagnostic = (
    observer: Pick<EventObserver, 'sessionId' | 'generation' | 'path'>,
    diagnostic: MoorEventDiagnostic
  ): void => {
    if (options.onMoorEventDiagnostic) {
      options.onMoorEventDiagnostic({ ...observer, diagnostic });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(
      `[moor-events] ${observer.sessionId}@${observer.generation} ${diagnostic.code}: ${diagnostic.message}`
    );
  };
  // Tag-01 path identity — the §1.2 CANONICAL SESSION identity form: 0x01
  // followed by the RAW path bytes (confirmed by the real binary's attach
  // fence). The EVENT-store identity is DIFFERENT: the real ATTACH_ACK
  // carries the handed-off path's raw posix bytes with NO tag (unix.rs
  // `event_path.as_os_str().as_bytes()`), so its comparand is the raw path.
  const tag01Identity = (path: string): Uint8Array => {
    const pathBytes = Buffer.from(path);
    const identity = new Uint8Array(1 + pathBytes.length);
    identity[0] = 1;
    identity.set(pathBytes, 1);
    return identity;
  };
  const eventStoreIdentity = (path: string): Uint8Array => new Uint8Array(Buffer.from(path));
  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  };
  /**
   * OB-39 event-store authority: the adopted ATTACH_ACK/STATUS descriptor must
   * exist, carry the store layout, and name EXACTLY (byte-for-byte raw POSIX
   * path bytes — never a lossy decoded string) the directory Desk handed to
   * this launch. Returns the acknowledged 4-field frontier the observer
   * replays from.
   */
  const resolveStoreAuthority = (
    status: MoorStatus | undefined,
    handedOffDir: string
  ):
    | { ok: true; frontier: { bodySlot: number; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array } }
    | { ok: false; error: string } => {
    if (status === undefined || status.layout !== 2) {
      return { ok: false, error: 'moor attach descriptor is missing or does not carry the event store' };
    }
    if (!bytesEqual(status.eventIdentity, eventStoreIdentity(handedOffDir))) {
      // Byte-for-byte against the raw handed-off path: a lossy decode can
      // never collapse distinct identities, and any mismatch — different
      // directory OR an unexpected identity shape — is the same refusal.
      return {
        ok: false,
        error:
          'moor event-store descriptor names a different directory than this launch handed off'
      };
    }
    return {
      ok: true,
      frontier: {
        bodySlot: status.bodySlot,
        commitIndex: status.commitIndex,
        bodyLength: status.bodyLength,
        bodyHash: status.bodyHash
      }
    };
  };
  /**
   * desk#59 — stop an observer only AFTER one last bounded read of its store.
   *
   * Moor commits the lifecycle before it unlinks, so at teardown the exit
   * record is routinely already committed and unread. Stopping first threw it
   * away and left the session recorded as "someone retired it", with no cause
   * of death — the exact blindness that made live agent deaths untraceable.
   *
   * The registration is rechecked AFTER the awaited drain: a successor
   * generation may have claimed this sessionId while we were reading, and a
   * stale observer must never unregister or speak for it.
   */
  const drainAndStopEventObserver = (observer: EventObserver): Promise<void> => {
    // Memoized per registration: a concurrent wrapper and transition must not
    // read the store twice, and the caller that arrives second must await the
    // work the first one already started rather than skipping it.
    observer.drainPromise ??= runFinalDrain(observer);
    return observer.drainPromise;
  };

  const runFinalDrain = async (observer: EventObserver): Promise<void> => {
    const outcome = await observer.observer.drain();
    if (outcome === 'unobservable') {
      // Durable first: stderr does not survive the daemon, and a blindness
      // nobody can read afterwards is the defect this issue exists to fix.
      // The refinement is generation-fenced and touches ONLY the diagnostic —
      // the reason that initiated this retirement stays exactly as recorded.
      // Recheck the registration AFTER the await: a successor may have claimed
      // this session id while we were reading, and a stale observer must never
      // annotate it.
      if (eventObservers.get(observer.sessionId) === observer) {
        router.sessions.refineExitDiagnostic(observer.sessionId, observer.generation, {
          code: 'moor-event-drain-unobservable'
        });
      }
      reportMoorDiagnostic(
        { sessionId: observer.sessionId, generation: observer.generation, path: observer.path },
        { code: 'tailer-io', message: 'final drain could not read the committed store' }
      );
    }
    if (eventObservers.get(observer.sessionId) === observer) {
      eventObservers.delete(observer.sessionId);
    }
  };

  const stopEventObserver = (observer: EventObserver): void => {
    observer.observer.stop();
    if (eventObservers.get(observer.sessionId) === observer) {
      eventObservers.delete(observer.sessionId);
    }
  };
  const cleanupFailedEventObserver = (observer: EventObserver): void => {
    const replayKey = moorTransitionKey(observer.sessionId, observer.generation);
    if (!observer.superseded) suppressedReplayTransitions.delete(replayKey);
    if (eventObservers.get(observer.sessionId) === observer) {
      eventObservers.delete(observer.sessionId);
    }
  };
  const initializeEventObserver = async (observer: EventObserver): Promise<void> => {
    const replayKey = moorTransitionKey(observer.sessionId, observer.generation);
    try {
      if (!(await observer.observer.start())) {
        throw new Error('moor event store could not be observed');
      }
      if (observer.superseded) {
        throw new Error('moor event observer registration was superseded');
      }
      // Downtime catch-up: the replay is fully delivered inside start(), so the
      // last suppressed transition IS the final caught-up state — publish it as
      // the one summary event downstream missed while the daemon was down. The
      // key was cleared before start(), so this entry belongs to exactly THIS
      // replay — publish unconditionally: a replayed exit legitimately stops
      // this very observer (cleanup microtask) and must still be announced.
      const caughtUp = suppressedReplayTransitions.get(replayKey);
      suppressedReplayTransitions.delete(replayKey);
      if (caughtUp !== undefined) {
        eventJournal.appendTransition(caughtUp);
      }
    } catch (error) {
      // Keep the failed exact registration published until its shared
      // readiness rejects. A duplicate arriving from stop/failure cleanup must
      // join that result instead of starting a replacement observer early.
      observer.observer.stop();
      throw error;
    }
  };
  const startEventObserver = async (
    sessionId: string,
    generation: number,
    path: string,
    descriptor?: { bodySlot: number; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array }
  ): Promise<EventObserver> => {
    const current = eventObservers.get(sessionId);
    if (current?.generation === generation && current.path === path) {
      await current.ready;
      if (current.superseded) {
        throw new Error('moor event observer registration was superseded');
      }
      return current;
    }
    const diagnosticIdentity = { sessionId, generation, path };
    const expectedIdentity = tag01Identity(socketPath(sessionId));
    const storeObserver = new MoorEventObserver({
      directory: path,
      generation,
      identity: expectedIdentity,
      ...(descriptor === undefined ? {} : { descriptor }),
      ...(options.moorEventPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.moorEventPollIntervalMs }),
      onEvent: async (event, context) => {
        let observedEvent = event;
        if (event.type === 'exit') {
          const evidence = await readCurrentMoorGenerationExitEvidence(
            socketPath(sessionId),
            generation
          );
          const outcomeMatches =
            (evidence.outcome.ended === 'exited' &&
              event.outcome.kind === 'exited' &&
              evidence.outcome.code === event.outcome.code &&
              evidence.outcome.method === event.outcome.method) ||
            (evidence.outcome.ended === 'signalled' &&
              event.outcome.kind === 'signalled' &&
              evidence.outcome.signal === event.outcome.signal &&
              evidence.outcome.method === event.outcome.method);
          if (!outcomeMatches) {
            throw new Error(`lifecycle/event exit mismatch for generation ${generation}`);
          }
          observedEvent = { ...event, outputEnd: BigInt(evidence.outputEnd) };
        }
        const replayKey = moorTransitionKey(sessionId, generation);
        if (context.phase === 'replay') replayingMoorTransitions.add(replayKey);
        try {
          router.sessions.observeMoorEvent(sessionId, generation, observedEvent);
        } finally {
          if (context.phase === 'replay') replayingMoorTransitions.delete(replayKey);
        }
      },
      onEventError: (error, event) => {
        if (error instanceof MoorCurrentExitEvidenceError) {
          return error.code === 'UNAVAILABLE' ? 'retry' : 'terminal';
        }
        return event.type === 'exit' ? 'terminal' : 'continue';
      },
      onDiagnostic: (message) =>
        reportMoorDiagnostic(diagnosticIdentity, { code: 'tailer-io', message }),
      onAvailabilityChange: (availability) => {
        const registered = eventObservers.get(sessionId);
        if (registered === undefined || registered.observer !== storeObserver) return;
        reportMoorDiagnostic(diagnosticIdentity, {
          code:
            availability.status === 'unavailable'
              ? 'observer-unavailable'
              : 'observer-recovered',
          message:
            availability.status === 'unavailable'
              ? `event-store observation unavailable after ${availability.consecutiveReadFailures} consecutive read failures: ${availability.message}`
              : 'event-store observation recovered'
        });
      },
      onTerminal: () => {
        // Observation is not holder lifetime authority. A structural event-
        // store contradiction stops this observer and leaves the store in place
        // for diagnosis, but it must never retire/SIGTERM an authenticated live
        // holder. Session exit still comes only from holder lifecycle evidence
        // or an explicit control-plane retirement.
        const registered = eventObservers.get(sessionId);
        if (registered === undefined || registered.observer !== storeObserver) {
          return;
        }
        registered.observer.stop();
        if (
          registered.readiness === 'settled' &&
          eventObservers.get(sessionId) === registered
        ) {
          eventObservers.delete(sessionId);
        }
      }
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let observer!: EventObserver;
    observer = {
      sessionId,
      generation,
      path,
      observer: storeObserver,
      ready,
      readiness: 'pending',
      superseded: false
    };
    // Registered BEFORE the replay runs: an already-committed exit transition
    // schedules its cleanup as a microtask, which must find this registration
    // (or the exited store would survive as an orphan).
    if (current) {
      current.superseded = true;
      stopEventObserver(current);
    }
    eventObservers.set(sessionId, observer);
    const replayKey = moorTransitionKey(sessionId, generation);
    suppressedReplayTransitions.delete(replayKey); // no stale carryover into this replay
    void initializeEventObserver(observer).then(
      () => {
        observer.readiness = 'settled';
        resolveReady();
      },
      (error) => {
        observer.readiness = 'settled';
        rejectReady(error);
        // Promise reactions for every current waiter were enqueued by the
        // rejection above. Cleanup follows in a later microtask, fenced to this
        // exact registration, so a non-overlapping retry can start afterwards.
        queueMicrotask(() => cleanupFailedEventObserver(observer));
      }
    );
    await observer.ready;
    if (observer.superseded) {
      throw new Error('moor event observer registration was superseded');
    }
    return observer;
  };
  async function reconcileMoorEvents(
    sessionId: string,
    generation: number
  ): Promise<boolean> {
    // Restart reconciliation and late retry adoption re-observe the surviving
    // holder's committed event store under the SAME OB-39 authority as
    // provision: the adopted ATTACH_ACK descriptor must exist and name exactly
    // the directory this launch derived, and replay starts at its frontier.
    const path = moorEventStoreDir(
      moorEventStoreRoot(options.moorBinPath),
      sessionId,
      generation
    );
    const diagnose = (message: string): false => {
      reportMoorDiagnostic(
        { sessionId, generation, path },
        { code: 'tailer-io', message }
      );
      return false;
    };
    const status = router.sessions.moorStatus(sessionId);
    if (status !== undefined && status.generation !== generation) {
      return diagnose(
        `could not reconcile the moor event store: adopted status is generation ${status.generation}, not ${generation}`
      );
    }
    const authority = resolveStoreAuthority(status, path);
    if (!authority.ok) {
      return diagnose(`could not reconcile the moor event store: ${authority.error}`);
    }
    if (!existsSync(path)) {
      return diagnose(
        'could not reconcile the moor event store: the acknowledged store directory does not exist'
      );
    }
    try {
      await startEventObserver(sessionId, generation, path, authority.frontier);
      return true;
    } catch (error) {
      return diagnose(
        `could not reconcile the moor event store: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  scheduleMoorObserverCleanup = (sessionId, generation, origin): void => {
    queueMicrotask(() => {
      const observer = eventObservers.get(sessionId);
      if (observer?.generation !== generation) return;
      // §11.6: observation stops here; the PUBLISHED store belongs to the
      // holder's own retirement cleanup — Desk never deletes it.
      if (origin === 'observed') {
        stopEventObserver(observer);
        return;
      }
      // The synchronous link-close path retires without going through the
      // control wrapper, so this is the ONLY final read it ever gets.
      void drainAndStopEventObserver(observer);
    });
  };

  type ContinuityFailure = Extract<
    ProviderSessionContinuityMutationResult,
    { ok: false }
  >;
  const continuityFailure = (
    reason: ContinuityFailure['reason'],
    error: string,
    detail: Partial<
      Pick<
        ContinuityFailure,
        'currentProviderSessionId' | 'targetProviderSessionId' | 'action'
      >
    > = {}
  ): ContinuityFailure => ({ ok: false, reason, error, ...detail });
  const bindingFailure = (
    failure: Extract<
      ReturnType<typeof readProviderSessionBinding>,
      { ok: false }
    >
  ): ContinuityFailure => continuityFailure(failure.code, failure.error);
  const evidenceFailure = (
    failure: Extract<ProviderSessionEvidenceResult, { ok: false }>
  ): ContinuityFailure => {
    const reason =
      failure.code === 'evidence-not-found'
        ? 'provider-session-evidence-missing'
        : failure.code === 'evidence-stale'
          ? 'provider-session-evidence-stale'
          : 'provider-session-evidence-invalid';
    return continuityFailure(reason, failure.error);
  };
  const selectedProviderSession = (deskSessionId: string) => {
    const manifestPath = options.manifestPath ?? resolveManifestPath();
    const homeDir = options.homeDir ?? homedir();
    return buildSessionSpecs(readManifestFile(manifestPath), { homeDir }).find(
      (candidate) => candidate.sessionId === deskSessionId
    );
  };
  const verifyEvidence = async (input: {
    deskSessionId: string;
    provider: ProviderSessionContinuityProvider;
    providerSessionId: string;
    notBeforeMs: number;
  }): Promise<ProviderSessionEvidenceResult | ContinuityFailure> => {
    const selected = selectedProviderSession(input.deskSessionId);
    if (!selected) {
      return continuityFailure(
        'provider-session-not-found',
        `Desk session not found: ${input.deskSessionId}`
      );
    }
    if (selected.agent !== input.provider) {
      return continuityFailure(
        'provider-session-agent-mismatch',
        `Desk session ${input.deskSessionId} is not configured for ${input.provider}`
      );
    }
    // Providers without an on-disk session store reader are authenticated by
    // the launch proof alone: it is per-generation, random, and already
    // verified before this point, while their stores (sqlite, per-cwd chats)
    // have no bounded evidence file to read.
    if (!isEvidenceCapableProvider(input.provider)) {
      return {
        ok: true,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        evidencePath: 'launch-proof'
      };
    }
    return evidenceVerifier({
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      selected: {
        cwd: selected.cwd,
        ...(selected.profileId === undefined
          ? {}
          : { profileId: selected.profileId })
      },
      homeDir: options.homeDir ?? homedir(),
      notBeforeMs: input.notBeforeMs
    });
  };
  const finishObservedLaunch = (
    input: CompleteProviderSessionLaunchInput
  ): ContinuityFailure | undefined => {
    const completed = providerLaunchLedger.complete(input);
    if (completed.ok) return undefined;
    return continuityFailure(
      'provider-session-store-failed',
      `provider launch completion failed: ${completed.reason}`
    );
  };
  const observeProviderSessionIdentity = (
    input: ObserveProviderSessionIdentityInput
  ): Promise<ProviderSessionContinuityMutationResult> =>
    runProviderContinuity(input?.deskSessionId ?? '', async () => {
      try {
        if (
          !input ||
          !isSafeDaemonSessionId(input.deskSessionId) ||
          !isHookIdentityProvider(input.provider) ||
          !isValidProviderSessionId(input.provider, input.providerSessionId) ||
          !Number.isSafeInteger(input.generation) ||
          input.generation < 2 ||
          typeof input.launchProof !== 'string' ||
          typeof input.hook !== 'string'
        ) {
          return continuityFailure(
            'provider-session-id-invalid',
            'Invalid provider session observation'
          );
        }
        const binding = readProviderSessionBinding({
          deskSessionId: input.deskSessionId,
          ...(options.manifestPath === undefined
            ? {}
            : { manifestPath: options.manifestPath }),
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir })
        });
        if (!binding.ok) return bindingFailure(binding);
        if (binding.provider !== input.provider) {
          return continuityFailure(
            'provider-session-provider-mismatch',
            `Desk session ${input.deskSessionId} is configured for ${binding.provider}, not ${input.provider}`
          );
        }
        if (ledger.current(input.deskSessionId) !== input.generation) {
          return continuityFailure(
            'provider-session-generation-mismatch',
            'Provider observation generation is not current'
          );
        }
        const status = router.sessions.moorStatus(input.deskSessionId);
        if (
          status === undefined ||
          status.generation !== input.generation ||
          !status.running
        ) {
          return continuityFailure(
            'provider-session-not-live',
            'Provider observation has no exact live adopted Moor generation'
          );
        }
        const proof = providerContinuityLedger.verifyLaunchProof({
          deskSessionId: input.deskSessionId,
          provider: input.provider,
          generation: input.generation,
          launchProof: input.launchProof
        });
        if (!proof.ok) {
          return continuityFailure(
            'provider-session-proof-invalid',
            'Provider launch proof is missing or invalid'
          );
        }
        const evidence = await verifyEvidence({
          deskSessionId: input.deskSessionId,
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          notBeforeMs: proof.issuedAt
        });
        if (!evidence.ok) {
          return 'reason' in evidence ? evidence : evidenceFailure(evidence);
        }
        if (binding.providerSessionId === null) {
          const persisted = await bindProviderSessionIdentity({
            deskSessionId: input.deskSessionId,
            provider: input.provider,
            providerSessionId: input.providerSessionId,
            ...(options.manifestPath === undefined
              ? {}
              : { manifestPath: options.manifestPath }),
            ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir })
          });
          if (!persisted.ok) {
            return continuityFailure(persisted.code, persisted.error);
          }
          const completionFailure = finishObservedLaunch({
            deskSessionId: input.deskSessionId,
            provider: input.provider,
            providerSessionId: input.providerSessionId,
            generation: input.generation
          });
          if (completionFailure) return completionFailure;
          return {
            ok: true,
            kind: 'bound',
            provider: input.provider,
            providerSessionId: input.providerSessionId
          };
        }
        if (binding.providerSessionId === input.providerSessionId) {
          const completionFailure = finishObservedLaunch({
            deskSessionId: input.deskSessionId,
            provider: input.provider,
            providerSessionId: input.providerSessionId,
            generation: input.generation
          });
          if (completionFailure) return completionFailure;
          return {
            ok: true,
            kind: 'matching',
            provider: input.provider,
            providerSessionId: input.providerSessionId
          };
        }
        providerContinuityLedger.stageTransition({
          deskSessionId: input.deskSessionId,
          provider: input.provider,
          generation: input.generation,
          expectedProviderSessionId: binding.providerSessionId,
          observedProviderSessionId: input.providerSessionId,
          evidencePath: evidence.evidencePath
        });
        return continuityFailure(
          'provider-session-rebind-required',
          'The running provider session differs from the durable Desk binding',
          {
            currentProviderSessionId: binding.providerSessionId,
            targetProviderSessionId: input.providerSessionId,
            action: rebindAction(
              input.deskSessionId,
              input.providerSessionId
            )
          }
        );
      } catch {
        return continuityFailure(
          'provider-session-store-failed',
          'Provider session continuity operation failed'
        );
      }
    });

  const rebindProviderSession = (
    input: RebindProviderSessionInput
  ): Promise<ProviderSessionContinuityMutationResult> =>
    runProviderContinuity(input?.deskSessionId ?? '', async () => {
      try {
        if (
          !input ||
          !isSafeDaemonSessionId(input.deskSessionId) ||
          typeof input.targetProviderSessionId !== 'string'
        ) {
          return continuityFailure(
            'provider-session-id-invalid',
            'Invalid provider session rebind request'
          );
        }
        const transition = providerContinuityLedger.currentTransition(
          input.deskSessionId
        );
        if (
          transition === undefined ||
          transition.state === 'cancelled-by-reset'
        ) {
          return continuityFailure(
            'provider-session-transition-missing',
            'No pending provider session transition exists'
          );
        }
        if (
          transition.observedProviderSessionId !==
          input.targetProviderSessionId
        ) {
          return continuityFailure(
            'provider-session-transition-mismatch',
            'Requested provider session does not match the current transition'
          );
        }
        if (
          !isValidProviderSessionId(
            transition.provider,
            input.targetProviderSessionId
          ) ||
          ledger.current(input.deskSessionId) !== transition.generation
        ) {
          return continuityFailure(
            'provider-session-generation-mismatch',
            'Provider transition generation is not current'
          );
        }
        const status = router.sessions.moorStatus(input.deskSessionId);
        if (
          status === undefined ||
          status.generation !== transition.generation ||
          !status.running
        ) {
          return continuityFailure(
            'provider-session-not-live',
            'Provider rebind has no exact live adopted Moor generation'
          );
        }
        const proof = providerContinuityLedger.proofContext(
          input.deskSessionId
        );
        if (
          proof === undefined ||
          proof.provider !== transition.provider ||
          proof.generation !== transition.generation
        ) {
          return continuityFailure(
            'provider-session-proof-invalid',
            'Provider transition has no exact launch proof context'
          );
        }
        const binding = readProviderSessionBinding({
          deskSessionId: input.deskSessionId,
          ...(options.manifestPath === undefined
            ? {}
            : { manifestPath: options.manifestPath }),
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir })
        });
        if (!binding.ok) return bindingFailure(binding);
        if (binding.provider !== transition.provider) {
          return continuityFailure(
            'provider-session-provider-mismatch',
            'Provider transition does not match the configured provider'
          );
        }
        if (
          binding.providerSessionId !== transition.expectedProviderSessionId &&
          binding.providerSessionId !== transition.observedProviderSessionId
        ) {
          return continuityFailure(
            'provider-session-mismatch',
            'Durable provider session changed outside the pending transition'
          );
        }
        const evidence = await verifyEvidence({
          deskSessionId: input.deskSessionId,
          provider: transition.provider,
          providerSessionId: transition.observedProviderSessionId,
          notBeforeMs: proof.issuedAt
        });
        if (!evidence.ok) {
          return 'reason' in evidence ? evidence : evidenceFailure(evidence);
        }
        if (transition.state === 'pending') {
          providerContinuityLedger.resolveTransition({
            deskSessionId: input.deskSessionId,
            transitionId: transition.transitionId,
            targetProviderSessionId: transition.observedProviderSessionId
          });
        }
        if (binding.providerSessionId === transition.observedProviderSessionId) {
          return {
            ok: true,
            kind: 'already-rebound',
            provider: transition.provider,
            providerSessionId: transition.observedProviderSessionId
          };
        }
        const replaced = await replaceProviderIdentity({
          deskSessionId: input.deskSessionId,
          provider: transition.provider,
          expectedProviderSessionId: transition.expectedProviderSessionId,
          providerSessionId: transition.observedProviderSessionId,
          ...(options.manifestPath === undefined
            ? {}
            : { manifestPath: options.manifestPath }),
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir })
        });
        if (!replaced.ok) {
          return continuityFailure(replaced.code, replaced.error);
        }
        return {
          ok: true,
          kind:
            replaced.kind === 'already-replaced'
              ? 'already-rebound'
              : 'rebound',
          provider: transition.provider,
          providerSessionId: transition.observedProviderSessionId
        };
      } catch {
        return continuityFailure(
          'provider-session-store-failed',
          'Provider session continuity operation failed'
        );
      }
    });

  return {
    router,
    async provision(sessionId, spec) {
      const sessionPath = socketPath(sessionId);
      let storeDir: string | undefined;
      let observedGeneration: number | undefined;
      const result = await router.sessions.spawnAndAttachMoor(sessionId, {
        binPath: options.moorBinPath,
        sessionPath,
        command: spec.command,
        geometry: spec.geometry,
        subject: spec.subject,
        preallocateSpawn: (context) => preallocateProviderSession(context, spec),
        // The ledger allocation is durable before this hook. Preserve the
        // predecessor's evidence with independent generation-scoped copies.
        // Stable companions stay nlink-one so Moor can retain lifecycle-derived
        // paths, remove stable .log/.events/.exit in that order, then remove the
        // predecessor's -T event store and -S instrument stage. The independent
        // archive remains readable; each holder still creates its own -T store.
        prepareSpawn: async ({ generation }) => {
          observedGeneration = generation;
          await archiveMoorGenerationStores(sessionPath, generation);
          storeDir = moorEventStoreDir(moorEventStoreRoot(options.moorBinPath), sessionId, generation);
          return { storeDir };
        },
        killSpec: {
          binPath: options.moorBinPath,
          args: ['kill', '-f', sessionPath],
          staleCleanupSpec: { binPath: options.moorBinPath, args: ['rm', sessionPath] }
        }
      });
      if (!result.ok) return result;
      // OB-39: the holder's ATTACH_ACK descriptor is the event-store
      // authority — the supervisor never guesses. The descriptor must exist,
      // carry the store layout, and name EXACTLY the directory this launch
      // handed to the holder; observation replays from the acknowledged
      // frontier, never behind it.
      const status = result.moorStatus;
      if (storeDir !== undefined && observedGeneration !== undefined) {
        // Every rejection below retires EXACTLY the generation this provision
        // observed — a stale provision result must never retire a successor.
        const handedOffDir = storeDir;
        const generation = observedGeneration;
        const authority = resolveStoreAuthority(status, handedOffDir);
        if (!authority.ok) {
          await router.sessions.retireGenerationAwaited(sessionId, generation, {
            reason: 'store-authority-refused'
          });
          throw new Error(authority.error);
        }
        try {
          await startEventObserver(sessionId, generation, handedOffDir, authority.frontier);
        } catch (error) {
          // Fail closed: a session whose lifecycle events cannot be observed
          // is not provisioned — tear the fresh holder down. Store cleanup
          // belongs to the holder's own retirement (§11.6); Desk deletes
          // nothing it merely named.
          await router.sessions.retireGenerationAwaited(sessionId, generation, {
            reason: 'observer-start-failed'
          });
          throw error;
        }
      }
      return result;
    },
    async retire(sessionId, reason) {
      const observer = eventObservers.get(sessionId);
      const result = await router.sessions.retireAwaited(sessionId, { reason });
      // desk#59: the drain runs AFTER the retire, so the placeholder already
      // exists and the holder's real exit can strengthen it in place.
      if (result.ok && observer) await drainAndStopEventObserver(observer);
      return result;
    },
    async retireGeneration(sessionId, generation) {
      const observer = eventObservers.get(sessionId);
      const result = await router.sessions.retireGenerationAwaited(sessionId, generation, {
        reason: 'control-retire'
      });
      if (result.ok && observer?.generation === generation) {
        await drainAndStopEventObserver(observer);
      }
      return result;
    },
    async resetProviderSession(sessionId) {
      const result = await router.sessions.resetForProviderSession(
        sessionId,
        socketPath(sessionId),
        (generation) => runProviderContinuity(sessionId, async () => {
          const observer = eventObservers.get(sessionId);
          if (observer) stopEventObserver(observer);
          const transition = providerContinuityLedger.currentTransition(
            sessionId
          );
          const cancellable =
            transition?.state === 'pending' ||
            transition?.state === 'resolved'
              ? transition
              : undefined;
          if (cancellable !== undefined) {
            const binding = readProviderSessionBinding({
              deskSessionId: sessionId,
              ...(options.manifestPath === undefined
                ? {}
                : { manifestPath: options.manifestPath }),
              ...(options.homeDir === undefined
                ? {}
                : { homeDir: options.homeDir })
            });
            const launchAuthorization = providerLaunchLedger.current(sessionId);
            if (
              !binding.ok ||
              binding.provider !== cancellable.provider ||
              (cancellable.state === 'pending'
                ? cancellable.generation !== generation
                : cancellable.generation > generation) ||
              (binding.providerSessionId !==
                cancellable.expectedProviderSessionId &&
                binding.providerSessionId !==
                  cancellable.observedProviderSessionId &&
                !(
                  binding.providerSessionId === null &&
                  launchAuthorization?.state === 'prepared'
                ))
            ) {
              return {
                ok: false as const,
                reason: 'provider-session-store-failed' as const,
                error:
                  'Provider session transition does not match reset state'
              };
            }
          }
          return authorizeProviderSessionReset(
            {
              deskSessionId: sessionId,
              generation,
              ...(options.manifestPath === undefined
                ? {}
                : { manifestPath: options.manifestPath }),
              ...(options.homeDir === undefined
                ? {}
                : { homeDir: options.homeDir })
            },
            {
              ledger: providerLaunchLedger,
              ...(cancellable === undefined
                ? {}
                : {
                    afterBindingCleared: (authorization: {
                      authorizationId: string;
                    }) => {
                      const current =
                        providerContinuityLedger.currentTransition(sessionId);
                      if (
                        current === undefined ||
                        current.state === 'cancelled-by-reset' ||
                        current.transitionId !== cancellable.transitionId
                      ) {
                        throw new Error(
                          'provider session transition changed during reset'
                        );
                      }
                      providerContinuityLedger.cancelTransitionByReset({
                        deskSessionId: sessionId,
                        transitionId: cancellable.transitionId,
                        resetAuthorizationId: authorization.authorizationId
                      });
                    }
                  })
            }
          );
        })
      );
      if (!result.ok) return result;
      return result.value;
    },
    completeProviderSessionLaunch(input) {
      return providerLaunchLedger.complete(input);
    },
    observeProviderSessionIdentity,
    rebindProviderSession,
    input(sessionId, bytes, paste = false) {
      return router.sessions.injectInput(sessionId, bytes, paste);
    },
    prompt(sessionId, bytes) {
      return router.sessions.injectPrompt(sessionId, bytes);
    },
    tail(sessionId, rows, offset = 0) {
      return router.sessions.historyText(sessionId, rows, offset);
    },
    terminalObservation(sessionId) {
      return router.sessions.terminalObservation(sessionId);
    },
    moorExitEvidence(sessionId) {
      return readMoorGenerationExitEvidence(socketPath(sessionId));
    },
    reconcileMoorEvents,
    clearSessionLog(sessionId) {
      return router.sessions.clearHolderLog(sessionId);
    },
    moorSessionStatus(sessionId) {
      return router.sessions.moorStatus(sessionId);
    },
    moorHolderPresence(sessionId) {
      return router.sessions.moorHolderPresence(sessionId, options.moorSocketRoot);
    },
    agentEndpoint(input) {
      return endpointStore.register(input);
    },
    async activateAgentEndpoint(input) {
      const result = endpointStore.activate(input);
      if (result.kind === 'activated' || result.kind === 'already-active') {
        await reconcileAgentProviders([result.registration.sessionId]);
      }
      return result;
    },
    reconcileAgentProviders,
    agentEvent(input, scope) {
      let envelope: AgentStateEnvelope;
      try {
        envelope = parseAgentStateEnvelope(input);
      } catch {
        return router.sessions.ingestAgentState(input);
      }
      if (envelope.producer !== 'opencode-terminal') {
        return scope === undefined
          ? router.sessions.ingestAgentState(envelope)
          : { kind: 'rejected', reason: 'invalid-provider-scope' };
      }
      if (scope?.kind === 'producer-bootstrap') {
        return envelope.facts.length === 1 &&
          envelope.facts[0]?.kind === 'heartbeat'
          ? router.sessions.ingestAgentState(envelope)
          : { kind: 'rejected', reason: 'invalid-provider-scope' };
      }
      if (
        scope?.kind !== 'provider-session' ||
        scope.providerSessionId.trim().length === 0
      ) {
        return {
          kind: 'rejected',
          reason: 'provider-session-unregistered'
        };
      }
      const registration = endpointStore.getActive(
        envelope.sessionId,
        envelope.generation,
        envelope.producer
      );
      if (registration === undefined) {
        return {
          kind: 'rejected',
          reason: 'provider-session-unregistered'
        };
      }
      if (registration.providerSessionId !== scope.providerSessionId) {
        return {
          kind: 'rejected',
          reason: 'provider-session-mismatch'
        };
      }
      if (registration.producerInstanceId !== envelope.producerInstanceId) {
        return {
          kind: 'rejected',
          reason: 'producer-instance-mismatch'
        };
      }
      return router.sessions.ingestAgentState(envelope);
    },
    agentStates() {
      return router.sessions.stateSnapshots();
    },
    events(limit) {
      return eventJournal.snapshot(limit === undefined ? {} : { limit });
    },
    channelEvent(input) {
      return eventJournal.appendChannel(input);
    },
    readEvents(input) {
      return eventJournal.markRead(input);
    },
    clearEvents() {
      return eventJournal.clear();
    },
    isReady() {
      return ready;
    },
    health() {
      return eventJournal.health();
    },
    markReady() {
      ready = true;
    },
    beginDrain() {
      draining = true;
    },
    isDraining() {
      return draining;
    },
    enterMutation(abort) {
      // Atomic with the drain check: either the mutation is admitted and
      // COUNTED (with its abort registered), or it is refused — there is no
      // window where a request saw not-draining but escaped the barrier.
      if (draining) return undefined;
      const registration = { abort };
      openMutations.add(registration);
      return () => {
        if (!openMutations.delete(registration)) return; // idempotent
        if (openMutations.size === 0 && mutationDrainWaiters.length > 0) {
          const waiters = mutationDrainWaiters;
          mutationDrainWaiters = [];
          for (const waiter of waiters) waiter();
        }
      };
    },
    awaitMutationDrain() {
      if (openMutations.size === 0) return Promise.resolve();
      return new Promise((resolve) => {
        mutationDrainWaiters.push(resolve);
      });
    },
    abortOpenMutations() {
      const severed = [...openMutations];
      for (const registration of severed) {
        try {
          registration.abort();
        } catch {
          // The connection is already gone; its close-path release follows.
        }
      }
      return severed.length;
    },
    dispose() {
      // ABRUPT teardown: no lease handover here — the graceful §7.4 viewer
      // detach (release + AWAITED released results) lives on the async
      // close() shutdown path, which runs it before calling dispose.
      for (const observer of [...eventObservers.values()]) {
        stopEventObserver(observer);
      }
      disposeBridge();
      intakeStore?.close();
      intakeStore = undefined;
      sessionGeometryStore.close();
      sessionScreenCheckpointStore.close();
      eventJournal.close();
      providerLaunchLedger.close();
      providerContinuityLedger.close();
    }
  };
}

/**
 * A sessionId that is safe to use as a socket filename under the socket root:
 * no path separators, NUL, or traversal. Minted session ids (lowercase +
 * digits + hyphen) and §10 sessionIds both satisfy this. The daemon rejects
 * anything else rather than letting a caller escape the socket root.
 */
export function isSafeDaemonSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/.test(value);
}

/** Control payloads are tiny (a session id + a short command array). */
const CONTROL_BODY_MAX_BYTES = 64 * 1024;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

function readSessionSubject(value: unknown): SessionRegistration['subject'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const subject = value as Record<string, unknown>;
  if (subject.kind === 'terminal') {
    return Object.keys(subject).length === 1 ? { kind: 'terminal' } : undefined;
  }
  if (
    subject.kind !== 'agent' ||
    typeof subject.provider !== 'string' ||
    typeof subject.mode !== 'string' ||
    typeof subject.producer !== 'string' ||
    (subject.producerInstanceId !== undefined && typeof subject.producerInstanceId !== 'string')
  ) {
    return undefined;
  }
  const allowedKeys = new Set(['kind', 'provider', 'mode', 'producer', 'producerInstanceId']);
  if (Object.keys(subject).some((key) => !allowedKeys.has(key))) return undefined;
  if (!Object.prototype.hasOwnProperty.call(AGENT_PRODUCER_BINDINGS, subject.producer)) return undefined;
  const producer = subject.producer as AgentProducer;
  const binding = AGENT_PRODUCER_BINDINGS[producer];
  if (binding.provider !== subject.provider || binding.mode !== subject.mode) return undefined;
  return {
    kind: 'agent',
    provider: binding.provider,
    mode: binding.mode,
    producer,
    ...(subject.producerInstanceId === undefined
      ? {}
      : { producerInstanceId: subject.producerInstanceId })
  };
}

export const PROVISION_GEOMETRY_ERROR =
  'provision geometry must be an object with integer rows and cols, each 1..32767, rows*cols at most 2000000';

/**
 * The caller-supplied provision geometry, exactly as supplied and validated
 * against the moor wire bound, or undefined when it is absent or malformed.
 * Nothing is clamped or defaulted: a caller that wants the creation size sends
 * SESSION_CREATION_GEOMETRY, and a malformed request is refused (400) rather
 * than recorded as a size somebody asked for.
 */
function readProvisionGeometry(value: unknown): SessionGeometry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { rows, cols } = value as { rows?: unknown; cols?: unknown };
  if (typeof rows !== 'number' || typeof cols !== 'number') return undefined;
  return isRealSessionGeometry({ rows, cols }) ? { rows, cols } : undefined;
}

function readAgentObservationScope(
  value: unknown
): AgentObservationScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const scope = value as Record<string, unknown>;
  if (
    scope.kind === 'producer-bootstrap' &&
    Object.keys(scope).length === 1
  ) {
    return { kind: 'producer-bootstrap' };
  }
  if (
    scope.kind === 'provider-session' &&
    typeof scope.providerSessionId === 'string' &&
    scope.providerSessionId.trim().length > 0 &&
    scope.providerSessionId.length <= 512 &&
    Object.keys(scope).length === 2
  ) {
    return {
      kind: 'provider-session',
      providerSessionId: scope.providerSessionId.trim()
    };
  }
  return undefined;
}

/**
 * The daemon's HTTP control plane: the web server posts here to provision/retire
 * a session's moor holder on demand (the spawn/boot/restart cutover path). It is
 * an ordinary `request` listener; the binary terminal transport rides the
 * separate `upgrade` event, so the two never collide. Bodies read through the
 * shared bounded `readJsonBody`; responses through the shared `sendJson`.
 */
export interface DaemonControlHandlerOptions {
  healthNonce?: string;
  prepareClaudeSessionStart?: (
    descriptor: ClaudeContinuityDescriptor,
    deskSessionId: string
  ) => unknown;
  syncClaudeProfileMemory?: (
    descriptor: ClaudeProfileMemoryDescriptor,
    deskSessionId: string
  ) => SyncClaudeProfileMemoryResult;
}

export function createDaemonControlHandler(
  daemon: Pick<
    TerminalDaemon,
    | 'provision'
    | 'retire'
    | 'retireGeneration'
    | 'resetProviderSession'
    | 'completeProviderSessionLaunch'
    | 'observeProviderSessionIdentity'
    | 'rebindProviderSession'
    | 'input'
    | 'prompt'
    | 'tail'
    | 'clearSessionLog'
    | 'moorSessionStatus'
    | 'moorHolderPresence'
    | 'terminalObservation'
    | 'moorExitEvidence'
    | 'agentEndpoint'
    | 'activateAgentEndpoint'
    | 'agentEvent'
    | 'agentStates'
    | 'events'
    | 'channelEvent'
    | 'readEvents'
    | 'clearEvents'
    | 'isReady'
    | 'isDraining'
    | 'enterMutation'
    | 'health'
  >,
  handlerOptions: DaemonControlHandlerOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://daemon.local');
        if (!daemon.isReady()) {
          // Startup reconciliation has not reached a terminal state. EVERY
          // control route (health included) answers 503: a provision accepted
          // now could ensure() at N+1 over a surviving master that reconcile
          // was about to adopt at N, and the ACK-mismatch cleanup would then
          // DESTROY that master. Callers retry; the supervisor probe reads
          // not-ready.
          sendJson(res, 503, { ok: false, error: 'starting' });
          return;
        }
        if (req.method !== 'GET') {
          // Mutation drain barrier — acquired BEFORE the first awaited body
          // read, atomically with the draining check: either this mutation is
          // admitted and COUNTED (shutdown then waits for it to finish, so
          // its lease lands in the handover snapshot), or it is refused 503.
          // A body that arrives after close() began can therefore never slip
          // a state change behind the lease snapshot. Read-only routes stay
          // answerable while existing connections drain.
          const releaseMutation = daemon.enterMutation(() => {
            // Shutdown escalation: sever this connection — its close event
            // fires the release below, so the barrier always empties.
            req.destroy();
          });
          if (releaseMutation === undefined) {
            sendJson(res, 503, { ok: false, error: 'draining' });
            return;
          }
          // Released on EVERY exit — normal finish, early return, thrown
          // route error (the catch below still sends a response), or a client
          // that vanished mid-body.
          let released = false;
          const releaseOnce = (): void => {
            if (!released) {
              released = true;
              releaseMutation();
            }
          };
          res.once('finish', releaseOnce);
          res.once('close', releaseOnce);
        }
        if (req.method === 'POST' && url.pathname === '/control/provision') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          if (!isStringArray(body.command)) {
            sendJson(res, 400, { ok: false, error: 'command must be a non-empty string[]' });
            return;
          }
          const subject = readSessionSubject(body.subject);
          if (subject === undefined) {
            sendJson(res, 400, { ok: false, error: 'invalid subject' });
            return;
          }
          let providerSessionId: string | undefined;
          if (body.providerSessionId !== undefined) {
            if (typeof body.providerSessionId !== 'string') {
              sendJson(res, 400, {
                ok: false,
                error: 'providerSessionId must be a string'
              });
              return;
            }
            providerSessionId = body.providerSessionId;
          }
          let claudeMemory: ClaudeProfileMemoryDescriptor | undefined;
          try {
            claudeMemory = readClaudeProfileMemoryDescriptor(body.claudeMemory);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            });
            return;
          }
          let continuity: ClaudeContinuityDescriptor | undefined;
          try {
            continuity = readClaudeContinuityDescriptor(body.continuity);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            });
            return;
          }
          let memoryAttention:
            | {
                code: 'claude-memory-conflicts' | 'claude-memory-sync-failed';
                count?: number;
                error?: string;
              }
            | undefined;
          if (claudeMemory) {
            try {
              const syncMemory =
                handlerOptions.syncClaudeProfileMemory ??
                ((descriptor: ClaudeProfileMemoryDescriptor) =>
                  syncClaudeProfileMemoryDefault({
                    homeDir: homedir(),
                    cwd: descriptor.cwd,
                    profileId: descriptor.profileId
                  }));
              const result = syncMemory(claudeMemory, body.sessionId);
              if (result.conflicts.length > 0) {
                memoryAttention = {
                  code: 'claude-memory-conflicts',
                  count: result.conflicts.length
                };
              }
            } catch (error) {
              if (handlerOptions.syncClaudeProfileMemory === undefined) {
                try {
                  recordClaudeProfileMemorySyncFailure(
                    {
                      homeDir: homedir(),
                      cwd: claudeMemory.cwd,
                      profileId: claudeMemory.profileId
                    },
                    error
                  );
                } catch {
                  // Provision remains available even when diagnostics cannot persist.
                }
              }
              memoryAttention = {
                code: 'claude-memory-sync-failed',
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
          if (continuity) {
            try {
              const prepare =
                handlerOptions.prepareClaudeSessionStart ??
                ((descriptor: ClaudeContinuityDescriptor, deskSessionId: string) =>
                  prepareClaudeSessionStartDefault({
                    homeDir: homedir(),
                    cwd: descriptor.cwd,
                    providerSessionId: descriptor.providerSessionId,
                    profileId: descriptor.profileId ?? undefined,
                    deskSessionId
                  }));
              prepare(continuity, body.sessionId);
            } catch (error) {
              const code = (error as { code?: unknown } | undefined)?.code;
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 409, {
                ok: false,
                error:
                  typeof code === 'string' && code.startsWith('continuity-')
                    ? `${code}: ${message}`
                    : message
              });
              return;
            }
          }
          const geometry = readProvisionGeometry(body.geometry);
          if (geometry === undefined) {
            sendJson(res, 400, { ok: false, error: PROVISION_GEOMETRY_ERROR });
            return;
          }
          const ens = await daemon.provision(body.sessionId, {
            command: body.command,
            geometry,
            subject,
            ...(providerSessionId === undefined ? {} : { providerSessionId })
          });
          if (ens.ok) {
            sendJson(res, 200, {
              ok: true,
              ...(memoryAttention === undefined ? {} : { memoryAttention })
            });
          } else {
            const detail = 'detail' in ens ? ens.detail : undefined;
            const recovery =
              detail === 'reset-incomplete'
                ? `rerun \`desk reset-provider-session ${body.sessionId} --force\` to finish the interrupted reset`
                : detail === 'authorization-consumed'
                  ? `rerun \`desk reset-provider-session ${body.sessionId} --force\` after confirming the prior provider process is stopped`
                  : 'action' in ens && typeof ens.action === 'string'
                    ? ens.action
                    : undefined;
            const cause =
              detail ??
              ('error' in ens && typeof ens.error === 'string' ? ens.error : undefined);
            sendJson(res, 503, {
              ok: false,
              error: `${ens.reason}${
                cause === undefined ? '' : `: ${cause}`
              }${recovery === undefined ? '' : `; ${recovery}`}`,
              ...(detail === undefined ? {} : { detail }),
              ...(recovery === undefined ? {} : { recovery })
            });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/moor-status') {
          const sessionId = url.searchParams.get('sessionId');
          if (!isSafeDaemonSessionId(sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          // #8: liveness/creation-time are WIRE truth, never filesystem
          // guesses. The adopted ATTACH_ACK descriptor exists exactly while a
          // live adopted link exists (published after markRunning, cleared in
          // beginRetire), and its wallStart is the holder's own start clock.
          const status = daemon.moorSessionStatus(sessionId);
          if (status === undefined) {
            // desk#50b: this 404 states that THIS DAEMON holds no adopted
            // link — nothing more. It is the daemon's honest answer during the
            // whole re-adoption window and after any controller link loss,
            // while the holder runs on. Callers read it as a licence to start,
            // so the envelope must also answer the separable question it was
            // being mistaken for: is a holder nevertheless there?
            //
            // The shared literal, not a local copy: callers tell this negative
            // verdict apart from any other 404 by its exact wording, and a
            // reworded copy would read to them as "some proxy said not-found".
            sendJson(res, 404, {
              ok: false,
              error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
              holder: await daemon.moorHolderPresence(sessionId)
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            generation: status.generation,
            wallStartMs: Number(status.wallStart),
            pid: status.pid,
            running: status.running
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/log-clear') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          // §10.2.13: the FULL result algebra reaches the control-plane
          // caller — cleared and already-clear are both success, refused is
          // the holder's completed decision, indeterminate got no valid
          // complete result and nothing may be assumed about it.
          const outcome = await daemon.clearSessionLog(body.sessionId);
          if (outcome === 'no-link') {
            sendJson(res, 404, { ok: false, outcome, error: 'session has no live moor link' });
            return;
          }
          const ok = outcome === 'cleared' || outcome === 'already-clear';
          sendJson(res, ok ? 200 : outcome === 'refused' ? 409 : 502, { ok, outcome });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/retire') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          // desk#59: the cause is part of the request, not something the
          // transport invents. An unknown or absent cause is refused rather
          // than silently relabelled as a generic control retire.
          if (!isRetireReason(body.reason)) {
            sendJson(res, 400, { ok: false, error: 'invalid retire reason' });
            return;
          }
          const retired = await daemon.retire(body.sessionId, body.reason);
          if (!retired.ok) {
            sendJson(res, 502, { ok: false, error: retired.error ?? 'retire failed' });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/provider-session/reset'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          const result = await daemon.resetProviderSession(body.sessionId);
          if (!result.ok) {
            const status =
              result.reason === 'provider-session-not-found'
                ? 404
                : result.reason === 'retire-failed'
                  ? 502
                  : result.reason === 'provider-session-store-failed'
                    ? 500
                    : 409;
            sendJson(res, status, result);
            return;
          }
          sendJson(res, 200, result);
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/provider-session/complete'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          if (!isSafeDaemonSessionId(body.deskSessionId)) {
            sendJson(res, 400, {
              ok: false,
              error: 'invalid deskSessionId'
            });
            return;
          }
          if (!isProviderSessionProvider(body.provider)) {
            sendJson(res, 400, { ok: false, error: 'invalid provider' });
            return;
          }
          if (
            typeof body.providerSessionId !== 'string' ||
            !isValidProviderSessionId(
              body.provider,
              body.providerSessionId
            )
          ) {
            sendJson(res, 400, {
              ok: false,
              error: 'invalid providerSessionId'
            });
            return;
          }
          if (
            !Number.isSafeInteger(body.generation) ||
            (body.generation as number) <= 0
          ) {
            sendJson(res, 400, {
              ok: false,
              error: 'generation must be a positive safe integer'
            });
            return;
          }
          const result = daemon.completeProviderSessionLaunch({
            deskSessionId: body.deskSessionId,
            provider: body.provider as ProviderSessionProvider,
            providerSessionId: body.providerSessionId,
            generation: body.generation as number
          });
          if (!result.ok) {
            sendJson(res, 409, result);
            return;
          }
          sendJson(res, 200, { ok: true, kind: result.kind });
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/provider-session/observe'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          if (
            Object.keys(body).sort().join(',') !==
              'deskSessionId,generation,hook,launchProof,provider,providerSessionId' ||
            !isSafeDaemonSessionId(body.deskSessionId) ||
            !isHookIdentityProvider(body.provider) ||
            typeof body.providerSessionId !== 'string' ||
            !isValidProviderSessionId(
              body.provider,
              body.providerSessionId
            ) ||
            !Number.isSafeInteger(body.generation) ||
            (body.generation as number) < 2 ||
            typeof body.launchProof !== 'string' ||
            typeof body.hook !== 'string' ||
            body.hook.length === 0 ||
            body.hook.length > 128
          ) {
            sendJson(res, 400, {
              ok: false,
              reason: 'provider-session-observation-invalid',
              error: 'invalid provider session observation'
            });
            return;
          }
          const result = await daemon.observeProviderSessionIdentity({
            deskSessionId: body.deskSessionId,
            provider: body.provider,
            providerSessionId: body.providerSessionId,
            generation: body.generation as number,
            launchProof: body.launchProof,
            hook: body.hook
          });
          if (!result.ok) {
            const status =
              result.reason === 'provider-session-not-found'
                ? 404
                : result.reason === 'provider-session-store-failed'
                  ? 500
                  : 409;
            sendJson(res, status, result);
            return;
          }
          sendJson(res, 200, result);
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/provider-session/rebind'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          if (
            Object.keys(body).sort().join(',') !==
              'sessionId,targetProviderSessionId' ||
            !isSafeDaemonSessionId(body.sessionId) ||
            typeof body.targetProviderSessionId !== 'string'
          ) {
            sendJson(res, 400, {
              ok: false,
              reason: 'provider-session-rebind-invalid',
              error: 'invalid provider session rebind request'
            });
            return;
          }
          const result = await daemon.rebindProviderSession({
            deskSessionId: body.sessionId,
            targetProviderSessionId: body.targetProviderSessionId
          });
          if (!result.ok) {
            const status =
              result.reason === 'provider-session-not-found' ||
              result.reason === 'provider-session-transition-missing'
                ? 404
                : result.reason === 'provider-session-store-failed'
                  ? 500
                  : 409;
            sendJson(res, status, result);
            return;
          }
          sendJson(res, 200, result);
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/retire-generation'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          if (
            !Number.isSafeInteger(body.generation) ||
            (body.generation as number) <= 0
          ) {
            sendJson(res, 400, {
              ok: false,
              error: 'generation must be a positive safe integer'
            });
            return;
          }
          const retired = await daemon.retireGeneration(
            body.sessionId,
            body.generation as number
          );
          if (!retired.ok) {
            const status =
              retired.reason === 'session-not-found'
                ? 404
                : retired.reason === 'generation-mismatch'
                  ? 409
                  : 502;
            sendJson(res, status, retired);
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/input') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          if (typeof body.text !== 'string' || body.text.length === 0) {
            sendJson(res, 400, { ok: false, error: 'text must be a non-empty string' });
            return;
          }
          const accepted = daemon.input(body.sessionId, new TextEncoder().encode(body.text), body.paste === true);
          if (!accepted) {
            // An unknown session is a concrete failure the channels engine must
            // see (it reverts the delivery), never a silent ok.
            sendJson(res, 404, { ok: false, error: `no such session: ${body.sessionId}` });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/prompt') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          if (typeof body.text !== 'string' || body.text.length === 0) {
            sendJson(res, 400, { ok: false, error: 'text must be a non-empty string' });
            return;
          }
          const accepted = await daemon.prompt(body.sessionId, new TextEncoder().encode(body.text));
          if (!accepted) {
            sendJson(res, 404, { ok: false, error: `no such session: ${body.sessionId}` });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/tail') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          const rows = Number(body.rows);
          const bounded = Number.isFinite(rows) && rows > 0 ? Math.min(Math.floor(rows), 2000) : 200;
          // offset counts lines back from the live edge; absent/invalid = 0
          // (the live tail — the pre-range contract unchanged).
          const offsetRaw = Number(body.offset);
          const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), 5000) : 0;
          const window = daemon.tail(body.sessionId, bounded, offset);
          if (window === undefined) {
            sendJson(res, 404, { ok: false, error: `no such session: ${body.sessionId}` });
            return;
          }
          sendJson(res, 200, { ok: true, lines: window.lines, totalAvailable: window.totalAvailable });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/terminal-observation') {
          const sessionId = url.searchParams.get('sessionId');
          if (!isSafeDaemonSessionId(sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          const observation = daemon.terminalObservation(sessionId);
          const exitEvidence = await daemon.moorExitEvidence(sessionId);
          if (observation === undefined && exitEvidence.length === 0) {
            sendJson(res, 404, { ok: false, error: `no such session: ${sessionId}` });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            observation: observation ?? null,
            exitEvidence
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/agent-event') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          const wrapped =
            Object.prototype.hasOwnProperty.call(body, 'envelope') ||
            Object.prototype.hasOwnProperty.call(body, 'scope');
          let envelope: unknown = body;
          let scope: AgentObservationScope | undefined;
          if (wrapped) {
            scope = readAgentObservationScope(body.scope);
            if (
              !Object.prototype.hasOwnProperty.call(body, 'envelope') ||
              scope === undefined ||
              Object.keys(body).some(
                (key) => key !== 'envelope' && key !== 'scope'
              )
            ) {
              sendJson(res, 400, {
                ok: false,
                reason: 'invalid-provider-scope'
              });
              return;
            }
            envelope = body.envelope;
          }
          const result =
            scope === undefined
              ? daemon.agentEvent(envelope)
              : daemon.agentEvent(envelope, scope);
          if (result.kind === 'accepted' || result.kind === 'duplicate') {
            sendJson(res, 200, {
              ok: true,
              kind: result.kind,
              acceptanceId: result.event.acceptanceId,
              acceptedSeq: result.event.acceptedSeq
            });
            return;
          }
          const status =
            result.reason === 'invalid-envelope' ||
            result.reason === 'invalid-provider-scope'
            ? 400
            : result.reason === 'producer-unregistered'
              ? 404
              : 409;
          sendJson(res, status, {
            ok: false,
            reason: result.reason,
            ...(result.carried === undefined ? {} : { carried: result.carried }),
            ...(result.current === undefined ? {} : { current: result.current })
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/agent-endpoint') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          const result = daemon.agentEndpoint(body);
          if (result.kind === 'accepted' || result.kind === 'duplicate') {
            sendJson(res, 200, {
              ok: true,
              kind: result.kind,
              active: result.active
            });
            return;
          }
          const status =
            result.reason === 'invalid-registration' ||
            result.reason === 'provider-session-id-invalid'
              ? 400
              : result.reason === 'producer-unregistered'
                ? 404
                : 409;
          sendJson(res, status, {
            ok: false,
            reason: result.reason,
            ...(result.carried === undefined ? {} : { carried: result.carried }),
            ...(result.current === undefined ? {} : { current: result.current })
          });
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/agent-endpoint/activate'
        ) {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          const result = await daemon.activateAgentEndpoint(body);
          if (result.kind === 'rejected') {
            const status =
              result.reason === 'invalid-activation' ||
              result.reason === 'provider-session-id-invalid'
                ? 400
                : result.reason === 'endpoint-unregistered'
                  ? 404
                  : 409;
            sendJson(res, status, { ok: false, reason: result.reason });
            return;
          }
          sendJson(res, 200, { ok: true, kind: result.kind });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/agent-states') {
          sendJson(res, 200, { ok: true, ...daemon.agentStates() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/events') {
          const requested = Number(url.searchParams.get('limit'));
          const limit =
            Number.isSafeInteger(requested) && requested > 0
              ? Math.min(requested, 1_000)
              : 200;
          sendJson(res, 200, { ok: true, ...daemon.events(limit) });
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/events/channel'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          let input: ChannelMessageDeskEventInput;
          try {
            input = parseChannelMessageDeskEventInput(body);
          } catch {
            sendJson(res, 400, {
              ok: false,
              error: 'invalid channel event'
            });
            return;
          }
          const result = daemon.channelEvent(input);
          if (result.kind === 'conflict') {
            sendJson(res, 409, {
              ok: false,
              error: 'channel event idempotency conflict'
            });
            return;
          }
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/events/read'
        ) {
          const body = await readJsonBody(req, {
            maxBytes: CONTROL_BODY_MAX_BYTES
          });
          let input: DeskEventReadRequest;
          try {
            input = parseDeskEventReadRequest(body);
          } catch {
            sendJson(res, 400, {
              ok: false,
              error: 'invalid event read request'
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            unread: daemon.readEvents(input)
          });
          return;
        }
        if (
          req.method === 'POST' &&
          url.pathname === '/control/events/clear'
        ) {
          sendJson(res, 200, {
            ok: true,
            unread: daemon.clearEvents()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/control/health') {
          const health = daemon.health();
          sendJson(res, 200, {
            ok: true,
            ...(health.status === 'degraded' ? health : {}),
            ...(handlerOptions.healthNonce !== undefined ? { nonce: handlerOptions.healthNonce } : {})
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        if (error instanceof HttpBodyError) {
          sendJson(res, error.statusCode, { ok: false, error: error.message });
          return;
        }
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
}

export interface ProvisionRequest {
  sessionId: string;
  spec: TerminalDaemonSessionSpec;
}

/**
 * Provision moor holders for a set of sessions (the daemon process's startup
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

export interface RunTerminalDaemonOptions extends Omit<TerminalDaemonOptions, 'httpServer'> {
  host?: string;
  port: number;
  sessions: readonly ProvisionRequest[];
  /**
   * Leave the daemon NOT-ready after provisioning (every control route 503s)
   * so the caller can finish its own startup work — the process entry defers
   * until its reconcile pass reaches a terminal state, closing the window
   * where a provision could destroy a surviving master mid-adoption.
   */
  deferReady?: boolean;
}

export interface RunningTerminalDaemon {
  daemon: TerminalDaemon;
  server: import('node:http').Server;
  port: number;
  provisioned: { sessionId: string; ok: boolean; error?: string }[];
  close(): Promise<void>;
}

/**
 * The daemon-process main: start the standalone terminal daemon server, then
 * provision the moor holder for each running session. Returns a handle with the
 * bound port and per-session provisioning results; a process entry adds the
 * signal handling around it.
 */
export async function runTerminalDaemon(options: RunTerminalDaemonOptions): Promise<RunningTerminalDaemon> {
  const server = await startTerminalDaemonServer(options);
  // provisionSessions drives the daemon directly (not over HTTP), so the
  // not-ready gate does not block this startup provisioning.
  const provisioned = await provisionSessions(server.daemon, options.sessions);
  if (options.deferReady !== true) {
    server.daemon.markReady();
  }
  return { daemon: server.daemon, server: server.server, port: server.port, provisioned, close: server.close };
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
 * connects out to this over the WS proxy.
 */
export async function startTerminalDaemonServer(
  options: Omit<TerminalDaemonOptions, 'httpServer'> & { host?: string; port: number }
): Promise<TerminalDaemonServer> {
  const server = createServer();
  // The socket root must exist (0700, this user) BEFORE anything can bind
  // <root>/<sessionId> — the holder skips its own mkdir for slash-bearing names
  // and the master's bind() fails ENOENT on an absent parent.
  ensurePrivateSocketRoot(options.moorSocketRoot);
  const daemon = createTerminalDaemon({ ...options, httpServer: server });
  server.on(
    'request',
    createDaemonControlHandler(daemon, options.healthNonce !== undefined ? { healthNonce: options.healthNonce } : {})
  );
  // Reject cleanly on a bind failure (EADDRINUSE during an HMR/serve overlap)
  // instead of emitting an unhandled server 'error'.
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      daemon.dispose();
      reject(error);
    };
    server.once('error', onError);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  let shutdownPromise: Promise<void> | undefined;
  return {
    daemon,
    server,
    port,
    close() {
      // Single-flight: repeated close calls (SIGINT + SIGTERM racing) join
      // the SAME shutdown promise instead of re-running the sequence.
      shutdownPromise ??= (async () => {
        // 1. DRAIN synchronously as the very first instruction: from here the
        //    control plane refuses every state-changing request, so nothing
        //    can install a master behind the handover snapshot.
        daemon.beginDrain();
        // 2. Stop accepting NEW http connections (existing ones finish their
        //    current — already drain-refused — requests).
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        // 3. TRULY await the mutation barrier — no shutdown step past this
        //    line can run while an admitted mutation can still run. Bounded
        //    by ESCALATION, not by giving up: a request that has not
        //    finished within 5 s is severed (its connection destroyed),
        //    which fires its close-path release, so the barrier always
        //    empties. The client sees an aborted connection — never a 200
        //    behind the lease snapshot.
        const escalate = setTimeout(() => {
          const severed = daemon.abortOpenMutations();
          if (severed > 0) {
            process.stderr.write(
              `desk daemon shutdown: severed ${severed} still-open control mutation(s) after the drain deadline\n`
            );
          }
        }, 5_000);
        escalate.unref?.();
        await daemon.awaitMutationDrain();
        clearTimeout(escalate);
        // 4. Settle every in-flight provision that could still attach and
        //    take a lease; only then is the master map final.
        await daemon.router.sessions.awaitInflightSpawns();
        // 4. §7.4 graceful viewer detach: release every owned lease and WAIT
        //    for the released results (bounded by the client's 2 s release
        //    deadline). Refused/indeterminate outcomes are reported on
        //    stderr — a failed handover is a fact of the departure, never a
        //    silent drop; the holders survive either way.
        const handover = await daemon.router.sessions.releaseAllLeases();
        for (const entry of handover) {
          if (entry.outcome !== 'released') {
            process.stderr.write(
              `desk daemon shutdown: lease handover for ${entry.sessionId}: ${entry.outcome}\n`
            );
          }
        }
        // 5. Close the viewer links (detach WITHOUT retiring — the holders
        //    outlive the daemon), tear the daemon down, finish server close.
        daemon.router.sessions.closeAllLinks();
        daemon.dispose();
        await serverClosed;
      })();
      return shutdownPromise;
    }
  };
}
