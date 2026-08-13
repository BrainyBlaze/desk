import { z } from 'zod';
import type { SessionStateTransition } from './contract.js';

export const DESK_EVENT_SCHEMA_VERSION = 1 as const;
export const DESK_EVENT_KINDS = [
  'agent-blocked',
  'agent-idle',
  'agent-error',
  'agent-recovered',
  'agent-exited',
  'channel-message'
] as const;

const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, 'must contain a non-whitespace character');
const identifierSchema = nonBlank(512);
const positiveSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.string().datetime({ offset: true });
const eventKindSchema = z.enum(DESK_EVENT_KINDS);

const baseEventShape = {
  schemaVersion: z.literal(DESK_EVENT_SCHEMA_VERSION),
  id: identifierSchema,
  seq: positiveSequenceSchema,
  at: timestampSchema,
  read: z.boolean()
};
const agentEventShape = {
  ...baseEventShape,
  sessionId: identifierSchema,
  generation: positiveSequenceSchema,
  authorityRevision: nonNegativeSequenceSchema
};
const waitSchema = z.strictObject({
  kind: nonBlank(128),
  owner: z.literal('operator'),
  since: nonNegativeSequenceSchema,
  detail: nonBlank(2_000).optional()
});
const healthySchema = z.strictObject({
  status: z.literal('healthy'),
  since: nonNegativeSequenceSchema
});
const degradedSchema = z.strictObject({
  status: z.literal('degraded'),
  reason: nonBlank(128),
  since: nonNegativeSequenceSchema,
  detail: nonBlank(2_000).optional()
});
const exitSchema = z.strictObject({
  at: nonNegativeSequenceSchema,
  code: z.number().int().nullable(),
  signal: nonBlank(64).nullable()
});

const agentBlockedEventSchema = z.strictObject({
  ...agentEventShape,
  kind: z.literal('agent-blocked'),
  wait: waitSchema
});
const agentIdleEventSchema = z.strictObject({
  ...agentEventShape,
  kind: z.literal('agent-idle')
});
const agentErrorEventSchema = z.strictObject({
  ...agentEventShape,
  kind: z.literal('agent-error'),
  health: degradedSchema
});
const agentRecoveredEventSchema = z.strictObject({
  ...agentEventShape,
  kind: z.literal('agent-recovered'),
  health: healthySchema
});
const agentExitedEventSchema = z.strictObject({
  ...agentEventShape,
  kind: z.literal('agent-exited'),
  exit: exitSchema
});
const channelMessageEventSchema = z.strictObject({
  ...baseEventShape,
  kind: z.literal('channel-message'),
  sessionId: identifierSchema.optional(),
  channel: identifierSchema,
  messageId: identifierSchema,
  thread: identifierSchema.optional(),
  author: identifierSchema,
  mentionsOperator: z.boolean(),
  message: nonBlank(10_000)
});

const deskEventSchema = z.discriminatedUnion('kind', [
  agentBlockedEventSchema,
  agentIdleEventSchema,
  agentErrorEventSchema,
  agentRecoveredEventSchema,
  agentExitedEventSchema,
  channelMessageEventSchema
]);

export type DeskEvent = z.infer<typeof deskEventSchema>;
export type DeskEventKind = z.infer<typeof eventKindSchema>;
type WithoutFeedIdentity<T> = T extends DeskEvent
  ? Omit<T, 'id' | 'seq' | 'read'>
  : never;
export type DeskEventDraft = WithoutFeedIdentity<DeskEvent>;

const channelMessageInputSchema = channelMessageEventSchema.omit({
  schemaVersion: true,
  id: true,
  seq: true,
  at: true,
  read: true,
  kind: true
});
export type ChannelMessageDeskEventInput = z.infer<
  typeof channelMessageInputSchema
>;

const readRequestSchema = z
  .strictObject({
    ids: z.array(identifierSchema).max(1_000).optional(),
    all: z.boolean().optional(),
    kinds: z.array(eventKindSchema).max(DESK_EVENT_KINDS.length).optional(),
    /** mark every channel-message posted into this thread parent read (resolved
        to ids server-side; never stored in the journal record) */
    thread: identifierSchema.optional()
  })
  .superRefine((value, context) => {
    if (
      value.all !== true &&
      (value.ids === undefined || value.ids.length === 0) &&
      (value.kinds === undefined || value.kinds.length === 0) &&
      value.thread === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'at least one read selector is required'
      });
    }
  });

export type DeskEventReadRequest = z.infer<typeof readRequestSchema>;

