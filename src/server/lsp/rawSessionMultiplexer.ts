import type { LspVirtualSession } from '../lspWebSocketBridge.js';
import { isLspRequestMetricsEnabled, type LspRequestMetricDimensions, type LspRequestMetricsRecorder } from './requestMetrics.js';

export type RawSessionConsumerKind = 'raw-editor' | 'internal-request-api';
export type JsonRpcId = number | string;

export type RawDocumentSnapshot =
  | { state: 'editor-open'; uri: string; languageId: string; version: number; text: string }
  | { state: 'disk-cached'; uri: string; languageId: string; version: number; text: string }
  | { state: 'closed'; uri: string };

export interface RawSessionMultiplexerOptions {
  session: Pick<LspVirtualSession, 'sendClientMessage' | 'onServerMessage' | 'onExit' | 'dispose'>;
  sessionId?: string;
  requestCaps?: RawSessionRequestCapsOptions;
  requestMetrics?: LspRequestMetricsRecorder;
  onDiagnostics?: (notification: { method: 'textDocument/publishDiagnostics'; params: unknown }) => void;
  onProgress?: (notification: { method: '$/progress'; params: LspProgressParams }) => void;
  onDocumentSnapshot?: (snapshot: RawDocumentSnapshot) => void;
  onServerRequest?: (request: {
    id: JsonRpcId;
    method: string;
    params: unknown;
  }) => { handled: false } | { handled: true; result?: unknown; error?: { code: number; message: string } };
}

export interface RawSessionRequestCapsOptions {
  maxPendingPerConsumer?: number;
  maxPendingPerMethod?: number;
  excludedMethods?: readonly string[];
}

export interface AttachRawSessionConsumerOptions {
  kind: RawSessionConsumerKind;
  onMessage: (message: unknown) => void;
}

export interface DiskDocumentUseOptions {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface SyncDocumentForRequestOptions {
  uri: string;
  languageId: string;
  readDisk: () => string | { text: string; languageId?: string; version?: number };
}

export interface DiskDocumentUse {
  source: 'editor-live' | 'disk-cache';
  snapshot?: Extract<RawDocumentSnapshot, { state: 'editor-open' | 'disk-cached' }>;
  release(): void;
}

export interface RawSessionConsumer {
  readonly id: string;
  readonly kind: RawSessionConsumerKind;
  sendClientMessage(message: unknown): void;
  useDiskDocument(document: DiskDocumentUseOptions): DiskDocumentUse;
  dispose(): void;
}

export interface LspProgressParams {
  token: string | number;
  value: {
    kind?: string;
    title?: string;
    message?: string;
    percentage?: number;
  };
}

export interface RawSessionMultiplexer {
  attachConsumer(options: AttachRawSessionConsumerOptions): RawSessionConsumer;
  syncDocumentForRequest(options: SyncDocumentForRequestOptions): DiskDocumentUse;
  closeAllDocuments(): void;
  dispose(): void;
}

interface ConsumerState {
  id: string;
  kind: RawSessionConsumerKind;
  onMessage: (message: unknown) => void;
  disposed: boolean;
}

interface ClientPending {
  consumerId: string;
  downstreamId: JsonRpcId;
  method: string;
  metric: LspRequestMetricDimensions;
  requestCap?: RequestCapAccount;
}

interface ServerPending {
  consumerId: string;
  downstreamId: JsonRpcId;
  upstreamId: JsonRpcId;
  method: string;
  metric: LspRequestMetricDimensions;
  requestCap?: RequestCapAccount;
}

interface DiskSnapshot {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspContentChange {
  text: string;
  range?: LspRange;
}

interface DocumentState {
  uri: string;
  editorOwners: Set<string>;
  diskSnapshot: DiskSnapshot | undefined;
  serverOpen: boolean;
  languageId: string;
  version: number;
  text: string;
}

interface RequestCapAccount {
  consumerId: string;
  method: string;
}

interface NormalizedRequestCaps {
  maxPendingPerConsumer: number;
  maxPendingPerMethod: number;
  excludedMethods: Set<string>;
}

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const REQUEST_CANCELLED = -32800;
const DEFAULT_MAX_PENDING_PER_CONSUMER = 32;
const DEFAULT_MAX_PENDING_PER_METHOD = 64;
const REQUEST_CAP_EXCLUDED_METHODS = [
  'shutdown',
  'textDocument/diagnostic',
  'workspace/willCreateFiles',
  'workspace/willRenameFiles',
  'workspace/willDeleteFiles',
  'workspace/applyEdit',
  'workspace/didCreateFiles',
  'workspace/didRenameFiles',
  'workspace/didDeleteFiles',
  'client/registerCapability',
  'client/unregisterCapability'
] as const;

export function createRawSessionMultiplexer(options: RawSessionMultiplexerOptions): RawSessionMultiplexer {
  return new RawSessionMultiplexerImpl(options);
}

class RawSessionMultiplexerImpl implements RawSessionMultiplexer {
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly editorAttachOrder: string[] = [];
  private readonly clientPendingByUpstream = new Map<string, ClientPending>();
  private readonly clientPendingByConsumerDownstream = new Map<string, JsonRpcId>();
  private readonly serverPendingByUpstream = new Map<string, ServerPending>();
  private readonly serverPendingByConsumerDownstream = new Map<string, JsonRpcId>();
  private readonly documents = new Map<string, DocumentState>();
  private readonly requestCaps: NormalizedRequestCaps;
  private readonly cappedPendingByConsumer = new Map<string, number>();
  private readonly cappedPendingByMethod = new Map<string, number>();
  private nextConsumerId = 1;
  private nextClientUpstreamId = 1;
  private nextServerDownstreamId = 1;
  private disposed = false;

