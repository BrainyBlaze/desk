import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLspRequestMetricsCollector } from '../../src/server/lsp/requestMetrics';
import { LspSessionPool } from '../../src/server/lsp/sessionPool';
import type { LspVirtualSession } from '../../src/server/lspWebSocketBridge';
import { createStubStdioServerCommand } from './stubStdioServer';

const URI = 'file:///workspace/src/example.ts';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-session-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LspSessionPool lifecycle', () => {
  it('uses the accepted stdio virtual-session path by default', async () => {
    const cwdFile = join(root, 'cwd.txt');
    const initializedFile = join(root, 'initialized.txt');
    const initializeFile = join(root, 'initialize.json');
    const fakeServer = createStubStdioServerCommand({ cwdFile, initializedFile, initializeFile });
    const pool = new LspSessionPool();

    try {
      const session = await pool.start({
        id: 'fake-typescript',
        command: fakeServer.command,
        args: fakeServer.args,
        env: fakeServer.env,
        workspaceRoot: root
      });
      await eventually(() => existsSync(cwdFile));
      expect(readFileSync(cwdFile, 'utf8')).toBe(root);

      expect(session).toEqual({
        id: 'fake-typescript',
        state: 'ready',
        capabilities: {
          hoverProvider: true,
          definitionProvider: true
        }
      });
      await eventually(() => existsSync(initializedFile));
      await eventually(() => existsSync(initializeFile));
      const initializeParams = JSON.parse(readFileSync(initializeFile, 'utf8'));
      expect(initializeParams.capabilities.workspace.fileOperations).toEqual({
        dynamicRegistration: true,
        didCreate: true,
        didRename: true,
        didDelete: true,
        willCreate: true,
        willRename: true,
        willDelete: true
      });
    } finally {
      await pool.stopAll();
    }
  });

  it('emits sanitized dynamic file-operation registration events and clears them on session exit', async () => {
    const token = 'tok_DYNAMIC_SECRET';
    const virtual = new FakeVirtualSession();
    const events: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    (pool as any).onFileOperationRegistration((event: unknown) => events.push(event));
    await pool.start(startOptions('fake-typescript'));

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 77,
      method: 'client/registerCapability',
      params: {
        registrations: [
          {
            id: `dynamic-${token}`,
            method: 'workspace/willRenameFiles',
            registerOptions: {
              [`key-${token}`]: 'drop-key',
              filters: [
                {
                  scheme: 'file',
                  pattern: {
                    glob: '*.ts',
                    matches: 'file',
                    options: { ignoreCase: true, [`nested-${token}`]: true },
                    command: token
                  },
                  data: token
                },
                { scheme: 'untitled', pattern: { glob: `leak-${token}.ts` } },
                { pattern: { glob: 123 } }
              ],
              env: token,
              serverCommands: token
            }
          }
        ]
      }
    });

    expect(virtual.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 77, result: null });
    expect(events[0]).toEqual({
      sessionId: 'fake-typescript',
      action: 'register',
      registrations: [
        {
          id: `dynamic-${token}`,
          method: 'workspace/willRenameFiles',
          filters: [{ scheme: 'file', pattern: { glob: '*.ts', matches: 'file', options: { ignoreCase: true } } }]
        }
      ]
    });
    expect(JSON.stringify(events[0])).not.toContain(`key-${token}`);
    expect(JSON.stringify(events[0])).not.toContain(`nested-${token}`);
    expect(JSON.stringify(events[0])).not.toContain('serverCommands');
    expect(JSON.stringify(events[0])).not.toContain('command');

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 78,
      method: 'client/unregisterCapability',
      params: { unregisterations: [{ id: `dynamic-${token}`, method: 'workspace/willRenameFiles' }] }
    });
    expect(virtual.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 78, result: null });
    expect(events[1]).toEqual({
      sessionId: 'fake-typescript',
      action: 'unregister',
      registrations: [{ id: `dynamic-${token}`, method: 'workspace/willRenameFiles', filters: [] }]
    });

    virtual.exit({ code: 0, signal: null });
    expect(events[2]).toEqual({ sessionId: 'fake-typescript', action: 'clear', registrations: [] });
  });

  it('treats invalid dynamic registration and unknown unregister as no-op success', async () => {
    const virtual = new FakeVirtualSession();
    const events: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    (pool as any).onFileOperationRegistration((event: unknown) => events.push(event));
    await pool.start(startOptions('fake-typescript'));

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 80,
      method: 'client/registerCapability',
      params: {
        registrations: [
          {
            id: 'invalid',
            method: 'workspace/didCreateFiles',
            registerOptions: { filters: [{ scheme: 'untitled', pattern: { glob: '*.ts' } }] }
          }
        ]
      }
    });
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 81,
      method: 'client/unregisterCapability',
      params: { unregisterations: [{ id: 'missing', method: 'workspace/didCreateFiles' }] }
    });

    expect(virtual.sent.slice(-2)).toEqual([
      { jsonrpc: '2.0', id: 80, result: null },
      { jsonrpc: '2.0', id: 81, result: null }
    ]);
    expect(events).toEqual([
      { sessionId: 'fake-typescript', action: 'register', registrations: [] },
      { sessionId: 'fake-typescript', action: 'unregister', registrations: [{ id: 'missing', method: 'workspace/didCreateFiles', filters: [] }] }
    ]);
  });

  it('routes concurrent requests by pool-assigned JSON-RPC ids', async () => {
    const virtual = new FakeVirtualSession();
    const pool = new LspSessionPool({ createSession: async () => virtual });
    await pool.start(startOptions('fake-typescript'));

    const first = pool.sendRequest('fake-typescript', 'textDocument/hover', { marker: 'first' });
    const second = pool.sendRequest('fake-typescript', 'textDocument/hover', { marker: 'second' });
    expect(virtual.sent.map((message: any) => [message.id, message.method, message.params])).toEqual([
      [1, 'textDocument/hover', { marker: 'first' }],
      [2, 'textDocument/hover', { marker: 'second' }]
    ]);

    virtual.emitServerMessage({ jsonrpc: '2.0', id: 2, result: 'second-result' });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'first-result' });

    await expect(first).resolves.toBe('first-result');
    await expect(second).resolves.toBe('second-result');
  });

  it('keeps request metrics disabled by default and no-ops when explicitly disabled', async () => {
    const virtual = new FakeVirtualSession();
    const metrics = createLspRequestMetricsCollector({ enabled: false });
    const pool = new LspSessionPool({ createSession: async () => virtual, requestMetrics: metrics });
    await pool.start(startOptions('fake-typescript'));

    const pending = pool.sendRequest('fake-typescript', 'textDocument/hover', { token: 'SECRET_TOKEN' });
    expect(virtual.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { token: 'SECRET_TOKEN' } }]);
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });

    await expect(pending).resolves.toBe('ok');
    expect(metrics.snapshot()).toEqual(emptyRequestMetricsSnapshot(false));
  });

  it('records enabled request metrics for success, failure, cancellation, and session-exit rejection', async () => {
    const virtual = new FakeVirtualSession();
    const metrics = createLspRequestMetricsCollector({ enabled: true });
    const pool = new LspSessionPool({ createSession: async () => virtual, requestMetrics: metrics });
    await pool.start(startOptions('fake-typescript'));

    const success = pool.sendRequest('fake-typescript', 'textDocument/hover', { marker: 'success' });
    expect(metrics.snapshot().pending.bySession).toEqual({ 'fake-typescript': 1 });
    expect(metrics.snapshot().pending.byMethod).toEqual({ 'textDocument/hover': 1 });
    expect(Object.values(metrics.snapshot().pending.byConsumer)).toEqual([1]);
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });
    await expect(success).resolves.toBe('ok');
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });

    const failure = pool.sendRequest('fake-typescript', 'textDocument/hover', { marker: 'failure' });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 2, error: { message: 'server failed' } });
    await expect(failure).rejects.toThrow('server failed');
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });

    const controller = new AbortController();
    const canceled = pool.sendRequest('fake-typescript', 'textDocument/hover', { marker: 'cancel' }, { signal: controller.signal });
    controller.abort();
    await expect(canceled).rejects.toThrow(/cancel/i);
    expect(metrics.snapshot().cancellations.total).toBe(1);
    expect(metrics.snapshot().cancellations.byMethod).toEqual({ 'textDocument/hover': 1 });
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });

    const rejectedOnExit = pool.sendRequest('fake-typescript', 'textDocument/hover', { marker: 'exit' });
    virtual.exit({ code: 9, signal: null });
    await expect(rejectedOnExit).rejects.toThrow(/exited/i);
    expect(metrics.snapshot().sessionExitRejections.total).toBe(1);
    expect(metrics.snapshot().sessionExitRejections.bySession).toEqual({ 'fake-typescript': 1 });
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });
  });

  it('keeps request metric snapshots free of command, env, initialization option, and token payloads', async () => {
    const virtual = new FakeVirtualSession();
    const metrics = createLspRequestMetricsCollector({ enabled: true });
    const pool = new LspSessionPool({ createSession: async () => virtual, requestMetrics: metrics });
    await pool.start({
      id: 'fake-typescript',
      command: 'SECRET_COMMAND',
      args: ['SECRET_ARG'],
      env: { SECRET_ENV: 'SECRET_ENV_VALUE' },
      initializationOptions: { token: 'SECRET_INIT_TOKEN', serverCommands: { typescript: 'SECRET_SERVER_COMMAND' } },
      workspaceRoot: root
    });

    const pending = pool.sendRequest('fake-typescript', 'textDocument/hover', {
      token: 'SECRET_REQUEST_TOKEN',
      env: 'SECRET_REQUEST_ENV'
    });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });
    await expect(pending).resolves.toBe('ok');

    expect(JSON.stringify(metrics.snapshot())).not.toMatch(
      /SECRET_COMMAND|SECRET_ARG|SECRET_ENV|SECRET_INIT_TOKEN|SECRET_SERVER_COMMAND|SECRET_REQUEST_TOKEN|SECRET_REQUEST_ENV|serverCommands|initializationOptions/
    );
  });

  it('rejects duplicate in-flight starts for the same session id without creating another session', async () => {
    const created: FakeVirtualSession[] = [];
    const startupResolvers: Array<(session: FakeVirtualSession) => void> = [];
    const pool = new LspSessionPool({
      createSession: async () => {
        const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
        created.push(virtual);
        return new Promise<FakeVirtualSession>((resolve) => {
          startupResolvers.push(resolve);
        });
      }
    });

    const first = pool.start(startOptions('fake-typescript'));
    const duplicate = pool.start(startOptions('fake-typescript'));
    await Promise.resolve();
    expect(created).toHaveLength(1);

    await expect(duplicate).rejects.toThrow(/already exists|starting/i);
    startupResolvers[0](created[0]);
    await expect(first).resolves.toMatchObject({
      id: 'fake-typescript',
      state: 'ready',
      capabilities: { label: 'fake-1' }
    });
  });

  it('sends cancelRequest with the exact in-flight id and ignores late canceled responses', async () => {
    const virtual = new FakeVirtualSession();
    const pool = new LspSessionPool({ createSession: async () => virtual });
    const controller = new AbortController();
    await pool.start(startOptions('fake-typescript'));

    const pending = pool.sendRequest('fake-typescript', 'textDocument/hover', { hold: true }, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/cancel/i);
    expect(virtual.sent.map((message: any) => ({ id: message.id, method: message.method, params: message.params }))).toEqual([
      { id: 1, method: 'textDocument/hover', params: { hold: true } },
      { id: undefined, method: '$/cancelRequest', params: { id: 1 } }
    ]);

    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'late' });
  });

  it('rejects pending requests on session exit and allows a later start', async () => {
    const firstVirtual = new FakeVirtualSession();
    const secondVirtual = new FakeVirtualSession({ label: 'second' });
    const virtuals = [firstVirtual, secondVirtual];
    const pool = new LspSessionPool({ createSession: async () => virtuals.shift() ?? secondVirtual });
    await pool.start(startOptions('fake-typescript'));
    const pending = pool.sendRequest('fake-typescript', 'textDocument/hover', { hold: true });

    firstVirtual.exit({ code: 7, signal: null });

    await expect(pending).rejects.toThrow(/exited/i);
    await expect(pool.sendRequest('fake-typescript', 'textDocument/hover', {})).rejects.toThrow(/not found/i);

    const next = await pool.start(startOptions('fake-typescript'));
    expect(next.capabilities.label).toBe('second');
  });

  it('notifies exit listeners with natural exit code and signal', async () => {
    const virtual = new FakeVirtualSession();
    const exits: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    pool.onSessionExit((exit) => exits.push(exit));
    await pool.start(startOptions('fake-typescript'));

    virtual.exit({ code: 7, signal: 'SIGTERM' });

    expect(exits).toEqual([{ sessionId: 'fake-typescript', code: 7, signal: 'SIGTERM', reason: 'natural' }]);
  });

  it('ignores server notifications and unmatched responses', async () => {
    const virtual = new FakeVirtualSession();
    const pool = new LspSessionPool({ createSession: async () => virtual });
    await pool.start(startOptions('fake-typescript'));

    const pending = pool.sendRequest('fake-typescript', 'textDocument/hover', {});
    virtual.emitServerMessage({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hello' } });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 99, result: 'unmatched' });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'matched' });

    await expect(pending).resolves.toBe('matched');
  });

  it('surfaces allowlisted id-less server notifications without surfacing requests or unmatched responses', async () => {
    const virtual = new FakeVirtualSession();
    const notifications: unknown[] = [];
    const editorMessages: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    pool.onServerNotification((notification) => notifications.push(notification));
    await pool.start(startOptions('fake-typescript'));
    pool.attachRawConsumer('fake-typescript', {
      kind: 'raw-editor',
      onMessage: (message) => editorMessages.push(message)
    });

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///workspace/src/example.ts', diagnostics: [] }
    });
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'report', message: 'Indexing', percentage: 50 } }
    });
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 42,
      method: 'window/workDoneProgress/create',
      params: { token: 'progress' }
    });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 99, result: 'unmatched' });
    virtual.emitServerMessage({ jsonrpc: '2.0', method: 123, params: { ignored: true } });

    expect(notifications).toEqual([
      {
        sessionId: 'fake-typescript',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///workspace/src/example.ts', diagnostics: [] }
      },
      {
        sessionId: 'fake-typescript',
        method: '$/progress',
        params: { token: 'index', value: { kind: 'report', message: 'Indexing', percentage: 50 } }
      }
    ]);
    expect(editorMessages).toEqual([
      { jsonrpc: '2.0', method: '$/progress', params: { token: 'index', value: { kind: 'report', message: 'Indexing', percentage: 50 } } },
      { jsonrpc: '2.0', id: 'mplex:1', method: 'window/workDoneProgress/create', params: { token: 'progress' } }
    ]);
  });

  it('syncs editor-owned documents without invoking the disk reader', async () => {
    const virtual = new FakeVirtualSession();
    const documentEvents: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    (pool as any).onDocumentSnapshot((event: unknown) => documentEvents.push(event));
    await pool.start(startOptions('fake-typescript'));
    const editor = (pool as any).attachRawConsumer('fake-typescript', {
      kind: 'raw-editor',
      onMessage: () => undefined
    });

    editor.sendClientMessage(didOpen(URI, 'editor text', 4));
    const synced = (pool as any).syncDocumentForRequest('fake-typescript', {
      uri: URI,
      languageId: 'typescript',
      readDisk: () => {
        throw new Error('disk should not be read for editor-owned document');
      }
    });

    expect(synced).toMatchObject({
      source: 'editor-live',
      snapshot: { uri: URI, languageId: 'typescript', version: 4, text: 'editor text' }
    });
    expect(virtual.sent.map((message: any) => message.method)).toEqual(['textDocument/didOpen']);
    expect(documentEvents).toEqual([
      {
        sessionId: 'fake-typescript',
        snapshot: { state: 'editor-open', uri: URI, languageId: 'typescript', version: 4, text: 'editor text' }
      }
    ]);
  });

  it('preserves lazy disk didOpen unchanged didChange sync through the multiplexer', async () => {
    const virtual = new FakeVirtualSession();
    const documentEvents: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    (pool as any).onDocumentSnapshot((event: unknown) => documentEvents.push(event));
    await pool.start(startOptions('fake-typescript'));

    (pool as any).syncDocumentForRequest('fake-typescript', {
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk v1' })
    });
    (pool as any).syncDocumentForRequest('fake-typescript', {
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk v1' })
    });
    (pool as any).syncDocumentForRequest('fake-typescript', {
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk v2' })
    });

    expect(virtual.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange'
    ]);
    expect(documentEvents).toEqual([
      {
        sessionId: 'fake-typescript',
        snapshot: { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 1, text: 'disk v1' }
      },
      {
        sessionId: 'fake-typescript',
        snapshot: { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 2, text: 'disk v2' }
      }
    ]);
  });

  it('shares one virtual session between raw consumers and internal requests', async () => {
    const virtual = new FakeVirtualSession();
    const rawMessages: unknown[] = [];
    const pool = new LspSessionPool({ createSession: async () => virtual });
    await pool.start(startOptions('fake-typescript'));
    const editor = (pool as any).attachRawConsumer('fake-typescript', {
      kind: 'raw-editor',
      onMessage: (message: unknown) => rawMessages.push(message)
    });

    editor.sendClientMessage({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { from: 'raw' } });
    const internal = pool.sendRequest('fake-typescript', 'textDocument/completion', { from: 'internal' });

    const rawUpstreamId = (virtual.sent[0] as any).id;
    const internalUpstreamId = (virtual.sent[1] as any).id;
    expect(rawUpstreamId).not.toBe(internalUpstreamId);

    virtual.emitServerMessage({ jsonrpc: '2.0', id: internalUpstreamId, result: 'internal-result' });
    virtual.emitServerMessage({ jsonrpc: '2.0', id: rawUpstreamId, result: 'raw-result' });

    await expect(internal).resolves.toBe('internal-result');
    expect(rawMessages).toEqual([{ jsonrpc: '2.0', id: 1, result: 'raw-result' }]);
  });
});

