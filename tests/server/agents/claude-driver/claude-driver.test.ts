import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '../../../../src/server/agents/host/driver';
import { isDriverCommandError } from '../../../../src/server/agents/host/driver';
import {
  createClaudeDriver,
  type ClaudeQueryConfig,
  type ClaudeSdkBoundary,
  type ClaudeSdkMessage
} from '../../../../src/server/agents/drivers/claudeDriver';

/**
 * Scripted SDK boundary: the test pushes SDK-shaped messages and observes the
 * normalized DriverEvents. No claude binary involved; the real-binary probe is
 * a separate gated integration test.
 */
class FakeQuery implements AsyncIterable<ClaudeSdkMessage> {
  private queue: ClaudeSdkMessage[] = [];
  private waiters: Array<(value: IteratorResult<ClaudeSdkMessage>) => void> = [];
  private done = false;
  interrupts = 0;
  setModelCalls: Array<string | undefined> = [];

  async setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model);
  }

  push(message: ClaudeSdkMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as never });
    }
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ done: false, value: this.queue.shift() as ClaudeSdkMessage });
        }
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined as never });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

interface Harness {
  driver: ReturnType<typeof createClaudeDriver>;
  query: FakeQuery;
  events: DriverEvent[];
  config: () => ClaudeQueryConfig;
  history: ClaudeSdkMessage[];
  pushedMessages: Array<Record<string, unknown>>;
  readonly setModelCalls: Array<string | undefined>;
}

function harness(options: { resume?: string; history?: ClaudeSdkMessage[]; omitHistoryApi?: boolean; omitSetModel?: boolean } = {}): Harness {
  const query = new FakeQuery();
  if (options.omitSetModel) {
    (query as { setModel?: unknown }).setModel = undefined;
  }
  let captured: ClaudeQueryConfig | undefined;
  const history = options.history ?? [];
  const pushedMessages: Array<Record<string, unknown>> = [];
  const sdk: ClaudeSdkBoundary = {
    query: (config) => {
      captured = config;
      void (async () => {
        for await (const m of config.prompt) pushedMessages.push(m);
      })();
      return query;
    },
    ...(options.omitHistoryApi
      ? {}
      : {
          getSessionMessages: async () => history
        })
  };
  const driver = createClaudeDriver({ cwd: '/tmp/project', resume: options.resume, bypassPermissions: false, sdk });
  const events: DriverEvent[] = [];
  driver.onEvent((event) => events.push(event));
  return {
    driver,
    query,
    events,
    history,
    pushedMessages,
    get setModelCalls() {
      return query.setModelCalls;
    },
    config: () => {
      if (!captured) {
        throw new Error('query was not called');
      }
      return captured;
    }
  };
}

const INIT: ClaudeSdkMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-uuid-1',
  model: 'claude-fable-5'
};

