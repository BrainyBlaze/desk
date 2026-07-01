import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { installLspWebSocketBridge, type LspVirtualSession } from '../src/server/lspWebSocketBridge';
import { LspConnection, type LspExit, type ServerCapabilities } from '../src/web/editor/lsp/connection';
import { createLspWebSocketTransport, type WebSocketLike } from '../src/web/editor/lsp/webSocketTransport';
import {
  LspSessionController,
  type ControllerSession,
  type ProviderRegistration
} from '../src/web/editor/lsp/sessionController';
import type { ProviderConnection } from '../src/web/editor/lsp/providers';

/**
 * Controllable fake of a ControllerSession. Mirrors the real LspConnection + transport seam:
 * die() before ready both rejects whenReady() (shape A) and fires exit listeners; after ready it
 * only fires exit listeners. close() is a spy. closeInfo() returns the recorded close code.
 */
class FakeSession implements ControllerSession {
  readonly connection: ProviderConnection = { request: vi.fn(async () => null) };
  readonly close = vi.fn(() => {
    this.closed = true;
  });
  closed = false;

  /** Document-sync recording: ordered log + spies, to assert defer/order/identity-guard. */
  readonly docCalls: string[] = [];
  readonly openDocument = vi.fn((uri: string, _languageId: string, text: string) => {
    this.docCalls.push(`open:${uri}:${text}`);
  });
  readonly changeDocument = vi.fn((uri: string, edit: { fullText: string }) => {
    this.docCalls.push(`change:${uri}:${edit.fullText}`);
  });
  readonly closeDocument = vi.fn((uri: string) => {
    this.docCalls.push(`close:${uri}`);
  });

  private ready = false;
  private resolveReady!: (capabilities: ServerCapabilities) => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyPromise: Promise<ServerCapabilities>;
  private readonly exitListeners = new Set<(exit: LspExit) => void>();
  private lastClose: { code: number; reason: string } | null = null;

  constructor() {
    this.readyPromise = new Promise<ServerCapabilities>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyPromise.catch(() => {});
  }

