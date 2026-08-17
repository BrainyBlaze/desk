import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DeskAgent } from '../core/types.js';
import {
  AGENT_SURFACE_RING_SIZE,
  parseAgentHostClientFrame,
  parseAgentUiClientFrame,
  type AgentHostClientFrame,
  type AgentHostServerFrame,
  type AgentSurfaceEvent,
  type AgentUiClientFrame,
  type AgentUiErrorCode,
  type AgentUiServerFrame
} from '../core/agentSurfaceProtocol.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  parseAgentStateEnvelope,
  type AgentProvider,
  type AgentProducer,
  type AgentStateEnvelope
} from '../shared/controlPlane/contract.js';
import {
  completeProviderSessionLaunch,
  daemonControl
} from '../shared/daemonControlClient.js';
import {
  nativeAgentFactsFor,
  type NativeAgentObservation
} from '../shared/runtime/nativeLifecycle.js';
import type { ProviderSessionProvider } from '../shared/providerSessionIdentity.js';
import { verifyAgentHostToken } from './agentHostToken.js';
import {
  bindProviderSessionIdentity,
  readProviderSessionBinding,
  type BindProviderSessionIdentityInput,
  type ProviderSessionBindingReadResult,
  type ProviderSessionBindingResult
} from './providerSessionBinding.js';

/**
 * Agent-surface broker — Phase 2 server core.
 *
 * Two WebSocket endpoints:
 *  - `/ws/agent-host` — adapter hosts connect here with a generation-fenced hello;
 *    the broker verifies the HMAC token against the persistent desk-host secret, replies
 *    hello-ack {lastSeq}, and forwards host events to subscribed browser surfaces (with
 *    visibility-gated delta forwarding).
 *  - `/ws/agent-ui` — browser surfaces subscribe/unsubscribe/inject here; the broker
 *    forwards commands to the host and routes command-result back via requestId.
 *
 * Per-session state: host connection, surface subscriptions, lastSeq, and a
 * bounded committed-event ring (default 2000 events / 16 MiB, FIFO) for snapshot
 * replies to late or reconnecting subscribers. Spec §6.
 * Agent semantics are adapted once and published to the daemon-owned authority; the
 * broker does not retain a second activity/wait state.
 */

const DEFAULT_RING_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const NATIVE_HEARTBEAT_WINDOW_MS = 5_000;

interface RetainedAgentSurfaceEvent {
  event: AgentSurfaceEvent;
  bytes: number;
}

interface SurfaceSubscription {
  surfaceId: string;
  visible: boolean;
}

interface BrowserClient {
  transport: WebSocket;
  subscriptions: Map<string, SurfaceSubscription>; // key = session|surfaceId
}

interface InflightCommand {
  ws?: WebSocket;
  surfaceId?: string;
  session: string;
  kind: 'inject' | 'respond-permission' | 'interrupt' | 'shutdown';
  /** Deadline after which the broker gives up and replies with a timeout error. */
  deadlineMs: number;
  resolve?: () => void;
  reject?: (error: Error & { code: AgentUiErrorCode; retryable: boolean }) => void;
}

interface HostConnection {
  ws: WebSocket;
  pid: number;
  agent: AgentProvider;
  session: string;
  producer: NativeProducerCursor;
  /** Non-null only after exact bind + launch authorization completion. */
  providerSessionId: string | null;
}

interface NativeProducerCursor {
  generation: number;
  provider: AgentProvider;
  producer: AgentProducer;
  producerInstanceId: string;
  producerSeq: number;
  publishTail: Promise<void>;
  lastHeartbeatAt?: number;
}

interface AgentSurfaceSession {
  session: string;
  host: HostConnection | null;
  /** Last known host pid. Used to detect new-pid (reset ring) vs same-pid (keep ring). */
  lastHostPid: number | null;
  /** Browser surfaces grouped by transport; each transport may host multiple surfaceIds. */
  clients: Map<WebSocket, Map<string, SurfaceSubscription>>;
  ring: RetainedAgentSurfaceEvent[];
  ringBytes: number;
  lastSeq: number;
  producer: NativeProducerCursor | null;
  /** Survives only an exact same-producer reconnect within this broker process. */
  authorizedProviderSession: {
    producer: NativeProducerCursor;
    providerSessionId: string;
  } | null;
  inflight: Map<string, InflightCommand>;
  /** Serialize host events so identity binding cannot be overtaken by later state. */
  eventTail: Promise<void>;
  idleSince?: number;
}

export interface CompleteProviderLaunchAuthorizationInput {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  providerSessionId: string;
  generation: number;
}

