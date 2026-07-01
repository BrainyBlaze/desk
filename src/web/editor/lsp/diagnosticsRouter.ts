/**
 * Headless router for textDocument/publishDiagnostics: subscribes to a server->client notification
 * stream, validates the payload, converts well-formed diagnostics to Monaco marker data, and routes
 * them to an injected per-uri sink. The real monaco.editor.setModelMarkers wiring lives in
 * monacoDiagnostics.ts, so this stays unit-testable without monaco.
 *
 * Safety: handlers run synchronously inside connection.ts's receive loop, so this never throws on a
 * malformed payload -- bad params/diagnostics are ignored; markers clear ONLY on a valid empty array.
 * Stale handling is by owner-scoped cleanup on dispose (markers are namespaced by a per-session owner
 * the sink carries) + closed-model no-op (the sink skips when the model is gone); version-based
 * staleness is intentionally out of scope.
 */

import { toMarkerData, type LspDiagnostic, type MonacoMarkerData } from './diagnosticsAdapter.js';

const PUBLISH_DIAGNOSTICS = 'textDocument/publishDiagnostics';

/** Applies markers for a uri under a fixed (per-session) owner. */
export interface DiagnosticsSink {
  set(uri: string, markers: MonacoMarkerData[]): void;
  clearBuiltInMarkers?(): void;
}

/** Minimal model surface the sink needs (Monaco's ITextModel satisfies it). */
export interface MarkerModel {
  getLanguageId(): string;
}

/**
 * Build a sink over a model resolver + setModelMarkers. Skips when the model is gone (closed/disposed
 * -> no-op, no throw); when applying LSP markers it also clears the built-in worker's markers (owner =
 * the model's languageId) so a built-in diagnostic computed before coexistence disabled it is not left
 * as a duplicate. monaco-free (getModel/setModelMarkers injected) so the lifecycle is unit-testable.
 */
export function createModelMarkerSink<M extends MarkerModel>(deps: {
  owner: string;
  getModel(uri: string): M | null;
  getModels?(): Iterable<M>;
  setModelMarkers(model: M, owner: string, markers: MonacoMarkerData[]): void;
}): DiagnosticsSink {
  return {
    set: (uri, markers) => {
      const model = deps.getModel(uri);
      if (!model) {
        return; // closed/disposed model: no-op
      }
      deps.setModelMarkers(model, deps.owner, markers);
      deps.setModelMarkers(model, model.getLanguageId(), []);
    },
    clearBuiltInMarkers: () => {
      if (!deps.getModels) {
        return;
      }
      for (const model of deps.getModels()) {
        deps.setModelMarkers(model, model.getLanguageId(), []);
      }
    }
  };
}

export interface DiagnosticsRouterDeps {
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  sink: DiagnosticsSink;
}

let ownerCounter = 0;

/** Mint a distinct, language-scoped marker owner per diagnostics attach (per session). */
export function nextDiagnosticsOwner(monacoLanguageId: string): string {
  ownerCounter += 1;
  return `lsp:${monacoLanguageId}:${ownerCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidDiagnostic(value: unknown): value is LspDiagnostic {
  if (!isRecord(value) || typeof value.message !== 'string' || !isRecord(value.range)) {
    return false;
  }
  const { start, end } = value.range as { start?: unknown; end?: unknown };
  for (const position of [start, end]) {
    if (!isRecord(position) || typeof position.line !== 'number' || typeof position.character !== 'number') {
      return false;
    }
  }
  return true;
}

export interface DiagnosticsRouter {
  dispose(): void;
  /** Clear the built-in worker owner for currently-open models of this router's language. */
  clearBuiltInMarkers(): void;
  /**
   * Apply a PULL (textDocument/diagnostic) result's items for a uri into the SAME per-session sink/
   * owner as push, so push + pull from one session share a bucket. A non-empty list applies; a
   * non-empty all-malformed list is ignored (never clears). A valid empty array clears that uri
   * ONLY when push has not populated it -- an empty pull never clobbers push-delivered markers
   * (rust-analyzer is push-only and keeps returning empty pulls). Callers route only successful
   * `full` reports here; unchanged/failed are no-ops upstream and never reach this.
   */
  applyPull(uri: string, diagnostics: unknown[]): void;
}

export function createDiagnosticsRouter(deps: DiagnosticsRouterDeps): DiagnosticsRouter {
  const tracked = new Set<string>();
  // URIs currently populated by a non-empty PUSH (publishDiagnostics). rust-analyzer is push-only for
  // diagnostics: it pushes publishDiagnostics but its textDocument/diagnostic PULL is repeatedly empty.
  // Since push and pull share one owner bucket, an empty PULL must NOT clobber push-delivered markers --
  // only an authoritative empty PUSH (or dispose) clears them.
  const pushPopulated = new Set<string>();
  deps.sink.clearBuiltInMarkers?.();

  // Shared by push (publishDiagnostics) and pull (textDocument/diagnostic): both route through the
  // same sink under the same per-session owner, so they update the same marker bucket. `source`
  // distinguishes them so an empty pull cannot clear push-populated diagnostics.
  const apply = (uri: string, raw: unknown[], source: 'push' | 'pull'): void => {
    if (raw.length === 0) {
      // An empty pull never clears a uri push has populated (push-only servers like rust-analyzer
      // keep returning empty pulls); leave the push markers in place.
      if (source === 'pull' && pushPopulated.has(uri)) {
        return;
      }
      deps.sink.set(uri, []); // valid empty array -> clear
      tracked.delete(uri);
      if (source === 'push') {
        pushPopulated.delete(uri);
      }
      return;
    }
    const valid = raw.filter(isValidDiagnostic);
    if (valid.length === 0) {
      return; // non-empty but all malformed: ignore (do NOT clear)
    }
    deps.sink.set(uri, toMarkerData(valid));
    tracked.add(uri);
    if (source === 'push') {
      pushPopulated.add(uri);
    }
  };

  const unsubscribe = deps.onNotification(PUBLISH_DIAGNOSTICS, (params) => {
    if (!isRecord(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) {
      return; // malformed payload: ignore, never throw
    }
    apply(params.uri, params.diagnostics as unknown[], 'push');
  });

  return {
    clearBuiltInMarkers: () => {
      deps.sink.clearBuiltInMarkers?.();
    },
    applyPull: (uri, diagnostics) => {
      if (typeof uri !== 'string' || !Array.isArray(diagnostics)) {
        return; // defensive: malformed pull routing is a no-op
      }
      apply(uri, diagnostics, 'pull');
    },
    dispose: () => {
      unsubscribe();
      for (const uri of tracked) {
        deps.sink.set(uri, []);
      }
      tracked.clear();
      pushPopulated.clear();
    }
  };
}
