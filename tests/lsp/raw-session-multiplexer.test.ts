import { describe, expect, it } from 'vitest';
import { createLspRequestMetricsCollector } from '../../src/server/lsp/requestMetrics';
import {
  createRawSessionMultiplexer,
  type RawSessionConsumerKind,
  type RawSessionMultiplexerOptions
} from '../../src/server/lsp/rawSessionMultiplexer';
import type { LspVirtualSession } from '../../src/server/lspWebSocketBridge';

const URI = 'file:///workspace/src/example.ts';

describe('RawSessionMultiplexer', () => {
  it('uses editor-owned documents without invoking the lazy disk reader', () => {
    const snapshots: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDocumentSnapshot: (snapshot) => snapshots.push(snapshot) });
    const editor = attach(multiplexer, 'raw-editor');

    editor.consumer.sendClientMessage(didOpen(URI, 'editor text', 7));
    const synced = (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => {
        throw new Error('disk should not be read for editor-owned document');
      }
    });

    expect(synced).toMatchObject({
      source: 'editor-live',
      snapshot: { uri: URI, languageId: 'typescript', version: 7, text: 'editor text' }
    });
    expect(session.sent.map((message: any) => message.method)).toEqual(['textDocument/didOpen']);
    expect(snapshots).toEqual([
      { state: 'editor-open', uri: URI, languageId: 'typescript', version: 7, text: 'editor text' }
    ]);
  });

  it('syncs disk documents lazily and only sends didChange when text changes', () => {
    const snapshots: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDocumentSnapshot: (snapshot) => snapshots.push(snapshot) });

    const first = (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk text v1' })
    });
    const second = (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk text v1' })
    });
    const third = (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk text v2' })
    });

    expect([first.source, second.source, third.source]).toEqual(['disk-cache', 'disk-cache', 'disk-cache']);
    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange'
    ]);
    expect((session.sent[0] as any).params.textDocument).toMatchObject({
      uri: URI,
      languageId: 'typescript',
      version: 1,
      text: 'disk text v1'
    });
    expect((session.sent[1] as any).params).toMatchObject({
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: 'disk text v2' }]
    });
    expect(snapshots).toEqual([
      { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 1, text: 'disk text v1' },
      { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 2, text: 'disk text v2' }
    ]);
  });

  it('restores disk-cache ownership when an editor closes over a cached disk document', () => {
    const snapshots: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDocumentSnapshot: (snapshot) => snapshots.push(snapshot) });
    const editor = attach(multiplexer, 'raw-editor');

    (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk text' })
    });
    editor.consumer.sendClientMessage(didOpen(URI, 'editor text', 5));
    editor.consumer.sendClientMessage(didClose(URI));

    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange'
    ]);
    expect(snapshots).toEqual([
      { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 1, text: 'disk text' },
      { state: 'editor-open', uri: URI, languageId: 'typescript', version: 5, text: 'editor text' },
      { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 6, text: 'disk text' }
    ]);

    multiplexer.closeAllDocuments();
    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange',
      'textDocument/didClose'
    ]);
    expect(snapshots.at(-1)).toEqual({ state: 'closed', uri: URI });
  });

  it('bumps duplicate editor didOpen over disk ownership to a monotonic full-content didChange', () => {
    const snapshots: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDocumentSnapshot: (snapshot) => snapshots.push(snapshot) });
    const editor = attach(multiplexer, 'raw-editor');

    (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk text' })
    });
    editor.consumer.sendClientMessage(didOpen(URI, 'editor text', 1));

    expect(session.sent.map((message: any) => message.method)).toEqual(['textDocument/didOpen', 'textDocument/didChange']);
    expect((session.sent[1] as any).params).toMatchObject({
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: 'editor text' }]
    });
    expect(snapshots).toEqual([
      { state: 'disk-cached', uri: URI, languageId: 'typescript', version: 1, text: 'disk text' },
      { state: 'editor-open', uri: URI, languageId: 'typescript', version: 2, text: 'editor text' }
    ]);
  });

  it('keeps subsequent editor incremental changes monotonic and snapshots full-buffer authoritative', () => {
    const snapshots: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDocumentSnapshot: (snapshot) => snapshots.push(snapshot) });
    const editor = attach(multiplexer, 'raw-editor');

    (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'const value = 1;\n' })
    });
    editor.consumer.sendClientMessage(didOpen(URI, 'const value = 1;\n', 1));
    editor.consumer.sendClientMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
            text: 'const next = 2;\n'
          }
        ]
      }
    });

    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange'
    ]);
    expect((session.sent[2] as any).params).toMatchObject({
      textDocument: { uri: URI, version: 3 },
      contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: 'const next = 2;\n' }]
    });
    expect(snapshots.at(-1)).toEqual({
      state: 'editor-open',
      uri: URI,
      languageId: 'typescript',
      version: 3,
      text: 'const value = 1;\nconst next = 2;\n'
    });
  });

  it('reverts to disk-cache with a monotonic version after a bumped editor duplicate-open closes', () => {
    const snapshots: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDocumentSnapshot: (snapshot) => snapshots.push(snapshot) });
    const editor = attach(multiplexer, 'raw-editor');

    (multiplexer as any).syncDocumentForRequest({
      uri: URI,
      languageId: 'typescript',
      readDisk: () => ({ text: 'disk text' })
    });
    editor.consumer.sendClientMessage(didOpen(URI, 'editor text', 1));
    editor.consumer.sendClientMessage(didClose(URI));

    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange'
    ]);
    expect((session.sent[2] as any).params).toMatchObject({
      textDocument: { uri: URI, version: 3 },
      contentChanges: [{ text: 'disk text' }]
    });
    expect(snapshots.at(-1)).toEqual({
      state: 'disk-cached',
      uri: URI,
      languageId: 'typescript',
      version: 3,
      text: 'disk text'
    });
  });

  it('routes duplicate downstream request ids back to the originating consumer', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    editor.consumer.sendClientMessage(request(1, 'textDocument/hover', { from: 'editor' }));
    internal.consumer.sendClientMessage(request(1, 'textDocument/completion', { from: 'internal' }));

    const editorUpstreamId = (session.sent[0] as any).id;
    const internalUpstreamId = (session.sent[1] as any).id;
    expect(editorUpstreamId).not.toBe(internalUpstreamId);

    session.emitServerMessage({ jsonrpc: '2.0', id: internalUpstreamId, result: 'internal-result' });
    session.emitServerMessage({ jsonrpc: '2.0', id: editorUpstreamId, result: 'editor-result' });

    expect(internal.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: 'internal-result' }]);
    expect(editor.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: 'editor-result' }]);
  });

  it('round-trips numeric and string ids in both directions', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');

    editor.consumer.sendClientMessage(request('client-id', 'textDocument/hover', {}));
    const clientUpstreamId = (session.sent[0] as any).id;
    session.emitServerMessage({ jsonrpc: '2.0', id: clientUpstreamId, result: 'client-result' });
    expect(editor.messages[0]).toEqual({ jsonrpc: '2.0', id: 'client-id', result: 'client-result' });

    session.emitServerMessage(request('server-id', 'workspace/configuration', { items: [] }));
    const serverDownstreamId = (editor.messages[1] as any).id;
    editor.consumer.sendClientMessage({ jsonrpc: '2.0', id: serverDownstreamId, result: ['config'] });
    expect(session.sent[1]).toEqual({ jsonrpc: '2.0', id: 'server-id', result: ['config'] });

    session.emitServerMessage(request(42, 'client/registerCapability', { registrations: [] }));
    const numericServerDownstreamId = (editor.messages[2] as any).id;
    editor.consumer.sendClientMessage({ jsonrpc: '2.0', id: numericServerDownstreamId, result: null });
    expect(session.sent[2]).toEqual({ jsonrpc: '2.0', id: 42, result: null });
  });

  it('isolates cancellation to the matching consumer and ignores late canceled responses', () => {
    const metrics = createLspRequestMetricsCollector({ enabled: true });
    const { session, multiplexer } = createHarness({ requestMetrics: metrics });
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    editor.consumer.sendClientMessage(request(1, 'textDocument/hover', { hold: 'editor' }));
    internal.consumer.sendClientMessage(request(1, 'textDocument/hover', { hold: 'internal' }));
    const editorUpstreamId = (session.sent[0] as any).id;
    const internalUpstreamId = (session.sent[1] as any).id;

    editor.consumer.sendClientMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } });
    expect(session.sent[2]).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: editorUpstreamId } });

    session.emitServerMessage({ jsonrpc: '2.0', id: editorUpstreamId, result: 'late-editor' });
    session.emitServerMessage({ jsonrpc: '2.0', id: internalUpstreamId, result: 'internal-result' });

    expect(editor.messages).toEqual([]);
    expect(internal.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: 'internal-result' }]);
    expect(metrics.snapshot().cancellations.total).toBe(1);
    expect(metrics.snapshot().lateResponseDrops.total).toBe(1);
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });
  });

  it('rejects eligible client requests over the per-consumer cap without blocking other consumers', () => {
    const metrics = createLspRequestMetricsCollector({ enabled: true });
    const { session, multiplexer } = createHarness({
      requestMetrics: metrics,
      requestCaps: { maxPendingPerConsumer: 1, maxPendingPerMethod: 10 }
    });
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    editor.consumer.sendClientMessage(request(1, 'textDocument/hover', { from: 'editor-first' }));
    editor.consumer.sendClientMessage(request(2, 'textDocument/completion', { from: 'editor-excess' }));
    internal.consumer.sendClientMessage(request(1, 'textDocument/completion', { from: 'internal' }));

    expect(session.sent.map((message: any) => [message.id, message.method, message.params])).toEqual([
      [1, 'textDocument/hover', { from: 'editor-first' }],
      [2, 'textDocument/completion', { from: 'internal' }]
    ]);
    expect(editor.messages).toEqual([
      { jsonrpc: '2.0', id: 2, error: { code: -32800, message: 'LSP request cap exceeded' } }
    ]);
    expect(internal.messages).toEqual([]);
    expect(metrics.snapshot().cancellations).toEqual({ total: 1, byMethod: { 'textDocument/completion': 1 } });
    expect(metrics.snapshot().pending.byMethod).toEqual({ 'textDocument/completion': 1, 'textDocument/hover': 1 });
  });

  it('rejects eligible client requests over the per-method cap without blocking other methods', () => {
    const { session, multiplexer } = createHarness({
      requestCaps: { maxPendingPerConsumer: 10, maxPendingPerMethod: 1 }
    });
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    editor.consumer.sendClientMessage(request(1, 'textDocument/hover', { from: 'editor' }));
    internal.consumer.sendClientMessage(request(1, 'textDocument/hover', { from: 'internal-excess' }));
    internal.consumer.sendClientMessage(request(2, 'textDocument/completion', { from: 'internal-completion' }));

    expect(session.sent.map((message: any) => [message.id, message.method, message.params])).toEqual([
      [1, 'textDocument/hover', { from: 'editor' }],
      [2, 'textDocument/completion', { from: 'internal-completion' }]
    ]);
    expect(internal.messages).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32800, message: 'LSP request cap exceeded' } }
    ]);
  });

  it('rejects eligible server requests over the selected-consumer cap without changing the socket lifetime', () => {
    const { session, multiplexer } = createHarness({
      requestCaps: { maxPendingPerConsumer: 1, maxPendingPerMethod: 10 }
    });
    const editor = attach(multiplexer, 'raw-editor');

    session.emitServerMessage(request('server-1', 'workspace/configuration', { items: [{ section: 'a' }] }));
    session.emitServerMessage(request('server-2', 'window/showMessageRequest', { message: 'excess' }));

    expect(editor.messages).toHaveLength(1);
    expect(editor.messages[0]).toMatchObject({ method: 'workspace/configuration' });
    expect(session.sent).toEqual([
      { jsonrpc: '2.0', id: 'server-2', error: { code: -32800, message: 'LSP request cap exceeded' } }
    ]);

    editor.consumer.sendClientMessage({ jsonrpc: '2.0', id: (editor.messages[0] as any).id, result: ['config'] });
    expect(session.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 'server-1', result: ['config'] });
  });

  it('never caps text sync, lifecycle, diagnostics, or file-operation safety messages', () => {
    const { session, multiplexer } = createHarness({
      requestCaps: { maxPendingPerConsumer: 0, maxPendingPerMethod: 0 }
    });
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    editor.consumer.sendClientMessage(didOpen(URI, 'editor text', 1));
    editor.consumer.sendClientMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'next text' }] }
    });
    editor.consumer.sendClientMessage(didClose(URI));
    editor.consumer.sendClientMessage(request(10, 'shutdown', {}));
    editor.consumer.sendClientMessage({ jsonrpc: '2.0', method: 'exit' });
    internal.consumer.sendClientMessage(request(11, 'textDocument/diagnostic', { textDocument: { uri: URI } }));
    internal.consumer.sendClientMessage(request(12, 'workspace/willRenameFiles', { files: [] }));
    session.emitServerMessage(request('apply-edit', 'workspace/applyEdit', { edit: { changes: {} } }));

    expect(session.sent.map((message: any) => [message.id, message.method])).toEqual([
      [undefined, 'textDocument/didOpen'],
      [undefined, 'textDocument/didChange'],
      [undefined, 'textDocument/didClose'],
      [1, 'shutdown'],
      [undefined, 'exit'],
      [2, 'textDocument/diagnostic'],
      [3, 'workspace/willRenameFiles']
    ]);
    expect(editor.messages).toEqual([
      {
        jsonrpc: '2.0',
        id: expect.stringMatching(/^mplex:/),
        method: 'workspace/applyEdit',
        params: { edit: { changes: {} } }
      }
    ]);
    expect(internal.messages).toEqual([]);
  });

  it('rejects client requests with invalid present ids without forwarding upstream', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');

    editor.consumer.sendClientMessage(requestWithInvalidId({ nested: true }));
    editor.consumer.sendClientMessage(requestWithInvalidId(null));
    editor.consumer.sendClientMessage(requestWithInvalidId(['array']));
    editor.consumer.sendClientMessage({ jsonrpc: '2.0', id: { response: true }, result: 'ignored' });

    expect(session.sent).toEqual([]);
    expect(editor.messages).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } }
    ]);
  });

  it('routes documentless server requests to the primary editor and maps the response upstream', () => {
    const { session, multiplexer } = createHarness();
    const primary = attach(multiplexer, 'raw-editor');
    const secondary = attach(multiplexer, 'raw-editor');

    session.emitServerMessage(request(7, 'workspace/configuration', { items: [] }));

    expect(primary.messages).toHaveLength(1);
    expect(secondary.messages).toEqual([]);
    expect((primary.messages[0] as any).id).toMatch(/^mplex:/);
    primary.consumer.sendClientMessage({ jsonrpc: '2.0', id: (primary.messages[0] as any).id, result: ['ok'] });

    expect(session.sent).toEqual([{ jsonrpc: '2.0', id: 7, result: ['ok'] }]);
  });

  it('answers server requests itself when no editor is attached and never fans out to internal consumers', () => {
    const { session, multiplexer } = createHarness();
    const internal = attach(multiplexer, 'internal-request-api');

    session.emitServerMessage(request(99, 'workspace/configuration', { items: [] }));

    expect(internal.messages).toEqual([]);
    expect(session.sent).toEqual([
      { jsonrpc: '2.0', id: 99, error: { code: -32601, message: 'unhandled request: workspace/configuration' } }
    ]);
  });

  it('intercepts pure dynamic file-operation registration requests before primary editor routing', () => {
    const handled: unknown[] = [];
    const { session, multiplexer } = createHarness({
      onServerRequest: (request) => {
        if (request.method === 'client/registerCapability') {
          handled.push(request.params);
          return { handled: true, result: null };
        }
        return { handled: false };
      }
    } as any);
    const internal = attach(multiplexer, 'internal-request-api');

    session.emitServerMessage(
      request(44, 'client/registerCapability', {
        registrations: [{ id: 'file-op', method: 'workspace/didRenameFiles', registerOptions: { filters: [] } }]
      })
    );

    expect(internal.messages).toEqual([]);
    expect(handled).toEqual([
      { registrations: [{ id: 'file-op', method: 'workspace/didRenameFiles', registerOptions: { filters: [] } }] }
    ]);
    expect(session.sent).toEqual([{ jsonrpc: '2.0', id: 44, result: null }]);
  });

  it('passes mixed dynamic registration requests through unchanged to the primary editor', () => {
    const { session, multiplexer } = createHarness({
      onServerRequest: () => ({ handled: false })
    } as any);
    const editor = attach(multiplexer, 'raw-editor');
    const mixed = {
      registrations: [
        { id: 'file-op', method: 'workspace/didRenameFiles', registerOptions: { filters: [] } },
        { id: 'completion', method: 'textDocument/completion', registerOptions: {} }
      ]
    };

    session.emitServerMessage(request(45, 'client/registerCapability', mixed));

    expect(editor.messages[0]).toMatchObject({ method: 'client/registerCapability', params: mixed });
    editor.consumer.sendClientMessage({ jsonrpc: '2.0', id: (editor.messages[0] as any).id, result: null });
    expect(session.sent).toEqual([{ jsonrpc: '2.0', id: 45, result: null }]);
  });

  it('rejects server requests with invalid present ids without fanout', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    session.emitServerMessage(requestWithInvalidId({ nested: true }));
    session.emitServerMessage(requestWithInvalidId(null));
    session.emitServerMessage(requestWithInvalidId(['array']));
    session.emitServerMessage({ jsonrpc: '2.0', id: { response: true }, result: 'ignored' });

    expect(editor.messages).toEqual([]);
    expect(internal.messages).toEqual([]);
    expect(session.sent).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC id' } }
    ]);
  });

  it('reassigns the primary editor deterministically when the selected editor disconnects', () => {
    const { session, multiplexer } = createHarness();
    const first = attach(multiplexer, 'raw-editor');
    const second = attach(multiplexer, 'raw-editor');

    session.emitServerMessage(request(1, 'workspace/configuration', {}));
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(0);

    first.consumer.dispose();
    session.emitServerMessage(request(2, 'workspace/configuration', {}));
    expect(second.messages).toHaveLength(1);
    second.consumer.sendClientMessage({ jsonrpc: '2.0', id: (second.messages[0] as any).id, result: 'second' });
    expect(session.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 2, result: 'second' });
  });

  it('settles pending server requests when the selected editor disconnects and ignores late responses', () => {
    const metrics = createLspRequestMetricsCollector({ enabled: true });
    const { session, multiplexer } = createHarness({ requestMetrics: metrics });
    const editor = attach(multiplexer, 'raw-editor');

    session.emitServerMessage(request('server', 'workspace/configuration', {}));
    expect(metrics.snapshot().pending.byMethod).toEqual({ 'workspace/configuration': 1 });
    const downstreamId = (editor.messages[0] as any).id;
    editor.consumer.dispose();
    editor.consumer.sendClientMessage({ jsonrpc: '2.0', id: downstreamId, result: 'late' });

    expect(session.sent).toEqual([
      { jsonrpc: '2.0', id: 'server', error: { code: -32800, message: 'client disconnected' } }
    ]);
    expect(metrics.snapshot().lateResponseDrops.total).toBe(1);
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });
  });

  it('records writer errors without swallowing them or mutating outbound messages', () => {
    const metrics = createLspRequestMetricsCollector({ enabled: true });
    const { session, multiplexer } = createHarness({ requestMetrics: metrics });
    session.throwOnSend = true;
    const editor = attach(multiplexer, 'raw-editor');

    expect(() => editor.consumer.sendClientMessage(request(1, 'textDocument/hover', { hold: true }))).toThrow(
      /synthetic writer failure/
    );
    expect(metrics.snapshot().writerErrors.total).toBe(1);
    expect(metrics.snapshot().pending).toEqual({ bySession: {}, byConsumer: {}, byMethod: {} });
    expect(session.sent).toEqual([]);
  });

  it('uses a collision-free owned namespace for server-request downstream ids', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');

    editor.consumer.sendClientMessage(request(1, 'textDocument/hover', {}));
    session.emitServerMessage(request(1, 'workspace/configuration', {}));

    expect((editor.messages[0] as any).id).toMatch(/^mplex:/);
    expect((editor.messages[0] as any).id).not.toBe(1);
  });

  it('fans diagnostics out only to interested editors while updating the diagnostics sink', () => {
    const diagnostics: unknown[] = [];
    const { session, multiplexer } = createHarness({ onDiagnostics: (entry) => diagnostics.push(entry) });
    const interested = attach(multiplexer, 'raw-editor');
    const uninterested = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    interested.consumer.sendClientMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: URI, languageId: 'typescript', version: 1, text: 'const value = 1;' } }
    });
    interested.messages.length = 0;

    const notification = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: URI, diagnostics: [] }
    };
    session.emitServerMessage(notification);

    expect(diagnostics).toEqual([{ method: 'textDocument/publishDiagnostics', params: notification.params }]);
    expect(interested.messages).toEqual([notification]);
    expect(uninterested.messages).toEqual([]);
    expect(internal.messages).toEqual([]);
  });

  it('does not deliver non-diagnostic server notifications to internal outputs', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    session.emitServerMessage({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: {
        message: 'token-root-serverCommands-env-should-not-reach-internal'
      }
    });

    expect(editor.messages).toEqual([]);
    expect(internal.messages).toEqual([]);
  });

  it('keeps editor-owned documents live and makes didClose idempotent', () => {
    const { session, multiplexer } = createHarness();
    const editor = attach(multiplexer, 'raw-editor');
    const internal = attach(multiplexer, 'internal-request-api');

    editor.consumer.sendClientMessage(didOpen(URI, 'editor text'));
    const live = internal.consumer.useDiskDocument({ uri: URI, languageId: 'typescript', version: 1, text: 'disk text' });
    expect(live.source).toBe('editor-live');
    live.release();
    expect(session.sent.map((message: any) => message.method)).toEqual(['textDocument/didOpen']);

    editor.consumer.sendClientMessage(didClose(URI));
    editor.consumer.sendClientMessage(didClose(URI));
    expect(session.sent.map((message: any) => message.method)).toEqual(['textDocument/didOpen', 'textDocument/didClose']);
  });

  it('keeps disk-cache documents open until simulated session stop cleanup', () => {
    const { session, multiplexer } = createHarness();
    const internal = attach(multiplexer, 'internal-request-api');
    const editor = attach(multiplexer, 'raw-editor');

    const disk = internal.consumer.useDiskDocument({ uri: URI, languageId: 'typescript', version: 1, text: 'disk text' });
    expect(disk.source).toBe('disk-cache');
    disk.release();
    expect(session.sent.map((message: any) => message.method)).toEqual(['textDocument/didOpen']);

    editor.consumer.sendClientMessage(didOpen(URI, 'editor text'));
    editor.consumer.sendClientMessage(didClose(URI));
    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange'
    ]);

    multiplexer.closeAllDocuments();
    multiplexer.closeAllDocuments();
    expect(session.sent.map((message: any) => message.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange',
      'textDocument/didClose'
    ]);
  });
});

