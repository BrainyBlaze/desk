import { describe, expect, it } from 'vitest';
import {
  createCodeActionProvider,
  createCodeLensProvider,
  createColorProvider,
  createCompletionProvider,
  createDeclarationProvider,
  createDefinitionProvider,
  createDocumentFormattingProvider,
  createDocumentHighlightProvider,
  createDocumentLinkProvider,
  createDocumentOnTypeFormattingProvider,
  createDocumentRangeFormattingProvider,
  createDocumentSymbolProvider,
  createFoldingRangeProvider,
  createHoverProvider,
  createImplementationProvider,
  createInlayHintProvider,
  createLinkedEditingRangeProvider,
  createPrepareRenameProvider,
  createReferencesProvider,
  createRenameProvider,
  createDocumentRangeSemanticTokensProvider,
  createDocumentSemanticTokensProvider,
  createSelectionRangeProvider,
  createSignatureHelpProvider,
  createTypeDefinitionProvider
} from '../src/web/editor/lsp/providers';

function makeConnection(result: unknown) {
  const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  const connection = {
    request: (method: string, params: unknown, options?: unknown): Promise<unknown> => {
      calls.push({ method, params, options });
      return Promise.resolve(result);
    }
  };
  return { connection, calls };
}

describe('createHoverProvider', () => {
  it('sends textDocument/hover with the document uri+position and converts the result', async () => {
    const { connection, calls } = makeConnection({ contents: { kind: 'markdown', value: 'doc' } });
    const provider = createHoverProvider(connection);
    const hover = await provider.provideHover({ uri: 'file:///a.ts', position: { line: 1, character: 2 } });
    expect(calls[0]!.method).toBe('textDocument/hover');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 1, character: 2 } });
    expect(hover).toEqual({ contents: [{ value: 'doc' }] });
  });

  it('returns null when the server has no hover', async () => {
    const { connection } = makeConnection(null);
    const provider = createHoverProvider(connection);
    expect(await provider.provideHover({ uri: 'file:///a.ts', position: { line: 0, character: 0 } })).toBeNull();
  });

  it('forwards the cancellation signal to the request', async () => {
    const { connection, calls } = makeConnection({ contents: 'x' });
    const provider = createHoverProvider(connection);
    const controller = new AbortController();
    await provider.provideHover({ uri: 'file:///a.ts', position: { line: 0, character: 0 } }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });
});

describe('createDefinitionProvider', () => {
  it('sends textDocument/definition and converts the result to Monaco locations', async () => {
    const { connection, calls } = makeConnection({
      uri: 'file:///b.ts',
      range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } }
    });
    const provider = createDefinitionProvider(connection);
    const locations = await provider.provideDefinition({ uri: 'file:///a.ts', position: { line: 0, character: 0 } });
    expect(calls[0]!.method).toBe('textDocument/definition');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 0 } });
    expect(locations).toEqual([
      { uri: 'file:///b.ts', range: { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 } }
    ]);
  });

  it('definition returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDefinitionProvider(connection);
    expect(await provider.provideDefinition({ uri: 'file:///a.ts', position: { line: 0, character: 0 } })).toEqual([]);
  });
});

describe('createReferencesProvider', () => {
  it('sends textDocument/references with includeDeclaration context and converts', async () => {
    const loc = { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } };
    const { connection, calls } = makeConnection([loc]);
    const provider = createReferencesProvider(connection);
    const refs = await provider.provideReferences(
      { uri: 'file:///a.ts', position: { line: 0, character: 1 } },
      { includeDeclaration: true }
    );
    expect(calls[0]!.method).toBe('textDocument/references');
    expect(calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 0, character: 1 },
      context: { includeDeclaration: true }
    });
    expect(refs).toEqual([
      { uri: 'file:///a.ts', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 } }
    ]);
  });
});

