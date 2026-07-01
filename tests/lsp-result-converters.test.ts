import { describe, expect, it } from 'vitest';
import {
  toMonacoCodeActions,
  toMonacoCodeLenses,
  toMonacoColorInformation,
  toMonacoColorPresentations,
  toMonacoDocumentHighlights,
  toMonacoDocumentLinks,
  toMonacoDocumentSymbols,
  toMonacoFoldingRanges,
  toMonacoHover,
  toMonacoInlayHints,
  toMonacoLinkedEditingRanges,
  toMonacoLocation,
  toMonacoLocations,
  toMonacoRange,
  toMonacoRenamePrepare,
  toMonacoSelectionRanges,
  toMonacoSemanticTokens,
  toMonacoSemanticTokensEdits,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
  toMonacoWorkspaceEdit
} from '../src/web/editor/lsp/resultConverters';

describe('toMonacoRange', () => {
  it('converts a 0-based LSP range to a 1-based Monaco range', () => {
    expect(toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 3, character: 7 } })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 8
    });
  });
});

describe('toMonacoHover', () => {
  it('converts MarkupContent plus an optional range to a Monaco hover (1-based)', () => {
    expect(
      toMonacoHover({
        contents: { kind: 'markdown', value: '**x**' },
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
      })
    ).toEqual({
      contents: [{ value: '**x**' }],
      range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 }
    });
  });

  it('normalizes a plain string and a MarkedString array into fenced markdown contents', () => {
    expect(toMonacoHover({ contents: 'plain text' })).toEqual({ contents: [{ value: 'plain text' }] });
    expect(toMonacoHover({ contents: [{ language: 'ts', value: 'const x = 1' }, 'note'] })).toEqual({
      contents: [{ value: '```ts\nconst x = 1\n```' }, { value: 'note' }]
    });
  });
});

describe('toMonacoLocation / toMonacoLocations', () => {
  it('toMonacoLocation converts a single location to a 1-based Monaco location', () => {
    expect(
      toMonacoLocation({ uri: 'file:///a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } })
    ).toEqual({ uri: 'file:///a.ts', range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 } });
  });

  it('normalizes single Location, Location[], and LocationLink[] into {uri,range} with 1-based ranges', () => {
    const loc = { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    expect(toMonacoLocations(loc)).toEqual([
      { uri: 'file:///a.ts', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 } }
    ]);
    expect(toMonacoLocations([loc, loc])).toHaveLength(2);
    const link = {
      targetUri: 'file:///b.ts',
      targetRange: { start: { line: 5, character: 0 }, end: { line: 6, character: 0 } },
      targetSelectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 7 } }
    };
    expect(toMonacoLocations([link])).toEqual([
      { uri: 'file:///b.ts', range: { startLineNumber: 6, startColumn: 3, endLineNumber: 6, endColumn: 8 } }
    ]);
  });

  it('returns an empty array for null/undefined', () => {
    expect(toMonacoLocations(null)).toEqual([]);
    expect(toMonacoLocations(undefined)).toEqual([]);
  });
});

describe('toMonacoTextEdits', () => {
  it('converts LSP TextEdit[] to Monaco edit operations (1-based range, newText->text)', () => {
    expect(
      toMonacoTextEdits([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'let' }
      ])
    ).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: 'let' }]);
  });

  it('returns an empty array for null/undefined', () => {
    expect(toMonacoTextEdits(null)).toEqual([]);
    expect(toMonacoTextEdits(undefined)).toEqual([]);
  });
});

