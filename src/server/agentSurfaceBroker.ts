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
  type AgentSurfaceState,
  type AgentUiClientFrame,
  type AgentUiErrorCode,
  type AgentUiServerFrame
} from '../core/agentSurfaceProtocol.js';
import { verifyAgentHostToken } from './agentHostToken.js';
import {
  attentionTracker,
  notifyAgentSignal,
  type AgentEventKind
} from './attention.js';
import { isValidResumeIdForAgent, persistSessionResume } from './resumeCapture.js';

/**
 * Agent-surface broker — Phase 2 server core.
 *
 * Mirrors the terminalBroker shape with two WebSocket endpoints:
 *  - `/ws/agent-host` — adapter hosts connect here with hello {session, token, agent, pid};
 *    the broker verifies the HMAC token against the persistent desk-host secret, replies
 *    hello-ack {lastSeq}, and forwards host events to subscribed browser surfaces (with
 *    visibility-gated delta forwarding).
 *  - `/ws/agent-ui` — browser surfaces subscribe/unsubscribe/inject here; the broker
 *    forwards commands to the host and routes command-result back via requestId.
 *
 * Per-session state: host connection, surface subscriptions, FSM state, lastSeq, and a
 * bounded committed-event ring (default 2000 events / 16 MiB, FIFO) for snapshot
 * replies to late or reconnecting subscribers. Spec §6.
 *
 * Attention synthesis (R3 amendment): one mapping from normalized events → existing
 * AttentionTracker/agentEvents so lamps/sounds/pulse/channel-engine behavior is identical
 * in native and terminal modes with zero driver-specific code.
 */

const DEFAULT_RING_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

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
  agent: DeskAgent;
  session: string;
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
  currentState: AgentSurfaceState | null;
  lastSeq: number;
  inflight: Map<string, InflightCommand>;
  /** Once true, skip the persistSessionResume manifest write on subsequent session-info. */
  persistedResumeGuard: boolean;
  idleSince?: number;
}

export interface AgentSurfaceBrokerOptions {
  ringSize?: number;
  ringMaxBytes?: number;
  commandTimeoutMs?: number;
  /** Inject the secret provider (test seam); production uses getOrCreateAgentHostSecret. */
  resolveSecret?: () => string;
  /** Inject the attention tracker (test seam); production uses the singleton. */
  attention?: AttentionSink;
  /**
   * Inject the resume-persistence path (test seam). Production leaves this undefined
   * and the broker calls persistSessionResume(tmuxSession, resume) which writes the
   * default manifest at ~/.config/desk/desk.yml. Tests pass a custom function that
   * writes to a temp manifest so the broker's session-info handling can be exercised
   * hermetically.
   */
  persistResume?: (tmuxSession: string, resume: string) => boolean | Promise<boolean>;
  now?: () => number;
}