export interface AgentSurfaceBrokerOptions {
  ringSize?: number;
  ringMaxBytes?: number;
  commandTimeoutMs?: number;
  /** Inject the secret provider (test seam); production uses getOrCreateAgentHostSecret. */
  resolveSecret?: () => string;
  /** Inject the canonical authority publisher (test seam). */
  publishAgentState?: (envelope: AgentStateEnvelope) => void | Promise<void>;
  /** Inject the typed, manifest-locked provider identity binder (test seam). */
  bindProviderSession?: (
    input: BindProviderSessionIdentityInput
  ) => Promise<ProviderSessionBindingResult>;
  /** Read an existing durable binding before a surviving host replays events. */
  readProviderSessionBinding?: (input: {
    deskSessionId: string;
  }) => ProviderSessionBindingReadResult;
  /** Complete a matching one-shot launch authorization after durable binding. */
  completeLaunchAuthorization?: (
    input: CompleteProviderLaunchAuthorizationInput
  ) => void | Promise<void>;
  /** Retire only the native generation that emitted a rejected identity. */
  terminateNativeGeneration?: (
    sessionId: string,
    generation: number
  ) => void | Promise<void>;
  now?: () => number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class AgentSurfaceBroker {
  private readonly ringSize: number;
  private readonly ringMaxBytes: number;
  private readonly commandTimeoutMs: number;
  private readonly resolveSecret: () => string;
  private readonly publishAgentState: (envelope: AgentStateEnvelope) => void | Promise<void>;
  private readonly bindProviderSession: (
    input: BindProviderSessionIdentityInput
  ) => Promise<ProviderSessionBindingResult>;
  private readonly readProviderSession: (input: {
    deskSessionId: string;
  }) => ProviderSessionBindingReadResult;
  private readonly completeLaunchAuthorization: (
    input: CompleteProviderLaunchAuthorizationInput
  ) => void | Promise<void>;
  private readonly terminateNativeGeneration: (
    sessionId: string,
    generation: number
  ) => void | Promise<void>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AgentSurfaceSession>();
  private readonly browserClients = new Map<WebSocket, BrowserClient>();

  constructor(options: AgentSurfaceBrokerOptions = {}) {
    this.ringSize = options.ringSize ?? AGENT_SURFACE_RING_SIZE;
    this.ringMaxBytes = positiveInteger(options.ringMaxBytes ?? DEFAULT_RING_MAX_BYTES, 'agent surface ringMaxBytes');
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.resolveSecret = options.resolveSecret ?? defaultResolveSecret;
    this.publishAgentState = options.publishAgentState ?? defaultPublishAgentState;
    this.bindProviderSession = options.bindProviderSession ?? bindProviderSessionIdentity;
    this.readProviderSession =
      options.readProviderSessionBinding ?? readProviderSessionBinding;
    this.completeLaunchAuthorization =
      options.completeLaunchAuthorization ??
      defaultCompleteLaunchAuthorization;
    this.terminateNativeGeneration =
      options.terminateNativeGeneration ?? defaultTerminateNativeGeneration;
    this.now = options.now ?? Date.now;
  }

  // ── Public surface for tests / external callers ──

  /** Server-internal inject path used by channels-engine (spec §8) and the HTTP API. */
  async injectUserMessage(session: string, text: string, source: 'ui' | 'channel' | 'external'): Promise<void> {
    const sess = this.sessions.get(session);
    const host = sess?.host;
    if (!host || host.providerSessionId === null) {
      throw brokerError('adapter-unavailable', `no adapter host connected for ${session}`, false);
    }
    const requestId = newRequestId();
    const result = new Promise<void>((resolve, reject) => {
      this.registerInflight(sess, requestId, {
        session,
        kind: 'inject',
        deadlineMs: this.now() + this.commandTimeoutMs,
        resolve,
        reject
      });
    });
    this.sendHostCommand(host, { type: 'inject', requestId, text, source });
    await result;
  }

  /** Conversation-transport diagnostics only; semantic state lives in the authority. */
  snapshot(): Array<{ session: string; lastSeq: number; hostConnected: boolean }> {
    return [...this.sessions.values()].map((s) => ({
      session: s.session,
      lastSeq: s.lastSeq,
      hostConnected: s.host !== null
    }));
  }

  /**
   * Drop all broker state for a session (ring, state, inflight, guards). Called from
   * the delete-session route so a recreated session with the same identity
   * doesn't receive the OLD conversation's ring as its snapshot (BUG-7 root cause:
   * broker session entry survived DeskSession deletion because nothing told the broker
   * the session was gone).
   */
  disposeSession(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (!session) {
      return;
    }
    this.teardownSession(session);
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.teardownSession(session);
    }
    this.browserClients.clear();
  }

  // ── Host connection (//ws/agent-host) ──

