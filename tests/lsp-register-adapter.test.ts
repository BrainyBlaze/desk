import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLspProviders } from '../src/web/editor/lsp/registerAdapter';
import { createProviderScheduler } from '../src/web/editor/lsp/providerScheduler';
import { toMonacoCompletionList } from '../src/web/editor/lsp/completionConverter';
import { toLspDiagnostics } from '../src/web/editor/lsp/diagnosticsAdapter';
import {
  toMonacoCodeLenses,
  toMonacoColorInformation,
  toMonacoColorPresentations,
  toMonacoDocumentLinks,
  toMonacoDocumentSymbols,
  toMonacoHover,
  toMonacoInlayHints,
  toMonacoLinkedEditingRanges,
  toMonacoSelectionRanges,
  toMonacoSemanticTokens,
  toMonacoSignatureHelp,
  toMonacoTextEdits
} from '../src/web/editor/lsp/resultConverters';

interface ProviderCall {
  selector: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any;
  disposable: { disposed: boolean; dispose(): void };
}

/** Structural fake of monaco.languages: records register* calls per provider kind with tracked disposables. */
function makeLanguages() {
  const makeRecorder = () => {
    const calls: ProviderCall[] = [];
    const register = (selector: unknown, provider: unknown) => {
      const disposable = {
        disposed: false,
        dispose() {
          disposable.disposed = true;
        }
      };
      calls.push({ selector, provider, disposable });
      return disposable;
    };
    return { calls, register };
  };
  const hover = makeRecorder();
  const definition = makeRecorder();
  const typeDefinition = makeRecorder();
  const implementation = makeRecorder();
  const declaration = makeRecorder();
  const reference = makeRecorder();
  const documentHighlight = makeRecorder();
  const documentSymbol = makeRecorder();
  const documentFormatting = makeRecorder();
  const documentRangeFormatting = makeRecorder();
  const onTypeFormatting = makeRecorder();
  const signatureHelp = makeRecorder();
  const selectionRange = makeRecorder();
  const codeLens = makeRecorder();
  const link = makeRecorder();
  const color = makeRecorder();
  const rename = makeRecorder();
  const inlayHints = makeRecorder();
  const linkedEditing = makeRecorder();
  const foldingRange = makeRecorder();
  const completion = makeRecorder();
  const semanticTokens = makeRecorder();
  const rangeSemanticTokens = makeRecorder();
  const codeAction = makeRecorder();
  return {
    hoverCalls: hover.calls,
    definitionCalls: definition.calls,
    typeDefinitionCalls: typeDefinition.calls,
    implementationCalls: implementation.calls,
    declarationCalls: declaration.calls,
    referenceCalls: reference.calls,
    documentHighlightCalls: documentHighlight.calls,
    documentSymbolCalls: documentSymbol.calls,
    documentFormattingCalls: documentFormatting.calls,
    documentRangeFormattingCalls: documentRangeFormatting.calls,
    onTypeFormattingCalls: onTypeFormatting.calls,
    signatureHelpCalls: signatureHelp.calls,
    selectionRangeCalls: selectionRange.calls,
    codeLensCalls: codeLens.calls,
    linkCalls: link.calls,
    colorCalls: color.calls,
    renameCalls: rename.calls,
    inlayHintsCalls: inlayHints.calls,
    linkedEditingCalls: linkedEditing.calls,
    foldingRangeCalls: foldingRange.calls,
    completionCalls: completion.calls,
    semanticTokensCalls: semanticTokens.calls,
    rangeSemanticTokensCalls: rangeSemanticTokens.calls,
    codeActionCalls: codeAction.calls,
    registerHoverProvider: hover.register,
    registerDefinitionProvider: definition.register,
    registerTypeDefinitionProvider: typeDefinition.register,
    registerImplementationProvider: implementation.register,
    registerDeclarationProvider: declaration.register,
    registerReferenceProvider: reference.register,
    registerDocumentHighlightProvider: documentHighlight.register,
    registerDocumentSymbolProvider: documentSymbol.register,
    registerDocumentFormattingEditProvider: documentFormatting.register,
    registerDocumentRangeFormattingEditProvider: documentRangeFormatting.register,
    registerOnTypeFormattingEditProvider: onTypeFormatting.register,
    registerSignatureHelpProvider: signatureHelp.register,
    registerSelectionRangeProvider: selectionRange.register,
    registerCodeLensProvider: codeLens.register,
    registerLinkProvider: link.register,
    registerColorProvider: color.register,
    registerRenameProvider: rename.register,
    registerInlayHintsProvider: inlayHints.register,
    registerLinkedEditingRangeProvider: linkedEditing.register,
    registerFoldingRangeProvider: foldingRange.register,
    registerCompletionItemProvider: completion.register,
    registerDocumentSemanticTokensProvider: semanticTokens.register,
    registerDocumentRangeSemanticTokensProvider: rangeSemanticTokens.register,
    registerCodeActionProvider: codeAction.register
  };
}

/** Fake FoldingRangeKind factory: wraps the string so tests can assert it went through the factory. */
function makeFoldingKindFactory() {
  return (value: string) => ({ value });
}

/** Fake Uri factory: tags the string so tests can assert the output URI was produced through it. */
function makeUriFactory() {
  const inputs: string[] = [];
  const createUri = (value: string) => {
    inputs.push(value);
    return { kind: 'uri' as const, value, toString: () => value };
  };
  return { createUri, inputs };
}

/** Fake connection that resolves every request with a fixed result. */
function makeConnection(result: unknown) {
  const calls: { method: string; params: unknown; options?: { signal?: AbortSignal } }[] = [];
  return {
    calls,
    request(method: string, params: unknown, options?: { signal?: AbortSignal }) {
      calls.push({ method, params, options });
      return Promise.resolve(result);
    }
  };
}

/** Fake connection whose single request stays pending until resolve()/reject() is called. */
function makeDeferredConnection() {
  const calls: { method: string; params: unknown; options?: { signal?: AbortSignal } }[] = [];
  let resolveFn: (value: unknown) => void = () => {};
  let rejectFn: (reason: unknown) => void = () => {};
  return {
    calls,
    resolve: (value: unknown) => resolveFn(value),
    reject: (reason: unknown) => rejectFn(reason),
    request(method: string, params: unknown, options?: { signal?: AbortSignal }) {
      calls.push({ method, params, options });
      return new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    }
  };
}

/** Fake Monaco CancellationToken with an observable registration-disposed flag. */
function makeToken() {
  let listener: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    disposed: false,
    onCancellationRequested(cb: () => void) {
      listener = cb;
      return {
        dispose() {
          token.disposed = true;
          listener = undefined;
        }
      };
    },
    fire() {
      if (listener !== undefined) {
        listener();
      }
    }
  };
  return token;
}

const model = {
  uri: { toString: () => 'file:///a.ts' },
  // Only the completion path uses this; other providers ignore it.
  getWordUntilPosition: () => ({ startColumn: 3, endColumn: 7 }),
  // Only the rename-prepare path uses this.
  getValueInRange: () => 'oldName'
};
const position = { lineNumber: 2, column: 4 };

