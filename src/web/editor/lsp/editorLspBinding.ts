/**
 * Bridges the editor's model lifecycle to LSP sessions. It refcounts open models per languageId
 * and delegates session ownership to an injected LspSessionController: it ensures a session when
 * the FIRST model of a language opens and closes it when the LAST one closes (one language server
 * per language per workspaceRoot). It is headless and monaco-free; EditorSubsystem forwards real
 * model open/close events to it through a default-off injected seam.
 *
 * Out of scope (later, separately-gated slices): the production connect-factory + real
 * monacoLspClient registration supplied by the App-layer createLspBinding, config/workspaceRoot
 * (desk.yml) enablement, builtinCoexistence, diagnostics, and the real backend session.
 */

import type { MonacoChangeEdit } from './documentSync.js';
import type { SessionLostEvent } from './sessionController.js';

/** A model the editor opened/closed, identified by its uri string and resolved languageId. */
export interface ModelRef {
  uri: string;
  languageId: string;
}

/** The slice of LspSessionController the binding needs (LspSessionController satisfies it). */
export interface SessionControllerLike<TSelector> {
  ensureSession(params: { workspaceRoot: string; languageId: string; languageSelector: TSelector }): Promise<unknown>;
  closeSession(params: { workspaceRoot: string; languageId: string }): void;
  /** Optional unexpected-loss signal. Intentional close/dispose must not emit. */
  onSessionLost?(listener: (event: SessionLostEvent) => void): () => void;
  /** Optional model-open diagnostics pull (capability-gated + deferred-until-ready by the controller). */
  pullDiagnostics?(params: { workspaceRoot: string; languageId: string; uri: string }): void;
  /** Optional editor-owned didOpen (live text); deferred-until-ready + identity-guarded by the controller. */
  openDocument?(params: { workspaceRoot: string; languageId: string; uri: string; text: string }): void;
  /** Optional editor-owned didChange for an already-opened uri. */
  changeDocument?(params: { workspaceRoot: string; languageId: string; uri: string; edit: MonacoChangeEdit }): void;
  /** Optional editor-owned didClose. */
  closeDocument?(params: { workspaceRoot: string; languageId: string; uri: string }): void;
}

export interface EditorLspBindingDeps<TSelector> {
  controller: SessionControllerLike<TSelector>;
  workspaceRoot: string;
  /** Only languages for which this returns true get sessions; others are no-ops. */
  isLanguageEnabled(languageId: string): boolean;
  /** Map a languageId to the controller's provider-registration selector. */
  toSelector(languageId: string): TSelector;
  /** Capped reconnect backoff. Primarily injectable for deterministic tests. */
  reconnectDelaysMs?: readonly number[];
}

export interface EditorLspBinding {
  /**
   * Refcount this model's language session (ensure on 0->1) and establish editor-owned didOpen with
   * the live model `text` (the authoritative snapshot before any didChange). `text` defaults to ''
   * for callers that do not drive document sync (the controller no-ops without an openDocument seam).
   */
  openModel(ref: ModelRef, text?: string): void;
  /** Editor-owned didChange for an already-open model; a no-op for untracked/disabled models. */
  changeModel(ref: ModelRef, edit: MonacoChangeEdit): void;
  closeModel(ref: ModelRef): void;
  disposeAll(): void;
}

const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 3_000, 5_000] as const;

function ensureFailed(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'status' in result && result.status === 'failed';
}

