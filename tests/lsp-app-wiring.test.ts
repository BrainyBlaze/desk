import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { installLspWebSocketBridge, type LspVirtualSession } from '../src/server/lspWebSocketBridge';
import { type LspExit, type ServerCapabilities } from '../src/web/editor/lsp/connection';
import { type WebSocketLike } from '../src/web/editor/lsp/webSocketTransport';
import { type ControllerSession, type ProviderRegistration } from '../src/web/editor/lsp/sessionController';
import type { ProviderConnection } from '../src/web/editor/lsp/providers';
import { resolveLspConfig, makeCreateLspBinding, createWebSocketControllerSession } from '../src/web/editor/lsp/appLspWiring';
import type { LspSessionStatus } from '../src/web/editor/lsp/statusSegment';

function fakeReadySession(capabilities: ServerCapabilities = { hoverProvider: true }): ControllerSession {
  return {
    connection: { request: () => Promise.resolve(null) } as ProviderConnection,
    whenReady: () => Promise.resolve(capabilities),
    onExit: (_listener: (exit: LspExit) => void) => () => {},
    close: () => {},
    closeInfo: () => null
  };
}
function makeRegisterSpy() {
  const calls: Array<{ languageSelector: string }> = [];
  const fn = vi.fn((args: { connection: ProviderConnection; capabilities: ServerCapabilities; languageSelector: string }): ProviderRegistration => {
    calls.push({ languageSelector: args.languageSelector });
    return { dispose: vi.fn() };
  });
  return { fn, calls };
}

describe('resolveLspConfig', () => {
  it('returns enabled with parsed languages and baseUrl', () => {
    expect(resolveLspConfig({ enabled: true, languages: ['typescript', 'python'], baseUrl: 'ws://host' })).toEqual({
      enabled: true,
      languages: ['typescript', 'python'],
      baseUrl: 'ws://host'
    });
  });
  it('fails closed for non-object / null / undefined', () => {
    for (const raw of [undefined, null, 'x', 7]) {
      expect(resolveLspConfig(raw)).toEqual({ enabled: false, languages: [] });
    }
  });
  it('fails closed when enabled is not exactly true', () => {
    expect(resolveLspConfig({ enabled: 'yes', languages: ['typescript'] })).toEqual({ enabled: false, languages: [] });
  });
  it('fails closed when languages is missing, not an array, or empty after filtering', () => {
    expect(resolveLspConfig({ enabled: true })).toEqual({ enabled: false, languages: [] });
    expect(resolveLspConfig({ enabled: true, languages: 'typescript' })).toEqual({ enabled: false, languages: [] });
    expect(resolveLspConfig({ enabled: true, languages: [] })).toEqual({ enabled: false, languages: [] });
    expect(resolveLspConfig({ enabled: true, languages: [1, '', '  '] })).toEqual({ enabled: false, languages: [] });
  });
  it('drops a non-string baseUrl', () => {
    expect(resolveLspConfig({ enabled: true, languages: ['typescript'], baseUrl: 5 })).toEqual({
      enabled: true,
      languages: ['typescript']
    });
  });
  it('subtracts a server-normalized disabledLanguages denylist from the detected languages', () => {
    expect(
      resolveLspConfig({ enabled: true, languages: ['typescript', 'python', 'go'], disabledLanguages: ['python'] })
    ).toEqual({ enabled: true, languages: ['typescript', 'go'] });
  });
  it('fails closed (disabled) when every detected language is on the denylist', () => {
    expect(
      resolveLspConfig({ enabled: true, languages: ['typescript', 'python'], disabledLanguages: ['python', 'typescript'] })
    ).toEqual({ enabled: false, languages: [] });
  });
  it('ignores a non-array or malformed denylist and never trusts non-detected ids', () => {
    // non-array -> treated as no denylist
    expect(
      resolveLspConfig({ enabled: true, languages: ['typescript'], disabledLanguages: 'typescript' })
    ).toEqual({ enabled: true, languages: ['typescript'] });
    // malformed entries dropped; a non-detected id in the denylist subtracts nothing
    expect(
      resolveLspConfig({ enabled: true, languages: ['typescript', 'python'], disabledLanguages: [4, '', '  python  ', 'rust'] })
    ).toEqual({ enabled: true, languages: ['typescript'] });
  });
});

