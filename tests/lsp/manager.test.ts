import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LspDiagnosticsStore } from '../../src/server/lsp/diagnosticsStore';
import { LspDocumentStore } from '../../src/server/lsp/documentStore';
import { LspManager, type LspManagedSessionExitEvent, type LspManagedSessionProgressEvent } from '../../src/server/lsp/manager';
import { LspSessionPool } from '../../src/server/lsp/sessionPool';
import type { LspVirtualSession } from '../../src/server/lspWebSocketBridge';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-manager-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LspManager', () => {
  it('lazily starts once, shares leases, and idle-stops after the last release', async () => {
    const virtual = new FakeVirtualSession();
    const created: FakeVirtualSession[] = [];
    const manager = createManager({
      maxSessions: 1,
      idleTimeoutMs: 10,
      createSession: async () => {
        created.push(virtual);
        return virtual;
      }
    });

    const first = await manager.acquireServer(serverOptions('typescript'));
    const second = await manager.acquireServer(serverOptions('typescript'));
    expect(created).toHaveLength(1);

    await expect(manager.acquireServer(serverOptions('python'))).rejects.toThrow(/capacity/i);

    first.release();
    expect(virtual.disposed).toBe(false);
    second.release();
    await vi.waitFor(() => expect(virtual.disposed).toBe(true));
  });

  it('shares one in-flight startup for concurrent acquires of the same server key', async () => {
    const created: FakeVirtualSession[] = [];
    const startupResolvers: Array<(session: FakeVirtualSession) => void> = [];
    const manager = createManager({
      idleTimeoutMs: 10,
      createSession: async () => {
        const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
        created.push(virtual);
        return new Promise<FakeVirtualSession>((resolve) => {
          startupResolvers.push(resolve);
        });
      }
    });

    const first = manager.acquireServer(serverOptions('typescript'));
    const second = manager.acquireServer(serverOptions('typescript'));
    await Promise.resolve();
    expect(created).toHaveLength(1);

    startupResolvers[0](created[0]);
    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(firstLease.capabilities.label).toBe('fake-1');
    expect(secondLease.capabilities.label).toBe('fake-1');

    firstLease.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(created[0].disposed).toBe(false);

    secondLease.release();
    await vi.waitFor(() => expect(created[0].disposed).toBe(true));
  });

  it('releases capacity after startup failure and natural exit', async () => {
    const healthy = new FakeVirtualSession();
    let failStartup = true;
    const manager = createManager({
      maxSessions: 1,
      createSession: async () => {
        if (failStartup) {
          failStartup = false;
          throw new Error('startup failed');
        }
        return healthy;
      }
    });

    await expect(manager.acquireServer(serverOptions('typescript'))).rejects.toThrow(/startup failed/);
    const lease = await manager.acquireServer(serverOptions('typescript'));
    healthy.exit({ code: 7, signal: null });

    const next = await manager.acquireServer(serverOptions('typescript'));
    expect(next.key.serverConfigId).toBe('typescript');
    lease.release();
    next.release();
  });

  it('restarts a crashed leased session within the crash window', async () => {
    const created: FakeVirtualSession[] = [];
    const manager = createManager({
      restartPolicy: { maxRestarts: 1, windowMs: 1_000 },
      createSession: async () => {
        const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
        created.push(virtual);
        return virtual;
      }
    });

    const lease = await manager.acquireServer(serverOptions('typescript'));
    expect(lease.capabilities.label).toBe('fake-1');

    created[0].exit({ code: 9, signal: null });

    await vi.waitFor(() => expect(created).toHaveLength(2));
    const restartedLease = await manager.acquireServer(serverOptions('typescript'));
    const request = manager.sendRequest(lease.key, 'textDocument/hover', { marker: 'after-restart' });
    expect(created[1].sent.at(-1)).toMatchObject({ method: 'textDocument/hover', params: { marker: 'after-restart' } });
    created[1].emitServerMessage({ jsonrpc: '2.0', id: (created[1].sent.at(-1) as any).id, result: 'restarted-result' });
    await expect(request).resolves.toBe('restarted-result');

    restartedLease.release();
    lease.release();
  });

  it('emits a stopped restart event when automatic restart startup fails', async () => {
    const exits: LspManagedSessionExitEvent[] = [];
    const initial = new FakeVirtualSession({ hoverProvider: true, label: 'initial' });
    let starts = 0;
    const manager = createManager({
      restartPolicy: { maxRestarts: 1, windowMs: 1_000 },
      createSession: async () => {
        starts += 1;
        if (starts === 1) {
          return initial;
        }
        throw new Error('restart startup failed');
      }
    });
    manager.onManagedSessionExit((exit) => exits.push(exit));

    const lease = await manager.acquireServer(serverOptions('typescript'));
    initial.exit({ code: 9, signal: null });

    await vi.waitFor(() => expect(exits).toHaveLength(2));
    expect(exits[0].restart).toEqual({ state: 'restarting', attempt: 1, maxAttempts: 1 });
    expect(exits[1]).toMatchObject({
      key: lease.key,
      sessionId: exits[0].sessionId,
      code: 9,
      signal: null,
      reason: 'natural',
      restart: { state: 'stopped', attempt: 1, maxAttempts: 1 }
    });
    await expect(manager.acquireServer(serverOptions('typescript'))).rejects.toThrow(/manual restart/i);

    lease.release();
  });

  it('waits for the pending restart when acquireServer reenters from an exit listener', async () => {
    const created: FakeVirtualSession[] = [];
    const startupResolvers: Array<(session: FakeVirtualSession) => void> = [];
    const manager = createManager({
      restartPolicy: { maxRestarts: 1, windowMs: 1_000 },
      createSession: async () => {
        const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
        created.push(virtual);
        if (created.length === 1) {
          return virtual;
        }
        return new Promise<FakeVirtualSession>((resolve) => {
          startupResolvers.push(resolve);
        });
      }
    });
    const lease = await manager.acquireServer(serverOptions('typescript'));
    let reentrantResolved = false;
    let reentrantLease: Awaited<ReturnType<typeof manager.acquireServer>> | undefined;
    manager.onManagedSessionExit(() => {
      void manager.acquireServer(serverOptions('typescript')).then((nextLease) => {
        reentrantResolved = true;
        reentrantLease = nextLease;
      });
    });

    created[0].exit({ code: 9, signal: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(created).toHaveLength(2);
    expect(reentrantResolved).toBe(false);

    startupResolvers[0](created[1]);
    await vi.waitFor(() => expect(reentrantResolved).toBe(true));
    expect(reentrantLease?.capabilities.label).toBe('fake-2');

    reentrantLease?.release();
    lease.release();
  });

  it('stops after exhausting the crash budget and requires a manual restart', async () => {
    const created: FakeVirtualSession[] = [];
    const exits: LspManagedSessionExitEvent[] = [];
    const manager = createManager({
      restartPolicy: { maxRestarts: 1, windowMs: 1_000 },
      createSession: async () => {
        const virtual = new FakeVirtualSession({ hoverProvider: true, label: `fake-${created.length + 1}` });
        created.push(virtual);
        return virtual;
      }
    });
    manager.onManagedSessionExit((exit) => exits.push(exit));

    const lease = await manager.acquireServer(serverOptions('typescript'));
    created[0].exit({ code: 1, signal: null });
    await vi.waitFor(() => expect(created).toHaveLength(2));
    const restartedLease = await manager.acquireServer(serverOptions('typescript'));
    restartedLease.release();
    created[1].exit({ code: 2, signal: null });
    await vi.waitFor(() => expect(exits.at(-1)?.restart?.state).toBe('stopped'));

    await expect(manager.acquireServer(serverOptions('typescript'))).rejects.toThrow(/manual restart/i);
    const recovered = await manager.acquireServer(serverOptions('typescript'), { manualRestart: true });
    expect(recovered.capabilities.label).toBe('fake-3');
    expect(created).toHaveLength(3);

    lease.release();
    recovered.release();
  });

  it('keeps restart state events free of command, env, initialization option, and token payloads', async () => {
    const exits: LspManagedSessionExitEvent[] = [];
    const virtual = new FakeVirtualSession();
    const manager = createManager({
      restartPolicy: { maxRestarts: 0, windowMs: 1_000 },
      createSession: async () => virtual
    });
    manager.onManagedSessionExit((exit) => exits.push(exit));

    const lease = await manager.acquireServer({
      serverConfigId: 'typescript',
      workspaceRoot: root,
      command: 'SECRET_COMMAND',
      args: ['SECRET_ARG'],
      env: { SECRET_ENV: 'SECRET_ENV_VALUE' },
      initializationOptions: { token: 'SECRET_INIT_TOKEN', serverCommands: { typescript: 'SECRET_SERVER_COMMAND' } },
      startupTimeoutMs: 500
    });
    virtual.exit({ code: 2, signal: null });

    expect(exits).toHaveLength(1);
    expect(exits[0].restart?.state).toBe('stopped');
    expect(JSON.stringify(exits[0])).not.toMatch(
      /SECRET_COMMAND|SECRET_ARG|SECRET_ENV|SECRET_INIT_TOKEN|SECRET_SERVER_COMMAND|serverCommands|initializationOptions|token/
    );

    lease.release();
  });

  it('idle-stops using the stored session key after the workspace directory is removed', async () => {
    const virtual = new FakeVirtualSession();
    const manager = createManager({
      idleTimeoutMs: 10,
      createSession: async () => virtual
    });

    const lease = await manager.acquireServer(serverOptions('typescript'));
    lease.release();
    rmSync(root, { recursive: true, force: true });

    await vi.waitFor(() => expect(virtual.disposed).toBe(true));
  });

  it('syncs saved disk documents per live session and closes opened documents on stop', async () => {
    const firstVirtual = new FakeVirtualSession();
    const secondVirtual = new FakeVirtualSession({ label: 'second' });
    const virtuals = [firstVirtual, secondVirtual];
    const manager = createManager({
      idleTimeoutMs: 10,
      createSession: async () => virtuals.shift() ?? new FakeVirtualSession()
    });
    const filePath = join(root, 'sample.ts');
    const uri = pathToFileURL(filePath).href;
    writeFileSync(filePath, 'const value = 1;\n');

    const lease = await manager.acquireServer(serverOptions('typescript'));
    const first = manager.sendRequest(lease.key, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 6 }
    }, { languageId: 'typescript' });
    expect(firstVirtual.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/hover'
    ]);
    expect((firstVirtual.sent[0] as any).params.textDocument).toMatchObject({
      uri,
      languageId: 'typescript',
      version: 1,
      text: 'const value = 1;\n'
    });
    firstVirtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'first' });
    await expect(first).resolves.toBe('first');

    const second = manager.sendRequest(lease.key, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 7 }
    }, { languageId: 'typescript' });
    expect(firstVirtual.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/hover',
      'textDocument/hover'
    ]);
    firstVirtual.emitServerMessage({ jsonrpc: '2.0', id: 2, result: 'second' });
    await expect(second).resolves.toBe('second');

    writeFileSync(filePath, 'const value = 2;\n');
    const third = manager.sendRequest(lease.key, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 8 }
    }, { languageId: 'typescript' });
    expect(firstVirtual.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/hover',
      'textDocument/hover',
      'textDocument/didChange',
      'textDocument/hover'
    ]);
    expect((firstVirtual.sent[3] as any).params).toMatchObject({
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'const value = 2;\n' }]
    });
    firstVirtual.emitServerMessage({ jsonrpc: '2.0', id: 3, result: 'third' });
    await expect(third).resolves.toBe('third');

    lease.release();
    await vi.waitFor(() => expect(firstVirtual.disposed).toBe(true));
    expect(firstVirtual.sent.map((message: any) => message.method)).toContain('textDocument/didClose');

    const nextLease = await manager.acquireServer(serverOptions('typescript'));
    const fourth = manager.sendRequest(nextLease.key, 'textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 9 }
    }, { languageId: 'typescript' });
    expect(secondVirtual.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/hover'
    ]);
    secondVirtual.emitServerMessage({ jsonrpc: '2.0', id: (secondVirtual.sent.at(-1) as any).id, result: 'fourth' });
    await expect(fourth).resolves.toBe('fourth');
    nextLease.release();
  });

  it('uses raw editor-open documents for requests and diagnostics staleness without disk reads', async () => {
    const virtual = new FakeVirtualSession();
    const manager = createManager({ createSession: async () => virtual });
    const uri = pathToFileURL(join(root, 'editor-owned-missing.ts')).href;
    const rawLease = await (manager as any).acquireRawConsumer(serverOptions('typescript'), {
      kind: 'raw-editor',
      onMessage: () => undefined
    });

    rawLease.consumer.sendClientMessage(didOpen(uri, 'const live = true;\n', 5));
    const hover = manager.sendRequest(
      rawLease.key,
      'textDocument/hover',
      { textDocument: { uri }, position: { line: 0, character: 7 } },
      { languageId: 'typescript' }
    );

    expect(virtual.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/hover'
    ]);
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'hover-result' });
    await expect(hover).resolves.toBe('hover-result');

    virtual.emitServerMessage(publishDiagnostics(uri, 'stale editor diagnostic', 4));
    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({ diagnostics: [] });

    virtual.emitServerMessage(publishDiagnostics(uri, 'current editor diagnostic', 5));
    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
      diagnostics: [diagnosticValue('current editor diagnostic')]
    });

    rawLease.release();
  });

  it('shares refcount between raw consumers and requestApi leases', async () => {
    const virtual = new FakeVirtualSession();
    const created: FakeVirtualSession[] = [];
    const manager = createManager({
      idleTimeoutMs: 10,
      createSession: async () => {
        created.push(virtual);
        return virtual;
      }
    });

    const requestLease = await manager.acquireServer(serverOptions('typescript'));
    const rawLease = await (manager as any).acquireRawConsumer(serverOptions('typescript'), {
      kind: 'raw-editor',
      onMessage: () => undefined
    });
    expect(created).toHaveLength(1);

    requestLease.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(virtual.disposed).toBe(false);

    rawLease.release();
    await vi.waitFor(() => expect(virtual.disposed).toBe(true));
  });

  it('notifies only ready running sessions for a workspace without starting another session', async () => {
    const firstVirtual = new FakeVirtualSession({
      workspace: { fileOperations: { didCreate: { filters: [{ pattern: { glob: '*.ts' } }] } } },
      label: 'first'
    });
    const secondRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-manager-second-'));
    const secondVirtual = new FakeVirtualSession({
      workspace: { fileOperations: { didCreate: { filters: [{ pattern: { glob: '*.ts' } }] } } },
      label: 'second'
    });
    const created: FakeVirtualSession[] = [];
    const manager = createManager({
      createSession: async () => {
        const virtual = created.length === 0 ? firstVirtual : secondVirtual;
        created.push(virtual);
        return virtual;
      }
    });

    try {
      const first = await manager.acquireServer(serverOptions('typescript'));
      const second = await manager.acquireServer({ ...serverOptions('typescript'), workspaceRoot: secondRoot });

      const count = await manager.notifyRunningSessionsForWorkspaceFileOperation({
        workspaceRoot: root,
        method: 'workspace/didCreateFiles',
        params: { files: [{ uri: 'file:///workspace/sample.ts' }] },
        matchesCapabilities: (capabilities) => capabilities.label === 'first'
      });

      expect(count).toBe(1);
      expect(created).toHaveLength(2);
      expect(firstVirtual.sent.at(-1)).toEqual({
        jsonrpc: '2.0',
        method: 'workspace/didCreateFiles',
        params: { files: [{ uri: 'file:///workspace/sample.ts' }] }
      });
      expect(secondVirtual.sent).toEqual([]);

      first.release();
      second.release();
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('does not reset an existing idle timer when sending file-operation notifications', async () => {
    const virtual = new FakeVirtualSession({
      workspace: { fileOperations: { didDelete: { filters: [{ pattern: { glob: '*.ts' } }] } } }
    });
    const manager = createManager({
      idleTimeoutMs: 10,
      createSession: async () => virtual
    });
    const lease = await manager.acquireServer(serverOptions('typescript'));
    lease.release();

    const count = await manager.notifyRunningSessionsForWorkspaceFileOperation({
      workspaceRoot: root,
      method: 'workspace/didDeleteFiles',
      params: { files: [{ uri: 'file:///workspace/sample.ts' }] },
      matchesCapabilities: () => true
    });

    expect(count).toBe(1);
    await vi.waitFor(() => expect(virtual.disposed).toBe(true));
  });

  it('returns zero for file-operation notifications when no matching session is running', async () => {
    const created: FakeVirtualSession[] = [];
    const manager = createManager({
      createSession: async () => {
        const virtual = new FakeVirtualSession();
        created.push(virtual);
        return virtual;
      }
    });

    const count = await manager.notifyRunningSessionsForWorkspaceFileOperation({
      workspaceRoot: root,
      method: 'workspace/didCreateFiles',
      params: { files: [{ uri: 'file:///workspace/sample.ts' }] },
      matchesCapabilities: () => true
    });

    expect(count).toBe(0);
    expect(created).toEqual([]);
  });

  it('requests willRename from all matching ready running sessions without starting or touching idle state', async () => {
    const firstVirtual = new FakeVirtualSession({ label: 'typescript' });
    const secondVirtual = new FakeVirtualSession({ label: 'eslint' });
    const otherRootVirtual = new FakeVirtualSession({ label: 'other-root' });
    const created: FakeVirtualSession[] = [];
    const secondRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-manager-second-'));
    const manager = createManager({
      idleTimeoutMs: 20,
      createSession: async () => {
        const virtual = [firstVirtual, secondVirtual, otherRootVirtual][created.length] ?? new FakeVirtualSession();
        created.push(virtual);
        return virtual;
      }
    });

    try {
      const first = await manager.acquireServer(serverOptions('typescript'));
      const second = await manager.acquireServer(serverOptions('eslint'));
      const otherRoot = await manager.acquireServer({ ...serverOptions('typescript'), workspaceRoot: secondRoot });
      first.release();

      const request = manager.requestRunningSessionsForWorkspaceFileOperation({
        workspaceRoot: root,
        method: 'workspace/willRenameFiles',
        params: { files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }] },
        matchesCapabilities: (capabilities) => capabilities.label !== 'other-root',
        timeoutMs: 100
      });

      await vi.waitFor(() => {
        expect(firstVirtual.sent).toHaveLength(1);
        expect(secondVirtual.sent).toHaveLength(1);
      });
      expect(otherRootVirtual.sent).toEqual([]);
      expect(firstVirtual.sent[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'workspace/willRenameFiles',
        params: { files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }] }
      });
      expect(secondVirtual.sent[0]).toMatchObject({ method: 'workspace/willRenameFiles' });
      firstVirtual.emitServerMessage({ jsonrpc: '2.0', id: (firstVirtual.sent[0] as any).id, result: { changes: {} } });
      secondVirtual.emitServerMessage({ jsonrpc: '2.0', id: (secondVirtual.sent[0] as any).id, result: null });

      await expect(request).resolves.toEqual([
        { sessionId: expect.stringContaining('typescript'), result: { changes: {} } },
        { sessionId: expect.stringContaining('eslint'), result: null }
      ]);
      expect(created).toHaveLength(3);
      await vi.waitFor(() => expect(firstVirtual.disposed).toBe(true));

      second.release();
      otherRoot.release();
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty willRename request result without starting when no session matches', async () => {
    const created: FakeVirtualSession[] = [];
    const manager = createManager({
      createSession: async () => {
        const virtual = new FakeVirtualSession();
        created.push(virtual);
        return virtual;
      }
    });

    await expect(
      manager.requestRunningSessionsForWorkspaceFileOperation({
        workspaceRoot: root,
        method: 'workspace/willRenameFiles',
        params: { files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }] },
        matchesCapabilities: () => true,
        timeoutMs: 10
      })
    ).resolves.toEqual([]);
    expect(created).toEqual([]);
  });

  it('merges dynamic file-operation filters for running-session matching without exposing registration internals', async () => {
    const token = 'tok_MANAGER_SECRET';
    const virtual = new FakeVirtualSession({
      workspace: { fileOperations: { willRename: { filters: [{ pattern: { glob: '*.js' } }] } } },
      label: 'typescript'
    });
    const manager = createManager({ idleTimeoutMs: 20, createSession: async () => virtual });
    const lease = await manager.acquireServer(serverOptions('typescript'));
    lease.release();

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 90,
      method: 'client/registerCapability',
      params: {
        registrations: [
          {
            id: `secret-${token}`,
            method: 'workspace/willRenameFiles',
            registerOptions: {
              filters: [{ pattern: { glob: '*.ts', matches: 'file' }, [`key-${token}`]: true }],
              env: token,
              command: token,
              serverCommands: token
            }
          }
        ]
      }
    });
    expect(virtual.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 90, result: null });

    let observedCapabilities: Record<string, unknown> | undefined;
    const request = manager.requestRunningSessionsForWorkspaceFileOperation({
      workspaceRoot: root,
      method: 'workspace/willRenameFiles',
      params: { files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }] },
      matchesCapabilities: (capabilities) => {
        observedCapabilities = capabilities;
        const filters = (((capabilities.workspace as any)?.fileOperations as any)?.willRename as any)?.filters;
        return Array.isArray(filters) && filters.some((filter) => filter?.pattern?.glob === '*.ts');
      },
      timeoutMs: 100
    });

    await vi.waitFor(() => expect(virtual.sent.some((message: any) => message.method === 'workspace/willRenameFiles')).toBe(true));
    const willRename = virtual.sent.find((message: any) => message.method === 'workspace/willRenameFiles') as any;
    expect(willRename.params).toEqual({
      files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }]
    });
    expect(JSON.stringify(willRename)).not.toContain(token);
    expect(JSON.stringify(observedCapabilities)).not.toContain(token);
    expect(JSON.stringify(observedCapabilities)).not.toContain('registerOptions');
    expect(JSON.stringify(observedCapabilities)).not.toContain('serverCommands');
    expect(((observedCapabilities?.workspace as any).fileOperations.willRename.filters as any[]).map((filter) => filter.pattern.glob)).toEqual([
      '*.js',
      '*.ts'
    ]);
    virtual.emitServerMessage({ jsonrpc: '2.0', id: willRename.id, result: null });
    await expect(request).resolves.toEqual([{ sessionId: expect.stringContaining('typescript'), result: null }]);
    await vi.waitFor(() => expect(virtual.disposed).toBe(true));
  });

  it('replaces and unregisters dynamic registrations without weakening static filters', async () => {
    const virtual = new FakeVirtualSession({
      workspace: { fileOperations: { didCreate: { filters: [{ pattern: { glob: '*.js' } }] } } },
      label: 'typescript'
    });
    const manager = createManager({ createSession: async () => virtual });
    const lease = await manager.acquireServer(serverOptions('typescript'));

    virtual.emitServerMessage(registerFileOperation(1, 'replace-me', 'workspace/didCreateFiles', '*.ts'));
    virtual.emitServerMessage(registerFileOperation(2, 'replace-me', 'workspace/didCreateFiles', '*.tsx'));

    const dynamicCount = await manager.notifyRunningSessionsForWorkspaceFileOperation({
      workspaceRoot: root,
      method: 'workspace/didCreateFiles',
      params: { files: [{ uri: 'file:///workspace/new.tsx' }] },
      matchesCapabilities: (capabilities) => {
        const filters = (((capabilities.workspace as any)?.fileOperations as any)?.didCreate as any)?.filters;
        expect(filters.map((filter: any) => filter.pattern.glob)).toEqual(['*.js', '*.tsx']);
        return filters.some((filter: any) => filter.pattern.glob === '*.tsx');
      }
    });
    expect(dynamicCount).toBe(1);

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'client/unregisterCapability',
      params: { unregisterations: [{ id: 'replace-me', method: 'workspace/didCreateFiles' }] }
    });
    const staticCount = await manager.notifyRunningSessionsForWorkspaceFileOperation({
      workspaceRoot: root,
      method: 'workspace/didCreateFiles',
      params: { files: [{ uri: 'file:///workspace/new.js' }] },
      matchesCapabilities: (capabilities) => {
        const filters = (((capabilities.workspace as any)?.fileOperations as any)?.didCreate as any)?.filters;
        expect(filters.map((filter: any) => filter.pattern.glob)).toEqual(['*.js']);
        return filters.some((filter: any) => filter.pattern.glob === '*.js');
      }
    });
    expect(staticCount).toBe(1);
    lease.release();
  });

  it('maps willRename request timeout to a generic error without raw server details', async () => {
    const virtual = new FakeVirtualSession({ label: 'typescript' });
    const manager = createManager({ createSession: async () => virtual });
    const lease = await manager.acquireServer(serverOptions('typescript'));

    await expect(
      manager.requestRunningSessionsForWorkspaceFileOperation({
        workspaceRoot: root,
        method: 'workspace/willRenameFiles',
        params: { files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }] },
        matchesCapabilities: () => true,
        timeoutMs: 5
      })
    ).rejects.toThrow('LSP file operation request failed');
    await expect(
      manager.requestRunningSessionsForWorkspaceFileOperation({
        workspaceRoot: root,
        method: 'workspace/willRenameFiles',
        params: { files: [{ oldUri: 'file:///workspace/old.ts', newUri: 'file:///workspace/new.ts' }] },
        matchesCapabilities: () => true,
        timeoutMs: 5
      })
    ).rejects.not.toThrow(/workspace|serverConfig|command/);

    lease.release();
  });

  it('applies a per-start capacity override for raw editor sessions without changing the manager default', async () => {
    const firstVirtual = new FakeVirtualSession({ label: 'first' });
    const secondVirtual = new FakeVirtualSession({ label: 'second' });
    const thirdVirtual = new FakeVirtualSession({ label: 'third' });
    const virtuals = [firstVirtual, secondVirtual, thirdVirtual];
    const secondRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-manager-second-'));
    const manager = createManager({
      maxSessions: 4,
      idleTimeoutMs: 10,
      createSession: async () => virtuals.shift() ?? new FakeVirtualSession()
    });

    try {
      const first = await (manager as any).acquireRawConsumer(
        serverOptions('typescript'),
        { kind: 'raw-editor', onMessage: () => undefined },
        { maxSessions: 1 }
      );

      await expect(
        (manager as any).acquireRawConsumer(
          { ...serverOptions('python'), workspaceRoot: secondRoot },
          { kind: 'raw-editor', onMessage: () => undefined },
          { maxSessions: 1 }
        )
      ).rejects.toThrow(/capacity/i);

      const sameKey = await (manager as any).acquireRawConsumer(
        serverOptions('typescript'),
        { kind: 'raw-editor', onMessage: () => undefined },
        { maxSessions: 1 }
      );
      sameKey.release();

      first.release();
      await vi.waitFor(() => expect(firstVirtual.disposed).toBe(true));

      const retry = await (manager as any).acquireRawConsumer(
        { ...serverOptions('python'), workspaceRoot: secondRoot },
        { kind: 'raw-editor', onMessage: () => undefined },
        { maxSessions: 1 }
      );
      retry.release();
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('ingests publishDiagnostics as minimal diagnostics and clears on empty publish', async () => {
    const virtual = new FakeVirtualSession();
    const diagnosticsStore = new LspDiagnosticsStore();
    const manager = createManager({
      createSession: async () => virtual,
      diagnosticsStore
    });
    const uri = pathToFileURL(join(root, 'sample.ts')).href;
    const lease = await manager.acquireServer(serverOptions('typescript'));

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        version: 7,
        diagnostics: [
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
            message: 'normal diagnostic',
            severity: 1,
            source: 'typescript',
            code: 'ts-100',
            tags: [1],
            relatedInformation: [{ location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }],
            codeDescription: { href: 'https://example.test/ts-100' },
            data: { secret: 'nope' }
          },
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
            message: 'object code omitted',
            code: { value: 'object-code' }
          }
        ]
      }
    });
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 123, diagnostics: [{ message: 'malformed' }] }
    });
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [
          { msg: 'missing range and message' },
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
            msg: 'missing message field'
          }
        ]
      }
    });

    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
      diagnostics: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          message: 'normal diagnostic',
          severity: 1,
          source: 'typescript',
          code: 'ts-100',
          tags: [1]
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          message: 'object code omitted'
        }
      ]
    });

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [] }
    });

    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({ diagnostics: [] });
    lease.release();
  });

  it('emits sanitized managed progress events without server command configuration', async () => {
    const virtual = new FakeVirtualSession();
    const manager = createManager({ createSession: async () => virtual });
    const progress: LspManagedSessionProgressEvent[] = [];
    manager.onManagedSessionProgress((event) => progress.push(event));
    const lease = await manager.acquireServer({
      ...serverOptions('typescript'),
      env: { SECRET_TOKEN: 'tok_PROGRESS_SECRET' },
      initializationOptions: { command: 'nope', nested: { env: 'nope' } }
    });

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'begin', title: 'Indexing', percentage: 0 } }
    });
    virtual.emitServerMessage({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'ignored' } });

    expect(progress).toEqual([
      {
        key: lease.key,
        sessionId: `typescript\u0000${root}`,
        params: { token: 'index', value: { kind: 'begin', title: 'Indexing', percentage: 0 } }
      }
    ]);
    const serialized = JSON.stringify(progress);
    expect(serialized).not.toContain('SECRET_TOKEN');
    expect(serialized).not.toContain('tok_PROGRESS_SECRET');
    expect(serialized).not.toContain('initializationOptions');
    expect(serialized).not.toContain('serverCommands');
    lease.release();
  });

  it('keeps same serverConfigId diagnostics isolated by session id and clears only stopped sessions', async () => {
    const secondRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-manager-second-'));
    const firstVirtual = new FakeVirtualSession({ label: 'first' });
    const secondVirtual = new FakeVirtualSession({ label: 'second' });
    const virtuals = [firstVirtual, secondVirtual];
    const manager = createManager({
      idleTimeoutMs: 10,
      createSession: async () => virtuals.shift() ?? new FakeVirtualSession()
    });
    const uri = 'file:///shared/example.ts';

    try {
      const firstLease = await manager.acquireServer(serverOptions('typescript'));
      const secondLease = await manager.acquireServer({ ...serverOptions('typescript'), workspaceRoot: secondRoot });

      firstVirtual.emitServerMessage(publishDiagnostics(uri, 'first diagnostic'));
      secondVirtual.emitServerMessage(publishDiagnostics(uri, 'second diagnostic'));

      expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
        diagnostics: [diagnosticValue('first diagnostic'), diagnosticValue('second diagnostic')]
      });

      firstLease.release();
      await vi.waitFor(() => expect(firstVirtual.disposed).toBe(true));

      expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
        diagnostics: [diagnosticValue('second diagnostic')]
      });

      secondVirtual.exit({ code: 0, signal: null });
      expect(manager.getDiagnostics({ workspaceRoot: secondRoot, uri })).toEqual({ diagnostics: [] });
      secondLease.release();
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('ignores stale versioned diagnostics using the current disk document snapshot version', async () => {
    const virtual = new FakeVirtualSession();
    const manager = createManager({ createSession: async () => virtual });
    const filePath = join(root, 'versioned.ts');
    const uri = pathToFileURL(filePath).href;
    writeFileSync(filePath, 'const value = 1;\n');
    const lease = await manager.acquireServer(serverOptions('typescript'));

    const first = manager.sendRequest(
      lease.key,
      'textDocument/hover',
      { textDocument: { uri }, position: { line: 0, character: 1 } },
      { languageId: 'typescript' }
    );
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 1, result: 'first' });
    await expect(first).resolves.toBe('first');
    virtual.emitServerMessage(publishDiagnostics(uri, 'current diagnostic', 1));

    writeFileSync(filePath, 'const value = 2;\n');
    const second = manager.sendRequest(
      lease.key,
      'textDocument/hover',
      { textDocument: { uri }, position: { line: 0, character: 2 } },
      { languageId: 'typescript' }
    );
    virtual.emitServerMessage({ jsonrpc: '2.0', id: 2, result: 'second' });
    await expect(second).resolves.toBe('second');

    virtual.emitServerMessage(publishDiagnostics(uri, 'stale diagnostic', 1));

    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
      diagnostics: [diagnosticValue('current diagnostic')]
    });

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, version: 1, diagnostics: [] }
    });

    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
      diagnostics: [diagnosticValue('current diagnostic')]
    });

    virtual.emitServerMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, version: 2, diagnostics: [] }
    });

    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({ diagnostics: [] });
    lease.release();
  });

  it('pulls diagnostics from a ready running diagnosticProvider session without resetting idle state', async () => {
    const virtual = new FakeVirtualSession({ diagnosticProvider: true, label: 'typescript' });
    const manager = createManager({
      idleTimeoutMs: 20,
      createSession: async () => virtual
    });
    const filePath = join(root, 'pull.ts');
    const uri = pathToFileURL(filePath).href;
    writeFileSync(filePath, 'const value = 1;\n');
    const lease = await manager.acquireServer(serverOptions('typescript'));
    lease.release();

    const pull = manager.pullDiagnosticsForRunningSession({
      workspaceRoot: root,
      serverConfigId: 'typescript',
      uri,
      languageId: 'typescript',
      timeoutMs: 100
    });

    await vi.waitFor(() => expect(virtual.sent.some((message: any) => message.method === 'textDocument/diagnostic')).toBe(true));
    const request = virtual.sent.find((message: any) => message.method === 'textDocument/diagnostic') as any;
    expect(request.params).toEqual({ textDocument: { uri } });
    expect(JSON.stringify(request.params)).not.toContain('previousResultId');
    expect(JSON.stringify(request.params)).not.toContain('workDoneToken');
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        kind: 'full',
        resultId: 'ignored',
        items: [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } },
            message: 'pulled diagnostic',
            severity: 2,
            code: { value: 'object-code' },
            tags: [1, 'bad']
          }
        ],
        relatedDocuments: {
          [uri]: { kind: 'full', items: [{ message: 'leak' }] }
        }
      }
    });

    await expect(pull).resolves.toEqual({
      status: 'updated',
      diagnostics: [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } },
          message: 'pulled diagnostic',
          severity: 2,
          tags: [1]
        }
      ]
    });
    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
      diagnostics: [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } },
          message: 'pulled diagnostic',
          severity: 2,
          tags: [1]
        }
      ]
    });
    await vi.waitFor(() => expect(virtual.disposed).toBe(true));
  });

  it('records disk-open, duplicate editor-open conversion, store update, later edit, and pull timing', async () => {
    const virtual = new FakeVirtualSession({ diagnosticProvider: true, label: 'rust' });
    const documentStore = new LspDocumentStore();
    const pool = new LspSessionPool({ createSession: async () => virtual });
    const manager = new LspManager(pool, { idleTimeoutMs: 1_000, documentStore });
    const srcDir = join(root, 'src');
    mkdirSync(srcDir);
    const filePath = join(srcDir, 'main.rs');
    const diskText = ['fn main() {', '    let _broken: i32 = ; undefined_symbol_here();', '}'].join('\n');
    const editedText = ['fn main() {', '    let _broken: i32 = ; undefined_symbol_here();', '    let _next = 1;', '}'].join('\n');
    const incrementalInsert = '    let _next = 1;\n';
    const uri = pathToFileURL(filePath).href;
    writeFileSync(filePath, diskText);
    const diskSummary = textSummary(diskText);
    const editedSummary = textSummary(editedText);
    const incrementalSummary = textSummary(incrementalInsert);
    const lease = await manager.acquireServer(serverOptions('rust'));
    lease.release();

    const pull = manager.pullDiagnosticsForRunningSession({
      workspaceRoot: root,
      serverConfigId: 'rust',
      uri,
      languageId: 'rust',
      timeoutMs: 100
    });

    await vi.waitFor(() => expect(virtual.sent.some((message: any) => message.method === 'textDocument/diagnostic')).toBe(true));
    const rawLease = await manager.acquireRawConsumer(serverOptions('rust'), {
      kind: 'raw-editor',
      onMessage: () => undefined
    });
    rawLease.consumer.sendClientMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'rust', version: 1, text: diskText } }
    });
    expect(summarizeDocumentSnapshot(documentStore.getSnapshot({ workspaceRoot: root, uri }))).toEqual({
      state: 'editor-open',
      uri,
      languageId: 'rust',
      version: 2,
      lineCount: diskSummary.lineCount,
      hash: diskSummary.hash
    });
    rawLease.consumer.sendClientMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
            text: incrementalInsert
          }
        ]
      }
    });

    const evidence = virtual.sent.map((message) => summarizeLspMessage(message));
    expect(evidence).toEqual([
      {
        method: 'textDocument/didOpen',
        uri,
        languageId: 'rust',
        version: 1,
        lineCount: diskSummary.lineCount,
        hash: diskSummary.hash
      },
      { method: 'textDocument/diagnostic', uri },
      {
        method: 'textDocument/didChange',
        uri,
        version: 2,
        lineCount: diskSummary.lineCount,
        hash: diskSummary.hash
      },
      {
        method: 'textDocument/didChange',
        uri,
        version: 3,
        lineCount: incrementalSummary.lineCount,
        hash: incrementalSummary.hash
      }
    ]);
    expect(evidence[1]?.method).toBe('textDocument/diagnostic');
    expect((evidence[2] as any).version).toBeGreaterThan((evidence[0] as any).version);

    expect(summarizeDocumentSnapshot(documentStore.getSnapshot({ workspaceRoot: root, uri }))).toEqual({
      state: 'editor-open',
      uri,
      languageId: 'rust',
      version: 3,
      lineCount: editedSummary.lineCount,
      hash: editedSummary.hash
    });
    expect(editedSummary.hash).not.toBe(incrementalSummary.hash);

    const request = virtual.sent.find((message: any) => message.method === 'textDocument/diagnostic') as any;
    virtual.emitServerMessage({ jsonrpc: '2.0', id: request.id, result: { kind: 'full', items: [] } });
    await expect(pull).resolves.toMatchObject({ status: 'updated' });
    rawLease.release();
  });

  it('preserves existing diagnostics when pull diagnostics fails or is unsupported', async () => {
    const unsupported = new FakeVirtualSession({ hoverProvider: true, label: 'typescript' });
    const manager = createManager({ createSession: async () => unsupported });
    const uri = pathToFileURL(join(root, 'unsupported.ts')).href;
    const lease = await manager.acquireServer(serverOptions('typescript'));
    unsupported.emitServerMessage(publishDiagnostics(uri, 'existing diagnostic'));

    await expect(
      manager.pullDiagnosticsForRunningSession({
        workspaceRoot: root,
        serverConfigId: 'typescript',
        uri,
        languageId: 'typescript',
        timeoutMs: 5
      })
    ).resolves.toEqual({
      status: 'unsupported',
      diagnostics: [diagnosticValue('existing diagnostic')]
    });
    expect(unsupported.sent).toEqual([]);

    await expect(
      manager.pullDiagnosticsForRunningSession({
        workspaceRoot: root,
        serverConfigId: 'missing',
        uri,
        languageId: 'typescript',
        timeoutMs: 5
      })
    ).resolves.toEqual({
      status: 'not_running',
      diagnostics: [diagnosticValue('existing diagnostic')]
    });

    lease.release();
  });

  it('preserves existing diagnostics when a non-empty pull report sanitizes to no valid diagnostics', async () => {
    const virtual = new FakeVirtualSession({ diagnosticProvider: true, label: 'typescript' });
    const manager = createManager({ createSession: async () => virtual });
    const filePath = join(root, 'malformed-pull.ts');
    const uri = pathToFileURL(filePath).href;
    writeFileSync(filePath, 'const value = 1;\n');
    const lease = await manager.acquireServer(serverOptions('typescript'));
    virtual.emitServerMessage(publishDiagnostics(uri, 'kept diagnostic'));

    const pull = manager.pullDiagnosticsForRunningSession({
      workspaceRoot: root,
      serverConfigId: 'typescript',
      uri,
      languageId: 'typescript',
      timeoutMs: 100
    });

    await vi.waitFor(() => expect(virtual.sent.some((message: any) => message.method === 'textDocument/diagnostic')).toBe(true));
    const request = virtual.sent.find((message: any) => message.method === 'textDocument/diagnostic') as any;
    virtual.emitServerMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        kind: 'full',
        items: [{ range: { bad: true }, message: 'invalid diagnostic' }]
      }
    });

    await expect(pull).resolves.toEqual({
      status: 'failed',
      diagnostics: [diagnosticValue('kept diagnostic')]
    });
    expect(manager.getDiagnostics({ workspaceRoot: root, uri })).toEqual({
      diagnostics: [diagnosticValue('kept diagnostic')]
    });

    lease.release();
  });
});

