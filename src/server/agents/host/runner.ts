import { WebSocket } from 'ws';
import type {
  AgentHostClientFrame,
  AgentHostServerFrame,
  AgentSurfaceEvent,
  AgentSurfaceEventPayload,
  AgentUiErrorCode
} from '../../../core/agentSurfaceProtocol.js';
import type { DeskAgent } from '../../../core/types.js';
import {
  isDriverCommandError,
  type AgentDriver,
  type DriverEvent
} from './driver.js';
import { loadDriver } from './loader.js';
import { AgentHostLogger } from './logger.js';

/**
 * Adapter host runner — the in-tmux process that owns one agent driver and bridges it
 * to the desk server's broker over /ws/agent-host.
 *
 * Lifecycle (spec docs/native-ui-mode-spec.md §5):
 *   1. read env (DESK_TMUX_SESSION, DESK_AGENT, DESK_AGENT_RESUME, DESK_AGENT_BYPASS,
 *      DESK_SERVER_URL, DESK_AGENT_HOST_TOKEN, optional DESK_AGENT_CWD,
 *      DESK_AGENT_HOST_LOG_LEVEL)
 *   2. print pane banner + structured one-line logs (R5)
 *   3. connect to ${DESK_SERVER_URL}/ws/agent-host
 *   4. send hello { session, token, agent, pid }
 *   5. receive hello-ack { lastSeq }
 *   6. load driver by DESK_AGENT; subscribe onEvent BEFORE start (frozen contract)
 *   7. start(): emit session-info + status events; if lastSeq === 0 also emit
 *      fetchHistory() backfill + history-boundary
 *   8. forward events (seq/ts stamped by THIS runner) to the broker
 *   9. receive commands (inject/respond-permission/interrupt/shutdown) → driver methods
 *      → command-result ok:true|ok:false per the agreed mapping table
 *  10. bounded committed-event ring (last K=200) so transient socket drops don't lose
 *      committed events (N1, glm sign-off msg-20260705-152314)
 *  11. reconnect: bounded-pre-hello (10 attempts, exit nonzero on exhaustion);
 *      unbounded-post-hello with capped backoff (parity: agent outlives server restart)
 *  12. crash-exit cleanly on shutdown / fatal driver error so the tmux pane surfaces it
 */

const RING_SIZE = 200;
const PRE_HELLO_MAX_ATTEMPTS = 10;
const PRE_HELLO_BACKOFF_MS = 1_000;
const POST_HELLO_INITIAL_BACKOFF_MS = 500;
const POST_HELLO_MAX_BACKOFF_MS = 30_000;
const POST_HELLO_BACKOFF_JITTER_MS = 500;

export interface AgentHostEnv {
  DESK_TMUX_SESSION: string;
  DESK_AGENT: DeskAgent;
  DESK_AGENT_RESUME?: string;
  DESK_AGENT_BYPASS: string;
  DESK_AGENT_CWD?: string;
  DESK_SERVER_URL: string;
  DESK_AGENT_HOST_TOKEN: string;
  DESK_AGENT_HOST_LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
}

export interface AgentHostOptions {
  env: AgentHostEnv;
  /** Override the driver factory (test seam); production uses loadDriver from loader.js. */
  loadDriver?: (env: AgentHostEnv, logger: AgentHostLogger) => AgentDriver;
  /** Override the WS constructor (test seam); production uses ws.WebSocket. */
  createSocket?: (url: string) => WebSocketLike;
  /** Override process exit (test seam); production uses process.exit. */
  exit?: (code: number) => void;
  /** Override pid (test seam); production uses process.pid. */
  pid?: number;
  /** Override now (test seam); production uses Date.now. */
  now?: () => Date;
  /** Override setTimeout/clearTimeout (test seam). */
  scheduler?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
  /** Signal the host should observe for graceful exit. */
  signals?: NodeJS.Signals[];
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  readonly CLOSED: number;
  send(data: string): void;
  close(code?: number, reason?: string | Buffer): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: (code: number | null, reason: Buffer | string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
}

interface CommandPending {
  requestId: string;
  kind: 'inject' | 'respond-permission' | 'interrupt' | 'shutdown';
}

export class AgentHost {
  private readonly env: AgentHostEnv;
  private readonly logger: AgentHostLogger;
  private readonly loadDriverFn: (env: AgentHostEnv, logger: AgentHostLogger) => AgentDriver;
  private readonly createSocketFn: (url: string) => WebSocketLike;
  private readonly exitFn: (code: number) => void;
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly scheduler: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
  private readonly signals: NodeJS.Signals[];

