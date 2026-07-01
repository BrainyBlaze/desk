import { describe, expect, it } from 'vitest';
import { WatchRegistry, parseWatchMessage } from '../src/server/fsWatchBridge';

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