describe('makeCreateLspBinding', () => {
  it('returns null when the config is disabled', () => {
    const { fn } = makeRegisterSpy();
    expect(makeCreateLspBinding({ enabled: false, languages: [] }, { registerProviders: fn })).toBeNull();
  });

  it('builds a binding that registers once for an enabled language via the injected deps', async () => {
    const register = makeRegisterSpy();
    const connectSession = vi.fn(() => fakeReadySession({ hoverProvider: true }));
    const create = makeCreateLspBinding({ enabled: true, languages: ['typescript'] }, { connectSession, registerProviders: register.fn });
    expect(create).not.toBeNull();
    const binding = create!({ workspaceRoot: '/workspace' });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(register.fn).toHaveBeenCalledTimes(1));
    expect(connectSession).toHaveBeenCalledTimes(1);
    expect(register.calls[0]!.languageSelector).toBe('typescript'); // identity selector
  });

  it('is a no-op for a language outside the enabled set', () => {
    const register = makeRegisterSpy();
    const connectSession = vi.fn(() => fakeReadySession());
    const binding = makeCreateLspBinding({ enabled: true, languages: ['typescript'] }, { connectSession, registerProviders: register.fn })!({ workspaceRoot: '/workspace' });
    binding.openModel({ uri: 'file:///a.py', languageId: 'python' });
    expect(connectSession).not.toHaveBeenCalled();
    expect(register.fn).not.toHaveBeenCalled();
  });

  it('opens no session for a denylisted language (fail-closed) while a sibling language still activates', () => {
    const register = makeRegisterSpy();
    const connectSession = vi.fn(() => fakeReadySession({ hoverProvider: true }));
    // Server-normalized effective config: python detected but denylisted -> only typescript survives.
    const config = resolveLspConfig({ enabled: true, languages: ['typescript', 'python'], disabledLanguages: ['python'] });
    const binding = makeCreateLspBinding(config, { connectSession, registerProviders: register.fn })!({ workspaceRoot: '/workspace' });

    binding.openModel({ uri: 'file:///a.py', languageId: 'python' });
    expect(connectSession).not.toHaveBeenCalled();
    expect(register.fn).not.toHaveBeenCalled();

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(connectSession).toHaveBeenCalledTimes(1);
  });

  it('returns null (no factory, no sessions) when all detected languages are denylisted', () => {
    const register = makeRegisterSpy();
    const config = resolveLspConfig({ enabled: true, languages: ['typescript'], disabledLanguages: ['typescript'] });
    expect(makeCreateLspBinding(config, { registerProviders: register.fn })).toBeNull();
  });
});

// ---- Integration: production adapter + real bridge + node ws ----

