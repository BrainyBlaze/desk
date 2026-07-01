import { describe, expect, it, vi } from 'vitest';
import { LspConnection, LspReadyError, type LspTransport } from '../src/web/editor/lsp/connection';

/** Synchronous in-memory transport: tests push server frames, inspect client sends. */
class FakeTransport implements LspTransport {
  sent: string[] = [];
  private messageListener: ((data: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  close(): void {
    this.closed = true;
  }

  /** Simulate a frame arriving from the bridge. */
  emit(payload: unknown): void {
    this.messageListener?.(JSON.stringify(payload));
  }
  /** Simulate the socket closing. */
  drop(): void {
    this.closeListener?.();
  }
  /** Last frame the client sent, parsed. */
  lastSent(): any {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

describe('LspConnection handshake', () => {
  it('resolves whenReady with the server capabilities from the ready frame', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);

    const capabilities = { hoverProvider: true, completionProvider: { triggerCharacters: ['.'] } };
    transport.emit({ type: 'ready', capabilities });

    await expect(connection.whenReady()).resolves.toEqual(capabilities);
  });

  it('does not dispatch the ready frame as an LSP notification', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const handler = vi.fn();
    connection.onNotification('ready', handler);

    transport.emit({ type: 'ready', capabilities: {} });
    await connection.whenReady();

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('LspConnection request/response', () => {
  it('sends a JSON-RPC request and resolves with the matching response result', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);

    const pending = connection.request('textDocument/hover', { line: 1 });
    const sent = transport.lastSent();
    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'textDocument/hover', params: { line: 1 } });
    expect(typeof sent.id).toBe('number');

    transport.emit({ jsonrpc: '2.0', id: sent.id, result: { contents: 'hi' } });
    await expect(pending).resolves.toEqual({ contents: 'hi' });
  });

  it('rejects the pending request when the response carries an error', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);

    const pending = connection.request('textDocument/definition', {});
    const { id } = transport.lastSent();
    transport.emit({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });

    await expect(pending).rejects.toThrow('method not found');
  });

  it('uses distinct ids for concurrent requests and routes each response', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);

    const first = connection.request('a', {});
    const firstId = transport.lastSent().id;
    const second = connection.request('b', {});
    const secondId = transport.lastSent().id;
    expect(firstId).not.toBe(secondId);

    transport.emit({ jsonrpc: '2.0', id: secondId, result: 'B' });
    transport.emit({ jsonrpc: '2.0', id: firstId, result: 'A' });
    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
  });
});

describe('LspConnection server->client requests', () => {
  it('answers a server request via the registered handler with the same id', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    connection.onRequest('workspace/configuration', () => [{ tabSize: 2 }]);

    transport.emit({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [] } });

    expect(transport.lastSent()).toEqual({ jsonrpc: '2.0', id: 7, result: [{ tabSize: 2 }] });
  });

  it('returns a method-not-found error when no handler is registered', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);

    transport.emit({ jsonrpc: '2.0', id: 9, method: 'window/showMessageRequest', params: {} });

    const sent = transport.lastSent();
    expect(sent.id).toBe(9);
    expect(sent.error.code).toBe(-32601);
  });

  it('awaits async handlers before responding', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    connection.onRequest('workspace/applyEdit', async () => ({ applied: true }));

    transport.emit({ jsonrpc: '2.0', id: 3, method: 'workspace/applyEdit', params: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.lastSent()).toEqual({ jsonrpc: '2.0', id: 3, result: { applied: true } });
  });
});

