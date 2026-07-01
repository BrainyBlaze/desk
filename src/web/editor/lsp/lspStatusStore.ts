/**
 * Module-level store of the latest read-only LSP session status per (workspaceRoot, languageId).
 * The integration seam between the headless app-layer wiring (which writes status as the bridge
 * publishes it) and EditorSubsystem (which reads the active file's entry to render a passive status
 * segment). Same idiom as the statusSegments store: a tiny external store with a subscribe hook.
 */

import type { LspSessionStatus } from './statusSegment.js';

const statuses = new Map<string, LspSessionStatus>();
const listeners = new Set<() => void>();

/** Collision-safe key across path/language delimiters (array JSON, same idiom as the controller). */
export function lspStatusKey(workspaceRoot: string, languageId: string): string {
  return JSON.stringify([workspaceRoot, languageId]);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setLspStatus(key: string, status: LspSessionStatus): void {
  statuses.set(key, status);
  notify();
}

export function clearLspStatus(key: string): void {
  if (statuses.delete(key)) {
    notify();
  }
}

export function getLspStatus(key: string): LspSessionStatus | undefined {
  return statuses.get(key);
}

export function subscribeLspStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: drop all stored statuses (listeners are left intact). */
export function resetLspStatusStore(): void {
  statuses.clear();
}
