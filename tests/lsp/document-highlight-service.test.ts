import { describe, expect, it, vi } from 'vitest';
import { createDocumentHighlightService } from '../../src/server/lsp/documentHighlightService';
import type {
  DocumentHighlightPlanInput,
  DocumentHighlightRequestTarget
} from '../../src/server/lsp/documentHighlightService';

describe('createDocumentHighlightService', () => {
  it('requests textDocument/documentHighlight from planned targets and preserves origin metadata', async () => {
    const input = documentHighlightInput();
    const tsHighlights = [documentHighlight(2)];
    const eslintHighlights = [documentHighlight(3)];
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: DocumentHighlightPlanInput) => ({
        targets: [target('tsserver', true), target('eslint', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async (target: { serverConfigId: string }) => {
        if (target.serverConfigId === 'tsserver') {
          return tsHighlights;
        }

        return eslintHighlights;
      })
    };
    const service = createDocumentHighlightService({ requestPlanner, manager });

    await expect(service.documentHighlights(input)).resolves.toEqual({
      results: [
        { serverConfigId: 'tsserver', isPrimary: true, result: tsHighlights },
        { serverConfigId: 'eslint', isPrimary: false, result: eslintHighlights }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'documentHighlight'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/documentHighlight',
      { textDocument: { uri: input.uri }, position: input.position }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/documentHighlight',
      { textDocument: { uri: input.uri }, position: input.position }
    );
  });

  it('returns no results and sends no requests when planning finds no document-highlight targets', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createDocumentHighlightService({ requestPlanner, manager });

    await expect(service.documentHighlights(documentHighlightInput())).resolves.toEqual({ results: [] });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('filters null, undefined, and empty highlight responses without dropping later results', async () => {
    const highlights = [documentHighlight(1)];
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [
          target('tsserver', true),
          target('eslint', false),
          target('tailwind', false),
          target('astro', false)
        ]
      }))
    };
    const manager = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(highlights)
    };
    const service = createDocumentHighlightService({ requestPlanner, manager });

    await expect(service.documentHighlights(documentHighlightInput())).resolves.toEqual({
      results: [{ serverConfigId: 'astro', isPrimary: false, result: highlights }]
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(4);
  });
});

function documentHighlightInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 }
  };
}

function target(serverConfigId: string, isPrimary: boolean): DocumentHighlightRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}

function documentHighlight(kind: number) {
  return {
    range: {
      start: { line: 3, character: 6 },
      end: { line: 3, character: 13 }
    },
    kind
  };
}
