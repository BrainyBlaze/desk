/**
 * App-layer wiring that turns desk.yml LSP config into the default-off `createLspBinding` factory
 * EditorSubsystem consumes. It is headless and monaco-free: the real provider registration
 * (monacoLspClient.installLspProviders) is injected by the caller (App.tsx / the test harness), so this
 * module stays unit-testable in node.
 *
 * Default-disabled + fail-closed: absent/malformed/empty config disables LSP; an enabled config
 * still degrades safely (no registration, no hang, no editor error) when the backend session
 * rejects before ready -- which is exactly what the live /ws/lsp does today (1011) until the real
 * backend-session slice lands.
 *
 * Out of scope (later, separately-gated slices): persisted LSP settings write + POST whitelist +
 * server/core types, the Settings UI, the real backend session, diagnostics, builtinCoexistence.
 */

import type { ServerCapabilities } from './connection.js';
import { LspConnection } from './connection.js';
import type { ProviderConnection } from './providers.js';
import { createLspWebSocketTransport, type WebSocketLike } from './webSocketTransport.js';
import { createEditorLspBinding, type EditorLspBinding } from './editorLspBinding.js';
import { LspSessionController, type ControllerSession, type ProviderRegistration } from './sessionController.js';
import { LspDocumentSync, type MonacoChangeEdit } from './documentSync.js';
import { perfMarkSessionCreate, perfMarkSessionReady } from './perfTelemetry.js';
import { createSessionStatusTracker } from './sessionStatusTracker.js';
import type { LspSessionStatus } from './statusSegment.js';

/** Normalized, validated LSP config (the only shape the factory trusts). */
export interface LspUiConfig {
  enabled: boolean;
  languages: string[];
  baseUrl?: string;
}

/** Provider registration as injected by the App/test harness (production: monacoLspClient.installLspProviders). */
export type RegisterLspProviders = (args: {
  connection: ProviderConnection;
  capabilities: ServerCapabilities;
  languageSelector: string;
}) => ProviderRegistration;

/**
 * Built-in coexistence seam (production: createBuiltinCoexistenceController over Monaco *Defaults).
 * acquire() leases per-feature built-in disablement for a ready LSP language; release() drops it.
 * Headless here -- the real Monaco binding is injected so appLspWiring imports no monaco.
 */
export interface BuiltinCoexistence {
  acquire(monacoLanguageId: string, capabilities: ServerCapabilities): { release(): void };
  /** Lease ONLY the built-in diagnostics flag; used when the live diagnostics path is wired. */
  acquireDiagnostics(monacoLanguageId: string): { release(): void };
}

/** The connection slice diagnostics needs (server->client notification stream). */
export interface DiagnosticsAttachConnection {
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}
/** A diagnostics attachment: push subscription (dispose) plus applyPull for pulled diagnostics. */
export interface DiagnosticsAttachment {
  dispose(): void;
  /** Clear stale built-in worker markers for currently-open models of this language. */
  clearBuiltInMarkers(): void;
  /** Route a pull (textDocument/diagnostic) result's items into the same per-session marker bucket. */
  applyPull(uri: string, diagnostics: unknown[]): void;
}
/** Subscribe a session's publishDiagnostics to Monaco markers; production = monacoDiagnostics.attach. */
export type AttachDiagnostics = (connection: DiagnosticsAttachConnection, languageId: string) => DiagnosticsAttachment;

