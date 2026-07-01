import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enumerateSubtree,
  fileOpDirtyBlock,
  fsCreateApply,
  fsCreatePreview,
  fsDeleteApply,
  fsDeletePreview,
  fsRenameApply,
  fsRenamePreview,
  isPathUnder,
  remapSubtreePath,
  resourceOpPaths,
  type LspFileResourceOperation
} from '../src/web/editor/fsClient';

describe('file-op reconciliation helpers (pure)', () => {
  it('isPathUnder matches the dir itself and descendants, not siblings or prefixes', () => {
    expect(isPathUnder('/ws/src', '/ws/src')).toBe(true);
    expect(isPathUnder('/ws/src/a.ts', '/ws/src')).toBe(true);
    expect(isPathUnder('/ws/src/nested/b.ts', '/ws/src')).toBe(true);
    expect(isPathUnder('/ws/srclib/a.ts', '/ws/src')).toBe(false); // prefix-but-not-subtree
    expect(isPathUnder('/ws/other/a.ts', '/ws/src')).toBe(false);
  });

  it('remapSubtreePath rewrites operation.from -> operation.to for the subtree, null otherwise', () => {
    expect(remapSubtreePath('/ws/old/a.ts', '/ws/old', '/ws/new')).toBe('/ws/new/a.ts');
    expect(remapSubtreePath('/ws/old/deep/b.ts', '/ws/old', '/ws/new')).toBe('/ws/new/deep/b.ts');
    expect(remapSubtreePath('/ws/old', '/ws/old', '/ws/moved/old')).toBe('/ws/moved/old');
    expect(remapSubtreePath('/ws/keep/c.ts', '/ws/old', '/ws/new')).toBeNull();
  });

  it('enumerateSubtree returns only the open paths under the dir', () => {
    const open = ['/ws/old/a.ts', '/ws/old/sub/b.ts', '/ws/keep/c.ts', '/ws/old'];
    expect(enumerateSubtree(open, '/ws/old').sort()).toEqual(['/ws/old', '/ws/old/a.ts', '/ws/old/sub/b.ts'].sort());
  });

  it('fileOpDirtyBlock blocks dirty files in the source subtree and in the touched set, deduped', () => {
    const blocked = fileOpDirtyBlock({
      dirtyPaths: ['/ws/old/a.ts', '/ws/importer.ts', '/ws/clean-unrelated-but-dirty.ts'],
      sourceDir: '/ws/old',
      touchedPaths: ['/ws/importer.ts']
    });
    expect(blocked.sort()).toEqual(['/ws/importer.ts', '/ws/old/a.ts'].sort());
  });

  it('fileOpDirtyBlock with no sourceDir (create) blocks only touched existing files', () => {
    const blocked = fileOpDirtyBlock({
      dirtyPaths: ['/ws/importer.ts', '/ws/elsewhere.ts'],
      touchedPaths: ['/ws/importer.ts']
    });
    expect(blocked).toEqual(['/ws/importer.ts']);
  });

  it('resourceOpPaths returns create target, rename old+new, and delete target', () => {
    const ops: LspFileResourceOperation[] = [
      { type: 'create', path: '/ws/new.ts', kind: 'file' },
      { type: 'rename', from: '/ws/a.ts', to: '/ws/b.ts', kind: 'file' },
      { type: 'delete', path: '/ws/gone.ts', kind: 'file' }
    ];
    expect(resourceOpPaths(ops).sort()).toEqual(['/ws/a.ts', '/ws/b.ts', '/ws/gone.ts', '/ws/new.ts'].sort());
  });

  it('fileOpDirtyBlock blocks a dirty buffer on a resource-op path outside the source subtree', () => {
    const ops: LspFileResourceOperation[] = [
      { type: 'delete', path: '/ws/server-deletes.ts', kind: 'file' },
      { type: 'rename', from: '/ws/server-renames.ts', to: '/ws/renamed.ts', kind: 'file' }
    ];
    const blocked = fileOpDirtyBlock({
      dirtyPaths: ['/ws/server-deletes.ts', '/ws/server-renames.ts', '/ws/unrelated.ts'],
      sourceDir: '/ws/src',
      touchedPaths: [],
      resourceOpPaths: resourceOpPaths(ops)
    });
    expect(blocked.sort()).toEqual(['/ws/server-deletes.ts', '/ws/server-renames.ts'].sort());
  });
});

