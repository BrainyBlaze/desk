import { parseSlashCommand } from './slashCommand.js';
import type {
  Event,
  Message,
  Part,
  Session,
  SessionStatus,
  TextPartInput
} from '@opencode-ai/sdk';
import {
  driverCommandError,
  isDriverCommandError,
  type AgentDriver,
  type DriverEvent,
  type DriverStatusEvent
} from '../host/driver.js';
import {
  assembleMarkdown,
  expandRetryStatus,
  mapHistoryMessage,
  mapLiveEvent,
  mapSessionStatus,
  type AssistantMessageText,
  type LiveEventContext
} from './opencodeMapper.js';
import {
  ensureOpencodeConfigDir,
  opencodePermissionConfigContent
} from '../../../core/opencodeConfig.js';

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
  promptAsync(sessionId: string, parts: TextPartInput[], model?: string): Promise<void>;
  /** Respond to a permission request. */
  respondPermission(sessionId: string, permissionId: string, response: PermissionResponse): Promise<void>;
  /** List messages (info + parts) for committed-history backfill. */
  listMessages(sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>>;
  /** Run an opencode session command (native slash-command support). */
  runCommand(sessionId: string, command: string, args: string, model?: string): Promise<void>;
  /** List available session commands (UX item 9: composer palette). */
  listCommands(): Promise<Array<{ name: string; description?: string }>>;
  /**
   * Subscribe to the global /event stream for this server. Returns unsubscribe.
   * `onEnd` fires when the stream terminates (server crash, network drop, clean close)
   * so the driver can emit a non-fatal agent-error instead of sitting idle forever
   * (Phase 4 debt item: driver stream-end hardening, applies to all 3 drivers).
   */
  subscribeEvents(
    handler: (event: Event) => void,
    onEnd?: (error?: Error) => void
  ): Promise<() => void>;
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
  /** Model override (providerID/modelID format, e.g. "zai-coding-plan/glm-5.2").
   * When set, every prompt_async carries this model so the agent doesn't fall back
   * to the provider default (which the user's plan may not include — BUG-15). */
  model?: string;
  /** Inject the backend (test seam); omit to use the live SDK-backed factory. */
  backend?: OpencodeBackend;
  /** Title for freshly-created sessions. */
  sessionTitle?: string;
  /**
   * Turn-liveness watchdog window in ms (default 90s). opencode broadcasts NOTHING
   * over SSE while it retries provider stream errors internally (verified live
   * against an AI_APICallError loop) — the truth only exists on the session-status
   * polling endpoint. A turn with no events within this window triggers a status
   * probe: retry states surface the real provider message, busy re-arms silently,
   * idle emits a dropped-message error. 0 disables (probes/tests).
   */
  turnWatchdogMs?: number;
}

/** Map an AgentDriver optionId to opencode's permission response vocabulary. */
export function mapPermissionOptionId(optionId: string): PermissionResponse {
  if (optionId === 'allow' || optionId === 'once') return 'once';
  if (optionId === 'allow-always' || optionId === 'allow-session' || optionId === 'always') return 'always';
  return 'reject';
}

