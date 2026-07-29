// Producer-side helpers for building agent-state facts.
//
// The fact vocabulary itself is NOT defined here: it is the canonical
// `AgentSemanticFact` from the control-plane contract, which producers import
// directly. A second definition of the same union — however faithful on the
// day it is written — is the parallel model this refactor exists to remove.
//
// What lives here is the one thing a producer owns: bounding the operator-facing
// text it copies out of an agent payload, before that text crosses a boundary.

export type { AgentSemanticFact, AgentWaitInput } from '../../shared/controlPlane/index.js';
import { MAX_HEALTH_REASON_CHARS } from '../../shared/controlPlane/index.js';

/**
 * Producer-side cap for copied text. Stricter than the contract's own 2000-char
 * bound on purpose: these strings are lifted verbatim out of provider payloads
 * and land in a sidebar row, so the producer trims at the source rather than
 * relying on every consumer to trim later.
 */
export const MAX_FACT_DETAIL_CHARS = 200;

export function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > MAX_FACT_DETAIL_CHARS ? `${trimmed.slice(0, MAX_FACT_DETAIL_CHARS - 1)}…` : trimmed;
}

/**
 * A health reason is bounded TIGHTER than a detail: the schema caps it at
 * MAX_HEALTH_REASON_CHARS and rejects anything longer outright, so a producer
 * that trimmed to the detail cap instead would emit an envelope the authority
 * refuses — dropping the degraded fact it was reporting. Trim to the number
 * the contract actually enforces.
 */
export function boundedReason(value: unknown, fallback: string): string {
  const trimmed = boundedDetail(value);
  if (trimmed === undefined) {
    return fallback;
  }
  return trimmed.length > MAX_HEALTH_REASON_CHARS
    ? `${trimmed.slice(0, MAX_HEALTH_REASON_CHARS - 1)}…`
    : trimmed;
}