describe('toMonacoDocumentSymbols', () => {
  it('converts hierarchical DocumentSymbol[] with children, mapped SymbolKind, default detail/tags, and 1-based ranges', () => {
    const result = toMonacoDocumentSymbols([
      {
        name: 'Foo',
        kind: 5, // LSP Class -> Monaco 4
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
        children: [
          {
            name: 'bar',
            detail: '()',
            kind: 6, // LSP Method -> Monaco 5
            tags: [1],
            range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
          }
        ]
      }
    ]);
    expect(result).toEqual([
      {
        name: 'Foo',
        detail: '',
        kind: 4,
        tags: [],
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 6, endColumn: 2 },
        selectionRange: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 10 },
        children: [
          {
            name: 'bar',
            detail: '()',
            kind: 5,
            tags: [1],
            range: { startLineNumber: 2, startColumn: 3, endLineNumber: 3, endColumn: 4 },
            selectionRange: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 },
            children: []
          }
        ]
      }
    ]);
  });

  it('converts flat SymbolInformation[] to top-level symbols with detail "" and tags []', () => {
    const result = toMonacoDocumentSymbols([
      {
        name: 'g',
        kind: 12, // LSP Function -> Monaco 11
        location: { uri: 'file:///a.ts', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } } }
      }
    ]);
    expect(result).toEqual([
      {
        name: 'g',
        detail: '',
        kind: 11,
        tags: [],
        range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 5 },
        selectionRange: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 5 },
        children: []
      }
    ]);
  });

  it('returns [] for null/undefined', () => {
    expect(toMonacoDocumentSymbols(null)).toEqual([]);
    expect(toMonacoDocumentSymbols(undefined)).toEqual([]);
  });
});

describe('toMonacoSignatureHelp', () => {
  it('converts signatures+parameters with default activeSignature/activeParameter, default parameters [], and markdown documentation', () => {
    const result = toMonacoSignatureHelp({
      signatures: [
        {
          label: 'foo(a, b)',
          documentation: { kind: 'markdown', value: 'docs' },
          parameters: [{ label: 'a' }, { label: 'b', documentation: 'param b' }]
        },
        { label: 'noParams()' }
      ]
    });
    expect(result).toEqual({
      activeSignature: 0,
      activeParameter: 0,
      signatures: [
        {
          label: 'foo(a, b)',
          documentation: { value: 'docs' },
          parameters: [{ label: 'a' }, { label: 'b', documentation: 'param b' }]
        },
        { label: 'noParams()', parameters: [] }
      ]
    });
  });

  it('passes through offset-pair parameter labels unchanged', () => {
    const result = toMonacoSignatureHelp({
      signatures: [{ label: 'f(x)', parameters: [{ label: [2, 3] }] }],
      activeSignature: 1,
      activeParameter: 0
    });
    expect(result!.signatures[0]!.parameters[0]!.label).toEqual([2, 3]);
    expect(result!.activeSignature).toBe(1);
  });

  it('returns null for null/undefined', () => {
    expect(toMonacoSignatureHelp(null)).toBeNull();
    expect(toMonacoSignatureHelp(undefined)).toBeNull();
  });
});

describe('toMonacoDocumentHighlights', () => {
  it('converts highlights with offset-mapped kind and 1-based ranges', () => {
    expect(
      toMonacoDocumentHighlights([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, kind: 2 },
        { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, kind: 3 }
      ])
    ).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, kind: 1 },
      { range: { startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 3 }, kind: 2 }
    ]);
  });

  it('defaults absent kind to Text(0)', () => {
    expect(
      toMonacoDocumentHighlights([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }])
    ).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, kind: 0 }]);
  });

  it('returns [] for null/undefined', () => {
    expect(toMonacoDocumentHighlights(null)).toEqual([]);
    expect(toMonacoDocumentHighlights(undefined)).toEqual([]);
  });
});

describe('toMonacoWorkspaceEdit', () => {
  it('flattens the changes map into resource+textEdit entries (1-based)', () => {
    expect(
      toMonacoWorkspaceEdit({
        changes: {
          'file:///a.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' }]
        }
      })
    ).toEqual({
      edits: [
        {
          resource: 'file:///a.ts',
          textEdit: { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'X' }
        }
      ]
    });
  });

  it('flattens documentChanges TextDocumentEdit with versionId and ignores resource operations', () => {
    expect(
      toMonacoWorkspaceEdit({
        documentChanges: [
          {
            textDocument: { uri: 'file:///b.ts', version: 4 },
            edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: 'Y' }]
          },
          { kind: 'rename', oldUri: 'file:///b.ts', newUri: 'file:///c.ts' }
        ]
      })
    ).toEqual({
      edits: [
        {
          resource: 'file:///b.ts',
          textEdit: { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 3 }, text: 'Y' },
          versionId: 4
        }
      ]
    });
  });

  it('returns { edits: [] } for null/undefined', () => {
    expect(toMonacoWorkspaceEdit(null)).toEqual({ edits: [] });
    expect(toMonacoWorkspaceEdit(undefined)).toEqual({ edits: [] });
  });
});

