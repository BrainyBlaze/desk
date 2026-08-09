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

const PROVIDER_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaa';
const OTHER_PROVIDER_SESSION_ID = 'ses_bbbbbbbbbbbbbbbbbbbb';

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
          providerSessionId: PROVIDER_SESSION_ID
        },
        { observedAt: 700 }
      )
    ).toEqual({
      kind: 'registration',
      registration: registration({
        observedAt: 700,
        providerSessionId: PROVIDER_SESSION_ID
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
      store.register(
        registration({ producerSeq: 2, providerSessionId: PROVIDER_SESSION_ID })
      )
    ).toMatchObject({ kind: 'accepted' });
    expect(
      store.register(
        registration({ producerSeq: 2, providerSessionId: OTHER_PROVIDER_SESSION_ID })
      )
    ).toMatchObject({ kind: 'rejected', reason: 'idempotency-conflict' });
    expect(
      store.register(
        registration({ producerSeq: 1, providerSessionId: PROVIDER_SESSION_ID })
      )
    ).toMatchObject({ kind: 'rejected', reason: 'producer-order' });
  });

  it('persists exact registration as inactive before idempotent activation', () => {
    const first = new FileAgentEndpointStore(path, dependencies());
    const staged = registration({
      producerSeq: 2,
      providerSessionId: PROVIDER_SESSION_ID
    });
    expect(
      first.register(staged)
    ).toMatchObject({ kind: 'accepted', active: false });
    expect(first.get('work-opencode', 5, 'opencode-terminal')).toMatchObject({
      providerSessionId: PROVIDER_SESSION_ID
    });
    expect(first.getActive('work-opencode', 5, 'opencode-terminal')).toBeUndefined();
    expect(
      first.reservePollSequence('work-opencode', 5, 'opencode-terminal')
    ).toBeUndefined();

    expect(
      first.register({ ...staged, observedAt: 900 })
    ).toMatchObject({ kind: 'duplicate', active: false });
    const { observedAt: _observedAt, ...activation } = staged;
    expect(first.activate(activation)).toMatchObject({ kind: 'activated' });
    expect(first.activate(activation)).toMatchObject({ kind: 'already-active' });
    expect(first.getActive('work-opencode', 5, 'opencode-terminal')).toMatchObject({
      providerSessionId: PROVIDER_SESSION_ID
    });
    expect(first.reservePollSequence('work-opencode', 5, 'opencode-terminal')).toMatchObject({
      pollSeq: 1,
      registration: { providerSessionId: PROVIDER_SESSION_ID }
    });

    const restarted = new FileAgentEndpointStore(path, dependencies());
    expect(restarted.getActive('work-opencode', 5, 'opencode-terminal')).toMatchObject({
      providerSessionId: PROVIDER_SESSION_ID,
      producerInstanceId: 'plugin-instance-a'
    });
    expect(restarted.register({ ...staged, observedAt: 1_200 })).toMatchObject({
      kind: 'duplicate',
      active: true
    });
    expect(restarted.activate(activation)).toMatchObject({ kind: 'already-active' });
    expect(
      restarted.reservePollSequence('work-opencode', 5, 'opencode-terminal')
    ).toMatchObject({ pollSeq: 2 });
  });

  it('keeps an inactive registration fenced across restart and rejects a changed activation fingerprint', () => {
    const staged = registration({ providerSessionId: PROVIDER_SESSION_ID });
    const first = new FileAgentEndpointStore(path, dependencies());
    expect(first.register(staged)).toMatchObject({ kind: 'accepted', active: false });

    const restarted = new FileAgentEndpointStore(path, dependencies());
    expect(restarted.get('work-opencode', 5, 'opencode-terminal')).toBeDefined();
    expect(restarted.getActive('work-opencode', 5, 'opencode-terminal')).toBeUndefined();
    const { observedAt: _observedAt, ...activation } = staged;
    expect(
      restarted.activate({
        ...activation,
        providerSessionId: OTHER_PROVIDER_SESSION_ID
      })
    ).toMatchObject({ kind: 'rejected', reason: 'registration-mismatch' });
    expect(restarted.getActive('work-opencode', 5, 'opencode-terminal')).toBeUndefined();
    expect(restarted.register({ ...staged, observedAt: 1_200 })).toMatchObject({
      kind: 'duplicate',
      active: false
    });
    expect(restarted.activate(activation)).toMatchObject({ kind: 'activated' });
    expect(restarted.getActive('work-opencode', 5, 'opencode-terminal')).toBeDefined();
  });

  it('rejects invalid provider identity before durable staging', () => {
    const store = new FileAgentEndpointStore(path, dependencies());

    expect(
      store.register(registration({ providerSessionId: 'ses_short' }))
    ).toMatchObject({ kind: 'rejected', reason: 'provider-session-id-invalid' });
    expect(store.get('work-opencode', 5, 'opencode-terminal')).toBeUndefined();
  });

  it('does not persist metadata rejected by the canonical producer watermark', () => {
    claimResult = { kind: 'rejected', reason: 'producer-order' };
    const store = new FileAgentEndpointStore(path, dependencies());

    expect(store.register(registration())).toEqual(claimResult);
    expect(store.get('work-opencode', 5, 'opencode-terminal')).toBeUndefined();
  });
});
