import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LspDiagnosticsStore, sanitizeLspDiagnostics, type LspDiagnostic } from './diagnosticsStore.js';
import { LspDocumentStore } from './documentStore.js';
import {
  LspSessionPool,
  type LspFileOperationRegistrationEvent,
  type LspDocumentSnapshotEvent,
  type LspSendRequestOptions,
  type LspServerNotification,
  type LspSessionExitEvent,
  type LspSessionStartOptions
} from './sessionPool.js';
import type { AttachRawSessionConsumerOptions, RawDocumentSnapshot, RawSessionConsumer } from './rawSessionMultiplexer.js';
import {
  mergeFileOperationCapabilities,
  type FileOperationRegistration
} from './fileOperationRegistrations.js';

export interface LspServerStartOptions {
  serverConfigId: string;
  workspaceRoot: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  startupTimeoutMs?: number;
}

export interface LspManagerOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  documentStore?: LspDocumentStore;
  diagnosticsStore?: LspDiagnosticsStore;
  restartPolicy?: LspRestartPolicyOptions;
}

export interface LspRestartPolicyOptions {
  enabled?: boolean;
  maxRestarts?: number;
  windowMs?: number;
}

export interface LspServerKey {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface LspServerLease {
  key: LspServerKey;
  capabilities: Record<string, unknown>;
  release(): void;
}

export interface LspRawConsumerLease extends LspServerLease {
  consumer: RawSessionConsumer;
}

export interface LspManagerSendRequestOptions extends LspSendRequestOptions {
  languageId?: string;
}

export interface LspAcquireOptions {
  maxSessions?: number;
  manualRestart?: boolean;
}

export interface LspFileOperationNotificationInput {
  workspaceRoot: string;
  method: 'workspace/didCreateFiles' | 'workspace/didRenameFiles' | 'workspace/didDeleteFiles';
  params: { files: Array<{ uri: string } | { oldUri: string; newUri: string }> };
  matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
}

export interface LspFileOperationRequestInput {
  workspaceRoot: string;
  method: 'workspace/willRenameFiles';
  params: { files: Array<{ oldUri: string; newUri: string }> };
  matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
  timeoutMs: number;
}

export interface LspFileOperationRequestResult {
  sessionId: string;
  result: unknown;
}

export type LspPullDiagnosticsStatus = 'updated' | 'unchanged' | 'not_running' | 'unsupported' | 'failed';

export interface LspPullDiagnosticsInput {
  workspaceRoot: string;
  serverConfigId: string;
  uri: string;
  languageId?: string;
  timeoutMs?: number;
}

export interface LspPullDiagnosticsResult {
  status: LspPullDiagnosticsStatus;
  diagnostics: LspDiagnostic[];
}

export interface LspManagedSessionExitEvent {
  key: LspServerKey;
  sessionId: string;
  code: number | null;
  signal: string | null;
  reason: 'natural' | 'stopped';
  restart?: {
    state: 'restarting' | 'stopped';
    attempt: number;
    maxAttempts: number;
  };
}

export interface LspManagedSessionProgressEvent {
  key: LspServerKey;
  sessionId: string;
  params: unknown;
}

interface ManagedSession {
  key: LspServerKey;
  keyString: string;
  sessionId: string;
  startOptions: LspSessionStartOptions;
  maxSessions: number | undefined;
  refCount: number;
  capabilities: Record<string, unknown>;
  fileOperationRegistrations: Map<string, FileOperationRegistration>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  releaseCapacity: () => void;
  state: 'ready' | 'restarting' | 'stopped';
  restartTimestamps: number[];
  restartPromise: Promise<void> | undefined;
}

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PULL_DIAGNOSTICS_TIMEOUT_MS = 1_000;
const DEFAULT_RESTART_MAX_RESTARTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 180_000;

export class LspManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly starting = new Map<string, Promise<ManagedSession>>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly documentStore: LspDocumentStore;
  private readonly diagnosticsStore: LspDiagnosticsStore;
  private readonly restartPolicy: Required<LspRestartPolicyOptions>;
  private readonly exitListeners: Array<(event: LspManagedSessionExitEvent) => void> = [];
  private readonly progressListeners: Array<(event: LspManagedSessionProgressEvent) => void> = [];
  private activeReservations = 0;

