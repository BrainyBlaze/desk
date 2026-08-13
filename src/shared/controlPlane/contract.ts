import { z } from 'zod';

export const AGENT_STATE_SCHEMA_VERSION = 3 as const;

export type SessionLifecycle = 'starting' | 'running' | 'exited';
export type AgentActivity = 'working' | 'blocked' | 'idle' | 'unknown';
export type WaitOwner = 'operator' | 'provider' | 'desk';
export type AgentProvider = 'codex' | 'claude' | 'opencode';
export type AgentMode = 'terminal' | 'native';
export type AgentStateTransport = 'push' | 'poll';
export type AgentProducer =
  | 'codex-hooks'
  | 'codex-native'
  | 'claude-hooks'
  | 'claude-native'
  | 'opencode-terminal'
  | 'opencode-native';

export const AGENT_PRODUCER_BINDINGS = {
  'codex-hooks': { provider: 'codex', mode: 'terminal' },
  'codex-native': { provider: 'codex', mode: 'native' },
  'claude-hooks': { provider: 'claude', mode: 'terminal' },
  'claude-native': { provider: 'claude', mode: 'native' },
  'opencode-terminal': { provider: 'opencode', mode: 'terminal' },
  'opencode-native': { provider: 'opencode', mode: 'native' }
} as const satisfies Record<AgentProducer, { provider: AgentProvider; mode: AgentMode }>;

/**
 * Health reasons are short operator-facing labels, not prose. Exported so a
 * producer bounds its text to the SAME number the schema enforces — writing
 * the limit twice is how a 200-char reason came to be rejected outright,
 * silently dropping the degraded fact it carried.
 */
export const MAX_HEALTH_REASON_CHARS = 128;

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, 'must contain a non-whitespace character');
const identifierSchema = boundedText(512);
const detailSchema = boundedText(2_000);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const waitOwnerSchema = z.enum(['operator', 'provider', 'desk']);
const agentWaitInputSchema = z.strictObject({
  kind: boundedText(128),
  owner: waitOwnerSchema,
  detail: detailSchema.optional()
});

const healthInputSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('healthy') }),
  z.strictObject({
    status: z.literal('degraded'),
    reason: boundedText(MAX_HEALTH_REASON_CHARS),
    detail: detailSchema.optional()
  })
]);

const semanticFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('activity'),
    activity: z.enum(['working', 'idle', 'unknown'])
  }),
  z.strictObject({
    kind: z.literal('blocked'),
    wait: agentWaitInputSchema
  }),
  z.strictObject({ kind: z.literal('unblocked') }),
  z.strictObject({ kind: z.literal('heartbeat') }),
  z.strictObject({
    kind: z.literal('tool'),
    phase: z.enum(['start', 'end'])
  }),
  z.strictObject({
    kind: z.literal('health'),
    health: healthInputSchema
  })
]);

export type AgentWaitInput = z.infer<typeof agentWaitInputSchema>;
export type AgentHealthInput = z.infer<typeof healthInputSchema>;
export type AgentSemanticFact = z.infer<typeof semanticFactSchema>;

const correlationSchema = z.strictObject({
  turnId: identifierSchema.optional(),
  toolUseId: identifierSchema.optional(),
  permissionId: identifierSchema.optional(),
  deliveryId: identifierSchema.optional()
});

const envelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(AGENT_STATE_SCHEMA_VERSION),
    sessionId: identifierSchema,
    generation: positiveSequenceSchema,
    provider: z.enum(['codex', 'claude', 'opencode']),
    mode: z.enum(['terminal', 'native']),
    producer: z.enum([
      'codex-hooks',
      'codex-native',
      'claude-hooks',
      'claude-native',
      'opencode-terminal',
      'opencode-native'
    ]),
    producerInstanceId: identifierSchema,
    transport: z.enum(['push', 'poll']).optional(),
    producerSeq: positiveSequenceSchema,
    eventId: identifierSchema,
    invocationId: identifierSchema,
    occurredAt: timestampSchema,
    observedAt: timestampSchema,
    facts: z.array(semanticFactSchema).min(1).max(8),
    correlation: correlationSchema.optional()
  })
  .superRefine((value, context) => {
    const binding = AGENT_PRODUCER_BINDINGS[value.producer];
    if (binding.provider !== value.provider) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `${value.producer} belongs to provider ${binding.provider}`
      });
    }
    if (binding.mode !== value.mode) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: `${value.producer} belongs to mode ${binding.mode}`
      });
    }
    const activityAssertions = value.facts.filter(
      (fact) =>
        fact.kind === 'activity' ||
        fact.kind === 'blocked' ||
        fact.kind === 'unblocked' ||
        (fact.kind === 'tool' && fact.phase === 'start')
    );
    if (activityAssertions.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['facts'],
        message: 'an observation may contain at most one activity assertion'
      });
    }
    if (value.facts.filter((fact) => fact.kind === 'health').length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['facts'],
        message: 'an observation may contain at most one health assertion'
      });
    }
    const toolFacts = value.facts.filter((fact) => fact.kind === 'tool');
    if (toolFacts.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['facts'],
        message: 'an observation may contain at most one tool interval edge'
      });
    }
    if (toolFacts.length > 0 && value.correlation?.toolUseId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['correlation', 'toolUseId'],
        message: 'tool interval edges require a correlated toolUseId'
      });
    }
  });

export type AgentStateEnvelope = z.infer<typeof envelopeSchema>;

const sessionHealthSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('healthy'),
    since: timestampSchema
  }),
  z.strictObject({
    status: z.literal('degraded'),
    reason: boundedText(MAX_HEALTH_REASON_CHARS),
    since: timestampSchema,
    detail: detailSchema.optional()
  })
]);

const agentWaitSchema = agentWaitInputSchema.extend({
  since: timestampSchema
});

const producerEvidenceSchema = z.strictObject({
  acceptanceId: identifierSchema,
  acceptedSeq: positiveSequenceSchema,
  acceptedAt: timestampSchema,
  producerInstanceId: identifierSchema,
  transport: z.enum(['push', 'poll']).optional(),
  producerSeq: positiveSequenceSchema,
  eventId: identifierSchema,
  invocationId: identifierSchema,
  factKinds: z.array(z.enum(['activity', 'blocked', 'unblocked', 'heartbeat', 'tool', 'health'])).min(1).max(8),
  occurredAt: timestampSchema,
  observedAt: timestampSchema,
  leaseExpiresAt: timestampSchema.optional()
});

const titleEvidenceSchema = z.strictObject({
  source: z.literal('terminal-title'),
  observedAt: timestampSchema,
  leaseExpiresAt: z.undefined().optional()
});

const evidenceSchema = z.union([producerEvidenceSchema, titleEvidenceSchema]);

const agentSubjectSchema = z
  .strictObject({
    kind: z.literal('agent'),
    provider: z.enum(['codex', 'claude', 'opencode']),
    mode: z.enum(['terminal', 'native']),
    producer: z.enum([
      'codex-hooks',
      'codex-native',
      'claude-hooks',
      'claude-native',
      'opencode-terminal',
      'opencode-native'
    ]),
    activity: z.enum(['working', 'blocked', 'idle', 'unknown']),
    activitySince: timestampSchema,
    wait: agentWaitSchema.nullable(),
    evidence: evidenceSchema.nullable()
  })
  .superRefine((value, context) => {
    const binding = AGENT_PRODUCER_BINDINGS[value.producer];
    if (binding.provider !== value.provider) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `${value.producer} belongs to provider ${binding.provider}`
      });
    }
    if (binding.mode !== value.mode) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: `${value.producer} belongs to mode ${binding.mode}`
      });
    }
    if ((value.activity === 'blocked') !== (value.wait !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['wait'],
        message: 'wait must be present exactly when activity is blocked'
      });
    }
    const titleEvidence =
      value.evidence !== null &&
      'source' in value.evidence &&
      value.evidence.source === 'terminal-title';
    if (
      value.activity === 'working' &&
      !titleEvidence &&
      value.evidence?.leaseExpiresAt === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'leaseExpiresAt'],
        message: 'working activity requires leased evidence'
      });
    }
    if (titleEvidence && value.activity !== 'working' && value.activity !== 'idle') {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'terminal title evidence requires working or idle activity'
      });
    }
  });

const terminalSubjectSchema = z.strictObject({
  kind: z.literal('terminal')
});

