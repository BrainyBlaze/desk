import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, Permission, SessionStatus, ToolPart, UserMessage } from '@opencode-ai/sdk';
import {
  assembleMarkdown,
  expandRetryStatus,
  mapHistoryMessage,
  mapLiveEvent,
  mapPermission,
  mapSessionError,
  mapSessionStatus,
  type AssistantMessageText,
  type LiveEventContext
} from '../../../../src/server/agents/drivers/opencodeMapper';

const SESSION_ID = 'ses_abc';

function makeCtx(overrides: Partial<LiveEventContext> = {}): LiveEventContext {
  return {
    sessionId: SESSION_ID,
    assistantTextByMessageId: new Map(),
    assistantCommitted: new Set(),
    ...overrides
  };
}

const fixedNow = 1_725_000_000_000;

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'm-user-1',
    sessionID: SESSION_ID,
    role: 'user',
    time: { created: fixedNow },
    agent: 'build',
    ...overrides
  } as UserMessage;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm-asst-1',
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: fixedNow, completed: fixedNow + 1500 },
    parentID: 'm-user-1',
    modelID: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    mode: 'default',
    path: { cwd: '/tmp/proj', root: '/tmp/proj' },
    cost: 0.0042,
    tokens: { input: 220, output: 180, reasoning: 0 },
    ...overrides
  } as AssistantMessage;
}

function completedTool(): ToolPart {
  return {
    id: 'p-tool-1',
    sessionID: SESSION_ID,
    messageID: 'm-asst-1',
    type: 'tool',
    callID: 'call_001',
    tool: 'Read',
    state: {
      status: 'completed',
      input: { path: '/tmp/proj/foo.ts' },
      output: 'export const X = 1;',
      title: 'Read foo.ts',
      metadata: {},
      time: { start: fixedNow, end: fixedNow + 100 }
    }
  } as ToolPart;
}

function errorTool(): ToolPart {
  return {
    id: 'p-tool-2',
    sessionID: SESSION_ID,
    messageID: 'm-asst-1',
    type: 'tool',
    callID: 'call_002',
    tool: 'Bash',
    state: {
      status: 'error',
      input: { command: 'exit 1' },
      error: 'nonzero exit',
      metadata: {},
      time: { start: fixedNow, end: fixedNow + 100 }
    }
  } as ToolPart;
}

describe('mapHistoryMessage — UserMessage', () => {
  it('emits one user-message with source=external by default', () => {
    const info = userMessage();
    const events = mapHistoryMessage(info, [
      { id: 'p1', sessionID: SESSION_ID, messageID: 'm-user-1', type: 'text', text: 'hi there' } as never
    ]);
    expect(events).toEqual([
      { kind: 'user-message', id: 'm-user-1', text: 'hi there', source: 'external' }
    ]);
  });

  it('honors caller-provided source for live-correlated backfill', () => {
    const info = userMessage();
    const events = mapHistoryMessage(
      info,
      [{ id: 'p1', sessionID: SESSION_ID, messageID: 'm-user-1', type: 'text', text: 'ping' } as never],
      'channel'
    );
    expect(events[0]).toMatchObject({ source: 'channel' });
  });

  it('skips synthetic text parts (opencode-injected prompts)', () => {
    const info = userMessage();
    const events = mapHistoryMessage(info, [
      { id: 'p1', sessionID: SESSION_ID, messageID: 'm-user-1', type: 'text', text: 'synthetic prefix', synthetic: true } as never,
      { id: 'p2', sessionID: SESSION_ID, messageID: 'm-user-1', type: 'text', text: 'real prompt' } as never
    ]);
    expect(events[0]).toMatchObject({ text: 'real prompt' });
  });
});

