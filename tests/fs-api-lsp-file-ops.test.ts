import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFsRequest } from '../src/server/fsApi';
import { MAX_EDITABLE_BYTES } from '../src/server/fsOps';
import { createLspFileOperationCoordinator, type LspFileOperationCoordinator } from '../src/server/lsp/lspFileOperationCoordinator';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-fs-api-lsp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('handleFsRequest LSP file-operation hooks', () => {
  it('notifies create only after a successful mutation and preserves the response body', async () => {
    const coordinator = fakeCoordinator();
    const path = join(root, 'sample.ts');
    const response = await invokeFs('/api/fs/create', { root, path, kind: 'file' }, coordinator);

    expect(response).toEqual({ statusCode: 200, payload: { ok: true, path } });
    expect(existsSync(path)).toBe(true);
    expect(coordinator.didCreate).toHaveBeenCalledWith({ workspaceRoot: root, path, kind: 'file' });
  });

  it('allows saving editable-size content whose JSON envelope exceeds the default body cap', async () => {
    const coordinator = fakeCoordinator();
    const path = join(root, 'large.txt');
    const content = '"'.repeat(Math.floor(MAX_EDITABLE_BYTES / 2) + 1);

    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_EDITABLE_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ root, path, content }), 'utf8')).toBeGreaterThan(1_048_576);

    const response = await invokeFs('/api/fs/write', { root, path, content }, coordinator);

    expect(response.statusCode).toBe(200);
    expect(response.payload.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('captures rename and delete kind before mutation removes the original path', async () => {
    const coordinator = fakeCoordinator();
    const dir = join(root, 'folder');
    const renamed = join(root, 'renamed');
    mkdirSync(dir);

    await invokeFs('/api/fs/rename', { root, from: dir, to: renamed }, coordinator);
    expect(coordinator.didRename).toHaveBeenCalledWith({
      workspaceRoot: root,
      oldPath: dir,
      newPath: renamed,
      kind: 'folder'
    });

    await invokeFs('/api/fs/delete', { root, path: renamed }, coordinator);
    expect(coordinator.didDelete).toHaveBeenCalledWith({ workspaceRoot: root, path: renamed, kind: 'folder' });
    expect(existsSync(renamed)).toBe(false);
  });

  it('does not notify failed mutations or delete-root refusal', async () => {
    const coordinator = fakeCoordinator();
    const path = join(root, 'exists.ts');
    writeFileSync(path, '');

    await expect(invokeFs('/api/fs/create', { root, path, kind: 'file' }, coordinator)).rejects.toThrow(/exists/);
    await expect(invokeFs('/api/fs/delete', { root, path: root }, coordinator)).rejects.toThrow(/refusing/);
    expect(coordinator.didCreate).not.toHaveBeenCalled();
    expect(coordinator.didDelete).not.toHaveBeenCalled();
  });

  it('swallows coordinator failures after successful mutation and preserves response status and body', async () => {
    const coordinator = fakeCoordinator();
    vi.mocked(coordinator.didCreate).mockRejectedValueOnce(new Error('secret command /tmp/server'));
    const path = join(root, 'sample.ts');

    const response = await invokeFs('/api/fs/create', { root, path, kind: 'file' }, coordinator);

    expect(response).toEqual({ statusCode: 200, payload: { ok: true, path } });
    expect(statSync(path).isFile()).toBe(true);
  });

  it('previews file rename without mutation and returns fallback statuses without hidden mutation', async () => {
    const coordinator = fakeCoordinator();
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    writeFileSync(oldPath, 'old\n');
    vi.mocked(coordinator.previewRename).mockResolvedValueOnce({
      ok: true,
      status: 'no-running-session',
      operation: { from: oldPath, to: newPath, kind: 'file' },
      changes: []
    });

    const response = await invokeFs('/api/fs/rename-preview', { root, from: oldPath, to: newPath }, coordinator);

    expect(response).toEqual({
      statusCode: 200,
      payload: { ok: true, status: 'no-running-session', operation: { from: oldPath, to: newPath, kind: 'file' }, changes: [] }
    });
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    expect(readFileSync(oldPath, 'utf8')).toBe('old\n');
  });

  it('previews folder rename without mutation', async () => {
    const coordinator = fakeCoordinator();
    const oldPath = join(root, 'folder');
    const newPath = join(root, 'renamed');
    mkdirSync(oldPath);
    vi.mocked(coordinator.previewRename).mockResolvedValueOnce({
      ok: true,
      status: 'no-capability',
      operation: { type: 'rename', from: oldPath, to: newPath, kind: 'folder' },
      changes: []
    });

    const response = await invokeFs('/api/fs/rename-preview', { root, from: oldPath, to: newPath }, coordinator);

    expect(response).toEqual({
      statusCode: 200,
      payload: { ok: true, status: 'no-capability', operation: { type: 'rename', from: oldPath, to: newPath, kind: 'folder' }, changes: [] }
    });
    expect(existsSync(oldPath)).toBe(true);
    expect(coordinator.previewRename).toHaveBeenCalledWith({ workspaceRoot: root, from: oldPath, to: newPath, kind: 'folder' });
  });

  it('previews and applies create/delete through previewId-only endpoints without changing direct routes', async () => {
    const coordinator = fakeCoordinator();
    const createPath = join(root, 'created.ts');
    const deletePath = join(root, 'deleted.ts');
    writeFileSync(deletePath, 'delete\n');
    vi.mocked(coordinator.previewCreate).mockResolvedValueOnce({
      ok: true,
      status: 'ready',
      previewId: 'create-preview',
      operation: { type: 'create', path: createPath, kind: 'file' },
      changes: []
    });
    vi.mocked(coordinator.applyCreate).mockResolvedValueOnce({
      ok: true,
      operation: { type: 'create', path: createPath, kind: 'file' },
      path: createPath,
      changedFiles: [createPath]
    });
    vi.mocked(coordinator.previewDelete).mockResolvedValueOnce({
      ok: true,
      status: 'ready',
      previewId: 'delete-preview',
      operation: { type: 'delete', path: deletePath, kind: 'file' },
      changes: []
    });
    vi.mocked(coordinator.applyDelete).mockResolvedValueOnce({
      ok: true,
      operation: { type: 'delete', path: deletePath, kind: 'file' },
      path: deletePath,
      changedFiles: [deletePath]
    });

    const createPreview = await invokeFs('/api/fs/create-preview', { root, path: createPath, kind: 'file' }, coordinator);
    const createApply = await invokeFs('/api/fs/create-apply', { root, previewId: 'create-preview', edits: [{ secret: true }] }, coordinator);
    const deletePreview = await invokeFs('/api/fs/delete-preview', { root, path: deletePath }, coordinator);
    const deleteApply = await invokeFs('/api/fs/delete-apply', { root, previewId: 'delete-preview', path: deletePath }, coordinator);

    expect(createPreview.payload).toMatchObject({ ok: true, status: 'ready', previewId: 'create-preview' });
    expect(createApply.payload).toMatchObject({ ok: true, path: createPath });
    expect(deletePreview.payload).toMatchObject({ ok: true, status: 'ready', previewId: 'delete-preview' });
    expect(deleteApply.payload).toMatchObject({ ok: true, path: deletePath });
    expect(coordinator.applyCreate).toHaveBeenCalledWith({ workspaceRoot: root, previewId: 'create-preview' });
    expect(coordinator.applyDelete).toHaveBeenCalledWith({ workspaceRoot: root, previewId: 'delete-preview' });
  });

  it('passes supportsResourceOps only on preview requests and keeps apply previewId-only', async () => {
    const coordinator = fakeCoordinator();
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const createPath = join(root, 'created.ts');
    const deletePath = join(root, 'deleted.ts');
    writeFileSync(oldPath, 'old\n');
    writeFileSync(deletePath, 'delete\n');

    await invokeFs('/api/fs/rename-preview', { root, from: oldPath, to: newPath, supportsResourceOps: true }, coordinator);
    await invokeFs('/api/fs/create-preview', { root, path: createPath, kind: 'file', supportsResourceOps: true }, coordinator);
    await invokeFs('/api/fs/delete-preview', { root, path: deletePath, supportsResourceOps: true }, coordinator);
    await invokeFs('/api/fs/rename-apply', { root, previewId: 'preview-1', supportsResourceOps: true }, coordinator);

    expect(coordinator.previewRename).toHaveBeenCalledWith({ workspaceRoot: root, from: oldPath, to: newPath, kind: 'file', supportsResourceOps: true });
    expect(coordinator.previewCreate).toHaveBeenCalledWith({ workspaceRoot: root, path: createPath, kind: 'file', supportsResourceOps: true });
    expect(coordinator.previewDelete).toHaveBeenCalledWith({ workspaceRoot: root, path: deletePath, kind: 'file', supportsResourceOps: true });
    expect(coordinator.applyRename).toHaveBeenCalledWith({ workspaceRoot: root, previewId: 'preview-1' });
  });

  it('applies a server-owned preview id only and emits no direct client edits', async () => {
    const coordinator = fakeCoordinator();
    const responseBody = { ok: true, path: join(root, 'new.ts'), changedFiles: [join(root, 'new.ts')] };
    vi.mocked(coordinator.applyRename).mockResolvedValueOnce(responseBody);

    const response = await invokeFs(
      '/api/fs/rename-apply',
      { root, previewId: 'preview-1', from: join(root, 'old.ts'), edits: [{ secret: true }] },
      coordinator
    );

    expect(response).toEqual({ statusCode: 200, payload: responseBody });
    expect(coordinator.applyRename).toHaveBeenCalledWith({ workspaceRoot: root, previewId: 'preview-1' });
  });

  it('returns static apply conflicts for replayed, expired, tampered, or stale previews', async () => {
    const coordinator = fakeCoordinator();
    vi.mocked(coordinator.applyRename).mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      error: 'lsp file operation apply failed',
      reason: 'stale-preview'
    });

    const response = await invokeFs('/api/fs/rename-apply', { root, previewId: 'preview-1' }, coordinator);

    expect(response).toEqual({ statusCode: 409, payload: { ok: false, error: 'lsp file operation apply failed', reason: 'stale-preview' } });
  });

  it('returns consistent preview-expired envelopes for missing apply preview ids', async () => {
    const coordinator = fakeCoordinator();

    await expect(invokeFs('/api/fs/rename-apply', { root }, coordinator)).resolves.toEqual({
      statusCode: 409,
      payload: { ok: false, error: 'preview expired', reason: 'preview-expired' }
    });
    await expect(invokeFs('/api/fs/create-apply', { root }, coordinator)).resolves.toEqual({
      statusCode: 409,
      payload: { ok: false, error: 'preview expired', reason: 'preview-expired' }
    });
    await expect(invokeFs('/api/fs/delete-apply', { root }, coordinator)).resolves.toEqual({
      statusCode: 409,
      payload: { ok: false, error: 'preview expired', reason: 'preview-expired' }
    });
  });

  it('scrubs active capability tokens from endpoint preview/apply responses while applying stored text edits', async () => {
    const token = 'DESK_LSP_TOKEN_SHOULD_NOT_LEAK_ENDPOINT_123456';
    const oldPath = join(root, `old-${token}.ts`);
    const newPath = join(root, `new-${token}.ts`);
    writeFileSync(oldPath, 'old\n');
    const manager = fakePreviewManager({
      token,
      editUri: pathToFileURL(oldPath).href,
      newText: `new-${token}`
    });
    const activeSecrets = new Set<string>();
    const coordinator = createLspFileOperationCoordinator({
      manager,
      responseSecrets: () => [...activeSecrets]
    });
    activeSecrets.add(token);

    const preview = await invokeFs('/api/fs/rename-preview', { root, from: oldPath, to: newPath }, coordinator);

    expect(preview.statusCode).toBe(200);
    expect(preview.payload.ok).toBe(true);
    expect(preview.payload.status).toBe('ready');
    expect(JSON.stringify(preview.payload)).not.toContain(token);
    expect(JSON.stringify(preview.payload)).toContain('[redacted]');

    const apply = await invokeFs('/api/fs/rename-apply', { root, previewId: preview.payload.previewId }, coordinator);

    expect(apply.statusCode).toBe(200);
    expect(JSON.stringify(apply.payload)).not.toContain(token);
    expect(readFileSync(newPath, 'utf8')).toBe(`new-${token}\n`);
  });

  it('fails unflagged resource-op previews closed and applies flagged resource-op-only previews', async () => {
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const serverCreatedPath = join(root, 'server-created.ts');
    writeFileSync(oldPath, 'old\n');
    const coordinator = createLspFileOperationCoordinator({
      manager: fakeResourceOpManager({ resourceUri: pathToFileURL(serverCreatedPath).href })
    });

    const unflagged = await invokeFs('/api/fs/rename-preview', { root, from: oldPath, to: newPath }, coordinator);

    expect(unflagged).toEqual({
      statusCode: 409,
      payload: { ok: false, error: 'lsp file operation preview failed', reason: 'resource-ops-not-supported' }
    });
    expect(JSON.stringify(unflagged.payload)).not.toContain('previewId');
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(serverCreatedPath)).toBe(false);

    const flagged = await invokeFs('/api/fs/rename-preview', { root, from: oldPath, to: newPath, supportsResourceOps: true }, coordinator);

    expect(flagged).toEqual({
      statusCode: 200,
      payload: {
        ok: true,
        status: 'ready',
        previewId: flagged.payload.previewId,
        operation: { type: 'rename', from: oldPath, to: newPath, kind: 'file' },
        changes: [],
        resourceOps: [{ type: 'create', path: serverCreatedPath, kind: 'file' }]
      }
    });

    const applied = await invokeFs('/api/fs/rename-apply', { root, previewId: flagged.payload.previewId, resourceOps: [{ secret: true }] }, coordinator);

    expect(applied).toEqual({
      statusCode: 200,
      payload: {
        ok: true,
        operation: { type: 'rename', from: oldPath, to: newPath, kind: 'file' },
        path: newPath,
        changedFiles: [newPath, serverCreatedPath].sort(),
        resourceOps: [{ type: 'create', path: serverCreatedPath, kind: 'file' }]
      }
    });
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(newPath, 'utf8')).toBe('old\n');
    expect(readFileSync(serverCreatedPath, 'utf8')).toBe('');
  });
});

