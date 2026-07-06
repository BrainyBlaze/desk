import { describe, expect, it, vi } from 'vitest';
import type { Event, Message, Part, Session, SessionStatus } from '@opencode-ai/sdk';
import {
  OpencodeDriver,
  mapPermissionOptionId,
  type OpencodeBackend,
  type PermissionResponse
} from '../../../../src/server/agents/drivers/opencodeDriver';

interface MockBackend extends OpencodeBackend {
  emitEvent(event: Event): void;
  /** Lists every call recorded against the backend. */
  readonly calls: Array<{ method: string; args: unknown[] }>;
  /** Replace the session's polled status (watchdog probe tests). */
  setStatus(status: SessionStatus): void;
  /** Make the next status() calls reject (watchdog probe-failure tests). */
  failStatus(error: Error): void;
}

function makeMockBackend(opts: {
  initialSessionId?: string;
  initialStatus?: SessionStatus;
  history?: Array<{ info: Message; parts: Part[] }>;
  fail?: { createSession?: Error; getSession?: Error; runCommand?: Error };
} = {}): MockBackend {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const subscribers = new Set<(event: Event) => void>();
  // Reuse the seeded id for createSession so the status map (keyed by it) still applies.
  const sessionId = opts.initialSessionId ?? 'ses_mock';
  const statusMap: Record<string, SessionStatus> = {
    [sessionId]: opts.initialStatus ?? { type: 'idle' }
  };
  let statusError: Error | null = null;

  return {
    calls,
    emitEvent(event) {
      for (const handler of subscribers) handler(event);
    },
    setStatus(status) {
      statusMap[sessionId] = status;
    },
    failStatus(error) {
      statusError = error;
    },
    async createSession(title) {
      calls.push({ method: 'createSession', args: [title] });
      if (opts.fail?.createSession) throw opts.fail.createSession;
      statusMap[sessionId] = statusMap[sessionId] ?? { type: 'idle' };
      return {
        id: sessionId,
        projectID: 'proj-1',
        directory: '/tmp/mock',
        title,
        version: '1.0.0',
        time: { created: Date.now(), updated: Date.now() }
      } as Session;
    },
    async getSession(id) {
      calls.push({ method: 'getSession', args: [id] });
      if (opts.fail?.getSession) throw opts.fail.getSession;
      if (id !== sessionId) return null;
      return {
        id,
        projectID: 'proj-1',
        directory: '/tmp/mock',
        title: 'mock',
        version: '1.0.0',
        time: { created: Date.now(), updated: Date.now() }
      } as Session;
    },
    async status() {
      calls.push({ method: 'status', args: [] });
      if (statusError) throw statusError;
      return statusMap;
    },
    async abort(id) {
      calls.push({ method: 'abort', args: [id] });
    },
    async runCommand(id, command, args, model) {
      calls.push({ method: 'runCommand', args: [id, command, args, model] });
      if (opts.fail?.runCommand) throw opts.fail.runCommand;
    },
    async promptAsync(id, parts, _model?: string) {
      calls.push({ method: 'promptAsync', args: [id, parts] });
    },
    async respondPermission(id, permissionId, response: PermissionResponse) {
      calls.push({ method: 'respondPermission', args: [id, permissionId, response] });
    },
    async listMessages(id) {
      calls.push({ method: 'listMessages', args: [id] });
      return opts.history ?? [];
    },
    async subscribeEvents(handler: (event: Event) => void, onEnd?: (error?: Error) => void) {
      calls.push({ method: 'subscribeEvents', args: [] });
      subscribers.add(handler as (event: Event) => void);
      // Stash onEnd so tests can simulate stream termination.
      (this as unknown as { _onEnd?: (error?: Error) => void })._onEnd = onEnd;
      return () => {
        subscribers.delete(handler as (event: Event) => void);
      };
    },
    async close() {
      calls.push({ method: 'close', args: [] });
    }
  };
}

async function collect(handler: (e: { kind: string }) => void, fn: () => Promise<void>): Promise<void> {
  await fn();
  return undefined;
}

