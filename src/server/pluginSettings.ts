import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  readManifestFile,
  resolveManifestPath,
  serializeDeskManifest,
  updateManifestFileSync
} from '../core/config.js';
import type { DeskManifest } from '../core/types.js';

export type ManifestRepositorySnapshot =
  | { status: 'ready'; revision: number; manifest: DeskManifest }
  | { status: 'error'; revision: number; error: string };

export type PluginSettingsState =
  | { status: 'ready'; revision: number; value: unknown }
  | { status: 'error'; revision: number; error: string };

export interface PluginSettingsStore {
  get(): unknown;
  state(): PluginSettingsState;
  set(value: unknown): void;
  subscribe(listener: (value: unknown) => void): () => void;
  subscribeState(listener: (state: PluginSettingsState) => void): () => void;
  dispose(): void;
}

export interface ManifestRepository {
  snapshot(): ManifestRepositorySnapshot;
  refresh(): void;
  pluginSettings(pluginName: string): PluginSettingsStore;
  dispose(): void;
}

interface ManifestRepositoryOptions {
  watchDirectory?: typeof watch;
  debounceMs?: number;
}

const DEFAULT_WATCH_DEBOUNCE_MS = 60;
const RESERVED_PLUGIN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settingsState(
  snapshot: ManifestRepositorySnapshot,
  pluginName: string
): PluginSettingsState {
  return snapshot.status === 'ready'
    ? {
        status: 'ready',
        revision: snapshot.revision,
        value: snapshot.manifest.plugins?.[pluginName]
      }
    : snapshot;
}

function serializeSettings(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

function assertPluginName(pluginName: string): void {
  if (pluginName.trim() === '' || RESERVED_PLUGIN_NAMES.has(pluginName)) {
    throw new Error(`invalid Desk plugin name: ${JSON.stringify(pluginName)}`);
  }
}

export function createManifestRepository(
  manifestPath = resolveManifestPath(),
  options: ManifestRepositoryOptions = {}
): ManifestRepository {
  const watchDirectory = options.watchDirectory ?? watch;
  const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const listeners = new Set<(snapshot: ManifestRepositorySnapshot) => void>();
  let watcher: FSWatcher | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let revision = 0;
  let canonical = '';
  let current: ManifestRepositorySnapshot;

  function readSnapshot(): ManifestRepositorySnapshot {
    try {
      const manifest = readManifestFile(manifestPath);
      return { status: 'ready', revision, manifest };
    } catch (error) {
      return { status: 'error', revision, error: errorMessage(error) };
    }
  }

  current = readSnapshot();
  if (current.status === 'ready') {
    canonical = serializeDeskManifest(current.manifest);
  }

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        console.error('manifest repository listener failed:', error);
      }
    }
  }

  function publishReady(manifest: DeskManifest): void {
    const nextCanonical = serializeDeskManifest(manifest);
    if (current.status === 'ready' && nextCanonical === canonical) {
      return;
    }
    canonical = nextCanonical;
    current = { status: 'ready', revision: ++revision, manifest };
    notify();
  }

  function publishError(error: unknown): void {
    const message = errorMessage(error);
    if (current.status === 'error' && current.error === message) {
      return;
    }
    canonical = '';
    current = { status: 'error', revision: ++revision, error: message };
    notify();
  }

  function refresh(): void {
    if (disposed) {
      return;
    }
    try {
      publishReady(readManifestFile(manifestPath));
    } catch (error) {
      publishError(error);
    }
  }

  function ensureWatch(): void {
    if (watcher || disposed) {
      return;
    }
    const directory = dirname(manifestPath);
    const file = basename(manifestPath);
    mkdirSync(directory, { recursive: true });
    watcher = watchDirectory(directory, (_event, changed) => {
      if (changed !== null && changed !== file) {
        return;
      }
      if (pending) {
        clearTimeout(pending);
      }
      pending = setTimeout(refresh, debounceMs);
      pending.unref?.();
    });
    watcher.on('error', publishError);
    watcher.unref?.();
  }

  function subscribe(listener: (snapshot: ManifestRepositorySnapshot) => void): () => void {
    if (disposed) {
      throw new Error('manifest repository is disposed');
    }
    listeners.add(listener);
    ensureWatch();
    return () => listeners.delete(listener);
  }

  function setPluginSettings(pluginName: string, value: unknown): void {
    if (disposed) {
      throw new Error('manifest repository is disposed');
    }
    const manifest = updateManifestFileSync(manifestPath, (existing) => ({
      ...existing,
      plugins: { ...existing.plugins, [pluginName]: value }
    }));
    if (manifest === null) {
      throw new Error('plugin settings update unexpectedly produced no manifest');
    }
    publishReady(manifest);
  }

  function pluginSettings(pluginName: string): PluginSettingsStore {
    assertPluginName(pluginName);
    const valueListeners = new Set<(value: unknown) => void>();
    const stateListeners = new Set<(state: PluginSettingsState) => void>();
    let unsubscribeRepository: (() => void) | undefined;
    let viewDisposed = false;
    let lastValue = current.status === 'ready'
      ? serializeSettings(current.manifest.plugins?.[pluginName])
      : undefined;

    function onSnapshot(snapshot: ManifestRepositorySnapshot): void {
      const state = settingsState(snapshot, pluginName);
      for (const listener of stateListeners) {
        try {
          listener(state);
        } catch (error) {
          console.error(`plugin settings state listener (${pluginName}) failed:`, error);
        }
      }
      if (state.status === 'error') {
        lastValue = undefined;
        return;
      }
      const serialized = serializeSettings(state.value);
      if (serialized === lastValue) {
        return;
      }
      lastValue = serialized;
      for (const listener of valueListeners) {
        try {
          listener(state.value);
        } catch (error) {
          console.error(`plugin settings listener (${pluginName}) failed:`, error);
        }
      }
    }

    function ensureSubscription(): void {
      if (!unsubscribeRepository) {
        unsubscribeRepository = subscribe(onSnapshot);
      }
    }

    function ensureViewActive(): void {
      if (viewDisposed) {
        throw new Error(`plugin settings view is disposed: ${pluginName}`);
      }
    }

    return {
      get(): unknown {
        ensureViewActive();
        const state = settingsState(current, pluginName);
        if (state.status === 'error') {
          throw new Error(`desk manifest unavailable: ${state.error}`);
        }
        return state.value;
      },
      state(): PluginSettingsState {
        ensureViewActive();
        return settingsState(current, pluginName);
      },
      set(value: unknown): void {
        ensureViewActive();
        setPluginSettings(pluginName, value);
      },
      subscribe(listener: (value: unknown) => void): () => void {
        ensureViewActive();
        valueListeners.add(listener);
        ensureSubscription();
        return () => valueListeners.delete(listener);
      },
      subscribeState(listener: (state: PluginSettingsState) => void): () => void {
        ensureViewActive();
        stateListeners.add(listener);
        ensureSubscription();
        return () => stateListeners.delete(listener);
      },
      dispose(): void {
        if (viewDisposed) {
          return;
        }
        viewDisposed = true;
        unsubscribeRepository?.();
        unsubscribeRepository = undefined;
        valueListeners.clear();
        stateListeners.clear();
      }
    };
  }

  return {
    snapshot: () => current,
    refresh,
    pluginSettings,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
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