export function createEditorLspBinding<TSelector = unknown>(deps: EditorLspBindingDeps<TSelector>): EditorLspBinding {
  // languageId -> uri -> latest full model text. The full snapshot is what lets a replacement
  // session recover every document after edits made while the transport was down.
  const openByLanguage = new Map<string, Map<string, string>>();
  const reconnectDelays = deps.reconnectDelaysMs?.length ? deps.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const reconnecting = new Set<string>();
  const languageEpochs = new Map<string, number>();
  let unsubscribeSessionLost: (() => void) | null = null;

  const bumpLanguageEpoch = (languageId: string): number => {
    const next = (languageEpochs.get(languageId) ?? 0) + 1;
    languageEpochs.set(languageId, next);
    return next;
  };

  const clearReconnectTimer = (languageId: string): void => {
    const timer = reconnectTimers.get(languageId);
    if (timer !== undefined) {
      clearTimeout(timer);
      reconnectTimers.delete(languageId);
    }
  };

  const cancelReconnect = (languageId: string): void => {
    clearReconnectTimer(languageId);
    reconnectAttempts.delete(languageId);
    reconnecting.delete(languageId);
    bumpLanguageEpoch(languageId);
  };

  const replayLanguage = (languageId: string): void => {
    const models = openByLanguage.get(languageId);
    if (!models) {
      return;
    }
    for (const [uri, text] of models) {
      deps.controller.openDocument?.({ workspaceRoot: deps.workspaceRoot, languageId, uri, text });
      deps.controller.pullDiagnostics?.({ workspaceRoot: deps.workspaceRoot, languageId, uri });
    }
  };

  let ensureLanguage: (languageId: string, replay: boolean) => void;

  const scheduleReconnect = (languageId: string): void => {
    const models = openByLanguage.get(languageId);
    if (!models?.size || reconnectTimers.has(languageId)) {
      return;
    }
    reconnecting.add(languageId);
    const attempt = reconnectAttempts.get(languageId) ?? 0;
    const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]!;
    reconnectAttempts.set(languageId, attempt + 1);
    reconnectTimers.set(
      languageId,
      setTimeout(() => {
        reconnectTimers.delete(languageId);
        if (openByLanguage.get(languageId)?.size) {
          ensureLanguage(languageId, true);
        }
      }, delay)
    );
  };

  ensureLanguage = (languageId: string, replay: boolean): void => {
    const epoch = bumpLanguageEpoch(languageId);
    let pending: Promise<unknown>;
    try {
      pending = deps.controller.ensureSession({
        workspaceRoot: deps.workspaceRoot,
        languageId,
        languageSelector: deps.toSelector(languageId)
      });
    } catch {
      if (languageEpochs.get(languageId) === epoch) {
        scheduleReconnect(languageId);
      }
      return;
    }
    void pending.then(
      (result) => {
        if (languageEpochs.get(languageId) !== epoch || !openByLanguage.get(languageId)?.size) {
          return;
        }
        if (ensureFailed(result)) {
          scheduleReconnect(languageId);
          return;
        }
        reconnectAttempts.delete(languageId);
        if (replay) {
          replayLanguage(languageId);
        }
        reconnecting.delete(languageId);
      },
      () => {
        if (languageEpochs.get(languageId) === epoch) {
          scheduleReconnect(languageId);
        }
      }
    );
  };

  const ensureLossSubscription = (): void => {
    if (unsubscribeSessionLost || !deps.controller.onSessionLost) {
      return;
    }
    unsubscribeSessionLost = deps.controller.onSessionLost((event) => {
      if (event.workspaceRoot !== deps.workspaceRoot || !openByLanguage.get(event.languageId)?.size) {
        return;
      }
      // Invalidate a ready result racing with this exit before scheduling its replacement.
      bumpLanguageEpoch(event.languageId);
      scheduleReconnect(event.languageId);
    });
  };

  const releaseLossSubscriptionIfIdle = (): void => {
    if (openByLanguage.size === 0) {
      unsubscribeSessionLost?.();
      unsubscribeSessionLost = null;
    }
  };

  return {
    openModel(ref: ModelRef, text = ''): void {
      if (!deps.isLanguageEnabled(ref.languageId)) {
        return;
      }
      ensureLossSubscription();
      let models = openByLanguage.get(ref.languageId);
      if (!models) {
        models = new Map<string, string>();
        openByLanguage.set(ref.languageId, models);
      }
      if (models.has(ref.uri)) {
        models.set(ref.uri, text);
        return; // already counted: never double-ensure / never double-open
      }
      const wasEmpty = models.size === 0;
      models.set(ref.uri, text);
      if (wasEmpty) {
        ensureLanguage(ref.languageId, false);
      }
      // Editor-owned didOpen: the live model text is the authoritative open snapshot. The controller
      // defers until ready and queues this BEFORE any later changeModel for the same uri, so didOpen
      // always precedes the first didChange. (The backend raw-mux converts a duplicate editor didOpen
      // on an already-server-open uri into a didChange with editor text authoritative -- see
      // rawSessionMultiplexer.handleDidOpen, server side, out of this slice's scope.)
      if (!reconnecting.has(ref.languageId)) {
        deps.controller.openDocument?.({
          workspaceRoot: deps.workspaceRoot,
          languageId: ref.languageId,
          uri: ref.uri,
          text
        });
        // Model-open pull trigger: request fresh diagnostics for this model. The controller defers
        // until the session is ready (covers the first-open case) and capability-gates; failures are
        // no-ops. Push diagnostics remain intact and update the same per-session marker bucket.
        deps.controller.pullDiagnostics?.({
          workspaceRoot: deps.workspaceRoot,
          languageId: ref.languageId,
          uri: ref.uri
        });
      }
    },

    changeModel(ref: ModelRef, edit: MonacoChangeEdit): void {
      if (!deps.isLanguageEnabled(ref.languageId)) {
        return;
      }
      const models = openByLanguage.get(ref.languageId);
      if (!models || !models.has(ref.uri)) {
        return; // not open / not tracked (e.g. a change after close): drop, never didChange unopened
      }
      models.set(ref.uri, edit.fullText);
      if (reconnecting.has(ref.languageId)) {
        return;
      }
      deps.controller.changeDocument?.({
        workspaceRoot: deps.workspaceRoot,
        languageId: ref.languageId,
        uri: ref.uri,
        edit
      });
    },

    closeModel(ref: ModelRef): void {
      const models = openByLanguage.get(ref.languageId);
      if (!models || !models.has(ref.uri)) {
        return;
      }
      // didClose before the session refcount drops. The controller runs closeDocument synchronously
      // when the session is ready, so the didClose notification is emitted BEFORE the closeSession
      // teardown below on the last-model close path (not lost to a deferred microtask).
      if (!reconnecting.has(ref.languageId)) {
        deps.controller.closeDocument?.({ workspaceRoot: deps.workspaceRoot, languageId: ref.languageId, uri: ref.uri });
      }
      models.delete(ref.uri);
      if (models.size === 0) {
        openByLanguage.delete(ref.languageId);
        cancelReconnect(ref.languageId);
        deps.controller.closeSession({ workspaceRoot: deps.workspaceRoot, languageId: ref.languageId });
        releaseLossSubscriptionIfIdle();
      }
    },

    disposeAll(): void {
      for (const languageId of [...openByLanguage.keys()]) {
        cancelReconnect(languageId);
        deps.controller.closeSession({ workspaceRoot: deps.workspaceRoot, languageId });
      }
      openByLanguage.clear();
      unsubscribeSessionLost?.();
      unsubscribeSessionLost = null;
    }
  };
}