  addHost(ws: WebSocket): void {
    ws.once('message', (raw) => this.handleHostHello(ws, raw));
    ws.on('close', () => this.handleHostGone(ws));
    ws.on('error', () => this.handleHostGone(ws));
  }

  private handleHostHello(ws: WebSocket, raw: unknown): void {
    let frame: AgentHostClientFrame;
    try {
      frame = parseAgentHostClientFrame(JSON.parse(String(raw)));
    } catch (err) {
      this.send(ws, { type: 'error', code: 'invalid-frame', message: describeError(err) });
      ws.close(1008, 'invalid hello');
      return;
    }
    if (frame.type !== 'hello') {
      this.send(ws, { type: 'error', code: 'invalid-frame', message: `first frame must be hello; got ${frame.type}` });
      ws.close(1008, 'protocol violation');
      return;
    }
    const secret = this.resolveSecret();
    if (!verifyAgentHostToken(secret, frame.session, frame.agent, frame.token)) {
      this.send(ws, { type: 'error', code: 'invalid-frame', message: 'host token verification failed' });
      ws.close(1008, 'auth failure');
      return;
    }
    const provider = nativeProviderFor(frame.agent);
    if (provider === undefined) {
      this.send(ws, {
        type: 'error',
        code: 'invalid-frame',
        message: `native host provider is not supported: ${frame.agent}`
      });
      ws.close(1008, 'unsupported provider');
      return;
    }
    const session = this.acquireSession(frame.session);
    // Spec §4 line 150: "broker resets a session's ring when a new host instance
    // (different pid/spawn) says hello". Same pid reconnecting after a transient socket
    // drop keeps the ring (lastSeq>0 path). Track lastHostPid across socket close so the
    // reset is keyed on pid change, not on current socket state.
    const changedSpawn =
      session.producer !== null &&
      (session.producer.generation !== frame.generation ||
        session.producer.provider !== provider ||
        session.producer.producerInstanceId !== frame.producerInstanceId ||
        session.lastHostPid !== frame.pid);
    if (changedSpawn) {
      session.ring = [];
      session.ringBytes = 0;
      session.lastSeq = 0;
      session.authorizedProviderSession = null;
      // Already-subscribed surfaces still hold the OLD spawn's rows. Without a
      // fresh snapshot they would keep them and APPEND the new spawn's backfill
      // as live events — live ids (user-N) can never dedupe against history ids
      // (store uuids), so every reload duplicated the whole transcript. Push a
      // replace-snapshot NOW (empty ring); the incoming backfill rebuilds the
      // transcript exactly once on top of it.
      for (const [clientWs, surfaces] of session.clients.entries()) {
        for (const sub of surfaces.values()) {
          this.sendSnapshot(clientWs, session, sub.surfaceId);
        }
      }
    }
    session.lastHostPid = frame.pid;
    const producerName = nativeProducerFor(provider);
    const priorProducer = session.producer;
    const producer =
      priorProducer !== null &&
      priorProducer.generation === frame.generation &&
      priorProducer.provider === provider &&
      priorProducer.producer === producerName &&
      priorProducer.producerInstanceId === frame.producerInstanceId
        ? priorProducer
        : {
            generation: frame.generation,
            provider,
            producer: producerName,
            producerInstanceId: frame.producerInstanceId,
            producerSeq: 0,
            publishTail: Promise.resolve()
          };
    session.producer = producer;
    let providerSessionId =
      session.authorizedProviderSession?.producer === producer
        ? session.authorizedProviderSession.providerSessionId
        : null;
    if (providerSessionId === null) {
      try {
        const binding = this.readProviderSession({
          deskSessionId: session.session
        });
        if (
          binding.ok &&
          binding.provider === provider &&
          binding.providerSessionId !== null
        ) {
          providerSessionId = binding.providerSessionId;
          session.authorizedProviderSession = {
            producer,
            providerSessionId
          };
        }
      } catch (error) {
        console.error(
          `[agent-surface] durable provider binding unavailable for ${session.session}: ${describeError(error)}`
        );
      }
    }
    const host: HostConnection = {
      ws,
      pid: frame.pid,
      agent: provider,
      session: session.session,
      producer,
      providerSessionId
    };
    session.host = host;
    session.idleSince = undefined;
    ws.removeAllListeners('message');
    ws.on('message', (raw2) => this.handleHostFrame(session, host, raw2));

    this.send(ws, { type: 'hello-ack', lastSeq: session.lastSeq });
    if (host.providerSessionId !== null) {
      this.publishNativeObservation(
        session,
        host,
        { kind: 'host-connected' },
        this.now()
      );
    }
  }

