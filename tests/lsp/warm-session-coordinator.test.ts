import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorSharedSessionFactory } from '../../src/server/lsp/editorSharedSessionFactory';
import { LspManager } from '../../src/server/lsp/manager';
import { LspSessionPool } from '../../src/server/lsp/sessionPool';
import { createLspWarmSessionCoordinator } from '../../src/server/lsp/warmSessionCoordinator';
import type { LspVirtualSession } from '../../src/server/lspWebSocketBridge';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-warm-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createLspWarmSessionCoordinator', () => {
  it('defers boot warmup scheduling without blocking startup', async () => {
    const scheduled: Array<() => void | Promise<void>> = [];
    const detector = { detect: vi.fn(async () => ({ languages: ['typescript'], truncated: false })) };
    const manager = new FakeWarmManager();
    const coordinator = createLspWarmSessionCoordinator({
      manager: manager as any,
      languageDetector: detector,
      readManifest: () => manifestWithTypescript(),
      schedule: (task) => {
        scheduled.push(task);
      }
    });

    coordinator.scheduleBootWarmup();

    expect(scheduled).toHaveLength(1);
    expect(detector.detect).not.toHaveBeenCalled();
    expect(manager.acquireCalls).toEqual([]);

    await scheduled[0]();

    expect(detector.detect).toHaveBeenCalledWith({ root, refresh: false });
    expect(manager.acquireCalls).toHaveLength(1);
    coordinator.dispose();
  });

  it('warms only trusted detected non-disabled project languages and stores redacted status', async () => {
    const detector = { detect: vi.fn(async () => ({ languages: ['typescript', 'python'], truncated: false })) };
    const manager = new FakeWarmManager();
    const coordinator = createLspWarmSessionCoordinator({
      manager: manager as any,
      languageDetector: detector,
      readManifest: () =>
        manifest({
          disabledLanguages: ['python'],
          serverCommands: {
            typescript: commandConfig({
              command: 'typescript-language-server',
              args: ['--stdio'],
              env: { SECRET_TOKEN: 'tok_WARM_SECRET' },
              languageIds: ['typescript'],
              extensions: ['.ts']
            }),
            python: commandConfig({
              command: 'pyright-langserver',
              args: ['--stdio'],
              env: {},
              languageIds: ['python'],
              extensions: ['.py']
            })
          }
        })
    });

    const result = await coordinator.warmProject();

    expect(result).toEqual({ warmed: 1, degraded: 0, skipped: 1 });
    expect(manager.acquireCalls).toHaveLength(1);
    expect(manager.acquireCalls[0].start).toMatchObject({
      serverConfigId: 'typescript',
      workspaceRoot: root,
      command: 'typescript-language-server',
      args: ['--stdio'],
      env: { SECRET_TOKEN: 'tok_WARM_SECRET' }
    });
    const status = coordinator.getStatus({ serverConfigId: 'typescript', workspaceRoot: root, languageId: 'typescript' });
    expect(status).toEqual({ state: 'ready', serverConfigId: 'typescript', workspaceRoot: root, languageId: 'typescript' });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('tok_WARM_SECRET');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('env');
    coordinator.dispose();
    expect(manager.releases).toBe(1);
  });

  it('keeps a warmed persistent lease and attaches editor sessions with didOpen to the same server', async () => {
    const sample = join(root, 'sample.ts');
    const uri = pathToFileURL(sample).href;
    writeFileSync(sample, 'const warmed = true;\n');
    const created: FakeVirtualSession[] = [];
    const manager = new LspManager(
      new LspSessionPool({
        createSession: async () => {
          const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
          created.push(virtual);
          return virtual;
        }
      }),
      { idleTimeoutMs: 10 }
    );
    const coordinator = createLspWarmSessionCoordinator({
      manager,
      languageDetector: { detect: async () => ({ languages: ['typescript'], truncated: false }) },
      readManifest: () => manifestWithTypescript()
    });

    await coordinator.warmProject();
    expect(created).toHaveLength(1);

    const statuses: unknown[] = [];
    const factory = createEditorSharedSessionFactory({
      manager,
      warmSessions: coordinator,
      readManifest: () => manifestWithTypescript()
    });
    const session = await factory({
      workspaceRoot: root,
      uri,
      languageId: 'typescript',
      publishStatus: (status: unknown) => statuses.push(status)
    });

    expect(created).toHaveLength(1);
    expect(created[0].sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId: 'typescript', version: 1, text: 'const warmed = true;\n' } }
      }
    ]);
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', serverConfigId: 'typescript', workspaceRoot: root, warm: true });
    session.dispose();
    coordinator.dispose();
    await manager.stopAll();
  });

  it('records degraded warm failures while leaving the lazy editor path available', async () => {
    const sample = join(root, 'fallback.ts');
    const uri = pathToFileURL(sample).href;
    writeFileSync(sample, 'const fallback = true;\n');
    const created: FakeVirtualSession[] = [];
    let failWarm = true;
    const manager = new LspManager(
      new LspSessionPool({
        createSession: async () => {
          if (failWarm) {
            failWarm = false;
            throw new Error('warm failed');
          }
          const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
          created.push(virtual);
          return virtual;
        }
      }),
      { idleTimeoutMs: 10 }
    );
    const coordinator = createLspWarmSessionCoordinator({
      manager,
      languageDetector: { detect: async () => ({ languages: ['typescript'], truncated: false }) },
      readManifest: () => manifestWithTypescript()
    });

    const result = await coordinator.warmProject();

    expect(result).toEqual({ warmed: 0, degraded: 1, skipped: 0 });
    expect(coordinator.getStatus({ serverConfigId: 'typescript', workspaceRoot: root, languageId: 'typescript' })).toMatchObject({
      state: 'degraded',
      serverConfigId: 'typescript',
      workspaceRoot: root,
      languageId: 'typescript'
    });

    const statuses: unknown[] = [];
    const factory = createEditorSharedSessionFactory({
      manager,
      warmSessions: coordinator,
      readManifest: () => manifestWithTypescript()
    });
    const session = await factory({
      workspaceRoot: root,
      uri,
      languageId: 'typescript',
      publishStatus: (status: unknown) => statuses.push(status)
    });

    expect(created).toHaveLength(1);
    expect(created[0].sent.at(-1)).toMatchObject({ method: 'textDocument/didOpen' });
    expect(statuses).toEqual([
      {
        state: 'degraded',
        serverConfigId: 'typescript',
        workspaceRoot: root,
        languageId: 'typescript',
        reason: 'warm-start-failed'
      },
      {
        state: 'ready',
        serverConfigId: 'typescript',
        workspaceRoot: root,
        languageId: 'typescript',
        warm: false
      }
    ]);
    session.dispose();
    coordinator.dispose();
    await manager.stopAll();
  });
});