  whenReady(): Promise<ServerCapabilities> {
    return this.readyPromise;
  }
  onExit(listener: (exit: LspExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  closeInfo(): { code: number; reason: string } | null {
    return this.lastClose;
  }

  fireReady(capabilities: ServerCapabilities): void {
    if (this.ready) {
      return;
    }
    this.ready = true;
    this.resolveReady(capabilities);
  }
  /** Emulate the connection dying. With closeCode set this is a close-before-ready. */
  die(exit: LspExit, closeCode?: number): void {
    if (!this.ready) {
      this.ready = true;
      this.lastClose = closeCode === undefined ? null : { code: closeCode, reason: '' };
      this.rejectReady(new Error('closed before ready'));
    }
    for (const listener of [...this.exitListeners]) {
      listener(exit);
    }
  }
}

function makeRegisterSpy() {
  const registrations: Array<{ dispose: ReturnType<typeof vi.fn>; connection: ProviderConnection; capabilities: ServerCapabilities; languageSelector: unknown }> = [];
  const fn = vi.fn((args: { connection: ProviderConnection; capabilities: ServerCapabilities; languageSelector: unknown }): ProviderRegistration => {
    const reg = { dispose: vi.fn(), ...args };
    registrations.push(reg);
    return reg;
  });
  return { fn, registrations };
}

function makeUnitController() {
  const sessions: FakeSession[] = [];
  const connectSession = vi.fn((_params: { workspaceRoot: string; languageId: string }) => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  });
  const register = makeRegisterSpy();
  const controller = new LspSessionController<string>({ connectSession, registerProviders: register.fn });
  return { controller, sessions, connectSession, register };
}

const SELECTOR = 'typescript';
const CAPS: ServerCapabilities = { hoverProvider: true };

describe('LspSessionController (unit)', () => {
  it('registers providers once when the session becomes ready', async () => {
    const { controller, sessions, register } = makeUnitController();
    const pending = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.fireReady(CAPS);

    const result = await pending;
    expect(result).toEqual({ status: 'ready', capabilities: CAPS });
    expect(register.fn).toHaveBeenCalledTimes(1);
    expect(register.registrations[0]).toMatchObject({ connection: sessions[0]!.connection, capabilities: CAPS, languageSelector: SELECTOR });
  });

  it('dedupes concurrent ensures for the same key (one connect, one registration)', async () => {
    const { controller, sessions, connectSession, register } = makeUnitController();
    const a = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    const b = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    expect(connectSession).toHaveBeenCalledTimes(1);
    sessions[0]!.fireReady(CAPS);

    expect(await a).toEqual({ status: 'ready', capabilities: CAPS });
    expect(await b).toEqual({ status: 'ready', capabilities: CAPS });
    expect(register.fn).toHaveBeenCalledTimes(1);
  });

  it('dedupes a ready session: a later ensure does not re-register', async () => {
    const { controller, connectSession, sessions, register } = makeUnitController();
    const first = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.fireReady(CAPS);
    await first;

    await controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    expect(connectSession).toHaveBeenCalledTimes(1);
    expect(register.fn).toHaveBeenCalledTimes(1);
  });

  it('returns failed with closeInfo and does not register on close-before-ready', async () => {
    const { controller, sessions, register } = makeUnitController();
    const pending = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.die({ code: null, signal: null }, 1011);

    expect(await pending).toEqual({ status: 'failed', closeInfo: { code: 1011, reason: '' } });
    expect(register.fn).not.toHaveBeenCalled();
  });

  it('permits a retry after a failed start (new connect, then registers)', async () => {
    const { controller, sessions, connectSession, register } = makeUnitController();
    const failed = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.die({ code: null, signal: null }, 1008);
    await failed;

    const retry = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    expect(connectSession).toHaveBeenCalledTimes(2);
    sessions[1]!.fireReady(CAPS);
    expect(await retry).toEqual({ status: 'ready', capabilities: CAPS });
    expect(register.fn).toHaveBeenCalledTimes(1);
  });

  it('disposes the registration exactly once on post-ready exit and deletes the entry', async () => {
    const { controller, sessions, connectSession, register } = makeUnitController();
    const first = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.fireReady(CAPS);
    await first;

    sessions[0]!.die({ code: 1, signal: null }); // post-ready exit (no close code)
    expect(register.registrations[0]!.dispose).toHaveBeenCalledTimes(1);

    // entry deleted -> a fresh ensure creates a new session
    controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    expect(connectSession).toHaveBeenCalledTimes(2);
  });

  it('closeSession disposes the registration and closes the session', async () => {
    const { controller, sessions, connectSession, register } = makeUnitController();
    const first = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.fireReady(CAPS);
    await first;

    controller.closeSession({ workspaceRoot: '/w', languageId: 'typescript' });
    expect(register.registrations[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);

    controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    expect(connectSession).toHaveBeenCalledTimes(2);
  });

  it('root/session replacement disposes the old registration before the new one and keeps the new', async () => {
    const { controller, sessions, register } = makeUnitController();
    const a = controller.ensureSession({ workspaceRoot: '/rootA', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.fireReady(CAPS);
    await a;

    controller.closeSession({ workspaceRoot: '/rootA', languageId: 'typescript' });
    expect(register.registrations[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);

    const b = controller.ensureSession({ workspaceRoot: '/rootB', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[1]!.fireReady(CAPS);
    await b;

    expect(register.registrations).toHaveLength(2);
    expect(register.registrations[1]!.dispose).not.toHaveBeenCalled();
    expect(register.registrations[1]).not.toBe(register.registrations[0]);
  });

  it('same-key replacement after close creates a fresh session', async () => {
    const { controller, sessions, connectSession } = makeUnitController();
    const first = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    sessions[0]!.fireReady(CAPS);
    await first;

    controller.closeSession({ workspaceRoot: '/w', languageId: 'typescript' });
    const second = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    expect(connectSession).toHaveBeenCalledTimes(2);
    expect(sessions[1]).not.toBe(sessions[0]);
    sessions[1]!.fireReady(CAPS);
    expect(await second).toEqual({ status: 'ready', capabilities: CAPS });
  });

  it('disposeAll closes all sessions and disposes all registrations', async () => {
    const { controller, sessions, register } = makeUnitController();
    const a = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    const b = controller.ensureSession({ workspaceRoot: '/w', languageId: 'python', languageSelector: 'python' });
    sessions[0]!.fireReady(CAPS);
    sessions[1]!.fireReady(CAPS);
    await Promise.all([a, b]);

    controller.disposeAll();
    expect(register.registrations[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(register.registrations[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(sessions[1]!.close).toHaveBeenCalledTimes(1);
  });

  it('stale pending A does not clobber replacement B for the same key (the controller race)', async () => {
    const { controller, sessions, connectSession, register } = makeUnitController();
    // A starts pending (never ready yet).
    const aPending = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    const sessionA = sessions[0]!;

    // Replace: close A, immediately ensure B for the same key.
    controller.closeSession({ workspaceRoot: '/w', languageId: 'typescript' });
    const bPending = controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR });
    const sessionB = sessions[1]!;
    expect(sessionB).not.toBe(sessionA);
    expect(connectSession).toHaveBeenCalledTimes(2);

    // B becomes ready and registers normally.
    sessionB.fireReady(CAPS);
    expect(await bPending).toEqual({ status: 'ready', capabilities: CAPS });
    const regB = register.registrations[register.registrations.length - 1]!;

    // Now A dies/rejects LATE. It must not touch B.
    sessionA.die({ code: null, signal: null }, 1011);
    expect(await aPending).toEqual({ status: 'failed', closeInfo: { code: 1011, reason: '' } });

    // B remains current: not disposed, and a re-ensure dedupes onto B (no third connect).
    expect(regB.dispose).not.toHaveBeenCalled();
    expect(await controller.ensureSession({ workspaceRoot: '/w', languageId: 'typescript', languageSelector: SELECTOR })).toEqual({ status: 'ready', capabilities: CAPS });
    expect(connectSession).toHaveBeenCalledTimes(2);
  });
});

// ---- Integration: real bridge (installLspWebSocketBridge) + node ws + real transport/connection ----

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

/** Inline ControllerSession adapter over the REAL transport + connection (the boundary glue). */
function wsSession(
  server: Server,
  params: { workspaceRoot: string; languageId: string },
  mangleUrl?: (url: string) => string
): ControllerSession {
  const transport = createLspWebSocketTransport({
    workspaceRoot: params.workspaceRoot,
    languageId: params.languageId,
    baseUrl: baseUrlFor(server),
    webSocketFactory: (url) => new WebSocket(mangleUrl ? mangleUrl(url) : url) as unknown as WebSocketLike
  });
  const connection = new LspConnection(transport);
  return {
    connection,
    whenReady: () => connection.whenReady(),
    onExit: (listener) => connection.onExit(listener),
    close: () => transport.close(),
    closeInfo: () => transport.closeInfo()
  };
}

describe('LspSessionController document sync (defer / order / identity-guard)', () => {
  const WS = { workspaceRoot: '/w', languageId: 'typescript' };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('defers didOpen/didChange until ready and emits them in call order', async () => {
    const { controller, sessions } = makeUnitController();
    void controller.ensureSession({ ...WS, languageSelector: SELECTOR });
    controller.openDocument({ ...WS, uri: 'file:///a.ts', text: 'v1' });
    controller.changeDocument({ ...WS, uri: 'file:///a.ts', edit: { changes: [], fullText: 'v2' } });
    expect(sessions[0]!.docCalls).toEqual([]); // queued, not yet ready
    sessions[0]!.fireReady(CAPS);
    await vi.waitFor(() => expect(sessions[0]!.docCalls).toEqual(['open:file:///a.ts:v1', 'change:file:///a.ts:v2']));
  });

  it('drops did* when the session closes before ready', async () => {
    const { controller, sessions } = makeUnitController();
    void controller.ensureSession({ ...WS, languageSelector: SELECTOR });
    controller.openDocument({ ...WS, uri: 'file:///a.ts', text: 'v1' });
    sessions[0]!.die({ code: null, signal: null }, 1011);
    await flush();
    expect(sessions[0]!.openDocument).not.toHaveBeenCalled();
  });

  it('routes did* to the current session, never a replaced/stale one', async () => {
    const { controller, sessions } = makeUnitController();
    void controller.ensureSession({ ...WS, languageSelector: SELECTOR });
    controller.closeSession(WS); // tears down session 0
    void controller.ensureSession({ ...WS, languageSelector: SELECTOR }); // session 1
    controller.openDocument({ ...WS, uri: 'file:///a.ts', text: 'v1' });
    sessions[1]!.fireReady(CAPS);
    await vi.waitFor(() => expect(sessions[1]!.docCalls).toEqual(['open:file:///a.ts:v1']));
    expect(sessions[0]!.openDocument).not.toHaveBeenCalled();
  });

  it('is a no-op when no session exists for the key', async () => {
    const { controller, sessions } = makeUnitController();
    controller.openDocument({ ...WS, uri: 'file:///a.ts', text: 'v1' });
    controller.changeDocument({ ...WS, uri: 'file:///a.ts', edit: { changes: [], fullText: 'v' } });
    controller.closeDocument({ ...WS, uri: 'file:///a.ts' });
    await flush();
    expect(sessions).toHaveLength(0);
  });
});

describe('LspSessionController (integration with real bridge)', () => {
  let server: Server | undefined;
  let disposeBridge: (() => void) | undefined;
  let controller: LspSessionController<string> | undefined;

  afterEach(async () => {
    controller?.disposeAll();
    controller = undefined;
    disposeBridge?.();
    disposeBridge = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it('registers providers once when the session becomes ready over a real socket', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const register = makeRegisterSpy();
    controller = new LspSessionController<string>({
      connectSession: (params) => wsSession(server!, params),
      registerProviders: register.fn
    });

    const result = await controller.ensureSession({ workspaceRoot: '/workspace', languageId: 'typescript', languageSelector: 'typescript' });
    expect(result).toEqual({ status: 'ready', capabilities: session.capabilities });
    expect(register.fn).toHaveBeenCalledTimes(1);
    expect(register.registrations[0]!.capabilities).toEqual(session.capabilities);
  });

  it('fails with closeInfo 1008 and no registration when workspaceRoot is empty at the server', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const register = makeRegisterSpy();
    controller = new LspSessionController<string>({
      connectSession: (params) => wsSession(server!, params, (url) => url.replace('workspaceRoot=%2Ftmp', 'workspaceRoot=')),
      registerProviders: register.fn
    });

    const result = await controller.ensureSession({ workspaceRoot: '/tmp', languageId: 'typescript', languageSelector: 'typescript' });
    expect(result).toEqual({ status: 'failed', closeInfo: { code: 1008, reason: expect.any(String) } });
    expect(register.fn).not.toHaveBeenCalled();
  });

  it('fails with closeInfo 1011 and no registration when the session factory throws', async () => {
    server = createServer();
    disposeBridge = installLspWebSocketBridge(server, {
      createSession: () => {
        throw new Error('boom');
      }
    });
    await listen(server);
    const register = makeRegisterSpy();
    controller = new LspSessionController<string>({
      connectSession: (params) => wsSession(server!, params),
      registerProviders: register.fn
    });

    const result = await controller.ensureSession({ workspaceRoot: '/workspace', languageId: 'typescript', languageSelector: 'typescript' });
    expect(result).toEqual({ status: 'failed', closeInfo: { code: 1011, reason: expect.any(String) } });
    expect(register.fn).not.toHaveBeenCalled();
  });

  it('disposes the registration when the server exits after ready', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);
    const register = makeRegisterSpy();
    controller = new LspSessionController<string>({
      connectSession: (params) => wsSession(server!, params),
      registerProviders: register.fn
    });

    await controller.ensureSession({ workspaceRoot: '/workspace', languageId: 'typescript', languageSelector: 'typescript' });
    expect(register.registrations).toHaveLength(1);

    session.emitExit({ code: 1, signal: null });
    await vi.waitFor(() => expect(register.registrations[0]!.dispose).toHaveBeenCalledTimes(1));
  });
});