describe('createTypeDefinitionProvider', () => {
  it('sends textDocument/typeDefinition and converts to Monaco locations', async () => {
    const { connection, calls } = makeConnection({
      uri: 'file:///b.ts',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }
    });
    const provider = createTypeDefinitionProvider(connection);
    const locations = await provider.provideTypeDefinition({ uri: 'file:///a.ts', position: { line: 0, character: 0 } });
    expect(calls[0]!.method).toBe('textDocument/typeDefinition');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 0 } });
    expect(locations).toEqual([
      { uri: 'file:///b.ts', range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 3 } }
    ]);
  });
});

describe('createImplementationProvider', () => {
  it('sends textDocument/implementation', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createImplementationProvider(connection);
    const locations = await provider.provideImplementation({ uri: 'file:///a.ts', position: { line: 0, character: 0 } });
    expect(calls[0]!.method).toBe('textDocument/implementation');
    expect(locations).toEqual([]);
  });
});

describe('createDeclarationProvider', () => {
  it('sends textDocument/declaration', async () => {
    const { connection, calls } = makeConnection([
      { uri: 'file:///c.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
    ]);
    const provider = createDeclarationProvider(connection);
    const locations = await provider.provideDeclaration({ uri: 'file:///a.ts', position: { line: 0, character: 0 } });
    expect(calls[0]!.method).toBe('textDocument/declaration');
    expect(locations).toEqual([
      { uri: 'file:///c.ts', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 } }
    ]);
  });
});

describe('createDocumentFormattingProvider', () => {
  it('sends textDocument/formatting with options and converts edits', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: '  ' }
    ]);
    const provider = createDocumentFormattingProvider(connection);
    const edits = await provider.provideDocumentFormatting({
      uri: 'file:///a.ts',
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(calls[0]!.method).toBe('textDocument/formatting');
    expect(calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, text: '  ' }
    ]);
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentFormattingProvider(connection);
    expect(
      await provider.provideDocumentFormatting({ uri: 'file:///a.ts', options: { tabSize: 2, insertSpaces: true } })
    ).toEqual([]);
  });
});

describe('createDocumentSymbolProvider', () => {
  it('sends textDocument/documentSymbol and converts to Monaco document symbols', async () => {
    const { connection, calls } = makeConnection([
      {
        name: 'X',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }
      }
    ]);
    const provider = createDocumentSymbolProvider(connection);
    const symbols = await provider.provideDocumentSymbols({ uri: 'file:///a.ts' });
    expect(calls[0]!.method).toBe('textDocument/documentSymbol');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(symbols).toEqual([
      {
        name: 'X',
        detail: '',
        kind: 4,
        tags: [],
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        selectionRange: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 },
        children: []
      }
    ]);
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentSymbolProvider(connection);
    expect(await provider.provideDocumentSymbols({ uri: 'file:///a.ts' })).toEqual([]);
  });
});

describe('createCompletionProvider', () => {
  it('sends textDocument/completion and converts to a Monaco completion list draft', async () => {
    const { connection, calls } = makeConnection({ isIncomplete: false, items: [{ label: 'foo', kind: 3 }] });
    const provider = createCompletionProvider(connection);
    const list = await provider.provideCompletions({ uri: 'file:///a.ts', position: { line: 0, character: 0 } });
    expect(calls[0]!.method).toBe('textDocument/completion');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 0 } });
    expect(list).toEqual({ incomplete: false, suggestions: [{ label: 'foo', kind: 1, insertText: 'foo' }] });
  });

  it('forwards completion context when provided', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createCompletionProvider(connection);
    await provider.provideCompletions(
      { uri: 'file:///a.ts', position: { line: 1, character: 2 } },
      { triggerKind: 2, triggerCharacter: '.' }
    );
    expect(calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 2 },
      context: { triggerKind: 2, triggerCharacter: '.' }
    });
  });

  it('forwards the cancellation signal to the request', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createCompletionProvider(connection);
    const controller = new AbortController();
    await provider.provideCompletions({ uri: 'file:///a.ts', position: { line: 0, character: 0 } }, undefined, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns an empty draft list when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createCompletionProvider(connection);
    expect(await provider.provideCompletions({ uri: 'file:///a.ts', position: { line: 0, character: 0 } })).toEqual({
      incomplete: false,
      suggestions: []
    });
  });
});

