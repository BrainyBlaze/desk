import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LspDocumentStore } from '../../src/server/lsp/documentStore';

describe('LspDocumentStore', () => {
  it('treats file paths and file URIs as the same editor-open document', () => {
    const store = new LspDocumentStore();
    const workspaceRoot = '/workspace';
    const filePath = '/workspace/src/example.ts';
    const fileUri = pathToFileURL(filePath).href;

    const opened = store.openEditorDocument({
      workspaceRoot,
      uri: filePath,
      languageId: 'typescript',
      version: 7,
      text: 'const value = 1;\n'
    });

    expect(opened).toEqual({
      workspaceRoot,
      uri: fileUri,
      state: 'editor-open',
      languageId: 'typescript',
      version: 7,
      text: 'const value = 1;\n'
    });
    expect(store.getSnapshot({ workspaceRoot, uri: fileUri })).toEqual(opened);
  });

  it('keeps editor-open content when disk-cached content targets the same document', () => {
    const store = new LspDocumentStore();
    const workspaceRoot = '/workspace';
    const filePath = '/workspace/src/example.ts';
    const fileUri = pathToFileURL(filePath).href;

    store.cacheDiskDocument({
      workspaceRoot,
      uri: fileUri,
      languageId: 'typescript',
      version: 1,
      text: 'const disk = true;\n'
    });
    const opened = store.openEditorDocument({
      workspaceRoot,
      uri: filePath,
      languageId: 'typescript',
      version: 2,
      text: 'const editor = true;\n'
    });
    const afterDiskRefresh = store.cacheDiskDocument({
      workspaceRoot,
      uri: fileUri,
      languageId: 'typescript',
      version: 3,
      text: 'const staleDisk = true;\n'
    });

    expect(afterDiskRefresh).toEqual(opened);
    expect(store.getSnapshot({ workspaceRoot, uri: fileUri })).toEqual({
      workspaceRoot,
      uri: fileUri,
      state: 'editor-open',
      languageId: 'typescript',
      version: 2,
      text: 'const editor = true;\n'
    });
  });

  it('records a closed state and clears document text', () => {
    const store = new LspDocumentStore();
    const workspaceRoot = '/workspace';
    const filePath = '/workspace/src/example.ts';
    const fileUri = pathToFileURL(filePath).href;

    store.openEditorDocument({
      workspaceRoot,
      uri: fileUri,
      languageId: 'typescript',
      version: 4,
      text: 'const value = 1;\n'
    });

    const closed = store.closeDocument({ workspaceRoot, uri: filePath });

    expect(closed).toEqual({
      workspaceRoot,
      uri: fileUri,
      state: 'closed'
    });
    expect(store.getSnapshot({ workspaceRoot, uri: fileUri })).toEqual(closed);
  });
});
