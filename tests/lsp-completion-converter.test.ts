import { describe, expect, it } from 'vitest';
import { toMonacoCompletionList } from '../src/web/editor/lsp/completionConverter';

describe('toMonacoCompletionList', () => {
  it('maps CompletionList items with kind-table, snippet rule, detail/documentation/insertText', () => {
    const result = toMonacoCompletionList({
      isIncomplete: true,
      items: [
        {
          label: 'log',
          kind: 3, // LSP Function -> Monaco 1
          detail: 'method',
          documentation: { kind: 'markdown', value: '**doc**' },
          insertText: 'log()',
          insertTextFormat: 2, // Snippet
          sortText: '0',
          filterText: 'log'
        }
      ]
    });
    expect(result).toEqual({
      incomplete: true,
      suggestions: [
        {
          label: 'log',
          kind: 1,
          insertText: 'log()',
          detail: 'method',
          documentation: { value: '**doc**' },
          insertTextRules: 4,
          sortText: '0',
          filterText: 'log'
        }
      ]
    });
  });

  it('maps a bare CompletionItem[] as not-incomplete and defaults insertText to label', () => {
    expect(toMonacoCompletionList([{ label: 'foo', kind: 7 }])).toEqual({
      incomplete: false,
      suggestions: [{ label: 'foo', kind: 5, insertText: 'foo' }]
    });
  });

  it('maps representative CompletionItemKinds (Function/Class/Snippet) via the table', () => {
    const kindOf = (lspKind: number): number =>
      toMonacoCompletionList([{ label: 'x', kind: lspKind }]).suggestions[0]!.kind;
    expect(kindOf(3)).toBe(1); // Function
    expect(kindOf(7)).toBe(5); // Class
    expect(kindOf(15)).toBe(28); // Snippet
  });

  it('returns { incomplete:false, suggestions:[] } for null/undefined', () => {
    expect(toMonacoCompletionList(null)).toEqual({ incomplete: false, suggestions: [] });
    expect(toMonacoCompletionList(undefined)).toEqual({ incomplete: false, suggestions: [] });
  });
});
