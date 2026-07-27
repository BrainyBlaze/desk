// Canonical agent-state intake. The producer carries its own sequence; the
// daemon fences generation and producer identity before allocating an
// independent durable acceptance sequence.

import {
  type AcceptedAgentStateEvent,
  type AgentMode,
  type AgentProducer,
  type AgentProvider,
  type AgentStateEnvelope,
  type AgentStateTransport,
  parseAgentStateEnvelope
} from './contract.js';

export interface AgentStateProducerRegistration {
  provider: AgentProvider;
  mode: AgentMode;
  producer: AgentProducer;
  producerInstanceId?: string;
}

export type AgentStateStoreCommitResult =
  | { kind: 'committed'; event: AcceptedAgentStateEvent }
  | { kind: 'duplicate'; event: AcceptedAgentStateEvent }
  | { kind: 'rejected'; reason: 'idempotency-conflict' | 'producer-instance-mismatch' | 'producer-order' };

export interface AgentProducerSequenceClaim {
  sessionId: string;
  generation: number;
  producer: AgentProducer;
  producerInstanceId: string;
  transport: AgentStateTransport;
  producerSeq: number;
}

export type AgentProducerSequenceClaimResult =
  | { kind: 'claimed' }
  | {
      kind: 'rejected';
      reason:
        | 'producer-unregistered'
        | 'producer-instance-mismatch'
        | 'producer-order';
    };

export interface AgentStateIntakeStore {
  currentGeneration(sessionId: string): number;
  expectedProducer(sessionId: string, generation: number): AgentStateProducerRegistration | undefined;
  now(): number;
  commitAgentState(envelope: AgentStateEnvelope, acceptedAt: number): AgentStateStoreCommitResult;
  claimProducerSequence(
    claim: AgentProducerSequenceClaim
  ): AgentProducerSequenceClaimResult;
  producerInstance(
    sessionId: string,
    generation: number,
    producer: AgentProducer
  ): string | undefined;
  reconcileProducerInstance(
    sessionId: string,
    generation: number,
    producer: AgentProducer,
    producerInstanceId: string
  ): void;
}

export type AgentStateIntakeResult =
  | { kind: 'accepted'; event: AcceptedAgentStateEvent }
  | { kind: 'duplicate'; event: AcceptedAgentStateEvent }
  | {
      kind: 'rejected';
      reason:
        | 'invalid-envelope'
        | 'generation-fence'
        | 'producer-unregistered'
        | 'producer-mismatch'
        | 'producer-instance-mismatch'
        | 'producer-order'
        | 'idempotency-conflict';
      carried?: number;
      current?: number;
    };

export function acceptAgentStateEvent(input: unknown, store: AgentStateIntakeStore): AgentStateIntakeResult {
  let envelope: AgentStateEnvelope;
  try {
    envelope = parseAgentStateEnvelope(input);
  } catch {
    return { kind: 'rejected', reason: 'invalid-envelope' };
  }

  const current = store.currentGeneration(envelope.sessionId);
  if (envelope.generation !== current) {
    return {
      kind: 'rejected',
      reason: 'generation-fence',
      carried: envelope.generation,
      current
    };
  }

  const expected = store.expectedProducer(envelope.sessionId, envelope.generation);
  if (expected === undefined) {
    return { kind: 'rejected', reason: 'producer-unregistered' };
  }
  if (
    expected.provider !== envelope.provider ||
    expected.mode !== envelope.mode ||
    expected.producer !== envelope.producer
  ) {
    return { kind: 'rejected', reason: 'producer-mismatch' };
  }
  if (
    expected.producerInstanceId !== undefined &&
    expected.producerInstanceId !== envelope.producerInstanceId
  ) {
    return { kind: 'rejected', reason: 'producer-instance-mismatch' };
  }

  const acceptedAt = store.now();
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
    throw new Error('agent-state intake clock must return a non-negative safe integer');
  }
  const result = store.commitAgentState(envelope, acceptedAt);
  if (result.kind === 'committed') return { kind: 'accepted', event: result.event };
  if (result.kind === 'duplicate') return result;
  return result;
}

interface InMemoryAgentStateIntakeDependencies {
  currentGeneration: (sessionId: string) => number;
  expectedProducer: (
    sessionId: string,
    generation: number
  ) => AgentStateProducerRegistration | undefined;
  now: () => number;
}

export class InMemoryAgentStateIntakeStore implements AgentStateIntakeStore {
  private acceptedSeq = 0;
  private readonly receipts = new Map<string, { event: AcceptedAgentStateEvent; fingerprint: string }>();
  private readonly watermarks = new Map<string, number>();
  private readonly instances = new Map<string, string>();

