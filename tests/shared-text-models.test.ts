import { describe, expect, it, vi } from 'vitest';
import { createSharedTextModelRegistry } from '../src/web/editor/sharedTextModelRegistry.js';

interface FakeModel {
  path: string;
  value: string;
}

function createHarness() {
  const models = new Map<string, FakeModel>();
  const createModel = vi.fn((path: string, content: string) => {
    const model = { path, value: content };
    models.set(path, model);
    return model;
  });
  const disposeModel = vi.fn((model: FakeModel) => {
    models.delete(model.path);
  });
  const registry = createSharedTextModelRegistry({
    keyForPath: (path) => path,
    findModel: (path) => models.get(path) ?? null,
    createModel,
    readModel: (model) => model.value,
    disposeModel
  });
  return { registry, createModel, disposeModel };
}

describe('createSharedTextModelRegistry', () => {
  it('reuses a live model without clobbering unsaved text with disk content', () => {
    const { registry, createModel } = createHarness();
    const editorLease = registry.acquire('/workspace/a.ts', 'const disk = true;');
    editorLease.model.value = 'const unsaved = true;';

    const notesLease = registry.acquire('/workspace/a.ts', 'const disk = true;');

    expect(notesLease.model).toBe(editorLease.model);
    expect(notesLease.model.value).toBe('const unsaved = true;');
    expect(notesLease.diskMatches).toBe(false);
    expect(createModel).toHaveBeenCalledTimes(1);

    notesLease.release();
    editorLease.release();
  });

  it('disposes the model only after the final lease is released', () => {
    const { registry, disposeModel } = createHarness();
    const editorLease = registry.acquire('/workspace/a.ts', 'text');
    const notesLease = registry.acquire('/workspace/a.ts', 'text');

    editorLease.release();
    expect(disposeModel).not.toHaveBeenCalled();

    notesLease.release();
    notesLease.release();
    expect(disposeModel).toHaveBeenCalledTimes(1);
    expect(disposeModel).toHaveBeenCalledWith(editorLease.model);
  });
});