describe('mapHistoryMessage — AssistantMessage', () => {
  it('emits tool-start + tool-end + assistant-message + turn-complete for completed turns', () => {
    const info = assistantMessage();
    const events = mapHistoryMessage(info, [
      completedTool(),
      { id: 'p2', sessionID: SESSION_ID, messageID: 'm-asst-1', type: 'text', text: 'all done' } as never
    ]);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['tool-start', 'tool-end', 'assistant-message', 'turn-complete']);
    const toolStart = events[0]!;
    expect(toolStart).toMatchObject({ kind: 'tool-start', toolUseId: 'call_001', name: 'Read' });
    const toolEnd = events[1]!;
    expect(toolEnd).toMatchObject({ kind: 'tool-end', toolUseId: 'call_001', status: 'ok' });
    const assistantMessageEvent = events[2]!;
    expect(assistantMessageEvent).toMatchObject({
      kind: 'assistant-message',
      id: 'm-asst-1',
      turnId: 'm-asst-1',
      markdown: 'all done'
    });
    const turnComplete = events[3]!;
    expect(turnComplete).toMatchObject({ kind: 'turn-complete', turnId: 'm-asst-1' });
    if (turnComplete.kind !== 'turn-complete') throw new Error('narrow');
    expect(turnComplete.usage?.costUsd).toBe(0.0042);
  });

  it('maps error-status tool to tool-end status=error', () => {
    const info = assistantMessage();
    const events = mapHistoryMessage(info, [errorTool()]);
    const toolEnd = events.find((e) => e.kind === 'tool-end');
    expect(toolEnd).toMatchObject({ kind: 'tool-end', toolUseId: 'call_002', status: 'error' });
  });

  it('omits turn-complete when assistant time.completed is absent (turn still in flight)', () => {
    const info = assistantMessage({ time: { created: fixedNow } });
    const events = mapHistoryMessage(info, [
      { id: 'p1', sessionID: SESSION_ID, messageID: 'm-asst-1', type: 'text', text: 'partial' } as never
    ]);
    expect(events.some((e) => e.kind === 'turn-complete')).toBe(false);
  });
});