describe('createSignatureHelpProvider', () => {
  it('sends textDocument/signatureHelp and converts to Monaco signature help', async () => {
    const { connection, calls } = makeConnection({ signatures: [{ label: 'f(a)' }], activeSignature: 0, activeParameter: 0 });
    const provider = createSignatureHelpProvider(connection);
    const help = await provider.provideSignatureHelp({ uri: 'file:///a.ts', position: { line: 0, character: 3 } });
    expect(calls[0]!.method).toBe('textDocument/signatureHelp');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 3 } });
    expect(help).toEqual({ activeSignature: 0, activeParameter: 0, signatures: [{ label: 'f(a)', parameters: [] }] });
  });

  it('forwards the full signatureHelp context including activeSignatureHelp unchanged', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createSignatureHelpProvider(connection);
    const context = {
      triggerKind: 3,
      isRetrigger: true,
      activeSignatureHelp: { signatures: [{ label: 'prev' }], activeSignature: 0, activeParameter: 0 }
    };
    await provider.provideSignatureHelp({ uri: 'file:///a.ts', position: { line: 1, character: 0 } }, context);
    expect(calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 0 },
      context
    });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createSignatureHelpProvider(connection);
    const controller = new AbortController();
    await provider.provideSignatureHelp({ uri: 'file:///a.ts', position: { line: 0, character: 0 } }, undefined, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns null when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createSignatureHelpProvider(connection);
    expect(await provider.provideSignatureHelp({ uri: 'file:///a.ts', position: { line: 0, character: 0 } })).toBeNull();
  });
});

describe('createDocumentHighlightProvider', () => {
  it('sends textDocument/documentHighlight and converts to Monaco highlights', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, kind: 2 }
    ]);
    const provider = createDocumentHighlightProvider(connection);
    const highlights = await provider.provideDocumentHighlights({ uri: 'file:///a.ts', position: { line: 0, character: 1 } });
    expect(calls[0]!.method).toBe('textDocument/documentHighlight');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 1 } });
    expect(highlights).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, kind: 1 }]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createDocumentHighlightProvider(connection);
    const controller = new AbortController();
    await provider.provideDocumentHighlights({ uri: 'file:///a.ts', position: { line: 0, character: 0 } }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentHighlightProvider(connection);
    expect(await provider.provideDocumentHighlights({ uri: 'file:///a.ts', position: { line: 0, character: 0 } })).toEqual([]);
  });
});

describe('createRenameProvider', () => {
  it('sends textDocument/rename with newName and converts to a Monaco workspace edit', async () => {
    const { connection, calls } = makeConnection({
      changes: { 'file:///a.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' }] }
    });
    const provider = createRenameProvider(connection);
    const edit = await provider.provideRenameEdits({ uri: 'file:///a.ts', position: { line: 0, character: 1 }, newName: 'bar' });
    expect(calls[0]!.method).toBe('textDocument/rename');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 1 }, newName: 'bar' });
    expect(edit).toEqual({
      edits: [
        { resource: 'file:///a.ts', textEdit: { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'bar' } }
      ]
    });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createRenameProvider(connection);
    const controller = new AbortController();
    await provider.provideRenameEdits({ uri: 'file:///a.ts', position: { line: 0, character: 0 }, newName: 'x' }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns { edits: [] } when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createRenameProvider(connection);
    expect(await provider.provideRenameEdits({ uri: 'file:///a.ts', position: { line: 0, character: 0 }, newName: 'x' })).toEqual({ edits: [] });
  });
});

