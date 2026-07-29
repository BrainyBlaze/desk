// The web server's read of the canonical session state.
//
// The daemon owns the authority; this module is a projection gateway and
// nothing else — it never derives, caches, or repairs state. Every consumer
// (sidebar, multiplexer, channels footer, events) reads the same revision from
// the same read, so two surfaces cannot disagree about one session.
//
// Failure is reported, never smoothed over. An unreachable daemon yields no
// snapshots and a reason, which renders as `unknown`; serving a remembered
// snapshot instead would show a turn that may have ended minutes ago as if it
// were current, and that is precisely the class of lie this subsystem is being
// rebuilt to remove.

import { daemonControlGet } from '../shared/daemonControlClient.js';
import { parseSessionStateSnapshot, type SessionStateSnapshot } from '../shared/controlPlane/index.js';

export type AgentStatePulseFailure = 'daemon-unreachable' | 'malformed';

export interface AgentStatePulse {
  ok: boolean;
  /** The authority's revision for this read; null when the read failed. */
  revision: number | null;
  reason?: AgentStatePulseFailure;
  snapshots: SessionStateSnapshot[];
  /** Snapshots the daemon returned that did not satisfy the contract. */
  rejected: number;
}

/** Bounded pulse budget: a slow daemon must not stall every browser tab. */
export const AGENT_STATE_PULSE_TIMEOUT_MS = 2000;

function failure(reason: AgentStatePulseFailure): AgentStatePulse {
  return { ok: false, revision: null, reason, snapshots: [], rejected: 0 };
}

export async function readAgentStatePulse(
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<AgentStatePulse> {
  const result = await daemonControlGet('/control/agent-states', {
    timeoutMs: options.timeoutMs ?? AGENT_STATE_PULSE_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  if (!result.ok || !result.body) {
    return failure('daemon-unreachable');
  }
  const revision = result.body.revision;
  const raw = result.body.snapshots;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || !Array.isArray(raw)) {
    return failure('malformed');
  }

  const snapshots: SessionStateSnapshot[] = [];
  let rejected = 0;
  for (const candidate of raw) {
    try {
      // Validated at the process boundary rather than trusted: a snapshot that
      // does not satisfy the contract must be dropped loudly, not rendered as
      // a half-populated row.
      snapshots.push(parseSessionStateSnapshot(candidate));
    } catch {
      rejected += 1;
    }
  }
  return { ok: true, revision, snapshots, rejected };
}

/**
 * Index snapshots by sessionId for the browser. The client keys every surface
 * by sessionId, and a duplicate would mean the authority holds two states for
 * one session — the later revision wins so the projection stays deterministic.
 */
export function indexSnapshots(snapshots: SessionStateSnapshot[]): Record<string, SessionStateSnapshot> {
  const byId: Record<string, SessionStateSnapshot> = {};
  for (const snapshot of snapshots) {
    const current = byId[snapshot.sessionId];
    if (!current || snapshot.revision >= current.revision) {
      byId[snapshot.sessionId] = snapshot;
    }
  }
  return byId;
}