describe('registerLspProviders', () => {
  it('registers a hover provider when capabilities.hoverProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { hoverProvider: true }, 'typescript');
    expect(languages.hoverCalls).toHaveLength(1);
    expect(languages.hoverCalls[0]!.selector).toBe('typescript');
  });

  it('registers nothing when hoverProvider capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), {}, 'typescript');
    expect(languages.hoverCalls).toHaveLength(0);
  });

  it('provideHover sends textDocument/hover with model.uri.toString() and a 0-based position', async () => {
    const lspHover = {
      contents: { kind: 'markdown', value: 'hi' },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }
    };
    const connection = makeConnection(lspHover);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { hoverProvider: true }, 'typescript');
    const result = await languages.hoverCalls[0]!.provider.provideHover(model, position, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/hover');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 }
    });
    expect(result).toEqual(toMonacoHover(lspHover));
  });

  it('forwards the cancellation AbortSignal to the connection', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { hoverProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.hoverCalls[0]!.provider.provideHover(model, position, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request cancellation bridge after the request resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { hoverProvider: true }, 'typescript');
    const token = makeToken();
    await languages.hoverCalls[0]!.provider.provideHover(model, position, token);
    expect(token.disposed).toBe(true);
  });

  it('disposes the per-request cancellation bridge after the request rejects', async () => {
    const connection = {
      calls: [] as unknown[],
      request() {
        return Promise.reject(new Error('boom'));
      }
    };
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { hoverProvider: true }, 'typescript');
    const token = makeToken();
    await expect(languages.hoverCalls[0]!.provider.provideHover(model, position, token)).rejects.toThrow('boom');
    expect(token.disposed).toBe(true);
  });

  it('composite dispose disposes the hover registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection(null), { hoverProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.hoverCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders position-to-locations', () => {
  it('registers each location provider only when advertised and createUri is supplied', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(
      languages,
      makeConnection([]),
      {
        definitionProvider: true,
        typeDefinitionProvider: true,
        implementationProvider: true,
        declarationProvider: true
      },
      'typescript',
      createUri
    );
    expect(languages.definitionCalls).toHaveLength(1);
    expect(languages.typeDefinitionCalls).toHaveLength(1);
    expect(languages.implementationCalls).toHaveLength(1);
    expect(languages.declarationCalls).toHaveLength(1);
  });

  it('does not register a location provider when its capability is absent', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript', createUri);
    expect(languages.definitionCalls).toHaveLength(0);
  });

  it('does not register location providers when createUri is missing even if advertised', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { definitionProvider: true }, 'typescript');
    expect(languages.definitionCalls).toHaveLength(0);
  });

  it('provideDefinition sends textDocument/definition with string uri and 0-based position and maps output uri through createUri', async () => {
    const server = [
      { uri: 'file:///def.ts', range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } } }
    ];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    const { createUri, inputs } = makeUriFactory();
    registerLspProviders(languages, connection, { definitionProvider: true }, 'typescript', createUri);
    const result = await languages.definitionCalls[0]!.provider.provideDefinition(model, position, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/definition');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 }
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.uri).toEqual({ kind: 'uri', value: 'file:///def.ts', toString: expect.any(Function) });
    expect(result[0]!.range).toEqual({ startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 6 });
    expect(inputs).toContain('file:///def.ts');
  });

  it('maps LocationLink server output (targetUri) through createUri with the flattened target range', async () => {
    const server = [
      {
        targetUri: 'file:///link.ts',
        targetRange: { start: { line: 5, character: 0 }, end: { line: 6, character: 0 } },
        targetSelectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 6 } }
      }
    ];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { definitionProvider: true }, 'typescript', createUri);
    const result = await languages.definitionCalls[0]!.provider.provideDefinition(model, position, makeToken());
    expect(result[0]!.uri.value).toBe('file:///link.ts');
    expect(result[0]!.range).toEqual({ startLineNumber: 6, startColumn: 3, endLineNumber: 6, endColumn: 7 });
  });

  it('forwards the cancellation AbortSignal for a location provider', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { definitionProvider: true }, 'typescript', createUri);
    const token = makeToken();
    const pending = languages.definitionCalls[0]!.provider.provideDefinition(model, position, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after a location request resolves', async () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), { definitionProvider: true }, 'typescript', createUri);
    const token = makeToken();
    await languages.definitionCalls[0]!.provider.provideDefinition(model, position, token);
    expect(token.disposed).toBe(true);
  });

  it('disposes the per-request bridge after a location request rejects', async () => {
    const connection = {
      calls: [] as unknown[],
      request() {
        return Promise.reject(new Error('boom'));
      }
    };
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { definitionProvider: true }, 'typescript', createUri);
    const token = makeToken();
    await expect(
      languages.definitionCalls[0]!.provider.provideDefinition(model, position, token)
    ).rejects.toThrow('boom');
    expect(token.disposed).toBe(true);
  });

  it('composite dispose disposes hover plus all location registrations', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    const registration = registerLspProviders(
      languages,
      makeConnection([]),
      {
        hoverProvider: true,
        definitionProvider: true,
        typeDefinitionProvider: true,
        implementationProvider: true,
        declarationProvider: true
      },
      'typescript',
      createUri
    );
    registration.dispose();
    expect(languages.hoverCalls[0]!.disposable.disposed).toBe(true);
    expect(languages.definitionCalls[0]!.disposable.disposed).toBe(true);
    expect(languages.typeDefinitionCalls[0]!.disposable.disposed).toBe(true);
    expect(languages.implementationCalls[0]!.disposable.disposed).toBe(true);
    expect(languages.declarationCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders references', () => {
  const refContext = { includeDeclaration: true };

  it('registers a references provider when capabilities.referencesProvider is set and createUri is supplied', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), { referencesProvider: true }, 'typescript', createUri);
    expect(languages.referenceCalls).toHaveLength(1);
  });

  it('does not register references when the capability is absent', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript', createUri);
    expect(languages.referenceCalls).toHaveLength(0);
  });

  it('does not register references when createUri is missing even if advertised', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { referencesProvider: true }, 'typescript');
    expect(languages.referenceCalls).toHaveLength(0);
  });

  it('provideReferences sends textDocument/references with string uri, 0-based position, and context.includeDeclaration', async () => {
    const server = [
      { uri: 'file:///ref.ts', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } } }
    ];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    const { createUri, inputs } = makeUriFactory();
    registerLspProviders(languages, connection, { referencesProvider: true }, 'typescript', createUri);
    const result = await languages.referenceCalls[0]!.provider.provideReferences(model, position, refContext, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/references');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 },
      context: { includeDeclaration: true }
    });
    expect(result[0]!.uri).toEqual({ kind: 'uri', value: 'file:///ref.ts', toString: expect.any(Function) });
    expect(result[0]!.range).toEqual({ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 7 });
    expect(inputs).toContain('file:///ref.ts');
  });

  it('passes context.includeDeclaration=false through unchanged', async () => {
    const connection = makeConnection([]);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { referencesProvider: true }, 'typescript', createUri);
    await languages.referenceCalls[0]!.provider.provideReferences(model, position, { includeDeclaration: false }, makeToken());
    expect((connection.calls[0]!.params as { context: unknown }).context).toEqual({ includeDeclaration: false });
  });

  it('forwards the cancellation AbortSignal for references', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { referencesProvider: true }, 'typescript', createUri);
    const token = makeToken();
    const pending = languages.referenceCalls[0]!.provider.provideReferences(model, position, refContext, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after references resolves and after it rejects', async () => {
    const { createUri } = makeUriFactory();

    const resolveLanguages = makeLanguages();
    registerLspProviders(resolveLanguages, makeConnection([]), { referencesProvider: true }, 'typescript', createUri);
    const resolveToken = makeToken();
    await resolveLanguages.referenceCalls[0]!.provider.provideReferences(model, position, refContext, resolveToken);
    expect(resolveToken.disposed).toBe(true);

    const rejecting = {
      request() {
        return Promise.reject(new Error('boom'));
      }
    };
    const rejectLanguages = makeLanguages();
    registerLspProviders(rejectLanguages, rejecting, { referencesProvider: true }, 'typescript', createUri);
    const rejectToken = makeToken();
    await expect(
      rejectLanguages.referenceCalls[0]!.provider.provideReferences(model, position, refContext, rejectToken)
    ).rejects.toThrow('boom');
    expect(rejectToken.disposed).toBe(true);
  });

  it('composite dispose includes the references registration', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    const registration = registerLspProviders(languages, makeConnection([]), { referencesProvider: true }, 'typescript', createUri);
    registration.dispose();
    expect(languages.referenceCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders documentHighlight', () => {
  it('registers a document highlight provider when capabilities.documentHighlightProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentHighlightProvider: true }, 'typescript');
    expect(languages.documentHighlightCalls).toHaveLength(1);
  });

  it('does not register a document highlight provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.documentHighlightCalls).toHaveLength(0);
  });

  it('provideDocumentHighlights sends textDocument/documentHighlight with string uri and 0-based position, preserving range and kind', async () => {
    const server = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, kind: 2 }];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentHighlightProvider: true }, 'typescript');
    const result = await languages.documentHighlightCalls[0]!.provider.provideDocumentHighlights(model, position, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/documentHighlight');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 }
    });
    expect(result).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }, kind: 1 }
    ]);
  });

  it('forwards the cancellation AbortSignal for document highlights', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentHighlightProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.documentHighlightCalls[0]!.provider.provideDocumentHighlights(model, position, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after document highlights resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentHighlightProvider: true }, 'typescript');
    const token = makeToken();
    await languages.documentHighlightCalls[0]!.provider.provideDocumentHighlights(model, position, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the document highlight registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { documentHighlightProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.documentHighlightCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders documentSymbol', () => {
  const serverSymbols = [
    {
      name: 'X',
      kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }
    }
  ];

  it('registers a document symbol provider when capabilities.documentSymbolProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentSymbolProvider: true }, 'typescript');
    expect(languages.documentSymbolCalls).toHaveLength(1);
  });

  it('does not register a document symbol provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.documentSymbolCalls).toHaveLength(0);
  });

  it('provideDocumentSymbols sends textDocument/documentSymbol with string uri and no position field', async () => {
    const connection = makeConnection(serverSymbols);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentSymbolProvider: true }, 'typescript');
    const result = await languages.documentSymbolCalls[0]!.provider.provideDocumentSymbols(model, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/documentSymbol');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual(toMonacoDocumentSymbols(serverSymbols));
  });

  it('forwards the cancellation AbortSignal for document symbols', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentSymbolProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.documentSymbolCalls[0]!.provider.provideDocumentSymbols(model, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after document symbols resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentSymbolProvider: true }, 'typescript');
    const token = makeToken();
    await languages.documentSymbolCalls[0]!.provider.provideDocumentSymbols(model, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the document symbol registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { documentSymbolProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.documentSymbolCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders documentFormatting', () => {
  const options = { tabSize: 2, insertSpaces: true };

  it('registers a document formatting provider when capabilities.documentFormattingProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentFormattingProvider: true }, 'typescript');
    expect(languages.documentFormattingCalls).toHaveLength(1);
  });

  it('does not register a document formatting provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.documentFormattingCalls).toHaveLength(0);
  });

  it('provideDocumentFormattingEdits sends textDocument/formatting with string uri and the passed options and no position field', async () => {
    const server = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: '  ' }];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentFormattingProvider: true }, 'typescript');
    const result = await languages.documentFormattingCalls[0]!.provider.provideDocumentFormattingEdits(model, options, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/formatting');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      options: { tabSize: 2, insertSpaces: true }
    });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual(toMonacoTextEdits(server));
  });

  it('forwards the cancellation AbortSignal for document formatting', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentFormattingProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.documentFormattingCalls[0]!.provider.provideDocumentFormattingEdits(model, options, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after document formatting resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentFormattingProvider: true }, 'typescript');
    const token = makeToken();
    await languages.documentFormattingCalls[0]!.provider.provideDocumentFormattingEdits(model, options, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the document formatting registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { documentFormattingProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.documentFormattingCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders documentRangeFormatting', () => {
  const options = { tabSize: 2, insertSpaces: true };
  const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 5 };

  it('registers a document range formatting provider when capabilities.documentRangeFormattingProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentRangeFormattingProvider: true }, 'typescript');
    expect(languages.documentRangeFormattingCalls).toHaveLength(1);
  });

  it('does not register a document range formatting provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.documentRangeFormattingCalls).toHaveLength(0);
  });

  it('provideDocumentRangeFormattingEdits sends textDocument/rangeFormatting with string uri, converted 0-based range, passed options, and no position field', async () => {
    const server = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: '  ' }];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentRangeFormattingProvider: true }, 'typescript');
    const result = await languages.documentRangeFormattingCalls[0]!.provider.provideDocumentRangeFormattingEdits(
      model,
      monacoRange,
      options,
      makeToken()
    );
    expect(connection.calls[0]!.method).toBe('textDocument/rangeFormatting');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } },
      options: { tabSize: 2, insertSpaces: true }
    });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual(toMonacoTextEdits(server));
  });

  it('forwards the cancellation AbortSignal for document range formatting', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentRangeFormattingProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.documentRangeFormattingCalls[0]!.provider.provideDocumentRangeFormattingEdits(
      model,
      monacoRange,
      options,
      token
    );
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after document range formatting resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentRangeFormattingProvider: true }, 'typescript');
    const token = makeToken();
    await languages.documentRangeFormattingCalls[0]!.provider.provideDocumentRangeFormattingEdits(model, monacoRange, options, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the document range formatting registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { documentRangeFormattingProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.documentRangeFormattingCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders onTypeFormatting', () => {
  const options = { tabSize: 2, insertSpaces: true };
  const onTypeCap = { firstTriggerCharacter: ';', moreTriggerCharacter: ['}', '\n'] };

  it('registers an on-type formatting provider when capabilities.documentOnTypeFormattingProvider is present', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentOnTypeFormattingProvider: onTypeCap }, 'typescript');
    expect(languages.onTypeFormattingCalls).toHaveLength(1);
  });

  it('does not register an on-type formatting provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.onTypeFormattingCalls).toHaveLength(0);
  });

  it('builds autoFormatTriggerCharacters from firstTriggerCharacter plus moreTriggerCharacter', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentOnTypeFormattingProvider: onTypeCap }, 'typescript');
    expect(languages.onTypeFormattingCalls[0]!.provider.autoFormatTriggerCharacters).toEqual([';', '}', '\n']);
  });

  it('builds autoFormatTriggerCharacters from firstTriggerCharacter alone when moreTriggerCharacter is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentOnTypeFormattingProvider: { firstTriggerCharacter: ';' } }, 'typescript');
    expect(languages.onTypeFormattingCalls[0]!.provider.autoFormatTriggerCharacters).toEqual([';']);
  });

  it('provideOnTypeFormattingEdits sends textDocument/onTypeFormatting with string uri, 0-based position, ch and options', async () => {
    const server = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: '  ' }];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentOnTypeFormattingProvider: onTypeCap }, 'typescript');
    const result = await languages.onTypeFormattingCalls[0]!.provider.provideOnTypeFormattingEdits(model, position, ';', options, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/onTypeFormatting');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 },
      ch: ';',
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(result).toEqual(toMonacoTextEdits(server));
  });

  it('forwards the cancellation AbortSignal for on-type formatting', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentOnTypeFormattingProvider: onTypeCap }, 'typescript');
    const token = makeToken();
    const pending = languages.onTypeFormattingCalls[0]!.provider.provideOnTypeFormattingEdits(model, position, ';', options, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after on-type formatting resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentOnTypeFormattingProvider: onTypeCap }, 'typescript');
    const token = makeToken();
    await languages.onTypeFormattingCalls[0]!.provider.provideOnTypeFormattingEdits(model, position, ';', options, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the on-type formatting registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { documentOnTypeFormattingProvider: onTypeCap }, 'typescript');
    registration.dispose();
    expect(languages.onTypeFormattingCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders signatureHelp', () => {
  const sigCap = { triggerCharacters: ['(', ','], retriggerCharacters: [')'] };
  const monacoContext = { triggerKind: 2, triggerCharacter: '(', isRetrigger: false, activeSignatureHelp: { signatures: [] } };
  const serverHelp = { signatures: [{ label: 'f(a)' }], activeSignature: 0, activeParameter: 0 };

  it('registers a signature help provider when capabilities.signatureHelpProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { signatureHelpProvider: sigCap }, 'typescript');
    expect(languages.signatureHelpCalls).toHaveLength(1);
  });

  it('does not register a signature help provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), {}, 'typescript');
    expect(languages.signatureHelpCalls).toHaveLength(0);
  });

  it('builds trigger and retrigger characters from capabilities', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { signatureHelpProvider: sigCap }, 'typescript');
    const provider = languages.signatureHelpCalls[0]!.provider;
    expect(provider.signatureHelpTriggerCharacters).toEqual(['(', ',']);
    expect(provider.signatureHelpRetriggerCharacters).toEqual([')']);
  });

  it('defaults trigger and retrigger characters to empty arrays when absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { signatureHelpProvider: {} }, 'typescript');
    const provider = languages.signatureHelpCalls[0]!.provider;
    expect(provider.signatureHelpTriggerCharacters).toEqual([]);
    expect(provider.signatureHelpRetriggerCharacters).toEqual([]);
  });

  it('sends textDocument/signatureHelp with string uri, 0-based position, and mapped context without activeSignatureHelp (token before context)', async () => {
    const connection = makeConnection(serverHelp);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { signatureHelpProvider: sigCap }, 'typescript');
    const result = await languages.signatureHelpCalls[0]!.provider.provideSignatureHelp(model, position, makeToken(), monacoContext);
    expect(connection.calls[0]!.method).toBe('textDocument/signatureHelp');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 },
      context: { triggerKind: 2, triggerCharacter: '(', isRetrigger: false }
    });
    expect(result).toEqual({ value: toMonacoSignatureHelp(serverHelp), dispose: expect.any(Function) });
  });

  it('returns null when the server returns null', async () => {
    const connection = makeConnection(null);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { signatureHelpProvider: sigCap }, 'typescript');
    const result = await languages.signatureHelpCalls[0]!.provider.provideSignatureHelp(model, position, makeToken(), monacoContext);
    expect(result).toBeNull();
  });

  it('forwards the cancellation AbortSignal for signature help', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { signatureHelpProvider: sigCap }, 'typescript');
    const token = makeToken();
    const pending = languages.signatureHelpCalls[0]!.provider.provideSignatureHelp(model, position, token, monacoContext);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after signature help resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { signatureHelpProvider: sigCap }, 'typescript');
    const token = makeToken();
    await languages.signatureHelpCalls[0]!.provider.provideSignatureHelp(model, position, token, monacoContext);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the signature help registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection(null), { signatureHelpProvider: sigCap }, 'typescript');
    registration.dispose();
    expect(languages.signatureHelpCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders selectionRange', () => {
  const positions = [
    { lineNumber: 1, column: 2 },
    { lineNumber: 3, column: 5 }
  ];
  const serverRanges = [
    { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } },
    { range: { start: { line: 2, character: 1 }, end: { line: 2, character: 6 } } }
  ];

  it('registers a selection range provider when capabilities.selectionRangeProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { selectionRangeProvider: true }, 'typescript');
    expect(languages.selectionRangeCalls).toHaveLength(1);
  });

  it('does not register a selection range provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.selectionRangeCalls).toHaveLength(0);
  });

  it('sends textDocument/selectionRange with string uri and every converted 0-based position', async () => {
    const connection = makeConnection(serverRanges);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { selectionRangeProvider: true }, 'typescript');
    const result = await languages.selectionRangeCalls[0]!.provider.provideSelectionRanges(model, positions, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/selectionRange');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      positions: [
        { line: 0, character: 1 },
        { line: 2, character: 4 }
      ]
    });
    expect(result).toEqual(toMonacoSelectionRanges(serverRanges));
  });

  it('forwards the cancellation AbortSignal for selection ranges', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { selectionRangeProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.selectionRangeCalls[0]!.provider.provideSelectionRanges(model, positions, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after selection ranges resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { selectionRangeProvider: true }, 'typescript');
    const token = makeToken();
    await languages.selectionRangeCalls[0]!.provider.provideSelectionRanges(model, positions, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the selection range registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { selectionRangeProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.selectionRangeCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders codeLens', () => {
  const serverLenses = [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, command: { title: 'Run', command: 'run' } }
  ];

  it('registers a code lens provider when capabilities.codeLensProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { codeLensProvider: true }, 'typescript');
    expect(languages.codeLensCalls).toHaveLength(1);
  });

  it('does not register a code lens provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.codeLensCalls).toHaveLength(0);
  });

  it('provideCodeLenses sends textDocument/codeLens with string uri and no position field', async () => {
    const connection = makeConnection(serverLenses);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { codeLensProvider: true }, 'typescript');
    const result = await languages.codeLensCalls[0]!.provider.provideCodeLenses(model, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/codeLens');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual(toMonacoCodeLenses(serverLenses));
  });

  it('forwards the cancellation AbortSignal for code lenses', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { codeLensProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.codeLensCalls[0]!.provider.provideCodeLenses(model, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after code lenses resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { codeLensProvider: true }, 'typescript');
    const token = makeToken();
    await languages.codeLensCalls[0]!.provider.provideCodeLenses(model, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the code lens registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { codeLensProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.codeLensCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders documentLink', () => {
  const serverLinks = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, target: 'https://example.test' }];

  it('registers a link provider via registerLinkProvider when capabilities.documentLinkProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentLinkProvider: true }, 'typescript');
    expect(languages.linkCalls).toHaveLength(1);
    expect(typeof languages.linkCalls[0]!.provider.provideLinks).toBe('function');
  });

  it('does not register a link provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.linkCalls).toHaveLength(0);
  });

  it('provideLinks sends textDocument/documentLink with string uri and no position field', async () => {
    const connection = makeConnection(serverLinks);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentLinkProvider: true }, 'typescript');
    const result = await languages.linkCalls[0]!.provider.provideLinks(model, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/documentLink');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual(toMonacoDocumentLinks(serverLinks));
  });

  it('forwards the cancellation AbortSignal for links', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { documentLinkProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.linkCalls[0]!.provider.provideLinks(model, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after links resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { documentLinkProvider: true }, 'typescript');
    const token = makeToken();
    await languages.linkCalls[0]!.provider.provideLinks(model, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the link registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { documentLinkProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.linkCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders color', () => {
  const serverColors = [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, color: { red: 1, green: 0, blue: 0, alpha: 1 } }
  ];
  const serverPresentations = [{ label: '#f00' }];
  const colorInfo = {
    color: { red: 1, green: 0, blue: 0, alpha: 1 },
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }
  };

  it('registers a color provider with both methods when capabilities.colorProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { colorProvider: true }, 'typescript');
    expect(languages.colorCalls).toHaveLength(1);
    expect(typeof languages.colorCalls[0]!.provider.provideDocumentColors).toBe('function');
    expect(typeof languages.colorCalls[0]!.provider.provideColorPresentations).toBe('function');
  });

  it('does not register a color provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.colorCalls).toHaveLength(0);
  });

  it('provideDocumentColors sends textDocument/documentColor with string uri and no position field', async () => {
    const connection = makeConnection(serverColors);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { colorProvider: true }, 'typescript');
    const result = await languages.colorCalls[0]!.provider.provideDocumentColors(model, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/documentColor');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual(toMonacoColorInformation(serverColors));
  });

  it('provideColorPresentations sends textDocument/colorPresentation with string uri, unchanged color, and converted 0-based range', async () => {
    const connection = makeConnection(serverPresentations);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { colorProvider: true }, 'typescript');
    const result = await languages.colorCalls[0]!.provider.provideColorPresentations(model, colorInfo, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/colorPresentation');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      color: { red: 1, green: 0, blue: 0, alpha: 1 },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
    });
    expect(result).toEqual(toMonacoColorPresentations(serverPresentations));
  });

  it('forwards the cancellation AbortSignal for provideDocumentColors', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { colorProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.colorCalls[0]!.provider.provideDocumentColors(model, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('forwards the cancellation AbortSignal for provideColorPresentations', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { colorProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.colorCalls[0]!.provider.provideColorPresentations(model, colorInfo, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after provideDocumentColors resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { colorProvider: true }, 'typescript');
    const token = makeToken();
    await languages.colorCalls[0]!.provider.provideDocumentColors(model, token);
    expect(token.disposed).toBe(true);
  });

  it('disposes the per-request bridge after provideColorPresentations resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { colorProvider: true }, 'typescript');
    const token = makeToken();
    await languages.colorCalls[0]!.provider.provideColorPresentations(model, colorInfo, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the color registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { colorProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.colorCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders rename', () => {
  const changesEdit = { changes: { 'file:///b.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'X' }] } };
  const docChangesEdit = {
    documentChanges: [
      {
        textDocument: { uri: 'file:///b.ts', version: 7 },
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'X' }]
      }
    ]
  };
  const expectedTextEdit = { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'X' };

  it('registers a rename provider when capabilities.renameProvider is set and createUri is supplied', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection(null), { renameProvider: true }, 'typescript', createUri);
    expect(languages.renameCalls).toHaveLength(1);
  });

  it('does not register a rename provider when the capability is absent', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection(null), {}, 'typescript', createUri);
    expect(languages.renameCalls).toHaveLength(0);
  });

  it('does not register a rename provider when createUri is missing even if advertised', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { renameProvider: true }, 'typescript');
    expect(languages.renameCalls).toHaveLength(0);
  });

  it('provideRenameEdits sends textDocument/rename with string uri, 0-based position, and newName', async () => {
    const connection = makeConnection(changesEdit);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: true }, 'typescript', createUri);
    await languages.renameCalls[0]!.provider.provideRenameEdits(model, position, 'newName', makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/rename');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 },
      newName: 'newName'
    });
  });

  it('maps changes output resources through createUri and preserves the text edit', async () => {
    const connection = makeConnection(changesEdit);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: true }, 'typescript', createUri);
    const result = await languages.renameCalls[0]!.provider.provideRenameEdits(model, position, 'X', makeToken());
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]!.resource).toEqual({ kind: 'uri', value: 'file:///b.ts', toString: expect.any(Function) });
    expect(result.edits[0]!.textEdit).toEqual(expectedTextEdit);
    // versionId key is always present (undefined when the server gave no version) to match Monaco's IWorkspaceTextEdit.
    expect(result.edits[0]!.versionId).toBeUndefined();
  });

  it('preserves versionId from documentChanges after mapping the resource through createUri', async () => {
    const connection = makeConnection(docChangesEdit);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: true }, 'typescript', createUri);
    const result = await languages.renameCalls[0]!.provider.provideRenameEdits(model, position, 'X', makeToken());
    expect(result.edits[0]!.resource.value).toBe('file:///b.ts');
    expect(result.edits[0]!.textEdit).toEqual(expectedTextEdit);
    expect(result.edits[0]!.versionId).toBe(7);
  });

  it('forwards the cancellation AbortSignal for rename', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: true }, 'typescript', createUri);
    const token = makeToken();
    const pending = languages.renameCalls[0]!.provider.provideRenameEdits(model, position, 'X', token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after rename resolves', async () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection(null), { renameProvider: true }, 'typescript', createUri);
    const token = makeToken();
    await languages.renameCalls[0]!.provider.provideRenameEdits(model, position, 'X', token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the rename registration', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    const registration = registerLspProviders(languages, makeConnection(null), { renameProvider: true }, 'typescript', createUri);
    registration.dispose();
    expect(languages.renameCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders rename prepare (resolveRenameLocation)', () => {
  const prepareWithPlaceholder = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, placeholder: 'suggested' };
  const prepareEmptyPlaceholder = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, placeholder: '' };
  const prepareBareRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
  const expectedRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };

  it('exposes resolveRenameLocation only when capabilities.renameProvider.prepareProvider is truthy', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection(null), { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    expect(typeof languages.renameCalls[0]!.provider.resolveRenameLocation).toBe('function');
  });

  it('leaves resolveRenameLocation undefined when prepareProvider is absent, with provideRenameEdits still present', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection(null), { renameProvider: true }, 'typescript', createUri);
    expect(languages.renameCalls[0]!.provider.resolveRenameLocation).toBeUndefined();
    expect(typeof languages.renameCalls[0]!.provider.provideRenameEdits).toBe('function');
  });

  it('resolveRenameLocation sends textDocument/prepareRename with string uri and 0-based position; placeholder takes precedence', async () => {
    const connection = makeConnection(prepareWithPlaceholder);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    const result = await languages.renameCalls[0]!.provider.resolveRenameLocation(model, position, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/prepareRename');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, position: { line: 1, character: 3 } });
    expect(result).toEqual({ range: expectedRange, text: 'suggested' });
  });

  it('preserves an empty-string placeholder rather than falling back to model text', async () => {
    const connection = makeConnection(prepareEmptyPlaceholder);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    const result = await languages.renameCalls[0]!.provider.resolveRenameLocation(model, position, makeToken());
    expect(result).toEqual({ range: expectedRange, text: '' });
  });

  it('falls back to model.getValueInRange when the draft has no placeholder', async () => {
    const connection = makeConnection(prepareBareRange);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    const result = await languages.renameCalls[0]!.provider.resolveRenameLocation(model, position, makeToken());
    expect(result).toEqual({ range: expectedRange, text: 'oldName' });
  });

  it('returns null for a null/defaultBehavior draft', async () => {
    const nullConn = makeConnection(null);
    const nullLanguages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(nullLanguages, nullConn, { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    expect(await nullLanguages.renameCalls[0]!.provider.resolveRenameLocation(model, position, makeToken())).toBeNull();

    const defConn = makeConnection({ defaultBehavior: true });
    const defLanguages = makeLanguages();
    registerLspProviders(defLanguages, defConn, { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    expect(await defLanguages.renameCalls[0]!.provider.resolveRenameLocation(model, position, makeToken())).toBeNull();
  });

  it('forwards the cancellation AbortSignal for resolveRenameLocation', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    const token = makeToken();
    const pending = languages.renameCalls[0]!.provider.resolveRenameLocation(model, position, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after resolveRenameLocation resolves', async () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection(prepareBareRange), { renameProvider: { prepareProvider: true } }, 'typescript', createUri);
    const token = makeToken();
    await languages.renameCalls[0]!.provider.resolveRenameLocation(model, position, token);
    expect(token.disposed).toBe(true);
  });
});

describe('registerLspProviders inlayHint', () => {
  const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 11, endColumn: 1 };
  const serverHints = [{ position: { line: 1, character: 4 }, label: ': number' }];

  it('registers an inlay hints provider when capabilities.inlayHintProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { inlayHintProvider: true }, 'typescript');
    expect(languages.inlayHintsCalls).toHaveLength(1);
  });

  it('does not register an inlay hints provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript');
    expect(languages.inlayHintsCalls).toHaveLength(0);
  });

  it('provideInlayHints sends textDocument/inlayHint with string uri and converted 0-based range, and returns hints plus a callable dispose', async () => {
    const connection = makeConnection(serverHints);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { inlayHintProvider: true }, 'typescript');
    const result = await languages.inlayHintsCalls[0]!.provider.provideInlayHints(model, monacoRange, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/inlayHint');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }
    });
    expect(result.hints).toEqual(toMonacoInlayHints(serverHints).hints);
    expect(typeof result.dispose).toBe('function');
  });

  it('forwards the cancellation AbortSignal for inlay hints', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { inlayHintProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.inlayHintsCalls[0]!.provider.provideInlayHints(model, monacoRange, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after inlay hints resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { inlayHintProvider: true }, 'typescript');
    const token = makeToken();
    await languages.inlayHintsCalls[0]!.provider.provideInlayHints(model, monacoRange, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the inlay hints registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { inlayHintProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.inlayHintsCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders linkedEditing', () => {
  const serverValid = {
    ranges: [
      { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
      { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } }
    ],
    wordPattern: '[a-z]+'
  };
  const serverInvalid = { ranges: [{ start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }], wordPattern: '(' };

  it('registers a linked editing range provider when capabilities.linkedEditingRangeProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { linkedEditingRangeProvider: true }, 'typescript');
    expect(languages.linkedEditingCalls).toHaveLength(1);
  });

  it('does not register a linked editing range provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), {}, 'typescript');
    expect(languages.linkedEditingCalls).toHaveLength(0);
  });

  it('provideLinkedEditingRanges sends textDocument/linkedEditingRange with string uri and 0-based position, compiling a valid wordPattern to RegExp', async () => {
    const connection = makeConnection(serverValid);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { linkedEditingRangeProvider: true }, 'typescript');
    const result = await languages.linkedEditingCalls[0]!.provider.provideLinkedEditingRanges(model, position, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/linkedEditingRange');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 }
    });
    expect(result.ranges).toEqual(toMonacoLinkedEditingRanges(serverValid)!.ranges);
    expect(result.wordPattern).toBeInstanceOf(RegExp);
    expect(result.wordPattern.source).toBe('[a-z]+');
  });

  it('returns null when the server returns null', async () => {
    const connection = makeConnection(null);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { linkedEditingRangeProvider: true }, 'typescript');
    const result = await languages.linkedEditingCalls[0]!.provider.provideLinkedEditingRanges(model, position, makeToken());
    expect(result).toBeNull();
  });

  it('omits wordPattern (preserving ranges) when the server pattern is an invalid RegExp', async () => {
    const connection = makeConnection(serverInvalid);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { linkedEditingRangeProvider: true }, 'typescript');
    const result = await languages.linkedEditingCalls[0]!.provider.provideLinkedEditingRanges(model, position, makeToken());
    expect(result.ranges).toEqual(toMonacoLinkedEditingRanges(serverInvalid)!.ranges);
    expect('wordPattern' in result).toBe(false);
  });

  it('forwards the cancellation AbortSignal for linked editing ranges', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { linkedEditingRangeProvider: true }, 'typescript');
    const token = makeToken();
    const pending = languages.linkedEditingCalls[0]!.provider.provideLinkedEditingRanges(model, position, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after linked editing ranges resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { linkedEditingRangeProvider: true }, 'typescript');
    const token = makeToken();
    await languages.linkedEditingCalls[0]!.provider.provideLinkedEditingRanges(model, position, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the linked editing range registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection(null), { linkedEditingRangeProvider: true }, 'typescript');
    registration.dispose();
    expect(languages.linkedEditingCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders foldingRange', () => {
  const serverRanges = [
    { startLine: 0, endLine: 2, kind: 'comment' },
    { startLine: 4, endLine: 6 }
  ];

  it('registers a folding range provider when capabilities.foldingRangeProvider is set and createFoldingRangeKind is supplied', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), { foldingRangeProvider: true }, 'typescript', createUri, makeFoldingKindFactory());
    expect(languages.foldingRangeCalls).toHaveLength(1);
  });

  it('does not register a folding range provider when the capability is absent', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript', createUri, makeFoldingKindFactory());
    expect(languages.foldingRangeCalls).toHaveLength(0);
  });

  it('does not register a folding range provider when createFoldingRangeKind is missing', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), { foldingRangeProvider: true }, 'typescript', createUri);
    expect(languages.foldingRangeCalls).toHaveLength(0);
  });

  it('registers folding range when createUri is omitted and createFoldingRangeKind is supplied (no createUri coupling)', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { foldingRangeProvider: true }, 'typescript', undefined, makeFoldingKindFactory());
    expect(languages.foldingRangeCalls).toHaveLength(1);
  });

  it('provideFoldingRanges sends textDocument/foldingRange with string uri and no position, preserving start/end and mapping kind through the factory', async () => {
    const connection = makeConnection(serverRanges);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { foldingRangeProvider: true }, 'typescript', createUri, makeFoldingKindFactory());
    const result = await languages.foldingRangeCalls[0]!.provider.provideFoldingRanges(model, {}, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/foldingRange');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).toEqual([
      { start: 1, end: 3, kind: { value: 'comment' } },
      { start: 5, end: 7 }
    ]);
    expect('kind' in result[1]!).toBe(false);
  });

  it('forwards the cancellation AbortSignal for folding ranges', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { foldingRangeProvider: true }, 'typescript', undefined, makeFoldingKindFactory());
    const token = makeToken();
    const pending = languages.foldingRangeCalls[0]!.provider.provideFoldingRanges(model, {}, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after folding ranges resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { foldingRangeProvider: true }, 'typescript', undefined, makeFoldingKindFactory());
    const token = makeToken();
    await languages.foldingRangeCalls[0]!.provider.provideFoldingRanges(model, {}, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the folding range registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection([]), { foldingRangeProvider: true }, 'typescript', undefined, makeFoldingKindFactory());
    registration.dispose();
    expect(languages.foldingRangeCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders completion', () => {
  const serverList = { isIncomplete: true, items: [{ label: 'foo', kind: 3 }, { label: 'bar', kind: 6 }] };
  const monacoContext = { triggerKind: 1, triggerCharacter: '.' };
  const expectedRange = { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 7 };

  it('registers a completion provider when capabilities.completionProvider is set', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { completionProvider: { triggerCharacters: ['.', '>'] } }, 'typescript');
    expect(languages.completionCalls).toHaveLength(1);
  });

  it('does not register a completion provider when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), {}, 'typescript');
    expect(languages.completionCalls).toHaveLength(0);
  });

  it('exposes triggerCharacters from capabilities, defaulting to an empty array', () => {
    const withChars = makeLanguages();
    registerLspProviders(withChars, makeConnection(null), { completionProvider: { triggerCharacters: ['.', '>'] } }, 'typescript');
    expect(withChars.completionCalls[0]!.provider.triggerCharacters).toEqual(['.', '>']);

    const withoutChars = makeLanguages();
    registerLspProviders(withoutChars, makeConnection(null), { completionProvider: {} }, 'typescript');
    expect(withoutChars.completionCalls[0]!.provider.triggerCharacters).toEqual([]);
  });

  it('sends textDocument/completion with string uri, 0-based position, and mapped context (triggerKind+1, triggerCharacter passthrough); arg order model, position, context, token', async () => {
    const connection = makeConnection(serverList);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { completionProvider: {} }, 'typescript');
    await languages.completionCalls[0]!.provider.provideCompletionItems(model, position, monacoContext, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/completion');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      position: { line: 1, character: 3 },
      context: { triggerKind: 2, triggerCharacter: '.' }
    });
  });

  it('injects the model word range into every returned suggestion and preserves incomplete', async () => {
    const connection = makeConnection(serverList);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { completionProvider: {} }, 'typescript');
    const result = await languages.completionCalls[0]!.provider.provideCompletionItems(model, position, monacoContext, makeToken());
    const expectedSuggestions = toMonacoCompletionList(serverList).suggestions.map((s) => ({ ...s, range: expectedRange }));
    expect(result.suggestions).toEqual(expectedSuggestions);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.every((s: { range: unknown }) => JSON.stringify(s.range) === JSON.stringify(expectedRange))).toBe(true);
    expect(result.incomplete).toBe(true);
  });

  it('forwards the cancellation AbortSignal for completion', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { completionProvider: {} }, 'typescript');
    const token = makeToken();
    const pending = languages.completionCalls[0]!.provider.provideCompletionItems(model, position, monacoContext, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after completion resolves', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { completionProvider: {} }, 'typescript');
    const token = makeToken();
    await languages.completionCalls[0]!.provider.provideCompletionItems(model, position, monacoContext, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the completion registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection(null), { completionProvider: {} }, 'typescript');
    registration.dispose();
    expect(languages.completionCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders semanticTokens (full document)', () => {
  const legend = { tokenTypes: ['keyword', 'variable'], tokenModifiers: ['declaration'] };
  const serverTokens = { resultId: '1', data: [0, 0, 5, 1, 0] };

  it('registers a document semantic tokens provider when capabilities.semanticTokensProvider has a legend', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend } }, 'typescript');
    expect(languages.semanticTokensCalls).toHaveLength(1);
  });

  it('does not register when the capability is absent', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), {}, 'typescript');
    expect(languages.semanticTokensCalls).toHaveLength(0);
  });

  it('does not register when the legend is missing', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: {} }, 'typescript');
    expect(languages.semanticTokensCalls).toHaveLength(0);
  });

  it('getLegend returns the exact capability tokenTypes and tokenModifiers', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend } }, 'typescript');
    expect(languages.semanticTokensCalls[0]!.provider.getLegend()).toEqual({
      tokenTypes: ['keyword', 'variable'],
      tokenModifiers: ['declaration']
    });
  });

  it('provideDocumentSemanticTokens sends textDocument/semanticTokens/full with string uri, no position, and no lastResultId; returns Uint32Array data', async () => {
    const connection = makeConnection(serverTokens);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { semanticTokensProvider: { legend } }, 'typescript');
    const result = await languages.semanticTokensCalls[0]!.provider.provideDocumentSemanticTokens(model, null, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/semanticTokens/full');
    expect(connection.calls[0]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect('lastResultId' in (connection.calls[0]!.params as object)).toBe(false);
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).not.toBeNull();
    expect(result.resultId).toBe('1');
    expect(result.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result.data)).toEqual([0, 0, 5, 1, 0]);
    expect(result).toEqual(toMonacoSemanticTokens(serverTokens));
  });

  it('exposes a callable noop releaseDocumentSemanticTokens', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend } }, 'typescript');
    expect(typeof languages.semanticTokensCalls[0]!.provider.releaseDocumentSemanticTokens).toBe('function');
    expect(() => languages.semanticTokensCalls[0]!.provider.releaseDocumentSemanticTokens('1')).not.toThrow();
  });

  it('forwards the cancellation AbortSignal for semantic tokens', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { semanticTokensProvider: { legend } }, 'typescript');
    const token = makeToken();
    const pending = languages.semanticTokensCalls[0]!.provider.provideDocumentSemanticTokens(model, null, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after semantic tokens resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend } }, 'typescript');
    const token = makeToken();
    await languages.semanticTokensCalls[0]!.provider.provideDocumentSemanticTokens(model, null, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the semantic tokens registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend } }, 'typescript');
    registration.dispose();
    expect(languages.semanticTokensCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders semanticTokens (full/delta)', () => {
  const legend = { tokenTypes: ['keyword', 'variable'], tokenModifiers: ['declaration'] };
  const deltaCap = { semanticTokensProvider: { legend, full: { delta: true } } };
  const fullTokens = { resultId: '1', data: [0, 0, 5, 1, 0] };
  const deltaResult = { resultId: '2', edits: [{ start: 0, deleteCount: 1, data: [0, 0, 6, 1, 0] }] };

  /** Connection whose result/throw is decided per request by a handler. */
  function makeFnConnection(handler: (method: string, params: unknown) => unknown) {
    const calls: { method: string; params: unknown; options?: { signal?: AbortSignal } }[] = [];
    return {
      calls,
      request(method: string, params: unknown, options?: { signal?: AbortSignal }) {
        calls.push({ method, params, options });
        return Promise.resolve().then(() => handler(method, params));
      }
    };
  }
  const byMethod = (map: Record<string, unknown>) => (method: string) => map[method];

  it('a non-delta server (full:true) ignores lastResultId and only ever requests full, never delta', async () => {
    const connection = makeFnConnection(byMethod({ 'textDocument/semanticTokens/full': fullTokens }));
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { semanticTokensProvider: { legend, full: true } }, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls.every((c) => c.method === 'textDocument/semanticTokens/full')).toBe(true);
  });

  it('first full request uses semanticTokens/full; a matching previousResultId then uses full/delta with exact params', async () => {
    const connection = makeFnConnection(byMethod({
      'textDocument/semanticTokens/full': fullTokens,
      'textDocument/semanticTokens/full/delta': deltaResult
    }));
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    const full = await provider.provideDocumentSemanticTokens(model, null, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/semanticTokens/full');
    expect(full.resultId).toBe('1');
    const edits = await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[1]!.method).toBe('textDocument/semanticTokens/full/delta');
    expect(connection.calls[1]!.params).toEqual({ textDocument: { uri: 'file:///a.ts' }, previousResultId: '1' });
    expect(edits.resultId).toBe('2');
    expect(edits.edits[0].data).toBeInstanceOf(Uint32Array);
  });

  it('falls back to full when previousResultId does not match the cached id', async () => {
    const connection = makeFnConnection(byMethod({ 'textDocument/semanticTokens/full': fullTokens }));
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken()); // caches '1'
    const result = await provider.provideDocumentSemanticTokens(model, 'stale', makeToken());
    expect(connection.calls[1]!.method).toBe('textDocument/semanticTokens/full');
    expect(result.resultId).toBe('1');
  });

  it('falls back to full after the resultId is released', async () => {
    const connection = makeFnConnection(byMethod({
      'textDocument/semanticTokens/full': fullTokens,
      'textDocument/semanticTokens/full/delta': deltaResult
    }));
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    provider.releaseDocumentSemanticTokens('1');
    await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[1]!.method).toBe('textDocument/semanticTokens/full');
  });

  it('returns full tokens when the delta endpoint answers with a full SemanticTokens', async () => {
    const connection = makeFnConnection(byMethod({
      'textDocument/semanticTokens/full': fullTokens,
      'textDocument/semanticTokens/full/delta': { resultId: '9', data: [0, 0, 7, 1, 0] }
    }));
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    const result = await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(result.data).toBeInstanceOf(Uint32Array);
    expect(result.resultId).toBe('9');
  });

  it('clears the cache when the delta endpoint returns null (next edits goes full)', async () => {
    const connection = makeFnConnection(byMethod({
      'textDocument/semanticTokens/full': fullTokens,
      'textDocument/semanticTokens/full/delta': null
    }));
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    expect(await provider.provideDocumentSemanticTokens(model, '1', makeToken())).toBeNull();
    await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[2]!.method).toBe('textDocument/semanticTokens/full');
  });

  it('on a non-cancel delta error clears the cache and retries exactly one full request', async () => {
    const connection = makeFnConnection((method) => {
      if (method === 'textDocument/semanticTokens/full/delta') { throw new Error('delta boom'); }
      return fullTokens;
    });
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    const result = await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[1]!.method).toBe('textDocument/semanticTokens/full/delta');
    expect(connection.calls[2]!.method).toBe('textDocument/semanticTokens/full');
    expect(connection.calls).toHaveLength(3);
    expect(result.resultId).toBe('1');
  });

  it('on a malformed delta RESPONSE object clears the cache and retries exactly one full request', async () => {
    const connection = makeFnConnection((method) => {
      if (method === 'textDocument/semanticTokens/full/delta') { return {}; } // malformed: no edits, no data
      return fullTokens;
    });
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    const result = await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[1]!.method).toBe('textDocument/semanticTokens/full/delta');
    expect(connection.calls[2]!.method).toBe('textDocument/semanticTokens/full'); // one full retry
    expect(connection.calls).toHaveLength(3);
    expect(result.resultId).toBe('1');
  });

  it('on a malformed delta edit entry clears the cache and retries exactly one full request', async () => {
    const connection = makeFnConnection((method) => {
      if (method === 'textDocument/semanticTokens/full/delta') { return { edits: [{ start: 0 }] }; } // missing deleteCount
      return fullTokens;
    });
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken());
    const result = await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[2]!.method).toBe('textDocument/semanticTokens/full');
    expect(connection.calls).toHaveLength(3);
    expect(result.resultId).toBe('1');
  });

  it('on delta cancellation rethrows and does NOT fall back to full', async () => {
    // full resolves immediately; delta stays pending until its abort signal fires (then rejects).
    const calls: { method: string }[] = [];
    const connection = {
      calls,
      request(method: string, _params: unknown, options?: { signal?: AbortSignal }) {
        calls.push({ method });
        if (method === 'textDocument/semanticTokens/full') {
          return Promise.resolve(fullTokens);
        }
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(new Error('cancelled')));
        });
      }
    };
    const languages = makeLanguages();
    registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken()); // caches '1'
    const token = makeToken();
    const pending = provider.provideDocumentSemanticTokens(model, '1', token);
    token.fire();
    await expect(pending).rejects.toThrow('cancelled');
    // exactly the prime-full + the cancelled delta; NO fallback full request.
    expect(calls.map((c) => c.method)).toEqual([
      'textDocument/semanticTokens/full',
      'textDocument/semanticTokens/full/delta'
    ]);
  });

  it('disposing the registration clears the cache so a later previousResultId goes full', async () => {
    const connection = makeFnConnection(byMethod({
      'textDocument/semanticTokens/full': fullTokens,
      'textDocument/semanticTokens/full/delta': deltaResult
    }));
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, connection, deltaCap, 'typescript');
    const provider = languages.semanticTokensCalls[0]!.provider;
    await provider.provideDocumentSemanticTokens(model, null, makeToken()); // caches '1'
    registration.dispose();
    await provider.provideDocumentSemanticTokens(model, '1', makeToken());
    expect(connection.calls[1]!.method).toBe('textDocument/semanticTokens/full');
  });
});