describe('createPrepareRenameProvider', () => {
  it('sends textDocument/prepareRename and converts to a draft rename location', async () => {
    const { connection, calls } = makeConnection({
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
      placeholder: 'foo'
    });
    const provider = createPrepareRenameProvider(connection);
    const prep = await provider.providePrepareRename({ uri: 'file:///a.ts', position: { line: 0, character: 3 } });
    expect(calls[0]!.method).toBe('textDocument/prepareRename');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 3 } });
    expect(prep).toEqual({ range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 }, placeholder: 'foo' });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createPrepareRenameProvider(connection);
    const controller = new AbortController();
    await provider.providePrepareRename({ uri: 'file:///a.ts', position: { line: 0, character: 0 } }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns null when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createPrepareRenameProvider(connection);
    expect(await provider.providePrepareRename({ uri: 'file:///a.ts', position: { line: 0, character: 0 } })).toBeNull();
  });
});

describe('createCodeActionProvider', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

  it('sends textDocument/codeAction with range and full context (diagnostics/only/triggerKind) and converts', async () => {
    const { connection, calls } = makeConnection([{ title: 'Fix', kind: 'quickfix' }]);
    const provider = createCodeActionProvider(connection);
    const context = { diagnostics: [{ range, message: 'e', severity: 1 }], only: ['quickfix'], triggerKind: 1 };
    const result = await provider.provideCodeActions({ uri: 'file:///a.ts', range, context });
    expect(calls[0]!.method).toBe('textDocument/codeAction');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, range, context });
    expect(result).toEqual({ actions: [{ title: 'Fix', kind: 'quickfix' }] });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createCodeActionProvider(connection);
    const controller = new AbortController();
    await provider.provideCodeActions({ uri: 'file:///a.ts', range, context: { diagnostics: [] } }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns { actions: [] } when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createCodeActionProvider(connection);
    expect(await provider.provideCodeActions({ uri: 'file:///a.ts', range, context: { diagnostics: [] } })).toEqual({
      actions: []
    });
  });
});

describe('createFoldingRangeProvider', () => {
  it('sends textDocument/foldingRange and converts to draft folding ranges', async () => {
    const { connection, calls } = makeConnection([{ startLine: 0, endLine: 3, kind: 'region' }]);
    const provider = createFoldingRangeProvider(connection);
    const ranges = await provider.provideFoldingRanges({ uri: 'file:///a.ts' });
    expect(calls[0]!.method).toBe('textDocument/foldingRange');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(ranges).toEqual([{ start: 1, end: 4, kind: 'region' }]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createFoldingRangeProvider(connection);
    const controller = new AbortController();
    await provider.provideFoldingRanges({ uri: 'file:///a.ts' }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createFoldingRangeProvider(connection);
    expect(await provider.provideFoldingRanges({ uri: 'file:///a.ts' })).toEqual([]);
  });
});

describe('createDocumentLinkProvider', () => {
  it('sends textDocument/documentLink and converts to a Monaco link list', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, target: 'https://x' }
    ]);
    const provider = createDocumentLinkProvider(connection);
    const result = await provider.provideDocumentLinks({ uri: 'file:///a.ts' });
    expect(calls[0]!.method).toBe('textDocument/documentLink');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(result).toEqual({
      links: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }, url: 'https://x' }]
    });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createDocumentLinkProvider(connection);
    const controller = new AbortController();
    await provider.provideDocumentLinks({ uri: 'file:///a.ts' }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns { links: [] } when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentLinkProvider(connection);
    expect(await provider.provideDocumentLinks({ uri: 'file:///a.ts' })).toEqual({ links: [] });
  });
});

describe('createCodeLensProvider', () => {
  it('sends textDocument/codeLens and converts to a Monaco code lens list', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, command: { title: 'Run', command: 'run.it' } }
    ]);
    const provider = createCodeLensProvider(connection);
    const result = await provider.provideCodeLenses({ uri: 'file:///a.ts' });
    expect(calls[0]!.method).toBe('textDocument/codeLens');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(result).toEqual({
      lenses: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, command: { id: 'run.it', title: 'Run' } }]
    });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createCodeLensProvider(connection);
    const controller = new AbortController();
    await provider.provideCodeLenses({ uri: 'file:///a.ts' }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns { lenses: [] } when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createCodeLensProvider(connection);
    expect(await provider.provideCodeLenses({ uri: 'file:///a.ts' })).toEqual({ lenses: [] });
  });
});