describe('toMonacoRenamePrepare', () => {
  it('converts bare Range and { range, placeholder } to 1-based range (+ placeholder)', () => {
    expect(toMonacoRenamePrepare({ start: { line: 0, character: 2 }, end: { line: 0, character: 5 } })).toEqual({
      range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 }
    });
    expect(
      toMonacoRenamePrepare({
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        placeholder: 'foo'
      })
    ).toEqual({ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }, placeholder: 'foo' });
  });

  it('maps { defaultBehavior:true } and null/undefined to null', () => {
    expect(toMonacoRenamePrepare({ defaultBehavior: true })).toBeNull();
    expect(toMonacoRenamePrepare(null)).toBeNull();
    expect(toMonacoRenamePrepare(undefined)).toBeNull();
  });
});

describe('toMonacoCodeActions', () => {
  it('converts a CodeAction (edit/kind/isPreferred + normalized nested command id) and a bare Command distinctly', () => {
    const result = toMonacoCodeActions([
      {
        title: 'Fix',
        kind: 'quickfix',
        isPreferred: true,
        edit: {
          changes: { 'file:///a.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] }
        },
        command: { title: 'Apply', command: 'fix.apply', arguments: [1] }
      },
      { title: 'Run', command: 'run.it', arguments: ['a'] }
    ]);
    expect(result).toEqual({
      actions: [
        {
          title: 'Fix',
          kind: 'quickfix',
          isPreferred: true,
          edit: {
            edits: [
              { resource: 'file:///a.ts', textEdit: { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'x' } }
            ]
          },
          command: { id: 'fix.apply', title: 'Apply', arguments: [1] }
        },
        { title: 'Run', command: { id: 'run.it', title: 'Run', arguments: ['a'] } }
      ]
    });
  });

  it('normalizes nested CodeAction.command to { id, title, arguments }', () => {
    const result = toMonacoCodeActions([{ title: 'A', command: { title: 'C', command: 'do.it' } }]);
    expect(result.actions[0]!.command).toEqual({ id: 'do.it', title: 'C' });
  });

  it('returns { actions: [] } for null/undefined', () => {
    expect(toMonacoCodeActions(null)).toEqual({ actions: [] });
    expect(toMonacoCodeActions(undefined)).toEqual({ actions: [] });
  });
});

describe('toMonacoFoldingRanges', () => {
  it('converts 0-based folding lines to 1-based draft ranges and passes kind string through', () => {
    expect(
      toMonacoFoldingRanges([{ startLine: 0, endLine: 4, kind: 'region', startCharacter: 3, endCharacter: 1 }])
    ).toEqual([{ start: 1, end: 5, kind: 'region' }]);
  });

  it('omits kind when absent', () => {
    expect(toMonacoFoldingRanges([{ startLine: 2, endLine: 6 }])).toEqual([{ start: 3, end: 7 }]);
  });

  it('returns [] for null/undefined', () => {
    expect(toMonacoFoldingRanges(null)).toEqual([]);
    expect(toMonacoFoldingRanges(undefined)).toEqual([]);
  });
});

describe('toMonacoDocumentLinks', () => {
  it('returns { links } with 1-based range, target->url, tooltip', () => {
    expect(
      toMonacoDocumentLinks([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, target: 'https://x', tooltip: 'open', data: { id: 1 } }
      ])
    ).toEqual({
      links: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, url: 'https://x', tooltip: 'open' }]
    });
  });

  it('omits url/tooltip when absent and drops data', () => {
    expect(
      toMonacoDocumentLinks([{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, data: 7 }])
    ).toEqual({ links: [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 3 } }] });
  });

  it('returns { links: [] } for null/undefined', () => {
    expect(toMonacoDocumentLinks(null)).toEqual({ links: [] });
    expect(toMonacoDocumentLinks(undefined)).toEqual({ links: [] });
  });
});

