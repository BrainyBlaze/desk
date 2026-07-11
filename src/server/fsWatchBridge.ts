import type { Server } from 'node:http';
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { WebSocketServer } from 'ws';

export interface WatchMessage {
  type: 'watch' | 'unwatch';
  path: string;
}

export interface FsChangeEvent {
  event: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
  path: string;
  watched: string;
}

/** Refcounting bookkeeping for watched paths (per connection). */
export class WatchRegistry {
  private readonly counts = new Map<string, number>();

  /** @returns true when this path becomes newly watched (start a watcher) */
  add(path: string): boolean {
    const next = (this.counts.get(path) ?? 0) + 1;
    this.counts.set(path, next);
    return next === 1;
  }

  /** @returns true when this path just lost its last reference (stop the watcher) */
  remove(path: string): boolean {
    const current = this.counts.get(path) ?? 0;
    if (current <= 1) {
      const hadRef = current === 1;
      this.counts.delete(path);
      return hadRef;
    }
    this.counts.set(path, current - 1);
    return false;
  }

  paths(): string[] {
    return [...this.counts.keys()];
  }
}

export function parseWatchMessage(raw: string): WatchMessage | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if ((parsed.type === 'watch' || parsed.type === 'unwatch') && typeof parsed.path === 'string' && parsed.path !== '') {
      return { type: parsed.type, path: parsed.path };
    }
    return null;
  } catch {
    return null;
  }
}

const FS_EVENTS: FsChangeEvent['event'][] = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'];
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface FsWatchBridgeOptions {
  maxPayloadBytes?: number;
}

export function installFsWatchBridge(httpServer: Server, options: FsWatchBridgeOptions = {}): () => void {
  const maxPayload = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 'fs watch maxPayloadBytes');
  const wss = new WebSocketServer({ noServer: true, maxPayload });

  const onUpgrade: Parameters<Server['on']>[1] = (request, socket, head) => {
    if (socket.destroyed) {
      return; // already rejected by the central upgrade guard
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname !== '/ws/fs') {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws) => {
    const registry = new WatchRegistry();
    const watchers = new Map<string, FSWatcher>();

    ws.on('message', (data) => {
      const message = parseWatchMessage(String(data));
      if (!message) {
        return;
      }
      if (message.type === 'watch' && registry.add(message.path)) {
        // depth 0: only this directory's direct children (or this single file).
        // Never recursive — watching ~ recursively would melt the host.
        const watcher = watch(message.path, { depth: 0, ignoreInitial: true });
        watcher.on('error', () => {
          // Unreadable paths must not crash the server; the tree simply stops updating.
        });
        watcher.on('all', (event, eventPath) => {
          if (!FS_EVENTS.includes(event as FsChangeEvent['event'])) {
            return;
          }
          const payload: FsChangeEvent = {
            event: event as FsChangeEvent['event'],
            path: eventPath,
            watched: message.path
          };
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(payload));
          }
        });
        watchers.set(message.path, watcher);
      }
      if (message.type === 'unwatch' && registry.remove(message.path)) {
        void watchers.get(message.path)?.close();
        watchers.delete(message.path);
      }
    });

    const closeWatchers = (): void => {
      for (const watcher of watchers.values()) {
        void watcher.close();
      }
      watchers.clear();
    };
    ws.on('close', closeWatchers);
    ws.on('error', closeWatchers);
  });

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    httpServer.off('upgrade', onUpgrade);
    for (const ws of wss.clients) {
      ws.close(1001, 'fs watch bridge disposed');
    }
    wss.close();
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}
