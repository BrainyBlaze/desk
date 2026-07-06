import { describe, expect, it } from 'vitest';
import {
  parseAgentHostClientFrame,
  parseAgentHostServerFrame,
  parseAgentSurfaceEvent,
  parseAgentUiClientFrame
} from '../src/core/agentSurfaceProtocol';

const base = { seq: 1, ts: '2026-07-05T15:00:00.000Z' };

describe('parseAgentUiClientFrame', () => {
  it('parses every client frame kind', () => {
    expect(parseAgentUiClientFrame({ type: 'subscribe', session: 's1', surfaceId: 'a', visible: true })).toEqual({
      type: 'subscribe',
      session: 's1',
      surfaceId: 'a',
      visible: true
    });
    expect(parseAgentUiClientFrame({ type: 'visibility', session: 's1', surfaceId: 'a', visible: false })).toEqual({
      type: 'visibility',
      session: 's1',
      surfaceId: 'a',
      visible: false
    });
    expect(parseAgentUiClientFrame({ type: 'unsubscribe', session: 's1', surfaceId: 'a' })).toEqual({
      type: 'unsubscribe',
      session: 's1',
      surfaceId: 'a'
    });
    expect(parseAgentUiClientFrame({ type: 'send', session: 's1', surfaceId: 'a', text: 'hello' })).toEqual({
      type: 'send',
      session: 's1',
      surfaceId: 'a',
      text: 'hello'
    });
    expect(
      parseAgentUiClientFrame({
        type: 'respond-permission',
        session: 's1',
        surfaceId: 'a',
        requestId: 'req-1',
        optionId: 'allow'
      })
    ).toEqual({ type: 'respond-permission', session: 's1', surfaceId: 'a', requestId: 'req-1', optionId: 'allow' });
    expect(
      parseAgentUiClientFrame({
        type: 'respond-permission',
        session: 's1',
        surfaceId: 'a',
        requestId: 'req-1',
        optionId: 'other',
        note: 'because'
      })
    ).toEqual({
      type: 'respond-permission',
      session: 's1',
      surfaceId: 'a',
      requestId: 'req-1',
      optionId: 'other',
      note: 'because'
    });
    expect(parseAgentUiClientFrame({ type: 'interrupt', session: 's1', surfaceId: 'a' })).toEqual({
      type: 'interrupt',
      session: 's1',
      surfaceId: 'a'
    });
  });

  it('throws per missing or malformed field', () => {
    expect(() => parseAgentUiClientFrame(null)).toThrow();
    expect(() => parseAgentUiClientFrame('subscribe')).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'launch', session: 's1', surfaceId: 'a' })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'subscribe', surfaceId: 'a', visible: true })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'subscribe', session: '', surfaceId: 'a', visible: true })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'subscribe', session: 's1', visible: true })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'subscribe', session: 's1', surfaceId: 'a', visible: 'yes' })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'send', session: 's1', surfaceId: 'a' })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'send', session: 's1', surfaceId: 'a', text: '' })).toThrow();
    expect(() => parseAgentUiClientFrame({ type: 'send', session: 's1', surfaceId: 'a', text: 42 })).toThrow();
    expect(() =>
      parseAgentUiClientFrame({ type: 'respond-permission', session: 's1', surfaceId: 'a', optionId: 'allow' })
    ).toThrow();
    expect(() =>
      parseAgentUiClientFrame({ type: 'respond-permission', session: 's1', surfaceId: 'a', requestId: 'req-1' })
    ).toThrow();
    expect(() =>
      parseAgentUiClientFrame({
        type: 'respond-permission',
        session: 's1',
        surfaceId: 'a',
        requestId: 'req-1',
        optionId: 'allow',
        note: 7
      })
    ).toThrow();
  });
});