describe('mapLiveEvent', () => {
  it('message.part.updated with text delta → assistant-delta AND accumulates the part text', () => {
    const ctx = makeCtx();
    const result = mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: SESSION_ID,
            messageID: 'm-asst-1',
            type: 'text',
            text: 'hello '
          } as never,
          delta: 'chunk-1'
        }
      },
      ctx
    );
    expect(result).toEqual({ kind: 'assistant-delta', turnId: 'm-asst-1', text: 'chunk-1' });
    expect(ctx.assistantTextByMessageId.get('m-asst-1')).toEqual({
      partOrder: ['p1'],
      partText: new Map([['p1', 'hello ']])
    });
  });

  it('message.part.updated accumulates across multiple parts', () => {
    const ctx = makeCtx();
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'first' } as never,
          delta: 'f'
        }
      },
      ctx
    );
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p2', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'second' } as never,
          delta: 's'
        }
      },
      ctx
    );
    expect(ctx.assistantTextByMessageId.get('m1')).toEqual({
      partOrder: ['p1', 'p2'],
      partText: new Map([
        ['p1', 'first'],
        ['p2', 'second']
      ])
    });
  });

  it('R1 follow-up — repeated updates for the SAME partID replace, not append', () => {
    const ctx = makeCtx();
    // opencode fires message.part.updated many times for one part as text grows
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'Hel' } as never,
          delta: 'Hel'
        }
      },
      ctx
    );
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'Hello wor' } as never,
          delta: 'lo wor'
        }
      },
      ctx
    );
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'Hello world' } as never,
          delta: 'ld'
        }
      },
      ctx
    );
    const assembled = ctx.assistantTextByMessageId.get('m1');
    expect(assembled).toEqual({
      partOrder: ['p1'],
      partText: new Map([['p1', 'Hello world']])
    });
  });

  it('R1 follow-up — multi-part message: each part updated twice, commit joins final texts in first-seen order', () => {
    const ctx = makeCtx({
      assistantTextByMessageId: new Map()
    });
    // Manually build the accumulator via repeated mapLiveEvent calls
    const seed = ctx.assistantTextByMessageId; // alias for clarity
    expect(seed).toBe(ctx.assistantTextByMessageId);
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'a1' } as never,
          delta: 'a1'
        }
      },
      ctx
    );
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p2', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'b1' } as never,
          delta: 'b1'
        }
      },
      ctx
    );
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'a1+a2' } as never,
          delta: '+a2'
        }
      },
      ctx
    );
    mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p2', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'b1+b2' } as never,
          delta: '+b2'
        }
      },
      ctx
    );
    // Commit: assemble final p1 + final p2 in first-seen order (p1 first, then p2)
    const assembled = assembleMarkdown(ctx.assistantTextByMessageId.get('m1'));
    expect(assembled).toBe('a1+a2\nb1+b2');
  });
  it('message.part.updated without delta → null but still accumulates', () => {
    const ctx = makeCtx();
    const result = mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: SESSION_ID, messageID: 'm1', type: 'text', text: 'acc' } as never
        }
      },
      ctx
    );
    expect(result).toBeNull();
    expect(ctx.assistantTextByMessageId.get('m1')).toEqual({
      partOrder: ['p1'],
      partText: new Map([['p1', 'acc']])
    });
  });

  it('message.updated for assistant without completed → null (do not commit yet)', () => {
    const ctx = makeCtx({
      assistantTextByMessageId: new Map([
        ['m-asst-1', { partOrder: ['p1'], partText: new Map([['p1', 'pending text']]) }]
      ])
    });
    const result = mapLiveEvent(
      {
        type: 'message.updated',
        properties: { info: assistantMessage({ time: { created: fixedNow } }) }
      },
      ctx
    );
    expect(result).toBeNull();
    expect(ctx.assistantCommitted.size).toBe(0);
  });

  it('R1 — message.updated for completed assistant → assistant-message with assembled markdown', () => {
    const ctx = makeCtx({
      assistantTextByMessageId: new Map([
        ['m-asst-1', { partOrder: ['p1'], partText: new Map([['p1', 'hello world']]) }]
      ])
    });
    const result = mapLiveEvent(
      { type: 'message.updated', properties: { info: assistantMessage() } },
      ctx
    );
    expect(result).toEqual({
      kind: 'assistant-message',
      id: 'm-asst-1',
      turnId: 'm-asst-1',
      markdown: 'hello world'
    });
    expect(ctx.assistantCommitted.has('m-asst-1')).toBe(true);
  });

  it('R1 — message.updated idempotent: second commit for same messageID returns null', () => {
    const ctx = makeCtx({
      assistantTextByMessageId: new Map([
        ['m-asst-1', { partOrder: ['p1'], partText: new Map([['p1', 'tx']]) }]
      ]),
      assistantCommitted: new Set(['m-asst-1'])
    });
    const result = mapLiveEvent(
      { type: 'message.updated', properties: { info: assistantMessage() } },
      ctx
    );
    expect(result).toBeNull();
  });
  it('R2 — message.updated for user → null (live user-messages come from inject only)', () => {
    const ctx = makeCtx();
    const result = mapLiveEvent(
      { type: 'message.updated', properties: { info: userMessage() } },
      ctx
    );
    expect(result).toBeNull();
  });

  it('session.idle with pendingTurnId → status idle + turn-complete', () => {
    const ctx = makeCtx({ pendingTurnId: 'm-asst-1' });
    const result = mapLiveEvent(
      { type: 'session.idle', properties: { sessionID: SESSION_ID } },
      ctx
    );
    expect(result).toEqual([
      { kind: 'status', state: 'idle' },
      { kind: 'turn-complete', turnId: 'm-asst-1' }
    ]);
  });

  it('session.idle without pendingTurnId → status idle only', () => {
    const ctx = makeCtx();
    const result = mapLiveEvent(
      { type: 'session.idle', properties: { sessionID: SESSION_ID } },
      ctx
    );
    expect(result).toEqual([{ kind: 'status', state: 'idle' }]);
  });

  it('permission.updated → permission-request with allow/allow-session/deny options', () => {
    const perm: Permission = {
      id: 'perm-1',
      type: 'command',
      sessionID: SESSION_ID,
      messageID: 'm-asst-1',
      title: 'Run `rm -rf /`?',
      metadata: {},
      time: { created: fixedNow }
    };
    const result = mapLiveEvent({ type: 'permission.updated', properties: perm }, makeCtx());
    expect(result).toMatchObject({
      kind: 'permission-request',
      requestId: 'perm-1',
      variant: 'command',
      title: 'Run `rm -rf /`?'
    });
    if (!result || Array.isArray(result)) throw new Error('expected single event');
    if (result.kind !== 'permission-request') throw new Error('narrow');
    const treatments = result.options.map((o) => o.treatment).sort();
    expect(treatments).toEqual(['allow', 'allow-session', 'deny']);
  });

  it('permission.replied → permission-resolved via agent', () => {
    const result = mapLiveEvent(
      {
        type: 'permission.replied',
        properties: { sessionID: SESSION_ID, permissionID: 'perm-1', response: 'allow-always' }
      },
      makeCtx()
    );
    expect(result).toEqual({
      kind: 'permission-resolved',
      requestId: 'perm-1',
      optionId: 'allow-always',
      via: 'agent'
    });
  });

  it('R3 — foreign-session message.part.updated is dropped (subagent child)', () => {
    const ctx = makeCtx({ sessionId: 'ses_ours' });
    const result = mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 'ses_subagent',
            messageID: 'm1',
            type: 'text',
            text: 'subagent whisper'
          } as never,
          delta: 'subagent whisper'
        }
      },
      ctx
    );
    expect(result).toBeNull();
    expect(ctx.assistantTextByMessageId.has('m1')).toBe(false);
  });

  it('R3 — foreign-session permission.updated is dropped', () => {
    const ctx = makeCtx({ sessionId: 'ses_ours' });
    const perm: Permission = {
      id: 'p-other',
      type: 'command',
      sessionID: 'ses_subagent',
      messageID: 'm-other',
      title: 'foreign',
      metadata: {},
      time: { created: fixedNow }
    };
    expect(mapLiveEvent({ type: 'permission.updated', properties: perm }, ctx)).toBeNull();
  });

  it('R3 — foreign-session session.idle is dropped', () => {
    const ctx = makeCtx({ sessionId: 'ses_ours', pendingTurnId: 't1' });
    expect(mapLiveEvent({ type: 'session.idle', properties: { sessionID: 'ses_other' } }, ctx)).toBeNull();
  });

  it('unmapped event kinds (file.*, tui.*) return null', () => {
    expect(
      mapLiveEvent(
        { type: 'file.edited', properties: { path: '/foo', sessionID: SESSION_ID } } as never,
        makeCtx()
      )
    ).toBeNull();
  });
});

