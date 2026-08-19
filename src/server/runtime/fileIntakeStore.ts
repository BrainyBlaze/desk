import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import {
  canonicalAdapterKey,
  canonicalEventKey,
  canonicalProducerAdapterKey,
  canonicalProducerWatermarkKey,
  canonicalWatermarkKey,
  makeAcceptanceId,
  type AgentProducerSequenceClaim,
  type AgentProducerSequenceClaimResult,
  type AgentStateIntakeStore,
  type AgentStateProducerRegistration,
  type AgentStateStoreCommitResult
} from '../../shared/controlPlane/intake.js';
import {
  type AcceptedAgentStateEvent,
  type AgentProducer,
  type AgentStateEnvelope,
  parseAgentStateEnvelope
} from '../../shared/controlPlane/contract.js';
import { AGENT_PRODUCER_IDS } from '../../shared/agentRegistry.js';

export interface FileIntakeStoreDependencies {
  currentGeneration: (sessionId: string) => number;
  expectedProducer: (
    sessionId: string,
    generation: number
  ) => AgentStateProducerRegistration | undefined;
  now: () => number;
}

interface Receipt {
  event: AcceptedAgentStateEvent;
  fingerprint: string;
}

interface BoundInstance {
  producerInstanceId: string;
  acceptedSeq: number;
}

interface ProducerSequenceClaimRecord extends AgentProducerSequenceClaim {
  recordType: 'producer-sequence-claim';
}

export class FileIntakeStore implements AgentStateIntakeStore {
  private readonly receipts = new Map<string, Receipt>();
  private readonly watermarks = new Map<string, number>();
  private readonly instances = new Map<string, BoundInstance>();
  private acceptedSeq = 0;
  private fd: number | null = null;

  constructor(
    private readonly path: string,
    private readonly dependencies: FileIntakeStoreDependencies
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.replayReceipts();
    this.fd = openSync(path, 'a', 0o600);
  }

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
        ? { kind: 'duplicate', event: structuredClone(prior.event) }
        : { kind: 'rejected', reason: 'idempotency-conflict' };
    }

    const adapterKey = canonicalAdapterKey(envelope);
    const bound = this.instances.get(adapterKey);
    if (bound !== undefined && bound.producerInstanceId !== envelope.producerInstanceId) {
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
    this.appendReceipt(event);
    this.installReceipt(event);
    return { kind: 'committed', event: structuredClone(event) };
  }

  claimProducerSequence(
    claim: AgentProducerSequenceClaim
  ): AgentProducerSequenceClaimResult {
    const bound = this.instances.get(canonicalProducerAdapterKey(claim));
    if (bound === undefined) {
      return { kind: 'rejected', reason: 'producer-unregistered' };
    }
    if (bound.producerInstanceId !== claim.producerInstanceId) {
      return { kind: 'rejected', reason: 'producer-instance-mismatch' };
    }
    const watermarkKey = canonicalProducerWatermarkKey(claim);
    if (claim.producerSeq <= (this.watermarks.get(watermarkKey) ?? 0)) {
      return { kind: 'rejected', reason: 'producer-order' };
    }
    const record: ProducerSequenceClaimRecord = {
      recordType: 'producer-sequence-claim',
      ...claim
    };
    this.appendRecord(record);
    this.installSequenceClaim(record);
    return { kind: 'claimed' };
  }

  producerInstance(
    sessionId: string,
    generation: number,
    producer: AgentProducer
  ): string | undefined {
    return this.instances.get(`${sessionId}\u0000${generation}\u0000${producer}`)
      ?.producerInstanceId;
  }

  reconcileProducerInstance(
    sessionId: string,
    generation: number,
    producer: AgentProducer,
    producerInstanceId: string
  ): void {
    if (
      sessionId.trim().length === 0 ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      producerInstanceId.trim().length === 0
    ) {
      throw new Error('invalid producer reconciliation');
    }
    this.instances.set(`${sessionId}\u0000${generation}\u0000${producer}`, {
      producerInstanceId,
      acceptedSeq: this.acceptedSeq
    });
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  private replayReceipts(): void {
    if (!existsSync(this.path)) return;
    const contents = readFileSync(this.path, 'utf8');
    let durableContents = contents;
    if (contents.length > 0 && !contents.endsWith('\n')) {
      const finalNewline = contents.lastIndexOf('\n');
      durableContents = finalNewline < 0 ? '' : contents.slice(0, finalNewline + 1);
      truncateSync(this.path, Buffer.byteLength(durableContents));
    }

    for (const line of durableContents.split('\n')) {
      if (line.length === 0) continue;
      const claim = parseProducerSequenceClaim(line);
      if (claim !== undefined) {
        this.installSequenceClaim(claim);
        continue;
      }
      const event = parseAcceptedEvent(line);
      if (event !== undefined) this.installReceipt(event);
    }
  }

  private installSequenceClaim(claim: ProducerSequenceClaimRecord): void {
    const watermarkKey = canonicalProducerWatermarkKey(claim);
    this.watermarks.set(
      watermarkKey,
      Math.max(this.watermarks.get(watermarkKey) ?? 0, claim.producerSeq)
    );
  }

  private installReceipt(event: AcceptedAgentStateEvent): void {
    const fingerprint = JSON.stringify(event.envelope);
    const eventKey = canonicalEventKey(event.envelope);
    const prior = this.receipts.get(eventKey);
    if (prior !== undefined && prior.fingerprint !== fingerprint) return;
    this.receipts.set(eventKey, { event: structuredClone(event), fingerprint });

    const watermarkKey = canonicalWatermarkKey(event.envelope);
    this.watermarks.set(
      watermarkKey,
      Math.max(this.watermarks.get(watermarkKey) ?? 0, event.envelope.producerSeq)
    );

    const adapterKey = canonicalAdapterKey(event.envelope);
    const bound = this.instances.get(adapterKey);
    if (bound === undefined || event.acceptedSeq > bound.acceptedSeq) {
      this.instances.set(adapterKey, {
        producerInstanceId: event.envelope.producerInstanceId,
        acceptedSeq: event.acceptedSeq
      });
    }
    this.acceptedSeq = Math.max(this.acceptedSeq, event.acceptedSeq);
  }

  private appendReceipt(event: AcceptedAgentStateEvent): void {
    this.appendRecord(event);
  }

  private appendRecord(record: AcceptedAgentStateEvent | ProducerSequenceClaimRecord): void {
    if (this.fd === null) this.fd = openSync(this.path, 'a', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('durable acceptance append made no progress');
      offset += written;
    }
    fsyncSync(this.fd);
  }
}