describe('registerLspProviders semanticTokens (range)', () => {
  const legend = { tokenTypes: ['keyword', 'variable'], tokenModifiers: ['declaration'] };
  const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 1 };
  const serverTokens = { resultId: '2', data: [0, 0, 3, 2, 0] };

  it('registers a document range semantic tokens provider when legend and range support are advertised', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend, range: true } }, 'typescript');
    expect(languages.rangeSemanticTokensCalls).toHaveLength(1);
  });

  it('does not register the range provider when range support is absent even with a legend', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend } }, 'typescript');
    expect(languages.rangeSemanticTokensCalls).toHaveLength(0);
  });

  it('does not register the range provider when range is explicitly false even with a legend', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend, range: false } }, 'typescript');
    expect(languages.rangeSemanticTokensCalls).toHaveLength(0);
  });

  it('does not register the range provider when the legend is missing even with range true', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { range: true } }, 'typescript');
    expect(languages.rangeSemanticTokensCalls).toHaveLength(0);
  });

  it('getLegend returns the exact capability tokenTypes and tokenModifiers', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend, range: true } }, 'typescript');
    expect(languages.rangeSemanticTokensCalls[0]!.provider.getLegend()).toEqual({
      tokenTypes: ['keyword', 'variable'],
      tokenModifiers: ['declaration']
    });
  });

  it('provideDocumentRangeSemanticTokens sends textDocument/semanticTokens/range with string uri and converted 0-based range, no position; returns Uint32Array data', async () => {
    const connection = makeConnection(serverTokens);
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { semanticTokensProvider: { legend, range: true } }, 'typescript');
    const result = await languages.rangeSemanticTokensCalls[0]!.provider.provideDocumentRangeSemanticTokens(model, monacoRange, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/semanticTokens/range');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } }
    });
    expect('position' in (connection.calls[0]!.params as object)).toBe(false);
    expect(result).not.toBeNull();
    expect(result.data).toBeInstanceOf(Uint32Array);
    expect(result).toEqual(toMonacoSemanticTokens(serverTokens));
  });

  it('forwards the cancellation AbortSignal for range semantic tokens', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    registerLspProviders(languages, connection, { semanticTokensProvider: { legend, range: true } }, 'typescript');
    const token = makeToken();
    const pending = languages.rangeSemanticTokensCalls[0]!.provider.provideDocumentRangeSemanticTokens(model, monacoRange, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve(null);
    await pending;
  });

  it('disposes the per-request bridge after range semantic tokens resolve', async () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend, range: true } }, 'typescript');
    const token = makeToken();
    await languages.rangeSemanticTokensCalls[0]!.provider.provideDocumentRangeSemanticTokens(model, monacoRange, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the range semantic tokens registration', () => {
    const languages = makeLanguages();
    const registration = registerLspProviders(languages, makeConnection(null), { semanticTokensProvider: { legend, range: true } }, 'typescript');
    registration.dispose();
    expect(languages.rangeSemanticTokensCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders codeAction', () => {
  const markers = [{ severity: 8, message: 'boom', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }];
  const monacoRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 };
  const context = { markers, only: 'quickfix', trigger: 1 };
  const textEditLsp = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'X' };
  const expectedTextEdit = { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'X' };

  it('registers a code action provider when capabilities.codeActionProvider is set and createUri is supplied', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), { codeActionProvider: true }, 'typescript', createUri);
    expect(languages.codeActionCalls).toHaveLength(1);
  });

  it('does not register a code action provider when the capability is absent', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), {}, 'typescript', createUri);
    expect(languages.codeActionCalls).toHaveLength(0);
  });

  it('does not register a code action provider when createUri is missing even if advertised', () => {
    const languages = makeLanguages();
    registerLspProviders(languages, makeConnection([]), { codeActionProvider: true }, 'typescript');
    expect(languages.codeActionCalls).toHaveLength(0);
  });

  it('sends textDocument/codeAction with converted range and context (markers->diagnostics, only->array, trigger passthrough)', async () => {
    const connection = makeConnection([]);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { codeActionProvider: true }, 'typescript', createUri);
    await languages.codeActionCalls[0]!.provider.provideCodeActions(model, monacoRange, context, makeToken());
    expect(connection.calls[0]!.method).toBe('textDocument/codeAction');
    expect(connection.calls[0]!.params).toEqual({
      textDocument: { uri: 'file:///a.ts' },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      context: { diagnostics: toLspDiagnostics(markers), only: ['quickfix'], triggerKind: 1 }
    });
  });

  it('maps an action edit (changes form) resource through createUri and preserves textEdit', async () => {
    const server = [{ title: 'Fix', kind: 'quickfix', edit: { changes: { 'file:///b.ts': [textEditLsp] } } }];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { codeActionProvider: true }, 'typescript', createUri);
    const result = await languages.codeActionCalls[0]!.provider.provideCodeActions(model, monacoRange, context, makeToken());
    expect(result.actions[0]!.title).toBe('Fix');
    expect(result.actions[0]!.kind).toBe('quickfix');
    expect(result.actions[0]!.edit.edits[0]!.resource).toEqual({ kind: 'uri', value: 'file:///b.ts', toString: expect.any(Function) });
    expect(result.actions[0]!.edit.edits[0]!.textEdit).toEqual(expectedTextEdit);
    expect(typeof result.dispose).toBe('function');
  });

  it('preserves versionId from a documentChanges action edit after resource mapping', async () => {
    const server = [
      { title: 'Fix', edit: { documentChanges: [{ textDocument: { uri: 'file:///b.ts', version: 7 }, edits: [textEditLsp] }] } }
    ];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { codeActionProvider: true }, 'typescript', createUri);
    const result = await languages.codeActionCalls[0]!.provider.provideCodeActions(model, monacoRange, context, makeToken());
    expect(result.actions[0]!.edit.edits[0]!.resource.value).toBe('file:///b.ts');
    expect(result.actions[0]!.edit.edits[0]!.versionId).toBe(7);
  });

  it('passes through an action without an edit, preserving title and command', async () => {
    const server = [{ title: 'Run', command: { title: 'Run', command: 'run' } }];
    const connection = makeConnection(server);
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { codeActionProvider: true }, 'typescript', createUri);
    const result = await languages.codeActionCalls[0]!.provider.provideCodeActions(model, monacoRange, context, makeToken());
    expect(result.actions[0]!.title).toBe('Run');
    expect(result.actions[0]!.command).toBeTruthy();
    expect('edit' in result.actions[0]!).toBe(false);
  });

  it('forwards the cancellation AbortSignal for code actions', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, connection, { codeActionProvider: true }, 'typescript', createUri);
    const token = makeToken();
    const pending = languages.codeActionCalls[0]!.provider.provideCodeActions(model, monacoRange, context, token);
    const signal = connection.calls[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
    connection.resolve([]);
    await pending;
  });

  it('disposes the per-request bridge after code actions resolve', async () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    registerLspProviders(languages, makeConnection([]), { codeActionProvider: true }, 'typescript', createUri);
    const token = makeToken();
    await languages.codeActionCalls[0]!.provider.provideCodeActions(model, monacoRange, context, token);
    expect(token.disposed).toBe(true);
  });

  it('composite dispose includes the code action registration', () => {
    const languages = makeLanguages();
    const { createUri } = makeUriFactory();
    const registration = registerLspProviders(languages, makeConnection([]), { codeActionProvider: true }, 'typescript', createUri);
    registration.dispose();
    expect(languages.codeActionCalls[0]!.disposable.disposed).toBe(true);
  });
});