describe('parseAgentSurfaceEvent', () => {
  it('parses every event kind', () => {
    expect(parseAgentSurfaceEvent({ ...base, kind: 'session-info', agentSessionId: 'abc', model: 'm' })).toMatchObject({
      kind: 'session-info',
      agentSessionId: 'abc'
    });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'status', state: 'idle' })).toMatchObject({ state: 'idle' });
    expect(
      parseAgentSurfaceEvent({ ...base, kind: 'user-message', id: 'u1', text: 'hi', source: 'channel' })
    ).toMatchObject({ source: 'channel' });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'assistant-delta', turnId: 't1', text: 'par' })).toMatchObject({
      turnId: 't1'
    });
    expect(
      parseAgentSurfaceEvent({ ...base, kind: 'assistant-message', id: 'm1', turnId: 't1', markdown: '**hi**' })
    ).toMatchObject({ markdown: '**hi**' });
    expect(
      parseAgentSurfaceEvent({ ...base, kind: 'tool-start', toolUseId: 'tu1', name: 'Bash', summary: 'ls' })
    ).toMatchObject({ name: 'Bash' });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'tool-output-delta', toolUseId: 'tu1', text: 'out' })).toMatchObject({
      toolUseId: 'tu1'
    });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'tool-end', toolUseId: 'tu1', status: 'ok' })).toMatchObject({
      status: 'ok'
    });
    expect(
      parseAgentSurfaceEvent({
        ...base,
        kind: 'permission-request',
        requestId: 'req-1',
        variant: 'command',
        title: 'Run ls?',
        options: [{ id: 'yes', label: 'Yes', treatment: 'allow' }]
      })
    ).toMatchObject({ requestId: 'req-1' });
    expect(
      parseAgentSurfaceEvent({
        ...base,
        kind: 'permission-request',
        requestId: 'req-2',
        variant: 'question',
        title: 'Pick one',
        options: [{ id: 'a', label: 'A', treatment: 'answer' }]
      })
    ).toMatchObject({ variant: 'question' });
    expect(
      parseAgentSurfaceEvent({ ...base, kind: 'permission-resolved', requestId: 'req-1', optionId: 'yes', via: 'ui' })
    ).toMatchObject({ via: 'ui' });
    expect(
      parseAgentSurfaceEvent({ ...base, kind: 'turn-complete', turnId: 't1', usage: { outputTokens: 12 } })
    ).toMatchObject({ turnId: 't1' });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'attention-hint', attention: 'idle-prompt' })).toMatchObject({
      attention: 'idle-prompt'
    });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'history-boundary', backfillComplete: true })).toMatchObject({
      backfillComplete: true
    });
    expect(parseAgentSurfaceEvent({ ...base, kind: 'agent-error', message: 'boom', fatal: false })).toMatchObject({
      fatal: false
    });
  });

  it('throws on missing envelope fields and unknown kinds', () => {
    expect(() => parseAgentSurfaceEvent(null)).toThrow();
    expect(() => parseAgentSurfaceEvent({ kind: 'status', state: 'idle', ts: base.ts })).toThrow();
    expect(() => parseAgentSurfaceEvent({ kind: 'status', state: 'idle', seq: -1, ts: base.ts })).toThrow();
    expect(() => parseAgentSurfaceEvent({ kind: 'status', state: 'idle', seq: 1.5, ts: base.ts })).toThrow();
    expect(() => parseAgentSurfaceEvent({ kind: 'status', state: 'idle', seq: 1 })).toThrow();
    expect(() => parseAgentSurfaceEvent({ kind: 'status', state: 'idle', seq: 1, ts: '' })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'telemetry' })).toThrow();
  });

  it('throws per malformed kind-specific field', () => {
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'status', state: 'sleeping' })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'user-message', id: 'u1', text: 'hi', source: 'webhook' })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'assistant-delta', text: 'par' })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'assistant-message', id: 'm1', turnId: 't1' })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'tool-end', toolUseId: 'tu1', status: 'meh' })).toThrow();
    expect(() =>
      parseAgentSurfaceEvent({
        ...base,
        kind: 'permission-request',
        requestId: 'req-1',
        variant: 'command',
        title: 'Run?',
        options: 'yes'
      })
    ).toThrow();
    expect(() =>
      parseAgentSurfaceEvent({
        ...base,
        kind: 'permission-request',
        requestId: 'req-1',
        variant: 'command',
        title: 'Run?',
        options: [{ id: 'yes', label: 'Yes', treatment: 'shrug' }]
      })
    ).toThrow();
    expect(() =>
      parseAgentSurfaceEvent({ ...base, kind: 'permission-resolved', requestId: 'req-1', optionId: 'yes', via: 'psychic' })
    ).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'attention-hint', attention: 'vibes' })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'history-boundary', backfillComplete: false })).toThrow();
    expect(() => parseAgentSurfaceEvent({ ...base, kind: 'agent-error', message: 'boom', fatal: 'yes' })).toThrow();
  });
});