function createManager(options: {
  maxSessions?: number;
  idleTimeoutMs?: number;
  restartPolicy?: { maxRestarts: number; windowMs: number };
  diagnosticsStore?: LspDiagnosticsStore;
  createSession: () => Promise<FakeVirtualSession> | FakeVirtualSession;
}): LspManager {
  const pool = new LspSessionPool({ createSession: options.createSession });
  return new LspManager(pool, {
    maxSessions: options.maxSessions ?? 4,
    idleTimeoutMs: options.idleTimeoutMs ?? 1_000,
    restartPolicy: options.restartPolicy,
    diagnosticsStore: options.diagnosticsStore
  });
}

function serverOptions(serverConfigId: string) {
  return {
    serverConfigId,
    workspaceRoot: root,
    command: 'unused',
    args: [],
    env: {},
    initializationOptions: {},
    startupTimeoutMs: 500
  };
}

function publishDiagnostics(uri: string, message: string, version?: number) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      ...(version !== undefined ? { version } : {}),
      diagnostics: [diagnosticValue(message)]
    }
  };
}

function diagnosticValue(message: string) {
  return {
    range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } },
    message
  };
}

function didOpen(uri: string, text: string, version = 1) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'typescript', version, text } }
  };
}

function registerFileOperation(id: number, registrationId: string, method: string, glob: string) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'client/registerCapability',
    params: {
      registrations: [
        {
          id: registrationId,
          method,
          registerOptions: { filters: [{ pattern: { glob } }] }
        }
      ]
    }
  };
}

