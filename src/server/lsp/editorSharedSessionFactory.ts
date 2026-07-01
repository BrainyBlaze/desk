import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeskManifest } from '../../core/types.js';
import type {
  LspLifecycleStatusEvent,
  LspVirtualSession,
  LspVirtualSessionExit,
  LspVirtualSessionFactoryOptions
} from '../lspWebSocketBridge.js';
import { matchLspLanguages } from './languageMatcher.js';
import type { LspManagedSessionExitEvent, LspManager } from './manager.js';
import type { RawSessionConsumer } from './rawSessionMultiplexer.js';
import { normalizeConfiguredLspServers } from './settings.js';

export interface EditorSharedSessionFactoryOptions {
  manager: Pick<LspManager, 'acquireRawConsumer' | 'onManagedSessionExit'>;
  readManifest: () => Pick<DeskManifest, 'settings'>;
  warmSessions?: {
    getStatus(input: { serverConfigId: string; workspaceRoot: string; languageId?: string }): LspLifecycleStatusEvent | undefined;
  };
}

export function createEditorSharedSessionFactory(
  options: EditorSharedSessionFactoryOptions
): (input: LspVirtualSessionFactoryOptions) => Promise<LspVirtualSession> {
  return async (input) => {
    const manifest = options.readManifest();
    const workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot);
    const config = normalizeConfiguredLspServers((manifest.settings as { lsp?: unknown } | undefined)?.lsp);
    const command = matchLspLanguages({ settings: config, uri: input.uri, languageId: input.languageId })[0];
    if (!command) {
      throw new Error('LSP server command is not configured');
    }
    const languageId = input.languageId ?? command.languageIds[0] ?? command.id;
    const warmStatus = options.warmSessions?.getStatus({
      serverConfigId: command.serverConfigId,
      workspaceRoot,
      languageId
    });
    if (warmStatus?.state === 'warming' || warmStatus?.state === 'degraded') {
      input.publishStatus?.(warmStatus);
    }

    const pendingBeforeAdapter: unknown[] = [];
    let adapter: EditorSharedVirtualSession | undefined;
    const lease = await options.manager.acquireRawConsumer(
      {
        serverConfigId: command.serverConfigId,
        workspaceRoot,
        command: command.command,
        args: command.args,
        env: command.env,
        initializationOptions: command.initializationOptions,
        startupTimeoutMs: config.startupTimeoutMs
      },
      {
        kind: 'raw-editor',
        onMessage: (message) => {
          if (adapter) {
            adapter.dispatchServerMessage(message);
            return;
          }
          pendingBeforeAdapter.push(message);
        }
      },
      { maxSessions: config.maxSessions, manualRestart: true }
    );

    const openDocument = createInitialDocumentOpener(
      lease.consumer,
      languageId,
      workspaceRoot
    );
    adapter = new EditorSharedVirtualSession({
      capabilities: lease.capabilities,
      sendClientMessage: (message) => lease.consumer.sendClientMessage(message),
      beforeClientMessage: (message) => openDocument(readMessageTextDocumentUri(message)),
      disposeLease: () => lease.release()
    });
    for (const message of pendingBeforeAdapter) {
      adapter.dispatchServerMessage(message);
    }
    openDocument(input.uri);
    input.publishStatus?.({
      state: 'ready',
      serverConfigId: command.serverConfigId,
      workspaceRoot,
      languageId,
      ...(warmStatus ? { warm: warmStatus.state === 'ready' } : {})
    });

    options.manager.onManagedSessionExit((event) => {
      if (event.reason !== 'natural' || !sameSession(event, command.serverConfigId, workspaceRoot)) {
        return;
      }
      if (event.restart) {
        input.publishStatus?.({
          state: event.restart.state,
          serverConfigId: command.serverConfigId,
          workspaceRoot,
          languageId,
          restart: event.restart
        });
      }
      adapter.emitNaturalExit({ code: event.code, signal: event.signal, ...(event.restart ? { restart: event.restart } : {}) });
    });

    return adapter;
  };
}

class EditorSharedVirtualSession implements LspVirtualSession {
  readonly capabilities: Record<string, unknown>;
  private readonly sendClientMessageImpl: (message: unknown) => void;
  private readonly beforeClientMessage: (message: unknown) => void;
  private readonly disposeLease: () => void;
  private readonly serverListeners: Array<(message: unknown) => void> = [];
  private readonly exitListeners: Array<(exit: LspVirtualSessionExit) => void> = [];
  private readonly queuedMessages: unknown[] = [];
  private disposed = false;
  private exitEmitted = false;

  constructor(options: {
    capabilities: Record<string, unknown>;
    sendClientMessage: (message: unknown) => void;
    beforeClientMessage: (message: unknown) => void;
    disposeLease: () => void;
  }) {
    this.capabilities = options.capabilities;
    this.sendClientMessageImpl = options.sendClientMessage;
    this.beforeClientMessage = options.beforeClientMessage;
    this.disposeLease = options.disposeLease;
  }

  sendClientMessage(message: unknown): void {
    if (this.disposed) {
      return;
    }
    this.beforeClientMessage(message);
    this.sendClientMessageImpl(message);
  }

  onServerMessage(listener: (message: unknown) => void): void {
    this.serverListeners.push(listener);
    for (const message of this.queuedMessages.splice(0)) {
      listener(message);
    }
  }

  onExit(listener: (exit: LspVirtualSessionExit) => void): void {
    this.exitListeners.push(listener);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLease();
  }

  dispatchServerMessage(message: unknown): void {
    if (this.disposed) {
      return;
    }
    if (this.serverListeners.length === 0) {
      this.queuedMessages.push(message);
      return;
    }
    for (const listener of this.serverListeners) {
      listener(message);
    }
  }

  emitNaturalExit(exit: LspVirtualSessionExit): void {
    if (this.disposed || this.exitEmitted) {
      return;
    }
    this.disposed = true;
    this.exitEmitted = true;
    for (const listener of this.exitListeners) {
      listener(exit);
    }
  }
}

function resolveWorkspaceRoot(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute path');
  }
  const real = realpathSync(workspaceRoot);
  if (!statSync(real).isDirectory()) {
    throw new Error('workspaceRoot must be an existing directory');
  }
  return real;
}

function sameSession(event: LspManagedSessionExitEvent, serverConfigId: string, workspaceRoot: string): boolean {
  return event.key.serverConfigId === serverConfigId && event.key.workspaceRoot === workspaceRoot;
}

function createInitialDocumentOpener(
  consumer: RawSessionConsumer,
  languageId: string | undefined,
  workspaceRoot: string
): (uri: string | undefined) => void {
  const opened = new Set<string>();
  return (uri) => {
    if (!uri || !languageId || !uri.startsWith('file://') || opened.has(uri)) {
      return;
    }
    const filePath = resolveContainedFileUri(uri, workspaceRoot);
    if (!filePath) {
      return;
    }
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    opened.add(uri);
    consumer.sendClientMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text
        }
      }
    });
  };
}

function resolveContainedFileUri(uri: string, workspaceRoot: string): string | undefined {
  let realFilePath: string;
  try {
    realFilePath = realpathSync(fileURLToPath(uri));
  } catch {
    return undefined;
  }
  const rel = relative(workspaceRoot, realFilePath);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    return undefined;
  }
  return realFilePath;
}

function readMessageTextDocumentUri(message: unknown): string | undefined {
  if (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    typeof (message as { params?: { textDocument?: { uri?: unknown } } }).params?.textDocument?.uri === 'string'
  ) {
    return (message as { params: { textDocument: { uri: string } } }).params.textDocument.uri;
  }
  return undefined;
}
