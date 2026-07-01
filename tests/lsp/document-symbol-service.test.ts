import { describe, expect, it, vi } from 'vitest';
import { createDocumentSymbolService } from '../../src/server/lsp/documentSymbolService';
import type {
  DocumentSymbolPlanInput,
  DocumentSymbolRequestTarget
} from '../../src/server/lsp/documentSymbolService';

describe('createDocumentSymbolService', () => {
  it('requests textDocument/documentSymbol from planned targets and preserves origin metadata', async () => {
    const input = documentSymbolInput();
    const tsSymbols = [documentSymbol('Example')];
    const eslintSymbols = [documentSymbol('lint/example')];
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: DocumentSymbolPlanInput) => ({
        targets: [target('tsserver', true), target('eslint', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async (target: { serverConfigId: string }) => {
        if (target.serverConfigId === 'tsserver') {
          return tsSymbols;
        }

        return eslintSymbols;
      })
    };
    const service = createDocumentSymbolService({ requestPlanner, manager });

    await expect(service.documentSymbols(input)).resolves.toEqual({
      results: [
        { serverConfigId: 'tsserver', isPrimary: true, result: tsSymbols },
        { serverConfigId: 'eslint', isPrimary: false, result: eslintSymbols }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'documentSymbol'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/documentSymbol',
      { textDocument: { uri: input.uri } }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/documentSymbol',
      { textDocument: { uri: input.uri } }
    );
  });

  it('returns no results and sends no requests when planning finds no document-symbol targets', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createDocumentSymbolService({ requestPlanner, manager });

    await expect(service.documentSymbols(documentSymbolInput())).resolves.toEqual({ results: [] });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('filters null and empty symbol responses without dropping later results', async () => {
    const symbols = [documentSymbol('Tailwind')];
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [target('tsserver', true), target('eslint', false), target('tailwind', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([]).mockResolvedValueOnce(symbols)
    };
    const service = createDocumentSymbolService({ requestPlanner, manager });

    await expect(service.documentSymbols(documentSymbolInput())).resolves.toEqual({
      results: [{ serverConfigId: 'tailwind', isPrimary: false, result: symbols }]
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(3);
  });
});

function documentSymbolInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace'
  };
}

function target(serverConfigId: string, isPrimary: boolean): DocumentSymbolRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}

function documentSymbol(name: string) {
  return {
    name,
    kind: 5,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 4, character: 1 }
    },
    selectionRange: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 13 }
    }
  };
}
