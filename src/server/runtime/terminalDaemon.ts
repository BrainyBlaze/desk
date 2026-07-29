// Terminal daemon assembly (cutover Phase 2 Step 3, core). Composes the durable
// terminal daemon the web server mounts at cutover: a TerminalWsRouter backed by
// a fsync'd generation ledger and the real @xterm/headless emulator, the binary
// WS bridge on /ws/terminal, and atch session provisioning via @codex's verified
// contract (CREATE = `atch start ABSOLUTE_SOCKET_PATH cmd`, KILL = `atch kill -f
// ABSOLUTE_SOCKET_PATH`; a slash-bearing name is the socket path, which isolates
// the canary under a dedicated socket root).
//
// This IS the product's terminal transport: the daemon supervisor spawns it
// and the web server proxies /ws/terminal to it. Instantiating it directly is
// how tests and a hand-run daemon (DESK_DAEMON_EXTERNAL) compose the pieces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { ensurePrivateSocketRoot } from '../../shared/atchPaths.js';
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
  type SessionStateSnapshot
} from '../../shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../../shared/runtime/index.js';
import { TerminalWsRouter } from './terminalWsRouter.js';
import { XtermEmulatorFactory } from './xtermEmulator.js';
import { FileGenerationLedgerStore } from './fileGenerationLedger.js';
import { installTerminalWsBridge } from '../terminalWsBridge.js';
import { HttpBodyError, readJsonBody, sendJson } from '../httpUtil.js';
import type { DaemonAgentStateIntakeResult, EnsureResult } from '../../shared/runtime/daemonCore.js';
import {
  FileIntakeStore,
  type FileIntakeStoreDependencies
} from './fileIntakeStore.js';
import {
  FileAgentEndpointStore,
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
  AtchEventTailer,
  atchEventPath,
  prepareAtchEventSink,
  type AtchEventDiagnostic
} from './atchEvents.js';
import type { TerminalObservationSnapshot } from './sessionManager.js';
import type { AgentObservationScope } from '../../core/agentState/providerAdapter.js';

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
  /** Poll cadence for generation-bound atch event sinks. */
  atchEventPollIntervalMs?: number;
  /** Injectable structured diagnostic sink for atch event ingestion. */
  onAtchEventDiagnostic?: (context: {
    sessionId: string;
    generation: number;
    path: string;
    diagnostic: AtchEventDiagnostic;
  }) => void;
}

/** A provisionable session: the command to run and its initial geometry. */
export interface TerminalDaemonSessionSpec {
  command: string[];
  geometry: { rows: number; cols: number };
  subject: SessionRegistration['subject'];
}

/** Provision outcome: ensure result, or the spawn/attach failure that rolled back. */
export type ProvisionResult = EnsureResult | { ok: false; reason: 'spawn-failed' | 'attach-failed' };

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