describe('createColorProvider', () => {
  const color = { red: 1, green: 0, blue: 0, alpha: 1 };
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } };

  it('provideDocumentColors sends textDocument/documentColor and converts', async () => {
    const { connection, calls } = makeConnection([{ range, color }]);
    const provider = createColorProvider(connection);
    const colors = await provider.provideDocumentColors({ uri: 'file:///a.ts' });
    expect(calls[0]!.method).toBe('textDocument/documentColor');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(colors).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }, color }]);
  });

  it('provideColorPresentations sends color+range and converts', async () => {
    const { connection, calls } = makeConnection([{ label: '#ff0000' }]);
    const provider = createColorProvider(connection);
    const result = await provider.provideColorPresentations({ uri: 'file:///a.ts', color, range });
    expect(calls[0]!.method).toBe('textDocument/colorPresentation');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, color, range });
    expect(result).toEqual([{ label: '#ff0000' }]);
  });

  it('forwards the cancellation signal on both methods', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createColorProvider(connection);
    const c1 = new AbortController();
    await provider.provideDocumentColors({ uri: 'file:///a.ts' }, c1.signal);
    expect(calls[0]!.options).toEqual({ signal: c1.signal });
    const c2 = new AbortController();
    await provider.provideColorPresentations({ uri: 'file:///a.ts', color, range }, c2.signal);
    expect(calls[1]!.options).toEqual({ signal: c2.signal });
  });

  it('returns [] for null on both methods', async () => {
    const { connection } = makeConnection(null);
    const provider = createColorProvider(connection);
    expect(await provider.provideDocumentColors({ uri: 'file:///a.ts' })).toEqual([]);
    expect(await provider.provideColorPresentations({ uri: 'file:///a.ts', color, range })).toEqual([]);
  });
});

describe('createSelectionRangeProvider', () => {
  it('sends textDocument/selectionRange with positions and converts to per-position chains', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } }
    ]);
    const provider = createSelectionRangeProvider(connection);
    const positions = [{ line: 0, character: 2 }];
    const result = await provider.provideSelectionRanges({ uri: 'file:///a.ts', positions });
    expect(calls[0]!.method).toBe('textDocument/selectionRange');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, positions });
    expect(result).toEqual([[{ range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 } }]]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createSelectionRangeProvider(connection);
    const controller = new AbortController();
    await provider.provideSelectionRanges({ uri: 'file:///a.ts', positions: [{ line: 0, character: 0 }] }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createSelectionRangeProvider(connection);
    expect(await provider.provideSelectionRanges({ uri: 'file:///a.ts', positions: [{ line: 0, character: 0 }] })).toEqual([]);
  });
});

describe('createInlayHintProvider', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } };

  it('sends textDocument/inlayHint with range and converts to a draft hint list', async () => {
    const { connection, calls } = makeConnection([{ position: { line: 1, character: 4 }, label: ': number' }]);
    const provider = createInlayHintProvider(connection);
    const result = await provider.provideInlayHints({ uri: 'file:///a.ts', range });
    expect(calls[0]!.method).toBe('textDocument/inlayHint');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, range });
    expect(result).toEqual({ hints: [{ position: { lineNumber: 2, column: 5 }, label: ': number' }] });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createInlayHintProvider(connection);
    const controller = new AbortController();
    await provider.provideInlayHints({ uri: 'file:///a.ts', range }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns { hints: [] } when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createInlayHintProvider(connection);
    expect(await provider.provideInlayHints({ uri: 'file:///a.ts', range })).toEqual({ hints: [] });
  });
});