function parseProducerSequenceClaim(
  line: string
): ProducerSequenceClaimRecord | undefined {
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (
    record.recordType !== 'producer-sequence-claim' ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.trim().length === 0 ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) <= 0 ||
    !isAgentProducer(record.producer) ||
    typeof record.producerInstanceId !== 'string' ||
    record.producerInstanceId.trim().length === 0 ||
    (record.transport !== 'push' && record.transport !== 'poll') ||
    !Number.isSafeInteger(record.producerSeq) ||
    (record.producerSeq as number) <= 0 ||
    Object.keys(record).some(
      (key) =>
        ![
          'recordType',
          'sessionId',
          'generation',
          'producer',
          'producerInstanceId',
          'transport',
          'producerSeq'
        ].includes(key)
    )
  ) {
    return undefined;
  }
  return record as unknown as ProducerSequenceClaimRecord;
}

const AGENT_PRODUCER_SET: ReadonlySet<string> = new Set(AGENT_PRODUCER_IDS);

function isAgentProducer(value: unknown): value is AgentProducer {
  return typeof value === 'string' && AGENT_PRODUCER_SET.has(value);
}

function parseAcceptedEvent(line: string): AcceptedAgentStateEvent | undefined {
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (
    typeof record.acceptanceId !== 'string' ||
    record.acceptanceId.trim().length === 0 ||
    !Number.isSafeInteger(record.acceptedSeq) ||
    (record.acceptedSeq as number) <= 0 ||
    !Number.isSafeInteger(record.acceptedAt) ||
    (record.acceptedAt as number) < 0
  ) {
    return undefined;
  }
  try {
    return {
      acceptanceId: record.acceptanceId,
      acceptedSeq: record.acceptedSeq as number,
      acceptedAt: record.acceptedAt as number,
      envelope: parseAgentStateEnvelope(record.envelope)
    };
  } catch {
    return undefined;
  }
}