function createHarness(
  options: Pick<
    RawSessionMultiplexerOptions,
    'onDiagnostics' | 'onDocumentSnapshot' | 'onServerRequest' | 'requestCaps' | 'requestMetrics'
  > = {}
) {
  const session = new FakeVirtualSession();
  const multiplexer = createRawSessionMultiplexer({
    session,
    onDiagnostics: options.onDiagnostics,
    onDocumentSnapshot: options.onDocumentSnapshot,
    onServerRequest: options.onServerRequest,
    requestCaps: options.requestCaps,
    requestMetrics: options.requestMetrics,
    sessionId: 'raw-test-session'
  });
  return { session, multiplexer };
}

function attach(multiplexer: ReturnType<typeof createRawSessionMultiplexer>, kind: RawSessionConsumerKind) {
  const messages: unknown[] = [];
  const consumer = multiplexer.attachConsumer({ kind, onMessage: (message) => messages.push(message) });
  return { consumer, messages };
}

function request(id: number | string, method: string, params: unknown) {
  return { jsonrpc: '2.0', id, method, params };
}

function requestWithInvalidId(id: unknown) {
  return { jsonrpc: '2.0', id, method: 'workspace/configuration', params: {} };
}

function didOpen(uri: string, text: string, version = 1) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'typescript', version, text } }
  };
}

function didClose(uri: string) {
  return {
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri } }
  };
}

class FakeVirtualSession implements LspVirtualSession {
  capabilities: Record<string, unknown> = { hoverProvider: true };
  sent: unknown[] = [];
  throwOnSend = false;
  private readonly serverListeners: Array<(message: unknown) => void> = [];
  private readonly exitListeners: Array<(exit: { code: number | null; signal: string | null }) => void> = [];

  sendClientMessage(message: unknown): void {
    if (this.throwOnSend) {
      throw new Error('synthetic writer failure');
    }
    this.sent.push(message);
  }

  onServerMessage(listener: (message: unknown) => void): void {
    this.serverListeners.push(listener);
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitListeners.push(listener);
  }

  dispose(): void {
    for (const listener of this.exitListeners) {
      listener({ code: null, signal: 'SIGTERM' });
    }
  }

  emitServerMessage(message: unknown): void {
    for (const listener of this.serverListeners) {
      listener(message);
    }
  }
}
