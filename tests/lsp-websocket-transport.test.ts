import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { installLspWebSocketBridge, type LspVirtualSession } from '../src/server/lspWebSocketBridge';
import { LspConnection, LspReadyError } from '../src/web/editor/lsp/connection';
import { createLspWebSocketTransport, type WebSocketLike } from '../src/web/editor/lsp/webSocketTransport';
import { perfReset, perfSnapshot, setPerfEnabled } from '../src/web/editor/lsp/perfTelemetry';

/** Controllable fake of the WebSocketLike surface for unit tests. */
class FakeWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  private readonly handlers: Record<string, Array<(event?: unknown) => void>> = {};

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }
  private emit(type: string, event?: unknown): void {
    for (const listener of this.handlers[type] ?? []) {
      listener(event);
    }
  }
  fireOpen(): void {
    this.readyState = 1; // OPEN
    this.emit('open');
  }
  fireMessage(data: string): void {
    this.emit('message', { data });
  }
  fireClose(code: number, reason: string): void {
    this.emit('close', { code, reason });
  }
}

describe('createLspWebSocketTransport (unit)', () => {
  it('builds the /ws/lsp URL with workspaceRoot and forwards the ready envelope to LspConnection', async () => {
    let capturedUrl = '';
    const fake = new FakeWebSocket();
    const transport = createLspWebSocketTransport({
      workspaceRoot: '/work',
      baseUrl: 'ws://host:1234',
      webSocketFactory: (url) => {
        capturedUrl = url;
        return fake;
      }
    });
    const parsed = new URL(capturedUrl);
    expect(parsed.protocol).toBe('ws:');
    expect(parsed.pathname).toBe('/ws/lsp');
    expect(parsed.searchParams.get('workspaceRoot')).toBe('/work');

    const connection = new LspConnection(transport);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify({ type: 'ready', capabilities: { hoverProvider: true } }));
    expect(await connection.whenReady()).toEqual({ hoverProvider: true });
  });

  it('appends lspTelemetry=1 to the /ws/lsp URL only when perf telemetry is enabled', () => {
    const capture = (): string => {
      let url = '';
      createLspWebSocketTransport({
        workspaceRoot: '/work',
        baseUrl: 'ws://host',
        webSocketFactory: (u) => {
          url = u;
          return new FakeWebSocket();
        }
      });
      return url;
    };
    try {
      setPerfEnabled(false);
      expect(new URL(capture()).searchParams.get('lspTelemetry')).toBeNull();
      setPerfEnabled(true);
      expect(new URL(capture()).searchParams.get('lspTelemetry')).toBe('1');
    } finally {
      setPerfEnabled(false);
    }
  });

  it('records backend ready-envelope telemetry from the ready frame into the perf snapshot', () => {
    try {
      setPerfEnabled(true);
      perfReset();
      const fake = new FakeWebSocket();
      const transport = createLspWebSocketTransport({
        workspaceRoot: '/work',
        baseUrl: 'ws://host',
        webSocketFactory: () => fake
      });
      const connection = new LspConnection(transport);
      void connection.whenReady();
      fake.fireOpen();
      fake.fireMessage(
        JSON.stringify({ type: 'ready', capabilities: {}, telemetry: { ready: { createSessionMs: 12.5, acceptToReadyMs: 7.25 } } })
      );
      const snap = perfSnapshot();
      expect(snap.backendCreateSessionMs).toBe(12.5);
      expect(snap.backendAcceptToReadyMs).toBe(7.25);
    } finally {
      setPerfEnabled(false);
      perfReset();
    }
  });

  it('encodes workspaceRoot, uri, and languageId and round-trips through URL parsing', () => {
    let capturedUrl = '';
    createLspWebSocketTransport({
      workspaceRoot: '/work space',
      uri: 'file:///a.ts',
      languageId: 'typescript',
      baseUrl: 'ws://host',
      webSocketFactory: (url) => {
        capturedUrl = url;
        return new FakeWebSocket();
      }
    });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('workspaceRoot')).toBe('/work space');
    expect(params.get('uri')).toBe('file:///a.ts');
    expect(params.get('languageId')).toBe('typescript');
  });

  it('omits uri and languageId when not provided', () => {
    let capturedUrl = '';
    createLspWebSocketTransport({
      workspaceRoot: '/w',
      baseUrl: 'ws://host',
      webSocketFactory: (url) => {
        capturedUrl = url;
        return new FakeWebSocket();
      }
    });
    const params = new URL(capturedUrl).searchParams;
    expect(params.has('uri')).toBe(false);
    expect(params.has('languageId')).toBe(false);
  });

  it('rejects empty or whitespace workspaceRoot before opening a socket', () => {
    const factory = vi.fn();
    expect(() => createLspWebSocketTransport({ workspaceRoot: '', webSocketFactory: factory })).toThrow();
    expect(() => createLspWebSocketTransport({ workspaceRoot: '   ', webSocketFactory: factory })).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('buffers sends before OPEN and flushes them in order on open', () => {
    const fake = new FakeWebSocket();
    const transport = createLspWebSocketTransport({
      workspaceRoot: '/w',
      baseUrl: 'ws://host',
      webSocketFactory: () => fake
    });
    transport.send('a');
    transport.send('b');
    expect(fake.sent).toEqual([]);
    fake.fireOpen();
    expect(fake.sent).toEqual(['a', 'b']);
    transport.send('c');
    expect(fake.sent).toEqual(['a', 'b', 'c']);
  });

  it('forwards message frames to onMessage listeners', () => {
    const fake = new FakeWebSocket();
    const transport = createLspWebSocketTransport({ workspaceRoot: '/w', baseUrl: 'ws://host', webSocketFactory: () => fake });
    const received: string[] = [];
    transport.onMessage((data) => received.push(data));
    fake.fireOpen();
    fake.fireMessage('{"jsonrpc":"2.0"}');
    expect(received).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it('fires onClose once and records closeInfo, and is idempotent on repeat close()', () => {
    const fake = new FakeWebSocket();
    const transport = createLspWebSocketTransport({ workspaceRoot: '/w', baseUrl: 'ws://host', webSocketFactory: () => fake });
    let closeCount = 0;
    transport.onClose(() => (closeCount += 1));
    expect(transport.closeInfo()).toBeNull();
    fake.fireOpen();
    transport.close();
    transport.close();
    expect(closeCount).toBe(1);
    expect(transport.closeInfo()).not.toBeNull();
  });

  it('records the server close code/reason (e.g. 1008) in closeInfo', () => {
    const fake = new FakeWebSocket();
    const transport = createLspWebSocketTransport({ workspaceRoot: '/w', baseUrl: 'ws://host', webSocketFactory: () => fake });
    transport.onClose(() => {});
    fake.fireClose(1008, 'workspaceRoot required');
    expect(transport.closeInfo()).toEqual({ code: 1008, reason: 'workspaceRoot required' });
  });

  it('suppresses sends after close and does not flush buffered sends if closed before open', () => {
    const fake = new FakeWebSocket();
    const transport = createLspWebSocketTransport({ workspaceRoot: '/w', baseUrl: 'ws://host', webSocketFactory: () => fake });
    transport.send('queued');
    transport.close();
    expect(fake.sent).toEqual([]); // never opened -> nothing flushed
    transport.send('after-close');
    fake.fireOpen(); // late open must not leak the buffered frame
    expect(fake.sent).toEqual([]);
  });
});

// ---- Integration: real bridge (installLspWebSocketBridge) + node ws client ----

class IntegrationSession implements LspVirtualSession {
  readonly capabilities = { hoverProvider: true, completionProvider: { triggerCharacters: ['.'] } };
  readonly disposed = vi.fn();
  readonly clientMessages: unknown[] = [];
  private serverListener: ((message: unknown) => void) | null = null;
  private exitListener: ((exit: { code: number | null; signal: string | null }) => void) | null = null;

  sendClientMessage(message: unknown): void {
    this.clientMessages.push(message);
  }
  onServerMessage(listener: (message: unknown) => void): void {
    this.serverListener = listener;
  }
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitListener = listener;
  }
  dispose(): void {
    this.disposed();
  }
  emitServer(message: unknown): void {
    this.serverListener?.(message);
  }
  emitExit(exit: { code: number | null; signal: string | null }): void {
    this.exitListener?.(exit);
  }
}

function baseUrlFor(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server not listening on a port');
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

describe('createLspWebSocketTransport (integration with real bridge)', () => {
  let server: Server | undefined;
  let disposeBridge: (() => void) | undefined;
  let transport: ReturnType<typeof createLspWebSocketTransport> | undefined;

  afterEach(async () => {
    transport?.close();
    transport = undefined;
    disposeBridge?.();
    disposeBridge = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  const connect = (workspaceRoot: string) => {
    transport = createLspWebSocketTransport({
      workspaceRoot,
      baseUrl: baseUrlFor(server!),
      webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike
    });
    return new LspConnection(transport);
  };

  it('resolves whenReady with the session capabilities (ready envelope over a real socket)', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const connection = connect('/workspace');
    expect(await connection.whenReady()).toEqual(session.capabilities);
  });

  it('round-trips a client request to a server response', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const connection = connect('/workspace');
    await connection.whenReady();

    const pending = connection.request('textDocument/hover', { uri: 'file:///a.ts' });
    await vi.waitFor(() => expect(session.clientMessages.length).toBe(1));
    const clientReq = session.clientMessages[0] as { id: number };
    session.emitServer({ jsonrpc: '2.0', id: clientReq.id, result: { contents: 'hi' } });
    expect(await pending).toEqual({ contents: 'hi' });
  });

  it('passes a raw $/cancelRequest to the session when a request is aborted', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const connection = connect('/workspace');
    await connection.whenReady();

    const controller = new AbortController();
    const pending = connection.request('textDocument/hover', { uri: 'file:///a.ts' }, { signal: controller.signal });
    // Attach the rejection expectation before aborting so the rejection is never momentarily unhandled.
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(session.clientMessages.length).toBe(1));
    controller.abort();
    await vi.waitFor(() =>
      expect(session.clientMessages.some((m) => (m as { method?: string }).method === '$/cancelRequest')).toBe(true)
    );
    await rejected;
  });

  it('forwards a server exit envelope to LspConnection.onExit', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const connection = connect('/workspace');
    await connection.whenReady();

    const exits: Array<{ code: number | null; signal: string | null }> = [];
    connection.onExit((exit) => exits.push(exit));
    session.emitExit({ code: 1, signal: null });
    await vi.waitFor(() => expect(exits).toEqual([{ code: 1, signal: null }]));
  });

  it('rejects whenReady with LspReadyError and records closeInfo 1008 when workspaceRoot is empty at the server', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    // Bypass client-side validation to exercise the server 1008 path: build with a space then assert server close.
    transport = createLspWebSocketTransport({
      workspaceRoot: '/tmp',
      baseUrl: `${baseUrlFor(server)}`,
      webSocketFactory: (url) => new WebSocket(url.replace('workspaceRoot=%2Ftmp', 'workspaceRoot=')) as unknown as WebSocketLike
    });
    const connection = new LspConnection(transport);
    // Attach the rejection expectation before the close lands so it is never momentarily unhandled.
    const rejected = expect(connection.whenReady()).rejects.toBeInstanceOf(LspReadyError);
    await vi.waitFor(() => expect(transport!.closeInfo()?.code).toBe(1008));
    await rejected;
  });

  it('rejects whenReady with LspReadyError and records closeInfo 1011 when the session factory throws', async () => {
    server = createServer();
    disposeBridge = installLspWebSocketBridge(server, {
      createSession: () => {
        throw new Error('boom');
      }
    });
    await listen(server);
    transport = createLspWebSocketTransport({
      workspaceRoot: '/workspace',
      baseUrl: baseUrlFor(server),
      webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike
    });
    const connection = new LspConnection(transport);
    const rejected = expect(connection.whenReady()).rejects.toBeInstanceOf(LspReadyError);
    await vi.waitFor(() => expect(transport!.closeInfo()?.code).toBe(1011));
    await rejected;
  });

  it('disposes: close() closes the socket and the session is disposed on socket close', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const connection = connect('/workspace');
    await connection.whenReady();
    transport!.close();
    await vi.waitFor(() => expect(session.disposed).toHaveBeenCalledTimes(1));
  });
});