describe('parseAgentHostServerFrame', () => {
  it('parses every server-to-host frame kind', () => {
    expect(parseAgentHostServerFrame({ type: 'hello-ack', lastSeq: 0 })).toEqual({ type: 'hello-ack', lastSeq: 0 });
    expect(parseAgentHostServerFrame({ type: 'hello-ack', lastSeq: 42 })).toEqual({ type: 'hello-ack', lastSeq: 42 });
    expect(parseAgentHostServerFrame({ type: 'inject', requestId: 'r1', text: 'hi', source: 'channel' })).toEqual({
      type: 'inject',
      requestId: 'r1',
      text: 'hi',
      source: 'channel'
    });
    expect(
      parseAgentHostServerFrame({
        type: 'respond-permission',
        requestId: 'r2',
        permissionRequestId: 'perm-1',
        optionId: 'allow'
      })
    ).toEqual({ type: 'respond-permission', requestId: 'r2', permissionRequestId: 'perm-1', optionId: 'allow' });
    expect(
      parseAgentHostServerFrame({
        type: 'respond-permission',
        requestId: 'r2',
        permissionRequestId: 'perm-1',
        optionId: 'other',
        note: 'why'
      })
    ).toEqual({
      type: 'respond-permission',
      requestId: 'r2',
      permissionRequestId: 'perm-1',
      optionId: 'other',
      note: 'why'
    });
    expect(parseAgentHostServerFrame({ type: 'interrupt', requestId: 'r3' })).toEqual({ type: 'interrupt', requestId: 'r3' });
    expect(parseAgentHostServerFrame({ type: 'shutdown', requestId: 'r4' })).toEqual({ type: 'shutdown', requestId: 'r4' });
  });

  it('throws per malformed server-to-host frame', () => {
    expect(() => parseAgentHostServerFrame(null)).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'reboot' })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'hello-ack' })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'hello-ack', lastSeq: -1 })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'hello-ack', lastSeq: 1.5 })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'inject', requestId: 'r1', text: 'hi', source: 'webhook' })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'inject', requestId: 'r1', source: 'ui' })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'inject', text: 'hi', source: 'ui' })).toThrow();
    expect(() =>
      parseAgentHostServerFrame({ type: 'respond-permission', requestId: 'r2', optionId: 'allow' })
    ).toThrow();
    expect(() =>
      parseAgentHostServerFrame({
        type: 'respond-permission',
        requestId: 'r2',
        permissionRequestId: 'perm-1',
        optionId: 'allow',
        note: 9
      })
    ).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'interrupt' })).toThrow();
    expect(() => parseAgentHostServerFrame({ type: 'shutdown' })).toThrow();
  });
});

describe('parseAgentHostClientFrame', () => {
  it('parses every host frame kind including both command-result arms', () => {
    expect(
      parseAgentHostClientFrame({ type: 'hello', session: 's1', token: 'tok', agent: 'claude', pid: 4242 })
    ).toEqual({ type: 'hello', session: 's1', token: 'tok', agent: 'claude', pid: 4242 });
    expect(
      parseAgentHostClientFrame({ type: 'event', event: { ...base, kind: 'status', state: 'idle' } })
    ).toMatchObject({ type: 'event', event: { kind: 'status' } });
    expect(parseAgentHostClientFrame({ type: 'command-result', requestId: 'req-1', ok: true })).toEqual({
      type: 'command-result',
      requestId: 'req-1',
      ok: true
    });
    expect(
      parseAgentHostClientFrame({
        type: 'command-result',
        requestId: 'req-1',
        ok: false,
        error: { code: 'send-while-busy', message: 'turn active', retryable: true }
      })
    ).toEqual({
      type: 'command-result',
      requestId: 'req-1',
      ok: false,
      error: { code: 'send-while-busy', message: 'turn active', retryable: true }
    });
  });

  it('accepts unsupported-command as a typed error code (native slash-command contract)', () => {
    const frame = parseAgentHostClientFrame({
      type: 'command-result',
      requestId: 'req-slash',
      ok: false,
      error: { code: 'unsupported-command', message: '/login needs terminal mode', retryable: false }
    });
    expect(frame).toMatchObject({ type: 'command-result', ok: false });
  });

  it('throws per malformed host frame', () => {
    expect(() => parseAgentHostClientFrame(null)).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'goodbye' })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'hello', session: 's1', agent: 'claude', pid: 1 })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'hello', session: 's1', token: 'tok', agent: 'claude', pid: 'one' })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'hello', session: 's1', token: 'tok', pid: 1 })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'event', event: { kind: 'status', state: 'idle' } })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'command-result', ok: true })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'command-result', requestId: 'req-1', ok: 'yep' })).toThrow();
    expect(() => parseAgentHostClientFrame({ type: 'command-result', requestId: 'req-1', ok: false })).toThrow();
    expect(() =>
      parseAgentHostClientFrame({
        type: 'command-result',
        requestId: 'req-1',
        ok: false,
        error: { code: 'send-while-busy', message: 'turn active' }
      })
    ).toThrow();
    expect(() =>
      parseAgentHostClientFrame({
        type: 'command-result',
        requestId: 'req-1',
        ok: false,
        error: { code: 'gremlins', message: 'boom', retryable: false }
      })
    ).toThrow();
    expect(() =>
      parseAgentHostClientFrame({
        type: 'command-result',
        requestId: 'req-1',
        ok: false,
        error: { code: 'send-while-busy', message: 7, retryable: false }
      })
    ).toThrow();
  });
});