async function startedHarness(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness(options);
  // start() must resolve WITHOUT any message from the CLI: in streaming-input
  // mode init only arrives after the first user message (live-probe finding).
  const result = await h.driver.start();
  expect(result.status).toMatchObject({ kind: 'status', state: 'idle' });
  h.query.push(INIT);
  await drain();
  return h;
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('claudeDriver start', () => {
  it('resolves before init, passes resume + parity options, and surfaces init as session-info', async () => {
    const h = harness({ resume: 'sess-uuid-1' });
    const result = await h.driver.start();
    expect(result.session).toEqual({ agentSessionId: 'sess-uuid-1' });
    expect(result.status).toMatchObject({ kind: 'status', state: 'idle' });

    const config = h.config();
    expect(config.options.resume).toBe('sess-uuid-1');
    expect(config.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(config.options.cwd).toBe('/tmp/project');
    expect(typeof config.options.canUseTool).toBe('function');

    h.query.push(INIT);
    await drain();
    expect(h.events.find((event) => event.kind === 'session-info')).toMatchObject({
      kind: 'session-info',
      agentSessionId: 'sess-uuid-1',
      model: 'claude-fable-5'
    });
  });

  it('throws when the session ends immediately after launch', async () => {
    const h = harness();
    h.query.finish();
    await expect(h.driver.start()).rejects.toThrow(/ended immediately/);
  });
});

describe('claudeDriver turn flow', () => {
  it('emits user-message on inject, streams deltas, commits, and completes the turn', async () => {
    const h = await startedHarness();
    await h.driver.inject('hello there', 'channel');
    await drain();

    const userEvent = h.events.find((event) => event.kind === 'user-message');
    expect(userEvent).toMatchObject({ kind: 'user-message', text: 'hello there', source: 'channel' });
    expect(h.events.some((event) => event.kind === 'status' && event.state === 'processing')).toBe(true);

    h.query.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } }
    });
    h.query.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'friend' } }
    });
    h.query.push({
      type: 'assistant',
      uuid: 'msg-1',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Hi friend' }] }
    });
    h.query.push({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 4 }, total_cost_usd: 0.01 });
    await drain();

    const deltas = h.events.filter((event) => event.kind === 'assistant-delta');
    expect(deltas.map((event) => (event.kind === 'assistant-delta' ? event.text : ''))).toEqual(['Hi ', 'friend']);
    const committed = h.events.find((event) => event.kind === 'assistant-message');
    expect(committed).toMatchObject({ kind: 'assistant-message', markdown: 'Hi friend' });
    if (committed?.kind === 'assistant-message' && deltas[0]?.kind === 'assistant-delta') {
      expect(committed.turnId).toBe(deltas[0].turnId);
    }
    const complete = h.events.find((event) => event.kind === 'turn-complete');
    expect(complete).toMatchObject({
      kind: 'turn-complete',
      usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 }
    });
    const last = h.events[h.events.length - 1];
    expect(last).toMatchObject({ kind: 'status', state: 'idle' });
  });

  it('maps tool_use blocks and tool results to tool-start/tool-end', async () => {
    const h = await startedHarness();
    await h.driver.inject('run it', 'ui');

    h.query.push({
      type: 'assistant',
      uuid: 'msg-2',
      message: {
        id: 'msg-2',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]
      }
    });
    await drain();
    expect(h.events.find((event) => event.kind === 'tool-start')).toMatchObject({
      kind: 'tool-start',
      toolUseId: 'toolu_1',
      name: 'Bash'
    });
    expect(h.events.some((event) => event.kind === 'status' && event.state === 'tool-executing')).toBe(true);

    h.query.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'file.txt' }]
      }
    });
    await drain();
    expect(h.events.find((event) => event.kind === 'tool-end')).toMatchObject({
      kind: 'tool-end',
      toolUseId: 'toolu_1',
      status: 'ok'
    });

    h.query.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'boom' }]
      }
    });
    await drain();
    expect(h.events.filter((event) => event.kind === 'tool-end').pop()).toMatchObject({
      kind: 'tool-end',
      toolUseId: 'toolu_2',
      status: 'error'
    });
  });
});

describe('claudeDriver permissions', () => {
  it('round-trips a Bash permission request as a command variant', async () => {
    const h = await startedHarness();
    const canUseTool = h.config().options.canUseTool;
    if (!canUseTool) {
      throw new Error('canUseTool missing');
    }

    const decision = canUseTool('Bash', { command: 'rm -rf /tmp/x' }, {});
    await drain();
    const request = h.events.find((event) => event.kind === 'permission-request');
    expect(request).toMatchObject({ kind: 'permission-request', variant: 'command' });
    expect(h.events.some((event) => event.kind === 'status' && event.state === 'awaiting-permission')).toBe(true);
    if (request?.kind !== 'permission-request') {
      throw new Error('no permission request');
    }
    expect(request.options.map((option) => option.treatment)).toEqual(expect.arrayContaining(['allow', 'deny']));

    await h.driver.respondPermission(request.requestId, 'allow');
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    await drain();
    expect(h.events.find((event) => event.kind === 'permission-resolved')).toMatchObject({
      kind: 'permission-resolved',
      requestId: request.requestId,
      optionId: 'allow',
      via: 'ui'
    });
  });

  it('maps deny with a note to a deny decision carrying the message', async () => {
    const h = await startedHarness();
    const canUseTool = h.config().options.canUseTool;
    if (!canUseTool) {
      throw new Error('canUseTool missing');
    }
    const decision = canUseTool('Edit', { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' }, {});
    await drain();
    const request = h.events.find((event) => event.kind === 'permission-request');
    if (request?.kind !== 'permission-request') {
      throw new Error('no permission request');
    }
    expect(request.variant).toBe('file-edit');
    expect(request.diff).toMatchObject({ path: '/tmp/a.ts', before: 'x', after: 'y' });

    await h.driver.respondPermission(request.requestId, 'deny', 'not in this repo');
    await expect(decision).resolves.toMatchObject({ behavior: 'deny', message: 'not in this repo' });
  });

  it('emits AskUserQuestion as a question variant with answer options', async () => {
    const h = await startedHarness();
    const canUseTool = h.config().options.canUseTool;
    if (!canUseTool) {
      throw new Error('canUseTool missing');
    }
    void canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which db?',
            options: [{ label: 'sqlite' }, { label: 'postgres' }]
          }
        ]
      },
      {}
    );
    await drain();
    const request = h.events.find((event) => event.kind === 'permission-request');
    if (request?.kind !== 'permission-request') {
      throw new Error('no permission request');
    }
    expect(request.variant).toBe('question');
    expect(request.options.every((option) => option.treatment === 'answer' || option.treatment === 'custom')).toBe(true);
    expect(request.options.map((option) => option.label)).toEqual(expect.arrayContaining(['sqlite', 'postgres']));
  });

  it('rejects a response to an unknown permission with a typed error', async () => {
    const h = await startedHarness();
    await expect(h.driver.respondPermission('nope', 'allow')).rejects.toSatisfy((error: unknown) => {
      return isDriverCommandError(error) && error.code === 'unknown-permission' && error.retryable === false;
    });
  });
});

