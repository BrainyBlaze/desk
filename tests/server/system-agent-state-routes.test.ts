import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { startSystemSampling, stopSystemSampling } from '../../src/server/systemSampler.js';

// The routes serve the background sampler's cached snapshot and REFUSE when
// it was never started (a hidden one-off collect would make the route appear
// to work in a process where nothing is sampling). Production starts it in
// installDeskRuntime before any route can serve; the test does the same.
beforeAll(() => startSystemSampling(60_000));
afterAll(() => stopSystemSampling());

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
    launchProof: 'A'.repeat(43),
    observation: {
      hook: 'Stop',
      providerSessionId: '22222222-2222-4222-8222-222222222222'
    },
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
    providerSessionId: 'ses_aaaaaaaaaaaaaaaaaaaa',
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
  activateEndpoint: ReturnType<typeof vi.fn>;
} {
  return {
    registerEndpoint: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'accepted', active: false }
    }),
    activateEndpoint: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'activated' }
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
  const route = systemRoute(
    agentStateGateway,
    deskEventGateway,
    agentEndpointGateway,
    options
  );
  return invokeRoute(route, method, path, body);
}

function systemRoute(
  agentStateGateway: AgentStateGateway,
  deskEventGateway: DeskEventGateway = eventGateway(),
  agentEndpointGateway: AgentEndpointGateway = endpointGateway(),
  options: Partial<SystemRoutesOptions> = {}
): ReturnType<typeof createSystemRoutes> {
  const managedAgentLsp = { reconcile: vi.fn(), cleanupAll: vi.fn() };
  return createSystemRoutes(managedAgentLsp, {
    agentStateGateway,
    deskEventGateway,
    agentEndpointGateway,
    bindProviderSessionIdentity: vi.fn().mockResolvedValue({
      ok: true,
      kind: 'persisted'
    }),
    completeProviderSessionLaunch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'not-required' }
    }),
    observeProviderSessionIdentity: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'matching',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222'
      }
    }),
    now: () => 950,
    ...options
  });
}