describe('toMonacoCodeLenses', () => {
  it('returns { lenses } with 1-based range and normalized command id', () => {
    expect(
      toMonacoCodeLenses([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          command: { title: 'Run', command: 'run.it', arguments: [1] },
          data: { x: 1 }
        }
      ])
    ).toEqual({
      lenses: [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          command: { id: 'run.it', title: 'Run', arguments: [1] }
        }
      ]
    });
  });

  it('omits command for an unresolved lens and drops data', () => {
    expect(
      toMonacoCodeLenses([{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } }, data: 9 }])
    ).toEqual({ lenses: [{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 5 } }] });
  });

  it('returns { lenses: [] } for null/undefined', () => {
    expect(toMonacoCodeLenses(null)).toEqual({ lenses: [] });
    expect(toMonacoCodeLenses(undefined)).toEqual({ lenses: [] });
  });
});

describe('toMonacoColorInformation', () => {
  it('converts range (1-based) and passes the color through unchanged', () => {
    expect(
      toMonacoColorInformation([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, color: { red: 1, green: 0.5, blue: 0, alpha: 1 } }
      ])
    ).toEqual([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }, color: { red: 1, green: 0.5, blue: 0, alpha: 1 } }
    ]);
  });

  it('returns [] for null/undefined', () => {
    expect(toMonacoColorInformation(null)).toEqual([]);
    expect(toMonacoColorInformation(undefined)).toEqual([]);
  });
});

describe('toMonacoColorPresentations', () => {
  it('converts label + single textEdit + additionalTextEdits to 1-based Monaco edits', () => {
    expect(
      toMonacoColorPresentations([
        {
          label: '#ff8800',
          textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: '#ff8800' },
          additionalTextEdits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'x' }]
        }
      ])
    ).toEqual([
      {
        label: '#ff8800',
        textEdit: { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }, text: '#ff8800' },
        additionalTextEdits: [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }, text: 'x' }]
      }
    ]);
  });

  it('omits edits when absent', () => {
    expect(toMonacoColorPresentations([{ label: 'rgb(255,136,0)' }])).toEqual([{ label: 'rgb(255,136,0)' }]);
  });

  it('returns [] for null/undefined', () => {
    expect(toMonacoColorPresentations(null)).toEqual([]);
    expect(toMonacoColorPresentations(undefined)).toEqual([]);
  });
});

describe('toMonacoSelectionRanges', () => {
  it('flattens each position parent chain into an inner-to-outer 1-based array', () => {
    const result = toMonacoSelectionRanges([
      {
        range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
        parent: { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } }
      }
    ]);
    expect(result).toEqual([
      [
        { range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 } },
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 } }
      ]
    ]);
  });

  it('a single range with no parent yields a one-element array', () => {
    expect(
      toMonacoSelectionRanges([{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }])
    ).toEqual([[{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 } }]]);
  });

  it('returns [] for null/undefined', () => {
    expect(toMonacoSelectionRanges(null)).toEqual([]);
    expect(toMonacoSelectionRanges(undefined)).toEqual([]);
  });
});

describe('toMonacoInlayHints', () => {
  it('converts position to 1-based, string label, kind/padding, and normalizes tooltip; draft wrapper', () => {
    expect(
      toMonacoInlayHints([
        {
          position: { line: 2, character: 4 },
          label: ': number',
          kind: 1,
          tooltip: { kind: 'markdown', value: 'a number' },
          paddingLeft: true,
          paddingRight: false
        }
      ])
    ).toEqual({
      hints: [
        {
          position: { lineNumber: 3, column: 5 },
          label: ': number',
          kind: 1,
          tooltip: { value: 'a number' },
          paddingLeft: true,
          paddingRight: false
        }
      ]
    });
  });

  it('maps label parts value->label and normalizes part tooltip (MarkupContent -> { value })', () => {
    expect(
      toMonacoInlayHints([
        {
          position: { line: 0, character: 0 },
          label: [{ value: 'Foo', tooltip: { kind: 'markdown', value: 'the foo' } }, { value: '.bar' }]
        }
      ])
    ).toEqual({
      hints: [
        {
          position: { lineNumber: 1, column: 1 },
          label: [{ label: 'Foo', tooltip: { value: 'the foo' } }, { label: '.bar' }]
        }
      ]
    });
  });

  it('returns { hints: [] } for null/undefined', () => {
    expect(toMonacoInlayHints(null)).toEqual({ hints: [] });
    expect(toMonacoInlayHints(undefined)).toEqual({ hints: [] });
  });
});

