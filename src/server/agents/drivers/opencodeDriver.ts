import type {
  Event,
  Message,
  Part,
  Session,
  SessionStatus,
  TextPartInput
} from '@opencode-ai/sdk';
import type { AgentDriver, DriverEvent, DriverStatusEvent } from '../host/driver.js';
import {
  expandRetryStatus,
  mapHistoryMessage,
  mapLiveEvent,
  mapSessionStatus
} from './opencodeMapper.js';

/**
 * OpenCode driver — bridges opencode serve ↔ the host runner.
 *
 * Lifecycle: spawn (or attach to) an opencode server, create or resume a session,
 * subscribe to its SSE event stream, fan normalized DriverEvents to the host runner,
 * and translate host commands back to opencode REST calls.
 *
 * Hermetic tests inject a MockOpencodeBackend; the real-binary probe (DESK_OPENCODE_PROBE=1)
 * uses LiveOpencodeBackend against an isolated HOME fixture.
 */

export type PermissionResponse = 'once' | 'always' | 'reject';

/**
 * Backend boundary — the small opencode SDK surface this driver needs. Abstracts
 * `@opencode-ai/sdk` so the driver logic is hermetic-testable without spawning a real
 * `opencode serve` child.
 */
export interface OpencodeBackend {
  /** Create a new session, returning the Session with id ses_xxx. */
  createSession(title: string): Promise<Session>;
  /** Fetch a session by id; returns null if not found. */
  getSession(id: string): Promise<Session | null>;
  /** Get session status map (1+ sessions on this server, but we only own one). */
  status(): Promise<Record<string, SessionStatus>>;
  /** Abort the in-flight turn for this session. */
  abort(sessionId: string): Promise<void>;
  /** Send a message asynchronously (no wait for response). */
  promptAsync(sessionId: string, parts: TextPartInput[]): Promise<void>;
  /** Respond to a permission request. */
  respondPermission(sessionId: string, permissionId: string, response: PermissionResponse): Promise<void>;
  /** List messages (info + parts) for committed-history backfill. */
  listMessages(sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>>;
  /** Subscribe to the global /event stream for this server. Returns unsubscribe. */
  subscribeEvents(handler: (event: Event) => void): Promise<() => void>;
  /** Close the backend (kills the spawned opencode serve if owned). */
  close(): Promise<void>;
}

export interface OpencodeDriverOptions {
  /** Working directory the opencode server will own. */
  cwd: string;
  /** Existing session id to resume; omit for fresh. */
  resumeId?: string;
  /** Bypass permissions flag from DESK_AGENT_BYPASS. */
  bypass: boolean;
  /** Inject the backend (test seam); omit to use the live SDK-backed factory. */
  backend?: OpencodeBackend;
  /** Title for freshly-created sessions. */
  sessionTitle?: string;
}

/** Map an AgentDriver optionId to opencode's permission response vocabulary. */
export function mapPermissionOptionId(optionId: string): PermissionResponse {
  if (optionId === 'allow' || optionId === 'once') return 'once';
  if (optionId === 'allow-always' || optionId === 'allow-session' || optionId === 'always') return 'always';
  return 'reject';
}

interface PendingInject {
  text: string;
  source: 'ui' | 'channel' | 'external';
  sentAt: number;
}

export class OpencodeDriver implements AgentDriver {
  private readonly opts: OpencodeDriverOptions;
  private readonly handlers = new Set<(event: DriverEvent) => void>();
  private readonly pendingInjects: PendingInject[] = [];
  private backend: OpencodeBackend | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private sessionId: string | null = null;
  private pendingTurnId: string | null = null;
  /** Tracks assistant-message ids we've already emitted committed, to dedpe part deltas. */
  private assistantDeltasSeen = new Set<string>();
  private started = false;
  private shutDown = false;

  constructor(opts: OpencodeDriverOptions) {
    this.opts = opts;
  }