  private handleHostFrame(session: AgentSurfaceSession, host: HostConnection, raw: unknown): void {
    if (session.host !== host) {
      return;
    }
    let frame: AgentHostClientFrame;
    try {
      frame = parseAgentHostClientFrame(JSON.parse(String(raw)));
    } catch (err) {
      // Drop+audit per parse-or-throw contract; the host should not crash on this.
      console.error(
        `[agent-surface] dropping malformed host frame for ${session.session}: ${err instanceof Error ? err.message : String(err)}; raw=${String(raw).slice(0, 200)}`
      );
      return;
    }
    switch (frame.type) {
      case 'hello':
        // Duplicate hello — ignore (already verified).
        return;
      case 'event':
        session.eventTail = session.eventTail
          .then(() => this.handleHostEvent(session, host, frame.event))
          .catch((error) => {
            console.error(
              `[agent-surface] host event pipeline failed for ${session.session}: ${describeError(error)}`
            );
          });
        return;
      case 'command-result':
        this.handleCommandResult(session, frame.requestId, frame.ok, frame.ok ? undefined : frame.error);
        return;
    }
  }

  private async handleHostEvent(
    session: AgentSurfaceSession,
    host: HostConnection,
    event: AgentSurfaceEvent
  ): Promise<void> {
    if (session.host !== host) {
      return;
    }
    if (event.seq <= session.lastSeq) {
      return; // already accepted (idempotent — protects against host re-emits on reconnect)
    }
    if (event.kind === 'session-info' && !event.agentSessionId && host.providerSessionId !== null) {
      return;
    }
    if (event.kind === 'session-info' && event.agentSessionId) {
      if (
        host.providerSessionId !== null &&
        host.providerSessionId !== event.agentSessionId
      ) {
        await this.rejectProviderIdentity(
          session,
          host,
          `host provider session changed from ${host.providerSessionId} to ${event.agentSessionId}`
        );
        return;
      }
      try {
        const binding = await this.bindProviderSession({
          deskSessionId: session.session,
          provider: host.agent,
          providerSessionId: event.agentSessionId
        });
        if (!binding.ok) {
          await this.rejectProviderIdentity(session, host, binding.error);
          return;
        }
        if (session.host !== host) {
          return;
        }
        await this.completeLaunchAuthorization({
          deskSessionId: session.session,
          provider: host.agent,
          providerSessionId: event.agentSessionId,
          generation: host.producer.generation
        });
      } catch (error) {
        await this.rejectProviderIdentity(session, host, describeError(error));
        return;
      }
      if (session.host !== host) {
        return;
      }
      const becameAuthorized = host.providerSessionId === null;
      host.providerSessionId = event.agentSessionId;
      session.authorizedProviderSession = {
        producer: host.producer,
        providerSessionId: event.agentSessionId
      };
      if (becameAuthorized) {
        this.publishNativeObservation(
          session,
          host,
          { kind: 'host-connected' },
          this.now()
        );
      }
    }

    this.retainHostEvent(session, event);
    if (host.providerSessionId !== null) {
      this.publishNativeObservation(
        session,
        host,
        event,
        eventOccurredAt(event, this.now()),
        correlationFor(event)
      );
    }
    this.fanEventToSurfaces(session, event);
  }

  private retainHostEvent(session: AgentSurfaceSession, event: AgentSurfaceEvent): void {
    session.lastSeq = event.seq;
    if (isTransient(event)) {
      return;
    }
    const retained = { event, bytes: Buffer.byteLength(JSON.stringify(event)) };
    if (retained.bytes > this.ringMaxBytes) {
      return;
    }
    session.ring.push(retained);
    session.ringBytes += retained.bytes;
    while (session.ring.length > this.ringSize || session.ringBytes > this.ringMaxBytes) {
      const removed = session.ring.shift();
      if (removed) {
        session.ringBytes -= removed.bytes;
      }
    }
  }

  private async rejectProviderIdentity(
    session: AgentSurfaceSession,
    host: HostConnection,
    error: string
  ): Promise<void> {
    if (session.authorizedProviderSession?.producer === host.producer) {
      session.authorizedProviderSession = null;
    }
    host.providerSessionId = null;
    if (session.host === host) {
      session.host = null;
      session.idleSince = this.now();
    }
    this.send(host.ws, { type: 'error', code: 'invalid-frame', message: error });
    try {
      host.ws.close(1008, 'provider session identity rejected');
    } catch {
      // best-effort transport close; exact generation retirement is authoritative
    }
    try {
      await this.terminateNativeGeneration(session.session, host.producer.generation);
    } catch (terminationError) {
      console.error(
        `[agent-surface] exact generation retirement failed for ${session.session}@${host.producer.generation}: ${describeError(terminationError)}`
      );
    }
  }

