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

/** A model the editor opened/closed, identified by its uri string and resolved languageId. */
export interface ModelRef {
  uri: string;
  languageId: string;
}

/** The slice of LspSessionController the binding needs (LspSessionController satisfies it). */
export interface SessionControllerLike<TSelector> {
  ensureSession(params: { workspaceRoot: string; languageId: string; languageSelector: TSelector }): Promise<unknown>;
  closeSession(params: { workspaceRoot: string; languageId: string }): void;
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

export function createEditorLspBinding<TSelector = unknown>(deps: EditorLspBindingDeps<TSelector>): EditorLspBinding {
  // languageId -> set of open model uris of that language.
  const openByLanguage = new Map<string, Set<string>>();

  return {
    openModel(ref: ModelRef, text = ''): void {
      if (!deps.isLanguageEnabled(ref.languageId)) {
        return;
      }
      let uris = openByLanguage.get(ref.languageId);
      if (!uris) {
        uris = new Set<string>();
        openByLanguage.set(ref.languageId, uris);
      }
      if (uris.has(ref.uri)) {
        return; // already counted: never double-ensure / never double-open
      }
      const wasEmpty = uris.size === 0;
      uris.add(ref.uri);
      if (wasEmpty) {
        // 0 -> 1: first model of this language. Fire-and-forget; the controller dedupes and owns
        // failure (close-before-ready -> failed result), which the editor does not surface yet.
        void deps.controller.ensureSession({
          workspaceRoot: deps.workspaceRoot,
          languageId: ref.languageId,
          languageSelector: deps.toSelector(ref.languageId)
        });
      }
      // Editor-owned didOpen: the live model text is the authoritative open snapshot. The controller
      // defers until ready and queues this BEFORE any later changeModel for the same uri, so didOpen
      // always precedes the first didChange. (The backend raw-mux converts a duplicate editor didOpen
      // on an already-server-open uri into a didChange with editor text authoritative -- see
      // rawSessionMultiplexer.handleDidOpen, server side, out of this slice's scope.)
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
    },

    changeModel(ref: ModelRef, edit: MonacoChangeEdit): void {
      if (!deps.isLanguageEnabled(ref.languageId)) {
        return;
      }
      const uris = openByLanguage.get(ref.languageId);
      if (!uris || !uris.has(ref.uri)) {
        return; // not open / not tracked (e.g. a change after close): drop, never didChange unopened
      }
      deps.controller.changeDocument?.({
        workspaceRoot: deps.workspaceRoot,
        languageId: ref.languageId,
        uri: ref.uri,
        edit
      });
    },

    closeModel(ref: ModelRef): void {
      const uris = openByLanguage.get(ref.languageId);
      if (!uris || !uris.has(ref.uri)) {
        return;
      }
      // didClose before the session refcount drops. The controller runs closeDocument synchronously
      // when the session is ready, so the didClose notification is emitted BEFORE the closeSession
      // teardown below on the last-model close path (not lost to a deferred microtask).
      deps.controller.closeDocument?.({ workspaceRoot: deps.workspaceRoot, languageId: ref.languageId, uri: ref.uri });
      uris.delete(ref.uri);
      if (uris.size === 0) {
        openByLanguage.delete(ref.languageId);
        deps.controller.closeSession({ workspaceRoot: deps.workspaceRoot, languageId: ref.languageId });
      }
    },

    disposeAll(): void {
      for (const languageId of [...openByLanguage.keys()]) {
        deps.controller.closeSession({ workspaceRoot: deps.workspaceRoot, languageId });
      }
      openByLanguage.clear();
    }
  };
}
