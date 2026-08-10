import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  agentEndpointFingerprint,
  parseAgentEndpointActivation,
  parseAgentEndpointRegistration,
  type AgentEndpointActivation,
  type AgentEndpointRegistration,
  type AgentProducer,
  type AgentProducerSequenceClaim,
  type AgentProducerSequenceClaimResult,
  type AgentStateProducerRegistration
} from '../../shared/controlPlane/index.js';
import { isValidProviderSessionId } from '../../shared/providerSessionIdentity.js';

const STORE_VERSION = 2 as const;
const MAX_ENDPOINTS = 512;

export interface FileAgentEndpointStoreDependencies {
  currentGeneration(sessionId: string): number;
  expectedProducer(
    sessionId: string,
    generation: number
  ): AgentStateProducerRegistration | undefined;
  claimProducerSequence(
    claim: AgentProducerSequenceClaim
  ): AgentProducerSequenceClaimResult;
}

interface StoredEndpoint {
  registration: AgentEndpointRegistration;
  pollSeq: number;
  active: boolean;
}

interface PersistedStore {
  version: typeof STORE_VERSION;
  entries: StoredEndpoint[];
}

export type AgentEndpointStoreResult =
  | { kind: 'accepted'; registration: AgentEndpointRegistration; active: false }
  | { kind: 'duplicate'; registration: AgentEndpointRegistration; active: boolean }
  | {
      kind: 'rejected';
      reason:
        | 'invalid-registration'
        | 'generation-fence'
        | 'producer-unregistered'
        | 'producer-mismatch'
        | 'producer-instance-mismatch'
        | 'producer-order'
        | 'idempotency-conflict'
        | 'provider-session-id-invalid';
      carried?: number;
      current?: number;
    };

export type AgentEndpointActivationResult =
  | {
      kind: 'activated' | 'already-active';
      registration: AgentEndpointRegistration;
    }
  | {
      kind: 'rejected';
      reason:
        | 'invalid-activation'
        | 'provider-session-id-invalid'
        | 'endpoint-unregistered'
        | 'registration-mismatch';
    };

export interface ReservedAgentPoll {
  registration: AgentEndpointRegistration;
  pollSeq: number;
}

export class FileAgentEndpointStore {
  private entries = new Map<string, StoredEndpoint>();

  constructor(
    private readonly path: string,
    private readonly dependencies: FileAgentEndpointStoreDependencies
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.entries = this.load();
  }

  register(input: unknown): AgentEndpointStoreResult {
    let registration: AgentEndpointRegistration;
    try {
      registration = parseAgentEndpointRegistration(input);
    } catch {
      return { kind: 'rejected', reason: 'invalid-registration' };
    }
    if (
      registration.providerSessionId !== undefined &&
      !isValidProviderSessionId('opencode', registration.providerSessionId)
    ) {
      return { kind: 'rejected', reason: 'provider-session-id-invalid' };
    }

    const current = this.dependencies.currentGeneration(registration.sessionId);
    if (registration.generation !== current) {
      return {
        kind: 'rejected',
        reason: 'generation-fence',
        carried: registration.generation,
        current
      };
    }
    const expected = this.dependencies.expectedProducer(
      registration.sessionId,
      registration.generation
    );
    if (expected === undefined) {
      return { kind: 'rejected', reason: 'producer-unregistered' };
    }
    if (
      expected.provider !== registration.provider ||
      expected.mode !== registration.mode ||
      expected.producer !== registration.producer
    ) {
      return { kind: 'rejected', reason: 'producer-mismatch' };
    }

    const key = endpointKey(
      registration.sessionId,
      registration.generation,
      registration.producer
    );
    const prior = this.entries.get(key);
    if (
      prior !== undefined &&
      prior.registration.producerInstanceId !== registration.producerInstanceId
    ) {
      return { kind: 'rejected', reason: 'producer-instance-mismatch' };
    }
    if (prior !== undefined && registration.producerSeq === prior.registration.producerSeq) {
      return JSON.stringify(agentEndpointFingerprint(registration)) ===
        JSON.stringify(agentEndpointFingerprint(prior.registration))
        ? {
            kind: 'duplicate',
            registration: structuredClone(prior.registration),
            active: prior.active
          }
        : { kind: 'rejected', reason: 'idempotency-conflict' };
    }
    if (prior !== undefined && registration.producerSeq < prior.registration.producerSeq) {
      return { kind: 'rejected', reason: 'producer-order' };
    }

    const sequenceClaim = this.dependencies.claimProducerSequence({
      sessionId: registration.sessionId,
      generation: registration.generation,
      producer: registration.producer,
      producerInstanceId: registration.producerInstanceId,
      transport: 'push',
      producerSeq: registration.producerSeq
    });
    if (sequenceClaim.kind === 'rejected') return sequenceClaim;

    const next = new Map(this.entries);
    for (const [candidateKey, candidate] of next) {
      if (
        candidate.registration.sessionId === registration.sessionId &&
        candidate.registration.producer === registration.producer &&
        candidate.registration.generation !== registration.generation
      ) {
        next.delete(candidateKey);
      }
    }
    next.set(key, {
      registration: structuredClone(registration),
      pollSeq: prior?.pollSeq ?? 0,
      active: false
    });
    trimOldest(next);
    this.persist(next);
    this.entries = next;
    return {
      kind: 'accepted',
      registration: structuredClone(registration),
      active: false
    };
  }

