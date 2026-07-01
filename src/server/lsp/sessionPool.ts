import type { LspVirtualSession } from '../lspWebSocketBridge.js';
import {
  createRawSessionMultiplexer,
  type AttachRawSessionConsumerOptions,
  type DiskDocumentUse,
  type RawDocumentSnapshot,
  type RawSessionConsumer,
  type RawSessionMultiplexer,
  type SyncDocumentForRequestOptions
} from './rawSessionMultiplexer.js';
import { isLspRequestMetricsEnabled, type LspRequestMetricsRecorder } from './requestMetrics.js';
import { createStdioVirtualSession, type StdioVirtualSessionOptions } from './stdioVirtualSession.js';
import {
  parseFileOperationRegistrationRequest,
  type FileOperationRegistrationEvent
} from './fileOperationRegistrations.js';

export interface LspSessionStartOptions {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceRoot: string;
  initializationOptions?: Record<string, unknown>;
  startupTimeoutMs?: number;
}

export interface LspSessionSnapshot {
  id: string;
  state: 'starting' | 'ready' | 'exited';
  capabilities: Record<string, unknown>;
}

export interface LspSessionPoolOptions {
  createSession?: (options: StdioVirtualSessionOptions) => LspVirtualSession | Promise<LspVirtualSession>;
  requestMetrics?: LspRequestMetricsRecorder;
}

export interface LspSendRequestOptions {
  signal?: AbortSignal;
}

export interface LspServerNotification {
  sessionId: string;
  method: string;
  params: unknown;
}

export interface LspDocumentSnapshotEvent {
  sessionId: string;
  snapshot: RawDocumentSnapshot;
}

export interface LspSessionExitEvent {
  sessionId: string;
  code: number | null;
  signal: string | null;
  reason: 'natural' | 'stopped';
}

