export const AGENT_EVENT_SCHEMA_VERSION = 2;

export type AgentEventKindV2 =
  | 'session-start'
  | 'prompt-submitted'
  | 'stop'
  | 'stop-failure'
  | 'approval-requested'
  | 'input-requested'
  | 'session-idle'
  | 'session-status'
  | 'session-end'
  | 'delivery-ack'
  | 'heartbeat';

const AGENT_EVENT_KINDS = new Set<AgentEventKindV2>([
  'session-start',
  'prompt-submitted',
  'stop',
  'stop-failure',
  'approval-requested',
  'input-requested',
  'session-idle',
  'session-status',
  'session-end',
  'delivery-ack',
  'heartbeat'
]);

export interface AgentEventV2 {
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  kind: AgentEventKindV2;
  session: string;
  agent: string;
  turnId?: string;
  notificationId?: string;
  ts: string;
  message?: string;
  status?: string;
}

export type LegacyAgentSignalKind = 'turn-complete' | 'approval-requested' | 'input-requested' | 'bell';

export interface NormalizedAgentEvent {
  event: AgentEventV2;
  attentionKind?: LegacyAgentSignalKind;
  signalKind?: LegacyAgentSignalKind;
  resumeSessionId?: string;
  deliveryAckNotificationId?: string;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`agent event requires ${field}`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function assertFullTmuxSession(session: string): void {
  if (/^[a-f0-9]{8}$/i.test(session)) {
    throw new Error('agent event session must be the full tmux session name, not a suffix');
  }
}

export function parseAgentEventV2(input: unknown, now = new Date()): AgentEventV2 {
  if (!input || typeof input !== 'object') {
    throw new Error('agent event must be an object');
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    throw new Error('agent event requires schemaVersion 2');
  }
  const kind = readString(record.kind, 'kind');
  if (!AGENT_EVENT_KINDS.has(kind as AgentEventKindV2)) {
    throw new Error(`unsupported agent event kind: ${kind}`);
  }
  const session = readString(record.session, 'session');
  assertFullTmuxSession(session);
  const agent = readString(record.agent, 'agent');
  const ts = readOptionalString(record.ts) ?? now.toISOString();

  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    kind: kind as AgentEventKindV2,
    session,
    agent,
    turnId: readOptionalString(record.turnId),
    notificationId: readOptionalString(record.notificationId),
    ts,
    message: readOptionalString(record.message),
    status: readOptionalString(record.status)
  };
}

export function normalizeAgentEventForApi(input: unknown, now = new Date()): NormalizedAgentEvent {
  if (input && typeof input === 'object' && (input as Record<string, unknown>).schemaVersion === AGENT_EVENT_SCHEMA_VERSION) {
    const event = parseAgentEventV2(input, now);
    return {
      event,
      attentionKind: eventToLegacySignal(event.kind),
      signalKind: eventToLegacySignal(event.kind),
      deliveryAckNotificationId: eventDeliveryAckNotificationId(event)
    };
  }
  if (!input || typeof input !== 'object') {
    throw new Error('agent event must be an object');
  }
  const record = input as Record<string, unknown>;
  const legacyKind = readOptionalString(record.kind);
  const kind: AgentEventKindV2 =
    legacyKind === 'approval-requested'
      ? 'approval-requested'
      : legacyKind === 'input-requested'
        ? 'input-requested'
        : 'stop';
  const event = parseAgentEventV2(
    {
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      kind,
      session: record.session,
      agent: readOptionalString(record.agent) ?? 'legacy',
      ts: record.ts,
      message: record.message
    },
    now
  );
  const signalKind = eventToLegacySignal(event.kind);
  return {
    event,
    attentionKind: signalKind,
    signalKind,
    resumeSessionId: readOptionalString(record.sessionId)
  };
}

function eventToLegacySignal(kind: AgentEventKindV2): LegacyAgentSignalKind | undefined {
  switch (kind) {
    case 'stop':
    case 'session-idle':
      return 'turn-complete';
    case 'approval-requested':
      return 'approval-requested';
    case 'input-requested':
      return 'input-requested';
    default:
      return undefined;
  }
}

function eventDeliveryAckNotificationId(event: AgentEventV2): string | undefined {
  if ((event.kind === 'delivery-ack' || event.kind === 'prompt-submitted') && event.notificationId) {
    return event.notificationId;
  }
  return undefined;
}
