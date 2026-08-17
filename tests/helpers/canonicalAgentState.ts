import type { AgentStateBatch } from '../../src/server/channels/delivery/strategy.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AgentActivity,
  type SessionLifecycle,
  type SessionStateSnapshot,
  type WaitOwner
} from '../../src/shared/controlPlane/index.js';

export interface CanonicalSnapshotOptions {
  activity?: AgentActivity;
  lifecycle?: SessionLifecycle;
  waitOwner?: WaitOwner;
  waitKind?: string;
  leaseExpiresAt?: number;
  now?: number;
  revision?: number;
}

export function canonicalAgentSnapshot(
  sessionId: string,
  options: CanonicalSnapshotOptions = {}
): SessionStateSnapshot {
  const now = options.now ?? Date.now();
  const activity = options.activity ?? 'idle';
  const blocked = activity === 'blocked';
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    revision: options.revision ?? 1,
    sessionId,
    generation: 1,
    lifecycle: options.lifecycle ?? 'running',
    lifecycleSince: now - 10_000,
    exit: null,
    health: { status: 'healthy', since: now - 10_000 },
    delivery: null,
    policy: { paused: false, since: now - 10_000 },
    subject: {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      activity,
      activitySince: now - 5_000,
      wait: blocked
        ? {
            kind: options.waitKind ?? 'approval',
            owner: options.waitOwner ?? 'operator',
            since: now - 5_000
          }
        : null,
      evidence:
        activity === 'unknown'
          ? null
          : {
              acceptanceId: `accept-${sessionId}`,
              acceptedSeq: 1,
              acceptedAt: now - 5_000,
              producerInstanceId: `producer-${sessionId}`,
              producerSeq: 1,
              eventId: `event-${sessionId}`,
              invocationId: `invocation-${sessionId}`,
              factKinds: [blocked ? 'blocked' : 'activity'],
              occurredAt: now - 5_000,
              observedAt: now - 5_000,
              ...(activity === 'working'
                ? { leaseExpiresAt: options.leaseExpiresAt ?? now + 30_000 }
                : {})
            }
    },
    updatedAt: now - 5_000
  };
}

export function canonicalAgentStateBatch(
  sessionIds: readonly string[],
  options: CanonicalSnapshotOptions = {}
): AgentStateBatch {
  return {
    ok: true,
    revision: options.revision ?? 1,
    snapshots: sessionIds.map((sessionId) => canonicalAgentSnapshot(sessionId, options))
  };
}
