import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createCodexDriver,
  type CodexAppServerTransport,
  type CodexAppServerProcess,
  type CodexTransportEvent
} from '../../../../src/server/agents/drivers/codexDriver.js';
import { isDriverCommandError } from '../../../../src/server/agents/host/driver.js';

class FakeCodexTransport implements CodexAppServerTransport {
  readonly calls: Array<
    | { type: 'request'; method: string; params: unknown }
    | { type: 'notify'; method: string }
    | { type: 'respond'; requestId: string; result: unknown }
  > = [];
  closed = false;
  private listeners = new Set<(event: CodexTransportEvent) => void>();

  constructor(private readonly requestHandlers: Record<string, (params: unknown) => unknown>) {}

  onEvent(handler: (event: CodexTransportEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(event: CodexTransportEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ type: 'request', method, params });
    const handler = this.requestHandlers[method];
    if (!handler) {
      throw new Error(`unexpected request ${method}`);
    }
    return handler(params);
  }

  async notify(method: string): Promise<void> {
    this.calls.push({ type: 'notify', method });
  }

  async respond(requestId: string, result: unknown): Promise<void> {
    this.calls.push({ type: 'respond', requestId, result });
  }

  async close(): Promise<void> {
    this.closed = true;
    return undefined;
  }
}

class FakeAppServerProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly writes: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.writes.push(String(chunk)));
  }

  kill(): boolean {
    return true;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition not met');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    path: null,
    cwd: '/repo',
    cliVersion: 'codex-cli 0.142.5',
    source: 'codex-app-server',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides
  };
}

function turn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'turn-1',
    status: 'inProgress',
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    itemsView: 'full',
    items: [],
    ...overrides
  };
}