describe('mapSessionStatus', () => {
  it('busy → processing', () => {
    const status: SessionStatus = { type: 'busy' };
    expect(mapSessionStatus(status)).toEqual({ kind: 'status', state: 'processing' });
  });
  it('idle → idle', () => {
    const status: SessionStatus = { type: 'idle' };
    expect(mapSessionStatus(status)).toEqual({ kind: 'status', state: 'idle' });
  });
  it('retry → processing with retry detail prefix', () => {
    const status: SessionStatus = {
      type: 'retry',
      attempt: 2,
      message: 'rate limited',
      next: fixedNow + 1000
    };
    const mapped = mapSessionStatus(status);
    expect(mapped.state).toBe('processing');
    expect(mapped.detail).toBe('retry: rate limited');
  });
});

describe('expandRetryStatus', () => {
  it('expands a retry-flavored status into status + attention-hint pair', () => {
    const result = expandRetryStatus({ kind: 'status', state: 'processing', detail: 'retry: slow down' });
    expect(result).toEqual([
      { kind: 'status', state: 'processing' },
      { kind: 'attention-hint', attention: 'session-status', detail: 'retry: slow down' }
    ]);
  });
  it('passes through non-retry statuses untouched', () => {
    const result = expandRetryStatus({ kind: 'status', state: 'idle' });
    expect(result).toEqual([{ kind: 'status', state: 'idle' }]);
  });
});

describe('mapPermission — variant mapping', () => {
  it('command permission → variant command', () => {
    const perm: Permission = {
      id: 'p1',
      type: 'command',
      sessionID: SESSION_ID,
      messageID: 'm',
      title: 'Bash',
      metadata: {},
      time: { created: fixedNow }
    };
    expect(mapPermission(perm)).toMatchObject({ variant: 'command' });
  });
  it('file permission → variant file-edit', () => {
    const perm: Permission = {
      id: 'p1',
      type: 'file',
      sessionID: SESSION_ID,
      messageID: 'm',
      title: 'Edit',
      metadata: {},
      time: { created: fixedNow }
    };
    expect(mapPermission(perm)).toMatchObject({ variant: 'file-edit' });
  });
  it('other types default to variant tool', () => {
    const perm: Permission = {
      id: 'p1',
      type: 'mcp_call',
      sessionID: SESSION_ID,
      messageID: 'm',
      title: 'MCP',
      metadata: {},
      time: { created: fixedNow }
    };
    expect(mapPermission(perm)).toMatchObject({ variant: 'tool' });
  });
});

describe('mapSessionError', () => {
  it('ProviderAuthError is fatal', () => {
    const event = mapSessionError({ name: 'ProviderAuthError', data: { message: 'bad key', providerID: 'anthropic' } });
    expect(event).toMatchObject({ kind: 'agent-error', message: 'bad key', fatal: true });
  });
  it('ApiError is non-fatal by default (agent may retry)', () => {
    const event = mapSessionError({ name: 'APIError', data: { message: '5xx', isRetryable: true } });
    expect(event.fatal).toBe(false);
  });
  it('null / undefined → unknown error', () => {
    expect(mapSessionError(null)).toMatchObject({ kind: 'agent-error', message: 'unknown error', fatal: false });
    expect(mapSessionError(undefined)).toMatchObject({ kind: 'agent-error', message: 'unknown error', fatal: false });
  });
  it('falls back through data.message → message → name → default', () => {
    expect(mapSessionError({ name: 'Weird' })?.message).toBe('Weird');
    expect(mapSessionError({ message: 'literal' })?.message).toBe('literal');
  });
});

describe('Message type guard', () => {
  it('assistantMessage fixture typechecks against Message', () => {
    const info: Message = assistantMessage();
    expect(info.role).toBe('assistant');
  });
  it('userMessage fixture typechecks against Message', () => {
    const info: Message = userMessage();
    expect(info.role).toBe('user');
  });
});