async function invokeRoute(
  route: ReturnType<typeof createSystemRoutes>,
  method: string,
  path: string,
  body?: unknown
): Promise<Captured> {
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
  it('returns the canonical runtime provenance projection', async () => {
    const provenance = {
      schemaVersion: 1 as const,
      packageKind: 'distribution' as const,
      runtimeKind: 'standalone' as const,
      version: '0.4.0',
      release: { state: 'unmanaged' as const }
    };
    const runtimeProvenance = vi.fn(() => provenance);

    const result = await invoke(
      gateway(),
      'GET',
      '/api/runtime',
      undefined,
      eventGateway(),
      endpointGateway(),
      { runtimeProvenance }
    );

    expect(runtimeProvenance).toHaveBeenCalledOnce();
    expect(result).toEqual({ handled: true, status: 200, body: provenance });
  });

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

  it('carries the exact OpenCode provider session beside the canonical envelope', async () => {
    const agentStateGateway = gateway();

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'opencode',
        producer: 'opencode-terminal',
        observation: {
          type: 'session.status',
          sessionID: 'provider-session-a',
          status: { type: 'busy' }
        }
      })
    );

    expect(result.status).toBe(200);
    expect(agentStateGateway.submitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'opencode',
        producer: 'opencode-terminal',
        facts: [{ kind: 'activity', activity: 'working' }]
      }),
      {
        kind: 'provider-session',
        providerSessionId: 'provider-session-a'
      }
    );
  });

  it('marks only the OpenCode plugin-load heartbeat as an unscoped bootstrap', async () => {
    const agentStateGateway = gateway();

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'opencode',
        producer: 'opencode-terminal',
        observation: { type: 'hook:plugin.loaded' }
      })
    );

    expect(result.status).toBe(200);
    expect(agentStateGateway.submitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        producer: 'opencode-terminal',
        facts: [{ kind: 'heartbeat' }]
      }),
      { kind: 'producer-bootstrap' }
    );
  });

  it('confirms an exact Claude provider session before forwarding SessionStart facts', async () => {
    const agentStateGateway = gateway();
    const confirmClaudeSessionStart = vi.fn().mockReturnValue({
      ok: true,
      generationId: 'generation-a'
    });
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'bound' }
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
      { confirmClaudeSessionStart, observeProviderSessionIdentity }
    );

    expect(confirmClaudeSessionStart).toHaveBeenCalledWith({
      deskSessionId: 'agent-a',
      providerSessionId: '11111111-2222-4333-8444-555555555555'
    });
    expect(observeProviderSessionIdentity).toHaveBeenCalledWith({
      deskSessionId: 'agent-a',
      provider: 'claude',
      providerSessionId: '11111111-2222-4333-8444-555555555555',
      generation: 2,
      launchProof: 'A'.repeat(43),
      hook: 'SessionStart'
    }, expect.any(Object));
    expect(agentStateGateway.submitEvent).toHaveBeenCalledOnce();
    expect(confirmClaudeSessionStart.mock.invocationCallOrder[0]).toBeLessThan(
      observeProviderSessionIdentity.mock.invocationCallOrder[0]!
    );
    expect(observeProviderSessionIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      agentStateGateway.submitEvent.mock.invocationCallOrder[0]!
    );
    expect(result.status).toBe(200);
  });

  it('binds an exact Codex thread id without Claude confirmation before forwarding', async () => {
    const agentStateGateway = gateway();
    const confirmClaudeSessionStart = vi.fn();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching' }
    });
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        observation: {
          hook: 'SessionStart',
          matcher: 'resume',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { confirmClaudeSessionStart, observeProviderSessionIdentity }
    );

    expect(confirmClaudeSessionStart).not.toHaveBeenCalled();
    expect(observeProviderSessionIdentity).toHaveBeenCalledWith({
      deskSessionId: 'agent-a',
      provider: 'codex',
      providerSessionId: '22222222-2222-4222-8222-222222222222',
      generation: 2,
      launchProof: 'A'.repeat(43),
      hook: 'SessionStart'
    }, expect.any(Object));
    expect(observeProviderSessionIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      agentStateGateway.submitEvent.mock.invocationCallOrder[0]!
    );
    expect(result.status).toBe(200);
  });

  it('binds a Qwen provider session id without Claude confirmation', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching', provider: 'qwen', providerSessionId: '33333333-3333-4333-8333-333333333333' }
    });
    const bindProviderSessionIdentity = vi.fn();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'qwen',
        producer: 'qwen-hooks',
        launchProof: 'A'.repeat(43),
        observation: {
          hook: 'SessionStart',
          providerSessionId: '33333333-3333-4333-8333-333333333333'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity, bindProviderSessionIdentity } as unknown as Partial<SystemRoutesOptions>
    );

    expect(observeProviderSessionIdentity).toHaveBeenCalledWith(
      {
        deskSessionId: 'agent-a',
        provider: 'qwen',
        providerSessionId: '33333333-3333-4333-8333-333333333333',
        generation: 2,
        launchProof: 'A'.repeat(43),
        hook: 'SessionStart'
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('binds an opaque Kimi provider session id without Claude confirmation', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching', provider: 'kimi', providerSessionId: 'kimi-session_01HZX4T9QK' }
    });
    const bindProviderSessionIdentity = vi.fn();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'kimi',
        producer: 'kimi-hooks',
        launchProof: 'A'.repeat(43),
        observation: {
          hook: 'SessionStart',
          providerSessionId: 'kimi-session_01HZX4T9QK'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity, bindProviderSessionIdentity } as unknown as Partial<SystemRoutesOptions>
    );

    expect(observeProviderSessionIdentity).toHaveBeenCalledWith(
      {
        deskSessionId: 'agent-a',
        provider: 'kimi',
        providerSessionId: 'kimi-session_01HZX4T9QK',
        generation: 2,
        launchProof: 'A'.repeat(43),
        hook: 'SessionStart'
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('binds a Grok 12-hex opaque provider session id without Claude confirmation', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching', provider: 'grok', providerSessionId: '69057f6fab27' }
    });
    const bindProviderSessionIdentity = vi.fn();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'grok',
        producer: 'grok-hooks',
        launchProof: 'A'.repeat(43),
        observation: {
          hook: 'SessionStart',
          providerSessionId: '69057f6fab27'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity, bindProviderSessionIdentity } as unknown as Partial<SystemRoutesOptions>
    );

    expect(observeProviderSessionIdentity).toHaveBeenCalledWith(
      {
        deskSessionId: 'agent-a',
        provider: 'grok',
        providerSessionId: '69057f6fab27',
        generation: 2,
        launchProof: 'A'.repeat(43),
        hook: 'SessionStart'
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('routes provider identity through daemon observation before forwarding facts', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'matching',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222'
      }
    });
    const bindProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'persisted'
    });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({ launchProof: 'A'.repeat(43) }),
      eventGateway(),
      endpointGateway(),
      {
        observeProviderSessionIdentity,
        bindProviderSessionIdentity
      } as unknown as Partial<SystemRoutesOptions>
    );

    expect(result.status).toBe(200);
    expect(observeProviderSessionIdentity).toHaveBeenCalledWith(
      {
        deskSessionId: 'agent-a',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
        launchProof: 'A'.repeat(43),
        hook: 'Stop'
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(observeProviderSessionIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      agentStateGateway.submitEvent.mock.invocationCallOrder[0]!
    );
  });

  it('does not run managed Claude SessionStart confirmation for later hooks', async () => {
    const agentStateGateway = gateway();
    const confirmClaudeSessionStart = vi.fn();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching' }
    });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'claude',
        producer: 'claude-hooks',
        observation: {
          hook: 'UserPromptSubmit',
          providerSessionId: '11111111-2222-4333-8444-555555555555'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { confirmClaudeSessionStart, observeProviderSessionIdentity }
    );

    expect(result.status).toBe(200);
    expect(confirmClaudeSessionStart).not.toHaveBeenCalled();
    expect(observeProviderSessionIdentity).toHaveBeenCalledOnce();
    expect(agentStateGateway.submitEvent).toHaveBeenCalledOnce();
  });

  it('daemon-observes every provider hook instead of caching route-local authority', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching' }
    });
    const route = systemRoute(agentStateGateway, eventGateway(), endpointGateway(), {
      observeProviderSessionIdentity
    });

    expect(
      (await invokeRoute(route, 'POST', '/api/agent-event', producerBody())).status
    ).toBe(200);
    expect(
      (
        await invokeRoute(
          route,
          'POST',
          '/api/agent-event',
          producerBody({
            producerSeq: 4,
            eventId: 'hooks-a:4',
            invocationId: 'turn-4',
            observation: {
              hook: 'PostToolUse',
              providerSessionId: '22222222-2222-4222-8222-222222222222'
            }
          })
        )
      ).status
    ).toBe(200);

    expect(observeProviderSessionIdentity).toHaveBeenCalledTimes(2);
    expect(agentStateGateway.submitEvent).toHaveBeenCalledTimes(2);
  });

  it('makes a later hook transport failure visible and permits a later retry', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon disconnected'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { ok: true, kind: 'matching' }
      });
    const route = systemRoute(agentStateGateway, eventGateway(), endpointGateway(), {
      observeProviderSessionIdentity
    });

    expect(
      (await invokeRoute(route, 'POST', '/api/agent-event', producerBody())).status
    ).toBe(503);
    expect(
      (
        await invokeRoute(
          route,
          'POST',
          '/api/agent-event',
          producerBody({ producerSeq: 4, eventId: 'hooks-a:4' })
        )
      ).status
    ).toBe(200);
    expect(observeProviderSessionIdentity).toHaveBeenCalledTimes(2);
    expect(agentStateGateway.submitEvent).toHaveBeenCalledOnce();
  });

  it('returns explicit rebind details and does not forward mismatched facts', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      error: 'provider-session-rebind-required',
      body: {
        ok: false,
        reason: 'provider-session-rebind-required',
        error: 'manual resume detected',
        currentProviderSessionId: '22222222-2222-4222-8222-222222222222',
        targetProviderSessionId: '33333333-3333-4333-8333-333333333333',
        action:
          'desk rebind-provider-session agent-a --to 33333333-3333-4333-8333-333333333333 --force'
      }
    });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        observation: {
          hook: 'SessionStart',
          providerSessionId: '33333333-3333-4333-8333-333333333333'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 409,
      body: {
        ok: false,
        reason: 'provider-session-rebind-required',
        currentProviderSessionId: '22222222-2222-4222-8222-222222222222',
        targetProviderSessionId: '33333333-3333-4333-8333-333333333333'
      }
    });
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid provider id before confirmation, binding, or forwarding', async () => {
    const agentStateGateway = gateway();
    const confirmClaudeSessionStart = vi.fn();
    const bindProviderSessionIdentity = vi.fn();

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'claude',
        producer: 'claude-hooks',
        observation: {
          hook: 'SessionStart',
          providerSessionId: 'not-a-provider-id'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { confirmClaudeSessionStart, bindProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 409,
      body: { ok: false, code: 'provider-session-id-invalid' }
    });
    expect(confirmClaudeSessionStart).not.toHaveBeenCalled();
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('rejects opaque provider session ids that break the id grammar', async () => {
    for (const providerSessionId of ['', '   ', 'has space', 'x'.repeat(129), 'семь-и-юникод']) {
      const agentStateGateway = gateway();
      const bindProviderSessionIdentity = vi.fn();
      const result = await invoke(
        agentStateGateway,
        'POST',
        '/api/agent-event',
        producerBody({
          provider: 'kimi',
          producer: 'kimi-hooks',
          observation: { hook: 'SessionStart', providerSessionId }
        }),
        eventGateway(),
        endpointGateway(),
        { bindProviderSessionIdentity }
      );
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ ok: false });
      expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
      expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
    }
  });

  it('rejects a mismatched Claude provider SessionStart before forwarding facts', async () => {
    const agentStateGateway = gateway();
    const bindProviderSessionIdentity = vi.fn();
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
      { confirmClaudeSessionStart, bindProviderSessionIdentity }
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
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing provider id before binding or forwarding SessionStart', async () => {
    const agentStateGateway = gateway();
    const bindProviderSessionIdentity = vi.fn();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({ observation: { hook: 'SessionStart', matcher: 'startup' } }),
      eventGateway(),
      endpointGateway(),
      { bindProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 409,
      body: { ok: false, code: 'provider-session-id-missing' }
    });
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing launch proof without guessing from generation', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({ launchProof: undefined }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 409,
      body: { ok: false, code: 'provider-session-proof-missing' }
    });
    expect(observeProviderSessionIdentity).not.toHaveBeenCalled();
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('retries SessionStart evidence at bounded offsets and then forwards facts', async () => {
    const agentStateGateway = gateway();
    let clock = 0;
    const observedAt: number[] = [];
    const observeProviderSessionIdentity = vi
      .fn()
      .mockImplementation(async () => {
        observedAt.push(clock);
        if (observedAt.length < 3) {
          return {
            ok: false,
            status: 409,
            error: 'provider-session-evidence-missing',
            body: {
              ok: false,
              reason: 'provider-session-evidence-missing',
              error: 'durable provider evidence is not present yet'
            }
          };
        }
        return {
          ok: true,
          status: 200,
          body: { ok: true, kind: 'bound' }
        };
      });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        observation: {
          hook: 'SessionStart',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }
      }),
      eventGateway(),
      endpointGateway(),
      {
        observeProviderSessionIdentity,
        providerSessionRetryNow: () => clock,
        providerSessionRetrySleep: async (milliseconds) => {
          clock += milliseconds;
        }
      }
    );

    expect(result.status).toBe(200);
    expect(observedAt).toEqual([0, 200, 400]);
    expect(
      observeProviderSessionIdentity.mock.calls.map((call) => call[1].timeoutMs)
    ).toEqual([1000, 800, 600]);
    expect(agentStateGateway.submitEvent).toHaveBeenCalledOnce();
  });

  it('leaves an orphan SessionStart unbound after five attempts and permits a later retry', async () => {
    const agentStateGateway = gateway();
    let clock = 0;
    const missing = {
      ok: false,
      status: 409,
      error: 'provider-session-evidence-missing',
      body: {
        ok: false,
        reason: 'provider-session-evidence-missing',
        error: 'durable provider evidence is not present yet'
      }
    };
    const observeProviderSessionIdentity = vi
      .fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { ok: true, kind: 'bound' }
      });
    const route = systemRoute(agentStateGateway, eventGateway(), endpointGateway(), {
      observeProviderSessionIdentity,
      providerSessionRetryNow: () => clock,
      providerSessionRetrySleep: async (milliseconds) => {
        clock += milliseconds;
      }
    });
    const body = producerBody({
      observation: {
        hook: 'SessionStart',
        providerSessionId: '22222222-2222-4222-8222-222222222222'
      }
    });

    expect((await invokeRoute(route, 'POST', '/api/agent-event', body)).status).toBe(
      409
    );
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
    expect(
      (
        await invokeRoute(
          route,
          'POST',
          '/api/agent-event',
          producerBody({
            ...body,
            producerSeq: 4,
            eventId: 'hooks-a:4',
            invocationId: 'turn-4'
          })
        )
      ).status
    ).toBe(200);
    expect(observeProviderSessionIdentity).toHaveBeenCalledTimes(6);
    expect(agentStateGateway.submitEvent).toHaveBeenCalledOnce();
  });

  it('does not retry wrong proof or non-SessionStart evidence failure', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      error: 'provider-session-proof-invalid',
      body: {
        ok: false,
        reason: 'provider-session-proof-invalid',
        error: 'invalid launch authorization'
      }
    });

    expect(
      (
        await invoke(
          agentStateGateway,
          'POST',
          '/api/agent-event',
          producerBody(),
          eventGateway(),
          endpointGateway(),
          { observeProviderSessionIdentity }
        )
      ).status
    ).toBe(409);
    expect(observeProviderSessionIdentity).toHaveBeenCalledOnce();
  });

  it('redacts supplied and daemon-stored proof values from rejection responses', async () => {
    const suppliedProof = 'A'.repeat(43);
    const storedProof = 'B'.repeat(43);
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      error: `wrong proof ${suppliedProof}`,
      body: {
        ok: false,
        reason: 'provider-session-proof-invalid',
        error: `received ${suppliedProof}; expected ${storedProof}`,
        action: `do not print ${storedProof}`
      }
    });

    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({ launchProof: suppliedProof }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity }
    );

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(suppliedProof);
    expect(serialized).not.toContain(storedProof);
    expect(serialized).toContain('[redacted]');
  });

  it('cancels a slow daemon observation at the route deadline', async () => {
    vi.useFakeTimers();
    try {
      const agentStateGateway = gateway();
      let carriedSignal: AbortSignal | undefined;
      const observeProviderSessionIdentity = vi.fn(
        (_input, options) => {
          carriedSignal = options?.signal;
          return new Promise(() => undefined);
        }
      );
      const pending = invoke(
        agentStateGateway,
        'POST',
        '/api/agent-event',
        producerBody(),
        eventGateway(),
        endpointGateway(),
        {
          observeProviderSessionIdentity,
          providerSessionRetryNow: () => Date.now()
        }
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ status: 503 });
      expect(carriedSignal?.aborted).toBe(true);
      expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a typed daemon observation rejection before forwarding SessionStart', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      error: 'provider-session-mismatch',
      body: {
        ok: false,
        reason: 'provider-session-mismatch',
        error: 'Desk session is already bound to another Codex thread'
      }
    });
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        observation: {
          hook: 'SessionStart',
          matcher: 'resume',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity }
    );

    expect(result).toEqual({
      handled: true,
      status: 409,
      body: {
        ok: false,
        reason: 'provider-session-mismatch',
        error: 'Desk session is already bound to another Codex thread'
      }
    });
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('returns storage failure before forwarding SessionStart', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      error: 'provider-session-store-failed',
      body: {
        ok: false,
        reason: 'provider-session-store-failed',
        error: 'provider session continuity storage failed'
      }
    });
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        observation: {
          hook: 'SessionStart',
          matcher: 'resume',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity }
    );

    expect(result).toEqual({
      handled: true,
      status: 500,
      body: {
        ok: false,
        reason: 'provider-session-store-failed',
        error: 'provider session continuity storage failed'
      }
    });
    expect(agentStateGateway.submitEvent).not.toHaveBeenCalled();
  });

  it('does not bind a mismatched provider/producer hook pair', async () => {
    const agentStateGateway = gateway();
    const bindProviderSessionIdentity = vi.fn();
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      producerBody({
        provider: 'codex',
        producer: 'claude-hooks',
        observation: {
          hook: 'SessionStart',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { bindProviderSessionIdentity }
    );

    expect(result.status).toBe(400);
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
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

  it('daemon-observes provider identity even when the hook asserts no state facts', async () => {
    const agentStateGateway = gateway();
    const observeProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'matching' }
    });
    const result = await invoke(
      agentStateGateway,
      'POST',
      '/api/agent-event',
      // SessionEnd is the hook that genuinely asserts nothing: the daemon
      // watches the process exit itself. (SessionStart does assert — a started
      // session is idle — so it is no longer an example of silence.)
      producerBody({
        observation: {
          hook: 'SessionEnd',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }
      }),
      eventGateway(),
      endpointGateway(),
      { observeProviderSessionIdentity }
    );

    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, kind: 'no-facts' }
    });
    expect(observeProviderSessionIdentity).toHaveBeenCalledOnce();
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

  it.each(['persisted', 'already-bound'] as const)(
    'stages, binds (%s), then activates exact endpoint registration',
    async (kind) => {
    const endpoints = endpointGateway();
    const bindProviderSessionIdentity = vi.fn().mockResolvedValue({ ok: true, kind });
    const completeProviderSessionLaunch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, kind: 'completed' }
    });
    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody(),
      eventGateway(),
      endpoints,
      { bindProviderSessionIdentity, completeProviderSessionLaunch }
    );

    const staged = {
      ...endpointBody(),
      observedAt: 950
    } satisfies AgentEndpointRegistration;
    expect(endpoints.registerEndpoint).toHaveBeenCalledWith(staged);
    expect(bindProviderSessionIdentity).toHaveBeenCalledWith({
      deskSessionId: 'agent-a',
      provider: 'opencode',
      providerSessionId: 'ses_aaaaaaaaaaaaaaaaaaaa'
    });
    const { observedAt: _observedAt, ...activation } = staged;
    expect(endpoints.activateEndpoint).toHaveBeenCalledWith(activation);
    expect(endpoints.registerEndpoint.mock.invocationCallOrder[0]).toBeLessThan(
      bindProviderSessionIdentity.mock.invocationCallOrder[0]!
    );
    expect(bindProviderSessionIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      completeProviderSessionLaunch.mock.invocationCallOrder[0]!
    );
    expect(completeProviderSessionLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      endpoints.activateEndpoint.mock.invocationCallOrder[0]!
    );
    expect(result).toEqual({
      handled: true,
      status: 200,
      body: { ok: true, kind: 'activated' }
    });
    }
  );

  it('leaves a bound endpoint inactive when launch completion is rejected', async () => {
    const endpoints = endpointGateway();
    const completeProviderSessionLaunch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      error: 'generation-mismatch',
      body: { ok: false, reason: 'generation-mismatch' }
    });

    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody(),
      eventGateway(),
      endpoints,
      { completeProviderSessionLaunch }
    );

    expect(result).toMatchObject({
      status: 409,
      body: { ok: false, reason: 'generation-mismatch' }
    });
    expect(endpoints.activateEndpoint).not.toHaveBeenCalled();
  });

  it('keeps a registration without provider identity staged and inactive', async () => {
    const endpoints = endpointGateway();
    const bindProviderSessionIdentity = vi.fn();
    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody({ providerSessionId: undefined }),
      eventGateway(),
      endpoints,
      { bindProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, kind: 'accepted', active: false }
    });
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();
    expect(endpoints.activateEndpoint).not.toHaveBeenCalled();
  });

  it('recovers a duplicate staged registration through already-bound and idempotent activation', async () => {
    const endpoints = endpointGateway({
      registerEndpoint: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, kind: 'duplicate', active: false }
      }),
      activateEndpoint: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, kind: 'already-active' }
      })
    });
    const bindProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'already-bound'
    });

    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody(),
      eventGateway(),
      endpoints,
      { bindProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, kind: 'already-active' }
    });
    expect(bindProviderSessionIdentity).toHaveBeenCalledOnce();
    expect(endpoints.activateEndpoint).toHaveBeenCalledOnce();
  });

  it('leaves staged endpoint inactive when provider identity binding is rejected', async () => {
    const endpoints = endpointGateway();
    const bindProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: false,
      code: 'provider-session-mismatch',
      error: 'Desk session is already bound to another provider session'
    });

    const result = await invoke(
      gateway(),
      'POST',
      '/api/agent-endpoint',
      endpointBody(),
      eventGateway(),
      endpoints,
      { bindProviderSessionIdentity }
    );

    expect(result).toMatchObject({
      status: 409,
      body: { ok: false, code: 'provider-session-mismatch' }
    });
    expect(endpoints.activateEndpoint).not.toHaveBeenCalled();
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

  it('rejects malformed staged and activation receipts before advancing continuity', async () => {
    const bindProviderSessionIdentity = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'persisted'
    });
    const malformedStage = endpointGateway({
      registerEndpoint: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, kind: 'accepted' }
      })
    });
    expect(
      (
        await invoke(
          gateway(),
          'POST',
          '/api/agent-endpoint',
          endpointBody(),
          eventGateway(),
          malformedStage,
          { bindProviderSessionIdentity }
        )
      ).status
    ).toBe(502);
    expect(bindProviderSessionIdentity).not.toHaveBeenCalled();

    const malformedActivation = endpointGateway({
      activateEndpoint: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, kind: 'accepted' }
      })
    });
    expect(
      (
        await invoke(
          gateway(),
          'POST',
          '/api/agent-endpoint',
          endpointBody(),
          eventGateway(),
          malformedActivation,
          { bindProviderSessionIdentity }
        )
      ).status
    ).toBe(502);
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
