import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsRouter, createModelMarkerSink, nextDiagnosticsOwner, type DiagnosticsSink } from '../src/web/editor/lsp/diagnosticsRouter';
import type { MonacoMarkerData } from '../src/web/editor/lsp/diagnosticsAdapter';

/** A fake server->client notifier: capture the publishDiagnostics handler, emit at will, track unsubscribe. */
function makeNotifier() {
  let handler: ((params: unknown) => void) | null = null;
  let unsubscribed = false;
  const onNotification = (method: string, h: (params: unknown) => void): (() => void) => {
    if (method === 'textDocument/publishDiagnostics') {
      handler = h;
    }
    return () => {
      unsubscribed = true;
      handler = null;
    };
  };
  return {
    onNotification,
    emit: (params: unknown) => handler?.(params),
    isUnsubscribed: () => unsubscribed,
    hasHandler: () => handler !== null
  };
}

/** Owner-keyed marker store mimicking monaco.editor.setModelMarkers(model, owner, markers) namespacing. */
function makeStore() {
  const store = new Map<string, MonacoMarkerData[]>();
  const sinkFor = (owner: string): DiagnosticsSink => ({
    set: (uri, markers) => store.set(`${owner}|${uri}`, markers)
  });
  return { store, sinkFor, get: (owner: string, uri: string) => store.get(`${owner}|${uri}`) };
}

const diag = (line: number, message = 'boom') => ({
  range: { start: { line, character: 0 }, end: { line, character: 4 } },
  message,
  severity: 1
});

describe('nextDiagnosticsOwner', () => {
  it('mints distinct, language-scoped owners per call', () => {
    const a = nextDiagnosticsOwner('typescript');
    const b = nextDiagnosticsOwner('typescript');
    expect(a).not.toBe(b);
    expect(a.startsWith('lsp:typescript:')).toBe(true);
    expect(b.startsWith('lsp:typescript:')).toBe(true);
  });
});

describe('createDiagnosticsRouter', () => {
  it('routes a valid publishDiagnostics to the sink by uri (1-based markers)', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///a.ts', diagnostics: [diag(0)] });
    const markers = store.get(owner, 'file:///a.ts')!;
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5, message: 'boom' });
  });

  it('clears markers only on a valid empty diagnostics array', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///a.ts', diagnostics: [diag(0)] });
    notifier.emit({ uri: 'file:///a.ts', diagnostics: [] });
    expect(store.get(owner, 'file:///a.ts')).toEqual([]);
  });

  it('ignores malformed payloads without throwing or setting markers', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    const setSpy = vi.fn();
    createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: { set: setSpy } });
    expect(() => {
      notifier.emit(null);
      notifier.emit('nope');
      notifier.emit({ diagnostics: [diag(0)] }); // missing uri
      notifier.emit({ uri: 42, diagnostics: [diag(0)] }); // wrong uri type
      notifier.emit({ uri: 'file:///a.ts', diagnostics: 'not-array' });
      notifier.emit({ uri: 'file:///a.ts', diagnostics: [{ message: 'no range' }] }); // malformed entry only
    }).not.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('keeps only well-formed diagnostic entries when an array mixes valid and malformed', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///a.ts', diagnostics: [diag(0), { message: 'no range' }, diag(2)] });
    expect(store.get(owner, 'file:///a.ts')).toHaveLength(2);
  });

  it('dispose unsubscribes and clears every uri it set', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///a.ts', diagnostics: [diag(0)] });
    notifier.emit({ uri: 'file:///b.ts', diagnostics: [diag(1)] });
    router.dispose();
    expect(notifier.isUnsubscribed()).toBe(true);
    expect(store.get(owner, 'file:///a.ts')).toEqual([]);
    expect(store.get(owner, 'file:///b.ts')).toEqual([]);
    notifier.emit({ uri: 'file:///a.ts', diagnostics: [diag(0)] }); // post-dispose: no effect
    expect(store.get(owner, 'file:///a.ts')).toEqual([]);
  });

  it('A-vs-B: disposing old session A does not clear replacement B markers (same language + uri)', () => {
    const store = makeStore();
    const ownerA = nextDiagnosticsOwner('typescript');
    const ownerB = nextDiagnosticsOwner('typescript');
    const nA = makeNotifier();
    const nB = makeNotifier();
    const routerA = createDiagnosticsRouter({ onNotification: nA.onNotification, sink: store.sinkFor(ownerA) });
    createDiagnosticsRouter({ onNotification: nB.onNotification, sink: store.sinkFor(ownerB) });
    nA.emit({ uri: 'file:///a.ts', diagnostics: [diag(0, 'A')] });
    nB.emit({ uri: 'file:///a.ts', diagnostics: [diag(0, 'B')] });

    routerA.dispose();

    expect(store.get(ownerA, 'file:///a.ts')).toEqual([]); // A cleared
    expect(store.get(ownerB, 'file:///a.ts')).toHaveLength(1); // B intact
    expect(store.get(ownerB, 'file:///a.ts')![0]!.message).toBe('B');
  });

  // rust-analyzer is push-only for diagnostics: it pushes publishDiagnostics but its
  // textDocument/diagnostic pull is repeatedly empty. Since push+pull share one owner bucket,
  // an empty pull MUST NOT clobber the markers a push already delivered.
  it('empty pull does NOT clear a uri that push already populated', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('rust');
    const notifier = makeNotifier();
    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///main.rs', diagnostics: [diag(0, 'cannot find value')] }); // push count=1
    router.applyPull('file:///main.rs', []); // empty pull -> must be ignored, not a clear
    const markers = store.get(owner, 'file:///main.rs');
    expect(markers).toHaveLength(1);
    expect(markers![0]!.message).toBe('cannot find value');
  });

  it('a later empty PUSH still clears push diagnostics (legitimate clear preserved)', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('rust');
    const notifier = makeNotifier();
    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///main.rs', diagnostics: [diag(0)] }); // push count=1
    router.applyPull('file:///main.rs', []); // empty pull preserved
    notifier.emit({ uri: 'file:///main.rs', diagnostics: [] }); // authoritative push clear
    expect(store.get(owner, 'file:///main.rs')).toEqual([]);
  });

  it('a non-empty pull still applies (pull authoritative when it has items)', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    router.applyPull('file:///b.ts', [diag(1)]);
    expect(store.get(owner, 'file:///b.ts')).toHaveLength(1);
  });

  it('an empty pull still clears a uri that ONLY pull populated (no regression for pull-only servers)', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('typescript');
    const notifier = makeNotifier();
    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    router.applyPull('file:///c.ts', [diag(0)]); // pull populates
    router.applyPull('file:///c.ts', []); // empty pull -> clears (pull-owned, authoritative)
    expect(store.get(owner, 'file:///c.ts')).toEqual([]);
  });

  it('dispose still clears a push-populated uri even after an empty pull preserved it', () => {
    const store = makeStore();
    const owner = nextDiagnosticsOwner('rust');
    const notifier = makeNotifier();
    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink: store.sinkFor(owner) });
    notifier.emit({ uri: 'file:///main.rs', diagnostics: [diag(0)] });
    router.applyPull('file:///main.rs', []); // preserved
    router.dispose();
    expect(store.get(owner, 'file:///main.rs')).toEqual([]);
  });
});

