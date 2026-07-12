/**
 * Owns the lifecycle of LSP sessions and their Monaco provider registrations, keyed by
 * (workspaceRoot, languageId). It is transport-agnostic and monaco-free: the session and the
 * provider registration are both injected, so this controller is driven by fakes in unit tests
 * and by the real createLspWebSocketTransport + LspConnection + provider registration in
 * integration / EditorSubsystem wiring.
 *
 * Invariants:
 *   - register providers only AFTER whenReady() resolves; never on close-before-ready.
 *   - dedupe concurrent ensures (pending and ready) onto one session + one registration per key.
 *   - dispose a registration exactly once on exit/close, and delete only the owning entry.
 *   - every async continuation and onExit callback is entry-identity guarded
 *     (this.entries.get(key) === entry) so a stale session cannot clobber a replacement created
 *     after closeSession(key); ensureSession(key) or a root/session swap.
 *
 * Out of scope (later, separately-gated slices): the production connect-factory, the real
 * monacoLspClient.installLspProviders wiring, EditorSubsystem call-site, config/workspaceRoot
 * plumbing, builtinCoexistence, diagnostics, and the real backend session.
 */

import type { LspExit, ServerCapabilities } from './connection.js';
import type { ProviderConnection } from './providers.js';
import type { MonacoChangeEdit } from './documentSync.js';

/** A live LSP session as the controller consumes it: a ProviderConnection plus lifecycle hooks. */
export interface ControllerSession {
  /** The connection used for provider registration (LspConnection satisfies ProviderConnection). */
  connection: ProviderConnection;
  /** Resolves with capabilities on ready; rejects (LspReadyError) on close-before-ready. */
  whenReady(): Promise<ServerCapabilities>;
  /** Notified when the server exits or the transport closes. Returns an unsubscribe. */
  onExit(listener: (exit: LspExit) => void): () => void;
  /** Tear down the underlying transport (which drives the connection to die). Idempotent. */
  close(): void;
  /** The concrete close code/reason (e.g. 1008/1011) once closed, else null. */
  closeInfo(): { code: number; reason: string } | null;
  /**
   * Optional pull-diagnostics for a single open model (capability-gated + bounded internally). A
   * no-op on sessions without diagnostic pull support; never clears markers on failure.
   */
  pullDiagnostics?(uri: string): void | Promise<void>;
  /**
   * Optional editor-owned document sync (textDocument/didOpen). Establishes the live model text as
   * the authoritative open snapshot before any didChange for this uri. Idempotent per uri.
   */
  openDocument?(uri: string, languageId: string, text: string): void;
  /** Optional editor-owned document sync (textDocument/didChange) for an already-opened uri. */
  changeDocument?(uri: string, edit: MonacoChangeEdit): void;
  /** Optional editor-owned document sync (textDocument/didClose). */
  closeDocument?(uri: string): void;
}

/** The disposable returned by provider registration (structurally a monaco.IDisposable). */
export interface ProviderRegistration {
  dispose(): void;
}

export interface SessionControllerDeps<TSelector = unknown> {
  connectSession(params: { workspaceRoot: string; languageId: string }): ControllerSession;
  registerProviders(args: {
    connection: ProviderConnection;
    capabilities: ServerCapabilities;
    languageSelector: TSelector;
  }): ProviderRegistration;
}

export type EnsureResult =
  | { status: 'ready'; capabilities: ServerCapabilities }
  | { status: 'failed'; closeInfo: { code: number; reason: string } | null };

export interface SessionLostEvent {
  workspaceRoot: string;
  languageId: string;
  exit: LspExit;
}

interface SessionEntry {
  session: ControllerSession;
  ready: Promise<EnsureResult>;
  /**
   * The resolved EnsureResult, set SYNCHRONOUSLY the moment `ready` settles (null while pending).
   * Lets document actions run synchronously once the session is ready so an editor-owned didClose
   * flushes BEFORE a synchronous closeSession/teardown on the same tick (last-model close handoff),
   * instead of losing the race as a deferred microtask.
   */
  readyResult: EnsureResult | null;
  registration: ProviderRegistration | null;
  unsubscribeExit: (() => void) | null;
  disposed: boolean;
}

export class LspSessionController<TSelector = unknown> {
  private readonly deps: SessionControllerDeps<TSelector>;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly sessionLostListeners = new Set<(event: SessionLostEvent) => void>();

  constructor(deps: SessionControllerDeps<TSelector>) {
    this.deps = deps;
  }

  private keyOf(workspaceRoot: string, languageId: string): string {
    // Array form is ASCII, deterministic, and collision-safe across path/lang delimiters.
    return JSON.stringify([workspaceRoot, languageId]);
  }

  /** Subscribe to unexpected transport/session exits. Intentional close/dispose never emits. */
  onSessionLost(listener: (event: SessionLostEvent) => void): () => void {
    this.sessionLostListeners.add(listener);
    return () => this.sessionLostListeners.delete(listener);
  }

  private notifySessionLost(event: SessionLostEvent): void {
    for (const listener of [...this.sessionLostListeners]) {
      try {
        listener(event);
      } catch {
        // Lifecycle cleanup must not be interrupted by an observer failure.
      }
    }
  }

