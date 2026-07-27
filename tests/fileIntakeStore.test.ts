import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AgentStateEnvelope,
  acceptAgentStateEvent
} from '../src/shared/controlPlane/index.js';
import { FileIntakeStore } from '../src/server/runtime/fileIntakeStore.js';

const envelope = (overrides: Partial<AgentStateEnvelope> = {}): AgentStateEnvelope => ({
  schemaVersion: AGENT_STATE_SCHEMA_VERSION,
  sessionId: 's1',
  generation: 1,
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks',
  producerInstanceId: 'instance-a',
  producerSeq: 1,
  eventId: 'instance-a:1',
  invocationId: 'turn-1',
  occurredAt: 100,
  observedAt: 200,
  facts: [{ kind: 'activity', activity: 'working' }],
  ...overrides
});

describe('FileIntakeStore canonical acceptance receipts', () => {
  let dir: string;
  let path: string;
  let generation: number;
  let now: number;
  let expectedInstance: string | undefined;

  const dependencies = () => ({
    currentGeneration: (_sessionId: string) => generation,
    expectedProducer: (_sessionId: string, _generation: number) => ({
      provider: 'codex' as const,
      mode: 'terminal' as const,
      producer: 'codex-hooks' as const,
      producerInstanceId: expectedInstance
    }),
    now: () => now
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-intake-'));
    path = join(dir, 'acceptance.ndjson');
    generation = 1;
    now = 1_000;
    expectedInstance = 'instance-a';
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('allocates independent acceptedSeq values and treats invocationId as correlation only', () => {
    const store = new FileIntakeStore(path, dependencies());
    const first = acceptAgentStateEvent(envelope(), store);
    const second = acceptAgentStateEvent(
      envelope({
        producerSeq: 2,
        eventId: 'instance-a:2',
        invocationId: 'turn-1',
        facts: [{ kind: 'health', health: { status: 'degraded', reason: 'output-length' } }]
      }),
      store
    );

    expect(first).toMatchObject({
      kind: 'accepted',
      event: { acceptedSeq: 1, acceptedAt: 1_000 }
    });
    expect(second).toMatchObject({
      kind: 'accepted',
      event: { acceptedSeq: 2, envelope: { invocationId: 'turn-1' } }
    });
    store.close();
  });

  it('deduplicates exact eventId retries and rejects payload conflicts', () => {
    const store = new FileIntakeStore(path, dependencies());
    const first = acceptAgentStateEvent(envelope(), store);
    now = 9_999;
    const retry = acceptAgentStateEvent(envelope(), store);
    const conflict = acceptAgentStateEvent(
      envelope({ facts: [{ kind: 'activity', activity: 'idle' }] }),
      store
    );

    expect(retry).toEqual({ kind: 'duplicate', event: first.event });
    expect(conflict).toMatchObject({ kind: 'rejected', reason: 'idempotency-conflict' });
    store.close();
  });

  it('returns the same durable receipt after restart without replaying activity', () => {
    const firstStore = new FileIntakeStore(path, dependencies());
    const first = acceptAgentStateEvent(envelope(), firstStore);
    firstStore.close();

    now = 2_000;
    const restarted = new FileIntakeStore(path, dependencies());
    const retry = acceptAgentStateEvent(envelope(), restarted);
    expect(retry).toEqual({ kind: 'duplicate', event: first.event });
    expect(restarted).not.toHaveProperty('snapshot');
    expect(restarted).not.toHaveProperty('restoreActivity');
    expect(restarted).not.toHaveProperty('replayInto');
    restarted.close();
  });

  it('rejects reordered or reused producer sequences with different event IDs', () => {
    const store = new FileIntakeStore(path, dependencies());
    acceptAgentStateEvent(envelope({ producerSeq: 2, eventId: 'instance-a:2' }), store);

    expect(
      acceptAgentStateEvent(envelope({ producerSeq: 2, eventId: 'different-event' }), store)
    ).toMatchObject({ kind: 'rejected', reason: 'producer-order' });
    expect(
      acceptAgentStateEvent(envelope({ producerSeq: 1, eventId: 'instance-a:1' }), store)
    ).toMatchObject({ kind: 'rejected', reason: 'producer-order' });
    store.close();
  });

  it('orders push and live-poll observations independently for one producer instance', () => {
    const store = new FileIntakeStore(path, dependencies());
    expect(
      acceptAgentStateEvent(
        envelope({ producerSeq: 8, eventId: 'instance-a:push:8' }),
        store
      )
    ).toMatchObject({ kind: 'accepted', event: { acceptedSeq: 1 } });
    expect(
      acceptAgentStateEvent(
        envelope({
          transport: 'poll',
          producerSeq: 1,
          eventId: 'instance-a:poll:1',
          facts: [{ kind: 'activity', activity: 'idle' }]
        }),
        store
      )
    ).toMatchObject({ kind: 'accepted', event: { acceptedSeq: 2 } });
    expect(
      acceptAgentStateEvent(
        envelope({ producerSeq: 9, eventId: 'instance-a:push:9' }),
        store
      )
    ).toMatchObject({ kind: 'accepted', event: { acceptedSeq: 3 } });
    expect(store.producerInstance('s1', 1, 'codex-hooks')).toBe('instance-a');
    store.close();
  });

  it('durably shares the push watermark with producer endpoint metadata', () => {
    const store = new FileIntakeStore(path, dependencies());
    expect(
      acceptAgentStateEvent(
        envelope({ producerSeq: 3, eventId: 'instance-a:push:3' }),
        store
      )
    ).toMatchObject({ kind: 'accepted' });
    expect(
      store.claimProducerSequence({
        sessionId: 's1',
        generation: 1,
        producer: 'codex-hooks',
        producerInstanceId: 'instance-a',
        transport: 'push',
        producerSeq: 4
      })
    ).toEqual({ kind: 'claimed' });
    expect(
      acceptAgentStateEvent(
        envelope({ producerSeq: 4, eventId: 'instance-a:push:4' }),
        store
      )
    ).toMatchObject({ kind: 'rejected', reason: 'producer-order' });
    expect(
      acceptAgentStateEvent(
        envelope({
          transport: 'poll',
          producerSeq: 1,
          eventId: 'instance-a:poll:1'
        }),
        store
      )
    ).toMatchObject({ kind: 'accepted' });
    store.close();

    const restarted = new FileIntakeStore(path, dependencies());
    expect(
      restarted.claimProducerSequence({
        sessionId: 's1',
        generation: 1,
        producer: 'codex-hooks',
        producerInstanceId: 'instance-a',
        transport: 'push',
        producerSeq: 4
      })
    ).toMatchObject({ kind: 'rejected', reason: 'producer-order' });
    expect(
      acceptAgentStateEvent(
        envelope({ producerSeq: 5, eventId: 'instance-a:push:5' }),
        restarted
      )
    ).toMatchObject({ kind: 'accepted' });
    restarted.close();
  });

  it('refuses sequence claims from an unbound or different producer instance', () => {
    const store = new FileIntakeStore(path, dependencies());
    const claim = {
      sessionId: 's1',
      generation: 1,
      producer: 'codex-hooks' as const,
      producerInstanceId: 'instance-a',
      transport: 'push' as const,
      producerSeq: 1
    };
    expect(store.claimProducerSequence(claim)).toMatchObject({
      kind: 'rejected',
      reason: 'producer-unregistered'
    });
    expect(acceptAgentStateEvent(envelope(), store)).toMatchObject({ kind: 'accepted' });
    expect(
      store.claimProducerSequence({
        ...claim,
        producerInstanceId: 'instance-b',
        producerSeq: 2
      })
    ).toMatchObject({
      kind: 'rejected',
      reason: 'producer-instance-mismatch'
    });
    store.close();
  });

  it('resets producer ordering for a new generation but keeps acceptedSeq monotonic', () => {
    const store = new FileIntakeStore(path, dependencies());
    const first = acceptAgentStateEvent(envelope({ producerSeq: 8, eventId: 'instance-a:8' }), store);
    generation = 2;
    const second = acceptAgentStateEvent(
      envelope({ generation: 2, producerSeq: 1, eventId: 'instance-a:g2:1' }),
      store
    );

    expect(first).toMatchObject({ kind: 'accepted', event: { acceptedSeq: 1 } });
    expect(second).toMatchObject({ kind: 'accepted', event: { acceptedSeq: 2 } });
    store.close();
  });

  it('rejects producer instance replacement until reconciliation explicitly authorizes it', () => {
    expectedInstance = undefined;
    const store = new FileIntakeStore(path, dependencies());
    acceptAgentStateEvent(envelope(), store);
    const fromNewInstance = envelope({
      producerInstanceId: 'instance-b',
      producerSeq: 1,
      eventId: 'instance-b:1'
    });

    expect(acceptAgentStateEvent(fromNewInstance, store)).toMatchObject({
      kind: 'rejected',
      reason: 'producer-instance-mismatch'
    });

    expectedInstance = 'instance-b';
    store.reconcileProducerInstance('s1', 1, 'codex-hooks', 'instance-b');
    expect(acceptAgentStateEvent(fromNewInstance, store)).toMatchObject({ kind: 'accepted' });
    store.close();
  });

  it('fences generation and the registered producer before durable commit', () => {
    const store = new FileIntakeStore(path, dependencies());
    expect(acceptAgentStateEvent(envelope({ generation: 2 }), store)).toMatchObject({
      kind: 'rejected',
      reason: 'generation-fence',
      carried: 2,
      current: 1
    });
    expect(
      acceptAgentStateEvent(
        envelope({
          provider: 'claude',
          producer: 'claude-hooks',
          producerInstanceId: 'claude-a',
          eventId: 'claude-a:1'
        }),
        store
      )
    ).toMatchObject({ kind: 'rejected', reason: 'producer-mismatch' });
    expect(readFileSync(path, 'utf8')).toBe('');
    store.close();
  });

  it('uses daemon acceptance time rather than producer timestamps', () => {
    now = 5_000;
    const store = new FileIntakeStore(path, dependencies());
    const result = acceptAgentStateEvent(
      envelope({ occurredAt: 999_999_999, observedAt: 999_999_999 }),
      store
    );
    expect(result).toMatchObject({ kind: 'accepted', event: { acceptedAt: 5_000 } });
    store.close();
  });

  it('truncates a torn final record before appending a clean durable retry', () => {
    const firstStore = new FileIntakeStore(path, dependencies());
    acceptAgentStateEvent(envelope(), firstStore);
    firstStore.close();
    appendFileSync(path, '{"acceptanceId":"torn"');

    const recovered = new FileIntakeStore(path, dependencies());
    const nextEnvelope = envelope({ producerSeq: 2, eventId: 'instance-a:2' });
    const next = acceptAgentStateEvent(nextEnvelope, recovered);
    expect(next).toMatchObject({ kind: 'accepted', event: { acceptedSeq: 2 } });
    recovered.close();

    const restarted = new FileIntakeStore(path, dependencies());
    expect(acceptAgentStateEvent(nextEnvelope, restarted)).toEqual({
      kind: 'duplicate',
      event: next.event
    });
    restarted.close();
  });
});
