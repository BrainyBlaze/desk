import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  adaptAgentEndpointRegistration,
  type AgentEndpointRegistration,
  type AgentProducerSequenceClaimResult
} from '../src/shared/controlPlane/index.js';
import { FileAgentEndpointStore } from '../src/server/runtime/fileAgentEndpointStore.js';

const registration = (
  overrides: Partial<AgentEndpointRegistration> = {}
): AgentEndpointRegistration => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  sessionId: 'work-opencode',
  generation: 5,
  provider: 'opencode',
  mode: 'terminal',
  producer: 'opencode-terminal',
  producerInstanceId: 'plugin-instance-a',
  producerSeq: 1,
  endpoint: 'http://127.0.0.1:4096/',
  observedAt: 500,
  ...overrides
});

describe('agent endpoint registration contract', () => {
  it('server-stamps a loopback OpenCode endpoint and preserves the selected provider session', () => {
    expect(
      adaptAgentEndpointRegistration(
        {
          ...registration(),
          observedAt: undefined,
          providerSessionId: 'ses_alpha'
        },
        { observedAt: 700 }
      )
    ).toEqual({
      kind: 'registration',
      registration: registration({
        observedAt: 700,
        providerSessionId: 'ses_alpha'
      })
    });
  });

  it.each([
    'https://example.com:4096/',
    'http://127.0.0.1:4096/session/status',
    'http://user:secret@127.0.0.1:4096/'
  ])('rejects an endpoint that is not a bare loopback origin: %s', (endpoint) => {
    expect(
      adaptAgentEndpointRegistration(
        { ...registration({ endpoint }), observedAt: undefined },
        { observedAt: 700 }
      )
    ).toMatchObject({ kind: 'invalid' });
  });
});

describe('FileAgentEndpointStore', () => {
  let dir: string;
  let path: string;
  let generation: number;
  let claimResult: AgentProducerSequenceClaimResult;

  const dependencies = () => ({
    currentGeneration: (_sessionId: string) => generation,
    expectedProducer: (_sessionId: string, _generation: number) => ({
      provider: 'opencode' as const,
      mode: 'terminal' as const,
      producer: 'opencode-terminal' as const
    }),
    claimProducerSequence: () => claimResult
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-endpoint-'));
    path = join(dir, 'agent-endpoints.json');
    generation = 5;
    claimResult = { kind: 'claimed' };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fences generation, producer identity, and producer ordering', () => {
    const store = new FileAgentEndpointStore(path, dependencies());
    expect(store.register(registration({ generation: 4 }))).toMatchObject({
      kind: 'rejected',
      reason: 'generation-fence'
    });
    expect(store.register(registration())).toMatchObject({ kind: 'accepted' });
    expect(store.register(registration())).toMatchObject({ kind: 'duplicate' });
    expect(
      store.register(
        registration({
          producerInstanceId: 'plugin-instance-b',
          producerSeq: 2
        })
      )
    ).toMatchObject({ kind: 'rejected', reason: 'producer-instance-mismatch' });
    expect(
      store.register(registration({ producerSeq: 2, providerSessionId: 'ses_alpha' }))
    ).toMatchObject({ kind: 'accepted' });
    expect(
      store.register(registration({ producerSeq: 2, providerSessionId: 'ses_beta' }))
    ).toMatchObject({ kind: 'rejected', reason: 'idempotency-conflict' });
    expect(
      store.register(registration({ producerSeq: 1, providerSessionId: 'ses_alpha' }))
    ).toMatchObject({ kind: 'rejected', reason: 'producer-order' });
  });

  it('durably retains one selected provider session and poll sequence', () => {
    const first = new FileAgentEndpointStore(path, dependencies());
    expect(first.register(registration())).toMatchObject({ kind: 'accepted' });
    expect(
      first.register(registration({ producerSeq: 2, providerSessionId: 'ses_alpha' }))
    ).toMatchObject({ kind: 'accepted' });
    expect(first.reservePollSequence('work-opencode', 5, 'opencode-terminal')).toMatchObject({
      pollSeq: 1,
      registration: { providerSessionId: 'ses_alpha' }
    });

    const restarted = new FileAgentEndpointStore(path, dependencies());
    expect(restarted.get('work-opencode', 5, 'opencode-terminal')).toMatchObject({
      providerSessionId: 'ses_alpha',
      producerInstanceId: 'plugin-instance-a'
    });
    expect(
      restarted.reservePollSequence('work-opencode', 5, 'opencode-terminal')
    ).toMatchObject({ pollSeq: 2 });
  });

  it('does not persist metadata rejected by the canonical producer watermark', () => {
    claimResult = { kind: 'rejected', reason: 'producer-order' };
    const store = new FileAgentEndpointStore(path, dependencies());

    expect(store.register(registration())).toEqual(claimResult);
    expect(store.get('work-opencode', 5, 'opencode-terminal')).toBeUndefined();
  });
});
