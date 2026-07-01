import { describe, expect, it, vi } from 'vitest';
import { createLspRequestApi } from '../../src/server/lsp/requestApi';

describe('LspRequestApi', () => {
  it('routes a textDocument/hover request body to hoverService with settings and LSP params', async () => {
    const settings = { enabled: true, languages: [] };
    const hoverResult = {
      results: [{ serverConfigId: 'tsserver', isPrimary: true, result: { contents: 'hover text' } }]
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = {
      hover: vi.fn(async () => hoverResult)
    };
    const formattingService = {
      formatDocument: vi.fn()
    };
    const documentSymbolService = {
      documentSymbols: vi.fn()
    };
    const completionService = {
      complete: vi.fn()
    };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });
    const body = hoverRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: hoverResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 }
    });
  });

  it('routes a textDocument/formatting request body to formattingService with settings and options', async () => {
    const settings = { enabled: true, languages: [] };
    const formattingResult = {
      serverConfigId: 'prettier',
      isPrimary: true,
      result: [
        {
          range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 12 }
          },
          newText: 'const x = 1;\n'
        }
      ]
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = {
      formatDocument: vi.fn(async () => formattingResult)
    };
    const documentSymbolService = {
      documentSymbols: vi.fn()
    };
    const completionService = {
      complete: vi.fn()
    };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });
    const body = formattingRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: formattingResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      options: { tabSize: 2, insertSpaces: true }
    });
  });

  it('routes a textDocument/documentSymbol request body to documentSymbolService with settings', async () => {
    const settings = { enabled: true, languages: [] };
    const documentSymbolResult = {
      results: [{ serverConfigId: 'tsserver', isPrimary: true, result: [{ name: 'Example', kind: 5 }] }]
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = {
      documentSymbols: vi.fn(async () => documentSymbolResult)
    };
    const completionService = {
      complete: vi.fn()
    };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });
    const body = documentSymbolRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: documentSymbolResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace'
    });
  });

  it('routes a textDocument/completion request body to completionService with settings and context', async () => {
    const settings = { enabled: true, languages: [] };
    const completionResult = {
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: { isIncomplete: false, items: [{ label: 'example' }] }
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = {
      complete: vi.fn(async () => completionResult)
    };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });
    const body = completionRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: completionResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      context: { triggerKind: 2, triggerCharacter: '.' }
    });
  });

  it('routes a textDocument/completion request body when optional context is absent', async () => {
    const settings = { enabled: true, languages: [] };
    const completionResult = { result: null };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = {
      complete: vi.fn(async () => completionResult)
    };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });
    const body = completionRequestBodyWithoutContext();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: completionResult });
    expect(completionService.complete).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      context: undefined
    });
  });

  it('routes a textDocument/signatureHelp request body to signatureHelpService with settings and context', async () => {
    const settings = { enabled: true, languages: [] };
    const signatureHelpResult = {
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: { signatures: [{ label: 'example(value: string)' }], activeSignature: 0, activeParameter: 0 }
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = {
      signatureHelp: vi.fn(async () => signatureHelpResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService
    });
    const body = signatureHelpRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: signatureHelpResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      context: {
        triggerKind: 2,
        triggerCharacter: '(',
        isRetrigger: false,
        activeSignatureHelp: { signatures: [{ label: 'previous()' }], activeSignature: 0, activeParameter: 0 }
      }
    });
  });

  it('routes a textDocument/signatureHelp request body when optional context is absent', async () => {
    const settings = { enabled: true, languages: [] };
    const signatureHelpResult = { result: null };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = {
      signatureHelp: vi.fn(async () => signatureHelpResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService
    });
    const body = signatureHelpRequestBodyWithoutContext();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: signatureHelpResult });
    expect(signatureHelpService.signatureHelp).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      context: undefined
    });
  });

  it('routes a textDocument/prepareRename request body to renameService with settings and position', async () => {
    const settings = { enabled: true, languages: [] };
    const prepareRenameResult = {
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: {
        range: {
          start: { line: 3, character: 6 },
          end: { line: 3, character: 13 }
        },
        placeholder: 'example'
      }
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const renameService = {
      prepareRename: vi.fn(async () => prepareRenameResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService,
      renameService
    });
    const body = prepareRenameRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: prepareRenameResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
    expect(renameService.prepareRename).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 }
    });
  });

  it('routes a textDocument/rename request body to renameService with settings, position, and newName', async () => {
    const settings = { enabled: true, languages: [] };
    const renameResult = {
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: {
        changes: {
          'file:///workspace/src/example.ts': [
            {
              range: {
                start: { line: 3, character: 6 },
                end: { line: 3, character: 13 }
              },
              newText: 'renamedExample'
            }
          ]
        }
      }
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const renameService = {
      prepareRename: vi.fn(),
      rename: vi.fn(async () => renameResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService,
      renameService
    });
    const body = renameRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: renameResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
    expect(renameService.prepareRename).not.toHaveBeenCalled();
    expect(renameService.rename).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      newName: 'renamedExample'
    });
  });

  it('routes a textDocument/documentHighlight request body to documentHighlightService with settings and position', async () => {
    const settings = { enabled: true, languages: [] };
    const documentHighlightResult = {
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [
            {
              range: {
                start: { line: 3, character: 0 },
                end: { line: 3, character: 12 }
              },
              kind: 2
            }
          ]
        }
      ]
    };
    const getSettings = vi.fn(() => settings);
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const renameService = { prepareRename: vi.fn() };
    const documentHighlightService = {
      documentHighlights: vi.fn(async () => documentHighlightResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService,
      renameService,
      documentHighlightService
    });
    const body = documentHighlightRequestBody();

    await expect(api.handleRequest(body)).resolves.toEqual({ ok: true, result: documentHighlightResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
    expect(renameService.prepareRename).not.toHaveBeenCalled();
    expect(documentHighlightService.documentHighlights).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 }
    });
  });

  it('routes location request bodies to locationService with settings and LSP params', async () => {
    const settings = { enabled: true, languages: [] };
    const locationResult = {
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: {
            uri: 'file:///workspace/src/target.ts',
            range: {
              start: { line: 4, character: 1 },
              end: { line: 4, character: 9 }
            }
          }
        }
      ]
    };
    const getSettings = vi.fn(() => settings);
    const locationService = {
      definition: vi.fn(async () => locationResult),
      references: vi.fn(async () => locationResult),
      typeDefinition: vi.fn(async () => locationResult),
      implementation: vi.fn(async () => locationResult),
      declaration: vi.fn(async () => locationResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService: { hover: vi.fn() },
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService
    });

    for (const [method, serviceName] of [
      ['textDocument/definition', 'definition'],
      ['textDocument/typeDefinition', 'typeDefinition'],
      ['textDocument/implementation', 'implementation'],
      ['textDocument/declaration', 'declaration']
    ] as const) {
      await expect(api.handleRequest(locationRequestBody(method))).resolves.toEqual({ ok: true, result: locationResult });
      expect(locationService[serviceName]).toHaveBeenCalledWith({
        settings,
        uri: 'file:///workspace/src/example.ts',
        languageId: 'typescript',
        workspaceRoot: '/workspace',
        position: { line: 3, character: 7 }
      });
    }

    await expect(api.handleRequest(referencesRequestBody(false))).resolves.toEqual({ ok: true, result: locationResult });
    expect(locationService.references).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      includeDeclaration: false
    });

    await expect(api.handleRequest(referencesRequestBody())).resolves.toEqual({ ok: true, result: locationResult });
    expect(locationService.references).toHaveBeenLastCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      position: { line: 3, character: 7 },
      includeDeclaration: false
    });
  });

  it('rejects malformed location params before calling locationService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const locationService = {
      definition: vi.fn(),
      references: vi.fn(),
      typeDefinition: vi.fn(),
      implementation: vi.fn(),
      declaration: vi.fn()
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService: { hover: vi.fn() },
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService
    });

    for (const method of [
      'textDocument/definition',
      'textDocument/references',
      'textDocument/typeDefinition',
      'textDocument/implementation',
      'textDocument/declaration'
    ]) {
      await expect(
        api.handleRequest({
          workspaceRoot: '/workspace',
          method,
          params: {
            textDocument: { uri: 'file:///workspace/src/example.ts' },
            position: { line: 3 }
          }
        })
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: `Invalid ${method} request body` }
      });
    }

    expect(getSettings).not.toHaveBeenCalled();
    expect(locationService.definition).not.toHaveBeenCalled();
    expect(locationService.references).not.toHaveBeenCalled();
    expect(locationService.typeDefinition).not.toHaveBeenCalled();
    expect(locationService.implementation).not.toHaveBeenCalled();
    expect(locationService.declaration).not.toHaveBeenCalled();
  });

  it('routes desk/lspDiagnostics to diagnosticsService without loading settings or sending LSP requests', async () => {
    const diagnosticsResult = {
      diagnostics: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          message: 'type error'
        }
      ]
    };
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const diagnosticsService = {
      diagnostics: vi.fn(async () => diagnosticsResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService: {
        definition: vi.fn(),
        references: vi.fn(),
        typeDefinition: vi.fn(),
        implementation: vi.fn(),
        declaration: vi.fn()
      },
      diagnosticsService
    });

    await expect(api.handleRequest(diagnosticsRequestBody())).resolves.toEqual({ ok: true, result: diagnosticsResult });
    await expect(api.handleRequest(diagnosticsRequestBody(false))).resolves.toEqual({ ok: true, result: diagnosticsResult });
    expect(diagnosticsService.diagnostics).toHaveBeenNthCalledWith(1, {
      workspaceRoot: '/workspace',
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript'
    });
    expect(diagnosticsService.diagnostics).toHaveBeenNthCalledWith(2, {
      workspaceRoot: '/workspace',
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript'
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
  });

  it('routes refresh desk/lspDiagnostics to diagnosticsService with settings', async () => {
    const settings = { enabled: true, languages: ['typescript'] };
    const diagnosticsResult = { diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }, message: 'pulled' }] };
    const getSettings = vi.fn(() => settings);
    const diagnosticsService = {
      diagnostics: vi.fn(async () => diagnosticsResult)
    };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService: { hover: vi.fn() },
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService: {
        definition: vi.fn(),
        references: vi.fn(),
        typeDefinition: vi.fn(),
        implementation: vi.fn(),
        declaration: vi.fn()
      },
      diagnosticsService
    });

    await expect(api.handleRequest(diagnosticsRequestBody(true))).resolves.toEqual({ ok: true, result: diagnosticsResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(diagnosticsService.diagnostics).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      refresh: true,
      settings
    });
  });

  it('rejects malformed desk/lspDiagnostics bodies before calling diagnosticsService', async () => {
    const diagnosticsService = { diagnostics: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings: vi.fn(() => ({ enabled: true })),
      hoverService: { hover: vi.fn() },
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService: {
        definition: vi.fn(),
        references: vi.fn(),
        typeDefinition: vi.fn(),
        implementation: vi.fn(),
        declaration: vi.fn()
      },
      diagnosticsService
    });

    for (const body of [
      { method: 'desk/lspDiagnostics', workspaceRoot: '/workspace', params: { textDocument: {} } },
      {
        method: 'desk/lspDiagnostics',
        params: { textDocument: { uri: 'file:///workspace/src/example.ts' } }
      },
      {
        method: 'desk/lspDiagnostics',
        workspaceRoot: '/workspace',
        params: { textDocument: { uri: 123 } }
      }
    ]) {
      await expect(api.handleRequest(body)).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid desk/lspDiagnostics request body' }
      });
    }

    expect(diagnosticsService.diagnostics).not.toHaveBeenCalled();
  });

  it('routes textDocument/foldingRange to foldingRangeService with settings and exact LSP params', async () => {
    const settings = { enabled: true, languages: [] };
    const foldingRangeResult = {
      results: [{ serverConfigId: 'tsserver', isPrimary: true, result: [{ startLine: 1, endLine: 4 }] }]
    };
    const getSettings = vi.fn(() => settings);
    const foldingRangeService = { foldingRanges: vi.fn(async () => foldingRangeResult) };
    const api = createTestLspRequestApi({ getSettings, foldingRangeService });

    await expect(api.handleRequest(foldingRangeRequestBody())).resolves.toEqual({ ok: true, result: foldingRangeResult });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(foldingRangeService.foldingRanges).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace'
    });
  });

  it('routes textDocument/selectionRange to selectionRangeService with settings and bounded positions', async () => {
    const settings = { enabled: true, languages: [] };
    const selectionRangeResult = {
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }]
        }
      ]
    };
    const getSettings = vi.fn(() => settings);
    const selectionRangeService = { selectionRanges: vi.fn(async () => selectionRangeResult) };
    const api = createTestLspRequestApi({ getSettings, selectionRangeService });

    await expect(api.handleRequest(selectionRangeRequestBody())).resolves.toEqual({
      ok: true,
      result: selectionRangeResult
    });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(selectionRangeService.selectionRanges).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      positions: [
        { line: 1, character: 2 },
        { line: 3, character: 4 }
      ]
    });
  });

  it('routes textDocument/semanticTokens/full to semanticTokensService with settings and exact LSP params', async () => {
    const settings = { enabled: true, languages: [] };
    const semanticTokensResult = {
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: { data: [0, 0, 5, 1, 0] },
          legend: { tokenTypes: ['variable'], tokenModifiers: ['declaration'] },
          semanticTokensProvider: { full: true }
        }
      ]
    };
    const getSettings = vi.fn(() => settings);
    const semanticTokensService = { semanticTokens: vi.fn(async () => semanticTokensResult) };
    const api = createTestLspRequestApi({ getSettings, semanticTokensService });

    await expect(api.handleRequest(semanticTokensRequestBody())).resolves.toEqual({
      ok: true,
      result: semanticTokensResult
    });
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(semanticTokensService.semanticTokens).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace'
    });
  });

  it('rejects malformed foldingRange and selectionRange params before service calls', async () => {
    const foldingRangeService = { foldingRanges: vi.fn() };
    const selectionRangeService = { selectionRanges: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings: vi.fn(() => ({ enabled: true })),
      foldingRangeService,
      selectionRangeService
    });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/foldingRange',
        params: { textDocument: {} }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/foldingRange request body' }
    });

    for (const params of [
      { textDocument: { uri: 'file:///workspace/src/example.ts' } },
      { textDocument: { uri: 'file:///workspace/src/example.ts' }, positions: [] },
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        positions: Array.from({ length: 101 }, () => ({ line: 0, character: 0 }))
      },
      { textDocument: { uri: 'file:///workspace/src/example.ts' }, positions: [{ line: -1, character: 0 }] },
      { textDocument: { uri: 'file:///workspace/src/example.ts' }, positions: [{ line: 1.5, character: 0 }] },
      { textDocument: { uri: 'file:///workspace/src/example.ts' }, positions: [{ line: 1, character: '0' }] }
    ]) {
      await expect(
        api.handleRequest({
          workspaceRoot: '/workspace',
          method: 'textDocument/selectionRange',
          params
        })
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid textDocument/selectionRange request body' }
      });
    }

    expect(foldingRangeService.foldingRanges).not.toHaveBeenCalled();
    expect(selectionRangeService.selectionRanges).not.toHaveBeenCalled();
  });

  it('rejects malformed semanticTokens params before service calls', async () => {
    const semanticTokensService = { semanticTokens: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings: vi.fn(() => ({ enabled: true })),
      semanticTokensService
    });

    for (const body of [
      { method: 'textDocument/semanticTokens/full', workspaceRoot: '/workspace', params: { textDocument: {} } },
      {
        method: 'textDocument/semanticTokens/full',
        params: { textDocument: { uri: 'file:///workspace/src/example.ts' } }
      },
      {
        method: 'textDocument/semanticTokens/full',
        workspaceRoot: '/workspace',
        params: { textDocument: { uri: 123 } }
      }
    ]) {
      await expect(api.handleRequest(body)).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid textDocument/semanticTokens/full request body' }
      });
    }

    expect(semanticTokensService.semanticTokens).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods without calling hoverService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/unknown',
        params: {}
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'unsupported_method', message: 'Unsupported LSP request method: textDocument/unknown' }
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed hover params before calling hoverService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/hover',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          position: { line: 3 }
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/hover request body' }
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed formatting params before calling formattingService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/formatting',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          options: { tabSize: 2 }
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/formatting request body' }
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed documentSymbol params before calling documentSymbolService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/documentSymbol',
        params: {
          textDocument: {}
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/documentSymbol request body' }
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed completion context before calling completionService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const api = createTestLspRequestApi({ getSettings, hoverService, formattingService, documentSymbolService, completionService });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/completion',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          position: { line: 3, character: 7 },
          context: { triggerKind: 'invoked' }
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/completion request body' }
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed signatureHelp context before calling signatureHelpService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService
    });

    for (const context of [
      { triggerKind: 'invoked' },
      { triggerKind: 2, triggerCharacter: 123 },
      { triggerKind: 2, isRetrigger: 'false' }
    ]) {
      await expect(
        api.handleRequest({
          workspaceRoot: '/workspace',
          method: 'textDocument/signatureHelp',
          params: {
            textDocument: { uri: 'file:///workspace/src/example.ts' },
            position: { line: 3, character: 7 },
            context
          }
        })
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid textDocument/signatureHelp request body' }
      });
    }

    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
  });

  it('rejects malformed prepareRename params before calling renameService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const renameService = { prepareRename: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService,
      renameService
    });

    for (const params of [
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3 }
      },
      {
        textDocument: {},
        position: { line: 3, character: 7 }
      },
      {
        position: { line: 3, character: 7 }
      }
    ]) {
      await expect(
        api.handleRequest({
          workspaceRoot: '/workspace',
          method: 'textDocument/prepareRename',
          params
        })
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid textDocument/prepareRename request body' }
      });
    }

    await expect(
      api.handleRequest({
        method: 'textDocument/prepareRename',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          position: { line: 3, character: 7 }
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/prepareRename request body' }
    });

    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
    expect(renameService.prepareRename).not.toHaveBeenCalled();
  });

  it('rejects malformed rename params before calling renameService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const renameService = { prepareRename: vi.fn(), rename: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService,
      renameService
    });

    for (const params of [
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3 },
        newName: 'renamedExample'
      },
      {
        textDocument: {},
        position: { line: 3, character: 7 },
        newName: 'renamedExample'
      },
      {
        position: { line: 3, character: 7 },
        newName: 'renamedExample'
      },
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3, character: 7 },
        newName: 123
      }
    ]) {
      await expect(
        api.handleRequest({
          workspaceRoot: '/workspace',
          method: 'textDocument/rename',
          params
        })
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid textDocument/rename request body' }
      });
    }

    await expect(
      api.handleRequest({
        method: 'textDocument/rename',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          position: { line: 3, character: 7 },
          newName: 'renamedExample'
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/rename request body' }
    });

    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
    expect(renameService.prepareRename).not.toHaveBeenCalled();
    expect(renameService.rename).not.toHaveBeenCalled();
  });

  it('rejects malformed documentHighlight params before calling documentHighlightService', async () => {
    const getSettings = vi.fn(() => ({ enabled: true }));
    const hoverService = { hover: vi.fn() };
    const formattingService = { formatDocument: vi.fn() };
    const documentSymbolService = { documentSymbols: vi.fn() };
    const completionService = { complete: vi.fn() };
    const signatureHelpService = { signatureHelp: vi.fn() };
    const renameService = { prepareRename: vi.fn() };
    const documentHighlightService = { documentHighlights: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService,
      formattingService,
      documentSymbolService,
      completionService,
      signatureHelpService,
      renameService,
      documentHighlightService
    });

    for (const params of [
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3 }
      },
      {
        textDocument: {},
        position: { line: 3, character: 7 }
      },
      {
        position: { line: 3, character: 7 }
      }
    ]) {
      await expect(
        api.handleRequest({
          workspaceRoot: '/workspace',
          method: 'textDocument/documentHighlight',
          params
        })
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid textDocument/documentHighlight request body' }
      });
    }

    await expect(
      api.handleRequest({
        method: 'textDocument/documentHighlight',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          position: { line: 3, character: 7 }
        }
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid textDocument/documentHighlight request body' }
    });

    expect(getSettings).not.toHaveBeenCalled();
    expect(hoverService.hover).not.toHaveBeenCalled();
    expect(formattingService.formatDocument).not.toHaveBeenCalled();
    expect(documentSymbolService.documentSymbols).not.toHaveBeenCalled();
    expect(completionService.complete).not.toHaveBeenCalled();
    expect(signatureHelpService.signatureHelp).not.toHaveBeenCalled();
    expect(renameService.prepareRename).not.toHaveBeenCalled();
    expect(documentHighlightService.documentHighlights).not.toHaveBeenCalled();
  });

  it('routes textDocument/codeAction to codeActionService with settings and LSP params', async () => {
    const settings = { enabled: true, languages: [] };
    const codeActionResult = {
      results: [{ serverConfigId: 'tsserver', isPrimary: true, result: [{ title: 'Fix', kind: 'quickfix' }] }]
    };
    const getSettings = vi.fn(() => settings);
    const codeActionService = { codeActions: vi.fn(async () => codeActionResult) };
    const api = createTestLspRequestApi({
      getSettings,
      hoverService: { hover: vi.fn() },
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService: { definition: vi.fn(), references: vi.fn(), typeDefinition: vi.fn(), implementation: vi.fn(), declaration: vi.fn() },
      diagnosticsService: { diagnostics: vi.fn() },
      codeActionService
    });

    await expect(api.handleRequest(codeActionRequestBody())).resolves.toEqual({ ok: true, result: codeActionResult });
    expect(codeActionService.codeActions).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      context: { diagnostics: [], only: ['quickfix'], triggerKind: 1 }
    });
  });

  it('rejects malformed code-action params before calling codeActionService', async () => {
    const codeActionService = { codeActions: vi.fn() };
    const api = createTestLspRequestApi({
      getSettings: vi.fn(() => ({ enabled: true })),
      hoverService: { hover: vi.fn() },
      formattingService: { formatDocument: vi.fn() },
      documentSymbolService: { documentSymbols: vi.fn() },
      completionService: { complete: vi.fn() },
      signatureHelpService: { signatureHelp: vi.fn() },
      renameService: { prepareRename: vi.fn(), rename: vi.fn() },
      documentHighlightService: { documentHighlights: vi.fn() },
      locationService: { definition: vi.fn(), references: vi.fn(), typeDefinition: vi.fn(), implementation: vi.fn(), declaration: vi.fn() },
      diagnosticsService: { diagnostics: vi.fn() },
      codeActionService
    });

    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/codeAction',
        params: { textDocument: { uri: 'file:///workspace/src/example.ts' }, context: { diagnostics: [] } }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(
      api.handleRequest({
        workspaceRoot: '/workspace',
        method: 'textDocument/codeAction',
        params: {
          textDocument: { uri: 'file:///workspace/src/example.ts' },
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          context: {}
        }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(codeActionService.codeActions).not.toHaveBeenCalled();
  });
});

function createTestLspRequestApi(overrides: any) {
  return createLspRequestApi({
    getSettings: vi.fn(() => ({ enabled: true })),
    hoverService: { hover: vi.fn() },
    formattingService: { formatDocument: vi.fn() },
    documentSymbolService: { documentSymbols: vi.fn() },
    completionService: { complete: vi.fn() },
    signatureHelpService: { signatureHelp: vi.fn() },
    renameService: { prepareRename: vi.fn(), rename: vi.fn() },
    documentHighlightService: { documentHighlights: vi.fn() },
    locationService: {
      definition: vi.fn(),
      references: vi.fn(),
      typeDefinition: vi.fn(),
      implementation: vi.fn(),
      declaration: vi.fn()
    },
    diagnosticsService: { diagnostics: vi.fn() },
    codeActionService: { codeActions: vi.fn() },
    foldingRangeService: { foldingRanges: vi.fn() },
    selectionRangeService: { selectionRanges: vi.fn() },
    semanticTokensService: { semanticTokens: vi.fn() },
    ...overrides
  } as any);
}

function codeActionRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/codeAction',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      context: { diagnostics: [], only: ['quickfix'], triggerKind: 1 }
    }
  };
}

function foldingRangeRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/foldingRange',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' }
    }
  };
}

function selectionRangeRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/selectionRange',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      positions: [
        { line: 1, character: 2 },
        { line: 3, character: 4 }
      ]
    }
  };
}

function semanticTokensRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/semanticTokens/full',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' }
    }
  };
}

function hoverRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/hover',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 }
    }
  };
}

function formattingRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/formatting',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      options: { tabSize: 2, insertSpaces: true }
    }
  };
}

function documentSymbolRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/documentSymbol',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' }
    }
  };
}

function completionRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 },
      context: { triggerKind: 2, triggerCharacter: '.' }
    }
  };
}

function completionRequestBodyWithoutContext() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 }
    }
  };
}

function signatureHelpRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/signatureHelp',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 },
      context: {
        triggerKind: 2,
        triggerCharacter: '(',
        isRetrigger: false,
        activeSignatureHelp: { signatures: [{ label: 'previous()' }], activeSignature: 0, activeParameter: 0 }
      }
    }
  };
}

function signatureHelpRequestBodyWithoutContext() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/signatureHelp',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 }
    }
  };
}

function prepareRenameRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/prepareRename',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 }
    }
  };
}

function renameRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/rename',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 },
      newName: 'renamedExample'
    }
  };
}

function documentHighlightRequestBody() {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/documentHighlight',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 }
    }
  };
}

function locationRequestBody(method: string) {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method,
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 }
    }
  };
}

function referencesRequestBody(includeDeclaration?: boolean) {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'textDocument/references',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      position: { line: 3, character: 7 },
      ...(includeDeclaration !== undefined ? { context: { includeDeclaration } } : {})
    }
  };
}

function diagnosticsRequestBody(refresh?: boolean) {
  return {
    workspaceRoot: '/workspace',
    languageId: 'typescript',
    method: 'desk/lspDiagnostics',
    params: {
      textDocument: { uri: 'file:///workspace/src/example.ts' },
      ...(refresh !== undefined ? { refresh } : {})
    }
  };
}