describe('claudeDriver interrupt and shutdown', () => {
  it('forwards interrupt to the query and reports the interrupted state', async () => {
    const h = await startedHarness();
    await h.driver.inject('long task', 'ui');
    await h.driver.interrupt();
    await drain();
    expect(h.query.interrupts).toBe(1);
    expect(h.events.some((event) => event.kind === 'status' && event.state === 'interrupted')).toBe(true);
  });

  it('rejects inject after shutdown with a non-retryable typed error', async () => {
    const h = await startedHarness();
    await h.driver.shutdown();
    await expect(h.driver.inject('too late', 'ui')).rejects.toSatisfy((error: unknown) => {
      return isDriverCommandError(error) && error.retryable === false;
    });
  });

  it('surfaces an unexpected stream end as a non-fatal error and exited state', async () => {
    const h = await startedHarness();
    h.query.finish();
    await drain();
    const error = h.events.find((event) => event.kind === 'agent-error');
    expect(error).toMatchObject({ kind: 'agent-error', fatal: false });
    expect(h.events[h.events.length - 1]).toMatchObject({ kind: 'status', state: 'exited' });
  });

  it('does not report a stream end caused by shutdown', async () => {
    const h = await startedHarness();
    await h.driver.shutdown();
    h.query.finish();
    await drain();
    expect(h.events.some((event) => event.kind === 'agent-error')).toBe(false);
    expect(h.events.some((event) => event.kind === 'status' && event.state === 'exited')).toBe(false);
  });

  it('stops emitting events after shutdown', async () => {
    const h = await startedHarness();
    await h.driver.shutdown();
    const count = h.events.length;
    h.query.push({
      type: 'assistant',
      uuid: 'late',
      message: { id: 'late', content: [{ type: 'text', text: 'ghost' }] }
    });
    await drain();
    expect(h.events.length).toBe(count);
  });
});

describe('claudeDriver slash commands', () => {
  it('/model routes to Query.setModel without starting a turn and emits session-info with the new model', async () => {
    const h = await startedHarness();
    h.events.length = 0;
    await h.driver.inject('/model sonnet', 'ui');
    expect(h.setModelCalls).toEqual(['sonnet']);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('user-message');
    expect(kinds).toContain('session-info');
    const info = h.events.find((e) => e.kind === 'session-info') as { model?: string };
    expect(info.model).toBe('sonnet');
    // No prompt was pushed — the SDK stream got nothing.
    expect(h.pushedMessages).toHaveLength(0);
  });

  it('/model without setModel support fails with unsupported-command', async () => {
    const h = await startedHarness({ omitSetModel: true });
    await expect(h.driver.inject('/model sonnet', 'ui')).rejects.toSatisfy((error: unknown) => {
      return isDriverCommandError(error) && error.code === 'unsupported-command' && error.retryable === false;
    });
  });

  it('interactive commands (/login) fail with unsupported-command instead of hanging the stream', async () => {
    const h = await startedHarness();
    await expect(h.driver.inject('/login', 'ui')).rejects.toSatisfy((error: unknown) => {
      return isDriverCommandError(error) && error.code === 'unsupported-command';
    });
    expect(h.pushedMessages).toHaveLength(0);
  });

  it('other slash text passes through to the SDK stream as a prompt (CLI processes it)', async () => {
    const h = await startedHarness();
    h.events.length = 0;
    await h.driver.inject('/compact', 'ui');
    expect(h.pushedMessages).toHaveLength(1);
    expect(h.events.some((e) => e.kind === 'user-message')).toBe(true);
  });

  it('plain text is unaffected', async () => {
    const h = await startedHarness();
    await h.driver.inject('hello there', 'ui');
    expect(h.pushedMessages).toHaveLength(1);
  });
});