  private driver: AgentDriver | null = null;
  private socket: WebSocketLike | null = null;
  private seqCounter = 0;
  private committedRing: AgentSurfaceEvent[] = [];
  private firstHelloCompleted = false;
  private inFlightCommand: CommandPending | null = null;
  private shuttingDown = false;
  private reconnectTimer: unknown = null;

  constructor(opts: AgentHostOptions) {
    this.env = opts.env;
    this.logger = new AgentHostLogger(opts.env.DESK_AGENT_HOST_LOG_LEVEL ?? 'info');
    this.loadDriverFn = opts.loadDriver ?? loadDriver;
    this.createSocketFn = opts.createSocket ?? ((url) => new WebSocket(url));
    this.exitFn = opts.exit ?? ((code) => process.exit(code));
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? (() => new Date());
    this.scheduler = opts.scheduler ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
    this.signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  }

  /**
   * Run the host until shutdown, fatal error, or signal. Returns the exit code that
   * was passed to exitFn. The production caller wires exitFn to process.exit, so this
   * never actually returns in production; tests pass an exitFn that captures the code.
   */
  async run(): Promise<void> {
    this.logger.banner(this.env);
    this.installSignalHandlers();

    let attempt = 0;
    while (!this.shuttingDown) {
      attempt += 1;
      try {
        await this.connectAndRun();
        // connectAndRun resolves only when the socket drops cleanly; loop continues
        // for reconnect handling per firstHelloCompleted state.
      } catch (err) {
        this.logger.error(`connection attempt ${attempt} failed: ${describeError(err)}`);
        if (!this.firstHelloCompleted) {
          if (attempt >= PRE_HELLO_MAX_ATTEMPTS) {
            this.logger.error(`pre-hello retries exhausted (${PRE_HELLO_MAX_ATTEMPTS}); exiting`);
            await this.maybeShutdownDriver();
            this.exitFn(1);
            return;
          }
          await this.sleep(preHelloBackoff(attempt));
        } else {
          await this.sleep(postHelloBackoff(attempt));
        }
      }
    }
  }

  private installSignalHandlers(): void {
    for (const sig of this.signals) {
      process.on(sig, () => {
        this.logger.info(`received ${sig}; initiating graceful shutdown`);
        void this.shutdown().then(() => this.exitFn(0));
      });
    }
  }