  constructor(private readonly sessionPool = new LspSessionPool(), options: LspManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.documentStore = options.documentStore ?? new LspDocumentStore();
    this.diagnosticsStore = options.diagnosticsStore ?? new LspDiagnosticsStore();
    this.restartPolicy = {
      enabled: options.restartPolicy?.enabled ?? true,
      maxRestarts: options.restartPolicy?.maxRestarts ?? DEFAULT_RESTART_MAX_RESTARTS,
      windowMs: options.restartPolicy?.windowMs ?? DEFAULT_RESTART_WINDOW_MS
    };
    this.sessionPool.onSessionExit((event) => this.handleSessionExit(event));
    this.sessionPool.onServerNotification((notification) => this.handleServerNotification(notification));
    this.sessionPool.onDocumentSnapshot((event) => this.handleDocumentSnapshot(event));
    this.sessionPool.onFileOperationRegistration((event) => this.handleFileOperationRegistration(event));
  }

  async startServer(options: LspServerStartOptions): Promise<void> {
    const lease = await this.acquireServer(options);
    lease.release();
  }

  async acquireServer(options: LspServerStartOptions, acquireOptions: LspAcquireOptions = {}): Promise<LspServerLease> {
    const key = {
      serverConfigId: options.serverConfigId,
      workspaceRoot: realpathSync(options.workspaceRoot)
    };
    const keyString = sessionKey(key);
    const existing = this.sessions.get(keyString);
    if (existing) {
      if (existing.state === 'stopped') {
        if (!acquireOptions.manualRestart) {
          throw new Error(`LSP server is stopped and requires manual restart: ${options.serverConfigId} ${key.workspaceRoot}`);
        }
        existing.restartTimestamps = [];
        await this.restartManagedSession(existing);
      } else if (existing.state === 'restarting') {
        if (!existing.restartPromise) {
          throw new Error(`LSP server restart is unavailable: ${options.serverConfigId} ${key.workspaceRoot}`);
        }
        await existing.restartPromise;
        if ((existing as { state: ManagedSession['state'] }).state === 'stopped') {
          throw new Error(`LSP server is stopped and requires manual restart: ${options.serverConfigId} ${key.workspaceRoot}`);
        }
      }
      return this.acquireManagedSession(existing);
    }

    const starting = this.starting.get(keyString);
    if (starting) {
      const managed = await starting;
      if (this.sessions.get(keyString) !== managed) {
        return this.acquireServer(options);
      }
      return this.acquireManagedSession(managed);
    }

    const start = this.startManagedSession(options, key, keyString, acquireOptions);
    this.starting.set(keyString, start);
    try {
      const managed = await start;
      return this.createLease(managed);
    } finally {
      if (this.starting.get(keyString) === start) {
        this.starting.delete(keyString);
      }
    }
  }

  async sendRequest(
    key: LspServerKey,
    method: string,
    params: unknown,
    options: LspManagerSendRequestOptions = {}
  ): Promise<unknown> {
    const managed = this.getManagedSession(key);
    this.syncDocumentForRequest(managed, params, options.languageId);
    return this.sessionPool.sendRequest(managed.sessionId, method, params, options);
  }

  getCapabilities(key: LspServerKey): Record<string, unknown> | undefined {
    return this.getManagedSession(key).capabilities;
  }

