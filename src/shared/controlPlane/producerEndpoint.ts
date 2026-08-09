import { z } from 'zod';
import { AGENT_STATE_SCHEMA_VERSION } from './contract.js';

const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0, 'must contain a non-whitespace character');
const positiveSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const loopbackEndpointSchema = z.string().min(1).max(2_048).transform((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'endpoint must be a valid URL' });
    return z.NEVER;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:' ||
    (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    context.addIssue({
      code: 'custom',
      message: 'endpoint must be a bare loopback HTTP origin'
    });
    return z.NEVER;
  }
  return parsed.toString();
});

const producerFields = {
  schemaVersion: z.literal(AGENT_STATE_SCHEMA_VERSION),
  sessionId: identifierSchema,
  generation: positiveSequenceSchema,
  provider: z.literal('opencode'),
  mode: z.literal('terminal'),
  producer: z.literal('opencode-terminal'),
  producerInstanceId: identifierSchema,
  producerSeq: positiveSequenceSchema,
  endpoint: loopbackEndpointSchema,
  providerSessionId: identifierSchema.optional()
} as const;

const endpointObservationSchema = z.strictObject({
  ...producerFields,
  observedAt: z.undefined().optional()
});

const endpointRegistrationSchema = z.strictObject({
  ...producerFields,
  observedAt: timestampSchema
});

const endpointFingerprintSchema = z.strictObject(producerFields);

const endpointActivationSchema = z.strictObject({
  ...producerFields,
  providerSessionId: identifierSchema
});

export type AgentEndpointRegistration = z.infer<typeof endpointRegistrationSchema>;
export type AgentEndpointFingerprint = z.infer<typeof endpointFingerprintSchema>;
export type AgentEndpointActivation = z.infer<typeof endpointActivationSchema>;

export type AgentEndpointAdaptation =
  | { kind: 'registration'; registration: AgentEndpointRegistration }
  | { kind: 'invalid'; reason: string };

export function adaptAgentEndpointRegistration(
  input: unknown,
  options: { observedAt: number }
): AgentEndpointAdaptation {
  const observedAt = timestampSchema.safeParse(options.observedAt);
  if (!observedAt.success) {
    throw new Error('agent endpoint clock must return a non-negative safe integer');
  }
  const parsed = endpointObservationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      reason: parsed.error.issues[0]?.message ?? 'invalid agent endpoint registration'
    };
  }
  const { observedAt: _ignored, ...observation } = parsed.data;
  return {
    kind: 'registration',
    registration: endpointRegistrationSchema.parse({
      ...observation,
      observedAt: observedAt.data
    })
  };
}

export function parseAgentEndpointRegistration(input: unknown): AgentEndpointRegistration {
  return endpointRegistrationSchema.parse(input);
}

export function agentEndpointFingerprint(
  registration: AgentEndpointRegistration
): AgentEndpointFingerprint {
  const { observedAt: _observedAt, ...fingerprint } = registration;
  return endpointFingerprintSchema.parse(fingerprint);
}

export function parseAgentEndpointActivation(input: unknown): AgentEndpointActivation {
  return endpointActivationSchema.parse(input);
}