describe('OpencodeDriver lifecycle', () => {
  it('start() creates a session when no resume id, subscribes events BEFORE status, emits idle', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: string[] = [];
    driver.onEvent((e) => events.push(e.kind));
    const result = await driver.start();
    expect(result.session.agentSessionId).toMatch(/^ses_/);
    expect(result.status).toMatchObject({ kind: 'status', state: 'idle' });
    expect(events).toContain('status');

    const methodOrder = backend.calls.map((c) => c.method);
    expect(methodOrder.indexOf('subscribeEvents')).toBeLessThan(methodOrder.indexOf('status'));
    expect(methodOrder).toContain('createSession');
    expect(methodOrder).not.toContain('getSession');
  });

  it('start() resumes when resumeId is provided and the session exists', async () => {
    const backend = makeMockBackend({ initialSessionId: 'ses_existing' });
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend, resumeId: 'ses_existing' });
    await driver.start();
    expect(backend.calls.some((c) => c.method === 'getSession' && c.args[0] === 'ses_existing')).toBe(true);
    expect(backend.calls.some((c) => c.method === 'createSession')).toBe(false);
  });

  it('start() throws DriverCommandError driver-start-failed retryable=false when resume session is gone', async () => {
    const backend = makeMockBackend({ initialSessionId: 'ses_other' });
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend, resumeId: 'ses_missing' });
    await expect(driver.start()).rejects.toMatchObject({
      message: expect.stringContaining('ses_missing'),
      code: 'driver-start-failed',
      retryable: false
    });
  });

  it('start() rejects being called twice', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await driver.start();
    await expect(driver.start()).rejects.toThrow('called twice');
  });

  it('start() expands retry status into [status, attention-hint]', async () => {
    const backend = makeMockBackend({
      initialStatus: { type: 'retry', attempt: 1, message: 'rate limited', next: Date.now() + 1000 }
    });
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: string[] = [];
    driver.onEvent((e) => events.push(e.kind));
    await driver.start();
    expect(events).toContain('status');
    expect(events).toContain('attention-hint');
  });
});

describe('OpencodeDriver inject', () => {
  it('emits user-message locally with the caller source AND calls promptAsync', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: Array<{ kind: string; source?: string }> = [];
    driver.onEvent((e) => events.push(e));
    await driver.start();
    events.length = 0;
    await driver.inject('hello world', 'ui');
    expect(events).toEqual([{ kind: 'user-message', source: 'ui', id: expect.any(String), text: 'hello world' }]);
    expect(backend.calls.some((c) => c.method === 'promptAsync')).toBe(true);
  });

  it('throws DriverCommandError adapter-unavailable retryable=false when called before start', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await expect(driver.inject('hi', 'ui')).rejects.toMatchObject({
      code: 'adapter-unavailable',
      retryable: false
    });
  });

  it('swallows opencode echo for a recently-injected user message (no duplicate)', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: Array<{ kind: string; role?: string }> = [];
    driver.onEvent((e) => events.push(e));
    await driver.start();
    events.length = 0;
    await driver.inject('hi', 'channel');
    events.length = 0;
    backend.emitEvent({
      type: 'message.updated',
      properties: {
        info: { id: 'm1', sessionID: backend.calls[0]!.args[0] ?? 'ses_mock', role: 'user', time: { created: 0 } } as Message
      }
    });
    expect(events).toEqual([]);
  });
});

describe('OpencodeDriver command methods', () => {
  it('respondPermission maps optionId via mapPermissionOptionId and posts to backend', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await driver.start();
    await driver.respondPermission('perm-1', 'allow-always');
    expect(backend.calls.some((c) => c.method === 'respondPermission' && c.args[2] === 'always')).toBe(true);
  });

  it('interrupt calls backend.abort with the session id', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await driver.start();
    await driver.interrupt();
    expect(backend.calls.some((c) => c.method === 'abort')).toBe(true);
  });
});