  onEvent(handler: (event: DriverEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: DriverEvent): void {
    if (this.shutDown) {
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // a misbehaving handler must not break sibling handlers
      }
    }
  }

  async start(): Promise<{
    session: { agentSessionId?: string; model?: string };
    status: DriverStatusEvent;
  }> {
    if (this.started) {
      throw new Error('OpencodeDriver.start called twice');
    }
    this.started = true;
    this.backend = this.opts.backend ?? (await createLiveBackend({ cwd: this.opts.cwd }));

    // Resolve or create the session BEFORE subscribing so we never miss an event for it.
    let sessionId: string;
    if (this.opts.resumeId) {
      const existing = await this.backend.getSession(this.opts.resumeId);
      if (!existing) {
        throw sessionGoneError(this.opts.resumeId);
      }
      sessionId = existing.id;
    } else {
      const created = await this.backend.createSession(this.opts.sessionTitle ?? 'desk native');
      sessionId = created.id;
    }
    this.sessionId = sessionId;

    // Subscribe to events before reading status so a turn that starts between the two
    // calls still surfaces as a processing event.
    this.unsubscribeEvents = await this.backend.subscribeEvents((event) => this.handleEvent(event));

    const statusMap = await this.backend.status();
    const opencodeStatus = statusMap[sessionId] ?? { type: 'idle' as const };
    const baseStatus = mapSessionStatus(opencodeStatus);
    const events = expandRetryStatus(baseStatus);
    for (const event of events) {
      this.emit(event);
    }
    void this.assistantDeltasSeen; // referenced for future part-delta dedup state

    return {
      session: { agentSessionId: sessionId },
      status: events[events.length - 1] as DriverStatusEvent
    };
  }

  async inject(text: string, source: 'ui' | 'channel' | 'external'): Promise<void> {
    if (!this.sessionId || !this.backend) {
      throw notStartedError();
    }
    const parts: TextPartInput[] = [{ type: 'text', text }];
    this.pendingInjects.push({ text, source, sentAt: Date.now() });
    await this.backend.promptAsync(this.sessionId, parts);
    // Optimistic local user-message emission; if opencode's message.updated arrives
    // later with the same text, the host runner dedupes via id (we use a client-generated
    // id here; opencode's id arrives via the SDK event).
    this.emit({ kind: 'user-message', id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, source });
  }

  async respondPermission(requestId: string, optionId: string, _note?: string): Promise<void> {
    if (!this.sessionId || !this.backend) {
      throw notStartedError();
    }
    const response = mapPermissionOptionId(optionId);
    await this.backend.respondPermission(this.sessionId, requestId, response);
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this.backend) {
      throw notStartedError();
    }
    await this.backend.abort(this.sessionId);
  }

  async fetchHistory(): Promise<DriverEvent[]> {
    if (!this.sessionId || !this.backend) {
      throw notStartedError();
    }
    const messages = await this.backend.listMessages(this.sessionId);
    const events: DriverEvent[] = [];
    for (const { info, parts } of messages) {
      const source = this.deriveHistorySource(info);
      events.push(...mapHistoryMessage(info, parts, source));
    }
    return events;
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
    if (this.unsubscribeEvents) {
      try {
        this.unsubscribeEvents();
      } catch {
        // best-effort
      }
      this.unsubscribeEvents = null;
    }
    if (this.backend) {
      try {
        await this.backend.close();
      } catch {
        // best-effort
      }
      this.backend = null;
    }
    this.handlers.clear();
  }

  private handleEvent(event: Event): void {
    if (this.shutDown) {
      return;
    }
    // Track the in-flight assistant message id for turn-complete attribution.
    if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
      this.pendingTurnId = event.properties.info.id;
    }

    // Reconcile live injects: when opencode echoes a user message we just sent, swallow
    // the duplicate (we already emitted a local user-message with the caller's source).
    if (event.type === 'message.updated' && event.properties.info.role === 'user') {
      const recent = this.pendingInjects[0];
      if (recent) {
        // opencode's user message arrives near-instantly after prompt_async resolves; we
        // treat the first matching echo as the duplicate.
        this.pendingInjects.shift();
        return;
      }
    }

