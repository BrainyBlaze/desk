import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { installLspWebSocketBridge, type LspVirtualSession } from '../src/server/lspWebSocketBridge';
import { createEditorSharedSessionFactory } from '../src/server/lsp/editorSharedSessionFactory';
import { LspManager } from '../src/server/lsp/manager';
import { LspSessionPool } from '../src/server/lsp/sessionPool';

let sockets: WebSocket[] = [];

class FakeLspSession implements LspVirtualSession {
  readonly capabilities = { hoverProvider: true };
  readonly disposed = vi.fn();
  private readonly serverMessageHandlers: Array<(message: unknown) => void> = [];
  private readonly exitHandlers: Array<(exit: { code: number | null; signal: string | null }) => void> = [];

  sendClientMessage(): void {
    // not needed in endpoint test
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
}

class FakeSharedSession implements LspVirtualSession {
  readonly capabilities: Record<string, unknown>;
  readonly sent: unknown[] = [];
  readonly disposed = vi.fn();
  private readonly serverMessageHandlers: Array<(message: unknown) => void> = [];
  private readonly exitHandlers: Array<(exit: { code: number | null; signal: string | null }) => void> = [];

  constructor(capabilities: Record<string, unknown> = { hoverProvider: true, label: 'shared' }) {
    this.capabilities = capabilities;
  }

  sendClientMessage(message: unknown): void {
    this.sent.push(message);
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
    for (const listener of this.serverMessageHandlers) {
      listener(message);
    }
  }

  exit(exit: { code: number | null; signal: string | null }): void {
    for (const listener of this.exitHandlers) {
      listener(exit);
    }
  }
}

describe('lsp websocket endpoint', () => {
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

  it('mounts /ws/lsp and sends ready capabilities', async () => {
    server = createServer();
    const session = new FakeLspSession();
    dispose = installLspWebSocketBridge(server, { createSession: () => session });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));

    const ws = openWs(server, '/ws/lsp?workspaceRoot=%2Fworkspace');

    expect(await nextJsonMessage(ws)).toEqual({ type: 'ready', capabilities: { hoverProvider: true } });
  });

  it('disposes an active session from the HTTP server close hook', async () => {
    server = createServer();
    const session = new FakeLspSession();
    dispose = installLspWebSocketBridge(server, { createSession: () => session });
    server.once('close', dispose);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const ws = openWs(server, '/ws/lsp?workspaceRoot=%2Fworkspace');
    await nextJsonMessage(ws);

    server.emit('close');
    await nextClose(ws);

    expect(session.disposed).toHaveBeenCalledTimes(1);
  });

  it('round-trips ready, raw requests, and natural exits through the shared manager-backed websocket session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-lsp-shared-ws-'));
    const virtual = new FakeSharedSession();
    const manager = new LspManager(new LspSessionPool({ createSession: async () => virtual }), { idleTimeoutMs: 10 });
    server = createServer();
    dispose = installLspWebSocketBridge(server, {
      createSession: createEditorSharedSessionFactory({
        manager,
        readManifest: () => manifest({ maxSessions: 1 })
      })
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));

    try {
      const uri = pathToFileURL(join(root, 'sample.ts')).href;
      const ws = openWs(
        server,
        `/ws/lsp?workspaceRoot=${encodeURIComponent(root)}&uri=${encodeURIComponent(uri)}&languageId=typescript`
      );

      expect(await nextJsonMessage(ws)).toEqual({
        type: 'ready',
        capabilities: { hoverProvider: true, label: 'shared' }
      });

      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { textDocument: { uri } } }));
      await vi.waitFor(() =>
        expect(virtual.sent.some((message: any) => message.method === 'textDocument/hover')).toBe(true)
      );
      const request = virtual.sent.find((message: any) => message.method === 'textDocument/hover') as any;
      virtual.emitServerMessage({ jsonrpc: '2.0', id: request.id, result: { contents: 'shared hover' } });

      expect(await nextJsonMessage(ws)).toEqual({ jsonrpc: '2.0', id: 1, result: { contents: 'shared hover' } });

      const exitMessages: unknown[] = [];
      ws.on('message', (data) => exitMessages.push(JSON.parse(String(data))));
      virtual.exit({ code: 7, signal: null });
      await vi.waitFor(() => expect(exitMessages).toHaveLength(2));
      expect(exitMessages[0]).toMatchObject({
        type: 'status',
        state: 'restarting',
        serverConfigId: 'typescript',
        workspaceRoot: root,
        languageId: 'typescript',
        restart: { state: 'restarting', attempt: 1, maxAttempts: 3 }
      });
      expect(exitMessages[1]).toEqual({
        type: 'exit',
        code: 7,
        signal: null,
        restart: { state: 'restarting', attempt: 1, maxAttempts: 3 }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      await manager.stopAll();
    }
  });

  it('keeps websocket maxSessions over-capacity as a 1011 close before ready on the shared path', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-shared-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-shared-second-'));
    const manager = new LspManager(new LspSessionPool({ createSession: async () => new FakeSharedSession() }), {
      idleTimeoutMs: 10,
      maxSessions: 4
    });
    server = createServer();
    dispose = installLspWebSocketBridge(server, {
      createSession: createEditorSharedSessionFactory({
        manager,
        readManifest: () => manifest({ maxSessions: 1 })
      })
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));

    try {
      const first = openWs(server, `/ws/lsp?workspaceRoot=${encodeURIComponent(firstRoot)}&languageId=typescript`);
      expect(await nextJsonMessage(first)).toMatchObject({ type: 'ready' });

      const second = openWs(server, `/ws/lsp?workspaceRoot=${encodeURIComponent(secondRoot)}&languageId=typescript`);
      expect(await nextClose(second)).toEqual({ code: 1011, reason: 'lsp session start failed' });
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
      await manager.stopAll();
    }
  });
});

function openWs(server: Server | undefined, path: string): WebSocket {
  if (!server) {
    throw new Error('server not started');
  }
  const { port } = server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  sockets.push(ws);
  return ws;
}

function manifest(options: { maxSessions: number }): any {
  return {
    settings: {
      lsp: {
        enabled: true,
        languages: ['typescript'],
        maxSessions: options.maxSessions,
        serverCommands: {
          typescript: {
            enabled: true,
            command: 'typescript-language-server',
            args: ['--stdio'],
            env: {},
            languageIds: ['typescript'],
            extensions: ['.ts']
          }
        }
      }
    },
    groups: []
  };
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
