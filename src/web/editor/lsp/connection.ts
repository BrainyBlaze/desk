/**
 * Editor-side LSP client transport. Speaks the Desk bridge contract:
 *   1. The bridge owns initialize/initialized; the first frame it sends is the
 *      single non-LSP envelope { type:'ready', capabilities:<InitializeResult.capabilities> }.
 *   2. Every frame after that is a raw LSP JSON-RPC object, one per WS message.
 *   3. Child death arrives as { type:'exit', code, signal } (and/or transport close).
 *
 * This class is transport-agnostic: it takes an {@link LspTransport} so the
 * protocol logic can be unit-tested with a synchronous fake and reused under
 * the real /ws/lsp WebSocket.
 */

import { perfMarkBackendReady, perfMarkFirst, perfMarkRequest } from './perfTelemetry.js';

/** Minimal duplex string transport - a thin seam over WebSocket. */
export interface LspTransport {
  send(data: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type ServerCapabilities = Record<string, unknown>;

type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

/** Bounded-restart metadata carried by an exit or restarting/stopped status frame. */
export interface LspRestartInfo {
  state: 'restarting' | 'stopped';
  attempt: number;
  maxAttempts: number;
}

/** Reason the language server went away. */
export interface LspExit {
  code: number | null;
  signal: string | null;
  /** Present when the backend's bounded-restart supervisor annotated the exit. */
  restart?: LspRestartInfo;
}
type ExitHandler = (exit: LspExit) => void;

/** The five read-only lifecycle states the bridge publishes as `type:'status'` frames. */
export type LspLifecycleState = 'warming' | 'ready' | 'degraded' | 'restarting' | 'stopped';

/** A read-only lifecycle/status envelope from the bridge: server-derived identity + state only. */
export interface LspLifecycleStatus {
  state: LspLifecycleState;
  serverConfigId: string;
  workspaceRoot: string;
  languageId?: string;
  warm?: boolean;
  reason?: string;
  restart?: LspRestartInfo;
}
type StatusHandler = (status: LspLifecycleStatus) => void;

const LIFECYCLE_STATES: ReadonlySet<string> = new Set<LspLifecycleState>([
  'warming',
  'ready',
  'degraded',
  'restarting',
  'stopped'
]);

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  /** Detach the abort listener once the request settles (prevents late cancel + leaks). */
  cleanup?: () => void;
}

/** Options for a client->server request. */
export interface LspRequestOptions {
  /** Abort the request: sends `$/cancelRequest` and rejects with {@link LspCancellationError}. */
  signal?: AbortSignal;
}

/** JSON-RPC error returned by the server in a response. */
export class LspResponseError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'LspResponseError';
  }
}

/** A request rejected because its caller (e.g. a Monaco provider token) cancelled it. */
export class LspCancellationError extends Error {
  constructor(message = 'request cancelled') {
    super(message);
    this.name = 'LspCancellationError';
  }
}

/**
 * whenReady() rejected because the transport closed (or the server exited) before the
 * `ready` envelope arrived. Carries the {@link LspExit} the connection died with; the
 * concrete WebSocket close code (e.g. 1008/1011) is read separately from the transport's
 * closeInfo(), since LspConnection only receives the generic onClose callback.
 */
export class LspReadyError extends Error {
  constructor(readonly exit: LspExit) {
    super(`language server closed before ready (code=${exit.code} signal=${exit.signal})`);
    this.name = 'LspReadyError';
  }
}

const METHOD_NOT_FOUND = -32601;

/** Validate an optional restart payload from a status/exit frame; undefined when absent/malformed. */
function parseRestartInfo(raw: unknown): LspRestartInfo | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const obj = raw as { state?: unknown; attempt?: unknown; maxAttempts?: unknown };
  if (
    (obj.state === 'restarting' || obj.state === 'stopped') &&
    typeof obj.attempt === 'number' &&
    typeof obj.maxAttempts === 'number'
  ) {
    return { state: obj.state, attempt: obj.attempt, maxAttempts: obj.maxAttempts };
  }
  return undefined;
}

export class LspConnection {
  private readonly transport: LspTransport;
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private nextId = 1;
  private dead = false;
  private ready = false;

  private resolveReady!: (capabilities: ServerCapabilities) => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyPromise: Promise<ServerCapabilities>;

  constructor(transport: LspTransport) {
    this.transport = transport;
    this.readyPromise = new Promise<ServerCapabilities>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Mark the readiness promise handled so a close-before-ready rejection never surfaces as an
    // unhandled rejection when no caller awaited whenReady(); whenReady() still returns this same
    // rejecting promise, so real callers receive the rejection.
    this.readyPromise.catch(() => {});
    transport.onMessage((data) => this.receive(data));
    transport.onClose(() => this.die({ code: null, signal: null }));
  }

  /** Resolves with the server's capabilities once the bridge sends `ready`. */
  whenReady(): Promise<ServerCapabilities> {
    return this.readyPromise;
  }