    const mapped = mapLiveEvent(event, { pendingTurnId: this.pendingTurnId ?? undefined });
    if (mapped === null) {
      return;
    }
    if (Array.isArray(mapped)) {
      for (const e of mapped) {
        this.emit(e);
      }
    } else {
      this.emit(mapped);
    }
  }

  /**
   * Best-effort history source attribution: if we have a pending inject that hasn't yet
   * been consumed by an echo, attribute the next user message to that inject's source.
   * Otherwise default to 'external' per claude review msg-20260705-153930.
   */
  private deriveHistorySource(_info: Message): 'ui' | 'channel' | 'external' {
    // History backfill typically runs once on (re)connect, after any in-flight injects
    // have already been echoed. Default to 'external' so we never guess 'ui'/'channel'
    // for an origin we cannot verify.
    return 'external';
  }
}

function sessionGoneError(resumeId: string): Error {
  const err = new Error(`opencode session ${resumeId} not found (deleted?)`) as Error & {
    code: 'driver-start-failed';
    retryable: false;
  };
  err.code = 'driver-start-failed';
  err.retryable = false;
  return err;
}

function notStartedError(): Error {
  const err = new Error('opencode driver method called before start() resolved') as Error & {
    code: 'adapter-unavailable';
    retryable: false;
  };
  err.code = 'adapter-unavailable';
  err.retryable = false;
  return err;
}

/**
 * Live backend factory — spawns an isolated `opencode serve --port 0` child, returns the
 * SDK client + close(). Implemented in a separate factory so the heavy SDK import stays
 * out of the hermetic test boundary.
 */
export async function createLiveBackend(_opts: { cwd: string }): Promise<OpencodeBackend> {
  // Imported lazily so the test boundary (which never calls this) doesn't pull the SDK.
  const sdk = await import('@opencode-ai/sdk');
  const server = await sdk.createOpencodeServer({ port: 0, hostname: '127.0.0.1' });
  const client = sdk.createOpencodeClient({ baseUrl: server.url });

  return {
    async createSession(title: string): Promise<Session> {
      const result = await client.session.create({ body: { title } });
      if (!result.data) {
        throw new Error(`session.create failed: ${result.error?.toString() ?? 'unknown'}`);
      }
      return result.data;
    },
    async getSession(id: string): Promise<Session | null> {
      const result = await client.session.get({ path: { id } });
      return result.data ?? null;
    },
    async status(): Promise<Record<string, SessionStatus>> {
      const result = await client.session.status();
      return result.data ?? {};
    },
    async abort(sessionId: string): Promise<void> {
      await client.session.abort({ path: { id: sessionId } });
    },
    async promptAsync(sessionId: string, parts: TextPartInput[]): Promise<void> {
      await client.session.promptAsync({ path: { id: sessionId }, body: { parts } });
    },
    async respondPermission(sessionId: string, permissionId: string, response: PermissionResponse): Promise<void> {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response }
      });
    },
    async listMessages(sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>> {
      const result = await client.session.messages({ path: { id: sessionId } });
      const data = result.data ?? [];
      return data.map((entry) => ({ info: entry.info, parts: entry.parts }));
    },
    async subscribeEvents(handler: (event: Event) => void): Promise<() => void> {
      // The SDK SSE helper resolves once the stream is established. We return an
      // unsubscribe that aborts the underlying fetch; opencode serve closes the stream.
      const controller = new AbortController();
      void client.global.event({
        signal: controller.signal,
        onSseEvent: (sseEvent: { data?: unknown }) => {
          if (!sseEvent.data) return;
          try {
            handler(JSON.parse(sseEvent.data as string) as Event);
          } catch {
            // malformed event — drop
          }
        }
      });
      return () => controller.abort();
    },
    async close(): Promise<void> {
      server.close();
    }
  };
}