  async acquireRawConsumer(
    options: LspServerStartOptions,
    consumerOptions: AttachRawSessionConsumerOptions,
    acquireOptions: LspAcquireOptions = {}
  ): Promise<LspRawConsumerLease> {
    const lease = await this.acquireServer(options, acquireOptions);
    try {
      const managed = this.getManagedSession(lease.key);
      const consumer = this.sessionPool.attachRawConsumer(managed.sessionId, consumerOptions);
      let released = false;
      return {
        key: lease.key,
        capabilities: lease.capabilities,
        consumer,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          consumer.dispose();
          lease.release();
        }
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    for (const managed of [...this.sessions.values()]) {
      await this.stopManagedSession(managed);
    }
  }

  getDiagnostics(options: { workspaceRoot: string; uri: string }): { diagnostics: LspDiagnostic[] } {
    return { diagnostics: this.diagnosticsStore.getMergedDiagnostics(options.uri).diagnostics };
  }

  async pullDiagnosticsForRunningSession(input: LspPullDiagnosticsInput): Promise<LspPullDiagnosticsResult> {
    const cached = () => this.getDiagnostics({ workspaceRoot: input.workspaceRoot, uri: input.uri }).diagnostics;
    let workspaceRoot: string;
    try {
      workspaceRoot = realpathSync(input.workspaceRoot);
    } catch {
      return { status: 'failed', diagnostics: cached() };
    }

    const managed = this.sessions.get(sessionKey({ serverConfigId: input.serverConfigId, workspaceRoot }));
    if (!managed || managed.state !== 'ready') {
      return { status: 'not_running', diagnostics: cached() };
    }
    if (!hasDiagnosticProvider(managed.capabilities)) {
      return { status: 'unsupported', diagnostics: cached() };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, input.timeoutMs ?? DEFAULT_PULL_DIAGNOSTICS_TIMEOUT_MS)
    );
    timeout.unref?.();

    try {
      const params = { textDocument: { uri: input.uri } };
      this.syncDocumentForRequest(managed, params, input.languageId);
      const result = await this.sessionPool.sendRequest(managed.sessionId, 'textDocument/diagnostic', params, {
        signal: controller.signal
      });
      const parsed = parsePullDiagnosticsResult(result);
      if (!parsed) {
        return { status: 'failed', diagnostics: cached() };
      }
      if (parsed.kind === 'unchanged') {
        return { status: 'unchanged', diagnostics: cached() };
      }
      const diagnostics = sanitizeLspDiagnostics(parsed.items);
      if (parsed.items.length > 0 && diagnostics.length === 0) {
        return { status: 'failed', diagnostics: cached() };
      }
      this.diagnosticsStore.setDiagnostics({
        uri: input.uri,
        serverId: managed.sessionId,
        diagnostics
      });
      return { status: 'updated', diagnostics: cached() };
    } catch {
      return { status: 'failed', diagnostics: cached() };
    } finally {
      clearTimeout(timeout);
    }
  }

  onManagedSessionExit(listener: (event: LspManagedSessionExitEvent) => void): void {
    this.exitListeners.push(listener);
  }

  onManagedSessionProgress(listener: (event: LspManagedSessionProgressEvent) => void): void {
    this.progressListeners.push(listener);
  }

  async notifyRunningSessionsForWorkspaceFileOperation(input: LspFileOperationNotificationInput): Promise<number> {
    const workspaceRoot = realpathSync(input.workspaceRoot);
    let notified = 0;
    for (const managed of this.sessions.values()) {
      if (managed.state !== 'ready') {
        continue;
      }
      if (managed.key.workspaceRoot !== workspaceRoot) {
        continue;
      }
      if (!input.matchesCapabilities(this.effectiveFileOperationCapabilities(managed))) {
        continue;
      }
      this.sessionPool.notify(managed.sessionId, input.method, input.params);
      notified += 1;
    }
    return notified;
  }

  hasRunningSessionForWorkspaceFileOperation(workspaceRoot: string): boolean {
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    return [...this.sessions.values()].some(
      (managed) => managed.state === 'ready' && managed.key.workspaceRoot === realWorkspaceRoot
    );
  }