export class OpencodeDriver implements AgentDriver {
  private readonly opts: OpencodeDriverOptions;
  private readonly handlers = new Set<(event: DriverEvent) => void>();
  private backend: OpencodeBackend | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private sessionId: string | null = null;
  /** Pending assistant messageID — used to attribute turn-complete on session.idle. */
  private pendingTurnId: string | null = null;
  /** Live text accumulator — populated by message.part.updated; consumed on commit. */
  private readonly assistantTextByMessageId = new Map<string, AssistantMessageText>();
  /** Set of assistant messageIDs we've already committed, dedupes repeated message.updated. */
  private readonly assistantCommitted = new Set<string>();
  /** User messageIDs we emitted locally via inject(); swallow their opencode echo. */
  private readonly injectedUserMessageIds = new Set<string>();
  private started = false;
  private shutDown = false;
  /** Turn-liveness watchdog — armed per inject, slid by activity, disarmed on turn-complete. */
  /** True after a probe-failure report until a status probe succeeds again. */
  private probeFailureReported = false;
  private turnWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Last retry attempt number reported to the surface — dedupes repeated probe hits. */
  private lastReportedRetryAttempt: number | null = null;

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
      } catch (err) {
        // A misbehaving handler must not break sibling handlers — but the
        // failure has to leave a trail, or the transcript just stops silently.
        console.error(`opencode driver: event handler threw on ${event.kind}: ${err instanceof Error ? err.message : String(err)}`);
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
    this.backend = this.opts.backend ?? (await createLiveBackend({ cwd: this.opts.cwd, bypass: this.opts.bypass }));

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
    // calls still surfaces as a processing event. The onEnd callback emits a non-fatal
    // agent-error when the SSE stream terminates outside shutdown so the cell surfaces
    // the failure instead of sitting idle forever (Phase 4 stream-end hardening).
    this.unsubscribeEvents = await this.backend.subscribeEvents(
      (event) => this.handleEvent(event),
      (error) => this.handleStreamEnd(error)
    );

    const statusMap = await this.backend.status();
    const opencodeStatus = statusMap[sessionId] ?? { type: 'idle' as const };
    const baseStatus = mapSessionStatus(opencodeStatus);
    const events = expandRetryStatus(baseStatus);
    for (const event of events) {
      this.emit(event);
    }

    // UX item 9: surface the agent's command list for the composer palette.
    // Best-effort — discovery failure logs and the palette simply doesn't render.
    void this.backend
      .listCommands()
      .then((commands) => {
        if (this.shutDown || !Array.isArray(commands) || commands.length === 0) return;
        this.emit({
          kind: 'session-info',
          agentSessionId: sessionId,
          commands: commands
            .filter((c) => c && typeof c.name === 'string' && c.name !== '')
            .map((c) => ({ name: c.name, ...(typeof c.description === 'string' ? { description: c.description } : {}) }))
        });
      })
      .catch((err: unknown) => {
        console.error('opencode driver: command discovery failed:', err instanceof Error ? err.message : String(err));
      });

    return {
      session: { agentSessionId: sessionId },
      status: events[events.length - 1] as DriverStatusEvent
    };
  }

  async inject(text: string, source: 'ui' | 'channel' | 'external'): Promise<void> {
    if (!this.sessionId || !this.backend) {
      throw notStartedError();
    }
    const slash = parseSlashCommand(text);
    if (slash) {
      // opencode exposes session commands over POST /session/:id/command; an
      // unknown command errors there and surfaces as a typed unsupported-command
      // instead of being sent to the model as literal text.
      try {
        await this.backend.runCommand(this.sessionId, slash.name, slash.args, this.opts.model);
      } catch (err) {
        throw driverCommandError(
          `/${slash.name} failed in native mode: ${err instanceof Error ? err.message : String(err)} — switch to terminal UI if this is an interactive command`,
          'unsupported-command',
          false
        );
      }
      const localCommandId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.injectedUserMessageIds.add(localCommandId);
      this.emit({ kind: 'user-message', id: localCommandId, text, source });
      this.disarmTurnWatchdog();
      this.armTurnWatchdog();
      return;
    }
    const parts: TextPartInput[] = [{ type: 'text', text }];
    await this.backend.promptAsync(this.sessionId, parts, this.opts.model);
    // Optimistic local user-message emission. Generate an id we'll recognize when opencode
    // echoes the message back via message.updated so we can swallow the echo (R2 fix:
    // keyed on the locally-generated id rather than a queue position).
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.injectedUserMessageIds.add(localId);
    this.emit({ kind: 'user-message', id: localId, text, source });
    // Fresh inject = fresh turn expectation: reset the retry-report dedupe too.
    this.disarmTurnWatchdog();
    this.armTurnWatchdog();
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
    this.disarmTurnWatchdog();
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
    this.disarmTurnWatchdog();
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

  private handleStreamEnd(error?: Error): void {
    if (this.shutDown) {
      return;
    }
    if (error) {
      this.emit({
        kind: 'agent-error',
        message: `opencode event stream error: ${error.message}`,
        fatal: false
      });
      return;
    }
    this.emit({
      kind: 'agent-error',
      message: 'opencode event stream ended unexpectedly; restart the session to reconnect',
      fatal: false
    });
  }

  private handleEvent(event: Event): void {
    if (this.shutDown) {
      return;
    }
    // R1 / R2 / R3 fix: live mapper needs sessionId filter + accumulator + committed set
    // + pendingTurnId attribution. The mapper mutates the accumulator + committed set
    // in-place when it processes message.part.updated / message.updated.
    const ctx: LiveEventContext = {
      sessionId: this.sessionId ?? '',
      pendingTurnId: this.pendingTurnId ?? undefined,
      assistantTextByMessageId: this.assistantTextByMessageId,
      assistantCommitted: this.assistantCommitted
    };

    // Track the in-flight assistant message id for turn-complete attribution (R4: cleared
    // after session.idle emits turn-complete).
    if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
      this.pendingTurnId = event.properties.info.id;
    }

    // R2 fix: opencode echoes our local injects as message.updated (no parts). The mapper
    // returns null for user message.updated; we additionally forget the local id once we
    // see the echo so the set doesn't grow unbounded. We can't correlate opencode's id to
    // our local id (opencode assigns a new one), so we forget on a FIFO basis: the next
    // user message.updated after an inject is treated as its echo.
    if (event.type === 'message.updated' && event.properties.info.role === 'user') {
      // Best-effort FIFO forget — at most one in-flight inject is expected (host runner
      // serializes commands via send-while-busy), so popping the oldest is correct.
      const firstLocal = this.injectedUserMessageIds.values().next().value;
      if (firstLocal) {
        this.injectedUserMessageIds.delete(firstLocal);
      }
      // Mapper returns null here (R2); nothing else to do.
      return;
    }

    const mapped = mapLiveEvent(event, ctx);
    if (mapped === null) {
      return;
    }
    // Mapped session activity proves the turn is alive RIGHT NOW — slide the
    // watchdog window instead of disarming so a mid-turn silent stall is still
    // caught. turn-complete disarms below.
    this.feedTurnWatchdog();
    if (Array.isArray(mapped)) {
      // R5 fix: route session.status through expandRetryStatus so live retry states emit
      // the [status, attention-hint] pair, not just the bare status.
      const expanded: DriverEvent[] = [];
      for (const e of mapped) {
        if (e.kind === 'status') {
          expanded.push(...expandRetryStatus(e));
        } else {
          expanded.push(e);
        }
      }
      // R4 fix: if this batch contained turn-complete, clear pendingTurnId so a repeated
      // session.idle doesn't duplicate it.
      if (expanded.some((e) => e.kind === 'turn-complete')) {
        this.pendingTurnId = null;
        this.disarmTurnWatchdog();
      }
      for (const e of expanded) {
        this.emit(e);
      }
    } else {
      // Single event — also route through expandRetryStatus for the retry case.
      if (mapped.kind === 'turn-complete') {
        this.disarmTurnWatchdog();
      }
      if (mapped.kind === 'status') {
        for (const e of expandRetryStatus(mapped)) {
          this.emit(e);
        }
      } else {
        this.emit(mapped);
      }
    }
  }

  /**
   * History backfill default source attribution. Per claude review (msg-20260705-153930)
   * history has no origin tag — default to 'external'.
   */
  private deriveHistorySource(_info: Message): 'ui' | 'channel' | 'external' {
    return 'external';
  }

  // ── Turn-liveness watchdog ──
  // opencode retries provider stream errors internally and broadcasts NOTHING over
  // /event while doing so (verified live against an AI_APICallError loop: zero SSE
  // events, message.error stays null for 7+ hours). The TRUTH lives only in the
  // session-status POLLING endpoint, which reports {type:'retry', attempt, message,
  // next}. So: a turn that produces no events within the window triggers a status
  // probe, and retry states flow through the existing expandRetryStatus pipeline —
  // the user sees the real provider message instead of eternal silence. A busy
  // status re-arms silently, so slow-but-healthy providers never false-positive.

  private armTurnWatchdog(): void {
    const windowMs = this.opts.turnWatchdogMs ?? 90_000;
    if (windowMs <= 0) {
      return;
    }
    this.clearTurnWatchdogTimer();
    const timer = setTimeout(() => {
      void this.fireTurnWatchdog(windowMs);
    }, windowMs);
    timer.unref?.();
    this.turnWatchdog = timer;
  }

  /** Slide the window on live session activity; only ticks when already armed. */
  private feedTurnWatchdog(): void {
    if (this.turnWatchdog) {
      this.armTurnWatchdog();
    }
  }

  private clearTurnWatchdogTimer(): void {
    if (this.turnWatchdog) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = null;
    }
  }

  /** Full disarm — turn is over (turn-complete/interrupt/shutdown); reset dedupe state. */
  private disarmTurnWatchdog(): void {
    this.clearTurnWatchdogTimer();
    this.lastReportedRetryAttempt = null;
  }

  private async fireTurnWatchdog(windowMs: number): Promise<void> {
    this.turnWatchdog = null;
    if (this.shutDown || !this.backend || !this.sessionId) {
      return;
    }
    const seconds = Math.round(windowMs / 1000);
    let status: SessionStatus | undefined;
    try {
      status = (await this.backend.status())[this.sessionId];
    } catch (err) {
      // A failed probe must not kill liveness detection for the turn: re-arm
      // and try again next window, reporting only the first consecutive
      // failure so a persistent outage does not spam one error per window.
      if (!this.probeFailureReported) {
        this.probeFailureReported = true;
        this.emit({
          kind: 'agent-error',
          message: `opencode produced no output for ${seconds}s and the status probe failed: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false
        });
      }
      this.armTurnWatchdog();
      return;
    }
    this.probeFailureReported = false;
    if (status?.type === 'retry') {
      // Report each retry state once per attempt — backoff grows, so this stays quiet
      // between attempts instead of repeating the same row every window.
      if (this.lastReportedRetryAttempt !== status.attempt) {
        this.lastReportedRetryAttempt = status.attempt;
        for (const event of expandRetryStatus(mapSessionStatus(status))) {
          this.emit(event);
        }
      }
      this.armTurnWatchdog();
      return;
    }
    if (status?.type === 'busy') {
      // Turn is alive, provider is just slow — keep watching silently.
      this.armTurnWatchdog();
      return;
    }
    this.emit({
      kind: 'agent-error',
      message:
        `opencode produced no output for ${seconds}s and reports an idle session — ` +
        `your message may have been dropped; send it again or restart the session`,
      fatal: false
    });
  }
}

function sessionGoneError(resumeId: string): Error {
  return driverCommandError(`opencode session ${resumeId} not found (deleted?)`, 'driver-start-failed', false);
}

function notStartedError(): Error {
  return driverCommandError('opencode driver method called before start() resolved', 'adapter-unavailable', false);
}

/**
 * Live backend factory — spawns an isolated `opencode serve --port 0` child, returns the
 * SDK client + close(). Implemented in a separate factory so the heavy SDK import stays
 * out of the hermetic test boundary.
 *
 * CRITICAL: sets OPENCODE_CONFIG_DIR + OPENCODE_CONFIG_CONTENT before spawning so the
 * opencode serve child uses desk-managed config (provider definitions, permission ruleset,
 * desk-attention plugin). Without these, the child runs with DEFAULT config → no provider
 * → empty responses → "opencode doesn't work" (root cause of the human's BUG-10/BUG-opencode
 * report). Terminal-mode launch sets these in buildAgentCommand; native-mode must do the same.
 */
export async function createLiveBackend(opts: { cwd: string; bypass: boolean }): Promise<OpencodeBackend> {
  // Set the desk-managed opencode config before spawning — mirrors terminal-mode
  // buildAgentCommand's env injection (manifest.ts buildOpencodeCommand).
  const configDir = ensureOpencodeConfigDir();
  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.OPENCODE_CONFIG_CONTENT = opencodePermissionConfigContent(opts.bypass);
  process.env.OPENCODE_DISABLE_MOUSE = '1';

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
    async promptAsync(sessionId: string, parts: TextPartInput[], model?: string): Promise<void> {
      const body: Record<string, unknown> = { parts };
      if (model) {
        const [providerID, modelID] = model.split('/');
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
      }
      await client.session.promptAsync({ path: { id: sessionId }, body: body as never });
    },
    async respondPermission(sessionId: string, permissionId: string, response: PermissionResponse): Promise<void> {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response }
      });
    },
    async listCommands(): Promise<Array<{ name: string; description?: string }>> {
      const result = await client.command.list();
      return (result.data ?? []).map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) }));
    },
    async runCommand(sessionId: string, command: string, args: string, model?: string): Promise<void> {
      const result = await client.session.command({
        path: { id: sessionId },
        body: { command, arguments: args, ...(model ? { model } : {}) }
      });
      const failure = (result as { error?: unknown }).error;
      if (failure !== undefined) {
        throw new Error(typeof failure === 'string' ? failure : JSON.stringify(failure).slice(0, 200));
      }
    },
    async listMessages(sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>> {
      const result = await client.session.messages({ path: { id: sessionId } });
      const data = result.data ?? [];
      return data.map((entry) => ({ info: entry.info, parts: entry.parts }));
    },
    async subscribeEvents(
      handler: (event: Event) => void,
      onEnd?: (error?: Error) => void
    ): Promise<() => void> {
      // Bounded retry on stream termination (BUG-3 fix, claude Phase 4 visual-validation):
      // opencode's SSE has known transient drops; demanding a manual restart for a
      // short-lived network blip is poor UX. Retry with capped exponential backoff before
      // declaring death via onEnd. AbortError (self-initiated unsubscribe) is NOT retried.
      const MAX_RETRIES = 5;
      const INITIAL_BACKOFF_MS = 500;
      const MAX_BACKOFF_MS = 10_000;

      let aborted = false;
      let activeController: AbortController | null = null;

      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      const attempt = async (retryCount: number): Promise<void> => {
        if (aborted) return;
        const controller = new AbortController();
        activeController = controller;
        try {
          await client.global.event({
            signal: controller.signal,
          onSseEvent: (sseEvent: { data?: unknown }) => {
            if (!sseEvent.data) return;
            try {
              handler(JSON.parse(sseEvent.data as string) as Event);
            } catch (err) {
              console.error('opencode driver: dropping malformed SSE event', typeof sseEvent.data === 'string' ? sseEvent.data.slice(0, 200) : '<non-string>', err);
            }
            }
          });
          // Stream closed cleanly (rare for opencode serve — it's long-lived).
          if (aborted) return;
          if (retryCount >= MAX_RETRIES) {
            onEnd?.();
            return;
          }
          await sleep(Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** retryCount));
          // Reset retry count on successful re-subscribe after receiving events — a fresh
          // connection that delivered events is a healthy connection; the next drop starts
          // the retry count from 0 again.
          return attempt(0);
        } catch (err) {
          if (aborted || controller.signal.aborted) return;
          if (retryCount >= MAX_RETRIES) {
            onEnd?.(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          await sleep(Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** retryCount));
          return attempt(retryCount + 1);
        }
      };

      void attempt(0);

      return () => {
        aborted = true;
        activeController?.abort();
      };
    },
    async close(): Promise<void> {
      server.close();
    }
  };
}