describe('toMonacoLinkedEditingRanges', () => {
  it('converts ranges and passes through the wordPattern string (draft)', () => {
    expect(
      toMonacoLinkedEditingRanges({
        ranges: [
          { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
          { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } }
        ],
        wordPattern: '[a-z]+'
      })
    ).toEqual({
      ranges: [
        { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 },
        { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 }
      ],
      wordPattern: '[a-z]+'
    });
  });

  it('omits wordPattern when the server does not provide one', () => {
    expect(
      toMonacoLinkedEditingRanges({
        ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }]
      })
    ).toEqual({
      ranges: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }]
    });
  });

  it('returns undefined for null/undefined', () => {
    expect(toMonacoLinkedEditingRanges(null)).toBeUndefined();
    expect(toMonacoLinkedEditingRanges(undefined)).toBeUndefined();
  });
});

describe('toMonacoSemanticTokens', () => {
  it('converts the data array to a Uint32Array and passes resultId through', () => {
    const result = toMonacoSemanticTokens({ resultId: '7', data: [0, 0, 5, 1, 0, 1, 2, 3, 2, 1] });
    expect(result).not.toBeNull();
    expect(result!.resultId).toBe('7');
    expect(result!.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result!.data)).toEqual([0, 0, 5, 1, 0, 1, 2, 3, 2, 1]);
  });

  it('supports an absent resultId', () => {
    const result = toMonacoSemanticTokens({ data: [0, 0, 1, 0, 0] });
    expect(result).not.toBeNull();
    expect(result!.resultId).toBeUndefined();
    expect(result!.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result!.data)).toEqual([0, 0, 1, 0, 0]);
  });

  it('returns null for null/undefined', () => {
    expect(toMonacoSemanticTokens(null)).toBeNull();
    expect(toMonacoSemanticTokens(undefined)).toBeNull();
  });
});

describe('toMonacoSemanticTokensEdits', () => {
  it('converts edit data arrays to Uint32Array and preserves start/deleteCount/resultId', () => {
    const result = toMonacoSemanticTokensEdits({
      resultId: '12',
      edits: [{ start: 5, deleteCount: 3, data: [0, 0, 2, 1, 0] }]
    });
    expect(result).not.toBeNull();
    expect(result!.resultId).toBe('12');
    expect(result!.edits).toHaveLength(1);
    expect(result!.edits[0]!.start).toBe(5);
    expect(result!.edits[0]!.deleteCount).toBe(3);
    expect(result!.edits[0]!.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result!.edits[0]!.data!)).toEqual([0, 0, 2, 1, 0]);
  });

  it('keeps an edit with absent data as absent data', () => {
    const result = toMonacoSemanticTokensEdits({ resultId: '13', edits: [{ start: 0, deleteCount: 5 }] });
    expect(result).not.toBeNull();
    expect(result!.edits[0]).toEqual({ start: 0, deleteCount: 5 });
    expect('data' in result!.edits[0]!).toBe(false);
  });

  it('supports an absent resultId', () => {
    const result = toMonacoSemanticTokensEdits({ edits: [{ start: 1, deleteCount: 0, data: [9] }] });
    expect(result).not.toBeNull();
    expect(result!.resultId).toBeUndefined();
    expect(result!.edits[0]!.data).toBeInstanceOf(Uint32Array);
    expect(Array.from(result!.edits[0]!.data!)).toEqual([9]);
  });

  it('returns null for null/undefined', () => {
    expect(toMonacoSemanticTokensEdits(null)).toBeNull();
    expect(toMonacoSemanticTokensEdits(undefined)).toBeNull();
  });
});
