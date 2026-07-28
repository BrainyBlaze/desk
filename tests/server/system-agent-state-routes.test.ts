import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  DESK_EVENT_SCHEMA_VERSION,
  type AgentEndpointRegistration,
  type AgentStateEnvelope,
  type SessionStateSnapshot
} from '../../src/shared/controlPlane/index.js';
import {
  createSystemRoutes,
  type AgentEndpointGateway,
  type AgentStateGateway,
  type DeskEventGateway,
  type SystemRoutesOptions
} from '../../src/server/routes/systemRoutes.js';

interface Captured {
  handled: boolean;
  status: number;
  body: Record<string, unknown> | undefined;
}

function event(): AgentStateEnvelope {
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    sessionId: 'agent-a',
    generation: 2,
    provider: 'codex',
    mode: 'terminal',
    producer: 'codex-hooks',
    producerInstanceId: 'hooks-a',
    producerSeq: 3,
    eventId: 'hooks-a:3',
    invocationId: 'turn-3',
    occurredAt: 900,
    observedAt: 950,
    facts: [{ kind: 'activity', activity: 'idle' }]
  };
}

function producerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    sessionId: 'agent-a',
    generation: 2,
    provider: 'codex',
    mode: 'terminal',
    producer: 'codex-hooks',
    producerInstanceId: 'hooks-a',
    producerSeq: 3,
    eventId: 'hooks-a:3',
    invocationId: 'turn-3',
    occurredAt: 900,
    observation: { hook: 'Stop' },
    ...overrides
  };
}

function endpointBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    sessionId: 'agent-a',
    generation: 2,
    provider: 'opencode',
    mode: 'terminal',
    producer: 'opencode-terminal',
    producerInstanceId: 'plugin-a',
    producerSeq: 4,
    endpoint: 'http://127.0.0.1:4096/',
    providerSessionId: 'provider-session-a',
    ...overrides
  };
}

function snapshot(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    revision: 8,
    sessionId: 'agent-a',
    generation: 2,
    lifecycle: 'running',
    lifecycleSince: 800,
    exit: null,
    health: { status: 'healthy', since: 800 },
    delivery: null,
    policy: { paused: false, since: 800 },
    subject: {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      activity: 'idle',
      activitySince: 950,
      wait: null,
      evidence: null
    },
    updatedAt: 950,
    ...overrides
  } as SessionStateSnapshot;
}

function gateway(
  overrides: Partial<AgentStateGateway> = {}
): AgentStateGateway & {
  submitEvent: ReturnType<typeof vi.fn>;
  readStates: ReturnType<typeof vi.fn>;
} {
  return {
    submitEvent: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'accepted',
        acceptanceId: 'agent-a:2:accepted:9',
        acceptedSeq: 9
      }
    }),
    readStates: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, revision: 8, snapshots: [snapshot()] }
    }),
    ...overrides
  };
}

function endpointGateway(
  overrides: Partial<AgentEndpointGateway> = {}
): AgentEndpointGateway & {
  registerEndpoint: ReturnType<typeof vi.fn>;
} {
  return {
    registerEndpoint: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'accepted' }
    }),
    ...overrides
  };
}

function eventGateway(
  overrides: Partial<DeskEventGateway> = {}
): DeskEventGateway & {
  readEvents: ReturnType<typeof vi.fn>;
  markEventsRead: ReturnType<typeof vi.fn>;
  clearEvents: ReturnType<typeof vi.fn>;
} {
  return {
    readEvents: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        latestSeq: 3,
        unread: 1,
        items: [
          {
            schemaVersion: DESK_EVENT_SCHEMA_VERSION,
            id: 'desk-event-3',
            seq: 3,
            at: '2026-07-27T12:00:00.000Z',
            read: false,
            kind: 'agent-idle',
            sessionId: 'agent-a',
            generation: 2,
            authorityRevision: 8
          }
        ]
      }
    }),
    markEventsRead: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, unread: 0 }
    }),
    clearEvents: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, unread: 0 }
    }),
    ...overrides
  };
}

async function invoke(
  agentStateGateway: AgentStateGateway,
  method: string,
  path: string,
  body?: unknown,
  deskEventGateway: DeskEventGateway = eventGateway(),
  agentEndpointGateway: AgentEndpointGateway = endpointGateway(),
  options: Partial<SystemRoutesOptions> = {}
): Promise<Captured> {
  const managedAgentLsp = { reconcile: vi.fn(), cleanupAll: vi.fn() };
  const route = createSystemRoutes(managedAgentLsp, {
    agentStateGateway,
    deskEventGateway,
    agentEndpointGateway,
    now: () => 950,
    ...options
  });
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  req.method = method;
  req.url = path;
  req.headers = {};
  let status = 0;
  let responseBody: Record<string, unknown> | undefined;
  const res = {
    set statusCode(value: number) {
      status = value;
    },
    setHeader() {},
    end(payload?: string) {
      responseBody = payload
        ? (JSON.parse(payload) as Record<string, unknown>)
        : undefined;
    }
  } as unknown as ServerResponse;
  const handledPromise = route(req, res, new URL(path, 'http://desk.local'));
  if (body !== undefined) req.write(JSON.stringify(body));
  req.end();
  return {
    handled: await handledPromise,
    status,
    body: responseBody
  };
}