export interface AppLspDeps {
  /** Defaults to the production WebSocket adapter (createWebSocketControllerSession). */
  connectSession?: (params: { workspaceRoot: string; languageId: string }) => ControllerSession;
  /** Required: the real installLspProviders (or a wrapper) -- never a spy-only replacement in production. */
  registerProviders: RegisterLspProviders;
  /** Optional: when present, ready providers lease built-in coexistence; disposal releases it. */
  coexistence?: BuiltinCoexistence;
  /** Optional: when present, each session subscribes publishDiagnostics -> Monaco markers. */
  attachDiagnostics?: AttachDiagnostics;
  /** Optional: read-only LSP session status (warm/ready/degraded/restart + $/progress) per language. */
  onSessionStatus?: (params: { workspaceRoot: string; languageId: string; status: LspSessionStatus }) => void;
  /** Optional: a session was torn down (last model closed / root switch) -- drop any stored status. */
  onSessionClosed?: (params: { workspaceRoot: string; languageId: string }) => void;
}

export type CreateLspBinding = (params: { workspaceRoot: string }) => EditorLspBinding;

/** Defensive, fail-closed normalizer over the verbatim settings.lsp block from /api/settings. */
export function resolveLspConfig(raw: unknown): LspUiConfig {
  const disabled: LspUiConfig = { enabled: false, languages: [] };
  if (typeof raw !== 'object' || raw === null) {
    return disabled;
  }
  const obj = raw as { enabled?: unknown; languages?: unknown; disabledLanguages?: unknown; baseUrl?: unknown };
  if (obj.enabled !== true || !Array.isArray(obj.languages)) {
    return disabled;
  }
  const detected = obj.languages.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  // The server-normalized user denylist. A non-array is treated as no denylist (subtract nothing);
  // malformed entries are dropped. Non-detected ids subtract nothing -- they are inert here.
  const denied = new Set(
    Array.isArray(obj.disabledLanguages)
      ? obj.disabledLanguages
          .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
          .map((value) => value.trim())
      : []
  );
  // Effective active languages = detected MINUS denylist. Disabling every detected language is
  // indistinguishable from "nothing to activate" -> fail closed to a disabled binding.
  const languages = detected.filter((language) => !denied.has(language));
  if (languages.length === 0) {
    return disabled;
  }
  const baseUrl = typeof obj.baseUrl === 'string' && obj.baseUrl.trim() !== '' ? obj.baseUrl : undefined;
  return baseUrl === undefined ? { enabled: true, languages } : { enabled: true, languages, baseUrl };
}

/** Dependencies the pull scheduler needs; all injectable so it is unit-testable without a real socket. */
export interface DiagnosticsPullSchedulerDeps {
  request: <T>(method: string, params: unknown, options: { signal: AbortSignal }) => Promise<T>;
  whenReady: () => Promise<ServerCapabilities | null | undefined>;
  diagnostics: { applyPull(uri: string, items: unknown[]): void; clearBuiltInMarkers(): void } | null;
  /** still-open membership test; a response for a closed uri is dropped (no apply, no retry). */
  isOpen: (uri: string) => boolean;
  /** current open uris for refreshAll(). */
  openUris: () => Iterable<string>;
  debounceMs?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface DiagnosticsPullScheduler {
  /** Debounced pull of one uri (model-open trigger). */
  pull(uri: string): void;
  /** Re-pull every currently open uri (workspace/diagnostic/refresh handler). */
  refreshAll(): void;
  /** Cancel all timers + in-flight requests; further pull/refresh is a no-op. */
  dispose(): void;
}

/**
 * Pull-diagnostics scheduler. Pull-first servers (rust-analyzer) emit diagnostics via
 * textDocument/diagnostic and ask the client to re-pull with workspace/diagnostic/refresh; they are
 * usually NOT ready at model-open. This schedules debounced per-uri pulls with a bounded retry AFTER
 * timeout/failure only (never after a valid full report, even an empty one), routes a valid full
 * report through applyPull, and never clears markers on failure/timeout/cancel/unchanged/malformed.
 * Close/dispose cancels timers + aborts in-flight; a response whose uri is no longer open (or after
 * dispose) is dropped. Push (publishDiagnostics) servers do not exercise this path.
 */
export function createDiagnosticsPullScheduler(deps: DiagnosticsPullSchedulerDeps): DiagnosticsPullScheduler {
  const debounceMs = deps.debounceMs ?? 150;
  const timeoutMs = deps.timeoutMs ?? 2000;
  const retryDelayMs = deps.retryDelayMs ?? 400;
  const maxRetries = deps.maxRetries ?? 4;
  let disposed = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const controllers = new Map<string, AbortController>();

  const clearTimer = (uri: string) => {
    const t = timers.get(uri);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(uri);
    }
  };
  const scheduleRun = (uri: string, attempt: number, delay: number) => {
    clearTimer(uri);
    timers.set(uri, setTimeout(() => {
      timers.delete(uri);
      void run(uri, attempt);
    }, delay));
  };