  constructor(private readonly dependencies: InMemoryAgentStateIntakeDependencies) {}

  currentGeneration(sessionId: string): number {
    return this.dependencies.currentGeneration(sessionId);
  }

  expectedProducer(sessionId: string, generation: number): AgentStateProducerRegistration | undefined {
    return this.dependencies.expectedProducer(sessionId, generation);
  }

  now(): number {
    return this.dependencies.now();
  }

  commitAgentState(envelope: AgentStateEnvelope, acceptedAt: number): AgentStateStoreCommitResult {
    const eventKey = canonicalEventKey(envelope);
    const fingerprint = JSON.stringify(envelope);
    const prior = this.receipts.get(eventKey);
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? { kind: 'duplicate', event: cloneAcceptedEvent(prior.event) }
        : { kind: 'rejected', reason: 'idempotency-conflict' };
    }

    const adapterKey = canonicalAdapterKey(envelope);
    const instance = this.instances.get(adapterKey);
    if (instance !== undefined && instance !== envelope.producerInstanceId) {
      return { kind: 'rejected', reason: 'producer-instance-mismatch' };
    }
    const watermarkKey = canonicalWatermarkKey(envelope);
    if (envelope.producerSeq <= (this.watermarks.get(watermarkKey) ?? 0)) {
      return { kind: 'rejected', reason: 'producer-order' };
    }

    const acceptedSeq = this.acceptedSeq + 1;
    const event: AcceptedAgentStateEvent = {
      acceptanceId: makeAcceptanceId(envelope, acceptedSeq),
      acceptedSeq,
      acceptedAt,
      envelope
    };
    this.acceptedSeq = acceptedSeq;
    this.receipts.set(eventKey, { event: cloneAcceptedEvent(event), fingerprint });
    this.watermarks.set(watermarkKey, envelope.producerSeq);
    this.instances.set(adapterKey, envelope.producerInstanceId);
    return { kind: 'committed', event: cloneAcceptedEvent(event) };
  }

  claimProducerSequence(
    claim: AgentProducerSequenceClaim
  ): AgentProducerSequenceClaimResult {
    const adapterKey = canonicalProducerAdapterKey(claim);
    const instance = this.instances.get(adapterKey);
    if (instance === undefined) {
      return { kind: 'rejected', reason: 'producer-unregistered' };
    }
    if (instance !== claim.producerInstanceId) {
      return { kind: 'rejected', reason: 'producer-instance-mismatch' };
    }
    const watermarkKey = canonicalProducerWatermarkKey(claim);
    if (claim.producerSeq <= (this.watermarks.get(watermarkKey) ?? 0)) {
      return { kind: 'rejected', reason: 'producer-order' };
    }
    this.watermarks.set(watermarkKey, claim.producerSeq);
    return { kind: 'claimed' };
  }

  producerInstance(
    sessionId: string,
    generation: number,
    producer: AgentProducer
  ): string | undefined {
    return this.instances.get(`${sessionId}\u0000${generation}\u0000${producer}`);
  }

  reconcileProducerInstance(
    sessionId: string,
    generation: number,
    producer: AgentProducer,
    producerInstanceId: string
  ): void {
    this.instances.set(`${sessionId}\u0000${generation}\u0000${producer}`, producerInstanceId);
  }
}

export function canonicalAdapterKey(envelope: AgentStateEnvelope): string {
  return canonicalProducerAdapterKey(envelope);
}

export function canonicalWatermarkKey(envelope: AgentStateEnvelope): string {
  return canonicalProducerWatermarkKey({
    ...envelope,
    transport: envelope.transport ?? 'push'
  });
}

export function canonicalProducerAdapterKey(
  claim: Pick<AgentProducerSequenceClaim, 'sessionId' | 'generation' | 'producer'>
): string {
  return `${claim.sessionId}\u0000${claim.generation}\u0000${claim.producer}`;
}

export function canonicalProducerWatermarkKey(
  claim: Pick<
    AgentProducerSequenceClaim,
    'sessionId' | 'generation' | 'producer' | 'producerInstanceId' | 'transport'
  >
): string {
  return `${canonicalProducerAdapterKey(claim)}\u0000${claim.producerInstanceId}\u0000${
    claim.transport
  }`;
}

export function canonicalEventKey(envelope: AgentStateEnvelope): string {
  return `${canonicalWatermarkKey(envelope)}\u0000${envelope.eventId}`;
}

export function makeAcceptanceId(envelope: AgentStateEnvelope, acceptedSeq: number): string {
  return `${envelope.sessionId}:${envelope.generation}:accepted:${acceptedSeq}`;
}

function cloneAcceptedEvent(event: AcceptedAgentStateEvent): AcceptedAgentStateEvent {
  return structuredClone(event);
}