  get(
    sessionId: string,
    generation: number,
    producer: AgentProducer
  ): AgentEndpointRegistration | undefined {
    const registration = this.entries.get(endpointKey(sessionId, generation, producer))
      ?.registration;
    return registration === undefined ? undefined : structuredClone(registration);
  }

  getActive(
    sessionId: string,
    generation: number,
    producer: AgentProducer
  ): AgentEndpointRegistration | undefined {
    const stored = this.entries.get(endpointKey(sessionId, generation, producer));
    if (stored === undefined || !stored.active) return undefined;
    return structuredClone(stored.registration);
  }

  activate(input: unknown): AgentEndpointActivationResult {
    let activation: AgentEndpointActivation;
    try {
      activation = parseAgentEndpointActivation(input);
    } catch {
      return { kind: 'rejected', reason: 'invalid-activation' };
    }
    if (!isValidProviderSessionId('opencode', activation.providerSessionId)) {
      return { kind: 'rejected', reason: 'provider-session-id-invalid' };
    }
    const key = endpointKey(
      activation.sessionId,
      activation.generation,
      activation.producer
    );
    const current = this.entries.get(key);
    if (current === undefined) {
      return { kind: 'rejected', reason: 'endpoint-unregistered' };
    }
    if (
      JSON.stringify(agentEndpointFingerprint(current.registration)) !==
      JSON.stringify(activation)
    ) {
      return { kind: 'rejected', reason: 'registration-mismatch' };
    }
    if (current.active) {
      return {
        kind: 'already-active',
        registration: structuredClone(current.registration)
      };
    }
    const next = new Map(this.entries);
    next.set(key, {
      registration: structuredClone(current.registration),
      pollSeq: current.pollSeq,
      active: true
    });
    this.persist(next);
    this.entries = next;
    return {
      kind: 'activated',
      registration: structuredClone(current.registration)
    };
  }

  reservePollSequence(
    sessionId: string,
    generation: number,
    producer: AgentProducer
  ): ReservedAgentPoll | undefined {
    const key = endpointKey(sessionId, generation, producer);
    const current = this.entries.get(key);
    if (current === undefined || !current.active) return undefined;
    const pollSeq = current.pollSeq + 1;
    if (!Number.isSafeInteger(pollSeq)) {
      throw new Error('agent endpoint poll sequence exhausted');
    }
    const next = new Map(this.entries);
    next.set(key, {
      registration: structuredClone(current.registration),
      pollSeq,
      active: true
    });
    this.persist(next);
    this.entries = next;
    return {
      registration: structuredClone(current.registration),
      pollSeq
    };
  }

  private load(): Map<string, StoredEndpoint> {
    if (!existsSync(this.path)) return new Map();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return new Map();
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== STORE_VERSION ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return new Map();
    }
    const result = new Map<string, StoredEndpoint>();
    for (const value of (parsed as PersistedStore).entries) {
      try {
        const registration = parseAgentEndpointRegistration(value.registration);
        if (
          !Number.isSafeInteger(value.pollSeq) ||
          value.pollSeq < 0 ||
          typeof value.active !== 'boolean' ||
          (registration.providerSessionId !== undefined &&
            !isValidProviderSessionId('opencode', registration.providerSessionId)) ||
          (value.active && registration.providerSessionId === undefined)
        ) {
          return new Map();
        }
        result.set(
          endpointKey(registration.sessionId, registration.generation, registration.producer),
          { registration, pollSeq: value.pollSeq, active: value.active }
        );
      } catch {
        return new Map();
      }
    }
    trimOldest(result);
    return result;
  }

  private persist(entries: Map<string, StoredEndpoint>): void {
    const payload: PersistedStore = {
      version: STORE_VERSION,
      entries: [...entries.values()]
    };
    atomicReplace(this.path, Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'));
  }
}

function endpointKey(sessionId: string, generation: number, producer: AgentProducer): string {
  return `${sessionId}\u0000${generation}\u0000${producer}`;
}

function trimOldest(entries: Map<string, StoredEndpoint>): void {
  if (entries.size <= MAX_ENDPOINTS) return;
  const oldest = [...entries.entries()].sort(
    (left, right) =>
      left[1].registration.observedAt - right[1].registration.observedAt
  );
  for (let index = 0; index < oldest.length - MAX_ENDPOINTS; index += 1) {
    entries.delete(oldest[index][0]);
  }
}

function atomicReplace(path: string, bytes: Buffer): void {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        fileDescriptor,
        bytes,
        offset,
        bytes.length - offset
      );
      if (written <= 0) throw new Error('agent endpoint snapshot write made no progress');
      offset += written;
    }
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file may already have been renamed.
    }
    throw error;
  }
}
