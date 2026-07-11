import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeFileOperationCapabilities } from '../src/server/lsp/fileOperationRegistrations';
import { createLspFileOperationCoordinator } from '../src/server/lsp/lspFileOperationCoordinator';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-file-ops-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LspFileOperationCoordinator', () => {
  it('sends didCreate only when static didCreate file filters match', async () => {
    const manager = fakeManager({
      workspace: {
        fileOperations: {
          didCreate: { filters: [{ scheme: 'file', pattern: { glob: '**/*.{ts,tsx}', matches: 'file' } }] }
        }
      }
    });
    const coordinator = createLspFileOperationCoordinator({ manager });
    writeFileSync(join(root, 'sample.ts'), '');

    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'sample.ts'), kind: 'file' })).resolves.toBe(1);

    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0].method).toBe('workspace/didCreateFiles');
    expect(manager.calls[0].params).toEqual({ files: [{ uri: pathToFileURL(join(root, 'sample.ts')).href }] });
  });

  it('does not notify for missing capability, unmatched glob, or scheme mismatch', async () => {
    const manager = fakeManager({});
    const coordinator = createLspFileOperationCoordinator({ manager });
    writeFileSync(join(root, 'sample.ts'), '');

    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'sample.ts'), kind: 'file' })).resolves.toBe(0);
    manager.capabilities = {
      workspace: { fileOperations: { didCreate: { filters: [{ pattern: { glob: '*.py' } }] } } }
    };
    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'sample.ts'), kind: 'file' })).resolves.toBe(0);
    manager.capabilities = {
      workspace: { fileOperations: { didCreate: { filters: [{ scheme: 'untitled', pattern: { glob: '*.ts' } }] } } }
    };
    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'sample.ts'), kind: 'file' })).resolves.toBe(0);
  });

  it('honors folder filters, ignoreCase, and unsupported glob fail-closed behavior', async () => {
    const manager = fakeManager({
      workspace: {
        fileOperations: {
          didCreate: {
            filters: [
              { pattern: { glob: 'SRC', matches: 'folder', options: { ignoreCase: true } } },
              { pattern: { glob: '[unsafe]*.ts' } }
            ]
          }
        }
      }
    });
    const coordinator = createLspFileOperationCoordinator({ manager });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'unsafe.ts'), '');

    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'src'), kind: 'folder' })).resolves.toBe(1);
    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'unsafe.ts'), kind: 'file' })).resolves.toBe(0);
  });

  it('preserves spec-shaped ignoreCase options when merging dynamic registrations', () => {
    const merged = mergeFileOperationCapabilities(
      {},
      [
        {
          id: 'folders',
          method: 'workspace/didCreateFiles',
          filters: [{ pattern: { glob: 'SRC', matches: 'folder', options: { ignoreCase: true } } }]
        }
      ]
    );

    expect(merged).toEqual({
      workspace: {
        fileOperations: {
          didCreate: {
            filters: [{ pattern: { glob: 'SRC', matches: 'folder', options: { ignoreCase: true } } }]
          }
        }
      }
    });
  });

  it('sends didRename and didDelete payloads without leaking capabilities', async () => {
    const token = 'DESK_LSP_TOKEN_SHOULD_NOT_LEAK';
    const manager = fakeManager({
      command: `/tmp/${token}/server`,
      env: { SECRET: token },
      workspace: {
        fileOperations: {
          didRename: { filters: [{ pattern: { glob: '*.ts' } }] },
          didDelete: { filters: [{ pattern: { glob: '*.ts' } }] }
        }
      }
    });
    const coordinator = createLspFileOperationCoordinator({ manager });
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    writeFileSync(oldPath, '');
    writeFileSync(newPath, '');

    await expect(coordinator.didRename({ workspaceRoot: root, oldPath, newPath, kind: 'file' })).resolves.toBe(1);
    await expect(coordinator.didDelete({ workspaceRoot: root, path: oldPath, kind: 'file' })).resolves.toBe(1);

    expect(manager.calls.map((call) => call.method)).toEqual(['workspace/didRenameFiles', 'workspace/didDeleteFiles']);
    expect(JSON.stringify(manager.calls)).not.toContain(token);
    expect(manager.calls[0].params).toEqual({
      files: [{ oldUri: pathToFileURL(oldPath).href, newUri: pathToFileURL(newPath).href }]
    });
    expect(manager.calls[1].params).toEqual({ files: [{ uri: pathToFileURL(oldPath).href }] });
  });

  it('fails closed for non-existing targets whose parent is missing or outside the workspace', async () => {
    const manager = fakeManager({
      workspace: { fileOperations: { didCreate: { filters: [{ pattern: { glob: '*.ts' } }] } } }
    });
    const coordinator = createLspFileOperationCoordinator({ manager });

    await expect(coordinator.didCreate({ workspaceRoot: root, path: join(root, 'missing', 'sample.ts'), kind: 'file' })).resolves.toBe(0);
  });

  it('previews willRename for file filters only and returns ready edits', async () => {
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const refsPath = join(root, 'refs.ts');
    writeFileSync(oldPath, 'old\n');
    writeFileSync(refsPath, 'old ref\n');
    const manager = fakeManager({
      workspace: {
        fileOperations: {
          willRename: { filters: [{ scheme: 'file', pattern: { glob: '**/*.ts', matches: 'file' } }] }
        }
      }
    });
    manager.requestResults = [
      {
        sessionId: 'typescript',
        result: {
          changes: {
            [pathToFileURL(refsPath).href]: [{ range: range(0, 0, 0, 3), newText: 'new' }]
          }
        }
      }
    ];
    const coordinator = createLspFileOperationCoordinator({ manager });

    const preview = await coordinator.previewRename({ workspaceRoot: root, from: oldPath, to: newPath, kind: 'file' });

    expect(preview).toMatchObject({
      ok: true,
      status: 'ready',
      operation: { from: oldPath, to: newPath, kind: 'file' },
      changes: [{ uri: pathToFileURL(refsPath).href, path: refsPath, edits: [{ range: range(0, 0, 0, 3), newText: 'new' }] }]
    });
    expect(manager.requestCalls).toHaveLength(1);
    expect(manager.requestCalls[0]).toMatchObject({
      method: 'workspace/willRenameFiles',
      params: { files: [{ oldUri: pathToFileURL(oldPath).href, newUri: pathToFileURL(newPath).href }] }
    });
  });

  it('previews folder willRename using folder filters and applies with one didRename', async () => {
    const oldDir = join(root, 'src');
    const newDir = join(root, 'lib');
    const oldFile = join(oldDir, 'main.ts');
    mkdirSync(oldDir);
    writeFileSync(oldFile, 'old\n');
    const manager = fakeManager({
      workspace: {
        fileOperations: {
          willRename: { filters: [{ scheme: 'file', pattern: { glob: 'src', matches: 'folder' } }] },
          didRename: { filters: [{ scheme: 'file', pattern: { glob: 'lib', matches: 'folder' } }] }
        }
      }
    });
    manager.requestResults = [
      {
        sessionId: 'typescript',
        result: {
          changes: {
            [pathToFileURL(oldFile).href]: [{ range: range(0, 0, 0, 3), newText: 'new' }]
          }
        }
      }
    ];
    const coordinator = createLspFileOperationCoordinator({ manager });

    const preview = await coordinator.previewRename({ workspaceRoot: root, from: oldDir, to: newDir, kind: 'folder' });
    expect(preview).toMatchObject({ ok: true, status: 'ready', operation: { type: 'rename', from: oldDir, to: newDir, kind: 'folder' } });
    const applied = await coordinator.applyRename({ workspaceRoot: root, previewId: preview.ok && preview.status === 'ready' ? preview.previewId : '' });

    expect(applied).toMatchObject({ ok: true, path: newDir });
    expect(readFileSync(join(newDir, 'main.ts'), 'utf8')).toBe('new\n');
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]).toEqual({
      method: 'workspace/didRenameFiles',
      params: { files: [{ oldUri: pathToFileURL(oldDir).href, newUri: pathToFileURL(newDir).href }] }
    });
  });

  it('previews willCreate and willDelete and emits exactly one post-success did notification', async () => {
    const createdPath = join(root, 'created.ts');
    const deletedPath = join(root, 'deleted.ts');
    const refsPath = join(root, 'refs.ts');
    writeFileSync(deletedPath, 'delete me\n');
    writeFileSync(refsPath, 'missing deleted\n');
    const manager = fakeManager({
      workspace: {
        fileOperations: {
          willCreate: { filters: [{ pattern: { glob: '*.ts', matches: 'file' } }] },
          didCreate: { filters: [{ pattern: { glob: '*.ts', matches: 'file' } }] },
          willDelete: { filters: [{ pattern: { glob: '*.ts', matches: 'file' } }] },
          didDelete: { filters: [{ pattern: { glob: '*.ts', matches: 'file' } }] }
        }
      }
    });
    const coordinator = createLspFileOperationCoordinator({ manager });

    manager.requestResults = [{ sessionId: 'typescript', result: { changes: { [pathToFileURL(createdPath).href]: [{ range: range(0, 0, 0, 0), newText: 'created\n' }] } } }];
    const createPreview = await coordinator.previewCreate({ workspaceRoot: root, path: createdPath, kind: 'file' });
    const createApply = await coordinator.applyCreate({ workspaceRoot: root, previewId: createPreview.ok && createPreview.status === 'ready' ? createPreview.previewId : '' });

    manager.requestResults = [{ sessionId: 'typescript', result: { changes: { [pathToFileURL(refsPath).href]: [{ range: range(0, 8, 0, 15), newText: 'removed' }] } } }];
    const deletePreview = await coordinator.previewDelete({ workspaceRoot: root, path: deletedPath, kind: 'file' });
    const deleteApply = await coordinator.applyDelete({ workspaceRoot: root, previewId: deletePreview.ok && deletePreview.status === 'ready' ? deletePreview.previewId : '' });

    expect(createApply).toMatchObject({ ok: true, path: createdPath });
    expect(deleteApply).toMatchObject({ ok: true, path: deletedPath });
    expect(manager.calls.map((call) => call.method)).toEqual(['workspace/didCreateFiles', 'workspace/didDeleteFiles']);
    expect(manager.requestCalls.map((call) => call.method)).toEqual(['workspace/willCreateFiles', 'workspace/willDeleteFiles']);
  });

  it('returns fallback statuses for no running session, no capability, and no edits without mutation', async () => {
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    writeFileSync(oldPath, 'old\n');
    const manager = fakeManager({});
    const coordinator = createLspFileOperationCoordinator({ manager });

    manager.hasRunningSession = false;
    await expect(coordinator.previewRename({ workspaceRoot: root, from: oldPath, to: newPath, kind: 'file' })).resolves.toMatchObject({
      ok: true,
      status: 'no-running-session',
      changes: []
    });
    manager.hasRunningSession = true;
    await expect(coordinator.previewRename({ workspaceRoot: root, from: oldPath, to: newPath, kind: 'file' })).resolves.toMatchObject({
      ok: true,
      status: 'no-capability',
      changes: []
    });
    manager.capabilities = {
      workspace: { fileOperations: { willRename: { filters: [{ pattern: { glob: '*.ts', matches: 'file' } }] } } }
    };
    manager.requestResults = [{ sessionId: 'typescript', result: null }];
    await expect(coordinator.previewRename({ workspaceRoot: root, from: oldPath, to: newPath, kind: 'file' })).resolves.toMatchObject({
      ok: true,
      status: 'no-edits',
      changes: []
    });
    expect(readFileSync(oldPath, 'utf8')).toBe('old\n');
  });
});

function fakeManager(capabilities: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const requestCalls: Array<{ method: string; params: unknown }> = [];
  const manager = {
    capabilities,
    calls,
    requestCalls,
    requestResults: [] as Array<{ sessionId: string; result: unknown }>,
    hasRunningSession: true,
    hasRunningSessionForWorkspaceFileOperation: vi.fn(async () => (manager as any).hasRunningSession),
    requestRunningSessionsForWorkspaceFileOperation: vi.fn(async (input: {
      method: 'workspace/willRenameFiles';
      params: unknown;
      matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
    }) => {
      if (!input.matchesCapabilities((manager as any).capabilities)) {
        return [];
      }
      requestCalls.push({ method: input.method, params: input.params });
      return (manager as any).requestResults;
    }),
    notifyRunningSessionsForWorkspaceFileOperation: vi.fn(async (input: {
      method: 'workspace/didCreateFiles' | 'workspace/didRenameFiles' | 'workspace/didDeleteFiles';
      params: unknown;
      matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
    }) => {
      if (!input.matchesCapabilities((manager as any).capabilities)) {
        return 0;
      }
      calls.push({ method: input.method, params: input.params });
      return 1;
    })
  };
  return manager;
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}
