import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorSharedSessionFactory } from '../../src/server/lsp/editorSharedSessionFactory';
import type { AttachRawSessionConsumerOptions, RawSessionConsumer } from '../../src/server/lsp/rawSessionMultiplexer';
import type { LspManagedSessionExitEvent, LspRawConsumerLease, LspServerStartOptions } from '../../src/server/lsp/manager';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-editor-shared-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createEditorSharedSessionFactory', () => {
  it('selects the matching LSP command and passes manifest maxSessions as a manager acquisition override', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () =>
        manifest({
          maxSessions: 1,
          languages: ['typescript'],
          serverCommands: {
            typescript: commandConfig({ command: 'typescript-language-server', args: ['--stdio'], env: { NODE_ENV: 'test' } })
          }
        })
    });

    const session = await factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' });

    expect(session.capabilities).toEqual({ hoverProvider: true, label: 'fake' });
    expect(manager.acquireCalls).toMatchObject([
      {
        start: {
          serverConfigId: 'typescript',
          workspaceRoot: root,
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { NODE_ENV: 'test' },
          initializationOptions: {},
          startupTimeoutMs: 5000
        },
        acquire: { maxSessions: 1 }
      }
    ]);
    expect(manager.acquireCalls[0].consumer.kind).toBe('raw-editor');
  });

  it('uses editor raw-session acquisition as the manual restart path for stopped servers', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () =>
        manifest({
          maxSessions: 2,
          languages: ['typescript'],
          serverCommands: {
            typescript: commandConfig({ command: 'typescript-language-server', args: ['--stdio'], env: {} })
          }
        })
    });

    const session = await factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' });

    expect(manager.acquireCalls).toHaveLength(1);
    expect(manager.acquireCalls[0].acquire).toMatchObject({ maxSessions: 2, manualRestart: true });
    session.dispose();
  });

  it('opens a shared editor session for a configured runtime language without persisted languages', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () =>
        manifest({
          languages: [],
          serverCommands: {
            typescript: commandConfig({ command: 'typescript-language-server', args: ['--stdio'], env: { NODE_ENV: 'test' } })
          }
        })
    });

    const session = await factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' });

    expect(session.capabilities).toEqual({ hoverProvider: true, label: 'fake' });
    expect(manager.acquireCalls).toHaveLength(1);
    expect(manager.acquireCalls[0].start).toMatchObject({
      serverConfigId: 'typescript',
      command: 'typescript-language-server',
      env: { NODE_ENV: 'test' }
    });
    session.dispose();
  });

  it('refuses editor sessions when the server-side master LSP toggle is not enabled', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () =>
        manifest({
          enabled: false,
          languages: [],
          serverCommands: {
            typescript: commandConfig({ command: 'typescript-language-server', args: [], env: {} })
          }
        })
    });

    await expect(factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' })).rejects.toThrow(
      'LSP server command is not configured'
    );
    expect(manager.acquireCalls).toEqual([]);
  });

  it('keeps the websocket session path independent from manifest editor root authority', async () => {
    const manager = new FakeManager();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-editor-outside-root-'));
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () =>
        manifest({
          editorRoot: null,
          languages: [],
          serverCommands: {
            typescript: commandConfig({ command: 'typescript-language-server', args: [], env: {} })
          }
        })
    });

    try {
      const session = await factory({
        workspaceRoot: outsideRoot,
        uri: pathToFileURL(join(outsideRoot, 'sample.ts')).href,
        languageId: 'typescript'
      });
      expect(session.capabilities).toEqual({ hoverProvider: true, label: 'fake' });
      expect(manager.acquireCalls).toHaveLength(1);
      expect(manager.acquireCalls[0].start.workspaceRoot).toBe(outsideRoot);
      session.dispose();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('forwards raw messages, queues early server messages, and releases exactly once on dispose', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      warmSessions: {
        getStatus: () => ({
          state: 'ready',
          serverConfigId: 'typescript',
          workspaceRoot: root,
          languageId: 'typescript'
        })
      },
      readManifest: () => manifestWithTypescript()
    });
    const session = await factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' });

    manager.pushToEditor({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'early' } });
    const received: unknown[] = [];
    session.onServerMessage((message) => received.push(message));
    session.sendClientMessage({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: {} });

    expect(received).toEqual([{ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'early' } }]);
    expect(manager.consumer.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: {} }]);

    session.dispose();
    session.dispose();

    expect(manager.consumer.dispose).toHaveBeenCalledTimes(1);
    expect(manager.release).toHaveBeenCalledTimes(1);
  });

  it('sends an initial didOpen snapshot for the requested file URI so editor diagnostics can fan out', async () => {
    const manager = new FakeManager();
    const sample = join(root, 'sample.ts');
    const uri = pathToFileURL(sample).href;
    writeFileSync(sample, 'const live = true;\n');
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });

    const session = await factory({ workspaceRoot: root, uri, languageId: 'typescript' });

    expect(manager.consumer.sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 1,
            text: 'const live = true;\n'
          }
        }
      }
    ]);
    session.dispose();
  });

  it('publishes ready status for cold raw editor sessions after acquiring a lease', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });
    const statuses: unknown[] = [];

    const session = await factory({
      workspaceRoot: root,
      uri: fileUri('sample.ts'),
      languageId: 'typescript',
      publishStatus: (status: unknown) => statuses.push(status)
    });

    expect(statuses).toEqual([
      {
        state: 'ready',
        serverConfigId: 'typescript',
        workspaceRoot: root,
        languageId: 'typescript'
      }
    ]);
    session.dispose();
  });

  it('lazily sends didOpen before the first raw editor request for a textDocument URI', async () => {
    const manager = new FakeManager();
    const sample = join(root, 'lazy.ts');
    const uri = pathToFileURL(sample).href;
    writeFileSync(sample, 'const lazy = true;\n');
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });
    const session = await factory({ workspaceRoot: root, languageId: 'typescript' });

    session.sendClientMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'textDocument/hover',
      params: { textDocument: { uri } }
    });

    expect(manager.consumer.sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 1,
            text: 'const lazy = true;\n'
          }
        }
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'textDocument/hover',
        params: { textDocument: { uri } }
      }
    ]);
    session.dispose();
  });

  it('does not read or didOpen an out-of-root query URI', async () => {
    const manager = new FakeManager();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-outside-'));
    const secret = join(outsideRoot, 'secret.ts');
    writeFileSync(secret, 'OUTSIDE_SECRET_123\n');
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });

    try {
      const session = await factory({ workspaceRoot: root, uri: pathToFileURL(secret).href, languageId: 'typescript' });

      expect(manager.consumer.sent).toEqual([]);
      session.dispose();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not read or didOpen an out-of-root lazy textDocument URI', async () => {
    const manager = new FakeManager();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-outside-'));
    const secret = join(outsideRoot, 'lazy-secret.ts');
    const uri = pathToFileURL(secret).href;
    writeFileSync(secret, 'OUTSIDE_SECRET_456\n');
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });

    try {
      const session = await factory({ workspaceRoot: root, languageId: 'typescript' });
      session.sendClientMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'textDocument/hover',
        params: { textDocument: { uri } }
      });

      expect(manager.consumer.sent).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'textDocument/hover',
          params: { textDocument: { uri } }
        }
      ]);
      session.dispose();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not read or didOpen a workspace symlink that resolves outside the root', async () => {
    const manager = new FakeManager();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-outside-'));
    const secret = join(outsideRoot, 'symlink-secret.ts');
    const link = join(root, 'link.ts');
    writeFileSync(secret, 'OUTSIDE_SECRET_789\n');
    symlinkSync(secret, link);
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });

    try {
      const session = await factory({ workspaceRoot: root, uri: pathToFileURL(link).href, languageId: 'typescript' });

      expect(manager.consumer.sent).toEqual([]);
      session.dispose();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('publishes read-only lifecycle status and carries restart metadata on natural exit', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      warmSessions: {
        getStatus: () => ({
          state: 'ready',
          serverConfigId: 'typescript',
          workspaceRoot: root,
          languageId: 'typescript'
        })
      },
      readManifest: () => manifestWithTypescript()
    });
    const statuses: unknown[] = [];
    const session = await factory({
      workspaceRoot: root,
      uri: fileUri('sample.ts'),
      languageId: 'typescript',
      publishStatus: (status: unknown) => statuses.push(status)
    });
    const exits: unknown[] = [];
    session.onExit((exit) => exits.push(exit));

    manager.emitExit({
      ...manager.exitBase(),
      code: 7,
      signal: null,
      reason: 'natural',
      restart: { state: 'restarting', attempt: 1, maxAttempts: 3 }
    });

    expect(statuses).toEqual([
      {
        state: 'ready',
        serverConfigId: 'typescript',
        workspaceRoot: root,
        languageId: 'typescript',
        warm: true
      },
      {
        state: 'restarting',
        serverConfigId: 'typescript',
        workspaceRoot: root,
        languageId: 'typescript',
        restart: { state: 'restarting', attempt: 1, maxAttempts: 3 }
      }
    ]);
    expect(exits).toEqual([
      { code: 7, signal: null, restart: { state: 'restarting', attempt: 1, maxAttempts: 3 } }
    ]);
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain('typescript-language-server');
    expect(serialized).not.toContain('NODE_ENV');
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('initializationOptions');
  });

  it('emits matching natural exits once and suppresses stopped/dispose exits', async () => {
    const manager = new FakeManager();
    const factory = createEditorSharedSessionFactory({
      manager: manager as any,
      readManifest: () => manifestWithTypescript()
    });
    const session = await factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' });
    const exits: unknown[] = [];
    session.onExit((exit) => exits.push(exit));

    manager.emitExit({ ...manager.exitBase(), code: 3, signal: null, reason: 'stopped' });
    session.dispose();
    manager.emitExit({ ...manager.exitBase(), code: 4, signal: 'SIGTERM', reason: 'natural' });
    manager.emitExit({ ...manager.exitBase(), code: 5, signal: null, reason: 'natural' });

    expect(exits).toEqual([]);

    const second = await factory({ workspaceRoot: root, uri: fileUri('sample.ts'), languageId: 'typescript' });
    const secondExits: unknown[] = [];
    second.onExit((exit) => secondExits.push(exit));
    manager.emitExit({ ...manager.exitBase(), code: 7, signal: null, reason: 'natural' });
    manager.emitExit({ ...manager.exitBase(), code: 8, signal: null, reason: 'natural' });

    expect(secondExits).toEqual([{ code: 7, signal: null }]);
  });
});