  async requestRunningSessionsForWorkspaceFileOperation(
    input: LspFileOperationRequestInput
  ): Promise<LspFileOperationRequestResult[]> {
    const workspaceRoot = realpathSync(input.workspaceRoot);
    const eligible = [...this.sessions.values()].filter(
      (managed) =>
        managed.state === 'ready' &&
        managed.key.workspaceRoot === workspaceRoot && input.matchesCapabilities(this.effectiveFileOperationCapabilities(managed))
    );
    if (eligible.length === 0) {
      return [];
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
    timeout.unref?.();
    try {
      return await Promise.all(
        eligible.map(async (managed) => ({
          sessionId: managed.sessionId,
          result: await this.sessionPool.sendRequest(managed.sessionId, input.method, input.params, {
            signal: controller.signal
          })
        }))
      );
    } catch {
      throw new Error('LSP file operation request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private createLease(managed: ManagedSession): LspServerLease {
    let released = false;
    return {
      key: managed.key,
      capabilities: managed.capabilities,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.releaseLease(managed);
      }
    };
  }

  private acquireManagedSession(managed: ManagedSession): LspServerLease {
    managed.refCount += 1;
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = undefined;
    }
    return this.createLease(managed);
  }

  private async startManagedSession(
    options: LspServerStartOptions,
    key: LspServerKey,
    keyString: string,
    acquireOptions: LspAcquireOptions
  ): Promise<ManagedSession> {
    const releaseCapacity = this.reserveCapacity(acquireOptions.maxSessions);
    try {
      const sessionId = keyString;
      const startOptions = {
        id: sessionId,
        command: options.command,
        args: options.args,
        env: options.env,
        workspaceRoot: key.workspaceRoot,
        initializationOptions: options.initializationOptions,
        startupTimeoutMs: options.startupTimeoutMs
      } satisfies LspSessionStartOptions;
      const snapshot = await this.sessionPool.start(startOptions);
      const managed: ManagedSession = {
        key,
        keyString,
        sessionId,
        startOptions,
        maxSessions: acquireOptions.maxSessions,
        refCount: 1,
        capabilities: snapshot.capabilities,
        fileOperationRegistrations: new Map(),
        idleTimer: undefined,
        releaseCapacity,
        state: 'ready',
        restartTimestamps: [],
        restartPromise: undefined
      };
      this.sessions.set(keyString, managed);
      return managed;
    } catch (error) {
      releaseCapacity();
      throw error;
    }
  }

  private releaseLease(managed: ManagedSession): void {
    if (this.sessions.get(managed.keyString) !== managed) {
      return;
    }
    managed.refCount = Math.max(0, managed.refCount - 1);
    if (managed.refCount === 0 && managed.state === 'stopped') {
      this.sessions.delete(managed.keyString);
      return;
    }
    if (managed.state !== 'ready') {
      return;
    }
    if (managed.refCount > 0 || managed.idleTimer) {
      return;
    }
    managed.idleTimer = setTimeout(() => {
      void this.stopManagedSession(managed);
    }, this.idleTimeoutMs);
    managed.idleTimer.unref?.();
  }

  private async stopManagedSession(managed: ManagedSession): Promise<void> {
    if (this.sessions.get(managed.keyString) !== managed) {
      return;
    }
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = undefined;
    }
    if (managed.state === 'restarting') {
      await managed.restartPromise;
    }
    if (managed.state === 'stopped') {
      this.sessions.delete(managed.keyString);
      return;
    }
    this.diagnosticsStore.clearServerDiagnostics(managed.sessionId);
    await this.sessionPool.stop(managed.sessionId);
    if (this.sessions.get(managed.keyString) === managed) {
      this.sessions.delete(managed.keyString);
      this.releaseManagedCapacity(managed);
    }
  }