const deliverySchema = z.strictObject({
  state: z.enum(['queued', 'delivering', 'confirmed', 'submit-stuck', 'blocked']),
  since: timestampSchema,
  deliveryId: identifierSchema.optional(),
  detail: detailSchema.optional()
});

const policySchema = z.strictObject({
  paused: z.boolean(),
  since: timestampSchema,
  reason: detailSchema.optional()
});

const exitSchema = z.strictObject({
  at: timestampSchema,
  code: z.number().int().nullable(),
  signal: boundedText(64).nullable(),
  /**
   * desk#59 — who ended the session. `observed` means the child's own exit
   * reached us and code/signal are the truth; `retired` means Desk tore the
   * session down and knows nothing about how the child died. Optional ONLY so
   * that exits journalled before this field existed still parse: their
   * provenance is genuinely unknown and must not be invented.
   */
  origin: z.enum(['observed', 'retired']).optional(),
  /** Which call site retired the session (`retired` only). */
  reason: boundedText(120).nullable().optional()
});

const snapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(AGENT_STATE_SCHEMA_VERSION),
    revision: nonNegativeSequenceSchema,
    sessionId: identifierSchema,
    generation: positiveSequenceSchema,
    lifecycle: z.enum(['starting', 'running', 'exited']),
    lifecycleSince: timestampSchema,
    exit: exitSchema.nullable(),
    health: sessionHealthSchema,
    delivery: deliverySchema.nullable(),
    policy: policySchema,
    subject: z.discriminatedUnion('kind', [agentSubjectSchema, terminalSubjectSchema]),
    updatedAt: timestampSchema
  })
  .superRefine((value, context) => {
    if ((value.lifecycle === 'exited') !== (value.exit !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['exit'],
        message: 'exit details must be present exactly when lifecycle is exited'
      });
    }
    if (value.subject.kind === 'agent') {
      const titleEvidence =
        value.subject.evidence !== null &&
        'source' in value.subject.evidence &&
        value.subject.evidence.source === 'terminal-title';
      const titleFallbackHealth =
        value.health.status === 'degraded' && value.health.reason === 'title-fallback';
      if (value.lifecycle !== 'exited' && titleEvidence !== titleFallbackHealth) {
        context.addIssue({
          code: 'custom',
          path: titleEvidence ? ['health'] : ['subject', 'evidence'],
          message: 'terminal title evidence and title-fallback health must appear together'
        });
      }
    }
  });

export type SessionHealth = z.infer<typeof sessionHealthSchema>;
export type AgentWait = z.infer<typeof agentWaitSchema>;
export type AgentEvidence = z.infer<typeof evidenceSchema>;
export type AgentSubjectSnapshot = z.infer<typeof agentSubjectSchema>;
export type TerminalSubjectSnapshot = z.infer<typeof terminalSubjectSchema>;
export type DeliverySnapshot = z.infer<typeof deliverySchema>;
export type SessionPolicySnapshot = z.infer<typeof policySchema>;
export type SessionExit = z.infer<typeof exitSchema>;
export type SessionStateSnapshot = z.infer<typeof snapshotSchema>;

export interface AcceptedAgentStateEvent {
  acceptanceId: string;
  acceptedSeq: number;
  acceptedAt: number;
  envelope: AgentStateEnvelope;
}

export type SessionStateTransitionCause =
  | 'registered'
  | 'lifecycle-running'
  | 'lifecycle-exited'
  | 'producer-reconciled'
  | 'agent-event'
  | 'title-fallback'
  | 'source-health'
  | 'working-lease-expired'
  | 'delivery'
  | 'policy';

export interface SessionStateTransition {
  schemaVersion: typeof AGENT_STATE_SCHEMA_VERSION;
  revision: number;
  sessionId: string;
  generation: number;
  at: number;
  cause: SessionStateTransitionCause;
  acceptedEventId?: string;
  actionable: boolean;
  from: SessionStateSnapshot | null;
  to: SessionStateSnapshot;
}

export function parseAgentStateEnvelope(input: unknown): AgentStateEnvelope {
  return envelopeSchema.parse(input);
}

export function parseSessionStateSnapshot(input: unknown): SessionStateSnapshot {
  return snapshotSchema.parse(input);
}