export interface DeskEventFeedResponse {
  schemaVersion: typeof DESK_EVENT_SCHEMA_VERSION;
  latestSeq: number;
  unread: number;
  items: DeskEvent[];
}

export interface DeskEventReadResponse {
  ok: true;
  unread: number;
}

export interface DeskEventClearResponse {
  ok: true;
  unread: 0;
}

const feedResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(DESK_EVENT_SCHEMA_VERSION),
    latestSeq: nonNegativeSequenceSchema,
    unread: nonNegativeSequenceSchema,
    items: z.array(deskEventSchema).max(1_000)
  })
  .superRefine((value, context) => {
    let previous = Number.POSITIVE_INFINITY;
    const ids = new Set<string>();
    for (let index = 0; index < value.items.length; index += 1) {
      const event = value.items[index]!;
      if (
        event.seq > value.latestSeq ||
        event.seq >= previous ||
        ids.has(event.id)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'feed items must be unique and strictly newest-first'
        });
      }
      previous = event.seq;
      ids.add(event.id);
    }
  });
const readResponseSchema = z.strictObject({
  ok: z.literal(true),
  unread: nonNegativeSequenceSchema
});
const clearResponseSchema = z.strictObject({
  ok: z.literal(true),
  unread: z.literal(0)
});

export function parseDeskEvent(input: unknown): DeskEvent {
  return deskEventSchema.parse(input);
}

export function parseChannelMessageDeskEventInput(
  input: unknown
): ChannelMessageDeskEventInput {
  return channelMessageInputSchema.parse(input);
}

export function parseDeskEventReadRequest(input: unknown): DeskEventReadRequest {
  return readRequestSchema.parse(input);
}

export function parseDeskEventFeedResponse(
  input: unknown
): DeskEventFeedResponse {
  return feedResponseSchema.parse(input);
}

export function parseDeskEventReadResponse(
  input: unknown
): DeskEventReadResponse {
  return readResponseSchema.parse(input);
}

export function parseDeskEventClearResponse(
  input: unknown
): DeskEventClearResponse {
  return clearResponseSchema.parse(input);
}

function transitionAt(transition: SessionStateTransition): string {
  const date = new Date(transition.at);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid transition timestamp: ${transition.at}`);
  }
  return date.toISOString();
}

export function projectTransitionToDeskEvents(
  transition: SessionStateTransition
): DeskEventDraft[] {
  if (transition.to.subject.kind !== 'agent') {
    return [];
  }

  const at = transitionAt(transition);
  const common = {
    schemaVersion: DESK_EVENT_SCHEMA_VERSION,
    at,
    sessionId: transition.sessionId,
    generation: transition.generation,
    authorityRevision: transition.revision
  } as const;
  const events: DeskEventDraft[] = [];
  const fromAgent =
    transition.from?.subject.kind === 'agent'
      ? transition.from.subject
      : undefined;
  const toAgent = transition.to.subject;

  const operatorWait =
    toAgent.activity === 'blocked' && toAgent.wait?.owner === 'operator'
      ? { ...toAgent.wait, owner: 'operator' as const }
      : null;
  const wasOperatorBlocked =
    fromAgent?.activity === 'blocked' &&
    fromAgent.wait?.owner === 'operator';
  if (
    transition.actionable &&
    operatorWait !== null &&
    !wasOperatorBlocked
  ) {
    events.push({
      ...common,
      kind: 'agent-blocked',
      wait: operatorWait
    });
  }

  if (
    fromAgent !== undefined &&
    fromAgent.activity !== 'idle' &&
    toAgent.activity === 'idle'
  ) {
    events.push({ ...common, kind: 'agent-idle' });
  }

  if (
    transition.from !== null &&
    transition.from.health.status !== 'degraded' &&
    transition.to.health.status === 'degraded' &&
    transition.cause !== 'registered' &&
    transition.cause !== 'producer-reconciled'
  ) {
    events.push({
      ...common,
      kind: 'agent-error',
      health: transition.to.health
    });
  }

  if (
    transition.from?.health.status === 'degraded' &&
    transition.to.health.status === 'healthy'
  ) {
    events.push({
      ...common,
      kind: 'agent-recovered',
      health: transition.to.health
    });
  }

  if (
    transition.from !== null &&
    transition.from.lifecycle !== 'exited' &&
    transition.to.lifecycle === 'exited' &&
    transition.to.exit !== null
  ) {
    events.push({
      ...common,
      kind: 'agent-exited',
      exit: transition.to.exit
    });
  }

  return events;
}