  constructor(private readonly options: RawSessionMultiplexerOptions) {
    this.requestCaps = normalizeRequestCaps(options.requestCaps);
    options.session.onServerMessage((message) => this.handleServerMessage(message));
    options.session.onExit(() => {
      for (const consumer of [...this.consumers.values()]) {
        this.disposeConsumer(consumer);
      }
    });
  }

  attachConsumer(options: AttachRawSessionConsumerOptions): RawSessionConsumer {
    const state: ConsumerState = {
      id: `consumer:${this.nextConsumerId++}`,
      kind: options.kind,
      onMessage: options.onMessage,
      disposed: false
    };
    this.consumers.set(state.id, state);
    if (state.kind === 'raw-editor') {
      this.editorAttachOrder.push(state.id);
    }

    return {
      id: state.id,
      kind: state.kind,
      sendClientMessage: (message) => this.handleConsumerMessage(state, message),
      useDiskDocument: (document) => this.useDiskDocument(state, document),
      dispose: () => this.disposeConsumer(state)
    };
  }

  syncDocumentForRequest(options: SyncDocumentForRequestOptions): DiskDocumentUse {
    if (this.disposed) {
      return noopDiskUse('disk-cache');
    }
    const document = this.getOrCreateDocument(options.uri);
    const editorSnapshot = this.editorSnapshot(document);
    if (editorSnapshot) {
      return noopDiskUse('editor-live', editorSnapshot);
    }

    const diskRead = options.readDisk();
    const text = typeof diskRead === 'string' ? diskRead : diskRead.text;
    const languageId = typeof diskRead === 'string' ? options.languageId : (diskRead.languageId ?? options.languageId);
    const requestedVersion = typeof diskRead === 'string' ? undefined : diskRead.version;
    const existingDisk = document.diskSnapshot;
    if (existingDisk && existingDisk.text === text && existingDisk.languageId === languageId) {
      document.languageId = existingDisk.languageId;
      document.version = existingDisk.version;
      document.text = existingDisk.text;
      return noopDiskUse('disk-cache', toDiskSnapshot(existingDisk));
    }

    const version = requestedVersion ?? (existingDisk ? existingDisk.version + 1 : 1);
    const disk: DiskSnapshot = { uri: options.uri, languageId, version, text };
    document.diskSnapshot = disk;
    document.languageId = languageId;
    document.version = version;
    document.text = text;

    if (!document.serverOpen) {
      document.serverOpen = true;
      this.sendUpstream({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: options.uri,
            languageId,
            version,
            text
          }
        }
      });
    } else {
      this.sendUpstream(didChange(options.uri, version, text));
    }

    const snapshot = toDiskSnapshot(disk);
    this.emitDocumentSnapshot(snapshot);
    return noopDiskUse('disk-cache', snapshot);
  }