describe('OpencodeDriver event handling', () => {
  it('forwards message.part.updated delta as assistant-delta', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: Array<{ kind: string; text?: string }> = [];
    driver.onEvent((e) => events.push(e));
    await driver.start();
    events.length = 0;
    backend.emitEvent({
      type: 'message.part.updated',
      properties: {
        part: { id: 'p1', sessionID: 'ses_mock', messageID: 'm1', type: 'text', text: 'acc' } as Part,
        delta: 'chunk'
      }
    });
    expect(events).toContainEqual({ kind: 'assistant-delta', turnId: 'm1', text: 'chunk' });
  });

  it('session.idle with pending assistant message emits turn-complete', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: string[] = [];
    driver.onEvent((e) => events.push(e.kind));
    await driver.start();
    events.length = 0;
    // pending assistant message arrival
    backend.emitEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'm-asst-1',
          sessionID: 'ses_mock',
          role: 'assistant',
          time: { created: 0 }
        } as Message
      }
    });
    backend.emitEvent({ type: 'session.idle', properties: { sessionID: 'ses_mock' } });
    expect(events).toContain('turn-complete');
  });

  it('permission.updated forwards with allow/allow-session/deny options', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const captured: Array<{ kind: string; options?: Array<{ treatment: string }> }> = [];
    driver.onEvent((e) => captured.push(e));
    await driver.start();
    captured.length = 0;
    backend.emitEvent({
      type: 'permission.updated',
      properties: {
        id: 'perm-1',
        type: 'command',
        sessionID: 'ses_mock',
        messageID: 'm-1',
        title: 'Bash?',
        metadata: {},
        time: { created: 0 }
      }
    });
    const request = captured.find((e) => e.kind === 'permission-request');
    expect(request).toBeDefined();
    const treatments = request!.options!.map((o) => o.treatment).sort();
    expect(treatments).toEqual(['allow', 'allow-session', 'deny']);
  });

  it('drops unmapped event kinds (file.*, tui.*) silently', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: string[] = [];
    driver.onEvent((e) => events.push(e.kind));
    await driver.start();
    events.length = 0;
    backend.emitEvent({ type: 'file.edited', properties: { path: '/x', sessionID: 'ses_mock' } } as unknown as Event);
    expect(events).toEqual([]);
  });
});

describe('OpencodeDriver fetchHistory', () => {
  it('returns committed events in chronological order with source=external default', async () => {
    const backend = makeMockBackend({
      history: [
        {
          info: { id: 'u1', sessionID: 'ses_mock', role: 'user', time: { created: 1 } } as Message,
          parts: [{ id: 'p1', sessionID: 'ses_mock', messageID: 'u1', type: 'text', text: 'hi' } as Part]
        },
        {
          info: {
            id: 'a1',
            sessionID: 'ses_mock',
            role: 'assistant',
            time: { created: 2, completed: 3 }
          } as Message,
          parts: [
            { id: 'p2', sessionID: 'ses_mock', messageID: 'a1', type: 'text', text: 'hello back' } as Part
          ]
        }
      ]
    });
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await driver.start();
    const history = await driver.fetchHistory();
    expect(history.map((e) => e.kind)).toEqual(['user-message', 'assistant-message', 'turn-complete']);
    const userMessage = history.find((e) => e.kind === 'user-message')!;
    if (userMessage.kind !== 'user-message') throw new Error('narrow');
    expect(userMessage.source).toBe('external');
  });

  it('throws when called before start', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await expect(driver.fetchHistory()).rejects.toMatchObject({
      code: 'adapter-unavailable',
      retryable: false
    });
  });
});

describe('OpencodeDriver stream-end hardening', () => {
  it('emits non-fatal agent-error when the SSE stream ends unexpectedly (not on shutdown)', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: Array<{ kind: string; fatal?: boolean; message?: string }> = [];
    driver.onEvent((e) => events.push(e as { kind: string; fatal?: boolean; message?: string }));
    await driver.start();
    events.length = 0;

    // Simulate stream termination (opencode serve crash / network drop)
    const onEnd = (backend as unknown as { _onEnd?: (error?: Error) => void })._onEnd;
    expect(onEnd).toBeDefined();
    onEnd?.(new Error('SSE connection reset'));

    const err = events.find((e) => e.kind === 'agent-error');
    expect(err).toBeDefined();
    expect(err?.fatal).toBe(false);
    expect(err?.message).toContain('SSE connection reset');
  });

  it('emits non-fatal agent-error when the stream ends cleanly outside shutdown', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: Array<{ kind: string; fatal?: boolean; message?: string }> = [];
    driver.onEvent((e) => events.push(e as { kind: string; fatal?: boolean; message?: string }));
    await driver.start();
    events.length = 0;

    const onEnd = (backend as unknown as { _onEnd?: (error?: Error) => void })._onEnd;
    onEnd?.(); // clean close, no error

    const err = events.find((e) => e.kind === 'agent-error');
    expect(err).toBeDefined();
    expect(err?.fatal).toBe(false);
    expect(err?.message).toContain('ended unexpectedly');
  });

  it('does NOT emit agent-error on stream end when driver is already shut down', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: Array<{ kind: string }> = [];
    driver.onEvent((e) => events.push(e as { kind: string }));
    await driver.start();
    await driver.shutdown();
    events.length = 0;

    const onEnd = (backend as unknown as { _onEnd?: (error?: Error) => void })._onEnd;
    onEnd?.(new Error('late stream error'));

    expect(events.filter((e) => e.kind === 'agent-error')).toHaveLength(0);
  });
});