export interface TerminalDaemon {
  readonly router: TerminalWsRouter;
  /** Spawn + attach the atch master for a session (CREATE contract). */
  provision(sessionId: string, spec: TerminalDaemonSessionSpec): Promise<ProvisionResult>;
  /**
   * Retire a session (KILL contract), resolving only after the kill command
   * completed AND the master's socket disappeared — the restart flow provisions
   * immediately after, and a stale socket would be adopted at the old
   * generation. A failed kill is a failure, never a silent 200.
   */
  retire(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  /** Control-plane input injection (channels delivery). False if unknown. */
  input(sessionId: string, bytes: Uint8Array, paste?: boolean): boolean;
  /**
   * Ranged plain-text window into the session's screen + scrollback. `offset`
   * counts lines back from the live edge (0/absent = the live tail); reads at
   * or beyond the top yield empty lines with totalAvailable telling the
   * caller where the top is. Undefined when the session is unknown.
   */
  tail(sessionId: string, rows: number, offset?: number): { lines: string[]; totalAvailable: number } | undefined;
  /** Latest generation-bound terminal observation, independent of semantic authority. */
  terminalObservation(sessionId: string): TerminalObservationSnapshot | undefined;
  /** Re-open a surviving generation's event sink after daemon restart. */
  reconcileAtchEvents(sessionId: string, generation: number): boolean;
  /** Bind durable provider transport metadata to the canonical producer sequence. */
  agentEndpoint(input: unknown): AgentEndpointStoreResult;
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
  const ledger = new GenerationLedger(new FileGenerationLedgerStore(join(options.homeRoot, '_engine', 'generation-ledger.json')));
  const eventJournal = new FileDeskEventJournal(
    join(options.homeRoot, '_engine', 'desk-events.ndjson')
  );
  let intakeStore: FileIntakeStore | undefined;
  let intakeDependencies: FileIntakeStoreDependencies | undefined;
  const now = options.now ?? Date.now;
  const hookInstallationProbe =
    options.hookInstallationProbe ?? probeHookInstallation;
  let ready = false;
  let scheduleAtchObserverCleanup = (
    _sessionId: string,
    _generation: number
  ): void => {};
  const replayingAtchTransitions = new Set<string>();
  const atchTransitionKey = (sessionId: string, generation: number): string =>
    `${sessionId}\0${generation}`;
  const router = new TerminalWsRouter({
    ledger,
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: new XtermEmulatorFactory(),
    now,
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
      if (
        !replayingAtchTransitions.has(
          atchTransitionKey(transition.sessionId, transition.generation)
        )
      ) {
        eventJournal.appendTransition(transition);
      }
      if (transition.cause === 'lifecycle-exited') {
        scheduleAtchObserverCleanup(
          transition.sessionId,
          transition.generation
        );
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
    const registration = endpointStore.get(
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

  const socketPath = (sessionId: string): string => join(options.atchSocketRoot, `${sessionId}.sock`);
  interface EventObserver {
    sessionId: string;
    generation: number;
    path: string;
    tailer: AtchEventTailer;
  }
  const eventObservers = new Map<string, EventObserver>();
  const reportAtchDiagnostic = (
    observer: Pick<EventObserver, 'sessionId' | 'generation' | 'path'>,
    diagnostic: AtchEventDiagnostic
  ): void => {
    if (options.onAtchEventDiagnostic) {
      options.onAtchEventDiagnostic({ ...observer, diagnostic });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(
      `[atch-events] ${observer.sessionId}@${observer.generation} ${diagnostic.code}: ${diagnostic.message}`
    );
  };
  const stopEventObserver = (observer: EventObserver, removeSink: boolean): void => {
    observer.tailer.stop();
    if (eventObservers.get(observer.sessionId) === observer) {
      eventObservers.delete(observer.sessionId);
    }
    if (removeSink) {
      try {
        unlinkSync(observer.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          reportAtchDiagnostic(observer, {
            code: 'tailer-io',
            message: `could not remove atch event sink: ${
              error instanceof Error ? error.message : String(error)
            }`
          });
        }
      }
    }
  };
  const startEventObserver = (
    sessionId: string,
    generation: number,
    path: string
  ): EventObserver => {
    const current = eventObservers.get(sessionId);
    if (current?.generation === generation && current.path === path) return current;
    let observer: EventObserver;
    const tailer = new AtchEventTailer({
      path,
      ...(options.atchEventPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.atchEventPollIntervalMs }),
      onEvent: (event, context) => {
        const replayKey = atchTransitionKey(sessionId, generation);
        if (context.phase === 'replay') replayingAtchTransitions.add(replayKey);
        try {
          router.sessions.observeAtchEvent(sessionId, generation, event);
        } finally {
          if (context.phase === 'replay') replayingAtchTransitions.delete(replayKey);
        }
      },
      onDiagnostic: (diagnostic) => reportAtchDiagnostic(observer, diagnostic)
    });
    observer = { sessionId, generation, path, tailer };
    if (!tailer.start()) {
      throw new Error('atch event sink could not be opened securely');
    }
    if (current) stopEventObserver(current, false);
    eventObservers.set(sessionId, observer);
    return observer;
  };
  scheduleAtchObserverCleanup = (sessionId, generation): void => {
    queueMicrotask(() => {
      const observer = eventObservers.get(sessionId);
      if (observer?.generation === generation) {
        stopEventObserver(observer, true);
      }
    });
  };

  return {
    router,
    async provision(sessionId, spec) {
      const sockPath = socketPath(sessionId);
      let preparedObserver: EventObserver | undefined;
      try {
        const result = await router.sessions.spawnAndAttach(sessionId, {
          binPath: options.atchBinPath,
          args: ['start', sockPath, ...spec.command],
          sockPath,
          geometry: spec.geometry,
          subject: spec.subject,
          detached: true,
          prepareSpawn: ({ generation, args }) => {
            const path = prepareAtchEventSink(
              options.atchSocketRoot,
              sessionId,
              generation
            );
            try {
              preparedObserver = startEventObserver(sessionId, generation, path);
            } catch (error) {
              try {
                unlinkSync(path);
              } catch {
                // Preserve the observer startup error.
              }
              throw error;
            }
            return { args: [args[0]!, '-T', path, ...args.slice(1)] };
          },
          killSpec: {
            binPath: options.atchBinPath,
            args: ['kill', '-f', sockPath],
            staleCleanupSpec: { binPath: options.atchBinPath, args: ['rm', sockPath] }
          }
        });
        if (!result.ok && preparedObserver) stopEventObserver(preparedObserver, true);
        return result;
      } catch (error) {
        if (preparedObserver) stopEventObserver(preparedObserver, true);
        throw error;
      }
    },
    async retire(sessionId) {
      const observer = eventObservers.get(sessionId);
      const result = await router.sessions.retireAwaited(sessionId);
      if (result.ok && observer) stopEventObserver(observer, true);
      return result;
    },
    input(sessionId, bytes, paste = false) {
      return router.sessions.injectInput(sessionId, bytes, paste);
    },
    tail(sessionId, rows, offset = 0) {
      return router.sessions.historyText(sessionId, rows, offset);
    },
    terminalObservation(sessionId) {
      return router.sessions.terminalObservation(sessionId);
    },
    reconcileAtchEvents(sessionId, generation) {
      const path = atchEventPath(options.atchSocketRoot, sessionId, generation);
      if (!existsSync(path)) return false;
      try {
        startEventObserver(sessionId, generation, path);
        return true;
      } catch (error) {
        reportAtchDiagnostic({ sessionId, generation, path }, {
          code: 'tailer-io',
          message: `could not reconcile atch event sink: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
        return false;
      }
    },
    agentEndpoint(input) {
      const result = endpointStore.register(input);
      if (result.kind === 'accepted') {
        void reconcileAgentProviders([result.registration.sessionId]);
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
      const registration = endpointStore.get(
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
    dispose() {
      for (const observer of [...eventObservers.values()]) {
        stopEventObserver(observer, false);
      }
      disposeBridge();
      intakeStore?.close();
      intakeStore = undefined;
      eventJournal.close();
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

/** Clamp a client-supplied geometry so it can neither zero nor blow up the grid allocation (R4.3). */
function readProvisionGeometry(value: unknown): { rows: number; cols: number } {
  const geometry = (value ?? {}) as { rows?: unknown; cols?: unknown };
  const rows = Number(geometry.rows);
  const cols = Number(geometry.cols);
  return {
    rows: Number.isFinite(rows) && rows > 0 ? Math.min(Math.floor(rows), 1000) : 24,
    cols: Number.isFinite(cols) && cols > 0 ? Math.min(Math.floor(cols), 1000) : 80
  };
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
 * a session's atch master on demand (the spawn/boot/restart cutover path). It is
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
    | 'input'
    | 'tail'
    | 'terminalObservation'
    | 'agentEndpoint'
    | 'agentEvent'
    | 'agentStates'
    | 'events'
    | 'channelEvent'
    | 'readEvents'
    | 'clearEvents'
    | 'isReady'
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
          const ens = await daemon.provision(body.sessionId, {
            command: body.command,
            geometry: readProvisionGeometry(body.geometry),
            subject
          });
          if (ens.ok) {
            sendJson(res, 200, {
              ok: true,
              ...(memoryAttention === undefined ? {} : { memoryAttention })
            });
          } else {
            sendJson(res, 503, { ok: false, error: `atch provision refused: ${ens.reason}` });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/control/retire') {
          const body = await readJsonBody(req, { maxBytes: CONTROL_BODY_MAX_BYTES });
          if (!isSafeDaemonSessionId(body.sessionId)) {
            sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
            return;
          }
          const retired = await daemon.retire(body.sessionId);
          if (!retired.ok) {
            sendJson(res, 502, { ok: false, error: retired.error ?? 'retire failed' });
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
          if (observation === undefined) {
            sendJson(res, 404, { ok: false, error: `no such session: ${sessionId}` });
            return;
          }
          sendJson(res, 200, { ok: true, observation });
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
            sendJson(res, 200, { ok: true, kind: result.kind });
            return;
          }
          const status =
            result.reason === 'invalid-registration'
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
 * provision the atch master for each running session. Returns a handle with the
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
 * connects out to this via daemonClient / a WS proxy.
 */
export async function startTerminalDaemonServer(
  options: Omit<TerminalDaemonOptions, 'httpServer'> & { host?: string; port: number }
): Promise<TerminalDaemonServer> {
  const server = createServer();
  // The socket root must exist (0700, this user) BEFORE anything can bind
  // <root>/<sessionId>.sock — atch skips its own mkdir for slash-bearing names
  // and the master's bind() fails ENOENT on an absent parent.
  ensurePrivateSocketRoot(options.atchSocketRoot);
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
