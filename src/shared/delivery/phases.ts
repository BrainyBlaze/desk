// Delivery-phase engine (spec §6.10, H1: accepted != delivered). Pure module.
//
// The old durability model (src/server/channelsDurability.ts) marked a prompt
// `.delivered` when "paste landed AND pane went working" — conflating transport
// acceptance with the semantic proof of submission. This engine SEPARATES them:
// transport phases (body-accepted, submit-accepted) come from COMMAND ACKs /
// native command-results; the terminal `submit-confirmed` requires SEMANTIC
// evidence (a typed hook echoing the txnId, or — weaker — the pane going
// working within the post-submit window). Native and terminal share this phase
// model and differ only in the transport + confirmation adapter.

/**
 * Durable per-delivery phase (§6.10).
 *  - queued            — enqueued, nothing sent.
 *  - body-accepted     — the body step landed (COMMAND step=body ACK / native
 *                        command-result); NOT yet submitted.
 *  - submit-accepted   — the submit step (the Enter) landed at the transport;
 *                        still NOT proof the agent accepted it.
 *  - submit-confirmed  — SEMANTIC proof: a marked hook echoed the txnId, or the
 *                        pane went working within the window (terminal); native
 *                        = AgentSurface accepted-result.
 *  - done              — confirmed and retired (producer acked).
 *  - semantic-unknown  — submit-accepted but no semantic evidence in the window;
 *                        HELD (fail-closed) within the retry horizon, never
 *                        auto-confirmed.
 *  - stuck             — a terminal failure classification.
 */
export type DeliveryPhase =
  | 'queued'
  | 'body-accepted'
  | 'submit-accepted'
  | 'submit-confirmed'
  | 'done'
  | 'semantic-unknown'
  | 'stuck';

export type StuckReason =
  | 'body-rejected'
  | 'submit-rejected'
  | 'semantic-horizon-exhausted'
  | 'transport-failed';

/**
 * The durable transaction tuple (§6.10). `bodyKey`/`submitKey` are the CMD_CACHE
 * step keys a retry re-sends verbatim (idempotent by key within the retained
 * generation). `txnId` is embedded in the delivered prompt as the semantic
 * correlation marker.
 */
export interface DeliveryTxn {
  txnId: string;
  sessionId: string;
  generation: number;
  bodyKey: string;
  submitKey: string;
  phase: DeliveryPhase;
  stuckReason?: StuckReason;
  /** When the txn entered its current phase (drives the semantic window + stuck timers). */
  phaseSince: number;
}

/**
 * Phase inputs. A `confirm` carries `marked`:
 *  - marked=true  — a typed hook ECHOED our txnId: authoritative proof the whole
 *    prompt was delivered, so it confirms from ANY pre-terminal phase (even if
 *    the transport ACKs were lost).
 *  - marked=false — pane-went-working, an UNMARKED observation: it may be about a
 *    different prompt under concurrency, so it confirms ONLY from submit-accepted
 *    (we know we just submitted) and NEVER rescues a semantic-unknown (§6.10
 *    fail-closed: a hook that omits/mis-correlates the marker leaves the txn
 *    held, never auto-confirmed).
 */
export type DeliveryInput =
  | { kind: 'body-ack' }
  | { kind: 'submit-ack' }
  | { kind: 'confirm'; marked: boolean }
  | { kind: 'semantic-window-elapsed' }
  | { kind: 'finalize' }
  | { kind: 'fail'; reason: StuckReason };

export interface DeliveryResult {
  txn: DeliveryTxn;
  changed: boolean;
}

const PRE_CONFIRM: ReadonlySet<DeliveryPhase> = new Set([
  'queued',
  'body-accepted',
  'submit-accepted',
  'semantic-unknown'
]);

/**
 * Apply one input to a txn (pure — mutates and returns it, with `changed`).
 * Illegal / no-op transitions leave the phase untouched and `changed=false`, so
 * a duplicate ACK or an out-of-order event is safely absorbed (the whole engine
 * is idempotent, mirroring the old rename-based durability).
 */
export function applyDelivery(txn: DeliveryTxn, input: DeliveryInput, now: number): DeliveryResult {
  const from = txn.phase;
  const to = nextPhase(txn, input);
  if (to === undefined || to === from) return { txn, changed: false };
  txn.phase = to;
  txn.phaseSince = now;
  txn.stuckReason = input.kind === 'fail' ? input.reason : to === 'stuck' ? txn.stuckReason : undefined;
  return { txn, changed: true };
}

function nextPhase(txn: DeliveryTxn, input: DeliveryInput): DeliveryPhase | undefined {
  const p = txn.phase;
  if (p === 'done' || p === 'stuck') return undefined; // terminal
  switch (input.kind) {
    case 'body-ack':
      return p === 'queued' ? 'body-accepted' : undefined;
    case 'submit-ack':
      // submit only advances from body-accepted; if we already have semantic
      // proof (later phases) it is redundant.
      return p === 'body-accepted' ? 'submit-accepted' : undefined;
    case 'confirm':
      if (input.marked) return PRE_CONFIRM.has(p) ? 'submit-confirmed' : undefined;
      // unmarked: only from submit-accepted (never rescues semantic-unknown)
      return p === 'submit-accepted' ? 'submit-confirmed' : undefined;
    case 'semantic-window-elapsed':
      return p === 'submit-accepted' ? 'semantic-unknown' : undefined;
    case 'finalize':
      return p === 'submit-confirmed' ? 'done' : undefined;
    case 'fail':
      return 'stuck';
  }
}

/** True once the txn has reached a terminal phase (done or stuck). */
export function isTerminal(phase: DeliveryPhase): boolean {
  return phase === 'done' || phase === 'stuck';
}

/**
 * Recover a txn's next transport action after a crash (§6.10). The persisted
 * phase alone determines what to re-issue; the actual send is deduped by
 * CMD_CACHE step key (see cmdCache.ts), so re-issuing is safe.
 *  - queued            → send the body step (bodyKey)
 *  - body-accepted     → re-issue the submit step (submitKey)
 *  - submit-accepted   → await/re-derive semantic confirmation (no re-send)
 *  - semantic-unknown  → await confirmation within the horizon (no re-send)
 *  - submit-confirmed  → finalize
 *  - done / stuck      → nothing
 */
export function recoverAction(
  phase: DeliveryPhase
): 'send-body' | 'reissue-submit' | 'await-semantic' | 'finalize' | 'none' {
  switch (phase) {
    case 'queued':
      return 'send-body';
    case 'body-accepted':
      return 'reissue-submit';
    case 'submit-accepted':
    case 'semantic-unknown':
      return 'await-semantic';
    case 'submit-confirmed':
      return 'finalize';
    default:
      return 'none';
  }
}
