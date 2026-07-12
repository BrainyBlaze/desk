import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { installLspWebSocketBridge, type LspVirtualSession } from '../src/server/lspWebSocketBridge';
import { LspConnection } from '../src/web/editor/lsp/connection';
import { createLspWebSocketTransport, type WebSocketLike } from '../src/web/editor/lsp/webSocketTransport';
import { LspSessionController, type ControllerSession, type ProviderRegistration } from '../src/web/editor/lsp/sessionController';
import { createEditorLspBinding } from '../src/web/editor/lsp/editorLspBinding';

/** Records the controller calls the binding makes, without a real session. */
class FakeController {
  readonly ensureSession = vi.fn(async (_params: { workspaceRoot: string; languageId: string; languageSelector: string }) => ({
    status: 'ready' as const,
    capabilities: {}
  }));
  readonly closeSession = vi.fn((_params: { workspaceRoot: string; languageId: string }) => {});
  readonly openDocument = vi.fn((_params: { workspaceRoot: string; languageId: string; uri: string; text: string }) => {});
  readonly changeDocument = vi.fn(
    (_params: { workspaceRoot: string; languageId: string; uri: string; edit: { changes: unknown; fullText: string } }) => {}
  );
  readonly closeDocument = vi.fn((_params: { workspaceRoot: string; languageId: string; uri: string }) => {});
  readonly pullDiagnostics = vi.fn((_params: { workspaceRoot: string; languageId: string; uri: string }) => {});
  private readonly lossListeners = new Set<
    (event: { workspaceRoot: string; languageId: string; exit: { code: number | null; signal: string | null } }) => void
  >();
  readonly onSessionLost = vi.fn(
    (listener: (event: { workspaceRoot: string; languageId: string; exit: { code: number | null; signal: string | null } }) => void) => {
      this.lossListeners.add(listener);
      return () => this.lossListeners.delete(listener);
    }
  );

  emitSessionLost(languageId: string): void {
    const event = { workspaceRoot: ROOT, languageId, exit: { code: 1, signal: null } };
    for (const listener of [...this.lossListeners]) {
      listener(event);
    }
  }
}

const EDIT = { changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'x' }], fullText: 'x' };

const ROOT = '/workspace';
function bindingWith(
  controller: FakeController,
  enabled: (id: string) => boolean = (id) => id === 'typescript',
  reconnectDelaysMs?: readonly number[]
) {
  return createEditorLspBinding<string>({
    controller,
    workspaceRoot: ROOT,
    isLanguageEnabled: enabled,
    toSelector: (languageId) => languageId,
    reconnectDelaysMs
  });
}

describe('createEditorLspBinding (unit)', () => {
  it('ensures a session once when the first model of an enabled language opens', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(controller.ensureSession).toHaveBeenCalledTimes(1);
    expect(controller.ensureSession).toHaveBeenCalledWith({ workspaceRoot: ROOT, languageId: 'typescript', languageSelector: 'typescript' });
  });

  it('does not ensure again for a second model of the same language', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.openModel({ uri: 'file:///b.ts', languageId: 'typescript' });
    expect(controller.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('counts the same uri only once', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(controller.closeSession).toHaveBeenCalledTimes(1);
  });

  it('does not close the session while another model of the language remains open', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.openModel({ uri: 'file:///b.ts', languageId: 'typescript' });
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(controller.closeSession).not.toHaveBeenCalled();
  });

  it('closes the session when the last model of the language closes', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.openModel({ uri: 'file:///b.ts', languageId: 'typescript' });
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.closeModel({ uri: 'file:///b.ts', languageId: 'typescript' });
    expect(controller.closeSession).toHaveBeenCalledTimes(1);
    expect(controller.closeSession).toHaveBeenCalledWith({ workspaceRoot: ROOT, languageId: 'typescript' });
  });

  it('ensures again when a language is reopened after its last model closed', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(controller.ensureSession).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for a disabled language', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller, (id) => id === 'typescript');
    binding.openModel({ uri: 'file:///a.py', languageId: 'python' });
    binding.closeModel({ uri: 'file:///a.py', languageId: 'python' });
    expect(controller.ensureSession).not.toHaveBeenCalled();
    expect(controller.closeSession).not.toHaveBeenCalled();
  });

  it('disposeAll closes every live language session and clears state', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller, () => true);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.openModel({ uri: 'file:///a.py', languageId: 'python' });
    binding.disposeAll();
    expect(controller.closeSession).toHaveBeenCalledTimes(2);
    expect(controller.closeSession).toHaveBeenCalledWith({ workspaceRoot: ROOT, languageId: 'typescript' });
    expect(controller.closeSession).toHaveBeenCalledWith({ workspaceRoot: ROOT, languageId: 'python' });
    // After disposeAll, reopening ensures fresh (state cleared).
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(controller.ensureSession).toHaveBeenCalledTimes(3);
  });

  it('closeModel for an unknown model is a no-op', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller, () => true);
    binding.closeModel({ uri: 'file:///never-opened.ts', languageId: 'typescript' });
    expect(controller.closeSession).not.toHaveBeenCalled();
  });
});