class FakeManager {
  readonly acquireCalls: Array<{
    start: LspServerStartOptions;
    consumer: AttachRawSessionConsumerOptions;
    acquire: { maxSessions?: number; manualRestart?: boolean };
  }> = [];
  readonly consumer = new FakeRawConsumer();
  readonly release = vi.fn(() => this.consumer.dispose());
  private readonly exitListeners: Array<(event: LspManagedSessionExitEvent) => void> = [];

  async acquireRawConsumer(
    start: LspServerStartOptions,
    consumer: AttachRawSessionConsumerOptions,
    acquire: { maxSessions?: number; manualRestart?: boolean } = {}
  ): Promise<LspRawConsumerLease> {
    this.acquireCalls.push({ start, consumer, acquire });
    return {
      key: { serverConfigId: start.serverConfigId, workspaceRoot: start.workspaceRoot },
      capabilities: { hoverProvider: true, label: 'fake' },
      consumer: this.consumer,
      release: this.release
    };
  }

  onManagedSessionExit(listener: (event: LspManagedSessionExitEvent) => void): void {
    this.exitListeners.push(listener);
  }

  pushToEditor(message: unknown): void {
    this.acquireCalls.at(-1)?.consumer.onMessage(message);
  }

  emitExit(event: LspManagedSessionExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  exitBase(): Omit<LspManagedSessionExitEvent, 'code' | 'signal' | 'reason'> {
    return {
      key: { serverConfigId: 'typescript', workspaceRoot: root },
      sessionId: 'typescript-session'
    };
  }
}

class FakeRawConsumer implements RawSessionConsumer {
  readonly id = 'consumer:1';
  readonly kind = 'raw-editor';
  readonly sent: unknown[] = [];
  readonly dispose = vi.fn();

  sendClientMessage(message: unknown): void {
    this.sent.push(message);
  }

  useDiskDocument(): never {
    throw new Error('not used by editor adapter');
  }
}

function manifestWithTypescript(): any {
  return manifest({
    languages: ['typescript'],
    serverCommands: { typescript: commandConfig({ command: 'typescript-language-server', args: [], env: {} }) }
  });
}

function manifest(options: {
  languages: string[];
  serverCommands: Record<string, unknown>;
  maxSessions?: number;
  enabled?: boolean;
  editorRoot?: string | null;
}): any {
  return {
    settings: {
      ...(options.editorRoot === null ? {} : { editor: { root: options.editorRoot ?? root } }),
      lsp: {
        enabled: options.enabled ?? true,
        languages: options.languages,
        maxSessions: options.maxSessions,
        serverCommands: options.serverCommands
      }
    },
    groups: []
  };
}

function commandConfig(command: { command: string; args: string[]; env: Record<string, string> }): any {
  return {
    enabled: true,
    command: command.command,
    args: command.args,
    env: command.env,
    languageIds: ['typescript'],
    extensions: ['.ts']
  };
}

function fileUri(name: string): string {
  return pathToFileURL(join(root, name)).href;
}