describe('createModelMarkerSink (real-sink lifecycle, monaco-free)', () => {
  it('closed/disposed model: no-op, no throw, no setModelMarkers side effect', () => {
    const setModelMarkers = vi.fn();
    const sink = createModelMarkerSink({
      owner: 'lsp:typescript:1',
      getModel: () => null, // model gone (closed/disposed)
      setModelMarkers
    });
    expect(() => sink.set('file:///gone.ts', [{ severity: 8, message: 'x', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }])).not.toThrow();
    expect(setModelMarkers).not.toHaveBeenCalled();
  });

  it('present model: applies LSP markers under the owner AND clears the built-in owner (languageId)', () => {
    const calls: Array<{ owner: string; count: number }> = [];
    const model = { getLanguageId: () => 'typescript' };
    const sink = createModelMarkerSink<typeof model>({
      owner: 'lsp:typescript:1',
      getModel: () => model,
      setModelMarkers: (_model, owner, markers) => calls.push({ owner, count: markers.length })
    });
    sink.set('file:///a.ts', [{ severity: 8, message: 'x', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }]);
    expect(calls).toEqual([
      { owner: 'lsp:typescript:1', count: 1 }, // LSP markers applied
      { owner: 'typescript', count: 0 } // built-in worker owner cleared (no duplicate)
    ]);
  });

  it('clears existing built-in markers immediately when diagnostics attach, before any server publish', () => {
    const calls: Array<{ owner: string; count: number }> = [];
    const model = { getLanguageId: () => 'typescript' };
    const notifier = makeNotifier();
    const sink = createModelMarkerSink<typeof model>({
      owner: 'lsp:typescript:1',
      getModel: () => model,
      getModels: () => [model],
      setModelMarkers: (_model, owner, markers) => calls.push({ owner, count: markers.length })
    });

    createDiagnosticsRouter({ onNotification: notifier.onNotification, sink });

    expect(calls).toEqual([{ owner: 'typescript', count: 0 }]);
    expect(notifier.hasHandler()).toBe(true);
  });

  it('can clear existing built-in markers again for models opened after diagnostics attach', () => {
    const calls: Array<{ owner: string; count: number }> = [];
    const model = { getLanguageId: () => 'typescript' };
    const notifier = makeNotifier();
    const sink = createModelMarkerSink<typeof model>({
      owner: 'lsp:typescript:1',
      getModel: () => model,
      getModels: () => [model],
      setModelMarkers: (_model, owner, markers) => calls.push({ owner, count: markers.length })
    });

    const router = createDiagnosticsRouter({ onNotification: notifier.onNotification, sink });
    calls.length = 0;
    router.clearBuiltInMarkers();

    expect(calls).toEqual([{ owner: 'typescript', count: 0 }]);
  });
});