class FakeWarmManager {
  readonly acquireCalls: Array<{ start: any; acquire: any }> = [];
  releases = 0;

  async acquireServer(start: any, acquire: any = {}) {
    this.acquireCalls.push({ start, acquire });
    return {
      key: { serverConfigId: start.serverConfigId, workspaceRoot: start.workspaceRoot },
      capabilities: { hoverProvider: true },
      release: () => {
        this.releases += 1;
      }
    };
  }
}

class FakeVirtualSession implements LspVirtualSession {
  sent: unknown[] = [];
  disposed = false;
  private readonly serverListeners: Array<(message: unknown) => void> = [];
  private readonly exitListeners: Array<(exit: { code: number | null; signal: string | null }) => void> = [];

  constructor(readonly capabilities: Record<string, unknown> = { hoverProvider: true }) {}

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
    this.disposed = true;
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

function manifestWithTypescript(): any {
  return manifest({
    serverCommands: {
      typescript: commandConfig({
        command: 'typescript-language-server',
        args: ['--stdio'],
        env: {},
        languageIds: ['typescript'],
        extensions: ['.ts']
      })
    }
  });
}

function manifest(options: { serverCommands: Record<string, unknown>; disabledLanguages?: string[] }): any {
  return {
    settings: {
      editor: { root },
      lsp: {
        enabled: true,
        disabledLanguages: options.disabledLanguages,
        serverCommands: options.serverCommands
      }
    },
    groups: []
  };
}

function commandConfig(command: {
  command: string;
  args: string[];
  env: Record<string, string>;
  languageIds: string[];
  extensions: string[];
}): any {
  return {
    enabled: true,
    command: command.command,
    args: command.args,
    env: command.env,
    languageIds: command.languageIds,
    extensions: command.extensions
  };
}