  async function run(uri: string, attempt: number): Promise<void> {
    if (disposed || !deps.isOpen(uri) || !deps.diagnostics) {
      return;
    }
    deps.diagnostics.clearBuiltInMarkers();
    let capabilities: ServerCapabilities | null | undefined;
    try {
      capabilities = await deps.whenReady();
    } catch {
      return; // close-before-ready: no retry
    }
    if (disposed || !deps.isOpen(uri)) {
      return;
    }
    if (!capabilities || typeof capabilities !== 'object' || !(capabilities as Record<string, unknown>).diagnosticProvider) {
      return; // server is not a pull-diagnostics provider: never pull/retry
    }
    const controller = new AbortController();
    const prev = controllers.get(uri);
    if (prev) {
      prev.abort();
    }
    controllers.set(uri, controller);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let report: unknown;
    try {
      report = await deps.request<unknown>('textDocument/diagnostic', { textDocument: { uri } }, { signal: controller.signal });
    } catch {
      clearTimeout(timeoutId);
      if (controllers.get(uri) === controller) {
        controllers.delete(uri);
      }
      // failure/timeout/cancel: never clears markers. Bounded retry only if still live.
      if (!disposed && deps.isOpen(uri) && attempt < maxRetries) {
        scheduleRun(uri, attempt + 1, retryDelayMs);
      }
      return;
    }
    clearTimeout(timeoutId);
    if (controllers.get(uri) === controller) {
      controllers.delete(uri);
    }
    if (disposed || !deps.isOpen(uri)) {
      return; // dropped: uri closed or session disposed while in flight
    }
    // A valid response (full or unchanged) is terminal -> never retry. Only a full array updates markers.
    if (report && typeof report === 'object' && (report as Record<string, unknown>).kind === 'full') {
      const items = (report as { items?: unknown }).items;
      if (Array.isArray(items)) {
        deps.diagnostics.applyPull(uri, items);
      }
    }
  }

  return {
    pull(uri: string): void {
      if (disposed) {
        return;
      }
      scheduleRun(uri, 0, debounceMs);
    },
    refreshAll(): void {
      if (disposed) {
        return;
      }
      for (const uri of deps.openUris()) {
        scheduleRun(uri, 0, debounceMs);
      }
    },
    dispose(): void {
      disposed = true;
      for (const t of timers.values()) {
        clearTimeout(t);
      }
      timers.clear();
      for (const c of controllers.values()) {
        c.abort();
      }
      controllers.clear();
    }
  };
}

/**
 * The production ControllerSession adapter: a real /ws/lsp transport + LspConnection. Teardown goes
 * through transport.close() (LspConnection has no public close), and closeInfo() comes from the
 * transport. webSocketFactory is injectable so node tests can drive it with the `ws` package;
 * production leaves it undefined (the global WebSocket).
 */