  closeAllDocuments(): void {
    for (const document of this.documents.values()) {
      if (document.serverOpen) {
        this.sendUpstream(didClose(document.uri));
        this.emitDocumentSnapshot({ state: 'closed', uri: document.uri });
      }
    }
    this.documents.clear();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.closeAllDocuments();
    for (const consumer of [...this.consumers.values()]) {
      this.disposeConsumer(consumer);
    }
    this.options.session.dispose();
  }

  private handleConsumerMessage(consumer: ConsumerState, message: unknown): void {
    if (consumer.disposed) {
      if (isRecord(message) && isJsonRpcId(message.id) && typeof message.method !== 'string') {
        this.recordLateResponseDropped();
      }
      return;
    }
    if (!isRecord(message)) {
      return;
    }

    if (typeof message.method === 'string') {
      if (message.method === '$/cancelRequest') {
        this.handleConsumerCancel(consumer, message.params);
        return;
      }
      if (hasInvalidPresentId(message)) {
        consumer.onMessage(invalidJsonRpcId());
        return;
      }
      if (isJsonRpcId(message.id)) {
        this.handleClientRequest(consumer, message as Record<string, unknown> & { id: JsonRpcId; method: string });
        return;
      }
      this.handleClientNotification(consumer, message as Record<string, unknown> & { method: string });
      return;
    }

    if (isJsonRpcId(message.id)) {
      this.handleConsumerResponse(consumer, message as Record<string, unknown> & { id: JsonRpcId });
    }
  }

  private handleClientRequest(consumer: ConsumerState, message: Record<string, unknown> & { id: JsonRpcId; method: string }): void {
    const metric = this.requestMetric(consumer, message.method);
    const requestCap = this.tryReserveRequestCap(consumer.id, message.method);
    if (requestCap === 'rejected') {
      this.recordCancellation(metric);
      consumer.onMessage(requestCancelled(message.id, 'LSP request cap exceeded'));
      return;
    }

    const upstreamId = this.nextClientUpstreamId++;
    this.clientPendingByUpstream.set(idKey(upstreamId), {
      consumerId: consumer.id,
      downstreamId: message.id,
      method: message.method,
      metric,
      requestCap
    });
    this.clientPendingByConsumerDownstream.set(consumerIdKey(consumer.id, message.id), upstreamId);
    this.recordRequestStarted(metric);
    try {
      this.sendUpstream({ ...message, id: upstreamId });
    } catch (error) {
      this.clientPendingByUpstream.delete(idKey(upstreamId));
      this.clientPendingByConsumerDownstream.delete(consumerIdKey(consumer.id, message.id));
      this.releaseRequestCap(requestCap);
      this.recordRequestSettled(metric);
      throw error;
    }
  }