describe('createEditorLspBinding document sync (didOpen/didChange/didClose)', () => {
  it('openModel establishes editor-owned didOpen with the live model text (before any change)', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'const a = 1;');
    expect(controller.openDocument).toHaveBeenCalledTimes(1);
    expect(controller.openDocument).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      languageId: 'typescript',
      uri: 'file:///a.ts',
      text: 'const a = 1;'
    });
  });

  it('changeModel forwards a didChange for an open model', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'const a = 1;');
    binding.changeModel({ uri: 'file:///a.ts', languageId: 'typescript' }, EDIT);
    expect(controller.changeDocument).toHaveBeenCalledTimes(1);
    expect(controller.changeDocument).toHaveBeenCalledWith({ workspaceRoot: ROOT, languageId: 'typescript', uri: 'file:///a.ts', edit: EDIT });
  });

  it('changeModel for an unopened/untracked model is a no-op (no didChange before didOpen, none after close)', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.changeModel({ uri: 'file:///a.ts', languageId: 'typescript' }, EDIT);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'x');
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    binding.changeModel({ uri: 'file:///a.ts', languageId: 'typescript' }, EDIT);
    expect(controller.changeDocument).not.toHaveBeenCalled();
  });

  it('closeModel forwards a didClose before the session refcount drops', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'x');
    binding.openModel({ uri: 'file:///b.ts', languageId: 'typescript' }, 'y');
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    expect(controller.closeDocument).toHaveBeenCalledWith({ workspaceRoot: ROOT, languageId: 'typescript', uri: 'file:///a.ts' });
    expect(controller.closeSession).not.toHaveBeenCalled(); // b.ts still open
  });

  it('opens each uri of a language exactly once (fanout, no double didOpen)', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller);
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'a');
    binding.openModel({ uri: 'file:///b.ts', languageId: 'typescript' }, 'b');
    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'a-again');
    expect(controller.openDocument).toHaveBeenCalledTimes(2);
    expect(controller.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a disabled language (no didOpen/didChange/didClose)', () => {
    const controller = new FakeController();
    const binding = bindingWith(controller, (id) => id === 'typescript');
    binding.openModel({ uri: 'file:///a.py', languageId: 'python' }, 'x');
    binding.changeModel({ uri: 'file:///a.py', languageId: 'python' }, EDIT);
    binding.closeModel({ uri: 'file:///a.py', languageId: 'python' });
    expect(controller.openDocument).not.toHaveBeenCalled();
    expect(controller.changeDocument).not.toHaveBeenCalled();
    expect(controller.closeDocument).not.toHaveBeenCalled();
  });

  it('reconnects after unexpected loss and replays every open model with its latest full text', async () => {
    vi.useFakeTimers();
    try {
      const controller = new FakeController();
      const binding = bindingWith(controller, undefined, [10]);
      binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'const a = 1;');
      controller.openDocument.mockClear();
      controller.changeDocument.mockClear();
      controller.pullDiagnostics.mockClear();

      controller.emitSessionLost('typescript');
      binding.changeModel(
        { uri: 'file:///a.ts', languageId: 'typescript' },
        { changes: EDIT.changes, fullText: 'const a = 2;' }
      );
      binding.openModel({ uri: 'file:///b.ts', languageId: 'typescript' }, 'const b = 1;');
      expect(controller.changeDocument).not.toHaveBeenCalled();
      expect(controller.openDocument).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);

      expect(controller.ensureSession).toHaveBeenCalledTimes(2);
      expect(controller.openDocument.mock.calls).toEqual([
        [{ workspaceRoot: ROOT, languageId: 'typescript', uri: 'file:///a.ts', text: 'const a = 2;' }],
        [{ workspaceRoot: ROOT, languageId: 'typescript', uri: 'file:///b.ts', text: 'const b = 1;' }]
      ]);
      expect(controller.pullDiagnostics).toHaveBeenCalledTimes(2);
      binding.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses capped retry delays when reconnect attempts fail', async () => {
    vi.useFakeTimers();
    try {
      const controller = new FakeController();
      controller.ensureSession
        .mockResolvedValueOnce({ status: 'ready', capabilities: {} })
        .mockResolvedValueOnce({ status: 'failed', closeInfo: null })
        .mockResolvedValueOnce({ status: 'failed', closeInfo: null })
        .mockResolvedValueOnce({ status: 'ready', capabilities: {} });
      const binding = bindingWith(controller, undefined, [10, 20]);
      binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'text');
      await Promise.resolve();

      controller.emitSessionLost('typescript');
      await vi.advanceTimersByTimeAsync(10);
      expect(controller.ensureSession).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(20);
      expect(controller.ensureSession).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(19);
      expect(controller.ensureSession).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(controller.ensureSession).toHaveBeenCalledTimes(4);
      binding.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending reconnect when the last model closes', async () => {
    vi.useFakeTimers();
    try {
      const controller = new FakeController();
      const binding = bindingWith(controller, undefined, [10]);
      const ref = { uri: 'file:///a.ts', languageId: 'typescript' };
      binding.openModel(ref, 'text');
      controller.emitSessionLost('typescript');
      binding.closeModel(ref);

      await vi.advanceTimersByTimeAsync(10);
      expect(controller.ensureSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending reconnects when the binding is disposed', async () => {
    vi.useFakeTimers();
    try {
      const controller = new FakeController();
      const binding = bindingWith(controller, undefined, [10]);
      binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'text');
      controller.emitSessionLost('typescript');
      binding.disposeAll();

      await vi.advanceTimersByTimeAsync(10);
      expect(controller.ensureSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Integration: binding + real LspSessionController + real bridge + node ws + real transport/connection ----

class IntegrationSession implements LspVirtualSession {
  readonly capabilities = { hoverProvider: true };
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
function wsSession(server: Server, params: { workspaceRoot: string; languageId: string }): ControllerSession {
  const transport = createLspWebSocketTransport({
    workspaceRoot: params.workspaceRoot,
    languageId: params.languageId,
    baseUrl: baseUrlFor(server),
    webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike
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

describe('createEditorLspBinding (integration with real controller + bridge)', () => {
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

  it('reaches provider registration when an enabled model opens over a real socket', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);

    const registrations: ProviderRegistration[] = [];
    const registerProviders = vi.fn((args: { capabilities: unknown }) => {
      const reg = { dispose: vi.fn(), capabilities: args.capabilities };
      registrations.push(reg);
      return reg;
    });
    controller = new LspSessionController<string>({ connectSession: (params) => wsSession(server!, params), registerProviders });
    const binding = createEditorLspBinding<string>({
      controller,
      workspaceRoot: '/workspace',
      isLanguageEnabled: (id) => id === 'typescript',
      toSelector: (id) => id
    });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(registerProviders).toHaveBeenCalledTimes(1));
    expect((registrations[0] as { capabilities: unknown }).capabilities).toEqual(session.capabilities);
  });

  it('disposes the session when the last enabled model closes', async () => {
    server = createServer();
    const session = new IntegrationSession();
    disposeBridge = installLspWebSocketBridge(server, { createSession: () => session });
    await listen(server);

    const registrations: ProviderRegistration[] = [];
    const registerProviders = vi.fn(() => {
      const reg = { dispose: vi.fn() };
      registrations.push(reg);
      return reg;
    });
    controller = new LspSessionController<string>({ connectSession: (params) => wsSession(server!, params), registerProviders });
    const binding = createEditorLspBinding<string>({
      controller,
      workspaceRoot: '/workspace',
      isLanguageEnabled: (id) => id === 'typescript',
      toSelector: (id) => id
    });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect(registrations).toHaveLength(1));
    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    await vi.waitFor(() => expect((registrations[0] as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.disposed).toHaveBeenCalledTimes(1));
  });

  it('emits didClose BEFORE session teardown when the LAST model closes (real controller)', async () => {
    // Regression: closeModel must flush the editor-owned didClose before closeSession tears the
    // session down. Previously closeDocument deferred onto a microtask and lost the race to the
    // synchronous closeSession, so the last-model didClose was dropped by the identity guard.
    const events: string[] = [];
    const recordingSession = (): ControllerSession => ({
      connection: { request: async () => null },
      whenReady: () => Promise.resolve({ hoverProvider: true } as never),
      onExit: () => () => {},
      close: () => {
        events.push('session-close');
      },
      closeInfo: () => null,
      openDocument: (uri: string) => {
        events.push('didOpen:' + uri);
      },
      changeDocument: (uri: string) => {
        events.push('didChange:' + uri);
      },
      closeDocument: (uri: string) => {
        events.push('didClose:' + uri);
      }
    });
    controller = new LspSessionController<string>({
      connectSession: () => recordingSession(),
      registerProviders: () => ({
        dispose: () => {
          events.push('reg-dispose');
        }
      })
    });
    const binding = createEditorLspBinding<string>({
      controller,
      workspaceRoot: ROOT,
      isLanguageEnabled: (id) => id === 'typescript',
      toSelector: (id) => id
    });

    binding.openModel({ uri: 'file:///a.ts', languageId: 'typescript' }, 'const a = 1;');
    await vi.waitFor(() => expect(events).toContain('didOpen:file:///a.ts'));

    binding.closeModel({ uri: 'file:///a.ts', languageId: 'typescript' });
    // didClose is emitted (not dropped) AND ordered before the session teardown / close.
    expect(events).toContain('didClose:file:///a.ts');
    expect(events.indexOf('didClose:file:///a.ts')).toBeLessThan(events.indexOf('session-close'));
    expect(events.indexOf('didClose:file:///a.ts')).toBeLessThan(events.indexOf('reg-dispose'));
  });
});