  private handleSessionExit(event: LspSessionExitEvent): void {
    const managed = [...this.sessions.values()].find((candidate) => candidate.sessionId === event.sessionId);
    if (!managed) {
      return;
    }
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = undefined;
    }
    this.diagnosticsStore.clearServerDiagnostics(managed.sessionId);
    this.releaseManagedCapacity(managed);
    const restart = this.planRestart(managed, event);
    let restartPromise: Promise<void> | undefined;
    if (!restart) {
      this.sessions.delete(managed.keyString);
    } else if (restart.state === 'restarting') {
      managed.state = 'restarting';
      managed.fileOperationRegistrations.clear();
      restartPromise = this.restartManagedSession(managed);
    } else {
      managed.state = 'stopped';
      managed.fileOperationRegistrations.clear();
    }
    for (const listener of this.exitListeners) {
      listener({
        key: managed.key,
        sessionId: managed.sessionId,
        code: event.code,
        signal: event.signal,
        reason: event.reason,
        ...(restart ? { restart } : {})
      });
    }
    if (restartPromise) {
      void restartPromise.catch(() => undefined);
    }
  }

  private planRestart(
    managed: ManagedSession,
    event: LspSessionExitEvent
  ): LspManagedSessionExitEvent['restart'] | undefined {
    if (!this.restartPolicy.enabled || event.reason !== 'natural' || managed.refCount <= 0) {
      return undefined;
    }
    const now = Date.now();
    managed.restartTimestamps = managed.restartTimestamps.filter((timestamp) => now - timestamp <= this.restartPolicy.windowMs);
    managed.restartTimestamps.push(now);
    const attempt = managed.restartTimestamps.length;
    if (attempt > this.restartPolicy.maxRestarts) {
      return {
        state: 'stopped',
        attempt,
        maxAttempts: this.restartPolicy.maxRestarts
      };
    }
    return {
      state: 'restarting',
      attempt,
      maxAttempts: this.restartPolicy.maxRestarts
    };
  }

  private async restartManagedSession(managed: ManagedSession): Promise<void> {
    if (this.sessions.get(managed.keyString) !== managed) {
      return;
    }
    managed.state = 'restarting';
    const restart = (async () => {
      const releaseCapacity = this.reserveCapacity(managed.maxSessions);
      try {
        const snapshot = await this.sessionPool.start(managed.startOptions);
        managed.sessionId = snapshot.id;
        managed.capabilities = snapshot.capabilities;
        managed.fileOperationRegistrations.clear();
        managed.releaseCapacity = releaseCapacity;
        managed.state = 'ready';
      } catch (error) {
        releaseCapacity();
        managed.state = 'stopped';
        throw error;
      } finally {
        managed.restartPromise = undefined;
      }
    })();
    managed.restartPromise = restart;
    await restart;
  }

  private releaseManagedCapacity(managed: ManagedSession): void {
    managed.releaseCapacity();
    managed.releaseCapacity = () => undefined;
  }

  private handleServerNotification(notification: LspServerNotification): void {
    const managed = [...this.sessions.values()].find((candidate) => candidate.sessionId === notification.sessionId);
    if (!managed) {
      return;
    }
    if (notification.method === 'textDocument/publishDiagnostics') {
      this.ingestPublishDiagnostics(managed, notification.params);
      return;
    }
    if (notification.method === '$/progress') {
      for (const listener of this.progressListeners) {
        listener({ key: managed.key, sessionId: managed.sessionId, params: notification.params });
      }
    }
  }

  private handleDocumentSnapshot(event: LspDocumentSnapshotEvent): void {
    const managed = [...this.sessions.values()].find((candidate) => candidate.sessionId === event.sessionId);
    if (!managed) {
      return;
    }
    this.applyDocumentSnapshot(managed, event.snapshot);
  }

  private handleFileOperationRegistration(event: LspFileOperationRegistrationEvent): void {
    const managed = [...this.sessions.values()].find((candidate) => candidate.sessionId === event.sessionId);
    if (!managed) {
      return;
    }
    if (event.action === 'clear') {
      managed.fileOperationRegistrations.clear();
      return;
    }
    for (const registration of event.registrations) {
      const key = dynamicRegistrationKey(registration);
      if (event.action === 'register') {
        managed.fileOperationRegistrations.set(key, registration);
      } else {
        managed.fileOperationRegistrations.delete(key);
      }
    }
  }

  private applyDocumentSnapshot(managed: ManagedSession, snapshot: RawDocumentSnapshot): void {
    if (snapshot.state === 'editor-open') {
      this.documentStore.openEditorDocument({
        workspaceRoot: managed.key.workspaceRoot,
        uri: snapshot.uri,
        languageId: snapshot.languageId,
        version: snapshot.version,
        text: snapshot.text
      });
      return;
    }
    if (snapshot.state === 'disk-cached') {
      this.documentStore.cacheDiskDocument({
        workspaceRoot: managed.key.workspaceRoot,
        uri: snapshot.uri,
        languageId: snapshot.languageId,
        version: snapshot.version,
        text: snapshot.text
      });
      return;
    }
    this.documentStore.closeDocument({ workspaceRoot: managed.key.workspaceRoot, uri: snapshot.uri });
  }

  private ingestPublishDiagnostics(managed: ManagedSession, params: unknown): void {
    const parsed = parsePublishDiagnostics(params);
    if (!parsed) {
      return;
    }
    const snapshot = this.documentStore.getSnapshot({ workspaceRoot: managed.key.workspaceRoot, uri: parsed.uri });
    if (isStalePublish(parsed.version, snapshot?.version)) {
      return;
    }
    if (parsed.diagnostics.length === 0) {
      this.diagnosticsStore.clearDiagnostics({ uri: parsed.uri, serverId: managed.sessionId });
      return;
    }
    this.diagnosticsStore.setDiagnostics({
      uri: parsed.uri,
      serverId: managed.sessionId,
      diagnostics: parsed.diagnostics,
      version: parsed.version,
      currentDocumentVersion: snapshot?.version
    });
  }

  private reserveCapacity(maxSessions = this.maxSessions): () => void {
    if (this.activeReservations >= maxSessions) {
      throw new Error('LSP session capacity exceeded');
    }
    this.activeReservations += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeReservations -= 1;
    };
  }

  private getManagedSession(key: LspServerKey): ManagedSession {
    const managed = this.sessions.get(sessionKey({ ...key, workspaceRoot: realpathSync(key.workspaceRoot) }));
    if (!managed) {
      throw new Error(`LSP server is not started: ${key.serverConfigId} ${key.workspaceRoot}`);
    }
    if (managed.state !== 'ready') {
      throw new Error(`LSP server is ${managed.state}: ${key.serverConfigId} ${key.workspaceRoot}`);
    }
    return managed;
  }

  private effectiveFileOperationCapabilities(managed: ManagedSession): Record<string, unknown> {
    return mergeFileOperationCapabilities(managed.capabilities, managed.fileOperationRegistrations.values());
  }

  private syncDocumentForRequest(managed: ManagedSession, params: unknown, languageId: string | undefined): void {
    const uri = readTextDocumentUri(params);
    if (!uri) {
      return;
    }
    this.sessionPool.syncDocumentForRequest(managed.sessionId, {
      uri,
      languageId: languageId ?? '',
      readDisk: () => ({ text: readFileSync(fileURLToPath(uri), 'utf8') })
    });
  }
}