  private handleConsumerCancel(consumer: ConsumerState, params: unknown): void {
    if (!isRecord(params) || !isJsonRpcId(params.id)) {
      return;
    }
    const downstreamKey = consumerIdKey(consumer.id, params.id);
    const upstreamId = this.clientPendingByConsumerDownstream.get(downstreamKey);
    if (!isJsonRpcId(upstreamId)) {
      return;
    }
    const pending = this.clientPendingByUpstream.get(idKey(upstreamId));
    this.clientPendingByConsumerDownstream.delete(downstreamKey);
    this.clientPendingByUpstream.delete(idKey(upstreamId));
    if (pending) {
      this.releaseRequestCap(pending.requestCap);
      this.recordCancellation(pending.metric);
      this.recordRequestSettled(pending.metric);
    }
    this.sendUpstream({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: upstreamId } });
  }

  private handleConsumerResponse(consumer: ConsumerState, message: Record<string, unknown> & { id: JsonRpcId }): void {
    const downstreamKey = consumerIdKey(consumer.id, message.id);
    const upstreamId = this.serverPendingByConsumerDownstream.get(downstreamKey);
    if (!isJsonRpcId(upstreamId)) {
      this.recordLateResponseDropped();
      return;
    }
    const pending = this.serverPendingByUpstream.get(idKey(upstreamId));

    this.serverPendingByConsumerDownstream.delete(downstreamKey);
    this.serverPendingByUpstream.delete(idKey(upstreamId));
    if (pending) {
      this.releaseRequestCap(pending.requestCap);
      this.recordRequestSettled(pending.metric);
    }
    this.sendUpstream({ ...message, id: upstreamId });
  }

  private handleClientNotification(consumer: ConsumerState, message: Record<string, unknown> & { method: string }): void {
    if (message.method === 'textDocument/didOpen') {
      this.handleDidOpen(consumer, message);
      return;
    }
    if (message.method === 'textDocument/didChange') {
      this.handleDidChange(consumer, message);
      return;
    }
    if (message.method === 'textDocument/didClose') {
      this.handleDidClose(consumer, message);
      return;
    }
    this.sendUpstream(message);
  }

  private handleDidOpen(consumer: ConsumerState, message: Record<string, unknown>): void {
    const textDocument = readTextDocument(message.params);
    if (!textDocument?.uri || consumer.kind !== 'raw-editor') {
      this.sendUpstream(message);
      return;
    }

    const document = this.getOrCreateDocument(textDocument.uri);
    document.editorOwners.add(consumer.id);
    const text = textDocument.text ?? document.text;
    const languageId = textDocument.languageId ?? document.languageId;

    if (document.serverOpen) {
      const version = nextDocumentVersion(document, textDocument.version);
      document.languageId = languageId;
      document.version = version;
      document.text = text;
      this.emitDocumentSnapshot({
        state: 'editor-open',
        uri: textDocument.uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text
      });
      if (typeof textDocument.text === 'string') {
        this.sendUpstream(didChange(textDocument.uri, version, textDocument.text));
      }
      return;
    }

    document.languageId = languageId;
    document.version = textDocument.version ?? document.version;
    document.text = text;
    this.emitDocumentSnapshot({
      state: 'editor-open',
      uri: textDocument.uri,
      languageId: document.languageId,
      version: document.version,
      text: document.text
    });

    if (!document.serverOpen) {
      document.serverOpen = true;
      this.sendUpstream(message);
    }
  }

  private handleDidChange(consumer: ConsumerState, message: Record<string, unknown>): void {
    const change = readTextDocumentChange(message.params);
    if (!change?.uri || consumer.kind !== 'raw-editor') {
      this.sendUpstream(message);
      return;
    }
    const document = this.documents.get(change.uri);
    if (!document || !document.editorOwners.has(consumer.id)) {
      this.sendUpstream(message);
      return;
    }

    const version = nextDocumentVersion(document, change.version);
    const nextText = applyContentChanges(document.text, change.contentChanges);
    document.version = version;
    document.text = nextText ?? document.text;
    this.emitDocumentSnapshot({
      state: 'editor-open',
      uri: change.uri,
      languageId: document.languageId,
      version: document.version,
      text: document.text
    });
    this.sendUpstream(withDidChangeVersion(message, change.uri, version));
  }

  private handleDidClose(consumer: ConsumerState, message: Record<string, unknown>): void {
    const uri = readTextDocumentUri(message.params);
    if (!uri || consumer.kind !== 'raw-editor') {
      this.sendUpstream(message);
      return;
    }

    const document = this.documents.get(uri);
    if (!document) {
      return;
    }
    document.editorOwners.delete(consumer.id);
    this.maybeCloseDocument(document);
  }

  private useDiskDocument(consumer: ConsumerState, options: DiskDocumentUseOptions): DiskDocumentUse {
    if (consumer.disposed) {
      return noopDiskUse('disk-cache');
    }
    return this.syncDocumentForRequest({
      uri: options.uri,
      languageId: options.languageId,
      readDisk: () => ({ text: options.text, languageId: options.languageId, version: options.version })
    });
  }

  private handleServerMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }

    if (typeof message.method === 'string') {
      if (hasInvalidPresentId(message)) {
        this.sendUpstream(invalidJsonRpcId());
        return;
      }
      if (isJsonRpcId(message.id)) {
        this.handleServerRequest(message as Record<string, unknown> & { id: JsonRpcId; method: string });
        return;
      }
      this.handleServerNotification(message as Record<string, unknown> & { method: string });
      return;
    }
    if (isJsonRpcId(message.id)) {
      this.handleServerResponse(message as Record<string, unknown> & { id: JsonRpcId });
    }
  }

  private handleServerResponse(message: Record<string, unknown> & { id: JsonRpcId }): void {
    const pending = this.clientPendingByUpstream.get(idKey(message.id));
    if (!pending) {
      this.recordLateResponseDropped();
      return;
    }
    this.clientPendingByUpstream.delete(idKey(message.id));
    this.clientPendingByConsumerDownstream.delete(consumerIdKey(pending.consumerId, pending.downstreamId));
    this.releaseRequestCap(pending.requestCap);
    this.recordRequestSettled(pending.metric);

    const consumer = this.consumers.get(pending.consumerId);
    if (!consumer || consumer.disposed) {
      return;
    }
    consumer.onMessage({ ...message, id: pending.downstreamId });
  }

  private handleServerRequest(message: Record<string, unknown> & { id: JsonRpcId; method: string }): void {
    const handled = this.handleCustomServerRequest(message);
    if (handled) {
      return;
    }

    const editor = this.primaryEditor();
    if (!editor) {
      this.sendUpstream(methodNotFound(message.id, message.method));
      return;
    }

    const metric = this.requestMetric(editor, message.method);
    const requestCap = this.tryReserveRequestCap(editor.id, message.method);
    if (requestCap === 'rejected') {
      this.recordCancellation(metric);
      this.sendUpstream(requestCancelled(message.id, 'LSP request cap exceeded'));
      return;
    }

    const downstreamId = this.nextServerRequestDownstreamId(editor.id);
    this.serverPendingByUpstream.set(idKey(message.id), {
      consumerId: editor.id,
      downstreamId,
      upstreamId: message.id,
      method: message.method,
      metric,
      requestCap
    });
    this.serverPendingByConsumerDownstream.set(consumerIdKey(editor.id, downstreamId), message.id);
    this.recordRequestStarted(metric);
    try {
      editor.onMessage({ ...message, id: downstreamId });
    } catch (error) {
      this.serverPendingByUpstream.delete(idKey(message.id));
      this.serverPendingByConsumerDownstream.delete(consumerIdKey(editor.id, downstreamId));
      this.releaseRequestCap(requestCap);
      this.recordRequestSettled(metric);
      throw error;
    }
  }

  private handleCustomServerRequest(message: Record<string, unknown> & { id: JsonRpcId; method: string }): boolean {
    const handler = this.options.onServerRequest;
    if (!handler) {
      return false;
    }
    try {
      const result = handler({ id: message.id, method: message.method, params: message.params });
      if (!result.handled) {
        return false;
      }
      if (result.error) {
        this.sendUpstream({ jsonrpc: '2.0', id: message.id, error: result.error });
      } else {
        this.sendUpstream({ jsonrpc: '2.0', id: message.id, result: result.result ?? null });
      }
      return true;
    } catch {
      this.sendUpstream({ jsonrpc: '2.0', id: message.id, result: null });
      return true;
    }
  }

  private handleServerNotification(message: Record<string, unknown> & { method: string }): void {
    if (message.method === '$/progress') {
      const params = sanitizeProgressParams(message.params);
      if (!params) {
        return;
      }
      const notification = { jsonrpc: '2.0', method: '$/progress', params };
      this.options.onProgress?.({ method: '$/progress', params });
      for (const consumer of this.rawEditors()) {
        consumer.onMessage(notification);
      }
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics') {
      this.options.onDiagnostics?.({ method: 'textDocument/publishDiagnostics', params: message.params });
      const uri = readPublishDiagnosticsUri(message.params);
      if (!uri) {
        return;
      }
      for (const consumer of this.interestedEditors(uri)) {
        consumer.onMessage(message);
      }
      return;
    }

    if (message.method.startsWith('textDocument/')) {
      const uri = readTextDocumentUri(message.params);
      if (!uri) {
        return;
      }
      for (const consumer of this.interestedEditors(uri)) {
        consumer.onMessage(message);
      }
    }
  }

  private disposeConsumer(consumer: ConsumerState): void {
    if (consumer.disposed) {
      return;
    }
    consumer.disposed = true;
    this.consumers.delete(consumer.id);

    for (const [upstreamKey, pending] of [...this.clientPendingByUpstream.entries()]) {
      if (pending.consumerId !== consumer.id) {
        continue;
      }
      this.clientPendingByUpstream.delete(upstreamKey);
      this.clientPendingByConsumerDownstream.delete(consumerIdKey(consumer.id, pending.downstreamId));
      this.releaseRequestCap(pending.requestCap);
      this.recordRequestSettled(pending.metric);
    }

    for (const [upstreamKey, pending] of [...this.serverPendingByUpstream.entries()]) {
      if (pending.consumerId !== consumer.id) {
        continue;
      }
      this.serverPendingByUpstream.delete(upstreamKey);
      this.serverPendingByConsumerDownstream.delete(consumerIdKey(consumer.id, pending.downstreamId));
      this.releaseRequestCap(pending.requestCap);
      this.recordRequestSettled(pending.metric);
      this.sendUpstream({
        jsonrpc: '2.0',
        id: pending.upstreamId,
        error: { code: REQUEST_CANCELLED, message: 'client disconnected' }
      });
    }

    if (consumer.kind === 'raw-editor') {
      for (const document of this.documents.values()) {
        if (!document.editorOwners.delete(consumer.id)) {
          continue;
        }
        this.maybeCloseDocument(document);
      }
    }
  }

  private getOrCreateDocument(uri: string): DocumentState {
    const existing = this.documents.get(uri);
    if (existing) {
      return existing;
    }
    const document: DocumentState = {
      uri,
      editorOwners: new Set(),
      diskSnapshot: undefined,
      serverOpen: false,
      languageId: '',
      version: 0,
      text: ''
    };
    this.documents.set(uri, document);
    return document;
  }

  private maybeCloseDocument(document: DocumentState): void {
    if (!document.serverOpen || document.editorOwners.size > 0) {
      return;
    }
    if (document.diskSnapshot) {
      document.diskSnapshot = {
        ...document.diskSnapshot,
        version: Math.max(document.version + 1, document.diskSnapshot.version)
      };
      document.languageId = document.diskSnapshot.languageId;
      document.version = document.diskSnapshot.version;
      document.text = document.diskSnapshot.text;
      this.sendUpstream(didChange(document.uri, document.version, document.text));
      this.emitDocumentSnapshot(toDiskSnapshot(document.diskSnapshot));
      return;
    }
    document.serverOpen = false;
    this.sendUpstream(didClose(document.uri));
    this.emitDocumentSnapshot({ state: 'closed', uri: document.uri });
  }

  private interestedEditors(uri: string): ConsumerState[] {
    const document = this.documents.get(uri);
    if (!document) {
      return [];
    }
    return [...document.editorOwners]
      .map((consumerId) => this.consumers.get(consumerId))
      .filter((consumer): consumer is ConsumerState => Boolean(consumer && !consumer.disposed && consumer.kind === 'raw-editor'));
  }

  private primaryEditor(): ConsumerState | undefined {
    for (const consumerId of this.editorAttachOrder) {
      const consumer = this.consumers.get(consumerId);
      if (consumer && !consumer.disposed && consumer.kind === 'raw-editor') {
        return consumer;
      }
    }
    return undefined;
  }

  private rawEditors(): ConsumerState[] {
    return [...this.editorAttachOrder]
      .map((consumerId) => this.consumers.get(consumerId))
      .filter((consumer): consumer is ConsumerState => Boolean(consumer && !consumer.disposed && consumer.kind === 'raw-editor'));
  }

  private nextServerRequestDownstreamId(consumerId: string): string {
    while (true) {
      const id = `mplex:${this.nextServerDownstreamId++}`;
      const key = consumerIdKey(consumerId, id);
      if (!this.clientPendingByConsumerDownstream.has(key) && !this.serverPendingByConsumerDownstream.has(key)) {
        return id;
      }
    }
  }

  private sendUpstream(message: unknown): void {
    try {
      this.options.session.sendClientMessage(message);
    } catch (error) {
      this.recordWriterError();
      throw error;
    }
  }

  private tryReserveRequestCap(consumerId: string, method: string): RequestCapAccount | 'rejected' | undefined {
    if (this.requestCaps.excludedMethods.has(method)) {
      return undefined;
    }

    const consumerPending = this.cappedPendingByConsumer.get(consumerId) ?? 0;
    const methodPending = this.cappedPendingByMethod.get(method) ?? 0;
    if (
      consumerPending >= this.requestCaps.maxPendingPerConsumer ||
      methodPending >= this.requestCaps.maxPendingPerMethod
    ) {
      return 'rejected';
    }

    increment(this.cappedPendingByConsumer, consumerId, 1);
    increment(this.cappedPendingByMethod, method, 1);
    return { consumerId, method };
  }

  private releaseRequestCap(account: RequestCapAccount | undefined): void {
    if (!account) {
      return;
    }
    increment(this.cappedPendingByConsumer, account.consumerId, -1);
    increment(this.cappedPendingByMethod, account.method, -1);
  }

  private emitDocumentSnapshot(snapshot: RawDocumentSnapshot): void {
    this.options.onDocumentSnapshot?.(snapshot);
  }

  private requestMetric(consumer: ConsumerState, method: string): LspRequestMetricDimensions {
    const sessionId = this.options.sessionId ?? 'unknown-session';
    return {
      sessionId,
      consumerId: `${sessionId}/${consumer.id}`,
      method
    };
  }

  private recordRequestStarted(metric: LspRequestMetricDimensions): void {
    if (isLspRequestMetricsEnabled(this.options.requestMetrics)) {
      this.options.requestMetrics.requestStarted(metric);
    }
  }

  private recordRequestSettled(metric: LspRequestMetricDimensions): void {
    if (isLspRequestMetricsEnabled(this.options.requestMetrics)) {
      this.options.requestMetrics.requestSettled(metric);
    }
  }

  private recordCancellation(metric: LspRequestMetricDimensions): void {
    if (isLspRequestMetricsEnabled(this.options.requestMetrics)) {
      this.options.requestMetrics.requestCanceled(metric);
    }
  }

  private recordLateResponseDropped(): void {
    if (isLspRequestMetricsEnabled(this.options.requestMetrics)) {
      this.options.requestMetrics.lateResponseDropped({ sessionId: this.options.sessionId ?? 'unknown-session' });
    }
  }

  private recordWriterError(): void {
    if (isLspRequestMetricsEnabled(this.options.requestMetrics)) {
      this.options.requestMetrics.writerError({ sessionId: this.options.sessionId });
    }
  }

  private editorSnapshot(document: DocumentState): Extract<RawDocumentSnapshot, { state: 'editor-open' }> | undefined {
    if (document.editorOwners.size === 0) {
      return undefined;
    }
    return {
      state: 'editor-open',
      uri: document.uri,
      languageId: document.languageId,
      version: document.version,
      text: document.text
    };
  }
}