describe('createDocumentRangeFormattingProvider', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

  it('sends textDocument/rangeFormatting with range and options and converts edits', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: '  ' }
    ]);
    const provider = createDocumentRangeFormattingProvider(connection);
    const edits = await provider.provideDocumentRangeFormatting({
      uri: 'file:///a.ts',
      range,
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(calls[0]!.method).toBe('textDocument/rangeFormatting');
    expect(calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      range,
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, text: '  ' }
    ]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createDocumentRangeFormattingProvider(connection);
    const controller = new AbortController();
    await provider.provideDocumentRangeFormatting(
      { uri: 'file:///a.ts', range, options: { tabSize: 2, insertSpaces: true } },
      controller.signal
    );
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentRangeFormattingProvider(connection);
    expect(
      await provider.provideDocumentRangeFormatting({
        uri: 'file:///a.ts',
        range,
        options: { tabSize: 2, insertSpaces: true }
      })
    ).toEqual([]);
  });
});

describe('createDocumentSemanticTokensProvider', () => {
  it('sends textDocument/semanticTokens/full and converts to Monaco semantic tokens', async () => {
    const { connection, calls } = makeConnection({ resultId: '9', data: [0, 0, 5, 1, 0] });
    const provider = createDocumentSemanticTokensProvider(connection);
    const result = await provider.provideDocumentSemanticTokens({ uri: 'file:///a.ts' });
    expect(calls[0]!.method).toBe('textDocument/semanticTokens/full');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(result).not.toBeNull();
    expect(result!.resultId).toBe('9');
    expect(result!.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result!.data)).toEqual([0, 0, 5, 1, 0]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createDocumentSemanticTokensProvider(connection);
    const controller = new AbortController();
    await provider.provideDocumentSemanticTokens({ uri: 'file:///a.ts' }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns null when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentSemanticTokensProvider(connection);
    expect(await provider.provideDocumentSemanticTokens({ uri: 'file:///a.ts' })).toBeNull();
  });

  it('delta: sends semanticTokens/full/delta with previousResultId and converts an edits delta', async () => {
    const { connection, calls } = makeConnection({ resultId: '2', edits: [{ start: 0, deleteCount: 1, data: [0, 0, 6, 1, 0] }] });
    const provider = createDocumentSemanticTokensProvider(connection);
    const result = await provider.provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1');
    expect(calls[0]!.method).toBe('textDocument/semanticTokens/full/delta');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, previousResultId: '1' });
    expect(result).not.toBeNull();
    expect((result as { resultId?: string }).resultId).toBe('2');
    expect((result as { edits: { data?: Uint32Array }[] }).edits[0]!.data).toBeInstanceOf(Uint32Array);
  });

  it('delta: converts a full SemanticTokens answered from the delta endpoint', async () => {
    const { connection } = makeConnection({ resultId: '3', data: [0, 0, 7, 1, 0] });
    const provider = createDocumentSemanticTokensProvider(connection);
    const result = await provider.provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1');
    expect((result as { data?: Uint32Array }).data).toBeInstanceOf(Uint32Array);
    expect((result as { resultId?: string }).resultId).toBe('3');
  });

  it('delta: returns null when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentSemanticTokensProvider(connection);
    expect(await provider.provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1')).toBeNull();
  });

  it('delta: THROWS on a malformed delta object (no edits, no valid data) instead of returning empty tokens', async () => {
    const { connection } = makeConnection({});
    const provider = createDocumentSemanticTokensProvider(connection);
    await expect(provider.provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1')).rejects.toThrow();
    const bad = makeConnection({ data: 'not-an-array' });
    await expect(
      createDocumentSemanticTokensProvider(bad.connection).provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1')
    ).rejects.toThrow();
  });

  it('delta: THROWS on a malformed edits shape / edit entry instead of mis-converting', async () => {
    const badEdits = makeConnection({ edits: 'bad' });
    await expect(
      createDocumentSemanticTokensProvider(badEdits.connection).provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1')
    ).rejects.toThrow();
    const badEntry = makeConnection({ edits: [{ start: 0 }] }); // missing deleteCount
    await expect(
      createDocumentSemanticTokensProvider(badEntry.connection).provideDocumentSemanticTokensDelta({ uri: 'file:///a.ts' }, '1')
    ).rejects.toThrow();
  });
});

