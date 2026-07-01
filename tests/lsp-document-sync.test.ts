import { describe, expect, it } from 'vitest';
import {
  LspDocumentSync,
  LspDocumentTracker,
  toIncrementalChanges,
  toFullContentChanges,
  toLspPosition
} from '../src/web/editor/lsp/documentSync';

describe('documentSync - Monaco->LSP conversion', () => {
  it('1-based Monaco positions convert to 0-based LSP positions', () => {
    expect(toLspPosition(3, 5)).toEqual({ line: 2, character: 4 });
    expect(toLspPosition(1, 1)).toEqual({ line: 0, character: 0 });
  });

  it('maps Monaco content changes to LSP incremental contentChanges preserving end-to-beginning order', () => {
    // Monaco delivers changes ordered from the end of the document to the beginning,
    // which is exactly the order LSP applies them in sequence. Emit verbatim - do not re-sort.
    const monacoChanges = [
      { range: { startLineNumber: 10, startColumn: 3, endLineNumber: 10, endColumn: 3 }, text: 'B' },
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }, text: 'A' }
    ];
    expect(toIncrementalChanges(monacoChanges)).toEqual([
      { range: { start: { line: 9, character: 2 }, end: { line: 9, character: 2 } }, text: 'B' },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, text: 'A' }
    ]);
  });

  it('full-text fallback emits a single change with no range', () => {
    expect(toFullContentChanges('hello\nworld')).toEqual([{ text: 'hello\nworld' }]);
  });
});

describe('LspDocumentTracker', () => {
  it('open assigns version 1 and returns didOpen with languageId and full text', () => {
    const tracker = new LspDocumentTracker();
    expect(tracker.open('file:///a.ts', 'typescript', 'const x = 1;')).toEqual({
      textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' }
    });
  });

  it('change increments the version and returns incremental contentChanges', () => {
    const tracker = new LspDocumentTracker();
    tracker.open('file:///a.ts', 'typescript', 'const x = 1;');
    const changes = [
      { range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 }, text: 'y' }
    ];
    expect(tracker.change('file:///a.ts', { changes, fullText: 'const y = 1;' })).toEqual({
      textDocument: { uri: 'file:///a.ts', version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'y' }]
    });
  });

  it('a server joining an already-open document gets didOpen with the current version and text', () => {
    const tracker = new LspDocumentTracker();
    tracker.open('file:///a.ts', 'typescript', 'v1');
    tracker.change('file:///a.ts', { changes: [], fullText: 'v2text' });
    expect(tracker.snapshotForNewServer('file:///a.ts')).toEqual({
      textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 2, text: 'v2text' }
    });
  });

  it('close returns didClose and forgets the document', () => {
    const tracker = new LspDocumentTracker();
    tracker.open('file:///a.ts', 'typescript', 'x');
    expect(tracker.close('file:///a.ts')).toEqual({ textDocument: { uri: 'file:///a.ts' } });
    expect(() => tracker.snapshotForNewServer('file:///a.ts')).toThrow(/not open/i);
  });
});

describe('LspDocumentSync', () => {
  function makeSink() {
    const calls: Array<{ method: string; params: unknown }> = [];
    return { calls, notify: (method: string, params: unknown) => calls.push({ method, params }) };
  }

  it('openDocument sends textDocument/didOpen over the connection', () => {
    const sink = makeSink();
    const sync = new LspDocumentSync(sink);
    sync.openDocument('file:///a.ts', 'typescript', 'const x = 1;');
    expect(sink.calls).toEqual([
      {
        method: 'textDocument/didOpen',
        params: { textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' } }
      }
    ]);
  });

  it('changeDocument sends textDocument/didChange with incremental changes', () => {
    const sink = makeSink();
    const sync = new LspDocumentSync(sink);
    sync.openDocument('file:///a.ts', 'typescript', 'const x = 1;');
    const changes = [
      { range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 }, text: 'y' }
    ];
    sync.changeDocument('file:///a.ts', { changes, fullText: 'const y = 1;' });
    expect(sink.calls[1]).toEqual({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: 'file:///a.ts', version: 2 },
        contentChanges: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'y' }]
      }
    });
  });

  it('closeDocument sends textDocument/didClose', () => {
    const sink = makeSink();
    const sync = new LspDocumentSync(sink);
    sync.openDocument('file:///a.ts', 'typescript', 'x');
    sync.closeDocument('file:///a.ts');
    expect(sink.calls[1]).toEqual({
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///a.ts' } }
    });
  });
});