export type LspFileOperationRegistrationEvent = FileOperationRegistrationEvent;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface LspSessionState {
  id: string;
  session: LspVirtualSession;
  multiplexer: RawSessionMultiplexer;
  internalConsumer: RawSessionConsumer;
  pending: Map<number, PendingRequest>;
  state: LspSessionSnapshot['state'];
  capabilities: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

export class LspSessionPool {
  private readonly sessions = new Map<string, LspSessionState>();
  private readonly starting = new Set<string>();
  private readonly createSession: (options: StdioVirtualSessionOptions) => LspVirtualSession | Promise<LspVirtualSession>;
  private readonly requestMetrics: LspRequestMetricsRecorder | undefined;
  private readonly exitListeners: Array<(event: LspSessionExitEvent) => void> = [];
  private readonly notificationListeners: Array<(notification: LspServerNotification) => void> = [];
  private readonly documentListeners: Array<(event: LspDocumentSnapshotEvent) => void> = [];
  private readonly fileOperationRegistrationListeners: Array<(event: LspFileOperationRegistrationEvent) => void> = [];
  private nextRequestId = 1;

  constructor(options: LspSessionPoolOptions = {}) {
    this.createSession = options.createSession ?? createStdioVirtualSession;
    this.requestMetrics = options.requestMetrics;
  }

  async start(options: LspSessionStartOptions): Promise<LspSessionSnapshot> {
    if (this.sessions.has(options.id) || this.starting.has(options.id)) {
      throw new Error(`LSP session already exists: ${options.id}`);
    }

    this.starting.add(options.id);
    try {
      const virtualSession = await this.createSession({
        command: options.command,
        args: options.args,
        env: options.env,
        workspaceRoot: options.workspaceRoot,
        initializationOptions: options.initializationOptions,
        startupTimeoutMs: options.startupTimeoutMs,
        sessionId: options.id,
        requestMetrics: this.requestMetrics
      });
      const session = {
        id: options.id,
        session: virtualSession,
        multiplexer: undefined as unknown as RawSessionMultiplexer,
        internalConsumer: undefined as unknown as RawSessionConsumer,
        pending: new Map(),
        state: 'ready',
        capabilities: virtualSession.capabilities
      } satisfies LspSessionState;
      session.multiplexer = createRawSessionMultiplexer({
        session: virtualSession,
        sessionId: session.id,
        requestMetrics: this.requestMetrics,
        onDiagnostics: (notification) => {
          for (const listener of this.notificationListeners) {
            listener({ sessionId: session.id, method: notification.method, params: notification.params });
          }
        },
        onProgress: (notification) => {
          for (const listener of this.notificationListeners) {
            listener({ sessionId: session.id, method: notification.method, params: notification.params });
          }
        },
        onDocumentSnapshot: (snapshot) => {
          for (const listener of this.documentListeners) {
            listener({ sessionId: session.id, snapshot });
          }
        },
        onServerRequest: (request) => this.handleServerRequest(session, request)
      });
      session.internalConsumer = session.multiplexer.attachConsumer({
        kind: 'internal-request-api',
        onMessage: (message) => this.handleMessage(session, message)
      });

      this.sessions.set(options.id, session);
      virtualSession.onExit((exit) => {
        this.handleExit(
          session,
          new Error(`LSP session exited: code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'null'}`),
          { code: exit.code, signal: exit.signal, reason: 'natural' }
        );
      });

      return snapshot(session);
    } finally {
      this.starting.delete(options.id);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  async sendRequest(sessionId: string, method: string, params: unknown, options: LspSendRequestOptions = {}): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`LSP session not found: ${sessionId}`);
    }
    if (session.state !== 'ready') {
      throw new Error(`LSP session is not ready: ${sessionId}`);
    }
    return this.request(session, method, params, options);
  }

  notify(sessionId: string, method: string, params: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'ready') {
      return;
    }
    session.internalConsumer.sendClientMessage({ jsonrpc: '2.0', method, params });
  }

  onSessionExit(listener: (event: LspSessionExitEvent) => void): void {
    this.exitListeners.push(listener);
  }

  onServerNotification(listener: (notification: LspServerNotification) => void): void {
    this.notificationListeners.push(listener);
  }

  onDocumentSnapshot(listener: (event: LspDocumentSnapshotEvent) => void): void {
    this.documentListeners.push(listener);
  }

  onFileOperationRegistration(listener: (event: LspFileOperationRegistrationEvent) => void): void {
    this.fileOperationRegistrationListeners.push(listener);
  }

  attachRawConsumer(sessionId: string, options: AttachRawSessionConsumerOptions): RawSessionConsumer {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'ready') {
      throw new Error(`LSP session not found: ${sessionId}`);
    }
    return session.multiplexer.attachConsumer(options);
  }

  syncDocumentForRequest(sessionId: string, options: SyncDocumentForRequestOptions): DiskDocumentUse {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'ready') {
      throw new Error(`LSP session not found: ${sessionId}`);
    }
    return session.multiplexer.syncDocumentForRequest(options);
  }

  async stop(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.multiplexer.closeAllDocuments();
    this.handleExit(session, new Error(`LSP session stopped: ${id}`), { code: null, signal: null, reason: 'stopped' });
    session.multiplexer.dispose();
  }

  private request(
    session: LspSessionState,
    method: string,
    params: unknown,
    options: LspSendRequestOptions
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('LSP request canceled'));
        return;
      }

      const cleanup = () => {
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (!session.pending.has(id)) {
          return;
        }
        session.pending.delete(id);
        cleanup();
        session.internalConsumer.sendClientMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        reject(new Error('LSP request canceled'));
      };

      session.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      session.internalConsumer.sendClientMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  private handleMessage(session: LspSessionState, message: unknown): void {
    if (!isRecord(message) || typeof message.id !== 'number') {
      return;
    }
    const pending = session.pending.get(message.id);
    if (!pending) {
      return;
    }
    session.pending.delete(message.id);
    const response = message as unknown as JsonRpcResponse;
    if (response.error) {
      pending.reject(new Error(response.error.message ?? 'LSP request failed'));
      return;
    }
    pending.resolve(response.result);
  }

  private handleServerRequest(
    session: LspSessionState,
    request: { id: string | number; method: string; params: unknown }
  ): { handled: false } | { handled: true; result: null } {
    const parsed = parseFileOperationRegistrationRequest(request.method, request.params);
    if (!parsed.handled) {
      return { handled: false };
    }
    try {
      this.emitFileOperationRegistration({
        sessionId: session.id,
        action: parsed.action,
        registrations: parsed.registrations
      });
    } catch {
      return { handled: true, result: null };
    }
    return { handled: true, result: null };
  }

  private handleExit(
    session: LspSessionState,
    error: Error,
    exit: Omit<LspSessionExitEvent, 'sessionId'>
  ): void {
    if (!this.sessions.has(session.id)) {
      return;
    }
    session.state = 'exited';
    this.sessions.delete(session.id);
    this.emitFileOperationRegistration({ sessionId: session.id, action: 'clear', registrations: [] });
    session.multiplexer.closeAllDocuments();
    session.multiplexer.dispose();
    if (isLspRequestMetricsEnabled(this.requestMetrics) && session.pending.size > 0) {
      this.requestMetrics.sessionExitRejected({ sessionId: session.id, count: session.pending.size });
    }
    for (const pending of session.pending.values()) {
      pending.reject(error);
    }
    session.pending.clear();
    for (const listener of this.exitListeners) {
      listener({ sessionId: session.id, ...exit });
    }
  }

  private emitFileOperationRegistration(event: LspFileOperationRegistrationEvent): void {
    for (const listener of this.fileOperationRegistrationListeners) {
      listener(event);
    }
  }
}

function snapshot(session: LspSessionState): LspSessionSnapshot {
  return {
    id: session.id,
    state: session.state,
    capabilities: session.capabilities
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