function noopDiskUse(source: DiskDocumentUse['source'], snapshot?: DiskDocumentUse['snapshot']): DiskDocumentUse {
  return {
    source,
    ...(snapshot ? { snapshot } : {}),
    release() {
      return;
    }
  };
}

function nextDocumentVersion(document: DocumentState, requestedVersion: number | undefined): number {
  return Math.max(document.version + 1, requestedVersion ?? 0);
}

function toDiskSnapshot(snapshot: DiskSnapshot): Extract<RawDocumentSnapshot, { state: 'disk-cached' }> {
  return {
    state: 'disk-cached',
    uri: snapshot.uri,
    languageId: snapshot.languageId,
    version: snapshot.version,
    text: snapshot.text
  };
}

function methodNotFound(id: JsonRpcId, method: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: METHOD_NOT_FOUND, message: `unhandled request: ${method}` }
  };
}

function invalidJsonRpcId(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: null,
    error: { code: INVALID_REQUEST, message: 'invalid JSON-RPC id' }
  };
}

function requestCancelled(id: JsonRpcId, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: REQUEST_CANCELLED, message }
  };
}

function didChange(uri: string, version: number, text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    }
  };
}

function withDidChangeVersion(message: Record<string, unknown>, uri: string, version: number): Record<string, unknown> {
  const params = isRecord(message.params) ? message.params : {};
  const textDocument = isRecord(params.textDocument) ? params.textDocument : {};
  return {
    ...message,
    params: {
      ...params,
      textDocument: { ...textDocument, uri, version }
    }
  };
}

