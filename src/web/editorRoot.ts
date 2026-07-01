/**
 * Cross-subsystem editor-root signal. The git subsystem scans repositories
 * under the editor's root but reads settings only once at its lazy boot —
 * without this signal a root change in the explorer left git scoped to the
 * old root until a full page reload. The editor publishes interactive root
 * changes here (boot/restore roots are not published: both subsystems read
 * the same persisted settings on boot) and git rescans on it. Same
 * module-level pub/sub shape as gitRevision: hidden-mounted subsystems can
 * both write and subscribe without prop drilling through App.
 */
import { useSyncExternalStore } from 'react';

let editorRoot: string | null = null;
const listeners = new Set<() => void>();

export function publishEditorRoot(root: string): void {
  if (root === editorRoot) {
    return;
  }
  editorRoot = root;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getEditorRoot(): string | null {
  return editorRoot;
}

export function subscribeEditorRoot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEditorRoot(): string | null {
  return useSyncExternalStore(subscribeEditorRoot, getEditorRoot);
}