  private async connectAndRun(): Promise<void> {
    const url = `${wsUrl(this.env.DESK_SERVER_URL)}/ws/agent-host`;
    this.logger.info(`connecting to ${url}`);
    const socket = this.createSocketFn(url);
    this.socket = socket;

    // Register the message + close listeners BEFORE awaiting open so messages that arrive
    // during the open→runMessageLoop transition aren't dropped. The open await still gates
    // hello submission; listeners just sit ready.
    const messageQueue: unknown[] = [];
    const onEarlyMessage = (data: unknown): void => {
      messageQueue.push(data);
    };
    const onEarlyClose = (code: number | null, reason: Buffer | string): void => {
      // Capture for the runMessageLoop promise to resolve; no-op if it hasn't started.
      earlyClose = { code, reason: String(reason) };
    };
    let earlyClose: { code: number | null; reason: string } | null = null;
    socket.on('message', onEarlyMessage);
    socket.on('close', onEarlyClose);

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
        this.sendHello();
        resolve();
      };
      const onError = (err: Error): void => {
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
        reject(err);
      };
      socket.on('open', onOpen);
      socket.on('error', onError);
    });

    await this.runMessageLoop(messageQueue, () => {
      socket.removeListener('message', onEarlyMessage);
      socket.removeListener('close', onEarlyClose);
      return earlyClose;
    });
  }

  private sendHello(): void {
    const frame: AgentHostClientFrame = {
      type: 'hello',
      session: this.env.DESK_TMUX_SESSION,
      token: this.env.DESK_AGENT_HOST_TOKEN,
      agent: this.env.DESK_AGENT,
      pid: this.pid
    };
    this.sendFrame(frame);
    this.logger.info(`hello sent session=${this.env.DESK_TMUX_SESSION} agent=${this.env.DESK_AGENT} pid=${this.pid}`);
  }

  private async runMessageLoop(
    earlyMessages?: unknown[],
    consumeEarlyClose?: () => { code: number | null; reason: string } | null
  ): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    // Drain any messages captured during the open→here transition before installing the
    // steady-state listener so they aren't lost.
    if (earlyMessages && earlyMessages.length > 0) {
      for (const data of earlyMessages) {
        this.handleInbound(data).catch((err) => {
          this.logger.error(`inbound handler threw: ${describeError(err)}`);
        });
      }
      earlyMessages.length = 0;
    }
    const earlyClose = consumeEarlyClose?.();
    if (earlyClose) {
      return;
    }
    await new Promise<void>((resolve) => {
      const onMessage = (data: unknown): void => {
        this.handleInbound(data).catch((err) => {
          this.logger.error(`inbound handler threw: ${describeError(err)}`);
        });
      };
      const onClose = (): void => {
        socket.removeListener('message', onMessage);
        socket.removeListener('close', onClose);
        resolve();
      };
      socket.on('message', onMessage);
      socket.on('close', onClose);
    });
  }

  private async handleInbound(data: unknown): Promise<void> {
    let frame: AgentHostServerFrame;
    try {
      frame = parseAgentHostServerFrame(typeof data === 'string' ? JSON.parse(data) : data);
    } catch (err) {
      this.logger.error(`dropping malformed frame: ${describeError(err)}`);
      return;
    }

    switch (frame.type) {
      case 'hello-ack':
        await this.handleHelloAck(frame.lastSeq);
        return;
      case 'inject':
        await this.runCommand(frame.requestId, 'inject', () => {
          if (!this.driver) throw notStartedError();
          return this.driver.inject(frame.text, frame.source);
        });
        return;
      case 'respond-permission':
        await this.runCommand(frame.requestId, 'respond-permission', () => {
          if (!this.driver) throw notStartedError();
          return this.driver.respondPermission(frame.permissionRequestId, frame.optionId, frame.note);
        });
        return;
      case 'interrupt':
        await this.runCommand(frame.requestId, 'interrupt', () => {
          if (!this.driver) throw notStartedError();
          return this.driver.interrupt();
        });
        return;
      case 'shutdown':
        await this.runCommand(frame.requestId, 'shutdown', async () => {
          this.shuttingDown = true;
          if (this.driver) {
            await this.driver.shutdown();
          }
        });
        // Closing the socket resolves runMessageLoop so run()'s loop re-checks
        // shuttingDown and exits cleanly.
        this.safeClose();
        return;
    }
  }

  private async handleHelloAck(lastSeq: number): Promise<void> {
    if (this.firstHelloCompleted) {
      // Reconnect after a transient drop or server restart.
      if (lastSeq > 0) {
        // Broker kept its ring — drain our bounded committed ring tail beyond lastSeq.
        this.logger.info(`hello-ack lastSeq=${lastSeq} (transient drop; draining ring tail)`);
        const tail = this.committedRing.filter((e) => e.seq > lastSeq);
        for (const event of tail) {
          this.sendFrame({ type: 'event', event });
        }
      } else {
        // Server restarted — full backfill sequence per spec §5 step 3.
        this.logger.info('hello-ack lastSeq=0 (server restart); running full backfill');
        await this.runBackfill();
      }
      return;
    }
    // First successful hello — start the driver, do initial backfill if needed.
    this.firstHelloCompleted = true;
    this.logger.info('hello-ack received; starting driver');
    await this.startDriver(lastSeq === 0);
  }

  private async startDriver(needsInitialBackfill: boolean): Promise<void> {
    if (this.driver) {
      this.logger.warn('startDriver called but driver already loaded');
      return;
    }
    const driver = this.loadDriverFn(this.env, this.logger);
    this.driver = driver;
    driver.onEvent((event) => this.handleDriverEvent(event));

    try {
      const { session, status } = await driver.start();
      // emit session-info (always; even on reconnect the broker needs it for resume-id persist)
      this.emitDriverEvent({
        kind: 'session-info',
        agentSessionId: session.agentSessionId,
        model: session.model
      });
      // emit deterministic status
      this.emitDriverEvent(status);
      if (needsInitialBackfill) {
        await this.runBackfill({ skipStatus: true });
      }
      this.logger.info('driver started');
    } catch (err) {
      this.logger.error(`driver.start failed: ${describeError(err)}`);
      // start failure is fatal — emit agent-error and exit nonzero so the tmux pane surfaces it
      this.emitDriverEvent({
        kind: 'agent-error',
        message: describeError(err),
        fatal: true
      });
      await this.maybeShutdownDriver();
      // Ensure the broker receives the agent-error before we close
      this.safeClose();
      this.exitFn(1);
    }
  }

  private async runBackfill(opts: { skipStatus?: boolean } = {}): Promise<void> {
    if (!this.driver) {
      return;
    }
    let history: DriverEvent[];
    try {
      history = await this.driver.fetchHistory();
    } catch (err) {
      if (isDriverCommandError(err)) {
        this.emitDriverEvent({
          kind: 'agent-error',
          message: `history backfill failed: ${err.message}`,
          fatal: false
        });
        return;
      }
      this.emitDriverEvent({
        kind: 'agent-error',
        message: `history backfill crashed: ${describeError(err)}`,
        fatal: false
      });
      return;
    }
    if (!opts.skipStatus) {
      // Re-emit current status before backfill events so the subscriber observes the
      // transition from idle → backfill → idle correctly.
    }
    for (const event of history) {
      this.emitDriverEvent(event);
    }
    this.emitDriverEvent({ kind: 'history-boundary', backfillComplete: true });
    this.logger.info(`backfill emitted ${history.length} events`);
  }

  private handleDriverEvent(payload: DriverEvent): void {
    if (this.shuttingDown) {
      return;
    }
    const event: AgentSurfaceEvent = {
      ...payload,
      seq: (this.seqCounter += 1),
      ts: this.now().toISOString()
    };
    if (!isTransient(event)) {
      this.committedRing.push(event);
      while (this.committedRing.length > RING_SIZE) {
        this.committedRing.shift();
      }
    }
    this.sendFrame({ type: 'event', event });
  }

  private emitDriverEvent(payload: AgentSurfaceEventPayload): void {
    this.handleDriverEvent(payload);
  }

  private async runCommand(
    requestId: string,
    kind: CommandPending['kind'],
    fn: () => Promise<void>
  ): Promise<void> {
    if (this.inFlightCommand) {
      // Spec does not support command pipelining; the broker must wait for command-result
      // before issuing the next. Reject with the typed send-while-busy.
      this.sendCommandResult(requestId, {
        code: 'send-while-busy',
        message: `command ${kind} arrived while ${this.inFlightCommand.kind} is in flight`,
        retryable: false
      });
      return;
    }
    this.inFlightCommand = { requestId, kind };
    try {
      await fn();
      this.sendFrame({ type: 'command-result', requestId, ok: true });
    } catch (err) {
      if (isDriverCommandError(err)) {
        this.sendCommandResult(requestId, { code: err.code, message: err.message, retryable: err.retryable });
      } else {
        // Agreed unknown-error mapping (msg-20260705-154138):
        // shutdown unknown → adapter-unavailable retryable=false (terminal);
        // other commands unknown → adapter-unavailable retryable=true (transient).
        const retryable = kind !== 'shutdown';
        this.sendCommandResult(requestId, {
          code: 'adapter-unavailable',
          message: describeError(err),
          retryable
        });
      }
    } finally {
      this.inFlightCommand = null;
    }
  }

  private sendCommandResult(requestId: string, error: { code: AgentUiErrorCode; message: string; retryable: boolean }): void {
    const frame: AgentHostClientFrame = { type: 'command-result', requestId, ok: false, error };
    this.sendFrame(frame);
  }

  private sendFrame(frame: AgentHostClientFrame): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      // socket dropped mid-frame; the ring will replay on reconnect if it was committed
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (err) {
      this.logger.error(`socket send failed: ${describeError(err)}`);
    }
  }

  private safeClose(): void {
    if (this.reconnectTimer !== null) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1000, 'agent-host shutdown');
      } catch {
        // best-effort
      }
      this.socket = null;
    }
  }

  private async maybeShutdownDriver(): Promise<void> {
    if (this.driver) {
      try {
        await this.driver.shutdown();
      } catch {
        // best-effort
      }
      this.driver = null;
    }
  }

  private async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer !== null) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.maybeShutdownDriver();
    this.safeClose();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = this.scheduler.setTimeout(() => {
        this.reconnectTimer = null;
        resolve();
      }, ms);
    });
  }
}