function didClose(uri: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri } }
  };
}

function applyContentChanges(text: string, changes: LspContentChange[] | undefined): string | undefined {
  if (!changes) {
    return undefined;
  }
  let next = text;
  for (const change of changes) {
    if (!change.range) {
      next = change.text;
      continue;
    }
    const start = offsetAt(next, change.range.start);
    const end = offsetAt(next, change.range.end);
    if (start === undefined || end === undefined || end < start) {
      return undefined;
    }
    next = `${next.slice(0, start)}${change.text}${next.slice(end)}`;
  }
  return next;
}

function offsetAt(text: string, position: LspPosition): number | undefined {
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const nextBreak = text.indexOf('\n', lineStart);
    if (nextBreak === -1) {
      return undefined;
    }
    lineStart = nextBreak + 1;
    line += 1;
  }
  const lineBreak = text.indexOf('\n', lineStart);
  const lineEnd = lineBreak === -1 ? text.length : lineBreak;
  const offset = lineStart + position.character;
  return offset <= lineEnd ? offset : undefined;
}

function readTextDocument(params: unknown):
  | { uri: string; languageId?: string; version?: number; text?: string }
  | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return undefined;
  }
  return {
    uri: params.textDocument.uri,
    ...(typeof params.textDocument.languageId === 'string' ? { languageId: params.textDocument.languageId } : {}),
    ...(typeof params.textDocument.version === 'number' ? { version: params.textDocument.version } : {}),
    ...(typeof params.textDocument.text === 'string' ? { text: params.textDocument.text } : {})
  };
}