function summarizeLspMessage(message: unknown) {
  const value = message as any;
  const method = typeof value?.method === 'string' ? value.method : undefined;
  if (method === 'textDocument/didOpen') {
    const document = value.params?.textDocument;
    return {
      method,
      uri: document?.uri,
      languageId: document?.languageId,
      version: document?.version,
      ...textSummary(document?.text)
    };
  }
  if (method === 'textDocument/didChange') {
    const change = value.params?.contentChanges?.find((entry: any) => typeof entry?.text === 'string');
    return {
      method,
      uri: value.params?.textDocument?.uri,
      version: value.params?.textDocument?.version,
      ...textSummary(change?.text)
    };
  }
  if (method === 'textDocument/diagnostic') {
    return { method, uri: value.params?.textDocument?.uri };
  }
  return { method };
}

function summarizeDocumentSnapshot(snapshot: unknown) {
  const value = snapshot as any;
  return {
    state: value?.state,
    uri: value?.uri,
    languageId: value?.languageId,
    version: value?.version,
    ...textSummary(value?.text)
  };
}

function textSummary(text: unknown): { lineCount: number | undefined; hash: string | undefined } {
  if (typeof text !== 'string') {
    return { lineCount: undefined, hash: undefined };
  }
  return {
    lineCount: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    hash: createHash('sha256').update(text).digest('hex')
  };
}

class FakeVirtualSession implements LspVirtualSession {
  capabilities: Record<string, unknown>;
  sent: unknown[] = [];
  disposed = false;
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