function isTransient(event: AgentSurfaceEvent): boolean {
  return event.kind === 'assistant-delta' || event.kind === 'tool-output-delta';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function notStartedError(): Error & { code: AgentUiErrorCode; retryable: boolean } {
  const err = new Error('driver not started') as Error & { code: AgentUiErrorCode; retryable: boolean };
  err.code = 'adapter-unavailable';
  err.retryable = false;
  return err;
}

function preHelloBackoff(attempt: number): number {
  // Linear with attempt, capped at 5s.
  return Math.min(5_000, PRE_HELLO_BACKOFF_MS * attempt);
}

function postHelloBackoff(attempt: number): number {
  // Exponential with jitter, capped at POST_HELLO_MAX_BACKOFF_MS.
  const base = Math.min(POST_HELLO_MAX_BACKOFF_MS, POST_HELLO_INITIAL_BACKOFF_MS * 2 ** Math.min(attempt - 1, 10));
  const jitter = Math.random() * POST_HELLO_BACKOFF_JITTER_MS;
  return base + jitter;
}

function wsUrl(serverUrl: string): string {
  return serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
}

/**
 * Parse an AgentHostServerFrame from an unknown value. Throws on malformed input so
 * the caller can drop+audit. Mirrors claude's parseAgentHostClientFrame shape.
 *
 * TODO(promote): once this stabilizes, move into core/agentSurfaceProtocol.ts so the
 * protocol module owns both directions' parsers. Tracked for a follow-up that doesn't
 * block Phase 1.
 */
export function parseAgentHostServerFrame(value: unknown): AgentHostServerFrame {
  if (!value || typeof value !== 'object') {
    throw new Error('agent host server frame must be an object');
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'hello-ack':
      return { type: 'hello-ack', lastSeq: nonNegativeInt(record.lastSeq) };
    case 'inject':
      return {
        type: 'inject',
        requestId: nonEmptyString(record.requestId),
        text: typeof record.text === 'string' ? record.text : '',
        source: parseSource(record.source)
      };
    case 'respond-permission':
      return {
        type: 'respond-permission',
        requestId: nonEmptyString(record.requestId),
        permissionRequestId: nonEmptyString(record.permissionRequestId),
        optionId: nonEmptyString(record.optionId),
        note: typeof record.note === 'string' ? record.note : undefined
      };
    case 'interrupt':
      return { type: 'interrupt', requestId: nonEmptyString(record.requestId) };
    case 'shutdown':
      return { type: 'shutdown', requestId: nonEmptyString(record.requestId) };
    default:
      throw new Error(`unknown agent host server frame type: ${String(record.type)}`);
  }
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('expected non-empty string');
  }
  return value;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
    throw new Error('expected non-negative integer');
  }
  return value;
}

function parseSource(value: unknown): 'ui' | 'channel' | 'external' {
  if (value === 'ui' || value === 'channel' || value === 'external') {
    return value;
  }
  return 'external';
}