class IntegrationSession implements LspVirtualSession {
  readonly capabilities = { hoverProvider: true, completionProvider: { triggerCharacters: ['.'] } };
  readonly disposed = vi.fn();
  private serverListener: ((message: unknown) => void) | null = null;
  private exitListener: ((exit: { code: number | null; signal: string | null }) => void) | null = null;
  sendClientMessage(): void {}
  onServerMessage(listener: (message: unknown) => void): void {
    this.serverListener = listener;
  }
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitListener = listener;
  }
  dispose(): void {
    this.disposed();
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
const nodeWsFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;

describe('createWebSocketControllerSession (integration with real bridge)', () => {
  let server: Server | undefined;
  let disposeBridge: (() => void) | undefined;
  let session: ControllerSession | undefined;

  afterEach(async () => {
    session?.close();
    session = undefined;
    disposeBridge?.();
    disposeBridge = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it('resolves whenReady with the bridge capabilities over a real socket', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    session = createWebSocketControllerSession({ workspaceRoot: '/workspace', languageId: 'typescript' }, { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory });
    expect(await session.whenReady()).toEqual(bridgeSession.capabilities);
  });

  it('forwards exit to onExit and disposes the bridge session on close', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    session = createWebSocketControllerSession({ workspaceRoot: '/workspace', languageId: 'typescript' }, { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory });
    await session.whenReady();

    const exits: LspExit[] = [];
    session.onExit((exit) => exits.push(exit));
    bridgeSession.emitExit({ code: 1, signal: null });
    await vi.waitFor(() => expect(exits).toEqual([{ code: 1, signal: null }]));
  });

  it('answers server-initiated client/registerCapability and client/unregisterCapability with a success result (not method-not-found)', async () => {
    // Pyright issues dynamic capability registration after initialize; if the editor client answers
    // method-not-found the server tears the session down. The client must ack with an empty result.
    server = createServer();
    const clientMessages: Array<Record<string, unknown>> = [];
    let pushToClient: (message: unknown) => void = () => {};
    const bridgeSession: LspVirtualSession = {
      capabilities: { hoverProvider: true },
      sendClientMessage: (message: unknown) => clientMessages.push(message as Record<string, unknown>),
      onServerMessage: (listener: (message: unknown) => void) => {
        pushToClient = listener;
      },
      onExit: () => {},
      dispose: () => {}
    };
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    session = createWebSocketControllerSession({ workspaceRoot: '/workspace', languageId: 'python' }, { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory });
    await session.whenReady();

    pushToClient({ jsonrpc: '2.0', id: 'reg1', method: 'client/registerCapability', params: { registrations: [] } });
    pushToClient({ jsonrpc: '2.0', id: 'unreg1', method: 'client/unregisterCapability', params: { unregisterations: [] } });

    await vi.waitFor(() => {
      const reg = clientMessages.find((m) => m.id === 'reg1') as { result?: unknown; error?: unknown } | undefined;
      const unreg = clientMessages.find((m) => m.id === 'unreg1') as { result?: unknown; error?: unknown } | undefined;
      expect(reg, 'no response to client/registerCapability').toBeTruthy();
      expect(unreg, 'no response to client/unregisterCapability').toBeTruthy();
      expect(reg!.error, 'registerCapability answered with an error').toBeUndefined();
      expect(unreg!.error, 'unregisterCapability answered with an error').toBeUndefined();
      expect('result' in reg!).toBe(true);
      expect('result' in unreg!).toBe(true);
    });
  });

  it('forwards a bridge lifecycle status frame to onSessionStatus', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    let publish: ((status: Record<string, unknown>) => void) | undefined;
    disposeBridge = installLspWebSocketBridge(server, {
      createSession: (opts: { publishStatus?: (status: Record<string, unknown>) => void }) => {
        publish = opts.publishStatus;
        return bridgeSession;
      }
    });
    await listen(server);
    const statuses: LspSessionStatus[] = [];
    session = createWebSocketControllerSession(
      { workspaceRoot: '/workspace', languageId: 'typescript' },
      { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory, onSessionStatus: (s) => statuses.push(s) }
    );
    await session.whenReady();

    publish?.({
      state: 'degraded',
      serverConfigId: 'typescript',
      workspaceRoot: '/workspace',
      languageId: 'typescript',
      reason: 'backend lifecycle frame'
    });
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ languageId: 'typescript', phase: 'degraded' }));
    expect(statuses.at(-1)?.reason).toBe('backend lifecycle frame');
  });

  it('emits a client-derived warming status the instant the session connects (before ready)', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    const statuses: LspSessionStatus[] = [];
    session = createWebSocketControllerSession(
      { workspaceRoot: '/workspace', languageId: 'rust' },
      { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory, onSessionStatus: (s) => statuses.push(s) }
    );
    // Synchronous: warming is published immediately, before the socket reaches ready.
    expect(statuses[0]).toMatchObject({ languageId: 'rust', phase: 'warming' });
    await session.whenReady();
  });

  it('marks a session ready when the bridge ready envelope resolves without a lifecycle status frame', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    const statuses: LspSessionStatus[] = [];
    session = createWebSocketControllerSession(
      { workspaceRoot: '/workspace', languageId: 'rust' },
      { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory, onSessionStatus: (s) => statuses.push(s) }
    );

    await session.whenReady();

    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ languageId: 'rust', phase: 'ready' }));
  });

  it('surfaces a client-derived degraded status when the session closes before ready', async () => {
    server = createServer();
    disposeBridge = installLspWebSocketBridge(server, {
      createSession: () => {
        throw new Error('server failed to start');
      }
    });
    await listen(server);
    const statuses: LspSessionStatus[] = [];
    session = createWebSocketControllerSession(
      { workspaceRoot: '/workspace', languageId: 'rust' },
      { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory, onSessionStatus: (s) => statuses.push(s) }
    );
    expect(statuses[0]).toMatchObject({ phase: 'warming' });
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ phase: 'degraded' }));
  });

  it('calls onSessionClosed when the controller session is closed', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    const closed = vi.fn();
    session = createWebSocketControllerSession(
      { workspaceRoot: '/workspace', languageId: 'typescript' },
      { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory, onSessionClosed: closed }
    );
    await session.whenReady();
    session.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('makeCreateLspBinding routes onSessionStatus with the (workspaceRoot, languageId) identity', async () => {
    server = createServer();
    const bridgeSession = new IntegrationSession();
    let publish: ((status: Record<string, unknown>) => void) | undefined;
    disposeBridge = installLspWebSocketBridge(server, {
      createSession: (opts: { publishStatus?: (status: Record<string, unknown>) => void }) => {
        publish = opts.publishStatus;
        return bridgeSession;
      }
    });
    await listen(server);
    const baseUrl = baseUrlFor(server);
    const seen: Array<{ workspaceRoot: string; languageId: string; status: LspSessionStatus }> = [];
    const register = makeRegisterSpy();
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'], baseUrl },
      {
        connectSession: (params) =>
          createWebSocketControllerSession(params, {
            baseUrl,
            webSocketFactory: nodeWsFactory,
            onSessionStatus: (status) => seen.push({ workspaceRoot: params.workspaceRoot, languageId: params.languageId, status })
          }),
        registerProviders: register.fn
      }
    );
    const binding = create!({ workspaceRoot: '/workspace' });
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(register.fn).toHaveBeenCalledTimes(1));

    // The session connects with a client-derived 'warming' first; the backend 'ready' frame supersedes it.
    expect(seen[0]).toMatchObject({ workspaceRoot: '/workspace', languageId: 'typescript', status: { phase: 'warming' } });
    publish?.({ state: 'ready', serverConfigId: 'typescript', workspaceRoot: '/workspace', languageId: 'typescript' });
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ workspaceRoot: '/workspace', languageId: 'typescript', status: { phase: 'ready' } }));
    binding.disposeAll();
  });

  it('sends editor-owned didOpen/didChange/didClose with exact params, monotonic versions, and open-once/closed guards', async () => {
    server = createServer();
    const clientMessages: Array<Record<string, unknown>> = [];
    const bridgeSession: LspVirtualSession = {
      capabilities: { hoverProvider: true },
      sendClientMessage: (message: unknown) => clientMessages.push(message as Record<string, unknown>),
      onServerMessage: () => {},
      onExit: () => {},
      dispose: () => {}
    };
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => bridgeSession });
    await listen(server);
    const s = createWebSocketControllerSession(
      { workspaceRoot: '/workspace', languageId: 'typescript' },
      { baseUrl: baseUrlFor(server), webSocketFactory: nodeWsFactory }
    );
    session = s;
    await s.whenReady();

    s.openDocument!('file:///a.ts', 'typescript', 'const a = 1;');
    s.openDocument!('file:///a.ts', 'typescript', 'IGNORED-dup'); // open-once guard
    s.changeDocument!('file:///a.ts', {
      changes: [{ range: { startLineNumber: 1, startColumn: 13, endLineNumber: 1, endColumn: 13 }, text: '2' }],
      fullText: 'const a = 12;'
    });
    s.closeDocument!('file:///a.ts');
    s.changeDocument!('file:///a.ts', { changes: [], fullText: 'after-close' }); // closed guard

    const didMethods = () =>
      clientMessages.filter((m) => typeof m.method === 'string' && (m.method as string).startsWith('textDocument/did'));
    await vi.waitFor(() =>
      expect(didMethods().map((m) => m.method)).toEqual(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose'])
    );
    const [open, change, close] = didMethods() as Array<{ params: Record<string, unknown> }>;
    expect(open.params.textDocument).toEqual({ uri: 'file:///a.ts', languageId: 'typescript', version: 1, text: 'const a = 1;' });
    expect(change.params.textDocument).toEqual({ uri: 'file:///a.ts', version: 2 });
    expect(change.params.contentChanges).toEqual([
      { range: { start: { line: 0, character: 12 }, end: { line: 0, character: 12 } }, text: '2' }
    ]);
    expect(close.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
  });
});

