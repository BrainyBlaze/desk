/**
 * Real-Monaco diagnostics sink: applies LSP-derived markers to Monaco models via
 * monaco.editor.setModelMarkers, namespaced by a per-session owner so a replacement session's
 * markers are independent of an old session's. The notification subscription + payload validation
 * live in the headless diagnosticsRouter; this is the only diagnostics module that imports monaco.
 */

import { monaco } from '../monacoSetup.js';
import { createDiagnosticsRouter, createModelMarkerSink, nextDiagnosticsOwner, type DiagnosticsRouter } from './diagnosticsRouter.js';
import type { MonacoMarkerData } from './diagnosticsAdapter.js';

/** The slice of the LSP connection diagnostics needs: the server->client notification stream. */
export interface DiagnosticsConnection {
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export interface MonacoDiagnostics {
  /**
   * Subscribe a session's publishDiagnostics to Monaco markers and expose applyPull so a pull
   * (textDocument/diagnostic) result routes to the SAME per-session owner/bucket; dispose clears +
   * unsubscribes.
   */
  attach(connection: DiagnosticsConnection, monacoLanguageId: string): DiagnosticsRouter;
}

export function createMonacoDiagnostics(): MonacoDiagnostics {
  return {
    attach: (connection, monacoLanguageId) => {
      const owner = nextDiagnosticsOwner(monacoLanguageId);
      // The null-skip + built-in-owner clearing live in the headless createModelMarkerSink (unit-tested);
      // here we just bind real monaco getModel/setModelMarkers into it.
      const sink = createModelMarkerSink<monaco.editor.ITextModel>({
        owner,
        getModel: (uri) => monaco.editor.getModel(monaco.Uri.parse(uri)),
        getModels: () => monaco.editor.getModels().filter((model) => model.getLanguageId() === monacoLanguageId),
        // MonacoMarkerData mirrors IMarkerData (severity/tag values coincide); narrow boundary cast.
        setModelMarkers: (model, markerOwner, markers: MonacoMarkerData[]) =>
          monaco.editor.setModelMarkers(model, markerOwner, markers as unknown as monaco.editor.IMarkerData[])
      });
      // Wrap onNotification so `this` stays bound to the connection (it is a class method).
      const router = createDiagnosticsRouter({
        onNotification: (method, handler) => connection.onNotification(method, handler),
        sink
      });
      const pendingClears = new Set<number>();
      const clearBuiltInMarkers = () => {
        router.clearBuiltInMarkers();
        // Monaco's TS/JS worker can still publish diagnostics it computed before the LSP lease
        // disabled built-in diagnostics. Clear again after those in-flight worker results settle.
        for (const delayMs of [0, 250, 1000]) {
          const handle = window.setTimeout(() => {
            pendingClears.delete(handle);
            router.clearBuiltInMarkers();
          }, delayMs);
          pendingClears.add(handle);
        }
      };
      clearBuiltInMarkers();
      return {
        applyPull: router.applyPull,
        clearBuiltInMarkers,
        dispose: () => {
          for (const handle of pendingClears) {
            window.clearTimeout(handle);
          }
          pendingClears.clear();
          router.dispose();
        }
      };
    }
  };
}
