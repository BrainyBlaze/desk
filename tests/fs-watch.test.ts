import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { WatchRegistry, installFsWatchBridge, parseWatchMessage } from '../src/server/fsWatchBridge';

describe('WatchRegistry', () => {
  it('reports when a path becomes newly watched and fully unwatched', () => {
    const registry = new WatchRegistry();
    expect(registry.add('/a')).toBe(true); // first ref → start watcher
    expect(registry.add('/a')).toBe(false); // second ref → reuse
    expect(registry.remove('/a')).toBe(false); // one ref left
    expect(registry.remove('/a')).toBe(true); // last ref → stop watcher
    expect(registry.remove('/a')).toBe(false); // already gone — no-op
    expect(registry.paths()).toEqual([]);
  });

  it('tracks independent paths', () => {
    const registry = new WatchRegistry();
    registry.add('/a');
    registry.add('/b');
    expect(registry.paths().sort()).toEqual(['/a', '/b']);
  });
});

describe('installFsWatchBridge', () => {
  it('removes its upgrade listener when disposed', () => {
    const server = createServer();
    const before = server.listenerCount('upgrade');
    const dispose = installFsWatchBridge(server);

    expect(server.listenerCount('upgrade')).toBe(before + 1);
    dispose();
    dispose();
    expect(server.listenerCount('upgrade')).toBe(before);
  });

  it('closes oversized raw frames before parsing watch messages', async () => {
    const server = createServer();
    const dispose = installFsWatchBridge(server, { maxPayloadBytes: 128 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/fs`);
    try {
      await waitForOpen(ws);
      const closed = waitForClose(ws);
      ws.send('x'.repeat(129));

      await expect(closed).resolves.toBe(1009);
    } finally {
      ws.terminate();
      dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('parseWatchMessage', () => {
  it('accepts watch/unwatch with a path', () => {
    expect(parseWatchMessage('{"type":"watch","path":"/tmp/x"}')).toEqual({ type: 'watch', path: '/tmp/x' });
    expect(parseWatchMessage('{"type":"unwatch","path":"/tmp/x"}')).toEqual({ type: 'unwatch', path: '/tmp/x' });
  });

  it('rejects malformed messages', () => {
    expect(parseWatchMessage('not json')).toBeNull();
    expect(parseWatchMessage('{"type":"watch"}')).toBeNull();
    expect(parseWatchMessage('{"type":"explode","path":"/x"}')).toBeNull();
  });
});

async function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket open')), 1000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket close')), 1000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