describe('claudeDriver fetchHistory', () => {
  it('maps stored user and assistant messages to committed payloads with external source', async () => {
    const h = await startedHarness({
      resume: 'sess-uuid-1',
      history: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'earlier question' } },
        {
          type: 'assistant',
          uuid: 'a1',
          message: { id: 'a1', content: [{ type: 'text', text: 'earlier answer' }] }
        }
      ]
    });
    const events = await h.driver.fetchHistory();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'user-message', text: 'earlier question', source: 'external' });
    expect(events[1]).toMatchObject({ kind: 'assistant-message', markdown: 'earlier answer' });
    expect(events.some((event) => event.kind === 'history-boundary')).toBe(false);
  });

  it('maps tool_use and tool_result blocks so accordions survive a restart (human BUG: tool calls vanish)', async () => {
    const h = await startedHarness({
      resume: 'sess-uuid-1',
      history: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'run pwd please' } },
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            id: 'a1',
            content: [
              { type: 'text', text: 'Running it now.' },
              { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'pwd' } }
            ]
          }
        },
        {
          type: 'user',
          uuid: 'u2',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '/tmp/workspace', is_error: false }]
          }
        },
        {
          type: 'assistant',
          uuid: 'a2',
          message: { id: 'a2', content: [{ type: 'text', text: 'You are in /tmp/workspace.' }] }
        }
      ]
    });
    const events = await h.driver.fetchHistory();
    const kinds = events.map((event) => event.kind);
    expect(kinds).toEqual(['user-message', 'tool-start', 'assistant-message', 'tool-end', 'assistant-message']);
    expect(events[1]).toMatchObject({ kind: 'tool-start', toolUseId: 'toolu_01', name: 'Bash' });
    expect(events[3]).toMatchObject({ kind: 'tool-end', toolUseId: 'toolu_01', status: 'ok', summary: '/tmp/workspace' });
  });

  it('maps an error tool_result to tool-end status=error', async () => {
    const h = await startedHarness({
      resume: 'sess-uuid-1',
      history: [
        {
          type: 'assistant',
          uuid: 'a1',
          message: { id: 'a1', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'boom' } }] }
        },
        {
          type: 'user',
          uuid: 'u1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'command failed', is_error: true }]
          }
        }
      ]
    });
    const events = await h.driver.fetchHistory();
    expect(events.map((e) => e.kind)).toEqual(['tool-start', 'tool-end']);
    expect(events[1]).toMatchObject({ kind: 'tool-end', toolUseId: 'toolu_02', status: 'error' });
  });

  it('returns empty history for sessions without a resume id', async () => {
    const h = await startedHarness();
    await expect(h.driver.fetchHistory()).resolves.toEqual([]);
  });

  it('throws a typed adapter-unavailable error when the SDK cannot list messages', async () => {
    const h = await startedHarness({ resume: 'sess-uuid-1', omitHistoryApi: true });
    await expect(h.driver.fetchHistory()).rejects.toSatisfy((error: unknown) => {
      return isDriverCommandError(error) && error.code === 'adapter-unavailable';
    });
  });
});

describe('claudeDriver bare /model', () => {
  it('reports the current model instead of silently doing nothing (human repro)', async () => {
    const h = await startedHarness();
    h.events.length = 0;
    await h.driver.inject('/model', 'ui');
    const hint = h.events.find((e) => e.kind === 'attention-hint') as { detail?: string } | undefined;
    expect(hint).toBeDefined();
    expect(hint!.detail).toContain('claude-fable-5');
    expect(hint!.detail).toContain('/model <name>');
    expect(h.setModelCalls).toHaveLength(0);
    expect(h.pushedMessages).toHaveLength(0);
  });
});