export function createWebSocketControllerSession(
  params: { workspaceRoot: string; languageId: string },
  options: {
    baseUrl?: string;
    webSocketFactory?: (url: string) => WebSocketLike;
    attachDiagnostics?: AttachDiagnostics;
    /** Read-only status sink: folds lifecycle frames + $/progress for THIS session's language. */
    onSessionStatus?: (status: LspSessionStatus) => void;
    /** Called once when this session is torn down (close()). */
    onSessionClosed?: () => void;
  } = {}
): ControllerSession {
  const transport = createLspWebSocketTransport({
    workspaceRoot: params.workspaceRoot,
    languageId: params.languageId,
    baseUrl: options.baseUrl,
    webSocketFactory: options.webSocketFactory
  });
  const connection = new LspConnection(transport);
  // Read-only status: fold the bridge's lifecycle frames + sanitized $/progress into one segment-ready
  // status and forward it. Subscriptions are torn down on close (no leak on close-before-ready).
  let disposeStatus = (): void => {};
  if (options.onSessionStatus) {
    const tracker = createSessionStatusTracker({ languageId: params.languageId, onChange: options.onSessionStatus });
    const identity = { serverConfigId: params.languageId, workspaceRoot: params.workspaceRoot, languageId: params.languageId };
    // Client-derived 'warming' the instant the session connects. The bridge queues backend status
    // frames until its `ready` envelope (lspWebSocketBridge: status passthrough opens only after ready),
    // so the pre-ready wait would otherwise render no status at all. The first real backend frame -- or
    // the close-before-ready 'degraded' below -- supersedes this through the same tracker.
    tracker.acceptStatus({ ...identity, state: 'warming' });
    const offStatus = connection.onStatus((status) => tracker.acceptStatus(status));
    const offProgress = connection.onNotification('$/progress', (progressParams) => tracker.acceptProgress(progressParams));
    const offExit = connection.onExit((exit) => tracker.acceptExit(exit));
    // Close-before-ready (server failed to start / warm degraded path closes the ws with no status
    // frame): surface 'degraded' so the user sees the fall-back to built-in features, not a silent gap.
    connection.whenReady().then(
      () => tracker.acceptStatus({ ...identity, state: 'ready' }),
      () => tracker.acceptStatus({ ...identity, state: 'degraded', reason: 'language server unavailable - using built-in features' })
    );
    disposeStatus = () => {
      offStatus();
      offProgress();
      offExit();
    };
  }
  // LSP telemetry (no-op unless DESK_LSP_PERF): time websocket session create -> ready.
  perfMarkSessionCreate();
  void connection
    .whenReady()
    .then(() => perfMarkSessionReady())
    .catch(() => undefined);
  // Subscribe diagnostics at connect time (publishDiagnostics only arrive post-ready; close disposes
  // the attachment whether or not the server ever reached ready -> no leak on close-before-ready).
  const diagnostics = options.attachDiagnostics ? options.attachDiagnostics(connection, params.languageId) : null;
  // Editor-owned document sync over the live connection (LspConnection satisfies LspNotifySink). The
  // controller defers these until ready; `openUris` guards the tracker so a change/close never lands
  // on an unopened uri and a uri is never opened twice.
  const documentSync = new LspDocumentSync(connection);
  const openUris = new Set<string>();
  const scheduler = createDiagnosticsPullScheduler({
    request: (method, params, opts) => connection.request(method, params, opts),
    whenReady: () => connection.whenReady(),
    diagnostics,
    isOpen: (uri) => openUris.has(uri),
    openUris: () => openUris
  });
  // Pull-first servers (rust-analyzer) ask the client to re-pull via this server->client request once
  // analysis is ready; respond null and re-pull every open uri. The bridge already forwards the
  // request + relays the response and connection.onRequest dispatches it, so pull diagnostics stay editor-only.
  const disposeRefresh = connection.onRequest('workspace/diagnostic/refresh', () => {
    scheduler.refreshAll();
    return null;
  });
  // Dynamic capability (un)registration: servers like pyright issue client/registerCapability right
  // after initialize and tear the session down if the client answers method-not-found. We ack with an
  // empty result (the editor registers providers statically from the initialize capabilities, so there
  // is nothing extra to wire), keeping such servers alive. Disposed with the session.
  const disposeRegister = connection.onRequest('client/registerCapability', () => null);
  const disposeUnregister = connection.onRequest('client/unregisterCapability', () => null);
  return {
    connection,
    whenReady: () => connection.whenReady(),
    onExit: (listener) => connection.onExit(listener),
    openDocument: (uri: string, languageId: string, text: string) => {
      if (openUris.has(uri)) {
        return;
      }
      openUris.add(uri);
      documentSync.openDocument(uri, languageId, text);
    },
    changeDocument: (uri: string, edit: MonacoChangeEdit) => {
      if (!openUris.has(uri)) {
        return;
      }
      documentSync.changeDocument(uri, edit);
    },
    closeDocument: (uri: string) => {
      if (!openUris.has(uri)) {
        return;
      }
      openUris.delete(uri);
      documentSync.closeDocument(uri);
    },
    // Pull diagnostics for a single open model (model-open trigger). Delegated to the scheduler:
    // debounced, capability-gated, bounded retry after timeout/failure only (so a pull-first server
    // not ready at open still converges), and a no-op on failure/timeout/unchanged/malformed that
    // never clears existing markers. workspace/diagnostic/refresh re-pulls every open uri.
    pullDiagnostics: (uri: string) => {
      scheduler.pull(uri);
    },
    close: () => {
      disposeRefresh();
      disposeRegister();
      disposeUnregister();
      disposeStatus();
      scheduler.dispose();
      diagnostics?.dispose();
      transport.close();
      options.onSessionClosed?.();
    },
    closeInfo: () => transport.closeInfo()
  };
}