  /**
   * Send a client->server request; resolves with the result or rejects on error.
   * Pass `options.signal` (e.g. bridged from a Monaco CancellationToken) to cancel:
   * on abort the connection emits `$/cancelRequest` and rejects with {@link LspCancellationError}.
   */
  request<T = unknown>(method: string, params: unknown, options?: LspRequestOptions): Promise<T> {
    const signal = options?.signal;
    // Already cancelled before we send: reject without bothering the server.
    if (signal?.aborted) {
      return Promise.reject(new LspCancellationError());
    }
    const id = this.nextId++;
    perfMarkRequest(method, 'start');
    return new Promise<T>((resolve, reject) => {
      // LSP telemetry (no-op unless DESK_LSP_PERF): count finish vs cancel by method, and record
      // the semanticTokens response-finish proxy. Wrapping resolve/reject changes no scheduling.
      const instrumentedResolve = (result: unknown): void => {
        perfMarkRequest(method, 'finish');
        if (method === 'textDocument/semanticTokens/full') {
          perfMarkFirst('semanticTokensResponse');
        }
        (resolve as (value: unknown) => void)(result);
      };
      const instrumentedReject = (error: Error): void => {
        perfMarkRequest(method, error instanceof LspCancellationError ? 'cancel' : 'finish');
        reject(error);
      };
      const entry: PendingRequest = { resolve: instrumentedResolve, reject: instrumentedReject };
      if (signal) {
        const onAbort = (): void => {
          // Ignore if the request already settled (response arrived first).
          if (!this.pending.has(id)) {
            return;
          }
          this.pending.delete(id);
          this.transport.send(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }));
          instrumentedReject(new LspCancellationError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, entry);
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Send a client->server notification (no response expected). */
  notify(method: string, params: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Subscribe to a server->client LSP notification (e.g. textDocument/publishDiagnostics). */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Register the answerer for a server->client request (workspace/configuration, applyEdit, ...). */
  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  /** Notified once when the server exits (exit frame) or the transport closes. */
  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Subscribe to the bridge's read-only lifecycle/status envelopes (warming/ready/degraded/...). */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Tear down once: reject in-flight requests, fire exit handlers, close the transport. */
  private die(exit: LspExit): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    // Closed/exited before the ready envelope: settle whenReady() with a deterministic rejection
    // instead of leaving it pending forever. Guarded by `ready` (no-op once resolved) and by the
    // `dead` early-return above, so readiness rejects at most once.
    if (!this.ready) {
      this.ready = true;
      this.rejectReady(new LspReadyError(exit));
    }
    for (const entry of this.pending.values()) {
      entry.cleanup?.();
      entry.reject(new Error(`language server gone (transport closed; code=${exit.code} signal=${exit.signal})`));
    }
    this.pending.clear();
    for (const handler of this.exitHandlers) {
      handler(exit);
    }
    this.transport.close();
  }

  private receive(data: string): void {
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      return; // ignore malformed frames
    }
    if (message && typeof message.type === 'string') {
      this.handleEnvelope(message);
      return;
    }
    this.handleLsp(message);
  }

  private handleEnvelope(message: {
    type: string;
    capabilities?: ServerCapabilities;
    code?: number | null;
    signal?: string | null;
    state?: string;
    serverConfigId?: string;
    workspaceRoot?: string;
    languageId?: string;
    warm?: boolean;
    reason?: string;
    restart?: unknown;
    telemetry?: { ready?: { createSessionMs?: number; acceptToReadyMs?: number } };
  }): void {
    if (message.type === 'status') {
      // Defensive: only forward a recognized lifecycle state with the server-derived identity. Unknown
      // states are dropped (fail closed) so a malformed/forward-incompatible frame never reaches the UI.
      if (
        typeof message.state === 'string' &&
        LIFECYCLE_STATES.has(message.state) &&
        typeof message.serverConfigId === 'string' &&
        typeof message.workspaceRoot === 'string'
      ) {
        const status: LspLifecycleStatus = {
          state: message.state as LspLifecycleState,
          serverConfigId: message.serverConfigId,
          workspaceRoot: message.workspaceRoot
        };
        if (typeof message.languageId === 'string') {
          status.languageId = message.languageId;
        }
        if (typeof message.warm === 'boolean') {
          status.warm = message.warm;
        }
        if (typeof message.reason === 'string') {
          status.reason = message.reason;
        }
        const restart = parseRestartInfo(message.restart);
        if (restart) {
          status.restart = restart;
        }
        for (const handler of this.statusHandlers) {
          handler(status);
        }
      }
      return;
    }
    if (message.type === 'ready') {
      // When connected with lspTelemetry=1 the bridge attaches safe ready timing -- record it
      // (no-op unless DESK_LSP_PERF). Read-only; absent on a normal connection.
      const ready = message.telemetry?.ready;
      if (ready && typeof ready.createSessionMs === 'number' && typeof ready.acceptToReadyMs === 'number') {
        perfMarkBackendReady(ready.createSessionMs, ready.acceptToReadyMs);
      }
      if (!this.ready) {
        this.ready = true;
        this.resolveReady(message.capabilities ?? {});
      }
      return;
    }
    if (message.type === 'exit') {
      const restart = parseRestartInfo(message.restart);
      this.die({ code: message.code ?? null, signal: message.signal ?? null, ...(restart ? { restart } : {}) });
    }
  }

  private handleLsp(message: any): void {
    const hasMethod = typeof message?.method === 'string';
    const hasId = message?.id !== undefined && message?.id !== null;

    if (hasMethod && hasId) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (hasMethod) {
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(message.params);
        }
      }
      return;
    }
    if (hasId) {
      this.handleResponse(message);
    }
  }

  private handleResponse(message: { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    pending.cleanup?.();
    if (message.error) {
      pending.reject(new LspResponseError(message.error.message, message.error.code, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.transport.send(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `unhandled request: ${method}` } })
      );
      return;
    }
    const respond = (result: unknown): void => this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const fail = (error: unknown): void =>
      this.transport.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
        })
      );
    let result: unknown;
    try {
      result = handler(params);
    } catch (error) {
      fail(error);
      return;
    }
    // Answer synchronously for plain values; defer only when the handler is async.
    if (result instanceof Promise) {
      result.then(respond, fail);
    } else {
      respond(result);
    }
  }
}
