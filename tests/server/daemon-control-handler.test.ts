import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createDaemonControlHandler, isSafeDaemonSessionId } from '../../src/server/runtime/terminalDaemon.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  DESK_EVENT_SCHEMA_VERSION,
  type AgentEndpointRegistration,
  type AgentStateEnvelope
} from '../../src/shared/controlPlane/index.js';

interface Captured {
  status: number;
  body: Record<string, unknown> | undefined;
}

interface DaemonMock {
  provision: ReturnType<typeof vi.fn>;
  resetProviderSession: ReturnType<typeof vi.fn>;
  completeProviderSessionLaunch: ReturnType<typeof vi.fn>;
  retire: ReturnType<typeof vi.fn>;
  retireGeneration: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  tail: ReturnType<typeof vi.fn>;
  terminalObservation: ReturnType<typeof vi.fn>;
  agentEndpoint: ReturnType<typeof vi.fn>;
  agentEvent: ReturnType<typeof vi.fn>;
  agentStates: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof vi.fn>;
  channelEvent: ReturnType<typeof vi.fn>;
  readEvents: ReturnType<typeof vi.fn>;
  clearEvents: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

function invoke(
  daemon: DaemonMock,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  handlerOptions?: Parameters<typeof createDaemonControlHandler>[1]
): Promise<Captured> {
  const handler = createDaemonControlHandler(daemon, handlerOptions);
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  req.method = method;
  req.url = url;
  req.headers = headers ?? {};
  return new Promise<Captured>((resolve) => {
    let status = 0;
    const res = {
      set statusCode(value: number) {
        status = value;
      },
      setHeader() {
        /* sendJson sets content-type; irrelevant to these assertions */
      },
      once() {
        /* mutation-barrier release listeners; the mock resolves on end() */
        return res;
      },
      end(payload?: string) {
        resolve({ status, body: payload ? (JSON.parse(payload) as Captured['body']) : undefined });
      }
    } as unknown as ServerResponse;
    handler(req, res);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function daemonMock(provisionResult: unknown = { ok: true, generation: 1, created: true }): DaemonMock {
  return {
    provision: vi.fn().mockResolvedValue(provisionResult),
    resetProviderSession: vi.fn().mockResolvedValue({
      ok: true,
      authorizationId: 'authorization-1',
      generation: 7,
      state: 'authorized'
    }),
    completeProviderSessionLaunch: vi.fn().mockReturnValue({
      ok: true,
      kind: 'completed'
    }),
    retire: vi.fn().mockResolvedValue({ ok: true }),
    retireGeneration: vi.fn().mockResolvedValue({ ok: true }),
    input: vi.fn().mockReturnValue(true),
    tail: vi.fn().mockReturnValue({ lines: ['line-a', 'line-b'], totalAvailable: 42 }),
    terminalObservation: vi.fn().mockReturnValue({
      sessionId: 'sess-a',
      generation: 1,
      ready: true,
      readyAt: 1000,
      activity: 'working',
      activityAt: 1100,
      title: 'Building',
      link: null,
      exit: null,
      updatedAt: 1100
    }),
    agentEndpoint: vi.fn().mockReturnValue({
      kind: 'accepted',
      registration: agentEndpoint(),
      active: false
    }),
    activateAgentEndpoint: vi.fn().mockResolvedValue({
      kind: 'activated',
      registration: agentEndpoint()
    }),
    agentEvent: vi.fn().mockReturnValue({
      kind: 'accepted',
      event: { acceptanceId: 'sess-a:1:accepted:7', acceptedSeq: 7 },
      mutation: { kind: 'applied' }
    }),
    agentStates: vi.fn().mockReturnValue({ revision: 7, snapshots: [] }),
    events: vi.fn().mockReturnValue({
      schemaVersion: DESK_EVENT_SCHEMA_VERSION,
      latestSeq: 1,
      unread: 1,
      items: [
        {
          schemaVersion: DESK_EVENT_SCHEMA_VERSION,
          id: 'desk-event-1',
          seq: 1,
          at: '2026-07-27T12:00:00.000Z',
          read: false,
          kind: 'agent-idle',
          sessionId: 'sess-a',
          generation: 1,
          authorityRevision: 7
        }
      ]
    }),
    channelEvent: vi.fn().mockReturnValue({
      kind: 'appended',
      event: {
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        id: 'desk-event-2',
        seq: 2,
        at: '2026-07-27T12:01:00.000Z',
        read: false,
        kind: 'channel-message',
        channel: 'desk',
        messageId: 'msg-2',
        author: 'human',
        mentionsOperator: true,
        message: 'Review this'
      }
    }),
    readEvents: vi.fn().mockReturnValue(0),
    clearEvents: vi.fn().mockReturnValue(0),
    isReady: vi.fn().mockReturnValue(true),
    isDraining: vi.fn().mockReturnValue(false),
    enterMutation: vi.fn((_abort: () => void) => () => undefined),
    moorSessionStatus: vi.fn().mockReturnValue(undefined),
    health: vi.fn().mockReturnValue({ status: 'healthy' })
  };
}

const terminalSubject = { kind: 'terminal' } as const;
const agentSubject = {
  kind: 'agent',
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks'
} as const;
const agentEndpoint = (
  overrides: Partial<AgentEndpointRegistration> = {}
): AgentEndpointRegistration => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  sessionId: 'sess-opencode',
  generation: 1,
  provider: 'opencode',
  mode: 'terminal',
  producer: 'opencode-terminal',
  producerInstanceId: 'plugin-a',
  producerSeq: 2,
  endpoint: 'http://127.0.0.1:4096/',
  providerSessionId: 'ses_aaaaaaaaaaaaaaaaaaaa',
  observedAt: 1_000,
  ...overrides
});
const agentEvent = (overrides: Partial<AgentStateEnvelope> = {}): AgentStateEnvelope => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  sessionId: 'sess-a',
  generation: 1,
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks',
  producerInstanceId: 'hooks-a',
  producerSeq: 1,
  eventId: 'hooks-a:1',
  invocationId: 'turn-1',
  occurredAt: 900,
  observedAt: 950,
  facts: [{ kind: 'activity', activity: 'working' }],
  ...overrides
});

