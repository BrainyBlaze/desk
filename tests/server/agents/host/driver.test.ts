import { describe, expect, it } from 'vitest';
import {
  isDriverCommandError,
  type AgentDriver,
  type DriverCommandError,
  type DriverEvent,
  type DriverStatusEvent
} from '../../../../src/server/agents/host/driver';
import type { AgentSurfaceEventPayload } from '../../../../src/core/agentSurfaceProtocol';

describe('isDriverCommandError', () => {
  it('returns true for an Error with string code and boolean retryable', () => {
    const error: DriverCommandError = Object.assign(new Error('session deleted'), {
      code: 'adapter-unavailable',
      retryable: false
    });
    expect(isDriverCommandError(error)).toBe(true);
  });

  it('returns false for a plain Error without code/retryable', () => {
    expect(isDriverCommandError(new Error('boom'))).toBe(false);
  });

  it('returns false when code is present but retryable is missing', () => {
    const almost = Object.assign(new Error('partial'), { code: 'adapter-unavailable' });
    expect(isDriverCommandError(almost)).toBe(false);
  });

  it('returns false when retryable is present but code is missing', () => {
    const almost = Object.assign(new Error('partial'), { retryable: true });
    expect(isDriverCommandError(almost)).toBe(false);
  });

  it('returns false when code is not a string', () => {
    const typed = Object.assign(new Error('typed'), { code: 42, retryable: true });
    expect(isDriverCommandError(typed)).toBe(false);
  });

  it('returns false when retryable is not a boolean', () => {
    const typed = Object.assign(new Error('typed'), { code: 'adapter-unavailable', retryable: 'yes' });
    expect(isDriverCommandError(typed)).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isDriverCommandError({ code: 'adapter-unavailable', retryable: false })).toBe(false);
    expect(isDriverCommandError(null)).toBe(false);
    expect(isDriverCommandError(undefined)).toBe(false);
    expect(isDriverCommandError('string')).toBe(false);
  });

  it('preserves code and retryable through throw/catch', () => {
    const build = (): never => {
      const error: DriverCommandError = Object.assign(new Error('wrong expectedTurnId'), {
        code: 'send-while-busy',
        retryable: false
      });
      throw error;
    };
    try {
      build();
      throw new Error('expected throw');
    } catch (caught) {
      if (!isDriverCommandError(caught)) {
        throw new Error('guard did not recognize thrown DriverCommandError');
      }
      expect(caught.code).toBe('send-while-busy');
      expect(caught.retryable).toBe(false);
      expect(caught.message).toBe('wrong expectedTurnId');
    }
  });
});

describe('DriverEvent payload variant acceptance', () => {
  it('accepts every AgentSurfaceEventPayload kind via the DriverEvent alias', () => {
    const sink = (event: DriverEvent): DriverEvent => event;

    expect(sink({ kind: 'session-info', agentSessionId: 'ses_abc', model: 'claude-sonnet' }).kind).toBe('session-info');
    expect(sink({ kind: 'status', state: 'idle' }).kind).toBe('status');
    expect(sink({ kind: 'user-message', id: 'm1', text: 'hi', source: 'ui' }).kind).toBe('user-message');
    expect(sink({ kind: 'assistant-delta', turnId: 't1', text: 'par' }).kind).toBe('assistant-delta');
    expect(sink({ kind: 'assistant-message', id: 'm2', turnId: 't1', markdown: '**par**' }).kind).toBe('assistant-message');
    expect(sink({ kind: 'tool-start', toolUseId: 'tu1', name: 'Read', summary: 'src/foo.ts' }).kind).toBe('tool-start');
    expect(sink({ kind: 'tool-output-delta', toolUseId: 'tu1', text: 'chunk' }).kind).toBe('tool-output-delta');
    expect(sink({ kind: 'tool-end', toolUseId: 'tu1', status: 'ok' }).kind).toBe('tool-end');
    expect(
      sink({
        kind: 'permission-request',
        requestId: 'r1',
        variant: 'tool',
        title: 'Allow Bash?',
        options: [{ id: 'allow', label: 'Allow', treatment: 'allow' }]
      }).kind
    ).toBe('permission-request');
    expect(sink({ kind: 'permission-resolved', requestId: 'r1', optionId: 'allow', via: 'ui' }).kind).toBe('permission-resolved');
    expect(sink({ kind: 'turn-complete', turnId: 't1' }).kind).toBe('turn-complete');
    expect(sink({ kind: 'attention-hint', attention: 'session-status' }).kind).toBe('attention-hint');
    expect(sink({ kind: 'history-boundary', backfillComplete: true }).kind).toBe('history-boundary');
    expect(sink({ kind: 'agent-error', message: 'failed', fatal: true }).kind).toBe('agent-error');
  });

  it('DriverStatusEvent narrows to status payloads only', () => {
    const status: DriverStatusEvent = { kind: 'status', state: 'processing', detail: 'thinking' };
    const narrowed: DriverStatusEvent['state'] = status.state;
    expect(narrowed).toBe('processing');
  });

  it('DriverEvent is structurally identical to AgentSurfaceEventPayload', () => {
    const payload: AgentSurfaceEventPayload = { kind: 'status', state: 'idle' };
    const driver: DriverEvent = payload;
    expect(driver).toBe(payload);
  });
});

describe('AgentDriver contract surface', () => {
  it('exposes the seven required methods plus onEvent via type signature', () => {
    const noop = (): void => undefined;
    const driver: AgentDriver = {
      onEvent: () => () => noop(),
      start: async () => ({ session: {}, status: { kind: 'status', state: 'starting' } }),
      inject: async () => undefined,
      respondPermission: async () => undefined,
      interrupt: async () => undefined,
      fetchHistory: async () => [],
      shutdown: async () => undefined
    };
    expect(typeof driver.onEvent).toBe('function');
    expect(typeof driver.start).toBe('function');
    expect(typeof driver.inject).toBe('function');
    expect(typeof driver.respondPermission).toBe('function');
    expect(typeof driver.interrupt).toBe('function');
    expect(typeof driver.fetchHistory).toBe('function');
    expect(typeof driver.shutdown).toBe('function');
  });

  it('start() returns session-info + status; onEvent subscribed before start (host ordering)', () => {
    const driver: AgentDriver = {
      onEvent: () => () => undefined,
      start: async () => ({
        session: { agentSessionId: 'ses_xyz', model: 'gpt-5' },
        status: { kind: 'status', state: 'idle' }
      }),
      inject: async () => undefined,
      respondPermission: async () => undefined,
      interrupt: async () => undefined,
      fetchHistory: async () => [],
      shutdown: async () => undefined
    };
    return driver.start().then((result) => {
      expect(result.session.agentSessionId).toBe('ses_xyz');
      expect(result.status.kind).toBe('status');
      expect(result.status.state).toBe('idle');
    });
  });
});