export interface AttentionSink {
  pushEvent(session: string, kind: AgentEventKind, message?: string): unknown;
  notifySignal(session: string, kind: AgentEventKind): void;
  raise(session: string): unknown;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class AgentSurfaceBroker {
  private readonly ringSize: number;
  private readonly ringMaxBytes: number;
  private readonly commandTimeoutMs: number;
  private readonly resolveSecret: () => string;
  private readonly attention: AttentionSink;
  private readonly persistResume: (tmuxSession: string, resume: string) => boolean | Promise<boolean>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AgentSurfaceSession>();
  private readonly browserClients = new Map<WebSocket, BrowserClient>();

  constructor(options: AgentSurfaceBrokerOptions = {}) {
    this.ringSize = options.ringSize ?? AGENT_SURFACE_RING_SIZE;
    this.ringMaxBytes = positiveInteger(options.ringMaxBytes ?? DEFAULT_RING_MAX_BYTES, 'agent surface ringMaxBytes');
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.resolveSecret = options.resolveSecret ?? defaultResolveSecret;
    this.attention = options.attention ?? defaultAttentionSink;
    this.persistResume = options.persistResume ?? ((tmuxSession, resume) => persistSessionResume(tmuxSession, resume));
    this.now = options.now ?? Date.now;
  }

  // ── Public surface for tests / external callers ──

  /** Server-internal inject path used by channels-engine (spec §8) and the HTTP API. */
  async injectUserMessage(session: string, text: string, source: 'ui' | 'channel' | 'external'): Promise<void> {
    const sess = this.sessions.get(session);
    const host = sess?.host;
    if (!host) {
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

  /** Snapshot for the pulse API: sessions with their FSM state + lastSeq (read-only). */
  snapshot(): Array<{ session: string; state: AgentSurfaceState | null; lastSeq: number; hostConnected: boolean }> {
    return [...this.sessions.values()].map((s) => ({
      session: s.session,
      state: s.currentState,
      lastSeq: s.lastSeq,
      hostConnected: s.host !== null
    }));
  }

  nativeDeliveryState(session: string): 'ready' | 'busy' | 'booting' | 'offline' | 'approval' {
    const current = this.sessions.get(session);
    if (!current?.host) return 'offline';
    switch (current.currentState) {
      case 'idle': return 'ready';
      case 'processing':
      case 'tool-executing': return 'busy';
      case 'awaiting-permission': return 'approval';
      case 'starting': return 'booting';
      default: return 'offline';
    }
  }

  /**
   * Drop all broker state for a session (ring, state, inflight, guards). Called from
   * the delete-session route so a recreated session with the same derived tmux name
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
    const session = this.acquireSession(frame.session);
    // Spec §4 line 150: "broker resets a session's ring when a new host instance
    // (different pid/spawn) says hello". Same pid reconnecting after a transient socket
    // drop keeps the ring (lastSeq>0 path). Track lastHostPid across socket close so the
    // reset is keyed on pid change, not on current socket state.
    if (session.lastHostPid !== null && session.lastHostPid !== frame.pid) {
      session.ring = [];
      session.ringBytes = 0;
      session.currentState = null;
      session.lastSeq = 0;
      // A new pid is a fresh spawn — the agent may mint a NEW session id (e.g.
      // confirmDiscard switch where the user explicitly accepted losing the prior
      // conversation). Reset persistedResumeGuard so the next session-info event with
      // the new id re-runs persistSessionResume; otherwise the manifest would keep the
      // OLD id and the next restart would silently resume the pre-discard conversation.
      session.persistedResumeGuard = false;
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
    const host: HostConnection = { ws, pid: frame.pid, agent: frame.agent, session: session.session };
    session.host = host;
    session.idleSince = undefined;
    ws.removeAllListeners('message');
    ws.on('message', (raw2) => this.handleHostFrame(session, raw2));

    this.send(ws, { type: 'hello-ack', lastSeq: session.lastSeq });
  }

  private handleHostFrame(session: AgentSurfaceSession, raw: unknown): void {
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
        this.handleHostEvent(session, frame.event);
        return;
      case 'command-result':
        this.handleCommandResult(session, frame.requestId, frame.ok, frame.ok ? undefined : frame.error);
        return;
    }
  }

  private handleHostEvent(session: AgentSurfaceSession, event: AgentSurfaceEvent): void {
    if (event.seq <= session.lastSeq) {
      return; // already accepted (idempotent — protects against host re-emits on reconnect)
    }
    session.lastSeq = event.seq;
    if (!isTransient(event)) {
      const retained = { event, bytes: Buffer.byteLength(JSON.stringify(event)) };
      if (retained.bytes <= this.ringMaxBytes) {
        session.ring.push(retained);
        session.ringBytes += retained.bytes;
        while (session.ring.length > this.ringSize || session.ringBytes > this.ringMaxBytes) {
          const removed = session.ring.shift();
          if (removed) {
            session.ringBytes -= removed.bytes;
          }
        }
      }
    }
    if (event.kind === 'status') {
      session.currentState = event.state;
    }
    // spec §6: session-info with agentSessionId is the load-bearing path for FRESH native
    // sessions to gain a resume id (the driver can't know the id at start() time — claude
    // streaming-init deadlock fix). Persist via the existing resumeCapture plumbing, which
    // also pins the tmux session name. persistSessionResume is idempotent; we additionally
    // gate on session.persistedResumeGuard so repeated session-info events on the same host
    // don't re-read the manifest after the first successful write.
    if (event.kind === 'session-info' && event.agentSessionId && session.host && !session.persistedResumeGuard) {
      const agent = session.host.agent;
      if (isValidResumeIdForAgent(agent, event.agentSessionId)) {
        const hostPid = session.host.pid;
        session.persistedResumeGuard = true;
        void Promise.resolve(this.persistResume(session.session, event.agentSessionId))
          .then((persisted) => {
            if (session.lastHostPid === hostPid) {
              session.persistedResumeGuard = persisted;
            }
          })
          .catch(() => {
            if (session.lastHostPid === hostPid) {
              session.persistedResumeGuard = false;
            }
          });
      }
    }
    this.synthesizeAttention(session.session, event);
    this.fanEventToSurfaces(session, event);
  }

  private handleHostGone(ws: WebSocket): void {
    for (const session of this.sessions.values()) {
      if (session.host?.ws === ws) {
        session.host = null;
        session.idleSince = this.now();
        // Notify subscribed surfaces so they can render a disconnected state.
        // Ring + state are NOT cleared here — they survive for same-pid reconnect
        // (transient drop, lastSeq>0 path) and are reset only on new-pid hello.
        // BUG-9 duplicate-rows is fixed at the codex history-mapper level (id mismatch
        // between live optimistic rows and backfill rows), not here.
        this.broadcast(session, { type: 'exit', session: session.session, reason: 'crashed' });
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
    const sub = client.subscriptions.get(subscriptionKey(sessionName, surfaceId));
    if (!sub) {
      throw brokerError('not-native-session', `not subscribed to ${sessionName}`, false);
    }
    if (!session.host) {
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
    this.requireSubscription(client, sessionName, surfaceId);
    if (!session.host) {
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
    this.requireSubscription(client, sessionName, surfaceId);
    if (!session.host) {
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
        currentState: null,
        lastSeq: 0,
        inflight: new Map(),
        persistedResumeGuard: false
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
      state: session.currentState ?? 'starting',
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
    // per surface, matching terminalBroker's output fanout shape.
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

  private synthesizeAttention(session: string, event: AgentSurfaceEvent): void {
    switch (event.kind) {
      case 'status':
        if (event.state === 'awaiting-permission') {
          this.attention.raise(session);
          this.attention.pushEvent(session, 'approval-requested', event.detail);
          this.attention.notifySignal(session, 'approval-requested');
        }
        return;
      case 'turn-complete':
        this.attention.raise(session);
        this.attention.pushEvent(session, 'turn-complete');
        this.attention.notifySignal(session, 'turn-complete');
        return;
      case 'agent-error':
        if (event.fatal) {
          this.attention.raise(session);
          this.attention.pushEvent(session, 'input-requested', event.message);
          this.attention.notifySignal(session, 'input-requested');
        }
        return;
      case 'attention-hint': {
        const mapped: AgentEventKind = event.attention === 'idle-prompt' ? 'input-requested' : event.attention === 'session-status' ? 'turn-complete' : 'input-requested';
        if (mapped === 'input-requested') {
          this.attention.raise(session);
          this.attention.pushEvent(session, mapped, event.detail);
          this.attention.notifySignal(session, mapped);
          return;
        }
        this.attention.pushEvent(session, mapped, event.detail);
        return;
      }
      default:
        return;
    }
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

const defaultAttentionSink: AttentionSink = {
  pushEvent: (session, kind, message) => attentionTracker.pushEvent(session, kind, message),
  notifySignal: (session, kind) => notifyAgentSignal(session, kind),
  raise: (session) => attentionTracker.raise(session)
};

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