  private handleHostGone(ws: WebSocket): void {
    for (const session of this.sessions.values()) {
      if (session.host?.ws === ws) {
        const host = session.host;
        session.host = null;
        session.idleSince = this.now();
        // Notify subscribed surfaces so they can render a disconnected state.
        // Ring + state are NOT cleared here — they survive for same-pid reconnect
        // (transient drop, lastSeq>0 path) and are reset only on new-pid hello.
        // BUG-9 duplicate-rows is fixed at the codex history-mapper level (id mismatch
        // between live optimistic rows and backfill rows), not here.
        this.broadcast(session, { type: 'exit', session: session.session, reason: 'crashed' });
        if (host.providerSessionId !== null) {
          this.publishNativeObservation(
            session,
            host,
            { kind: 'host-disconnected' },
            this.now()
          );
        }
      }
    }
  }

  // ── Browser-surface connection (/ws/agent-ui) ──

  addBrowserClient(ws: WebSocket): void {
    const client: BrowserClient = { transport: ws, subscriptions: new Map() };
    this.browserClients.set(ws, client);
    this.send(ws, { type: 'ready', version: 1 });
    ws.on('message', (raw) => {
      let frame: AgentUiClientFrame;
      try {
        frame = parseAgentUiClientFrame(JSON.parse(String(raw)));
      } catch (err) {
        this.send(ws, { type: 'error', code: 'invalid-frame', message: describeError(err) } satisfies AgentUiServerFrame);
        return;
      }
      try {
        this.handleBrowserFrame(client, frame);
      } catch (err) {
        const code = (err as { code?: AgentUiErrorCode }).code ?? 'invalid-frame';
        const message = describeError(err);
        this.send(ws, { type: 'error', session: sessionOfFrame(frame), code, message } satisfies AgentUiServerFrame);
      }
    });
    ws.on('close', () => this.removeBrowserClient(ws));
    ws.on('error', () => this.removeBrowserClient(ws));
  }

  private removeBrowserClient(ws: WebSocket): void {
    const client = this.browserClients.get(ws);
    if (!client) {
      return;
    }
    for (const key of [...client.subscriptions.keys()]) {
      const [session, surfaceId] = splitSubscriptionKey(key);
      this.unsubscribeResolved(client, session, surfaceId);
    }
    this.browserClients.delete(ws);
  }

  private handleBrowserFrame(client: BrowserClient, frame: AgentUiClientFrame): void {
    switch (frame.type) {
      case 'subscribe':
        this.browserSubscribe(client, frame.session, frame.surfaceId, frame.visible);
        return;
      case 'visibility':
        this.browserSetVisibility(client, frame.session, frame.surfaceId, frame.visible);
        return;
      case 'unsubscribe':
        this.unsubscribeResolved(client, frame.session, frame.surfaceId);
        return;
      case 'send':
        this.browserSend(client, frame.session, frame.surfaceId, frame.text);
        return;
      case 'respond-permission':
        this.browserRespondPermission(client, frame.session, frame.surfaceId, frame.requestId, frame.optionId, frame.note);
        return;
      case 'interrupt':
        this.browserInterrupt(client, frame.session, frame.surfaceId);
        return;
    }
  }

  private browserSubscribe(client: BrowserClient, sessionName: string, surfaceId: string, visible: boolean): void {
    const session = this.acquireSession(sessionName);
    let surfacesForClient = session.clients.get(client.transport);
    if (!surfacesForClient) {
      surfacesForClient = new Map();
      session.clients.set(client.transport, surfacesForClient);
    }
    surfacesForClient.set(surfaceId, { surfaceId, visible });
    client.subscriptions.set(subscriptionKey(sessionName, surfaceId), { surfaceId, visible, session: sessionName } as SurfaceSubscription & { session: string });
    session.idleSince = undefined;
    if (visible) {
      this.sendSnapshot(client.transport, session, surfaceId);
    }
  }

  private browserSetVisibility(client: BrowserClient, sessionName: string, surfaceId: string, visible: boolean): void {
    const session = this.sessions.get(sessionName);
    const sub = client.subscriptions.get(subscriptionKey(sessionName, surfaceId));
    const surfaceEntry = session?.clients.get(client.transport)?.get(surfaceId);
    if (!session || !sub || !surfaceEntry) {
      throw brokerError('not-native-session', `not subscribed to ${sessionName}`, false);
    }
    sub.visible = visible;
    surfaceEntry.visible = visible;
    if (visible) {
      this.sendSnapshot(client.transport, session, surfaceId);
    }
  }

  private browserSend(client: BrowserClient, sessionName: string, surfaceId: string, text: string): void {
    const session = this.requireSession(sessionName);
    this.requireVisibleSubscription(client, sessionName, surfaceId);
    if (!session.host || session.host.providerSessionId === null) {
      throw brokerError('adapter-unavailable', `no adapter host connected for ${sessionName}`, true);
    }
    const requestId = newRequestId();
    this.sendHostCommand(session.host, { type: 'inject', requestId, text, source: 'ui' });
    this.registerInflight(session, requestId, { ws: client.transport, surfaceId, session: sessionName, kind: 'inject', deadlineMs: this.now() + this.commandTimeoutMs });
  }