describe('OpencodeDriver shutdown', () => {
  it('closes backend, unsubscribes events, halts subsequent emissions', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const events: string[] = [];
    driver.onEvent((e) => events.push(e.kind));
    await driver.start();
    events.length = 0;
    await driver.shutdown();
    expect(backend.calls.some((c) => c.method === 'close')).toBe(true);
    backend.emitEvent({
      type: 'message.part.updated',
      properties: {
        part: { id: 'p1', sessionID: 'ses_mock', messageID: 'm1', type: 'text', text: 'x' } as Part,
        delta: 'late'
      }
    });
    expect(events).toEqual([]);
  });

  it('handler throwing does not break sibling handlers', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    const calls: string[] = [];
    driver.onEvent(() => {
      calls.push('first');
      throw new Error('boom');
    });
    driver.onEvent(() => calls.push('second'));
    await driver.start();
    calls.length = 0;
    driver.emit({ kind: 'status', state: 'idle' });
    expect(calls).toEqual(['first', 'second']);
  });
});

describe('mapPermissionOptionId', () => {
  it('maps allow/once → once', () => {
    expect(mapPermissionOptionId('allow')).toBe('once');
    expect(mapPermissionOptionId('once')).toBe('once');
  });
  it('maps allow-always/allow-session/always → always', () => {
    expect(mapPermissionOptionId('allow-always')).toBe('always');
    expect(mapPermissionOptionId('allow-session')).toBe('always');
    expect(mapPermissionOptionId('always')).toBe('always');
  });
  it('maps deny and anything else → reject', () => {
    expect(mapPermissionOptionId('deny')).toBe('reject');
    expect(mapPermissionOptionId('custom')).toBe('reject');
    expect(mapPermissionOptionId('unknown')).toBe('reject');
  });
});

describe('OpencodeDriver collect helper', () => {
  it('collect awaits the promise and returns undefined', async () => {
    const result = await collect(
      () => undefined,
      async () => undefined
    );
    expect(result).toBeUndefined();
    expect(vi.fn()).not.toHaveBeenCalled();
  });
});

describe('OpencodeDriver slash commands', () => {
  it('routes slash text to the session command API with the model override', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend, model: 'zai-coding-plan/glm-5.2' });
    const events: Array<{ kind: string }> = [];
    driver.onEvent((e) => events.push(e as { kind: string }));
    await driver.start();
    events.length = 0;
    await driver.inject('/compact now please', 'ui');
    const call = backend.calls.find((c) => c.method === 'runCommand');
    expect(call?.args).toEqual(['ses_mock', 'compact', 'now please', 'zai-coding-plan/glm-5.2']);
    expect(events.some((e) => e.kind === 'user-message')).toBe(true);
    expect(backend.calls.some((c) => c.method === 'promptAsync')).toBe(false);
  });

  it('maps command API failures to a typed unsupported-command error', async () => {
    const backend = makeMockBackend({ fail: { runCommand: new Error('unknown command: bogus') } });
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await driver.start();
    await expect(driver.inject('/bogus', 'ui')).rejects.toMatchObject({
      code: 'unsupported-command',
      retryable: false
    });
  });

  it('plain text still goes through promptAsync', async () => {
    const backend = makeMockBackend();
    const driver = new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend });
    await driver.start();
    await driver.inject('hello', 'ui');
    expect(backend.calls.some((c) => c.method === 'promptAsync')).toBe(true);
    expect(backend.calls.some((c) => c.method === 'runCommand')).toBe(false);
  });
});