function startOptions(id: string) {
  return {
    id,
    command: 'unused',
    args: [],
    env: {},
    workspaceRoot: root
  };
}

function didOpen(uri: string, text: string, version = 1) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'typescript', version, text } }
  };
}

function emptyRequestMetricsSnapshot(enabled: boolean) {
  return {
    enabled,
    pending: { bySession: {}, byConsumer: {}, byMethod: {} },
    cancellations: { total: 0, byMethod: {} },
    lateResponseDrops: { total: 0 },
    writerErrors: { total: 0 },
    sessionExitRejections: { total: 0, bySession: {} }
  };
}

class FakeVirtualSession implements LspVirtualSession {
  capabilities: Record<string, unknown>;
  sent: unknown[] = [];
  private readonly serverListeners: Array<(message: unknown) => void> = [];
  private readonly exitListeners: Array<(exit: { code: number | null; signal: string | null }) => void> = [];

  constructor(capabilities: Record<string, unknown> = { hoverProvider: true, label: 'fake' }) {
    this.capabilities = capabilities;
  }

  sendClientMessage(message: unknown): void {
    this.sent.push(message);
  }

  onServerMessage(listener: (message: unknown) => void): void {
    this.serverListeners.push(listener);
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitListeners.push(listener);
  }

  dispose(): void {
    this.exit({ code: null, signal: 'SIGTERM' });
  }

  emitServerMessage(message: unknown): void {
    for (const listener of this.serverListeners) {
      listener(message);
    }
  }

  exit(exit: { code: number | null; signal: string | null }): void {
    for (const listener of this.exitListeners) {
      listener(exit);
    }
  }
}

async function eventually(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(assertion()).toBe(true);
}