  private browserRespondPermission(
    client: BrowserClient,
    sessionName: string,
    surfaceId: string,
    requestId: string,
    optionId: string,
    note?: string
  ): void {
    const session = this.requireSession(sessionName);
    this.requireVisibleSubscription(client, sessionName, surfaceId);
    if (!session.host || session.host.providerSessionId === null) {
      throw brokerError('adapter-unavailable', `no adapter host connected for ${sessionName}`, true);
    }
    const cmdRequestId = newRequestId();
    this.sendHostCommand(session.host, {
      type: 'respond-permission',
      requestId: cmdRequestId,
      permissionRequestId: requestId,
      optionId,
      note
    });
    this.registerInflight(session, cmdRequestId, { ws: client.transport, surfaceId, session: sessionName, kind: 'respond-permission', deadlineMs: this.now() + this.commandTimeoutMs });
  }

  private browserInterrupt(client: BrowserClient, sessionName: string, surfaceId: string): void {
    const session = this.requireSession(sessionName);
    this.requireVisibleSubscription(client, sessionName, surfaceId);
    if (!session.host || session.host.providerSessionId === null) {
      throw brokerError('adapter-unavailable', `no adapter host connected for ${sessionName}`, true);
    }
    const requestId = newRequestId();
    this.sendHostCommand(session.host, { type: 'interrupt', requestId });
    this.registerInflight(session, requestId, { ws: client.transport, surfaceId, session: sessionName, kind: 'interrupt', deadlineMs: this.now() + this.commandTimeoutMs });
  }

  // ── Internal helpers ──

  private requireSubscription(client: BrowserClient, sessionName: string, surfaceId: string): SurfaceSubscription {
    const subscription = client.subscriptions.get(subscriptionKey(sessionName, surfaceId));
    if (!subscription) {
      throw brokerError('not-native-session', `not subscribed to ${sessionName}`, false);
    }
    return subscription;
  }

  private requireVisibleSubscription(client: BrowserClient, sessionName: string, surfaceId: string): SurfaceSubscription {
    const subscription = this.requireSubscription(client, sessionName, surfaceId);
    if (!subscription.visible) {
      throw brokerError('not-native-session', `surface ${surfaceId} is not visible for ${sessionName}`, false);
    }
    return subscription;
  }

  private acquireSession(name: string): AgentSurfaceSession {
    let session = this.sessions.get(name);
    if (!session) {
      session = {
        session: name,
        host: null,
        lastHostPid: null,
        clients: new Map(),
        ring: [],
        ringBytes: 0,
        lastSeq: 0,
        producer: null,
        authorizedProviderSession: null,
        inflight: new Map(),
        eventTail: Promise.resolve()
      };
      this.sessions.set(name, session);
    }
    return session;
  }