describe('canonical system agent-state routes', () => {
  it('maps producer bytes to a canonical envelope and returns the daemon receipt', async () => {
    const agentStateGateway = gateway();
    const envelope = event();

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody()
    );

    expect(agentStateGateway.submitEvent).toHaveBeenCalledWith(envelope);
    expect(result).toEqual({
      handled: true,
      status: 200,
      body: {
        ok: true,
        kind: 'accepted',
        acceptanceId: 'agent-a:2:accepted:9',
        acceptedSeq: 9
      }
    });
  });

  it('confirms an exact Claude provider session before forwarding SessionStart facts', async () => {
    const agentStateGateway = gateway();
    const confirmClaudeSessionStart = vi.fn().mockReturnValue({
      ok: true,
      generationId: 'generation-a'
    });
    const body = producerBody({
      provider: 'claude',
      producer: 'claude-hooks',
      observation: {
        hook: 'SessionStart',
        matcher: 'resume',
        providerSessionId: '11111111-2222-4333-8444-555555555555'
      }
    });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      body,
      eventGateway(),
      endpointGateway(),
      { confirmClaudeSessionStart }
    );

    expect(confirmClaudeSessionStart).toHaveBeenCalledWith({
      deskSessionId: 'agent-a',
      providerSessionId: '11111111-2222-4333-8444-555555555555'
    });
    expect(agentStateGateway.submitEvent).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
  });

  it('rejects a mismatched Claude provider SessionStart before forwarding facts', async () => {
    const agentStateGateway = gateway();
    const confirmClaudeSessionStart = vi.fn().mockReturnValue({
      ok: false,
      code: 'continuity-resume-unconfirmed',
      error: 'expected one provider session and observed another'
    });
    const body = producerBody({
      provider: 'claude',
      producer: 'claude-hooks',
      observation: {
        hook: 'SessionStart',
        matcher: 'resume',
        providerSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      }
    });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      body,
      eventGateway(),
      endpointGateway(),
      { confirmClaudeSessionStart }
    );

    expect(result).toEqual({
      handled: true,
      status: 409,
      body: {
        ok: false,
        code: 'continuity-resume-unconfirmed',
        error: 'expected one provider session and observed another'
      }
    });
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it.each([400, 404, 409, 503])(
    'preserves daemon semantic HTTP %s without raising legacy attention',
    async (status) => {
      const agentStateGateway = gateway({
        submitEvent: vi.fn().mockResolvedValue({
          ok: false,
          status,
          error: 'rejected',
          body: { ok: false, reason: 'generation-fence', carried: 1, current: 2 }
        })
      });

      const result = await invoke(
        agentStateGateway,
        'POST',
        '/api/agent-event',
        producerBody()
      );

      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({
        ok: false,
        reason: 'generation-fence',
        carried: 1,
        current: 2
      });
    }
  );

  it('accepts a valid observation that asserts no facts without contacting the daemon', async () => {
    const agentStateGateway = gateway();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      // SessionEnd is the hook that genuinely asserts nothing: the daemon
      // watches the process exit itself. (SessionStart does assert — a started
      // session is idle — so it is no longer an example of silence.)
      producerBody({ observation: { hook: 'SessionEnd' } })
    );

    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, kind: 'no-facts' }
    });
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid producer body with the adapter reason before contacting the daemon', async () => {
    const agentStateGateway = gateway();
    const result = await invoke(agentStateGateway, 'POST', '/api/agent-event', {
      schemaVersion: 2,
      kind: 'stop',
      session: 'legacy'
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      ok: false,
      error: 'invalid agent-state observation',
      reason: `producer body requires schemaVersion ${AGENT_STATE_SCHEMA_VERSION}`
    });
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('server-stamps and forwards endpoint registration outside the state envelope', async () => {
    const endpoints = endpointGateway();
    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody(),
      eventGateway(),
      endpoints
    );

    expect(endpoints.registerEndpoint).toHaveBeenCalledWith({
      ...endpointBody(),
      observedAt: 950
    } satisfies AgentEndpointRegistration);
    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, kind: 'accepted' }
    });
  });

  it('rejects a non-loopback endpoint before contacting the daemon', async () => {
    const endpoints = endpointGateway();
    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody({ endpoint: 'https://example.com/' }),
      eventGateway(),
      endpoints
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: 'invalid agent endpoint registration'
    });
    expect(endpoints.registerEndpoint).not.toHaveBeenCalled();
  });

  it('preserves endpoint registration rejection status and body', async () => {
    const endpoints = endpointGateway({
      registerEndpoint: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        error: 'rejected',
        body: { ok: false, reason: 'producer-instance-mismatch' }
      })
    });
    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody(),
      eventGateway(),
      endpoints
    );

    expect(result).toMatchObject({
      handled: true,
      status: 409,
      body: { ok: false, reason: 'producer-instance-mismatch' }
    });
  });

  it('returns one validated snapshot revision and never fabricates idle', async () => {
    const agentStateGateway = gateway();
    const result = await invoke(agentStateGateway, 'GET', '/api/agent-states');

    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, revision: 8, snapshots: [snapshot()] }
    });

    const unreachable = gateway({
      readStates: vi.fn().mockResolvedValue({
        ok: false,
        error: 'terminal daemon unreachable'
      })
    });
    const degraded = await invoke(
      unreachable,
      'GET',
      '/api/agent-states'
    );
    expect(degraded.status).toBe(503);
    expect(degraded.body).not.toHaveProperty('snapshots');
  });

  it('projects pulse from the same canonical read and derives running from lifecycle', async () => {
    const agentStateGateway = gateway({
      readStates: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          ok: true,
          revision: 8,
          snapshots: [
            snapshot(),
            snapshot({
              revision: 7,
              sessionId: 'agent-b',
              lifecycle: 'exited',
              exit: { at: 940, code: 0, signal: null },
              lifecycleSince: 940
            })
          ]
        }
      })
    });

    const result = await invoke(agentStateGateway, 'GET', '/api/pulse');

    expect(agentStateGateway.readStates).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      agentStates: {
        revision: 8,
        snapshots: [
          snapshot(),
          snapshot({
            revision: 7,
            sessionId: 'agent-b',
            lifecycle: 'exited',
            exit: { at: 940, code: 0, signal: null },
            lifecycleSince: 940
          })
        ]
      },
      running: ['agent-a']
    });
    expect(result.body).not.toHaveProperty('attention');
  });

  it('keeps system telemetry available without fabricating state when the authority is unavailable', async () => {
    const agentStateGateway = gateway({
      readStates: vi.fn().mockResolvedValue({
        ok: false,
        error: 'terminal daemon unreachable'
      })
    });

    const result = await invoke(agentStateGateway, 'GET', '/api/pulse');

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty('system');
    expect(result.body).not.toHaveProperty('agentStates');
    expect(result.body).not.toHaveProperty('running');
  });

  it('rejects malformed daemon snapshot payloads instead of projecting them', async () => {
    const malformed = gateway({
      readStates: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, revision: 8, snapshots: [{ state: 'idle' }] }
      })
    });

    expect(
      (await invoke(malformed, 'GET', '/api/agent-states')).status
    ).toBe(502);
  });

  it('returns the validated unified event feed without the daemon transport envelope', async () => {
    const events = eventGateway();
    const result = await invoke(
      gateway(),
      'GET',
      '/api/events?limit=25',
      undefined,
      events
    );

    expect(events.readEvents).toHaveBeenCalledWith(25);
    expect(result).toEqual({
      handled: true,
      status: 200,
      body: {
        schemaVersion: DESK_EVENT_SCHEMA_VERSION,
        latestSeq: 3,
        unread: 1,
        items: [
          {
            schemaVersion: DESK_EVENT_SCHEMA_VERSION,
            id: 'desk-event-3',
            seq: 3,
            at: '2026-07-27T12:00:00.000Z',
            read: false,
            kind: 'agent-idle',
            sessionId: 'agent-a',
            generation: 2,
            authorityRevision: 8
          }
        ]
      }
    });
  });

  it('rejects malformed daemon event feeds instead of inventing an empty feed', async () => {
    const events = eventGateway({
      readEvents: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          ok: true,
          schemaVersion: DESK_EVENT_SCHEMA_VERSION,
          latestSeq: 3,
          unread: 1,
          items: [{ kind: 'turn-complete', seq: 3 }]
        }
      })
    });
    expect(
      (
        await invoke(
          gateway(),
          'GET',
          '/api/events',
          undefined,
          events
        )
      ).status
    ).toBe(502);
  });

  it('marks journal records read without touching canonical activity', async () => {
    const state = gateway();
    const events = eventGateway();
    const result = await invoke(
      state,
      'POST',
      '/api/events/read',
      { ids: ['desk-event-3'] },
      events
    );

    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, unread: 0 }
    });
    expect(events.markEventsRead).toHaveBeenCalledWith({
      ids: ['desk-event-3']
    });
    expect(state.submitEvent).not.toHaveBeenCalled();
    expect(state.readStates).not.toHaveBeenCalled();

    expect(
      (
        await invoke(
          state,
          'POST',
          '/api/events/read',
          {},
          events
        )
      ).status
    ).toBe(400);
  });

  it('clears only the journal through the current feed sequence', async () => {
    const state = gateway();
    const events = eventGateway();
    const result = await invoke(
      state,
      'DELETE',
      '/api/events',
      undefined,
      events
    );
    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, unread: 0 }
    });
    expect(events.clearEvents).toHaveBeenCalledOnce();
    expect(state.submitEvent).not.toHaveBeenCalled();
    expect(state.readStates).not.toHaveBeenCalled();
  });

  it('does not expose retired attention endpoints', async () => {
    for (const [method, path] of [
      ['GET', '/api/attention'],
      ['POST', '/api/attention-clear'],
      ['POST', '/api/attention-read']
    ] as const) {
      expect((await invoke(gateway(), method, path, {})).handled).toBe(false);
    }
  });
});
