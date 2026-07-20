// Control plane — the source-tagged lifecycle model (spec §6.1–6.4, contract C16).
// Pure module (src/shared): no server/web/daemon imports. Both the daemon
// (authoritative producer) and the web-server projections (§6.7) build on this.
//
// One model per session resolves a single `state` from possibly-several sources,
// each tagged with its provenance and freshness. Precedence + staleness are the
// two rules that make the resolution honest (§6.2/§6.4).

/**
 * The unified control state (§6.1). This is the frozen `LifecycleStatus`
 * (src/server/channelsProtocol.ts:99: working | submit-stuck | blocked |
 * awaiting-approval | paused | idle) EXTENDED with `unknown` — a deliberate
 * union widening, NOT a value LifecycleStatus already carries. The `/state`
 * projection (§6.7) maps `unknown` to a rendered "unknown" the UI shows
 * honestly rather than coercing to idle. Kept as its own union here because
 * src/shared must not import from src/server (layering); the server projection
 * re-narrows to LifecycleStatus and handles `unknown` explicitly.
 */
export type ControlState =
  | 'working'
  | 'submit-stuck'
  | 'blocked'
  | 'awaiting-approval'
  | 'paused'
  | 'idle'
  | 'unknown';

/**
 * State provenance (§6.2). Precedence: typed-hook > native-fsm >
 * worker-rendered(degraded) > unknown. bash/custom agents produce `unknown`
 * and are NEVER coerced to a higher source. `worker-rendered` is the degraded
 * classifier fed by the headless buffer (§6.8) — always below typed/native.
 */
export type Source = 'typed-hook' | 'native-fsm' | 'worker-rendered' | 'unknown';

/** Precedence rank — higher wins (§6.2). `unknown` is a real, lowest source. */
export const SOURCE_RANK: Readonly<Record<Source, number>> = Object.freeze({
  'typed-hook': 3,
  'native-fsm': 2,
  'worker-rendered': 1,
  unknown: 0
});

/**
 * Per-source freshness TTL in ms (§6.4). Past its TTL a source's contribution
 * is REMOVED from resolution (dropped, not masked with `unknown`), so a fresh
 * lower-precedence source can win. Proposed values [CHECK]: typed hooks and the
 * native FSM are event-driven and long-lived; the worker-rendered classifier is
 * a periodic degraded probe, so it expires fast and must be refreshed to count.
 * `unknown` never expires (it is the fail-closed floor, always "fresh").
 */
export const SOURCE_TTL_MS: Readonly<Record<Source, number>> = Object.freeze({
  'typed-hook': 45_000,
  'native-fsm': 45_000,
  'worker-rendered': 8_000,
  unknown: Number.POSITIVE_INFINITY
});

/**
 * A control event that has PASSED the generation fence and been stamped with a
 * durable, per-(session,source) monotonic `sourceSeq` by the daemon intake
 * (§6.3/§6.5). `eventId = (sessionId, generation, source, sourceSeq)` is the
 * downstream ordering + dedupe key; it is derivable from the fields and also
 * carried pre-joined in `eventId` for convenience.
 */
export interface AcceptedEvent {
  sessionId: string;
  generation: number;
  source: Source;
  sourceSeq: number;
  /** Stable per-POST id, identical across retries — the intake dedupe key (§6.5). */
  invocationId: string;
  state: ControlState;
  /** Wall-clock ms when the intake accepted it (freshness is measured from here). */
  ts: number;
  /** Pre-joined `${sessionId}:${generation}:${source}:${sourceSeq}` (§6.3). */
  eventId: string;
}

/** Join the four identity fields into the canonical eventId string (§6.3). */
export function makeEventId(sessionId: string, generation: number, source: Source, sourceSeq: number): string {
  return `${sessionId}:${generation}:${source}:${sourceSeq}`;
}

/** The latest contribution retained for one source within the current generation. */
export interface SourceContribution {
  source: Source;
  state: ControlState;
  sourceSeq: number;
  /** ts of the event that set this contribution — freshness is `ts + TTL`. */
  ts: number;
}

/**
 * The resolved per-session model (§6.1). `source` is the winning source at the
 * last resolution; `state` is `unknown` only when NO source is fresh (§6.4).
 */
export interface SessionModel {
  sessionId: string;
  generation: number;
  state: ControlState;
  source: Source;
  /** When `state` last CHANGED (not merely re-observed). */
  stateSince: number;
  /** When the session last became idle, or undefined if not currently idle. */
  idleSince?: number;
  /** Latest retained contribution per source, within `generation`. */
  contributions: Map<Source, SourceContribution>;
}

/**
 * Resolve the effective state from the retained contributions at time `now`
 * (§6.2 precedence + §6.4 staleness-drop). A source whose contribution is stale
 * (`ts + TTL <= now`) is dropped from consideration entirely — NOT replaced with
 * `unknown` — so a fresh lower-precedence source outranks a stale higher one.
 * Returns `unknown`/`unknown` only when every contribution is stale (or none
 * exist): the fail-closed floor (R2 — never sticky-`working`).
 */
export function resolveState(
  contributions: ReadonlyMap<Source, SourceContribution>,
  now: number
): { state: ControlState; source: Source } {
  let best: SourceContribution | undefined;
  for (const c of contributions.values()) {
    const ttl = SOURCE_TTL_MS[c.source];
    const fresh = ttl === Number.POSITIVE_INFINITY || c.ts + ttl > now;
    if (!fresh) continue; // §6.4 — drop, do not mask
    if (best === undefined || SOURCE_RANK[c.source] > SOURCE_RANK[best.source]) {
      best = c;
    }
  }
  if (best === undefined) return { state: 'unknown', source: 'unknown' };
  return { state: best.state, source: best.source };
}
