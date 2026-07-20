// Control plane — the per-session reducer (spec §6.1–6.4). Pure module.
//
// Folds fence-passed AcceptedEvents into a SessionModel and re-resolves the
// effective state. Two transition triggers exist, and both route through
// `refreshSessionState`: (a) a new event arrives; (b) time passes and a
// higher-precedence source goes stale (§6.4) — the daemon calls refresh on a
// timer / next read so staleness-driven transitions are not missed.

import {
  type AcceptedEvent,
  type SessionModel,
  type Source,
  type SourceContribution,
  resolveState
} from './model.js';

/** A fresh session model at generation `generation`, resolving to `unknown`. */
export function createSessionModel(sessionId: string, generation: number, now: number): SessionModel {
  return {
    sessionId,
    generation,
    state: 'unknown',
    source: 'unknown',
    stateSince: now,
    idleSince: undefined,
    contributions: new Map<Source, SourceContribution>()
  };
}

/**
 * Fold one AcceptedEvent into the model, then re-resolve (§6.2/§6.4).
 * Generation handling:
 *  - event.generation  <  model.generation → STALE recreate-order event, ignored
 *    (defense in depth; the §6.3 fence should already have rejected it).
 *  - event.generation  >  model.generation → the session was recreated: adopt the
 *    new generation and DROP all prior-generation contributions (they describe a
 *    dead process).
 * Within the current generation, a per-source contribution is replaced only by a
 * STRICTLY higher `sourceSeq` (§6.2 "equal source, higher sourceSeq wins") — so a
 * reordered or duplicated event never regresses the source's latest state.
 * Mutates and returns `model`.
 */
export function applySessionEvent(model: SessionModel, event: AcceptedEvent, now: number): SessionModel {
  if (event.generation < model.generation) return model; // stale generation — drop
  if (event.generation > model.generation) {
    model.generation = event.generation;
    model.contributions.clear();
  }
  const existing = model.contributions.get(event.source);
  if (existing === undefined || event.sourceSeq > existing.sourceSeq) {
    model.contributions.set(event.source, {
      source: event.source,
      state: event.state,
      sourceSeq: event.sourceSeq,
      ts: event.ts
    });
  }
  return refreshSessionState(model, now);
}

/**
 * Re-resolve `state`/`source` from the retained contributions at `now` and
 * update the derived timestamps. Idempotent for a fixed `now`; call it on a
 * timer to catch staleness-driven transitions (a stale typed-hook dropping to a
 * fresh native/rendered source, or all-stale → `unknown`). `stateSince` advances
 * only when the resolved state actually CHANGES (not on mere re-observation);
 * `idleSince` is set on entering `idle` and cleared on leaving it.
 */
export function refreshSessionState(model: SessionModel, now: number): SessionModel {
  const resolved = resolveState(model.contributions, now);
  if (resolved.state !== model.state) {
    model.stateSince = now;
    if (resolved.state === 'idle') model.idleSince = now;
    else if (model.state === 'idle') model.idleSince = undefined;
  }
  // `source` can change even when `state` does not (e.g. typed-hook and native
  // both report `working`, then the hook goes stale); keep it truthful.
  model.state = resolved.state;
  model.source = resolved.source;
  if (model.state !== 'idle') model.idleSince = undefined;
  return model;
}