describe('OpencodeDriver turn-liveness watchdog', () => {
  // opencode broadcasts NOTHING over SSE while it retries provider stream errors
  // internally (verified live: an AI_APICallError retry loop emitted zero /event
  // frames for 7+ hours and message.error stayed null). The ONLY observable truth
  // is the session-status polling endpoint, which reports {type:'retry', attempt,
  // message, next}. The watchdog probes it when a turn goes silent.

  function makeWatchdogDriver(backend: MockBackend): OpencodeDriver {
    return new OpencodeDriver({ cwd: '/tmp/mock', bypass: false, backend, turnWatchdogMs: 60_000 });
  }

  it('surfaces the real provider retry message via status+attention-hint when a silent turn is stuck in retry', async () => {
    vi.useFakeTimers();
    try {
      const backend = makeMockBackend();
      const driver = makeWatchdogDriver(backend);
      const events: Array<{ kind: string; detail?: string }> = [];
      driver.onEvent((e) => events.push(e as { kind: string; detail?: string }));
      await driver.start();
      await driver.inject('are you alive?', 'ui');
      events.length = 0;
      backend.setStatus({ type: 'retry', attempt: 15, message: 'Weekly Limit Exhausted', next: 9999 });
      await vi.advanceTimersByTimeAsync(60_000);
      const hint = events.find((e) => e.kind === 'attention-hint');
      expect(hint).toBeDefined();
      expect(hint!.detail).toContain('Weekly Limit Exhausted');
      // Same attempt number → no duplicate report on the next probe.
      events.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.filter((e) => e.kind === 'attention-hint')).toHaveLength(0);
      // New attempt number → reported again.
      backend.setStatus({ type: 'retry', attempt: 16, message: 'Weekly Limit Exhausted', next: 9999 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.filter((e) => e.kind === 'attention-hint')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a dropped-message agent-error when a silent turn probes back idle', async () => {
    vi.useFakeTimers();
    try {
      const backend = makeMockBackend();
      const driver = makeWatchdogDriver(backend);
      const events: Array<{ kind: string; fatal?: boolean; message?: string }> = [];
      driver.onEvent((e) => events.push(e as { kind: string; fatal?: boolean; message?: string }));
      await driver.start();
      await driver.inject('hello?', 'ui');
      events.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      const errors = events.filter((e) => e.kind === 'agent-error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.fatal).toBe(false);
      expect(errors[0]!.message).toContain('no output');
      // Idle probe does not re-arm — no repeat fire without a new inject.
      await vi.advanceTimersByTimeAsync(180_000);
      expect(events.filter((e) => e.kind === 'agent-error')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms silently when the probe reports busy (slow but healthy provider)', async () => {
    vi.useFakeTimers();
    try {
      const backend = makeMockBackend();
      const driver = makeWatchdogDriver(backend);
      const events: Array<{ kind: string }> = [];
      driver.onEvent((e) => events.push(e as { kind: string }));
      await driver.start();
      await driver.inject('slow one', 'ui');
      events.length = 0;
      backend.setStatus({ type: 'busy' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toHaveLength(0);
      // Turn completes later → disarm; still nothing after a long silence.
      backend.emitEvent({
        type: 'message.updated',
        properties: {
          info: { id: 'm-asst-1', sessionID: 'ses_mock', role: 'assistant', time: { created: 0 } } as Message
        }
      });
      backend.emitEvent({ type: 'session.idle', properties: { sessionID: 'ses_mock' } });
      events.length = 0;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(events.filter((e) => e.kind === 'agent-error')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('slides the window on live session activity instead of firing', async () => {
    vi.useFakeTimers();
    try {
      const backend = makeMockBackend();
      const driver = makeWatchdogDriver(backend);
      const events: Array<{ kind: string }> = [];
      driver.onEvent((e) => events.push(e as { kind: string }));
      await driver.start();
      await driver.inject('hello', 'ui');
      await vi.advanceTimersByTimeAsync(45_000);
      backend.emitEvent({
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: 'ses_mock', messageID: 'm1', type: 'text', text: 'working' } as Part,
          delta: 'working'
        }
      });
      events.length = 0;
      // 45s later: original window (60s from inject) has passed but the slide reset it.
      await vi.advanceTimersByTimeAsync(45_000);
      expect(events.filter((e) => e.kind === 'agent-error')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms on interrupt', async () => {
    vi.useFakeTimers();
    try {
      const backend = makeMockBackend();
      const driver = makeWatchdogDriver(backend);
      const events: Array<{ kind: string }> = [];
      driver.onEvent((e) => events.push(e as { kind: string }));
      await driver.start();
      await driver.inject('will interrupt', 'ui');
      await driver.interrupt();
      events.length = 0;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(events.filter((e) => e.kind === 'agent-error')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a probe-failure agent-error when the status endpoint itself fails', async () => {
    vi.useFakeTimers();
    try {
      const backend = makeMockBackend();
      const driver = makeWatchdogDriver(backend);
      const events: Array<{ kind: string; message?: string }> = [];
      driver.onEvent((e) => events.push(e as { kind: string; message?: string }));
      await driver.start();
      await driver.inject('hello?', 'ui');
      events.length = 0;
      backend.failStatus(new Error('serve is gone'));
      await vi.advanceTimersByTimeAsync(60_000);
      const errors = events.filter((e) => e.kind === 'agent-error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('serve is gone');
    } finally {
      vi.useRealTimers();
    }
  });
});