describe('createDocumentRangeSemanticTokensProvider', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } };

  it('sends textDocument/semanticTokens/range with range and converts to Monaco semantic tokens', async () => {
    const { connection, calls } = makeConnection({ resultId: '3', data: [0, 0, 4, 2, 0] });
    const provider = createDocumentRangeSemanticTokensProvider(connection);
    const result = await provider.provideDocumentRangeSemanticTokens({ uri: 'file:///a.ts', range });
    expect(calls[0]!.method).toBe('textDocument/semanticTokens/range');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, range });
    expect(result).not.toBeNull();
    expect(result!.resultId).toBe('3');
    expect(result!.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result!.data)).toEqual([0, 0, 4, 2, 0]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createDocumentRangeSemanticTokensProvider(connection);
    const controller = new AbortController();
    await provider.provideDocumentRangeSemanticTokens({ uri: 'file:///a.ts', range }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns null when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentRangeSemanticTokensProvider(connection);
    expect(await provider.provideDocumentRangeSemanticTokens({ uri: 'file:///a.ts', range })).toBeNull();
  });
});

describe('createLinkedEditingRangeProvider', () => {
  const position = { line: 0, character: 3 };

  it('sends textDocument/linkedEditingRange with position and converts to a draft', async () => {
    const { connection, calls } = makeConnection({
      ranges: [
        { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
        { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } }
      ],
      wordPattern: '[a-z]+'
    });
    const provider = createLinkedEditingRangeProvider(connection);
    const result = await provider.provideLinkedEditingRanges({ uri: 'file:///a.ts', position });
    expect(calls[0]!.method).toBe('textDocument/linkedEditingRange');
    expect(calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position });
    expect(result).toEqual({
      ranges: [
        { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 },
        { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 }
      ],
      wordPattern: '[a-z]+'
    });
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createLinkedEditingRangeProvider(connection);
    const controller = new AbortController();
    await provider.provideLinkedEditingRanges({ uri: 'file:///a.ts', position }, controller.signal);
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns undefined when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createLinkedEditingRangeProvider(connection);
    expect(await provider.provideLinkedEditingRanges({ uri: 'file:///a.ts', position })).toBeUndefined();
  });
});

describe('createDocumentOnTypeFormattingProvider', () => {
  const position = { line: 2, character: 5 };

  it('sends textDocument/onTypeFormatting with position, ch and options and converts edits', async () => {
    const { connection, calls } = makeConnection([
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, newText: '  ' }
    ]);
    const provider = createDocumentOnTypeFormattingProvider(connection);
    const edits = await provider.provideOnTypeFormatting({
      uri: 'file:///a.ts',
      position,
      ch: ';',
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(calls[0]!.method).toBe('textDocument/onTypeFormatting');
    expect(calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position,
      ch: ';',
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).toEqual([
      { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 3 }, text: '  ' }
    ]);
  });

  it('forwards the cancellation signal', async () => {
    const { connection, calls } = makeConnection(null);
    const provider = createDocumentOnTypeFormattingProvider(connection);
    const controller = new AbortController();
    await provider.provideOnTypeFormatting(
      { uri: 'file:///a.ts', position, ch: ';', options: { tabSize: 2, insertSpaces: true } },
      controller.signal
    );
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it('returns [] when the server returns null', async () => {
    const { connection } = makeConnection(null);
    const provider = createDocumentOnTypeFormattingProvider(connection);
    expect(
      await provider.provideOnTypeFormatting({
        uri: 'file:///a.ts',
        position,
        ch: ';',
        options: { tabSize: 2, insertSpaces: true }
      })
    ).toEqual([]);
  });
});