function readTextDocumentChange(
  params: unknown
): { uri: string; version?: number; contentChanges?: LspContentChange[] } | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return undefined;
  }
  return {
    uri: params.textDocument.uri,
    ...(typeof params.textDocument.version === 'number' ? { version: params.textDocument.version } : {}),
    ...(Array.isArray(params.contentChanges) ? { contentChanges: readContentChanges(params.contentChanges) } : {})
  };
}

function readContentChanges(changes: unknown[]): LspContentChange[] | undefined {
  const parsed: LspContentChange[] = [];
  for (const change of changes) {
    if (!isRecord(change) || typeof change.text !== 'string') {
      return undefined;
    }
    const parsedChange: LspContentChange = { text: change.text };
    if (change.range !== undefined) {
      const range = readRange(change.range);
      if (!range) {
        return undefined;
      }
      parsedChange.range = range;
    }
    parsed.push(parsedChange);
  }
  return parsed;
}

function readRange(value: unknown): LspRange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = readPosition(value.start);
  const end = readPosition(value.end);
  if (!start || !end) {
    return undefined;
  }
  return { start, end };
}

function readPosition(value: unknown): LspPosition | undefined {
  if (!isRecord(value) || typeof value.line !== 'number' || typeof value.character !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(value.line) || !Number.isInteger(value.character) || value.line < 0 || value.character < 0) {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

function readTextDocumentUri(params: unknown): string | undefined {
  return readTextDocument(params)?.uri;
}

function readPublishDiagnosticsUri(params: unknown): string | undefined {
  return isRecord(params) && typeof params.uri === 'string' ? params.uri : undefined;
}

function consumerIdKey(consumerId: string, id: JsonRpcId): string {
  return `${consumerId}\u0000${idKey(id)}`;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function hasInvalidPresentId(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'id') && !isJsonRpcId(value.id);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeProgressParams(params: unknown): LspProgressParams | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const token = params.token;
  if (typeof token !== 'string' && typeof token !== 'number') {
    return undefined;
  }
  const value: LspProgressParams['value'] = {};
  if (isRecord(params.value)) {
    if (typeof params.value.kind === 'string') {
      value.kind = params.value.kind;
    }
    if (typeof params.value.title === 'string') {
      value.title = params.value.title;
    }
    if (typeof params.value.message === 'string') {
      value.message = params.value.message;
    }
    if (typeof params.value.percentage === 'number' && Number.isFinite(params.value.percentage)) {
      value.percentage = params.value.percentage;
    }
  }
  return { token, value };
}

function normalizeRequestCaps(options: RawSessionRequestCapsOptions | undefined): NormalizedRequestCaps {
  return {
    maxPendingPerConsumer: normalizeCap(options?.maxPendingPerConsumer, DEFAULT_MAX_PENDING_PER_CONSUMER),
    maxPendingPerMethod: normalizeCap(options?.maxPendingPerMethod, DEFAULT_MAX_PENDING_PER_METHOD),
    excludedMethods: new Set([...(REQUEST_CAP_EXCLUDED_METHODS as readonly string[]), ...(options?.excludedMethods ?? [])])
  };
}

function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function increment(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) {
    map.delete(key);
    return;
  }
  map.set(key, next);
}