function readTextDocumentUri(params: unknown): string | undefined {
  if (
    typeof params === 'object' &&
    params !== null &&
    typeof (params as { textDocument?: { uri?: unknown } }).textDocument?.uri === 'string' &&
    (params as { textDocument: { uri: string } }).textDocument.uri.startsWith('file://')
  ) {
    return (params as { textDocument: { uri: string } }).textDocument.uri;
  }
  return undefined;
}

function sessionKey(key: LspServerKey): string {
  return `${key.serverConfigId}\u0000${realpathSync(key.workspaceRoot)}`;
}

function dynamicRegistrationKey(registration: FileOperationRegistration): string {
  return `${registration.method}\u0000${registration.id}`;
}

function parsePublishDiagnostics(
  params: unknown
): { uri: string; diagnostics: LspDiagnostic[]; version?: number } | undefined {
  if (!isRecord(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) {
    return undefined;
  }
  const diagnostics = sanitizeLspDiagnostics(params.diagnostics);
  if (params.diagnostics.length > 0 && diagnostics.length === 0) {
    return undefined;
  }
  return {
    uri: params.uri,
    diagnostics,
    ...(typeof params.version === 'number' ? { version: params.version } : {})
  };
}

type PullDiagnosticReport = { kind: 'full'; items: unknown[] } | { kind: 'unchanged' };

function parsePullDiagnosticsResult(result: unknown): PullDiagnosticReport | undefined {
  if (!isRecord(result) || typeof result.kind !== 'string') {
    return undefined;
  }
  if (result.kind === 'unchanged') {
    return { kind: 'unchanged' };
  }
  if (result.kind === 'full' && Array.isArray(result.items)) {
    return { kind: 'full', items: result.items };
  }
  return undefined;
}

function hasDiagnosticProvider(capabilities: Record<string, unknown>): boolean {
  const provider = capabilities.diagnosticProvider;
  return provider !== undefined && provider !== null && provider !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStalePublish(version: number | undefined, currentDocumentVersion: number | undefined): boolean {
  return version !== undefined && currentDocumentVersion !== undefined && version < currentDocumentVersion;
}
