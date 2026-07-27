// OpenCode reconciliation — the poll half of the one OpenCode adapter.
//
// Push (the plugin) tells Desk what changed; poll tells Desk what IS. Only the
// second can answer honestly after a restart, because a journal replay would
// resurrect the state as it was recorded — including a `working` written a
// moment before the agent was killed. Recovery therefore reads the live
// `GET /session/status` map instead of remembering.
//
// Exclusivity is per ADAPTER, not per transport: push and poll are two
// transports of the same OpenCode adapter, and for a field both can carry, the
// poll result is authoritative — it observed the present, the push observed a
// moment.
//
// Failure never invents a state. An unreachable or malformed server yields no
// facts and a reason, which the authority renders as `unknown` with an
// explanation — the one honest answer when evidence is missing (R2, R3).

import { opencodeFacts, type OpencodeObservation } from './opencodeFacts.js';
import type { AgentSemanticFact } from './facts.js';

/** Sessions accepted from one response; a runaway server cannot allocate freely (R4). */
export const MAX_RECONCILED_SESSIONS = 512;
export const DEFAULT_RECONCILE_TIMEOUT_MS = 2000;

export type ReconcileFailure = 'unreachable' | 'http-error' | 'malformed';

export interface OpencodeReconcileResult {
  ok: boolean;
  reason?: ReconcileFailure;
  /** HTTP status when the server answered at all — kept for the degraded reason. */
  status?: number;
  /** OpenCode sessionID → the facts its current status asserts. */
  sessions: Map<string, AgentSemanticFact[]>;
  /** Sessions dropped because the response exceeded the cap. */
  droppedForCap: number;
}

export interface ReconcileDeps {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

const EMPTY: ReadonlyMap<string, AgentSemanticFact[]> = new Map();

function failure(reason: ReconcileFailure, status?: number): OpencodeReconcileResult {
  return { ok: false, reason, status, sessions: new Map(EMPTY), droppedForCap: 0 };
}

/**
 * Read every live session's status from one OpenCode server.
 *
 * The status map is exactly `SessionStatus` per session, so it maps through the
 * same table the push path uses — there is one definition of what `busy` means,
 * not one per transport (R8.4).
 */
export async function reconcileOpencodeStatus(
  serverUrl: string,
  deps: ReconcileDeps
): Promise<OpencodeReconcileResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(statusUrl(serverUrl), { signal: controller.signal });
  } catch {
    // A server that is down, half-open, or slower than the budget is not
    // evidence of any activity — it is the absence of evidence.
    return failure('unreachable');
  } finally {
    clearTimeout(timer);
  }

  // Check the status before parsing: an error page parsed as JSON is how a
  // 500 becomes an empty, confident, wrong answer (R4).
  if (!response.ok) {
    return failure('http-error', response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure('malformed', response.status);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return failure('malformed', response.status);
  }

  const sessions = new Map<string, AgentSemanticFact[]>();
  let droppedForCap = 0;
  for (const [sessionID, status] of Object.entries(body as Record<string, unknown>)) {
    if (sessions.size >= MAX_RECONCILED_SESSIONS) {
      droppedForCap += 1;
      continue;
    }
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      continue;
    }
    const facts = statusFacts(status);
    // A status shape this build does not understand contributes nothing rather
    // than a guessed idle.
    if (facts.length > 0) {
      sessions.set(sessionID, facts);
    }
  }
  return { ok: true, status: response.status, sessions, droppedForCap };
}

function statusFacts(status: unknown): AgentSemanticFact[] {
  if (!status || typeof status !== 'object') {
    return [];
  }
  const record = status as { type?: unknown; attempt?: unknown; message?: unknown };
  const observation: OpencodeObservation = {
    type: 'session.status',
    status: {
      type: typeof record.type === 'string' ? record.type : undefined,
      attempt: typeof record.attempt === 'number' ? record.attempt : undefined,
      message: typeof record.message === 'string' ? record.message : undefined
    }
  };
  return opencodeFacts(observation);
}

function statusUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/session/status`;
}