async function invokeFs(pathname: string, body: Record<string, unknown>, coordinator: LspFileOperationCoordinator) {
  const req = new JsonRequest(body) as IncomingMessage;
  req.method = 'POST';
  const res = new JsonResponse() as unknown as ServerResponse & JsonResponse;
  const handled = await handleFsRequest(req, res, new URL(pathname, 'http://desk.local'), {
    fileOperationCoordinator: coordinator
  });
  expect(handled).toBe(true);
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

function fakeCoordinator(): LspFileOperationCoordinator {
  return {
    didCreate: vi.fn(async () => 0),
    didRename: vi.fn(async () => 0),
    didDelete: vi.fn(async () => 0),
    previewRename: vi.fn(async ({ workspaceRoot, from, to }) => ({
      ok: true,
      status: 'no-capability',
      operation: { type: 'rename', from, to, kind: 'file' },
      changes: []
    })),
    applyRename: vi.fn(async () => ({ ok: false, statusCode: 409, error: 'preview expired', reason: 'preview-expired' })),
    previewCreate: vi.fn(async ({ path, kind }) => ({
      ok: true,
      status: 'no-capability',
      operation: { type: 'create', path, kind },
      changes: []
    })),
    applyCreate: vi.fn(async () => ({ ok: false, statusCode: 409, error: 'preview expired', reason: 'preview-expired' })),
    previewDelete: vi.fn(async ({ path, kind }) => ({
      ok: true,
      status: 'no-capability',
      operation: { type: 'delete', path, kind },
      changes: []
    })),
    applyDelete: vi.fn(async () => ({ ok: false, statusCode: 409, error: 'preview expired', reason: 'preview-expired' }))
  };
}

function fakePreviewManager(input: { token: string; editUri: string; newText: string }) {
  const capabilities = {
    workspace: {
      fileOperations: {
        willRename: { filters: [{ scheme: 'file', pattern: { glob: '*.ts', matches: 'file' } }] },
        didRename: { filters: [{ scheme: 'file', pattern: { glob: '*.ts', matches: 'file' } }] }
      }
    }
  };
  return {
    hasRunningSessionForWorkspaceFileOperation: vi.fn(async () => true),
    requestRunningSessionsForWorkspaceFileOperation: vi.fn(async (request: {
      matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
    }) => {
      if (!request.matchesCapabilities(capabilities)) {
        return [];
      }
      return [
        {
          sessionId: 'typescript',
          result: {
            changes: {
              [input.editUri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: input.newText }]
            }
          }
        }
      ];
    }),
    notifyRunningSessionsForWorkspaceFileOperation: vi.fn(async () => 1)
  };
}