  private requireSession(name: string): AgentSurfaceSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw brokerError('not-native-session', `unknown session ${name}`, false);
    }
    return session;
  }

  private teardownSession(session: AgentSurfaceSession): void {
    if (session.host) {
      try {
        session.host.ws.close(1000, 'broker shutdown');
      } catch {
        // best-effort
      }
    }
    for (const ws of session.clients.keys()) {
      try {
        ws.close(1000, 'broker shutdown');
      } catch {
        // best-effort
      }
    }
    this.sessions.delete(session.session);
  }

  private unsubscribeResolved(client: BrowserClient, sessionName: string, surfaceId: string): void {
    const session = this.sessions.get(sessionName);
    client.subscriptions.delete(subscriptionKey(sessionName, surfaceId));
    if (!session) {
      return;
    }
    const surfacesForClient = session.clients.get(client.transport);
    surfacesForClient?.delete(surfaceId);
    if (surfacesForClient && surfacesForClient.size === 0) {
      session.clients.delete(client.transport);
    }
    if (session.clients.size === 0 && !session.host) {
      session.idleSince = this.now();
    }
  }

  private sendSnapshot(ws: WebSocket, session: AgentSurfaceSession, surfaceId: string): void {
    const events = session.ring.map((retained) => retained.event); // committed-only; transients are excluded on insert
    this.send(ws, {
      type: 'snapshot',
      session: session.session,
      surfaceId,
      lastSeq: session.lastSeq,
      events
    });
  }

  private fanEventToSurfaces(session: AgentSurfaceSession, event: AgentSurfaceEvent): void {
    const transient = isTransient(event);
    // Send at most ONE event frame per WebSocket per event (codex Phase 4 G2 fix).
    // The browser-side client fans each frame to every subscribed surface for the session;
    // sending one frame per surface would multiply deliveries (N surfaces × M ws surfaces
    // per session = N*M arrivals per surface). Per-ws dedup collapses it to one arrival
    // per surface.
    for (const [ws, surfaces] of session.clients.entries()) {
      let shouldSend = false;
      for (const sub of surfaces.values()) {
        if (!transient || sub.visible) {
          shouldSend = true;
          break;
        }
      }
      if (shouldSend) {
        this.send(ws, { type: 'event', session: session.session, event });
      }
    }
  }

  private broadcast(session: AgentSurfaceSession, frame: AgentUiServerFrame): void {
    for (const ws of session.clients.keys()) {
      this.send(ws, frame);
    }
  }

  private sendHostCommand(host: HostConnection, command: AgentHostServerFrame): void {
    this.send(host.ws, command);
  }

  private registerInflight(session: AgentSurfaceSession, requestId: string, cmd: InflightCommand): void {
    session.inflight.set(requestId, cmd);
    setTimeout(() => {
      const pending = session.inflight.get(requestId);
      if (pending && pending === cmd) {
        session.inflight.delete(requestId);
        const error = brokerError('adapter-unavailable', `${cmd.kind} command timed out after ${this.commandTimeoutMs}ms`, false);
        cmd.reject?.(error);
        if (cmd.ws) {
          this.send(cmd.ws, {
            type: 'error',
            session: session.session,
            code: error.code,
            message: error.message
          });
        }
      }
    }, this.commandTimeoutMs).unref?.();
  }

  private handleCommandResult(
    session: AgentSurfaceSession,
    requestId: string,
    ok: boolean,
    error: { code: AgentUiErrorCode; message: string; retryable: boolean } | undefined
  ): void {
    const cmd = session.inflight.get(requestId);
    if (!cmd) {
      return;
    }
    session.inflight.delete(requestId);
    if (ok) {
      // Surface affordances for command-result ok are broker-internal (no frame); the
      // turn progress arrives as events. The browser only sees errors.
      cmd.resolve?.();
      return;
    }
    if (!error) {
      cmd.reject?.(brokerError('adapter-unavailable', 'command failed without error detail', false));
      return;
    }
    const commandError = brokerError(error.code, error.message, error.retryable);
    cmd.reject?.(commandError);
    if (cmd.ws) {
      this.send(cmd.ws, {
        type: 'error',
        session: cmd.session,
        code: commandError.code,
        message: commandError.message
      });
    }
  }

  private publishNativeObservation(
    session: AgentSurfaceSession,
    host: HostConnection,
    observation: NativeAgentObservation,
    occurredAt: number,
    correlation?: AgentStateEnvelope['correlation']
  ): void {
    const observedAt = this.now();
    const facts = nativeAgentFactsFor(observation);
    if (
      facts.length === 1 &&
      facts[0]?.kind === 'heartbeat' &&
      host.producer.lastHeartbeatAt !== undefined &&
      observedAt - host.producer.lastHeartbeatAt < NATIVE_HEARTBEAT_WINDOW_MS
    ) {
      return;
    }
    if (facts.length === 1 && facts[0]?.kind === 'heartbeat') {
      host.producer.lastHeartbeatAt = observedAt;
    }
    host.producer.producerSeq += 1;
    const eventId = `${host.producer.producerInstanceId}:${host.producer.producerSeq}`;
    let envelope: AgentStateEnvelope;
    try {
      envelope = parseAgentStateEnvelope({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: session.session,
        generation: host.producer.generation,
        provider: host.producer.provider,
        mode: 'native',
        producer: host.producer.producer,
        producerInstanceId: host.producer.producerInstanceId,
        producerSeq: host.producer.producerSeq,
        eventId,
        invocationId: eventId,
        occurredAt,
        observedAt,
        facts,
        ...(correlation === undefined ? {} : { correlation })
      });
    } catch (error) {
      console.error(
        `[agent-surface] invalid canonical observation for ${session.session}: ${describeError(error)}`
      );
      return;
    }
    host.producer.publishTail = host.producer.publishTail
      .then(() => this.publishAgentState(envelope))
      .then(() => undefined)
      .catch((error) => {
        console.error(
          `[agent-surface] canonical observation rejected for ${session.session}: ${describeError(error)}`
        );
      });
  }

  private send(ws: WebSocket, frame: AgentUiServerFrame | AgentHostServerFrame | { type: 'error'; code: AgentUiErrorCode; message: string }): void {
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort; transport will fire close on next tick
    }
  }
}

