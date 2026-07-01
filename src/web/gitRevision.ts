/**
 * Cross-subsystem git change signal. Staging, committing, discarding etc.
 * mutate `.git` — which the fs watcher deliberately does not watch — so the
 * git subsystem bumps this revision after every mutation and the editor's
 * decorations (tree badges, gutter hunks) re-fetch on it. Same module-level
 * pub/sub shape as statusSegments: hidden-mounted subsystems can both write
 * and subscribe without prop drilling through App.
 */
import { useSyncExternalStore } from 'react';

let revision = 0;
const listeners = new Set<() => void>();

export function bumpGitRevision(): void {
  revision += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getGitRevision(): number {
  return revision;
}

export function subscribeGitRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGitRevision(): number {
  return useSyncExternalStore(subscribeGitRevision, getGitRevision);
}
