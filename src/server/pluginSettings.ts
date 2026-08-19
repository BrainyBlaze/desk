// Durable, operator-editable configuration for a plugin.
//
// A plugin today receives only environment variables: process-lifetime,
// invisible to the operator, and immutable while the server runs. The desk
// manifest is the one config file an operator already edits and backs up, and
// it already carries `settings` for exactly this reason — so each plugin gets
// a namespaced section there (`plugins.<name>`), behind three verbs:
//
//   get()          the plugin's section, as last written by anyone
//   set(value)     replace the section, atomically, under the manifest lock
//   subscribe(fn)  be told when the section changes — including when the
//                  operator edits desk.yml by hand while the server runs
//
// Desk never interprets the values. Subscribe watches the manifest's
// DIRECTORY, not the file: manifest writes are atomic replacements, and an
// inode watch dies with the first rename. Notifications fire only when the
// subscribing plugin's own section actually changed, so plugins do not wake
// on every unrelated settings write.

import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readManifestFile, resolveManifestPath, updateManifestFileSync } from '../core/config.js';

export interface PluginSettingsStore {
  get(): unknown;
  set(value: unknown): void;
  subscribe(listener: (value: unknown) => void): () => void;
  /** Stops the file watch. Idempotent; the runtime calls it on close. */
  dispose(): void;
}

const WATCH_DEBOUNCE_MS = 60;

export function createPluginSettingsStore(pluginName: string, manifestPath = resolveManifestPath()): PluginSettingsStore {
  const listeners = new Set<(value: unknown) => void>();
  let watcher: FSWatcher | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastSeen = serialize(read());

  function read(): unknown {
    try {
      return readManifestFile(manifestPath).plugins?.[pluginName];
    } catch {
      // An unreadable manifest is a config problem, not this plugin's crash.
      return undefined;
    }
  }

  function serialize(value: unknown): string {
    return JSON.stringify(value) ?? 'undefined';
  }

  function notifyIfChanged(): void {
    const value = read();
    const seen = serialize(value);
    if (seen === lastSeen) {
      return;
    }
    lastSeen = seen;
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error(`plugin settings listener (${pluginName}) failed:`, error);
      }
    }
  }

  function ensureWatch(): void {
    if (watcher) {
      return;
    }
    const file = basename(manifestPath);
    watcher = watch(dirname(manifestPath), (_event, changed) => {
      if (changed !== null && changed !== file) {
        return;
      }
      if (pending) {
        clearTimeout(pending);
      }
      pending = setTimeout(notifyIfChanged, WATCH_DEBOUNCE_MS);
      pending.unref?.();
    });
    watcher.unref?.();
  }

  return {
    get: read,
    set(value: unknown): void {
      updateManifestFileSync(manifestPath, (manifest) => ({
        ...manifest,
        plugins: { ...manifest.plugins, [pluginName]: value }
      }));
      // Local writers hear about it synchronously; the watch stays the door
      // for external edits and is deduped by lastSeen either way.
      notifyIfChanged();
    },
    subscribe(listener: (value: unknown) => void): () => void {
      listeners.add(listener);
      ensureWatch();
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (pending) {
        clearTimeout(pending);
        pending = undefined;
      }
      watcher?.close();
      watcher = undefined;
      listeners.clear();
    }
  };
}