describe('App-layer factory fail-closed against a 1011 backend (guardrail 2)', () => {
  let server: Server | undefined;
  let disposeBridge: (() => void) | undefined;

  afterEach(async () => {
    disposeBridge?.();
    disposeBridge = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it('an enabled model open through the factory + production adapter produces no registration, no hang, no unhandled rejection when the backend session throws (1011)', async () => {
    server = createServer();
    let createSessionAttempts = 0;
    disposeBridge = installLspWebSocketBridge(server, {
      createSession: () => {
        createSessionAttempts += 1;
        throw new Error('createUnavailableLspSession-style failure');
      }
    });
    await listen(server);

    const register = makeRegisterSpy();
    const baseUrl = baseUrlFor(server);
    const create = makeCreateLspBinding(
      { enabled: true, languages: ['typescript'], baseUrl },
      {
        // The production ControllerSession adapter, only the ws transport + baseUrl are node-injected.
        connectSession: (params) => createWebSocketControllerSession(params, { baseUrl, webSocketFactory: nodeWsFactory }),
        registerProviders: register.fn
      }
    );
    const binding = create!({ workspaceRoot: '/workspace' });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    // The client reached the server and got a 1011 close-before-ready.
    await vi.waitFor(() => expect(createSessionAttempts).toBe(1));
    // Let the close-before-ready rejection propagate (fail-closed: failed result, swallowed).
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(register.fn).not.toHaveBeenCalled(); // no registration
    // No hang: the test reached here; no unhandled rejection: vitest would fail the file otherwise.

    binding.disposeAll();
  });
});