// ── Install helpers ──

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  removeListener(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface AgentSurfaceBrokerInstallOptions {
  maxPayloadBytes?: number;
}

export function installAgentSurfaceBroker(
  httpServer: UpgradeServer,
  broker: AgentSurfaceBroker,
  options: AgentSurfaceBrokerInstallOptions = {}
): () => void {
  const maxPayload = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 'agent surface maxPayloadBytes');
  const hostWss = new WebSocketServer({ noServer: true, maxPayload });
  const uiWss = new WebSocketServer({ noServer: true, maxPayload });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (socket.destroyed) {
      return;
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname === '/ws/agent-host') {
      hostWss.handleUpgrade(request, socket, head, (ws) => {
        hostWss.emit('connection', ws, request);
      });
    } else if (url.pathname === '/ws/agent-ui') {
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        uiWss.emit('connection', ws, request);
      });
    }
  };
  httpServer.on('upgrade', onUpgrade);

  hostWss.on('connection', (ws) => broker.addHost(ws));
  uiWss.on('connection', (ws) => broker.addBrowserClient(ws));

  return () => {
    httpServer.removeListener('upgrade', onUpgrade);
    hostWss.close();
    uiWss.close();
  };
}

// ── Free helpers ──

function isTransient(event: AgentSurfaceEvent): boolean {
  return event.kind === 'assistant-delta' || event.kind === 'tool-output-delta';
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function brokerError(code: AgentUiErrorCode, message: string, retryable: boolean): Error & { code: AgentUiErrorCode; retryable: boolean } {
  const err = new Error(message) as Error & { code: AgentUiErrorCode; retryable: boolean };
  err.code = code;
  err.retryable = retryable;
  return err;
}

function subscriptionKey(session: string, surfaceId: string): string {
  return `${session}|${surfaceId}`;
}

function splitSubscriptionKey(key: string): [string, string] {
  const idx = key.indexOf('|');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function newRequestId(): string {
  return `req-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function sessionOfFrame(frame: AgentUiClientFrame): string | undefined {
  return frame.session;
}

function nativeProviderFor(agent: DeskAgent): AgentProvider | undefined {
  return agent === 'claude' || agent === 'codex' || agent === 'opencode'
    ? agent
    : undefined;
}

function nativeProducerFor(provider: AgentProvider): AgentProducer {
  switch (provider) {
    case 'claude':
      return 'claude-native';
    case 'codex':
      return 'codex-native';
    case 'opencode':
      return 'opencode-native';
  }
}

function eventOccurredAt(event: AgentSurfaceEvent, fallback: number): number {
  const parsed = Date.parse(event.ts);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function correlationFor(
  event: AgentSurfaceEvent
): AgentStateEnvelope['correlation'] | undefined {
  switch (event.kind) {
    case 'assistant-delta':
    case 'assistant-message':
    case 'turn-complete':
      return { turnId: boundedIdentifier(event.turnId) };
    case 'tool-start':
    case 'tool-output-delta':
    case 'tool-end':
      return { toolUseId: boundedIdentifier(event.toolUseId) };
    case 'permission-request':
    case 'permission-resolved':
      return { permissionId: boundedIdentifier(event.requestId) };
    default:
      return undefined;
  }
}

function boundedIdentifier(value: string): string {
  return value.trim().slice(0, 512);
}

async function defaultPublishAgentState(envelope: AgentStateEnvelope): Promise<void> {
  const result = await daemonControl('/control/agent-event', envelope, {
    timeoutMs: 1_500
  });
  if (!result.ok) {
    throw new Error(result.error ?? 'terminal daemon rejected native agent observation');
  }
}

async function defaultCompleteLaunchAuthorization(
  input: CompleteProviderLaunchAuthorizationInput
): Promise<void> {
  const result = await completeProviderSessionLaunch(input, {
    timeoutMs: 1_500
  });
  if (
    !result.ok ||
    (result.body?.kind !== 'completed' &&
      result.body?.kind !== 'not-required')
  ) {
    throw new Error(
      result.error ??
        'terminal daemon returned an invalid provider launch completion receipt'
    );
  }
}

async function defaultTerminateNativeGeneration(
  sessionId: string,
  generation: number
): Promise<void> {
  const result = await daemonControl(
    '/control/retire-generation',
    { sessionId, generation },
    { timeoutMs: 6_000 }
  );
  if (!result.ok) {
    throw new Error(
      result.error ?? `terminal daemon rejected exact generation retirement for ${sessionId}@${generation}`
    );
  }
}

let defaultSecret: string | null = null;
function defaultResolveSecret(): string {
  if (defaultSecret === null) {
    // Lazy import to avoid a top-level circular dep at module-load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOrCreateAgentHostSecret } = require('./agentHostToken.js') as { getOrCreateAgentHostSecret: () => string };
    defaultSecret = getOrCreateAgentHostSecret();
  }
  return defaultSecret;
}
