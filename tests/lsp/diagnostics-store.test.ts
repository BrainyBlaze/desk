import { describe, expect, it } from 'vitest';
import { LspDiagnosticsStore, type LspDiagnostic } from '../../src/server/lsp/diagnosticsStore';

describe('LspDiagnosticsStore', () => {
  it('replaces one server bucket without clearing diagnostics from other servers', () => {
    const store = new LspDiagnosticsStore();
    const uri = 'file:///workspace/src/example.ts';
    const eslintDiagnostic = diagnostic('semi', 'eslint');
    const oldTypeScriptDiagnostic = diagnostic('old type error', 'typescript');
    const newTypeScriptDiagnostic = diagnostic('new type error', 'typescript');

    store.setDiagnostics({ uri, serverId: 'typescript', diagnostics: [oldTypeScriptDiagnostic] });
    store.setDiagnostics({ uri, serverId: 'eslint', diagnostics: [eslintDiagnostic] });

    const merged = store.setDiagnostics({
      uri,
      serverId: 'typescript',
      diagnostics: [newTypeScriptDiagnostic]
    });

    expect(merged).toEqual({
      uri,
      diagnostics: [newTypeScriptDiagnostic, eslintDiagnostic]
    });
  });

  it('getMergedDiagnostics returns the complete merged diagnostics for a uri', () => {
    const store = new LspDiagnosticsStore();
    const uri = 'file:///workspace/src/example.ts';
    const otherUri = 'file:///workspace/src/other.ts';
    const typeScriptDiagnostic = diagnostic('type error', 'typescript');
    const eslintDiagnostic = diagnostic('lint error', 'eslint');

    store.setDiagnostics({ uri, serverId: 'typescript', diagnostics: [typeScriptDiagnostic] });
    store.setDiagnostics({ uri, serverId: 'eslint', diagnostics: [eslintDiagnostic] });
    store.setDiagnostics({ uri: otherUri, serverId: 'typescript', diagnostics: [diagnostic('other')] });

    expect(store.getMergedDiagnostics(uri)).toEqual({
      uri,
      diagnostics: [typeScriptDiagnostic, eslintDiagnostic]
    });
  });

  it('drops stale versioned diagnostics when the current document version is newer', () => {
    const store = new LspDiagnosticsStore();
    const uri = 'file:///workspace/src/example.ts';
    const currentDiagnostic = diagnostic('current type error', 'typescript');
    const staleDiagnostic = diagnostic('stale type error', 'typescript');

    store.setDiagnostics({
      uri,
      serverId: 'typescript',
      diagnostics: [currentDiagnostic],
      version: 5,
      currentDocumentVersion: 5
    });
    const merged = store.setDiagnostics({
      uri,
      serverId: 'typescript',
      diagnostics: [staleDiagnostic],
      version: 4,
      currentDocumentVersion: 5
    });

    expect(merged).toEqual({
      uri,
      diagnostics: [currentDiagnostic]
    });
  });

  it('clearDiagnostics removes only the selected server bucket', () => {
    const store = new LspDiagnosticsStore();
    const uri = 'file:///workspace/src/example.ts';
    const typeScriptDiagnostic = diagnostic('type error', 'typescript');
    const eslintDiagnostic = diagnostic('lint error', 'eslint');

    store.setDiagnostics({ uri, serverId: 'typescript', diagnostics: [typeScriptDiagnostic] });
    store.setDiagnostics({ uri, serverId: 'eslint', diagnostics: [eslintDiagnostic] });

    const merged = store.clearDiagnostics({ uri, serverId: 'typescript' });

    expect(merged).toEqual({
      uri,
      diagnostics: [eslintDiagnostic]
    });
  });

  it('clearServerDiagnostics removes every bucket for one session without clearing other sessions', () => {
    const store = new LspDiagnosticsStore();
    const firstUri = 'file:///workspace/src/example.ts';
    const secondUri = 'file:///workspace/src/other.ts';
    const sessionDiagnostic = diagnostic('type error', 'typescript');
    const otherSessionDiagnostic = diagnostic('lint error', 'eslint');

    store.setDiagnostics({ uri: firstUri, serverId: 'session-a', diagnostics: [sessionDiagnostic] });
    store.setDiagnostics({ uri: secondUri, serverId: 'session-a', diagnostics: [diagnostic('other type error')] });
    store.setDiagnostics({ uri: firstUri, serverId: 'session-b', diagnostics: [otherSessionDiagnostic] });

    const snapshots = store.clearServerDiagnostics('session-a');

    expect(snapshots).toEqual([
      { uri: firstUri, diagnostics: [otherSessionDiagnostic] },
      { uri: secondUri, diagnostics: [] }
    ]);
    expect(store.getMergedDiagnostics(firstUri)).toEqual({ uri: firstUri, diagnostics: [otherSessionDiagnostic] });
    expect(store.getMergedDiagnostics(secondUri)).toEqual({ uri: secondUri, diagnostics: [] });
  });

  it('sanitizes diagnostics to the shared safe shape before storing them', () => {
    const store = new LspDiagnosticsStore();
    const uri = 'file:///workspace/src/example.ts';

    store.setDiagnostics({
      uri,
      serverId: 'typescript',
      diagnostics: [
        {
          range: {
            start: { line: 1, character: 2, tok_SECRET: 'start-leak' },
            end: { line: 1, character: 8, tok_SECRET: 'end-leak' },
            tok_SECRET: 'range-leak'
          },
          message: 'safe diagnostic',
          severity: '1',
          source: 'typescript',
          code: { value: 'ts-100', target: 'file:///secret' },
          tags: [1, 'bad', 2],
          uri: 'file:///workspace/src/example.ts',
          relatedInformation: [{ message: 'leak' }],
          codeDescription: { href: 'file:///secret' },
          data: { token: 'secret' },
          command: 'run-me'
        } as any,
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          message: 'numeric fields preserved',
          severity: 2,
          code: 1001,
          tags: [1]
        } as any
      ]
    });

    const merged = store.getMergedDiagnostics(uri);

    expect(JSON.stringify(merged)).not.toContain('tok_SECRET');
    expect(merged).toEqual({
      uri,
      diagnostics: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          message: 'safe diagnostic',
          source: 'typescript',
          tags: [1, 2]
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          message: 'numeric fields preserved',
          severity: 2,
          code: 1001,
          tags: [1]
        }
      ]
    });
  });
});

function diagnostic(message: string, source = 'server'): LspDiagnostic {
  return {
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 8 }
    },
    severity: 1,
    source,
    code: `${source}-code`,
    message
  };
}
