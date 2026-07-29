// The provider adapter: a producer's bounded observation becomes a canonical
// envelope, here and nowhere else.
//
// This is the seam that was missing. Producers post what they SAW; the
// authority accepts only canonical facts; and with nothing in between, every
// terminal hook and plugin POST was rejected while both sides' tests stayed
// green. Each half was tested against its own idea of the wire and neither ran
// the other's bytes.
//
// Semantics live in the per-provider mappers, which are unit-tested. This
// module does three things only: validate the producer body, choose the
// mapper, and stamp the envelope — including `observedAt`, which is the
// server's receive time and is the one field a producer genuinely cannot know.

import {
  AGENT_PRODUCER_BINDINGS,
  AGENT_STATE_SCHEMA_VERSION,
  parseAgentStateEnvelope,
  type AgentProducer,
  type AgentStateEnvelope,
  type AgentSemanticFact
} from '../../shared/controlPlane/index.js';
import { claudeFacts, type ClaudeObservation } from './claudeFacts.js';
import { opencodeFacts, type OpencodeObservation } from './opencodeFacts.js';

/** Contract cap on facts per envelope; a mapper returning more is a bug here. */
const MAX_FACTS_PER_ENVELOPE = 8;

export type ObservationEnvelopeResult =
  | { kind: 'envelope'; envelope: AgentStateEnvelope }
  /**
   * A well-formed observation that asserts nothing — SessionStart, an event
   * this build does not act on. Accepted and dropped: rejecting it would make
   * a healthy launch look like a failed one, and would train the producer's
   * error path to fire on ordinary traffic.
   */
  | { kind: 'no-facts' }
  | { kind: 'invalid'; reason: string };

export interface ObservationEnvelopeOptions {
  /** Server receive time. The producer cannot know when Desk saw the event. */
  observedAt: number;
}

interface ProducerBody {
  schemaVersion: number;
  sessionId: string;
  generation: number;
  provider: string;
  mode: string;
  producer: AgentProducer;
  producerInstanceId: string;
  producerSeq: number;
  eventId: string;
  invocationId: string;
  occurredAt: number;
  observation: Record<string, unknown>;
}

export function observationEnvelope(
  input: unknown,
  options: ObservationEnvelopeOptions
): ObservationEnvelopeResult {
  const body = readProducerBody(input);
  if ('reason' in body) {
    return { kind: 'invalid', reason: body.reason };
  }
  const facts = factsFor(body.value);
  if (facts.length === 0) {
    return { kind: 'no-facts' };
  }
  if (facts.length > MAX_FACTS_PER_ENVELOPE) {
    return { kind: 'invalid', reason: 'observation produced more facts than the envelope allows' };
  }

  // A tool edge is meaningless without the id that pairs it with its partner:
  // the authority closes an interval by ID, and an unpaired edge would either
  // leak an open interval or close the wrong one.
  const toolUseId = readOptionalIdentifier(body.value.observation.toolUseId);
  if (facts.some((fact) => fact.kind === 'tool') && toolUseId === undefined) {
    return { kind: 'invalid', reason: 'a tool interval edge requires a toolUseId' };
  }

  const candidate = {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    sessionId: body.value.sessionId,
    generation: body.value.generation,
    provider: body.value.provider,
    mode: body.value.mode,
    producer: body.value.producer,
    producerInstanceId: body.value.producerInstanceId,
    producerSeq: body.value.producerSeq,
    eventId: body.value.eventId,
    invocationId: body.value.invocationId,
    occurredAt: body.value.occurredAt,
    observedAt: options.observedAt,
    facts,
    ...(toolUseId === undefined ? {} : { correlation: { toolUseId } })
  };
  try {
    // Parsed here so the adapter can never hand the route something the route
    // would reject — the failure surfaces at the boundary that built it.
    return { kind: 'envelope', envelope: parseAgentStateEnvelope(candidate) };
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `adapter produced an invalid envelope: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Which mapper reads this producer's observations.
 *
 * Codex terminal hooks share Claude's hook vocabulary for the events Desk
 * subscribes to (SessionStart, UserPromptSubmit, Pre/PostToolUse,
 * PermissionRequest, Stop, SessionEnd), so they share the mapper. Native
 * producers do not arrive here at all — they speak the canonical protocol
 * directly through the daemon.
 */
function factsFor(body: ProducerBody): AgentSemanticFact[] {
  switch (body.producer) {
    case 'claude-hooks':
    case 'codex-hooks':
      return claudeFacts(body.observation as unknown as ClaudeObservation);
    case 'opencode-terminal':
      return opencodeFacts(body.observation as unknown as OpencodeObservation);
    default:
      // A native producer posting here is a routing mistake, not an
      // observation to interpret.
      return [];
  }
}

function readOptionalIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readProducerBody(input: unknown): { value: ProducerBody } | { reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { reason: 'producer body must be an object' };
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== AGENT_STATE_SCHEMA_VERSION) {
    return { reason: `producer body requires schemaVersion ${AGENT_STATE_SCHEMA_VERSION}` };
  }
  const producer = record.producer;
  if (typeof producer !== 'string' || !(producer in AGENT_PRODUCER_BINDINGS)) {
    return { reason: 'producer body names an unregistered producer' };
  }
  const binding = AGENT_PRODUCER_BINDINGS[producer as AgentProducer];
  if (record.provider !== binding.provider || record.mode !== binding.mode) {
    // The same check the envelope makes. Catching it here names the producer
    // that lied rather than reporting a generic envelope failure.
    return { reason: `producer ${producer} does not belong to ${String(record.provider)}/${String(record.mode)}` };
  }
  for (const key of ['sessionId', 'producerInstanceId', 'eventId', 'invocationId'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string).trim().length === 0) {
      return { reason: `producer body requires ${key}` };
    }
  }
  for (const key of ['generation', 'producerSeq'] as const) {
    const value = record[key];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      return { reason: `producer body requires a positive ${key}` };
    }
  }
  if (!Number.isSafeInteger(record.occurredAt) || (record.occurredAt as number) < 0) {
    return { reason: 'producer body requires occurredAt' };
  }
  const observation = record.observation;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return { reason: 'producer body requires an observation object' };
  }
  return {
    value: {
      schemaVersion: AGENT_STATE_SCHEMA_VERSION,
      sessionId: record.sessionId as string,
      generation: record.generation as number,
      provider: record.provider as string,
      mode: record.mode as string,
      producer: producer as AgentProducer,
      producerInstanceId: record.producerInstanceId as string,
      producerSeq: record.producerSeq as number,
      eventId: record.eventId as string,
      invocationId: record.invocationId as string,
      occurredAt: record.occurredAt as number,
      observation: observation as Record<string, unknown>
    }
  };
}