describe('registerLspProviders burst scheduling with the real scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const countMethod = (calls: { method: string }[], method: string): number =>
    calls.filter((call) => call.method === method).length;

  it('collapses a same-key burst to LEADING + trailing-latest (2 bridge calls), cancelling the middle', async () => {
    const connection = makeConnection([]);
    const languages = makeLanguages();
    const scheduler = createProviderScheduler({ delayMs: 20 });
    registerLspProviders(languages, connection, { documentSymbolProvider: true }, 'typescript', undefined, undefined, scheduler);
    const provider = languages.documentSymbolCalls[0]!.provider;
    const leading = provider.provideDocumentSymbols(model, makeToken()); // runs immediately (no first-paint delay)
    const middle = provider.provideDocumentSymbols(model, makeToken()); // queued, then superseded
    const latest = provider.provideDocumentSymbols(model, makeToken()); // trailing-latest
    await vi.advanceTimersByTimeAsync(20);
    const settled = await Promise.allSettled([leading, middle, latest]);
    expect(countMethod(connection.calls, 'textDocument/documentSymbol')).toBe(2); // leading + trailing-latest only
    expect(settled[0]!.status).toBe('fulfilled'); // leading delivered promptly
    expect(settled[2]!.status).toBe('fulfilled'); // trailing-latest delivered
    expect(settled[1]!.status).toBe('rejected'); // middle superseded -> cancelled
    scheduler.dispose();
  });

  it('surfaces a superseded (middle) caller as a Monaco cancellation (name Canceled), never an empty result', async () => {
    const connection = makeConnection([]);
    const languages = makeLanguages();
    const scheduler = createProviderScheduler({ delayMs: 20 });
    registerLspProviders(languages, connection, { documentSymbolProvider: true }, 'typescript', undefined, undefined, scheduler);
    const provider = languages.documentSymbolCalls[0]!.provider;
    provider.provideDocumentSymbols(model, makeToken()); // leading
    const superseded = provider.provideDocumentSymbols(model, makeToken()); // queued, then superseded by latest
    const latest = provider.provideDocumentSymbols(model, makeToken()); // trailing-latest
    await vi.advanceTimersByTimeAsync(20);
    await expect(superseded).rejects.toMatchObject({ name: 'Canceled' }); // cancellation-shaped, not [] (Monaco treats [] as authoritative clear)
    await expect(latest).resolves.toEqual([]);
    scheduler.dispose();
  });

  it('does NOT schedule latency-sensitive direct actions: hover runs synchronously even with a real scheduler', () => {
    const connection = makeConnection(null);
    const languages = makeLanguages();
    const scheduler = createProviderScheduler({ delayMs: 20 });
    registerLspProviders(languages, connection, { hoverProvider: true }, 'typescript', undefined, undefined, scheduler);
    const provider = languages.hoverCalls[0]!.provider;
    void provider.provideHover(model, { lineNumber: 1, column: 1 }, makeToken());
    // No timer advance: hover is not debounced, so the bridge request is issued immediately.
    expect(countMethod(connection.calls, 'textDocument/hover')).toBe(1);
    scheduler.dispose();
  });

  it('after registration dispose, an in-flight scheduled provider call rejects cancellation-shaped (no late result)', async () => {
    const connection = makeDeferredConnection();
    const languages = makeLanguages();
    const scheduler = createProviderScheduler({ delayMs: 20 });
    const registration = registerLspProviders(languages, connection, { documentSymbolProvider: true }, 'typescript', undefined, undefined, scheduler);
    const provider = languages.documentSymbolCalls[0]!.provider;
    const pending = provider.provideDocumentSymbols(model, makeToken()); // leading runs immediately; bridge stays pending
    registration.dispose(); // disposes the scheduler -> aborts the in-flight run
    connection.resolve([]); // bridge resolves AFTER dispose
    await expect(pending).rejects.toMatchObject({ name: 'Canceled' }); // no late [] delivered to Monaco
  });
});