describe('daemon control handler', () => {
  it('serves the adopted moor status as wire truth and 404s without a live link (#8)', async () => {
    const daemon = daemonMock();
    daemon.moorSessionStatus = vi.fn().mockReturnValue({
      generation: 2,
      wallStart: 1_755_000_000_000n,
      pid: 4321,
      running: true
    });
    const hit = await invoke(daemon, 'GET', '/control/moor-status?sessionId=sess-a');
    expect(hit).toEqual({
      status: 200,
      body: { ok: true, generation: 2, wallStartMs: 1_755_000_000_000, pid: 4321, running: true }
    });
    expect(daemon.moorSessionStatus).toHaveBeenCalledWith('sess-a');

    daemon.moorSessionStatus = vi.fn().mockReturnValue(undefined);
    const miss = await invoke(daemon, 'GET', '/control/moor-status?sessionId=sess-a');
    expect(miss).toMatchObject({ status: 404, body: { ok: false } });

    const bad = await invoke(daemon, 'GET', '/control/moor-status?sessionId=../evil');
    expect(bad).toMatchObject({ status: 400 });
  });

  it('provisions a session and returns ok', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'spawntest',
      command: ['sh', '-c', 'bash'],
      geometry: { rows: 10, cols: 20 },
      subject: agentSubject,
      providerSessionId: '11111111-2222-4333-8444-555555555555'
    });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(daemon.provision).toHaveBeenCalledWith('spawntest', {
      command: ['sh', '-c', 'bash'],
      geometry: { rows: 10, cols: 20 },
      subject: agentSubject,
      providerSessionId: '11111111-2222-4333-8444-555555555555'
    });
  });

  it('rejects a non-string provider session id before provisioning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'spawntest',
      command: ['codex'],
      subject: agentSubject,
      providerSessionId: 7
    });

    expect(result).toEqual({
      status: 400,
      body: { ok: false, error: 'providerSessionId must be a string' }
    });
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('runs Claude continuity preflight before provisioning', async () => {
    const daemon = daemonMock();
    const prepareClaudeSessionStart = vi.fn();
    const continuity = {
      schemaVersion: 1,
      provider: 'claude',
      providerSessionId: '11111111-2222-4333-8444-555555555555',
      cwd: '/tmp/work',
      profileId: 'work'
    } as const;

    const result = await invoke(
      daemon,
      'POST',
      '/control/provision',
      {
        sessionId: 'spawntest',
        command: ['sh', '-c', 'bash'],
        subject: agentSubject,
        continuity
      },
      undefined,
      { prepareClaudeSessionStart }
    );

    expect(result.status).toBe(200);
    expect(prepareClaudeSessionStart).toHaveBeenCalledWith(continuity, 'spawntest');
    expect(prepareClaudeSessionStart.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.provision.mock.invocationCallOrder[0]
    );
  });

  it('does not provision when Claude continuity preflight fails', async () => {
    const daemon = daemonMock();
    const prepareClaudeSessionStart = vi.fn(() => {
      throw Object.assign(new Error('target transcript differs'), {
        code: 'continuity-session-conflict'
      });
    });

    const result = await invoke(
      daemon,
      'POST',
      '/control/provision',
      {
        sessionId: 'spawntest',
        command: ['sh', '-c', 'bash'],
        subject: agentSubject,
        continuity: {
          schemaVersion: 1,
          provider: 'claude',
          providerSessionId: '11111111-2222-4333-8444-555555555555',
          cwd: '/tmp/work',
          profileId: 'work'
        }
      },
      undefined,
      { prepareClaudeSessionStart }
    );

    expect(result).toEqual({
      status: 409,
      body: {
        ok: false,
        error: 'continuity-session-conflict: target transcript differs'
      }
    });
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('synchronizes Claude profile memory before provisioning a fresh session', async () => {
    const daemon = daemonMock();
    const syncClaudeProfileMemory = vi.fn().mockReturnValue({
      profileId: 'work',
      projectSlug: '-tmp-work',
      conflicts: []
    });
    const claudeMemory = {
      schemaVersion: 1,
      provider: 'claude',
      cwd: '/tmp/work',
      profileId: 'work'
    } as const;

    const result = await invoke(
      daemon,
      'POST',
      '/control/provision',
      {
        sessionId: 'spawntest',
        command: ['claude'],
        subject: agentSubject,
        claudeMemory
      },
      undefined,
      { syncClaudeProfileMemory }
    );

    expect(result.status).toBe(200);
    expect(syncClaudeProfileMemory).toHaveBeenCalledWith(claudeMemory, 'spawntest');
    expect(syncClaudeProfileMemory.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.provision.mock.invocationCallOrder[0]
    );
  });

  it('does not block Claude startup when profile memory synchronization fails', async () => {
    const daemon = daemonMock();
    const syncClaudeProfileMemory = vi.fn(() => {
      throw new Error('memory store unavailable');
    });

    const result = await invoke(
      daemon,
      'POST',
      '/control/provision',
      {
        sessionId: 'spawntest',
        command: ['claude'],
        subject: agentSubject,
        claudeMemory: {
          schemaVersion: 1,
          provider: 'claude',
          cwd: '/tmp/work',
          profileId: 'work'
        }
      },
      undefined,
      { syncClaudeProfileMemory }
    );

    expect(result.status).toBe(200);
    expect(daemon.provision).toHaveBeenCalledOnce();
  });

  it('defaults geometry when absent', async () => {
    const daemon = daemonMock();
    await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'sess-a',
      command: ['bash'],
      subject: terminalSubject
    });
    expect(daemon.provision).toHaveBeenCalledWith('sess-a', {
      command: ['bash'],
      geometry: { rows: 24, cols: 80 },
      subject: terminalSubject
    });
  });

  it('rejects a path-traversal sessionId without spawning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: '../escape',
      command: ['bash'],
      subject: terminalSubject
    });
    expect(result.status).toBe(400);
    expect(result.body?.ok).toBe(false);
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('rejects an empty command without spawning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'sess-a',
      command: [],
      subject: terminalSubject
    });
    expect(result.status).toBe(400);
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('surfaces a provision refusal as a non-2xx error, not a silent ok', async () => {
    const daemon = daemonMock({ ok: false, reason: 'cap-exceeded' });
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'sess-a',
      command: ['bash'],
      subject: terminalSubject
    });
    expect(result.status).toBe(503);
    expect(result.body?.ok).toBe(false);
    expect(result.body?.error).toContain('cap-exceeded');
  });

  it('preserves typed provider reset recovery detail in a provision refusal', async () => {
    const daemon = daemonMock({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'reset-incomplete'
    });
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'sess-a',
      command: ['codex'],
      subject: agentSubject
    });

    expect(result).toEqual({
      status: 503,
      body: {
        ok: false,
        error:
          'provider-session-identity-missing: reset-incomplete; rerun `desk reset-provider-session sess-a --force` to finish the interrupted reset',
        detail: 'reset-incomplete',
        recovery:
          'rerun `desk reset-provider-session sess-a --force` to finish the interrupted reset'
      }
    });
  });

  it('explains that a consumed claim needs a new explicit reset', async () => {
    const daemon = daemonMock({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'authorization-consumed'
    });
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'sess-a',
      command: ['codex'],
      subject: agentSubject
    });

    expect(result).toEqual({
      status: 503,
      body: {
        ok: false,
        error:
          'provider-session-identity-missing: authorization-consumed; rerun `desk reset-provider-session sess-a --force` after confirming the prior provider process is stopped',
        detail: 'authorization-consumed',
        recovery:
          'rerun `desk reset-provider-session sess-a --force` after confirming the prior provider process is stopped'
      }
    });
  });

  it('reports a thrown provision error as HTTP 500', async () => {
    const daemon = { ...daemonMock(), provision: vi.fn().mockRejectedValue(new Error('spawn failed')) };
    const result = await invoke(daemon, 'POST', '/control/provision', {
      sessionId: 'sess-a',
      command: ['bash'],
      subject: terminalSubject
    });
    expect(result.status).toBe(500);
    expect(result.body?.error).toContain('spawn failed');
  });

  it('retires a session (200 only after the awaited kill reports done)', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/retire', { sessionId: 'sess-a' });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(daemon.retire).toHaveBeenCalledWith('sess-a');
  });

  it('surfaces a failed kill as non-2xx, never a silent success', async () => {
    const daemon = { ...daemonMock(), retire: vi.fn().mockResolvedValue({ ok: false, error: 'kill command exited 1' }) };
    const result = await invoke(daemon, 'POST', '/control/retire', { sessionId: 'sess-a' });
    expect(result.status).toBe(502);
    expect(result.body?.error).toContain('kill command exited 1');
  });

  it('retires only the exact requested generation', async () => {
    const daemon = daemonMock();

    const result = await invoke(
      daemon,
      'POST',
      '/control/retire-generation',
      { sessionId: 'sess-a', generation: 7 }
    );

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(daemon.retireGeneration).toHaveBeenCalledWith('sess-a', 7);
    expect(daemon.retire).not.toHaveBeenCalled();
  });

  it('authorizes provider-session reset only through the explicit daemon transaction', async () => {
    const daemon = daemonMock();

    const result = await invoke(
      daemon,
      'POST',
      '/control/provider-session/reset',
      { sessionId: 'sess-a' }
    );

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        authorizationId: 'authorization-1',
        generation: 7,
        state: 'authorized'
      }
    });
    expect(daemon.resetProviderSession).toHaveBeenCalledWith('sess-a');
  });

  it('preserves typed reset recovery details from the daemon', async () => {
    const daemon = daemonMock();
    daemon.resetProviderSession.mockResolvedValue({
      ok: false,
      reason: 'session-live',
      error: 'session sess-a still has a listening master'
    });

    const result = await invoke(
      daemon,
      'POST',
      '/control/provider-session/reset',
      { sessionId: 'sess-a' }
    );

    expect(result).toEqual({
      status: 409,
      body: {
        ok: false,
        reason: 'session-live',
        error: 'session sess-a still has a listening master'
      }
    });
  });

  it('completes only an exact provider launch authorization', async () => {
    const daemon = daemonMock();
    const body = {
      deskSessionId: 'sess-a',
      provider: 'codex',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      generation: 8
    };

    const result = await invoke(
      daemon,
      'POST',
      '/control/provider-session/complete',
      body
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, kind: 'completed' }
    });
    expect(daemon.completeProviderSessionLaunch).toHaveBeenCalledWith(body);
  });

  it.each([
    [{ deskSessionId: '../bad', provider: 'codex', providerSessionId: '11111111-1111-4111-8111-111111111111', generation: 8 }, 'invalid deskSessionId'],
    [{ deskSessionId: 'sess-a', provider: 'bash', providerSessionId: '11111111-1111-4111-8111-111111111111', generation: 8 }, 'invalid provider'],
    [{ deskSessionId: 'sess-a', provider: 'codex', providerSessionId: 'not-an-id', generation: 8 }, 'invalid providerSessionId'],
    [{ deskSessionId: 'sess-a', provider: 'codex', providerSessionId: '11111111-1111-4111-8111-111111111111', generation: 0 }, 'generation must be a positive safe integer']
  ])('rejects malformed provider launch completion %#', async (body, error) => {
    const daemon = daemonMock();

    const result = await invoke(
      daemon,
      'POST',
      '/control/provider-session/complete',
      body
    );

    expect(result).toEqual({ status: 400, body: { ok: false, error } });
    expect(daemon.completeProviderSessionLaunch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '1', null])(
    'rejects invalid exact-retire generation %j',
    async (generation) => {
      const daemon = daemonMock();

      const result = await invoke(
        daemon,
        'POST',
        '/control/retire-generation',
        { sessionId: 'sess-a', generation }
      );

      expect(result).toEqual({
        status: 400,
        body: { ok: false, error: 'generation must be a positive safe integer' }
      });
      expect(daemon.retireGeneration).not.toHaveBeenCalled();
    }
  );

  it('surfaces an exact-retire generation mismatch without killing the successor', async () => {
    const daemon = {
      ...daemonMock(),
      retireGeneration: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'generation-mismatch',
        expectedGeneration: 6,
        currentGeneration: 7,
        error: 'session sess-a is generation 7, not 6'
      })
    };

    const result = await invoke(
      daemon,
      'POST',
      '/control/retire-generation',
      { sessionId: 'sess-a', generation: 6 }
    );

    expect(result).toEqual({
      status: 409,
      body: {
        ok: false,
        reason: 'generation-mismatch',
        expectedGeneration: 6,
        currentGeneration: 7,
        error: 'session sess-a is generation 7, not 6'
      }
    });
    expect(daemon.retire).not.toHaveBeenCalled();
  });

  it('answers the health probe', async () => {
    const result = await invoke(daemonMock(), 'GET', '/control/health');
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it('reports recoverable journal corruption as degraded without failing readiness', async () => {
    const daemon = {
      ...daemonMock(),
      health: vi.fn().mockReturnValue({
        status: 'degraded',
        reasons: [
          {
            reason: 'event-journal-corrupt',
            detail: 'corrupt at record 2',
            quarantinePath: '/tmp/desk-events.ndjson.corrupt-1'
          }
        ]
      })
    };
    const result = await invoke(daemon, 'GET', '/control/health');
    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        status: 'degraded',
        reasons: [
          {
            reason: 'event-journal-corrupt',
            detail: 'corrupt at record 2',
            quarantinePath: '/tmp/desk-events.ndjson.corrupt-1'
          }
        ]
      }
    });
  });

  it('404s an unknown control path', async () => {
    const result = await invoke(daemonMock(), 'POST', '/control/bogus', {});
    expect(result.status).toBe(404);
  });

  it('maps an over-cap body to a typed 413 without spawning', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/provision', '{}', {
      'content-length': String(128 * 1024)
    });
    expect(result.status).toBe(413);
    expect(daemon.provision).not.toHaveBeenCalled();
  });

  it('injects input for a known session, threading the paste flag', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/input', { sessionId: 'sess-a', text: 'hi\n', paste: true });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    const [sessionId, bytes, paste] = daemon.input.mock.calls[0];
    expect(sessionId).toBe('sess-a');
    expect(new TextDecoder().decode(bytes)).toBe('hi\n');
    expect(paste).toBe(true);
  });

  it('404s input for an unknown session (a concrete failure, not a silent ok)', async () => {
    const daemon = { ...daemonMock(), input: vi.fn().mockReturnValue(false) };
    const result = await invoke(daemon, 'POST', '/control/input', { sessionId: 'ghost', text: 'hi' });
    expect(result.status).toBe(404);
    expect(result.body?.ok).toBe(false);
  });

  it('400s empty input text without touching the daemon', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/input', { sessionId: 'sess-a', text: '' });
    expect(result.status).toBe(400);
    expect(daemon.input).not.toHaveBeenCalled();
  });

  it('returns the tail lines for a known session, clamping rows', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a', rows: 5000 });
    expect(result.status).toBe(200);
    expect(result.body?.lines).toEqual(['line-a', 'line-b']);
    expect(result.body?.totalAvailable).toBe(42);
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 2000, 0);
  });

  it('defaults tail rows and offset when absent and 404s an unknown session', async () => {
    const daemon = daemonMock();
    await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a' });
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 200, 0);
    const unknown = { ...daemonMock(), tail: vi.fn().mockReturnValue(undefined) };
    const result = await invoke(unknown, 'POST', '/control/tail', { sessionId: 'ghost' });
    expect(result.status).toBe(404);
  });

  it('parses and bounds the tail offset (lines back from the live edge)', async () => {
    const daemon = daemonMock();
    await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a', rows: 100, offset: 250 });
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 100, 250);
    await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a', rows: 100, offset: 99999 });
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 100, 5000);
    await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a', rows: 100, offset: -3 });
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 100, 0);
    await invoke(daemon, 'POST', '/control/tail', { sessionId: 'sess-a', rows: 100, offset: 'junk' });
    expect(daemon.tail).toHaveBeenCalledWith('sess-a', 100, 0);
  });

  it('returns the separate terminal observation for a known session', async () => {
    const daemon = daemonMock();
    const result = await invoke(
      daemon,
      'GET',
      '/control/terminal-observation?sessionId=sess-a'
    );
    expect(result.status).toBe(200);
    expect(result.body?.observation).toMatchObject({
      sessionId: 'sess-a',
      generation: 1,
      activity: 'working',
      title: 'Building'
    });
    expect(daemon.terminalObservation).toHaveBeenCalledWith('sess-a');
  });

  it('rejects invalid observation ids and 404s unknown sessions', async () => {
    const daemon = daemonMock();
    expect(
      await invoke(
        daemon,
        'GET',
        '/control/terminal-observation?sessionId=../escape'
      )
    ).toMatchObject({ status: 400 });
    daemon.terminalObservation.mockReturnValueOnce(undefined);
    expect(
      await invoke(
        daemon,
        'GET',
        '/control/terminal-observation?sessionId=ghost'
      )
    ).toMatchObject({ status: 404 });
  });

  it('503s EVERY route (health included) until startup reconciliation is terminal', async () => {
    const daemon = { ...daemonMock(), isReady: vi.fn().mockReturnValue(false) };
    for (const [method, path, body] of [
      ['GET', '/control/health', undefined],
      ['POST', '/control/provision', { sessionId: 'sess-a', command: ['bash'], subject: terminalSubject }],
      ['POST', '/control/provider-session/reset', { sessionId: 'sess-a' }],
      ['POST', '/control/provider-session/complete', {
        deskSessionId: 'sess-a',
        provider: 'codex',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        generation: 1
      }],
      ['POST', '/control/retire', { sessionId: 'sess-a' }],
      ['POST', '/control/retire-generation', { sessionId: 'sess-a', generation: 1 }],
      ['POST', '/control/input', { sessionId: 'sess-a', text: 'x' }],
      ['POST', '/control/tail', { sessionId: 'sess-a' }],
      ['GET', '/control/terminal-observation?sessionId=sess-a', undefined],
      ['POST', '/control/agent-endpoint', agentEndpoint()],
      ['POST', '/control/agent-event', agentEvent()],
      ['GET', '/control/agent-states', undefined]
    ] as const) {
      const result = await invoke(daemon, method, path, body);
      expect(result.status).toBe(503);
      expect(result.body?.error).toBe('starting');
    }
    // a pre-ready provision must never reach the daemon — it could destroy a
    // surviving master that reconcile was about to adopt
    expect(daemon.provision).not.toHaveBeenCalled();
    expect(daemon.retire).not.toHaveBeenCalled();
  });

  it('accepts a canonical event and forwards it unchanged', async () => {
    const daemon = daemonMock();
    const envelope = agentEvent();
    const result = await invoke(daemon, 'POST', '/control/agent-event', envelope);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, kind: 'accepted', acceptanceId: 'sess-a:1:accepted:7' });
    expect(daemon.agentEvent).toHaveBeenCalledWith(envelope);
  });

  it('unwraps provider-session scope before forwarding a canonical event', async () => {
    const daemon = daemonMock();
    const envelope = agentEvent({
      provider: 'opencode',
      producer: 'opencode-terminal',
      producerInstanceId: 'plugin-a'
    });
    const scope = {
      kind: 'provider-session' as const,
      providerSessionId: 'provider-session-a'
    };

    const result = await invoke(daemon, 'POST', '/control/agent-event', {
      envelope,
      scope
    });

    expect(result.status).toBe(200);
    expect(daemon.agentEvent).toHaveBeenCalledWith(envelope, scope);
  });

  it('returns the original receipt for a duplicate canonical event', async () => {
    const daemon = {
      ...daemonMock(),
      agentEvent: vi.fn().mockReturnValue({
        kind: 'duplicate',
        event: { acceptanceId: 'sess-a:1:accepted:4', acceptedSeq: 4 }
      })
    };
    const result = await invoke(daemon, 'POST', '/control/agent-event', agentEvent());
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, kind: 'duplicate', acceptanceId: 'sess-a:1:accepted:4' }
    });
  });

  it('accepts canonical endpoint metadata and forwards it unchanged', async () => {
    const daemon = daemonMock();
    const registration = agentEndpoint();
    const result = await invoke(
      daemon,
      'POST',
      '/control/agent-endpoint',
      registration
    );

    expect(daemon.agentEndpoint).toHaveBeenCalledWith(registration);
    expect(result).toEqual({
      status: 200,
      body: { ok: true, kind: 'accepted', active: false }
    });
  });

  it('activates exact staged endpoint metadata through a separate control request', async () => {
    const daemon = daemonMock();
    const { observedAt: _observedAt, ...activation } = agentEndpoint();
    const result = await invoke(
      daemon,
      'POST',
      '/control/agent-endpoint/activate',
      activation
    );

    expect(daemon.activateAgentEndpoint).toHaveBeenCalledWith(activation);
    expect(result).toEqual({
      status: 200,
      body: { ok: true, kind: 'activated' }
    });
  });

  it.each([
    ['invalid-registration', 400],
    ['provider-session-id-invalid', 400],
    ['producer-unregistered', 404],
    ['generation-fence', 409],
    ['producer-instance-mismatch', 409],
    ['producer-order', 409],
    ['idempotency-conflict', 409]
  ] as const)('maps endpoint rejection %s to HTTP %s', async (reason, status) => {
    const daemon = {
      ...daemonMock(),
      agentEndpoint: vi.fn().mockReturnValue({
        kind: 'rejected',
        reason,
        ...(reason === 'generation-fence' ? { carried: 1, current: 2 } : {})
      })
    };

    const result = await invoke(
      daemon,
      'POST',
      '/control/agent-endpoint',
      agentEndpoint()
    );

    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ ok: false, reason });
    if (reason === 'generation-fence') {
      expect(result.body).toMatchObject({ carried: 1, current: 2 });
    }
  });

  it('maps invalid envelopes to 400 and fenced/conflicting events to 409', async () => {
    const invalid = {
      ...daemonMock(),
      agentEvent: vi.fn().mockReturnValue({ kind: 'rejected', reason: 'invalid-envelope' })
    };
    expect((await invoke(invalid, 'POST', '/control/agent-event', { nope: true })).status).toBe(400);

    const fenced = {
      ...daemonMock(),
      agentEvent: vi.fn().mockReturnValue({
        kind: 'rejected',
        reason: 'generation-fence',
        carried: 1,
        current: 2
      })
    };
    const result = await invoke(fenced, 'POST', '/control/agent-event', agentEvent());
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, reason: 'generation-fence', carried: 1, current: 2 });
  });

  it('returns one atomic canonical snapshot view', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'GET', '/control/agent-states');
    expect(result).toEqual({
      status: 200,
      body: { ok: true, revision: 7, snapshots: [] }
    });
  });

  it('returns the durable unified event feed with a bounded limit', async () => {
    const daemon = daemonMock();
    const result = await invoke(daemon, 'GET', '/control/events?limit=50000');
    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true,
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        latestSeq: 1,
        unread: 1
      }
    });
    expect(daemon.events).toHaveBeenCalledWith(1_000);
  });

  it('accepts a validated channel notification and preserves its idempotency receipt', async () => {
    const daemon = daemonMock();
    const input = {
      channel: 'desk',
      messageId: 'msg-2',
      author: 'human',
      mentionsOperator: true,
      message: 'Review this'
    };
    const result = await invoke(
      daemon,
      'POST',
      '/control/events/channel',
      input
    );
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, kind: 'appended', event: { id: 'desk-event-2' } }
    });
    expect(daemon.channelEvent).toHaveBeenCalledWith(input);

    const conflictDaemon = {
      ...daemonMock(),
      channelEvent: vi.fn().mockReturnValue({ kind: 'conflict' })
    };
    expect(
      (
        await invoke(
          conflictDaemon,
          'POST',
          '/control/events/channel',
          input
        )
      ).status
    ).toBe(409);
  });

  it('rejects malformed channel/read requests before mutating the journal', async () => {
    const daemon = daemonMock();
    expect(
      (
        await invoke(daemon, 'POST', '/control/events/channel', {
          channel: 'desk',
          messageId: 'msg-2',
          author: 'human',
          message: 'missing mentionsOperator'
        })
      ).status
    ).toBe(400);
    expect(
      (await invoke(daemon, 'POST', '/control/events/read', {})).status
    ).toBe(400);
    expect(daemon.channelEvent).not.toHaveBeenCalled();
    expect(daemon.readEvents).not.toHaveBeenCalled();
  });

  it('marks feed records read and clears only the feed acknowledgment', async () => {
    const daemon = daemonMock();
    const read = await invoke(daemon, 'POST', '/control/events/read', {
      kinds: ['agent-idle']
    });
    expect(read).toEqual({ status: 200, body: { ok: true, unread: 0 } });
    expect(daemon.readEvents).toHaveBeenCalledWith({
      kinds: ['agent-idle']
    });

    const cleared = await invoke(
      daemon,
      'POST',
      '/control/events/clear'
    );
    expect(cleared).toEqual({
      status: 200,
      body: { ok: true, unread: 0 }
    });
    expect(daemon.clearEvents).toHaveBeenCalledOnce();
    expect(daemon.agentStates).not.toHaveBeenCalled();
  });

  it('does not expose the retired terminal-attention route', async () => {
    const result = await invoke(daemonMock(), 'POST', '/control/attention', { since: 0 });
    expect(result.status).toBe(404);
  });
});

describe('isSafeDaemonSessionId', () => {
  it('accepts real session ids', () => {
    for (const id of ['shell', 'spawntest', 'agentdesk-canary-shell-002e06d4', 'a1_b-2']) {
      expect(isSafeDaemonSessionId(id)).toBe(true);
    }
  });

  it('rejects path separators, traversal, and non-strings', () => {
    for (const id of ['../escape', 'has/slash', 'has space', '', 'a', 42, null, undefined]) {
      expect(isSafeDaemonSessionId(id)).toBe(false);
    }
  });
});
