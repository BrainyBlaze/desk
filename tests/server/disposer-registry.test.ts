import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDisposerRegistry } from '../../src/server/disposerRegistry.js';

describe('createDisposerRegistry', () => {
  it('binds one close listener and disposes every registration once in order', () => {
    const server = new EventEmitter();
    const registry = createDisposerRegistry();
    const calls: string[] = [];

    registry.add(() => calls.push('first'));
    registry.add(() => calls.push('second'));
    registry.bind(server);
    registry.bind(server);
    expect(server.listenerCount('close')).toBe(1);

    server.emit('close');
    server.emit('close');
    registry.dispose();
    expect(calls).toEqual(['first', 'second']);
  });

  it('continues disposal when one registration throws', () => {
    const registry = createDisposerRegistry();
    const after = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    registry.add(() => {
      throw new Error('dispose failed');
    });
    registry.add(after);
    registry.dispose();

    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('[desk-api] disposer failed:', expect.any(Error));
    error.mockRestore();
  });
});