function fakeResourceOpManager(input: { resourceUri: string }) {
  const capabilities = {
    workspace: {
      fileOperations: {
        willRename: { filters: [{ scheme: 'file', pattern: { glob: '*.ts', matches: 'file' } }] },
        didRename: { filters: [{ scheme: 'file', pattern: { glob: '*.ts', matches: 'file' } }] }
      }
    }
  };
  return {
    hasRunningSessionForWorkspaceFileOperation: vi.fn(async () => true),
    requestRunningSessionsForWorkspaceFileOperation: vi.fn(async (request: {
      matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
    }) => {
      if (!request.matchesCapabilities(capabilities)) {
        return [];
      }
      return [
        {
          sessionId: 'typescript',
          result: { documentChanges: [{ kind: 'create', uri: input.resourceUri }] }
        }
      ];
    }),
    notifyRunningSessionsForWorkspaceFileOperation: vi.fn(async () => 1)
  };
}

class JsonRequest extends EventEmitter {
  method = 'POST';
  headers: Record<string, string>;
  private readonly payload: string;

  constructor(body: Record<string, unknown>) {
    super();
    this.payload = JSON.stringify(body);
    this.headers = { 'content-length': String(Buffer.byteLength(this.payload, 'utf8')) };
  }

  setEncoding(): void {
    setTimeout(() => {
      this.emit('data', this.payload);
      this.emit('end');
    }, 0);
  }

  resume(): void {}

  destroy(): this {
    return this;
  }
}

class JsonResponse {
  statusCode = 200;
  body = '';
  headers = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  end(body: string): void {
    this.body = body;
  }
}
