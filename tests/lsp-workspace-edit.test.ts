import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLspFileOperationPreviewStore, createLspRenamePreviewStore } from '../src/server/lsp/lspWorkspaceEdit';

let root: string;
let now = 1_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-workspace-edit-'));
  now = 1_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LSP rename workspace edit preview/apply store', () => {
  it('creates a one-use preview, applies UTF-16 edits after rename, and emits one didRename', async () => {
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const otherPath = join(root, 'refs.ts');
    writeFileSync(oldPath, 'export const smile = "\u{1f603}";\r\n');
    writeFileSync(otherPath, 'import { smile } from "./old";\nconsole.log(smile);\n');
    const notifyDidRename = vi.fn(async () => 1);
    const store = createStore({ notifyDidRename });

    const preview = await store.createPreview({
      workspaceRoot: root,
      from: oldPath,
      to: newPath,
      serverResults: [
        {
          sessionId: 'typescript',
          result: {
            changes: {
              [pathToFileURL(otherPath).href]: [
                {
                  range: { start: { line: 0, character: 25 }, end: { line: 0, character: 28 } },
                  newText: 'new'
                }
              ],
              [pathToFileURL(oldPath).href]: [
                {
                  range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
                  newText: 'grin'
                },
                {
                  range: { start: { line: 0, character: 25 }, end: { line: 0, character: 26 } },
                  newText: ' as const;'
                }
              ]
            }
          }
        }
      ]
    });

    expect(preview).toMatchObject({
      ok: true,
      status: 'ready',
      previewId: 'preview-1',
      operation: { from: oldPath, to: newPath, kind: 'file' }
    });
    expect(preview.ok && preview.changes.map((change) => change.path).sort()).toEqual([newPath, otherPath].sort());

    const applied = await store.apply({ workspaceRoot: root, previewId: 'preview-1' });

    expect(applied).toEqual({
      ok: true,
      operation: { type: 'rename', from: oldPath, to: newPath, kind: 'file' },
      path: newPath,
      changedFiles: [newPath, otherPath].sort()
    });
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(newPath, 'utf8')).toBe('export const grin = "\u{1f603}" as const;\r\n');
    expect(readFileSync(otherPath, 'utf8')).toBe('import { smile } from "./new";\nconsole.log(smile);\n');
    expect(notifyDidRename).toHaveBeenCalledTimes(1);
    expect(notifyDidRename).toHaveBeenCalledWith({ workspaceRoot: root, oldPath, newPath, kind: 'file' });
    await expect(store.apply({ workspaceRoot: root, previewId: 'preview-1' })).resolves.toEqual({
      ok: false,
      statusCode: 409,
      error: 'preview expired',
      reason: 'preview-expired'
    });
  });

  it('rejects unsupported edit shapes, non-null versions, out-of-root targets, and overlapping ranges', async () => {
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const otherPath = join(root, 'refs.ts');
    const outside = join(mkdtempSync(join(tmpdir(), 'desk-lsp-outside-')), 'secret.ts');
    writeFileSync(oldPath, 'old\n');
    writeFileSync(otherPath, 'abcdef\n');
    writeFileSync(outside, 'secret\n');
    const store = createStore();

    try {
      await expect(
        store.createPreview({
          workspaceRoot: root,
          from: oldPath,
          to: newPath,
          serverResults: [{ sessionId: 's', result: { documentChanges: [{ kind: 'rename', oldUri: 'a', newUri: 'b' }] } }]
        })
      ).resolves.toEqual({ ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'resource-ops-not-supported' });
      await expect(
        store.createPreview({
          workspaceRoot: root,
          from: oldPath,
          to: newPath,
          serverResults: [
            {
              sessionId: 's',
              result: {
                documentChanges: [
                  {
                    textDocument: { uri: pathToFileURL(otherPath).href, version: 1 },
                    edits: [{ range: range(0, 0, 0, 1), newText: 'x' }]
                  }
                ]
              }
            }
          ]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'unsupported-workspace-edit' });
      await expect(
        store.createPreview({
          workspaceRoot: root,
          from: oldPath,
          to: newPath,
          serverResults: [{ sessionId: 's', result: { changes: { [pathToFileURL(outside).href]: [{ range: range(0, 0, 0, 1), newText: 'x' }] } } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'out-of-root-edit' });
      await expect(
        store.createPreview({
          workspaceRoot: root,
          from: oldPath,
          to: newPath,
          serverResults: [
            {
              sessionId: 's',
              result: {
                changes: {
                  [pathToFileURL(otherPath).href]: [
                    { range: range(0, 0, 0, 3), newText: 'x' },
                    { range: range(0, 2, 0, 4), newText: 'y' }
                  ]
                }
              }
            }
          ]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'conflicting-edits' });
      await expect(
        store.createPreview({
          workspaceRoot: root,
          from: oldPath,
          to: newPath,
          serverResults: [
            {
              sessionId: 's',
              result: {
                changes: { [pathToFileURL(otherPath).href]: [{ range: range(0, 0, 0, 1), newText: 'x' }] },
                command: 'secret-command',
                arguments: ['secret-arg'],
                data: { secret: true }
              }
            }
          ]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'unsupported-workspace-edit' });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects expired, tampered, and stale previews before rename or edit mutation', async () => {
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const otherPath = join(root, 'refs.ts');
    writeFileSync(oldPath, 'old\n');
    writeFileSync(otherPath, 'old ref\n');
    const store = createStore({ ttlMs: 100 });
    const preview = await store.createPreview({
      workspaceRoot: root,
      from: oldPath,
      to: newPath,
      serverResults: [{ sessionId: 's', result: { changes: { [pathToFileURL(otherPath).href]: [{ range: range(0, 0, 0, 3), newText: 'new' }] } } }]
    });
    expect(preview.ok && preview.previewId).toBe('preview-1');

    await expect(store.apply({ workspaceRoot: join(root, 'missing'), previewId: 'preview-1' })).resolves.toEqual({
      ok: false,
      statusCode: 409,
      error: 'preview expired',
      reason: 'preview-expired'
    });
    writeFileSync(otherPath, 'changed\n');
    await expect(store.apply({ workspaceRoot: root, previewId: 'preview-1' })).resolves.toEqual({
      ok: false,
      statusCode: 409,
      error: 'lsp file operation apply failed',
      reason: 'stale-preview'
    });
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);

    const expired = await store.createPreview({
      workspaceRoot: root,
      from: oldPath,
      to: newPath,
      serverResults: [{ sessionId: 's', result: { changes: { [pathToFileURL(oldPath).href]: [{ range: range(0, 0, 0, 3), newText: 'new' }] } } }]
    });
    expect(expired.ok && expired.previewId).toBe('preview-2');
    now += 101;
    await expect(store.apply({ workspaceRoot: root, previewId: 'preview-2' })).resolves.toEqual({
      ok: false,
      statusCode: 409,
      error: 'preview expired',
      reason: 'preview-expired'
    });
  });

  it('scrubs exact token strings from preview response values and object keys without changing stored edits', async () => {
    const token = 'DESK_LSP_TOKEN_SHOULD_NOT_LEAK_123456';
    const oldPath = join(root, `old-${token}.ts`);
    const newPath = join(root, `new-${token}.ts`);
    writeFileSync(oldPath, 'old\n');
    const store = createStore({ secrets: [token] });

    const preview = await store.createPreview({
      workspaceRoot: root,
      from: oldPath,
      to: newPath,
      serverResults: [
        {
          sessionId: 's',
          result: { changes: { [pathToFileURL(oldPath).href]: [{ range: range(0, 0, 0, 3), newText: `new-${token}` }] } }
        }
      ]
    });

    expect(JSON.stringify(preview)).not.toContain(token);
    expect(JSON.stringify(preview)).toContain('[redacted]');
    const applied = await store.apply({ workspaceRoot: root, previewId: 'preview-1' });
    expect(applied.ok).toBe(true);
    expect(readFileSync(newPath, 'utf8')).toBe(`new-${token}\n`);
  });
});

describe('LSP file-operation workspace edit preview/apply store', () => {
  it('renames a folder and remaps descendant text edits to the new subtree', async () => {
    const oldDir = join(root, 'src');
    const newDir = join(root, 'lib');
    const oldFile = join(oldDir, 'main.ts');
    const newFile = join(newDir, 'main.ts');
    const refsPath = join(root, 'refs.ts');
    mkdirSync(oldDir);
    writeFileSync(oldFile, 'export const value = 1;\n');
    writeFileSync(refsPath, 'import { value } from "./src/main";\n');
    const notifyDidRename = vi.fn(async () => 1);
    const store = createFileOperationStore({ notifyDidRename });

    const preview = await store.createPreview({
      workspaceRoot: root,
      operation: { type: 'rename', from: oldDir, to: newDir, kind: 'folder' },
      serverResults: [
        {
          sessionId: 'typescript',
          result: {
            changes: {
              [pathToFileURL(oldFile).href]: [{ range: range(0, 13, 0, 18), newText: 'renamed' }],
              [pathToFileURL(refsPath).href]: [{ range: range(0, 25, 0, 28), newText: 'lib' }]
            }
          }
        }
      ]
    });

    expect(preview).toMatchObject({
      ok: true,
      status: 'ready',
      operation: { type: 'rename', from: oldDir, to: newDir, kind: 'folder' }
    });
    expect(preview.ok && preview.changes.map((change) => change.path).sort()).toEqual([newFile, refsPath].sort());

    const applied = await store.apply({ workspaceRoot: root, previewId: 'preview-1' });

    expect(applied).toEqual({
      ok: true,
      operation: { type: 'rename', from: oldDir, to: newDir, kind: 'folder' },
      path: newDir,
      changedFiles: [newDir, newFile, refsPath].sort()
    });
    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(newFile, 'utf8')).toBe('export const renamed = 1;\n');
    expect(readFileSync(refsPath, 'utf8')).toBe('import { value } from "./lib/main";\n');
    expect(notifyDidRename).toHaveBeenCalledTimes(1);
    expect(notifyDidRename).toHaveBeenCalledWith({ workspaceRoot: root, oldPath: oldDir, newPath: newDir, kind: 'folder' });
  });

  it('creates and deletes with text edits while keeping unflagged resource ops rejected', async () => {
    const createdPath = join(root, 'created.ts');
    const refsPath = join(root, 'refs.ts');
    writeFileSync(refsPath, 'import "./missing";\n');
    const notifyDidCreate = vi.fn(async () => 1);
    const store = createFileOperationStore({ notifyDidCreate });

    const preview = await store.createPreview({
      workspaceRoot: root,
      operation: { type: 'create', path: createdPath, kind: 'file' },
      serverResults: [
        {
          sessionId: 'typescript',
          result: {
            changes: {
              [pathToFileURL(createdPath).href]: [{ range: range(0, 0, 0, 0), newText: 'export const created = true;\n' }],
              [pathToFileURL(refsPath).href]: [{ range: range(0, 10, 0, 17), newText: 'created' }]
            }
          }
        }
      ]
    });

    expect(preview).toMatchObject({ ok: true, status: 'ready', operation: { type: 'create', path: createdPath, kind: 'file' } });
    const applied = await store.apply({ workspaceRoot: root, previewId: 'preview-1' });

    expect(applied).toMatchObject({ ok: true, path: createdPath });
    expect(readFileSync(createdPath, 'utf8')).toBe('export const created = true;\n');
    expect(readFileSync(refsPath, 'utf8')).toBe('import "./created";\n');
    expect(notifyDidCreate).toHaveBeenCalledTimes(1);

    const deleteStore = createFileOperationStore();
    await expect(
      deleteStore.createPreview({
        workspaceRoot: root,
        operation: { type: 'delete', path: createdPath, kind: 'file' },
        serverResults: [{ sessionId: 'typescript', result: { documentChanges: [{ kind: 'delete', uri: pathToFileURL(createdPath).href }] } }]
      })
    ).resolves.toMatchObject({ ok: false, reason: 'resource-ops-not-supported' });
  });

  it('opts into file resource ops, treats resource-only previews as ready, and applies by preview id only', async () => {
    const userCreatedPath = join(root, 'user.ts');
    const serverCreatedPath = join(root, 'server-created.ts');
    const renamedFrom = join(root, 'server-old.ts');
    const renamedTo = join(root, 'server-new.ts');
    const deletedPath = join(root, 'server-delete.ts');
    const notifyDidCreate = vi.fn(async () => 1);
    writeFileSync(renamedFrom, 'rename me\n');
    writeFileSync(deletedPath, 'delete me\n');
    const store = createFileOperationStore({ notifyDidCreate });

    const preview = await store.createPreview({
      workspaceRoot: root,
      operation: { type: 'create', path: userCreatedPath, kind: 'file' },
      supportsResourceOps: true,
      serverResults: [
        {
          sessionId: 'typescript',
          result: {
            documentChanges: [
              { kind: 'create', uri: pathToFileURL(serverCreatedPath).href },
              {
                textDocument: { uri: pathToFileURL(serverCreatedPath).href, version: null },
                edits: [{ range: range(0, 0, 0, 0), newText: 'created by server\n' }]
              },
              { kind: 'rename', oldUri: pathToFileURL(renamedFrom).href, newUri: pathToFileURL(renamedTo).href },
              { kind: 'delete', uri: pathToFileURL(deletedPath).href }
            ]
          }
        }
      ]
    });

    expect(preview).toMatchObject({
      ok: true,
      status: 'ready',
      previewId: 'preview-1',
      resourceOps: [
        { type: 'create', path: serverCreatedPath, kind: 'file' },
        { type: 'rename', from: renamedFrom, to: renamedTo, kind: 'file' },
        { type: 'delete', path: deletedPath, kind: 'file' }
      ]
    });
    expect(preview.ok && preview.changes).toEqual([{ uri: pathToFileURL(serverCreatedPath).href, path: serverCreatedPath, edits: [{ range: range(0, 0, 0, 0), newText: 'created by server\n' }] }]);

    const applied = await store.apply({ workspaceRoot: root, previewId: 'preview-1' });

    expect(applied).toEqual({
      ok: true,
      operation: { type: 'create', path: userCreatedPath, kind: 'file' },
      path: userCreatedPath,
      changedFiles: [deletedPath, renamedTo, serverCreatedPath, userCreatedPath].sort(),
      resourceOps: [
        { type: 'create', path: serverCreatedPath, kind: 'file' },
        { type: 'rename', from: renamedFrom, to: renamedTo, kind: 'file' },
        { type: 'delete', path: deletedPath, kind: 'file' }
      ]
    });
    expect(readFileSync(serverCreatedPath, 'utf8')).toBe('created by server\n');
    expect(existsSync(renamedFrom)).toBe(false);
    expect(readFileSync(renamedTo, 'utf8')).toBe('rename me\n');
    expect(existsSync(deletedPath)).toBe(false);
    expect(notifyDidCreate).toHaveBeenCalledTimes(1);
    expect(notifyDidCreate).toHaveBeenCalledWith({ workspaceRoot: root, path: userCreatedPath, kind: 'file' });
  });

  it('rejects unsafe resource-op options, folder targets, out-of-root paths, and symlinks', async () => {
    const userCreatedPath = join(root, 'user.ts');
    const existingPath = join(root, 'exists.ts');
    const folderPath = join(root, 'folder');
    const outside = mkdtempSync(join(tmpdir(), 'desk-lsp-resource-outside-'));
    writeFileSync(existingPath, 'exists\n');
    mkdirSync(folderPath);
    symlinkSync(existingPath, join(root, 'linked.ts'));
    const store = createFileOperationStore();

    try {
      const base = { workspaceRoot: root, operation: { type: 'create' as const, path: userCreatedPath, kind: 'file' as const }, supportsResourceOps: true };
      await expect(
        store.createPreview({
          ...base,
          serverResults: [{ sessionId: 'typescript', result: { documentChanges: [{ kind: 'create', uri: pathToFileURL(join(root, 'overwrite.ts')).href, options: { overwrite: true } }] } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'path-collision' });
      await expect(
        store.createPreview({
          ...base,
          serverResults: [{ sessionId: 'typescript', result: { documentChanges: [{ kind: 'create', uri: pathToFileURL(join(root, 'ignored.ts')).href, options: { ignoreIfExists: true } }] } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'unsupported-workspace-edit' });
      await expect(
        store.createPreview({
          ...base,
          serverResults: [{ sessionId: 'typescript', result: { documentChanges: [{ kind: 'delete', uri: pathToFileURL(folderPath).href, options: { recursive: true } }] } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'unsupported-workspace-edit' });
      await expect(
        store.createPreview({
          ...base,
          serverResults: [{ sessionId: 'typescript', result: { documentChanges: [{ kind: 'delete', uri: pathToFileURL(join(root, 'linked.ts')).href }] } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'out-of-root-edit' });
      await expect(
        store.createPreview({
          ...base,
          serverResults: [{ sessionId: 'typescript', result: { documentChanges: [{ kind: 'create', uri: pathToFileURL(join(outside, 'escape.ts')).href }] } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'out-of-root-edit' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rolls back user and resource creates when a later resource op fails without exposing tombstones', async () => {
    const userCreatedPath = join(root, 'user.ts');
    const serverCreatedPath = join(root, 'server-created.ts');
    const lockedDir = join(root, 'locked');
    const blockedPath = join(lockedDir, 'blocked.ts');
    mkdirSync(lockedDir);
    const store = createFileOperationStore();
    const preview = await store.createPreview({
      workspaceRoot: root,
      operation: { type: 'create', path: userCreatedPath, kind: 'file' },
      supportsResourceOps: true,
      serverResults: [
        {
          sessionId: 'typescript',
          result: {
            documentChanges: [
              { kind: 'create', uri: pathToFileURL(serverCreatedPath).href },
              { kind: 'create', uri: pathToFileURL(blockedPath).href }
            ]
          }
        }
      ]
    });
    expect(preview).toMatchObject({ ok: true, status: 'ready' });

    chmodSync(lockedDir, 0o555);
    try {
      const applied = await store.apply({ workspaceRoot: root, previewId: preview.ok && preview.status === 'ready' ? preview.previewId : '' });
      const responseText = JSON.stringify(applied);

      expect(applied).toEqual({ ok: false, statusCode: 409, error: 'lsp file operation apply failed', reason: 'invalid-operation' });
      expect(existsSync(userCreatedPath)).toBe(false);
      expect(existsSync(serverCreatedPath)).toBe(false);
      expect(existsSync(blockedPath)).toBe(false);
      expect(responseText).not.toContain('.desk-lsp-delete-');
      expect(responseText).not.toContain(root);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it('rejects folder URI targets and remapped symlink escapes before mutation', async () => {
    const oldDir = join(root, 'src');
    const newDir = join(root, 'lib');
    const outside = mkdtempSync(join(tmpdir(), 'desk-lsp-remap-outside-'));
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'main.ts'), 'old\n');
    const store = createFileOperationStore();

    try {
      await expect(
        store.createPreview({
          workspaceRoot: root,
          operation: { type: 'rename', from: oldDir, to: newDir, kind: 'folder' },
          serverResults: [{ sessionId: 'typescript', result: { changes: { [pathToFileURL(oldDir).href]: [{ range: range(0, 0, 0, 0), newText: 'x' }] } } }]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'out-of-root-edit' });
      symlinkSync(outside, join(oldDir, 'linked'), 'dir');
      await expect(
        store.createPreview({
          workspaceRoot: root,
          operation: { type: 'rename', from: oldDir, to: newDir, kind: 'folder' },
          serverResults: [
            {
              sessionId: 'typescript',
              result: {
                changes: { [pathToFileURL(join(oldDir, 'linked', 'escape.ts')).href]: [{ range: range(0, 0, 0, 0), newText: 'x' }] }
              }
            }
          ]
        })
      ).resolves.toMatchObject({ ok: false, reason: 'stale-preview' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps tombstone names and absolute paths out of rollback-failure responses', async () => {
    const deletedPath = join(root, 'deleted.ts');
    const refsPath = join(root, 'refs.ts');
    writeFileSync(deletedPath, 'delete me\n');
    writeFileSync(refsPath, 'old ref\n');
    const store = createFileOperationStore();

    const preview = await store.createPreview({
      workspaceRoot: root,
      operation: { type: 'delete', path: deletedPath, kind: 'file' },
      serverResults: [
        {
          sessionId: 'typescript',
          result: { changes: { [pathToFileURL(refsPath).href]: [{ range: range(0, 0, 0, 3), newText: 'new' }] } }
        }
      ]
    });
    expect(preview).toMatchObject({ ok: true, status: 'ready' });

    chmodSync(refsPath, 0o444);
    try {
      const applied = await store.apply({ workspaceRoot: root, previewId: preview.ok && preview.status === 'ready' ? preview.previewId : '' });
      const responseText = JSON.stringify(applied);

      expect(applied).toEqual({
        ok: false,
        statusCode: 409,
        error: 'lsp file operation rollback failed',
        reason: 'rollback-failed',
        rollbackFailed: true,
        affectedPaths: ['deleted.ts', 'refs.ts']
      });
      expect(responseText).not.toContain(root);
      expect(responseText).not.toContain('.desk-lsp-delete-');
    } finally {
      if (existsSync(refsPath)) {
        chmodSync(refsPath, 0o644);
      }
    }
  });
});

function createStore(options: {
  ttlMs?: number;
  secrets?: readonly string[];
  notifyDidRename?: (input: { workspaceRoot: string; oldPath: string; newPath: string; kind: 'file' }) => Promise<number>;
} = {}) {
  return createLspRenamePreviewStore({
    ttlMs: options.ttlMs,
    secrets: options.secrets,
    now: () => now,
    createPreviewId: (() => {
      let next = 1;
      return () => `preview-${next++}`;
    })(),
    notifyDidRename: options.notifyDidRename ?? (async () => 0)
  });
}

function createFileOperationStore(options: {
  ttlMs?: number;
  secrets?: readonly string[];
  notifyDidRename?: (input: { workspaceRoot: string; oldPath: string; newPath: string; kind: 'file' | 'folder' }) => Promise<number>;
  notifyDidCreate?: (input: { workspaceRoot: string; path: string; kind: 'file' | 'folder' }) => Promise<number>;
  notifyDidDelete?: (input: { workspaceRoot: string; path: string; kind: 'file' | 'folder' }) => Promise<number>;
} = {}) {
  return createLspFileOperationPreviewStore({
    ttlMs: options.ttlMs,
    secrets: options.secrets,
    now: () => now,
    createPreviewId: (() => {
      let next = 1;
      return () => `preview-${next++}`;
    })(),
    notifyDidRename: options.notifyDidRename ?? (async () => 0),
    notifyDidCreate: options.notifyDidCreate ?? (async () => 0),
    notifyDidDelete: options.notifyDidDelete ?? (async () => 0)
  });
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}
