import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, Permission, SessionStatus, ToolPart, UserMessage } from '@opencode-ai/sdk';
import {
  expandRetryStatus,
  mapHistoryMessage,
  mapLiveEvent,
  mapPermission,
  mapSessionError,
  mapSessionStatus
} from '../../../../src/server/agents/drivers/opencodeMapper';

const fixedNow = 1_725_000_000_000;

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'm-user-1',
    sessionID: 'ses_abc',
    role: 'user',
    time: { created: fixedNow },
    agent: 'build',
    ...overrides
  } as UserMessage;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm-asst-1',
    sessionID: 'ses_abc',
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
    sessionID: 'ses_abc',
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
    sessionID: 'ses_abc',
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
      { id: 'p1', sessionID: 'ses_abc', messageID: 'm-user-1', type: 'text', text: 'hi there' } as never
    ]);
    expect(events).toEqual([
      { kind: 'user-message', id: 'm-user-1', text: 'hi there', source: 'external' }
    ]);
  });

  it('honors caller-provided source for live-correlated backfill', () => {
    const info = userMessage();
    const events = mapHistoryMessage(
      info,
      [{ id: 'p1', sessionID: 'ses_abc', messageID: 'm-user-1', type: 'text', text: 'ping' } as never],
      'channel'
    );
    expect(events[0]).toMatchObject({ source: 'channel' });
  });

  it('skips synthetic text parts (opencode-injected prompts)', () => {
    const info = userMessage();
    const events = mapHistoryMessage(info, [
      { id: 'p1', sessionID: 'ses_abc', messageID: 'm-user-1', type: 'text', text: 'synthetic prefix', synthetic: true } as never,
      { id: 'p2', sessionID: 'ses_abc', messageID: 'm-user-1', type: 'text', text: 'real prompt' } as never
    ]);
    expect(events[0]).toMatchObject({ text: 'real prompt' });
  });
});

describe('mapHistoryMessage — AssistantMessage', () => {
  it('emits tool-start + tool-end + assistant-message + turn-complete for completed turns', () => {
    const info = assistantMessage();
    const events = mapHistoryMessage(info, [
      completedTool(),
      { id: 'p2', sessionID: 'ses_abc', messageID: 'm-asst-1', type: 'text', text: 'all done' } as never
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
      { id: 'p1', sessionID: 'ses_abc', messageID: 'm-asst-1', type: 'text', text: 'partial' } as never
    ]);
    expect(events.some((e) => e.kind === 'turn-complete')).toBe(false);
  });
});

describe('mapLiveEvent', () => {
  it('message.part.updated with text delta → assistant-delta', () => {
    const result = mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 'ses_abc',
            messageID: 'm-asst-1',
            type: 'text',
            text: 'accumulated'
          } as never,
          delta: 'chunk-1'
        }
      },
      {}
    );
    expect(result).toEqual({ kind: 'assistant-delta', turnId: 'm-asst-1', text: 'chunk-1' });
  });

  it('message.part.updated without delta → null (no transient emission)', () => {
    const result = mapLiveEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 'ses_abc',
            messageID: 'm-asst-1',
            type: 'text',
            text: 'accumulated'
          } as never
        }
      },
      {}
    );
    expect(result).toBeNull();
  });

  it('session.idle with pendingTurnId → status idle + turn-complete', () => {
    const result = mapLiveEvent(
      { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
      { pendingTurnId: 'm-asst-1' }
    );
    expect(result).toEqual([
      { kind: 'status', state: 'idle' },
      { kind: 'turn-complete', turnId: 'm-asst-1' }
    ]);
  });

  it('session.idle without pendingTurnId → status idle only', () => {
    const result = mapLiveEvent(
      { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
      {}
    );
    expect(result).toEqual([{ kind: 'status', state: 'idle' }]);
  });

  it('permission.updated → permission-request with allow/allow-session/deny options', () => {
    const perm: Permission = {
      id: 'perm-1',
      type: 'command',
      sessionID: 'ses_abc',
      messageID: 'm-asst-1',
      title: 'Run `rm -rf /`?',
      metadata: {},
      time: { created: fixedNow }
    };
    const result = mapLiveEvent({ type: 'permission.updated', properties: perm }, {});
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
        properties: { sessionID: 'ses_abc', permissionID: 'perm-1', response: 'allow-always' }
      },
      {}
    );
    expect(result).toEqual({
      kind: 'permission-resolved',
      requestId: 'perm-1',
      optionId: 'allow-always',
      via: 'agent'
    });
  });

  it('unmapped event kinds (file.*, tui.*, etc.) return null', () => {
    expect(
      mapLiveEvent(
        { type: 'file.edited', properties: { path: '/foo', sessionID: 'ses_abc' } } as never,
        {}
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
      sessionID: 'ses_abc',
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
      sessionID: 'ses_abc',
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
      sessionID: 'ses_abc',
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