/**
 * Build the default-off createLspBinding factory from config. Returns null when LSP is disabled, in
 * which case the App passes createLspBinding=undefined and EditorSubsystem behaves exactly as today.
 */
export function makeCreateLspBinding(config: LspUiConfig, deps: AppLspDeps): CreateLspBinding | null {
  if (!config.enabled) {
    return null;
  }
  const connectSession =
    deps.connectSession ??
    ((params: { workspaceRoot: string; languageId: string }) =>
      createWebSocketControllerSession(params, {
        baseUrl: config.baseUrl,
        attachDiagnostics: deps.attachDiagnostics,
        onSessionStatus: deps.onSessionStatus
          ? (status) => deps.onSessionStatus!({ workspaceRoot: params.workspaceRoot, languageId: params.languageId, status })
          : undefined,
        onSessionClosed: deps.onSessionClosed
          ? () => deps.onSessionClosed!({ workspaceRoot: params.workspaceRoot, languageId: params.languageId })
          : undefined
      }));
  // When coexistence is injected, a SUCCESSFUL registration (only after whenReady resolves) leases
  // built-in disablement; disposing the registration (exit/close/root switch/dispose) releases it.
  // Fail-closed: on close-before-ready registerProviders is never called, so no lease is taken. The
  // built-in DIAGNOSTICS flag is leased only when the diagnostics path is wired AND ready (no blackout).
  const coexistence = deps.coexistence;
  const leaseDiagnostics = Boolean(coexistence && deps.attachDiagnostics);
  const registerProviders: RegisterLspProviders = coexistence
    ? (args) => {
        const registration = deps.registerProviders(args);
        const lease = coexistence.acquire(args.languageSelector, args.capabilities);
        const diagnosticsLease = leaseDiagnostics ? coexistence.acquireDiagnostics(args.languageSelector) : null;
        return {
          dispose: () => {
            registration.dispose();
            lease.release();
            diagnosticsLease?.release();
          }
        };
      }
    : deps.registerProviders;
  return ({ workspaceRoot }) =>
    createEditorLspBinding<string>({
      controller: new LspSessionController<string>({ connectSession, registerProviders }),
      workspaceRoot,
      isLanguageEnabled: (languageId) => config.languages.includes(languageId),
      toSelector: (languageId) => languageId
    });
}