describe('file-op client (endpoints + previewId-only apply)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (payload: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => payload } as Response;
      })
    );
    return calls;
  };

  it('create-preview hits /api/fs/create-preview with {root,path,kind,supportsResourceOps:true}', async () => {
    const calls = stub({ ok: true, status: 'ready', previewId: 'p1', operation: { type: 'create', path: '/ws/x.ts', kind: 'file' }, changes: [], resourceOps: [] });
    const result = await fsCreatePreview('/ws', '/ws/x.ts', 'file');
    expect(calls[0].url).toBe('/api/fs/create-preview');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ root: '/ws', path: '/ws/x.ts', kind: 'file', supportsResourceOps: true });
    expect(result.ok).toBe(true);
  });

  it('delete-preview hits /api/fs/delete-preview with {root,path,supportsResourceOps:true}', async () => {
    const calls = stub({ ok: true, status: 'ready', previewId: 'p2', operation: { type: 'delete', path: '/ws/x.ts', kind: 'file' }, changes: [], resourceOps: [] });
    await fsDeletePreview('/ws', '/ws/x.ts');
    expect(calls[0].url).toBe('/api/fs/delete-preview');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ root: '/ws', path: '/ws/x.ts', supportsResourceOps: true });
  });

  it('rename-preview sends supportsResourceOps:true (4c-b opt-in)', async () => {
    const calls = stub({ ok: true, status: 'ready', previewId: 'p3', operation: { type: 'rename', from: '/ws/a.ts', to: '/ws/b.ts', kind: 'file' }, changes: [], resourceOps: [] });
    await fsRenamePreview('/ws', '/ws/a.ts', '/ws/b.ts');
    expect(calls[0].url).toBe('/api/fs/rename-preview');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ root: '/ws', from: '/ws/a.ts', to: '/ws/b.ts', supportsResourceOps: true });
  });

  it('defaults absent resourceOps to [] on preview and apply (older/text-only previews)', async () => {
    stub({ ok: true, status: 'ready', previewId: 'p4', operation: { type: 'rename', from: '/ws/a.ts', to: '/ws/b.ts', kind: 'file' }, changes: [{ uri: 'file:///ws/a.ts', path: '/ws/a.ts', edits: [] }] });
    const preview = await fsRenamePreview('/ws', '/ws/a.ts', '/ws/b.ts');
    expect(preview.ok && preview.status === 'ready' && preview.resourceOps).toEqual([]);
    vi.unstubAllGlobals();
    stub({ ok: true, operation: { type: 'rename', from: '/ws/a.ts', to: '/ws/b.ts', kind: 'file' }, path: '/ws/b.ts', changedFiles: [] });
    const applied = await fsRenameApply('/ws', 'p4');
    expect(applied.ok && applied.resourceOps).toEqual([]);
  });

  it('surfaces resourceOps allowlist from a flagged preview (changes may be empty)', async () => {
    const resourceOps: LspFileResourceOperation[] = [
      { type: 'create', path: '/ws/new.ts', kind: 'file' },
      { type: 'rename', from: '/ws/a.ts', to: '/ws/b.ts', kind: 'file' },
      { type: 'delete', path: '/ws/gone.ts', kind: 'file' }
    ];
    stub({ ok: true, status: 'ready', previewId: 'p5', operation: { type: 'rename', from: '/ws/src', to: '/ws/lib', kind: 'folder' }, changes: [], resourceOps });
    const preview = await fsRenamePreview('/ws', '/ws/src', '/ws/lib');
    expect(preview.ok && preview.status === 'ready' && preview.resourceOps).toEqual(resourceOps);
  });

  it('apply endpoints send {root,previewId} ONLY (never client edits)', async () => {
    for (const [fn, url] of [
      [fsRenameApply, '/api/fs/rename-apply'],
      [fsCreateApply, '/api/fs/create-apply'],
      [fsDeleteApply, '/api/fs/delete-apply']
    ] as const) {
      const calls = stub({ ok: true, operation: { type: 'create', path: '/ws/x.ts', kind: 'file' }, path: '/ws/x.ts', changedFiles: [] });
      await fn('/ws', 'preview-123');
      expect(calls[0].url).toBe(url);
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ root: '/ws', previewId: 'preview-123' });
      vi.unstubAllGlobals();
    }
  });
});
