// Recovery & durability trust-state (spec §8.2, C4). Pure module. Tracks whether
// a session's terminal state is exact along TWO INDEPENDENT axes plus per-buffer
// provenance, and the sticky recovery_lost flag that clears only via a real
// re-establishment oracle. These MUST NOT be collapsed into one enum (§8.2):
// each answers a different question and they move independently.

export type TerminalBuffer = 'main' | 'alt';

/**
 * Re-establishment oracles (§8.2). Only an oracle that covers the HIDDEN state
 * (tab-stops / charsets / saved-cursor / modes) restores trust — a visual
 * repaint does not.
 */
export type ReestablishOracle =
  // VALID — cover hidden state:
  | 'ris-reset' // ESC c / RIS then the app re-establishes the buffer
  | 'app-snapshot' // an application-declared exact snapshot
  | 'process-restart' // terminal + process start clean together
  | 'fresh-exact-checkpoint' // kind-0 checkpoint from a CONTINUOUSLY-authoritative worker
  // INVALID — do NOT re-establish:
  | 'later-checkpoint' // checkpoint of an already-incomplete buffer preserves the gap
  | 'resize' // SIGWINCH does not certify a complete redraw
  | 'alt-cycle' // alt enter/exit restores the previously-incomplete MAIN
  | 'visual-repaint'; // "full rendering" is not a falsifiable oracle

const VALID_ORACLES: ReadonlySet<ReestablishOracle> = new Set(['ris-reset', 'app-snapshot', 'process-restart', 'fresh-exact-checkpoint']);

export interface RecoveryState {
  /** Axis (i): is the LIVE worker emulator state exact right now? Only
   *  EMULATOR-STATE loss makes this false — NOT journal retention truncation. */
  currentStateExact: boolean;
  /** Axis (ii): can an exact state be REBUILT after a restart? Journal-retention
   *  truncation makes this false even while (i) is still true. */
  restartRecoverable: boolean;
  /** Axis (iii): per-buffer provenance — main and alt tracked separately. */
  bufferExact: Record<TerminalBuffer, boolean>;
  /** Sticky, persisted (§4.8 recovery_state): surfaced in ATTACH_ACK + GAP so a
   *  late attacher learns the session is degraded; clears only on a validated
   *  re-establishment. Never fabricated/partial-presented. */
  recoveryLost: boolean;
}

/** A pristine, fully-trusted session. */
export function createRecoveryState(): RecoveryState {
  return {
    currentStateExact: true,
    restartRecoverable: true,
    bufferExact: { main: true, alt: true },
    recoveryLost: false
  };
}

/**
 * Journal-retention truncation while the worker is ALIVE (§8.2): the live
 * emulator kept processing exactly, so current_state_exact and the screen stay
 * trusted — only future restart-recovery is lost.
 */
export function onRetentionTruncation(s: RecoveryState): RecoveryState {
  s.restartRecoverable = false;
  // current_state_exact, bufferExact, recoveryLost UNCHANGED — screen is fine.
  return s;
}

/**
 * Emulator-state loss (§8.2): the worker crashed mid-stream and could not be
 * exactly restored. The current state is now unknown → not exact + recovery_lost.
 */
export function onEmulatorLoss(s: RecoveryState): RecoveryState {
  s.currentStateExact = false;
  s.recoveryLost = true;
  return s;
}

/**
 * Restoring from a TRUNCATED journal after emulator-state loss (§8.2): a retained
 * tail may start mid-sequence, which the byte-opaque master cannot fence to VT
 * ground — so that buffer must NOT be rendered as current. Mark THAT buffer
 * inexact; the agent stays live, "current" is held unknown until re-established.
 */
export function onTruncatedRestore(s: RecoveryState, buffer: TerminalBuffer): RecoveryState {
  s.bufferExact[buffer] = false;
  s.recoveryLost = true;
  return s;
}

/**
 * Attempt to re-establish a buffer's trust (§8.2). Only a VALID oracle clears
 * it. `alt-cycle` never re-establishes `main` (exit restores the previously
 * incomplete main). Recovery_lost clears only when BOTH buffers are exact again;
 * current_state_exact is restored with the active buffer's trust.
 */
export function reestablish(
  s: RecoveryState,
  buffer: TerminalBuffer,
  oracle: ReestablishOracle
): { ok: boolean; reason: string } {
  if (!VALID_ORACLES.has(oracle)) {
    return { ok: false, reason: `${oracle} does not cover hidden state — not a valid oracle` };
  }
  s.bufferExact[buffer] = true;
  if (oracle === 'process-restart') {
    // a clean restart re-establishes everything
    s.bufferExact.main = true;
    s.bufferExact.alt = true;
    s.currentStateExact = true;
    s.restartRecoverable = true;
  }
  if (s.bufferExact.main && s.bufferExact.alt) {
    s.recoveryLost = false;
    s.currentStateExact = true;
  }
  return { ok: true, reason: `re-established ${buffer} via ${oracle}` };
}

/**
 * DISPLAY / attach drives off axes (i)+(iii) (§8.2): a surface may show the
 * ACTIVE buffer as exact only when the live state is exact AND that buffer's
 * provenance is exact.
 */
export function canDisplayExact(s: RecoveryState, activeBuffer: TerminalBuffer): boolean {
  return s.currentStateExact && s.bufferExact[activeBuffer];
}

/**
 * Takeover / restart-planning drives off axis (ii) (§8.2): an exact state can be
 * rebuilt after a restart only when the journal was not retention-truncated.
 */
export function canRebuildAfterRestart(s: RecoveryState): boolean {
  return s.restartRecoverable;
}