  /**
   * Ensure a session+registration exists for (workspaceRoot, languageId). Concurrent and repeat
   * calls dedupe onto the same in-flight or ready session. Resolves 'ready' once providers are
   * registered, or 'failed' (with closeInfo) on close-before-ready.
   */
  ensureSession(params: { workspaceRoot: string; languageId: string; languageSelector: TSelector }): Promise<EnsureResult> {
    const key = this.keyOf(params.workspaceRoot, params.languageId);
    const existing = this.entries.get(key);
    if (existing) {
      return existing.ready;
    }

    let session: ControllerSession;
    try {
      session = this.deps.connectSession({ workspaceRoot: params.workspaceRoot, languageId: params.languageId });
    } catch {
      // Synchronous connect failure (e.g. transport construction): nothing was stored, allow retry.
      return Promise.resolve<EnsureResult>({ status: 'failed', closeInfo: null });
    }

    const entry: SessionEntry = {
      session,
      ready: undefined as unknown as Promise<EnsureResult>,
      readyResult: null,
      registration: null,
      unsubscribeExit: null,
      disposed: false
    };

    // Subscribe before awaiting ready so a death during startup is observed; identity-guarded.
    entry.unsubscribeExit = session.onExit((exit) => {
      if (this.entries.get(key) !== entry) {
        return;
      }
      this.teardownEntry(key, entry);
      this.notifySessionLost({ workspaceRoot: params.workspaceRoot, languageId: params.languageId, exit });
    });

    entry.ready = this.startSession(key, entry, params.languageSelector);
    this.entries.set(key, entry);
    return entry.ready;
  }

  private async startSession(key: string, entry: SessionEntry, languageSelector: TSelector): Promise<EnsureResult> {
    try {
      const capabilities = await entry.session.whenReady();
      // The entry may have been replaced/closed while we awaited; never register a stale session.
      if (this.entries.get(key) !== entry) {
        entry.readyResult = { status: 'failed', closeInfo: entry.session.closeInfo() };
        return entry.readyResult;
      }
      entry.registration = this.deps.registerProviders({
        connection: entry.session.connection,
        capabilities,
        languageSelector
      });
      entry.readyResult = { status: 'ready', capabilities };
      return entry.readyResult;
    } catch {
      // close-before-ready (LspReadyError) or any startup failure: never register.
      const closeInfo = entry.session.closeInfo();
      if (this.entries.get(key) === entry) {
        this.teardownEntry(key, entry);
      }
      entry.readyResult = { status: 'failed', closeInfo };
      return entry.readyResult;
    }
  }

  /** Dispose registration + close session + remove the entry, exactly once. */
  private teardownEntry(key: string, entry: SessionEntry): void {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    entry.unsubscribeExit?.();
    entry.unsubscribeExit = null;
    entry.registration?.dispose();
    entry.registration = null;
    entry.session.close();
  }

  /**
   * Pull diagnostics for one open model on the (workspaceRoot, languageId) session. Defers until the
   * session is ready (so a pull requested right after the first model open still fires once ready),
   * is identity-guarded against a replaced/closed session, and delegates capability-gating + bounding
   * to the session. No-op when there is no session or it failed to start.
   */
  pullDiagnostics(params: { workspaceRoot: string; languageId: string; uri: string }): void {
    const key = this.keyOf(params.workspaceRoot, params.languageId);
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    void entry.ready
      .then((result) => {
        if (result.status !== 'ready' || this.entries.get(key) !== entry) {
          return;
        }
        void entry.session.pullDiagnostics?.(params.uri);
      })
      .catch(() => undefined);
  }

  /**
   * Run an action against the ready session for a key, mirroring pullDiagnostics: defer until ready
   * (so a did* emitted right after the first model open still fires once the session is ready), drop
   * if the session failed/never-readied, and identity-guard against a replaced/closed session.
   * Actions for one key queue on the same `ready` promise and therefore fire in call order, which is
   * what guarantees an editor-owned didOpen precedes the first didChange for a uri.
   */
  private deferToReady(key: string, action: (session: ControllerSession) => void): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    // Already settled: run SYNCHRONOUSLY (no microtask) so a didClose flushes before a same-tick
    // closeSession/teardown on the last-model close path. Drop if failed or no longer current.
    if (entry.readyResult) {
      if (entry.readyResult.status === 'ready' && this.entries.get(key) === entry) {
        action(entry.session);
      }
      return;
    }
    // Still pending: queue on `ready` in call order (preserves didOpen-before-didChange); the queued
    // callbacks all run during ready-resolution, before any later post-ready synchronous action.
    void entry.ready
      .then((result) => {
        if (result.status !== 'ready' || this.entries.get(key) !== entry) {
          return;
        }
        action(entry.session);
      })
      .catch(() => undefined);
  }

  /** Editor-owned didOpen for one model on the (workspaceRoot, languageId) session (live text snapshot). */
  openDocument(params: { workspaceRoot: string; languageId: string; uri: string; text: string }): void {
    this.deferToReady(this.keyOf(params.workspaceRoot, params.languageId), (session) =>
      session.openDocument?.(params.uri, params.languageId, params.text)
    );
  }

  /** Editor-owned didChange for one already-opened model on the (workspaceRoot, languageId) session. */
  changeDocument(params: { workspaceRoot: string; languageId: string; uri: string; edit: MonacoChangeEdit }): void {
    this.deferToReady(this.keyOf(params.workspaceRoot, params.languageId), (session) =>
      session.changeDocument?.(params.uri, params.edit)
    );
  }

  /** Editor-owned didClose for one model on the (workspaceRoot, languageId) session. */
  closeDocument(params: { workspaceRoot: string; languageId: string; uri: string }): void {
    this.deferToReady(this.keyOf(params.workspaceRoot, params.languageId), (session) => session.closeDocument?.(params.uri));
  }

  /** Dispose the registration and close the session for a key (dispose-before-new-session). */
  closeSession(params: { workspaceRoot: string; languageId: string }): void {
    const key = this.keyOf(params.workspaceRoot, params.languageId);
    const entry = this.entries.get(key);
    if (entry) {
      this.teardownEntry(key, entry);
    }
  }

  /** Tear down every live session. */
  disposeAll(): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      this.teardownEntry(key, entry);
    }
  }
}
