import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  installLspWebSocketBridge,
  type LspVirtualSession,
  type LspVirtualSessionFactoryOptions
} from '../src/server/lspWebSocketBridge';

let sockets: WebSocket[] = [];

class FakeLspSession implements LspVirtualSession {
  readonly sentClientMessages: unknown[] = [];
  readonly disposed = vi.fn();
  readonly capabilities: Record<string, unknown>;
  private readonly serverMessageHandlers: Array<(message: unknown) => void> = [];
  private readonly exitHandlers: Array<(exit: { code: number | null; signal: string | null }) => void> = [];

  constructor(capabilities: Record<string, unknown> = { hoverProvider: true }) {
    this.capabilities = capabilities;
  }

  sendClientMessage(message: unknown): void {
    this.sentClientMessages.push(message);
  }

  onServerMessage(listener: (message: unknown) => void): void {
    this.serverMessageHandlers.push(listener);
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitHandlers.push(listener);
  }

  dispose(): void {
    this.disposed();
  }

  emitServerMessage(message: unknown): void {
    for (const handler of this.serverMessageHandlers) {
      handler(message);
    }
  }

  emitExit(exit: { code: number | null; signal: string | null }): void {
    for (const handler of this.exitHandlers) {
      handler(exit);
    }
  }
}

describe('installLspWebSocketBridge', () => {
  let server: Server | undefined;
  let dispose: (() => void) | undefined;

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    sockets = [];
    dispose?.();
    dispose = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it('upgrades /ws/lsp and sends ready capabilities', async () => {
    const session = new FakeLspSession({ hoverProvider: true });
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(server, '/ws/lsp?workspaceRoot=%2Fworkspace&uri=file%3A%2F%2F%2Fa.ts&languageId=typescript');
    const ready = await nextJsonMessage(ws);

    expect(createSession).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      uri: 'file:///a.ts',
      languageId: 'typescript',
      publishStatus: expect.any(Function)
    });
    expect(ready).toEqual({ type: 'ready', capabilities: { hoverProvider: true } });
  });

  it('queues lifecycle status until after the legacy ready envelope', async () => {
    const session = new FakeLspSession({ hoverProvider: true });
    const createSession = vi.fn((options: LspVirtualSessionFactoryOptions) => {
      options.publishStatus({
        state: 'ready',
        serverConfigId: 'typescript',
        workspaceRoot: '/workspace',
        languageId: 'typescript',
        warm: true
      });
      return session;
    });
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(server, '/ws/lsp?workspaceRoot=%2Fworkspace&languageId=typescript');
    const messages: unknown[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(String(data)));
    });

    await waitFor(() => messages.length >= 2);
    expect(messages[0]).toEqual({ type: 'ready', capabilities: { hoverProvider: true } });
    expect(messages[1]).toEqual({
      type: 'status',
      state: 'ready',
      serverConfigId: 'typescript',
      workspaceRoot: '/workspace',
      languageId: 'typescript',
      warm: true
    });
  });

  it('includes opt-in ready timing telemetry without paths or server secrets', async () => {
    const session = new FakeLspSession({ hoverProvider: true });
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(
      server,
      '/ws/lsp?workspaceRoot=%2Fworkspace&uri=file%3A%2F%2F%2Fa.ts&languageId=typescript&lspTelemetry=1'
    );
    const ready = await nextJsonMessage(ws);

    expect(ready).toMatchObject({ type: 'ready', capabilities: { hoverProvider: true } });
    expect(ready).toHaveProperty('telemetry.ready');
    expect((ready as { telemetry?: unknown }).telemetry).not.toHaveProperty('workspaceRoot');
    expect((ready as { telemetry?: unknown }).telemetry).not.toHaveProperty('uri');
    expect((ready as { telemetry?: unknown }).telemetry).not.toHaveProperty('command');
    expect((ready as { telemetry?: unknown }).telemetry).not.toHaveProperty('env');
    expect((ready as { telemetry?: unknown }).telemetry).not.toHaveProperty('initializationOptions');
    const timings = (ready as { telemetry: { ready: Record<string, unknown> } }).telemetry.ready;
    expect(timings.createSessionMs).toEqual(expect.any(Number));
    expect(timings.acceptToReadyMs).toEqual(expect.any(Number));
    expect(timings.createSessionMs as number).toBeGreaterThanOrEqual(0);
    expect(timings.acceptToReadyMs as number).toBeGreaterThanOrEqual(timings.createSessionMs as number);
  });

  it('does not upgrade other websocket paths', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));

    const [onUpgrade] = server.listeners('upgrade') as Array<(request: IncomingMessage, socket: Duplex, head: Buffer) => void>;
    onUpgrade({ url: '/ws/not-lsp?workspaceRoot=%2Fworkspace' } as IncomingMessage, {} as Duplex, Buffer.alloc(0));

    expect(createSession).not.toHaveBeenCalled();
  });

  it('forwards raw client JSON-RPC messages to the virtual session', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { textDocument: { uri: 'file:///a.ts' } } }));
    await waitFor(() => session.sentClientMessages.length === 1);

    expect(session.sentClientMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'textDocument/hover',
      params: { textDocument: { uri: 'file:///a.ts' } }
    });
  });

  it('forwards $/cancelRequest unchanged', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    ws.send(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } }));
    await waitFor(() => session.sentClientMessages.length === 1);

    expect(session.sentClientMessages[0]).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } });
  });

  it('forwards raw virtual session messages to the websocket', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    session.emitServerMessage({ jsonrpc: '2.0', id: 1, result: { contents: 'hover' } });

    expect(await nextJsonMessage(ws)).toEqual({ jsonrpc: '2.0', id: 1, result: { contents: 'hover' } });
  });

  it('ignores malformed JSON and scalar JSON frames with no response', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    ws.send('not json');
    ws.send('42');
    ws.send('"method"');
    await delay(25);

    expect(session.sentClientMessages).toEqual([]);
    expect(await noMessage(ws)).toBe(true);
  });

  it('closes missing workspaceRoot before creating a session and sends no ready frame', async () => {
    const createSession = vi.fn(() => new FakeLspSession());
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(server, '/ws/lsp');
    const close = await nextClose(ws);

    expect(createSession).not.toHaveBeenCalled();
    expect(close).toEqual({ code: 1008, reason: 'workspaceRoot required' });
  });

  it('closes empty workspaceRoot before creating a session and sends no ready frame', async () => {
    const createSession = vi.fn(() => new FakeLspSession());
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(server, '/ws/lsp?workspaceRoot=');
    const close = await nextClose(ws);

    expect(createSession).not.toHaveBeenCalled();
    expect(close).toEqual({ code: 1008, reason: 'workspaceRoot required' });
  });

  it('closes deterministically when the session factory throws before ready', async () => {
    const createSession = vi.fn(() => {
      throw new Error('boom');
    });
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(server);
    const close = await nextClose(ws);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(close).toEqual({ code: 1011, reason: 'lsp session start failed' });
  });

  it('closes deterministically when the session factory rejects before ready', async () => {
    const createSession = vi.fn(async () => {
      throw new Error('boom');
    });
    ({ server, dispose } = await startBridge(createSession));

    const ws = openWs(server);
    const close = await nextClose(ws);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(close).toEqual({ code: 1011, reason: 'lsp session start failed' });
  });

  it('disposes an async-created session if the websocket closes before createSession resolves and sends no ready frame', async () => {
    const session = new FakeLspSession();
    let resolveSession: (session: FakeLspSession) => void = () => {};
    const createSession = vi.fn(
      () =>
        new Promise<FakeLspSession>((resolve) => {
          resolveSession = resolve;
        })
    );
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    const messages: unknown[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(String(data)));
    });
    await nextOpen(ws);

    ws.close();
    await nextClose(ws);
    await delay(25);
    resolveSession(session);
    await waitFor(() => session.disposed.mock.calls.length === 1);

    expect(session.disposed).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
  });

  it('disposes an async-created session if the bridge is disposed before createSession resolves and sends no ready frame', async () => {
    const session = new FakeLspSession();
    let resolveSession: (session: FakeLspSession) => void = () => {};
    const createSession = vi.fn(
      () =>
        new Promise<FakeLspSession>((resolve) => {
          resolveSession = resolve;
        })
    );
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    const messages: unknown[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(String(data)));
    });
    await nextOpen(ws);

    dispose();
    dispose = undefined;
    const close = await nextClose(ws);
    resolveSession(session);
    await waitFor(() => session.disposed.mock.calls.length === 1);

    expect(close.code).toBe(1001);
    expect(session.disposed).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('forwards virtual session exit and closes the websocket', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    session.emitExit({ code: 7, signal: 'SIGTERM' });

    expect(await nextJsonMessage(ws)).toEqual({ type: 'exit', code: 7, signal: 'SIGTERM' });
    expect((await nextClose(ws)).code).toBe(1000);
  });

  it('disposes the virtual session when the websocket closes', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    ws.close();
    await nextClose(ws);
    await waitFor(() => session.disposed.mock.calls.length === 1);

    expect(session.disposed).toHaveBeenCalledTimes(1);
  });

  it('returns a disposer that closes active sockets, disposes active sessions, and removes the upgrade listener', async () => {
    const session = new FakeLspSession();
    const createSession = vi.fn(() => session);
    ({ server, dispose } = await startBridge(createSession));
    const ws = openWs(server);
    await nextJsonMessage(ws);

    dispose();
    dispose = undefined;
    const close = await nextClose(ws);

    expect(close.code).toBe(1001);
    expect(session.disposed).toHaveBeenCalledTimes(1);
    expect(server.listenerCount('upgrade')).toBe(0);
  });
});

async function startBridge(createSession: (options: LspVirtualSessionFactoryOptions) => LspVirtualSession | Promise<LspVirtualSession>) {
  const server = createServer();
  const dispose = installLspWebSocketBridge(server, { createSession });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, dispose };
}

function openWs(server: Server | undefined, path = '/ws/lsp?workspaceRoot=%2Fworkspace'): WebSocket {
  if (!server) {
    throw new Error('server not started');
  }
  const { port } = server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  return trackSocket(ws);
}

function trackSocket(ws: WebSocket): WebSocket {
  sockets.push(ws);
  return ws;
}

async function nextOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
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

async function nextJsonMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), 1000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function noMessage(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      resolve(true);
    }, 25);
    const onMessage = () => {
      clearTimeout(timer);
      ws.off('error', onError);
      resolve(false);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(error);
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
  });
}

async function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket close')), 1000);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (assertion()) {
      return;
    }
    await delay(5);
  }
  throw new Error('timed out waiting for condition');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