describe('createCodexDriver', () => {
  it('uses a real app-server transport by default while allowing an injected process for tests', async () => {
    const proc = new FakeAppServerProcess();
    const driver = createCodexDriver({ cwd: '/repo', model: 'gpt-5.5', transportOptions: { process: proc } });

    const start = driver.start();
    await waitFor(() => proc.writes.length >= 1);
    proc.stdout.write('{"id":"1","result":{"userAgent":"codex-cli 0.142.5","codexHome":"/tmp/codex-home","platformFamily":"unix","platformOs":"linux"}}\n');
    await waitFor(() => proc.writes.length >= 3);
    proc.stdout.write('{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-1","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"openai","createdAt":1,"updatedAt":1,"recencyAt":1,"status":{"type":"idle"},"path":null,"cwd":"/repo","cliVersion":"codex-cli 0.142.5","source":"codex-app-server","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}}}\n');
    proc.stdout.write('{"id":"2","result":{}}\n');

    await expect(start).resolves.toEqual({
      session: { agentSessionId: 'thread-1', model: 'gpt-5.5' },
      status: { kind: 'status', state: 'idle' }
    });
    expect(proc.writes).toEqual([
      '{"id":"1","method":"initialize","params":{"clientInfo":{"name":"desk","title":"Desk","version":"0.2.0"},"capabilities":null}}\n',
      '{"method":"initialized"}\n',
      '{"id":"2","method":"thread/start","params":{"cwd":"/repo","model":"gpt-5.5"}}\n'
    ]);
  });

  it('logs malformed app-server stdout at error level and keeps reading valid frames', async () => {
    const proc = new FakeAppServerProcess();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const driver = createCodexDriver({ cwd: '/repo', transportOptions: { process: proc } });

    try {
      const start = driver.start();
      await waitFor(() => proc.writes.length >= 1);
      proc.stdout.write('not-json\n');
      proc.stdout.write('{"id":"1","result":{"userAgent":"codex-cli 0.142.5","codexHome":"/tmp/codex-home","platformFamily":"unix","platformOs":"linux"}}\n');
      await waitFor(() => proc.writes.length >= 3);
      proc.stdout.write('{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-1","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"openai","createdAt":1,"updatedAt":1,"recencyAt":1,"status":{"type":"idle"},"path":null,"cwd":"/repo","cliVersion":"codex-cli 0.142.5","source":"codex-app-server","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}}}\n');
      proc.stdout.write('{"id":"2","result":{}}\n');

      await expect(start).resolves.toEqual({
        session: { agentSessionId: 'thread-1' },
        status: { kind: 'status', state: 'idle' }
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dropping malformed codex app-server stdout line'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs codex app-server responses and messages that do not match the transport protocol', () => {
    const proc = new FakeAppServerProcess();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const driver = createCodexDriver({ cwd: '/repo', transportOptions: { process: proc } });

    try {
      proc.stdout.write('{"id":"missing","result":{}}\n');
      proc.stdout.write('{"unexpected":true}\n');

      expect(driver).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dropping codex app-server response for unknown request id missing'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dropping unrecognized codex app-server message'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('initializes app-server, starts a fresh thread, and backfills committed history via thread/read', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/read': (params) => {
        expect(params).toEqual({ threadId: 'thread-1', includeTurns: true });
        return {
          thread: thread({
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1000,
                itemsView: 'full',
                items: [
                  { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: 'hello', text_elements: [] }] },
                  { type: 'agentMessage', id: 'assistant-1', text: 'hi there', phase: null, memoryCitation: null }
                ]
              }
            ]
          })
        };
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo', model: 'gpt-5.5' });

    const started = await driver.start();
    const history = await driver.fetchHistory();

    expect(transport.calls).toMatchObject([
      { type: 'request', method: 'initialize' },
      { type: 'notify', method: 'initialized' },
      { type: 'request', method: 'thread/start', params: { cwd: '/repo', model: 'gpt-5.5' } },
      { type: 'request', method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } }
    ]);
    expect(started).toEqual({
      session: { agentSessionId: 'thread-1', model: 'gpt-5.5' },
      status: { kind: 'status', state: 'idle' }
    });
    expect(history).toEqual([
      { kind: 'user-message', id: 'user-1', text: 'hello', source: 'external' },
      { kind: 'assistant-message', id: 'assistant-1', turnId: 'turn-1', markdown: 'hi there' },
      { kind: 'turn-complete', turnId: 'turn-1' }
    ]);
  });

  it('backfills command executions with start and end events so tool rows survive restart', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/read': () => ({
        thread: thread({
          turns: [
            turn({
              id: 'turn-1',
              status: 'completed',
              completedAt: 2,
              durationMs: 1000,
              items: [
                {
                  type: 'commandExecution',
                  id: 'cmd-1',
                  command: 'npm test',
                  cwd: '/repo',
                  processId: null,
                  source: 'user',
                  status: 'completed',
                  commandActions: [],
                  aggregatedOutput: 'ok\n',
                  exitCode: 0,
                  durationMs: 12
                }
              ]
            })
          ]
        })
      })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await driver.start();
    const history = await driver.fetchHistory();

    expect(history).toEqual([
      { kind: 'tool-start', toolUseId: 'cmd-1', name: 'command', summary: 'npm test', detail: '/repo' },
      { kind: 'tool-end', toolUseId: 'cmd-1', status: 'ok', summary: 'exit 0', detail: 'ok\n' },
      { kind: 'turn-complete', turnId: 'turn-1' }
    ]);
  });

  it('backfills non-command Codex tool items with start and end events so tool rows survive restart', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/read': () => ({
        thread: thread({
          turns: [
            turn({
              id: 'turn-1',
              status: 'completed',
              completedAt: 2,
              durationMs: 1000,
              items: [
                {
                  type: 'mcpToolCall',
                  id: 'mcp-1',
                  server: 'github',
                  tool: 'search_issues',
                  status: 'completed',
                  arguments: { q: 'desk' },
                  appContext: null,
                  pluginId: null,
                  result: { content: ['done'], structuredContent: null, _meta: null },
                  error: null,
                  durationMs: 34
                },
                {
                  type: 'dynamicToolCall',
                  id: 'dyn-1',
                  namespace: 'image_gen',
                  tool: 'imagegen',
                  arguments: { prompt: 'logo' },
                  status: 'failed',
                  contentItems: [{ type: 'inputText', text: 'generation failed' }],
                  success: false,
                  durationMs: 5
                },
                {
                  type: 'fileChange',
                  id: 'patch-1',
                  changes: [{ path: '/repo/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' }],
                  status: 'declined'
                },
                {
                  type: 'collabAgentToolCall',
                  id: 'agent-1',
                  tool: 'spawnAgent',
                  status: 'completed',
                  senderThreadId: 'thread-1',
                  receiverThreadIds: ['thread-child'],
                  prompt: 'inspect mapper',
                  model: 'gpt-5.5',
                  reasoningEffort: null,
                  agentsStates: {}
                },
                { type: 'webSearch', id: 'web-1', query: 'Codex app server', action: { type: 'search', query: 'Codex app server', queries: null } },
                { type: 'imageView', id: 'image-1', path: '/repo/screenshot.png' },
                { type: 'sleep', id: 'sleep-1', durationMs: 1000 },
                { type: 'imageGeneration', id: 'imagegen-1', status: 'completed', revisedPrompt: 'logo mark', result: 'ok', savedPath: '/repo/logo.png' }
              ]
            })
          ]
        })
      })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await driver.start();
    const history = await driver.fetchHistory();

    expect(history.map((event) => event.kind)).toEqual([
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'turn-complete'
    ]);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'mcp-1', name: 'mcp', summary: 'github.search_issues' }),
        expect.objectContaining({ kind: 'tool-end', toolUseId: 'mcp-1', status: 'ok' }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'dyn-1', name: 'dynamic-tool', summary: 'image_gen.imagegen' }),
        expect.objectContaining({ kind: 'tool-end', toolUseId: 'dyn-1', status: 'error', detail: expect.stringContaining('generation failed') }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'patch-1', name: 'file-change', summary: '1 file change' }),
        expect.objectContaining({ kind: 'tool-end', toolUseId: 'patch-1', status: 'denied' }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'agent-1', name: 'agent', summary: 'spawnAgent' }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'web-1', name: 'web-search', summary: 'Codex app server' }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'image-1', name: 'image-view', summary: '/repo/screenshot.png' }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'sleep-1', name: 'sleep', summary: '1000ms' }),
        expect.objectContaining({ kind: 'tool-start', toolUseId: 'imagegen-1', name: 'image-generation', summary: 'logo mark' })
      ])
    );
  });

  it('loads full Codex turn items from per-turn item pages when thread/read only returns summary turns', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/read': () => ({
        thread: thread({
          turns: [
            turn({
              id: 'turn-1',
              status: 'completed',
              itemsView: 'summary',
              items: [
                { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: 'please use tools', text_elements: [] }] },
                { type: 'agentMessage', id: 'assistant-1', text: 'done', phase: null, memoryCitation: null }
              ]
            })
          ]
        })
      }),
      'thread/turns/items/list': (params) => {
        expect(params).toEqual({ threadId: 'thread-1', turnId: 'turn-1', sortDirection: 'asc' });
        return {
          data: [
            { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: 'please use tools', text_elements: [] }] },
            {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pwd',
              cwd: '/repo',
              processId: null,
              source: 'user',
              status: 'completed',
              commandActions: [],
              aggregatedOutput: '/repo\n',
              exitCode: 0,
              durationMs: 12
            },
            {
              type: 'mcpToolCall',
              id: 'mcp-1',
              server: 'github',
              tool: 'search_issues',
              status: 'completed',
              arguments: { q: 'desk' },
              appContext: null,
              pluginId: null,
              result: { content: ['done'], structuredContent: null, _meta: null },
              error: null,
              durationMs: 34
            },
            {
              type: 'fileChange',
              id: 'patch-1',
              changes: [{ path: '/repo/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' }],
              status: 'completed'
            },
            { type: 'agentMessage', id: 'assistant-1', text: 'done', phase: null, memoryCitation: null }
          ],
          nextCursor: null,
          backwardsCursor: null
        };
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await driver.start();
    const history = await driver.fetchHistory();

    expect(history).toEqual([
      { kind: 'user-message', id: 'user-1', text: 'please use tools', source: 'external' },
      { kind: 'tool-start', toolUseId: 'cmd-1', name: 'command', summary: 'pwd', detail: '/repo' },
      { kind: 'tool-end', toolUseId: 'cmd-1', status: 'ok', summary: 'exit 0', detail: '/repo\n' },
      { kind: 'tool-start', toolUseId: 'mcp-1', name: 'mcp', summary: 'github.search_issues', detail: '{"q":"desk"}' },
      expect.objectContaining({ kind: 'tool-end', toolUseId: 'mcp-1', status: 'ok' }),
      { kind: 'tool-start', toolUseId: 'patch-1', name: 'file-change', summary: '1 file change', detail: '/repo/src/a.ts' },
      { kind: 'tool-end', toolUseId: 'patch-1', status: 'ok', summary: 'completed', detail: '/repo/src/a.ts' },
      { kind: 'assistant-message', id: 'assistant-1', turnId: 'turn-1', markdown: 'done' },
      { kind: 'turn-complete', turnId: 'turn-1' }
    ]);
  });

  it('surfaces an honest reload limitation when resumed Codex history has no recoverable tool items', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/resume': () => ({ thread: thread({ id: 'thread-1', status: { type: 'idle' } }) }),
      'thread/read': () => ({
        thread: thread({
          turns: [
            turn({
              id: 'turn-1',
              status: 'completed',
              itemsView: 'full',
              items: [
                { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: 'please use tools', text_elements: [] }] },
                { type: 'agentMessage', id: 'assistant-1', text: 'done', phase: null, memoryCitation: null }
              ]
            })
          ]
        })
      }),
      'thread/turns/items/list': (params) => {
        expect(params).toEqual({ threadId: 'thread-1', turnId: 'turn-1', sortDirection: 'asc' });
        return {
          data: [
            { type: 'userMessage', id: 'user-1', clientId: null, content: [{ type: 'text', text: 'please use tools', text_elements: [] }] },
            { type: 'agentMessage', id: 'assistant-1', text: 'done', phase: null, memoryCitation: null }
          ],
          nextCursor: null,
          backwardsCursor: null
        };
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo', resumeId: 'thread-1' });

    await driver.start();
    const firstHistory = await driver.fetchHistory();
    const secondHistory = await driver.fetchHistory();

    expect(firstHistory).toEqual([
      { kind: 'user-message', id: 'user-1', text: 'please use tools', source: 'external' },
      { kind: 'assistant-message', id: 'assistant-1', turnId: 'turn-1', markdown: 'done' },
      { kind: 'turn-complete', turnId: 'turn-1' },
      {
        kind: 'attention-hint',
        attention: 'session-status',
        detail: 'Codex app-server does not expose pre-reload tool call details for this transcript; earlier tool accordions may be unavailable.'
      }
    ]);
    expect(secondHistory).toEqual([
      { kind: 'user-message', id: 'user-1', text: 'please use tools', source: 'external' },
      { kind: 'assistant-message', id: 'assistant-1', turnId: 'turn-1', markdown: 'done' },
      { kind: 'turn-complete', turnId: 'turn-1' }
    ]);
    expect(transport.calls.some((call) => call.type === 'request' && call.method === 'thread/turns/list')).toBe(false);
    expect(transport.calls.some((call) => call.type === 'request' && call.method === 'thread/turns/items/list')).toBe(true);
  });

  it('does not emit turn-complete dividers for history turns with no renderable items', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/read': () => ({
        thread: thread({
          turns: [
            turn({
              id: 'reasoning-turn',
              status: 'completed',
              items: [{ type: 'reasoning', id: 'reasoning-1', summary: ['thinking'], content: [] }]
            })
          ]
        })
      })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await driver.start();
    await expect(driver.fetchHistory()).resolves.toEqual([]);
  });

  it('treats an unmaterialized fresh thread as empty history', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/read': () => {
        throw new Error('thread thread-1 is not materialized yet; includeTurns is unavailable before first user message');
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await driver.start();
    await expect(driver.fetchHistory()).resolves.toEqual([]);

    expect(transport.calls).toMatchObject([
      { type: 'request', method: 'initialize' },
      { type: 'notify', method: 'initialized' },
      { type: 'request', method: 'thread/start' },
      { type: 'request', method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } }
    ]);
  });

  it('accepts fresh thread metadata returned by thread/start without a thread/started notification', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => ({ thread: thread({ id: 'thread-from-result', status: { type: 'active', activeFlags: [] } }) })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await expect(driver.start()).resolves.toEqual({
      session: { agentSessionId: 'thread-from-result' },
      status: { kind: 'status', state: 'processing' }
    });
  });

  it('accepts resumed thread metadata returned by thread/resume without a thread/started notification', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/resume': () => ({ thread: thread({ id: 'thread-resumed', status: { type: 'idle' } }) })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo', resumeId: 'thread-resumed' });

    await expect(driver.start()).resolves.toEqual({
      session: { agentSessionId: 'thread-resumed' },
      status: { kind: 'status', state: 'idle' }
    });
  });

  it('does not report ready from thread/start before the request resolves', async () => {
    const started = deferred<unknown>();
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread({ id: 'thread-starting' }) } });
        return started.promise;
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    let resolved = false;

    const start = driver.start().then((value) => {
      resolved = true;
      return value;
    });
    await waitFor(() => transport.calls.some((call) => call.type === 'request' && call.method === 'thread/start'));
    await Promise.resolve();

    expect(resolved).toBe(false);

    started.resolve({});
    await expect(start).resolves.toEqual({
      session: { agentSessionId: 'thread-starting' },
      status: { kind: 'status', state: 'idle' }
    });
  });

  it('does not report ready from thread/resume before the request resolves', async () => {
    const resumed = deferred<unknown>();
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/resume': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread({ id: 'thread-resuming' }) } });
        return resumed.promise;
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo', resumeId: 'thread-resuming' });
    let resolved = false;

    const start = driver.start().then((value) => {
      resolved = true;
      return value;
    });
    await waitFor(() => transport.calls.some((call) => call.type === 'request' && call.method === 'thread/resume'));
    await Promise.resolve();

    expect(resolved).toBe(false);

    resumed.resolve({});
    await expect(start).resolves.toEqual({
      session: { agentSessionId: 'thread-resuming' },
      status: { kind: 'status', state: 'idle' }
    });
  });

  it('injects with turn/start while idle and turn/steer with expectedTurnId while a turn is active', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'turn/start': () => {
        transport.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn({ id: 'turn-1' }) } });
        return { turn: turn({ id: 'turn-1' }) };
      },
      'turn/steer': () => ({})
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    await driver.inject('first', 'ui');
    await driver.inject('second', 'channel');

    expect(transport.calls).toMatchObject([
      { type: 'request', method: 'initialize' },
      { type: 'notify', method: 'initialized' },
      { type: 'request', method: 'thread/start' },
      {
        type: 'request',
        method: 'turn/start',
        params: { threadId: 'thread-1', input: [{ type: 'text', text: 'first', text_elements: [] }] }
      },
      {
        type: 'request',
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-1',
          input: [{ type: 'text', text: 'second', text_elements: [] }]
        }
      }
    ]);
    expect(events).toEqual([
      { kind: 'status', state: 'processing' },
      { kind: 'user-message', id: expect.any(String), text: 'first', source: 'ui' },
      { kind: 'user-message', id: expect.any(String), text: 'second', source: 'channel' }
    ]);
  });

  it('/model updates Codex thread settings without starting a turn and emits session-info', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/settings/update': () => ({})
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();
    events.length = 0;

    await driver.inject('/model gpt-5.5-codex', 'ui');

    expect(transport.calls).toContainEqual({
      type: 'request',
      method: 'thread/settings/update',
      params: { threadId: 'thread-1', model: 'gpt-5.5-codex' }
    });
    expect(transport.calls.some((call) => call.type === 'request' && call.method === 'turn/start')).toBe(false);
    expect(events).toEqual([
      { kind: 'user-message', id: 'codex-user-1', text: '/model gpt-5.5-codex', source: 'ui' },
      { kind: 'session-info', agentSessionId: 'thread-1', model: 'gpt-5.5-codex' }
    ]);
  });

  it('/goal routes to Codex goal APIs without starting a turn', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'thread/goal/set': () => ({}),
      'thread/goal/clear': () => ({})
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();
    events.length = 0;

    await driver.inject('/goal finish native UI', 'channel');
    await driver.inject('/goal complete', 'channel');
    await driver.inject('/goal clear', 'channel');

    expect(transport.calls).toEqual(
      expect.arrayContaining([
        { type: 'request', method: 'thread/goal/set', params: { threadId: 'thread-1', objective: 'finish native UI' } },
        { type: 'request', method: 'thread/goal/set', params: { threadId: 'thread-1', status: 'complete' } },
        { type: 'request', method: 'thread/goal/clear', params: { threadId: 'thread-1' } }
      ])
    );
    expect(transport.calls.some((call) => call.type === 'request' && call.method === 'turn/start')).toBe(false);
    expect(events.filter((event) => (event as { kind?: string }).kind === 'user-message')).toHaveLength(3);
  });

  it('interactive Codex slash commands fail with unsupported-command instead of becoming model text', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    await driver.start();

    await expect(driver.inject('/login', 'ui')).rejects.toSatisfy((error: unknown) => {
      return isDriverCommandError(error) && error.code === 'unsupported-command' && error.retryable === false;
    });
    expect(transport.calls.some((call) => call.type === 'request' && call.method === 'turn/start')).toBe(false);
  });

  it('uses the user item id returned by turn/start for the optimistic user row', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'turn/start': () => ({
        turn: turn({
          id: 'turn-1',
          items: [{ type: 'userMessage', id: 'user-real-1', clientId: null, content: [{ type: 'text', text: 'first', text_elements: [] }] }]
        })
      })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));

    await driver.start();
    await driver.inject('first', 'ui');

    expect(events).toEqual([{ kind: 'user-message', id: 'user-real-1', text: 'first', source: 'ui' }]);
  });

  it('does not emit a local user row when Codex rejects the inject dispatch', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'turn/start': () => {
        throw new Error('dispatch failed');
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    await expect(driver.inject('lost message', 'channel')).rejects.toThrow('dispatch failed');

    expect(events).toEqual([]);
  });

  it('emits a non-fatal agent error and exited status when the app-server transport closes unexpectedly', async () => {
    const proc = new FakeAppServerProcess();
    const driver = createCodexDriver({ cwd: '/repo', transportOptions: { process: proc } });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));

    const start = driver.start();
    await waitFor(() => proc.writes.length >= 1);
    proc.stdout.write('{"id":"1","result":{"userAgent":"codex-cli 0.142.5","codexHome":"/tmp/codex-home","platformFamily":"unix","platformOs":"linux"}}\n');
    await waitFor(() => proc.writes.length >= 3);
    proc.stdout.write('{"method":"thread/started","params":{"thread":{"id":"thread-1","sessionId":"session-1","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"openai","createdAt":1,"updatedAt":1,"recencyAt":1,"status":{"type":"idle"},"path":null,"cwd":"/repo","cliVersion":"codex-cli 0.142.5","source":"codex-app-server","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}}}\n');
    proc.stdout.write('{"id":"2","result":{}}\n');
    await start;

    proc.emit('exit', 1, null);

    expect(events).toEqual([
      { kind: 'agent-error', fatal: false, message: 'codex app-server exited (1)' },
      { kind: 'status', state: 'exited' }
    ]);
  });

  it('normalizes assistant deltas, committed messages, and turn completion notifications', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    transport.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn({ id: 'turn-1' }) } });
    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'hel' } });
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'assistant-1', text: 'hello', phase: null, memoryCitation: null }
      }
    });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn({ id: 'turn-1', status: 'completed' }) } });

    expect(events).toEqual([
      { kind: 'status', state: 'processing' },
      { kind: 'assistant-delta', turnId: 'turn-1', text: 'hel' },
      { kind: 'assistant-message', id: 'assistant-1', turnId: 'turn-1', markdown: 'hello' },
      { kind: 'turn-complete', turnId: 'turn-1' },
      { kind: 'status', state: 'idle' }
    ]);
  });

  it('normalizes command execution item lifecycle into tool events', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    transport.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          processId: null,
          source: 'user',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: '',
          exitCode: null,
          durationMs: null
        }
      }
    });
    transport.emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', delta: 'ok\n' } });
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          processId: null,
          source: 'user',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'ok\n',
          exitCode: 0,
          durationMs: 12
        }
      }
    });

    expect(events).toEqual([
      { kind: 'tool-start', toolUseId: 'cmd-1', name: 'command', summary: 'npm test', detail: '/repo' },
      { kind: 'tool-output-delta', toolUseId: 'cmd-1', text: 'ok\n' },
      { kind: 'tool-end', toolUseId: 'cmd-1', status: 'ok', summary: 'exit 0', detail: 'ok\n' }
    ]);
  });

  it('normalizes non-command Codex tool lifecycles and progress into tool events', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    transport.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'github',
          tool: 'search_issues',
          status: 'inProgress',
          arguments: { q: 'desk' },
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
          durationMs: null
        }
      }
    });
    transport.emit({ method: 'item/mcpToolCall/progress', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp-1', message: 'calling github' } });
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'github',
          tool: 'search_issues',
          status: 'failed',
          arguments: { q: 'desk' },
          appContext: null,
          pluginId: null,
          result: null,
          error: { message: 'rate limited' },
          durationMs: 34
        }
      }
    });
    transport.emit({ method: 'item/fileChange/patchUpdated', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-1', changes: [{ path: '/repo/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' }] } });

    expect(events).toEqual([
      { kind: 'tool-start', toolUseId: 'mcp-1', name: 'mcp', summary: 'github.search_issues', detail: '{"q":"desk"}' },
      { kind: 'tool-output-delta', toolUseId: 'mcp-1', text: 'calling github' },
      { kind: 'tool-end', toolUseId: 'mcp-1', status: 'error', summary: 'failed', detail: 'rate limited' },
      { kind: 'tool-output-delta', toolUseId: 'patch-1', text: '/repo/src/a.ts' }
    ]);
  });

  it('drops live events and permission requests for other Codex threads', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    transport.emit({ method: 'turn/started', params: { threadId: 'other-thread', turn: turn({ id: 'other-turn' }) } });
    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: 'other-turn', itemId: 'assistant-1', delta: 'leak' } });
    transport.emit({
      method: 'item/started',
      params: {
        threadId: 'other-thread',
        turnId: 'other-turn',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          processId: null,
          source: 'user',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: '',
          exitCode: null,
          durationMs: null
        }
      }
    });
    transport.emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'other-thread', turnId: 'other-turn', itemId: 'cmd-1', delta: 'leak\n' } });
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'other-thread',
        turnId: 'other-turn',
        item: { type: 'agentMessage', id: 'assistant-1', text: 'leak', phase: null, memoryCitation: null }
      }
    });
    transport.emit({ method: 'turn/completed', params: { threadId: 'other-thread', turn: turn({ id: 'other-turn', status: 'completed' }) } });
    transport.emit({
      id: 'other-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'other-thread',
        turnId: 'other-turn',
        itemId: 'cmd-item',
        startedAtMs: 1,
        environmentId: null,
        reason: null,
        command: 'npm test',
        cwd: '/repo',
        availableDecisions: ['accept', 'decline']
      }
    });
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'other-thread', requestId: 'other-approval' } });

    expect(events).toEqual([]);
  });

  it('normalizes command, file, question permission requests and resolved notifications', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();

    transport.emit({
      id: 'cmd-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-item',
        startedAtMs: 1,
        environmentId: null,
        reason: 'needs network',
        command: 'npm test',
        cwd: '/repo',
        availableDecisions: ['accept', 'acceptForSession', 'decline']
      }
    });
    transport.emit({
      id: 'file-approval',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-item', startedAtMs: 1, reason: 'write docs', grantRoot: '/repo' }
    });
    transport.emit({
      id: 'question-approval',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'question-item',
        autoResolutionMs: null,
        questions: [
          {
            id: 'choice',
            header: 'Pick one',
            question: 'Which option?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'A', description: 'First' }]
          }
        ]
      }
    });
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'cmd-approval' } });
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'file-approval' } });
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'question-approval' } });

    expect(events).toEqual([
      { kind: 'status', state: 'awaiting-permission' },
      {
        kind: 'permission-request',
        requestId: 'cmd-approval',
        variant: 'command',
        title: 'Run command',
        detail: 'npm test\n\nneeds network',
        options: [
          { id: 'accept', label: 'Allow', treatment: 'allow' },
          { id: 'acceptForSession', label: 'Allow for session', treatment: 'allow-session' },
          { id: 'decline', label: 'Deny', treatment: 'deny' }
        ]
      },
      { kind: 'status', state: 'awaiting-permission' },
      {
        kind: 'permission-request',
        requestId: 'file-approval',
        variant: 'file-edit',
        title: 'Allow file changes',
        detail: 'write docs',
        options: [
          { id: 'accept', label: 'Allow', treatment: 'allow' },
          { id: 'decline', label: 'Deny', treatment: 'deny' }
        ]
      },
      { kind: 'status', state: 'awaiting-permission' },
      {
        kind: 'permission-request',
        requestId: 'question-approval',
        variant: 'question',
        title: 'Pick one',
        detail: 'Which option?',
        options: [{ id: 'choice:0', label: 'A', treatment: 'answer' }]
      },
      { kind: 'permission-resolved', requestId: 'cmd-approval', optionId: 'resolved', via: 'agent' },
      { kind: 'permission-resolved', requestId: 'file-approval', optionId: 'resolved', via: 'agent' },
      { kind: 'permission-resolved', requestId: 'question-approval', optionId: 'resolved', via: 'agent' },
      { kind: 'status', state: 'idle' }
    ]);
  });

  it('logs and surfaces malformed codex question requests instead of rendering an empty prompt', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));

    try {
      await driver.start();
      transport.emit({
        id: 'bad-question',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'question-item',
          autoResolutionMs: null,
          questions: []
        }
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('malformed codex user-input request bad-question'));
      expect(events).toContainEqual({
        kind: 'permission-request',
        requestId: 'bad-question',
        variant: 'question',
        title: 'Invalid question request',
        detail: 'Codex sent a user-input request without a valid question payload.',
        options: [{ id: 'dismiss', label: 'Dismiss', treatment: 'deny' }]
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('responds to command, file, and question permission requests by JSON-RPC request id', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      }
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();
    transport.emit({
      id: 'cmd-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-item',
        startedAtMs: 1,
        environmentId: null,
        command: 'npm test',
        availableDecisions: ['accept', 'decline']
      }
    });
    transport.emit({
      id: 'file-approval',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-item', startedAtMs: 1 }
    });
    transport.emit({
      id: 'question-approval',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'question-item',
        autoResolutionMs: null,
        questions: [
          {
            id: 'choice',
            header: 'Pick one',
            question: 'Which option?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'A', description: 'First' }]
          }
        ]
      }
    });

    await driver.respondPermission('cmd-approval', 'accept');
    await driver.respondPermission('file-approval', 'decline');
    await driver.respondPermission('question-approval', 'choice:0');
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'cmd-approval' } });
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'file-approval' } });
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'question-approval' } });

    expect(transport.calls.filter((call) => call.type === 'respond')).toEqual([
      { type: 'respond', requestId: 'cmd-approval', result: { decision: 'accept' } },
      { type: 'respond', requestId: 'file-approval', result: { decision: 'decline' } },
      { type: 'respond', requestId: 'question-approval', result: { answers: { choice: { answers: ['A'] } } } }
    ]);
    expect(events.filter((event) => typeof event === 'object' && event !== null && (event as { kind?: unknown }).kind === 'permission-resolved')).toEqual([
      { kind: 'permission-resolved', requestId: 'cmd-approval', optionId: 'accept', via: 'ui' },
      { kind: 'permission-resolved', requestId: 'file-approval', optionId: 'decline', via: 'ui' },
      { kind: 'permission-resolved', requestId: 'question-approval', optionId: 'choice:0', via: 'ui' }
    ]);
  });

  it('reports command preconditions before start as non-retryable', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });

    await expect(driver.inject('before start', 'ui')).rejects.toMatchObject({ code: 'adapter-unavailable', retryable: false });
    await expect(driver.fetchHistory()).rejects.toMatchObject({ code: 'adapter-unavailable', retryable: false });
  });

  it('interrupts the active turn and closes transport on shutdown without further event emissions', async () => {
    const transport = new FakeCodexTransport({
      initialize: () => ({ userAgent: 'codex-cli 0.142.5', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }),
      'thread/start': () => {
        transport.emit({ method: 'thread/started', params: { thread: thread() } });
        return {};
      },
      'turn/interrupt': () => ({ status: 'ok' })
    });
    const driver = createCodexDriver({ transport, cwd: '/repo' });
    const events: unknown[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start();
    transport.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn({ id: 'turn-1' }) } });

    await driver.interrupt();
    await driver.shutdown();
    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'late' } });

    expect(transport.calls).toMatchObject([
      { type: 'request', method: 'initialize' },
      { type: 'notify', method: 'initialized' },
      { type: 'request', method: 'thread/start' },
      { type: 'request', method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } }
    ]);
    expect(transport.closed).toBe(true);
    expect(events).toEqual([{ kind: 'status', state: 'processing' }]);
  });
});