describe('LspConnection lifecycle', () => {
  it('fires onExit with the code/signal from the exit frame', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const onExit = vi.fn();
    connection.onExit(onExit);

    transport.emit({ type: 'exit', code: 1, signal: null });

    expect(onExit).toHaveBeenCalledWith({ code: 1, signal: null });
  });

  it('rejects in-flight requests when the server exits', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const pending = connection.request('textDocument/hover', {});

    transport.emit({ type: 'exit', code: null, signal: 'SIGTERM' });

    await expect(pending).rejects.toThrow(/exit|closed|gone/i);
  });

  it('rejects in-flight requests and fires onExit when the transport closes', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const onExit = vi.fn();
    connection.onExit(onExit);
    const pending = connection.request('textDocument/definition', {});

    transport.drop();

    await expect(pending).rejects.toThrow(/closed|gone/i);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('LspConnection readiness failure', () => {
  it('rejects whenReady with LspReadyError when the transport closes before the ready frame', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const ready = connection.whenReady();

    transport.drop();

    await expect(ready).rejects.toBeInstanceOf(LspReadyError);
  });

  it('rejects whenReady with LspReadyError when the server exits before the ready frame', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const ready = connection.whenReady();

    transport.emit({ type: 'exit', code: 2, signal: null });

    await expect(ready).rejects.toBeInstanceOf(LspReadyError);
  });

  it('leaves whenReady resolved when an exit arrives after the ready frame', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const capabilities = { hoverProvider: true };
    transport.emit({ type: 'ready', capabilities });
    await expect(connection.whenReady()).resolves.toEqual(capabilities);

    transport.emit({ type: 'exit', code: 1, signal: null });

    await expect(connection.whenReady()).resolves.toEqual(capabilities);
  });

  it('leaves whenReady resolved when the transport closes after the ready frame', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const capabilities = { completionProvider: {} };
    transport.emit({ type: 'ready', capabilities });
    await expect(connection.whenReady()).resolves.toEqual(capabilities);

    transport.drop();

    await expect(connection.whenReady()).resolves.toEqual(capabilities);
  });

  it('settles readiness exactly once across a close followed by an exit', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const onExit = vi.fn();
    connection.onExit(onExit);
    const ready = connection.whenReady();

    transport.drop();
    transport.emit({ type: 'exit', code: 9, signal: null });

    await expect(ready).rejects.toBeInstanceOf(LspReadyError);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('LspConnection cancellation', () => {
  it('aborting an in-flight request sends $/cancelRequest and rejects the pending promise', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const controller = new AbortController();

    const pending = connection.request('textDocument/hover', {}, { signal: controller.signal });
    const { id } = transport.lastSent();
    controller.abort();

    expect(transport.lastSent()).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
    await expect(pending).rejects.toThrow(/cancel/i);
  });

  it('does not send $/cancelRequest if the request already completed', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const controller = new AbortController();

    const pending = connection.request('textDocument/hover', {}, { signal: controller.signal });
    const { id } = transport.lastSent();
    transport.emit({ jsonrpc: '2.0', id, result: 'ok' });
    await expect(pending).resolves.toBe('ok');

    const sentBefore = transport.sent.length;
    controller.abort();
    expect(transport.sent.length).toBe(sentBefore);
  });

  it('rejects immediately without sending the request when the signal is already aborted', async () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const controller = new AbortController();
    controller.abort();

    const pending = connection.request('textDocument/hover', {}, { signal: controller.signal });

    await expect(pending).rejects.toThrow(/cancel/i);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('LspConnection lifecycle status', () => {
  it('delivers a type:"status" envelope to onStatus subscribers', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const seen: unknown[] = [];
    connection.onStatus((status) => seen.push(status));

    transport.emit({ type: 'status', state: 'warming', serverConfigId: 'rust', workspaceRoot: '/repo', languageId: 'rust', warm: true });

    expect(seen).toEqual([
      { state: 'warming', serverConfigId: 'rust', workspaceRoot: '/repo', languageId: 'rust', warm: true }
    ]);
  });

  it('carries a restart payload on a status envelope', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const seen: any[] = [];
    connection.onStatus((status) => seen.push(status));

    transport.emit({
      type: 'status',
      state: 'restarting',
      serverConfigId: 'rust',
      workspaceRoot: '/repo',
      restart: { state: 'restarting', attempt: 1, maxAttempts: 5 }
    });

    expect(seen[0].state).toBe('restarting');
    expect(seen[0].restart).toEqual({ state: 'restarting', attempt: 1, maxAttempts: 5 });
  });

  it('ignores a status envelope with an unknown state (defensive)', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const seen: unknown[] = [];
    connection.onStatus((status) => seen.push(status));

    transport.emit({ type: 'status', state: 'bogus', serverConfigId: 'rust', workspaceRoot: '/repo' });

    expect(seen).toHaveLength(0);
  });

  it('does not dispatch a status envelope as an LSP notification', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const handler = vi.fn();
    connection.onNotification('status', handler);

    transport.emit({ type: 'status', state: 'ready', serverConfigId: 'rust', workspaceRoot: '/repo' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops delivering status after unsubscribe', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    const seen: unknown[] = [];
    const off = connection.onStatus((status) => seen.push(status));

    transport.emit({ type: 'status', state: 'warming', serverConfigId: 'rust', workspaceRoot: '/repo' });
    off();
    transport.emit({ type: 'status', state: 'ready', serverConfigId: 'rust', workspaceRoot: '/repo' });

    expect(seen).toHaveLength(1);
  });

  it('carries restart metadata from an exit frame into the LspExit', () => {
    const transport = new FakeTransport();
    const connection = new LspConnection(transport);
    let exit: any = null;
    connection.onExit((e) => {
      exit = e;
    });

    transport.emit({ type: 'exit', code: null, signal: 'SIGKILL', restart: { state: 'stopped', attempt: 5, maxAttempts: 5 } });

    expect(exit.signal).toBe('SIGKILL');
    expect(exit.restart).toEqual({ state: 'stopped', attempt: 5, maxAttempts: 5 });
  });
});
