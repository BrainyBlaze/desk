// Identity migration — the journaled multi-phase FSM (spec §10). Pure. The
// migration is NOT one atomic commit across FS stores + browser localStorage;
// it is a sequence of journaled, crash-resumable phases. Each phase is designed
// idempotent, so resume-after-crash re-runs the last-journaled phase safely.

export type MigrationPhase = 'quiesce' | 'backup' | 'transform' | 'validate' | 'commit' | 'done' | 'aborted';

/** The forward order (§10 steps 1–5, then done). */
export const MIGRATION_ORDER: readonly MigrationPhase[] = ['quiesce', 'backup', 'transform', 'validate', 'commit', 'done'];

export type Rollback = 'none' | 'unquiesce' | 'restore-backup';

/**
 * Advance from the current phase on success, or abort on failure. Abort carries
 * the rollback needed to leave the runtime consistent: before a backup exists,
 * failure just resumes delivery (`unquiesce`); once a backup exists, failure
 * restores it (`restore-backup`). `done`/`aborted` are terminal.
 */
export function advanceMigration(
  cur: MigrationPhase,
  result: 'ok' | 'fail'
): { next: MigrationPhase; rollback: Rollback } {
  if (cur === 'done' || cur === 'aborted') return { next: cur, rollback: 'none' };
  if (result === 'fail') return { next: 'aborted', rollback: rollbackFor(cur) };
  const idx = MIGRATION_ORDER.indexOf(cur);
  return { next: MIGRATION_ORDER[idx + 1], rollback: 'none' };
}

function rollbackFor(cur: MigrationPhase): Rollback {
  switch (cur) {
    case 'quiesce':
    case 'backup':
      return 'unquiesce'; // no durable transform yet — just resume delivery
    case 'transform':
    case 'validate':
    case 'commit':
      return 'restore-backup'; // a backup exists; restore it to undo partial work
    default:
      return 'none';
  }
}

/**
 * Resume after a crash: re-run the last-journaled phase (each phase is
 * idempotent). A migration journaled at `done`/`aborted` is already terminal.
 */
export function resumeMigration(journaledPhase: MigrationPhase): { rerun: MigrationPhase; terminal: boolean } {
  const terminal = journaledPhase === 'done' || journaledPhase === 'aborted';
  return { rerun: journaledPhase, terminal };
}

/**
 * The browser localStorage half (§10 step 6) is NOT part of the server FS
 * migration — it is a schema negotiation on load: a client seeing the new schema
 * migrates-on-read or clears+re-derives; the runtime REJECTS the old key
 * (step 7). This helper models that client-side decision.
 */
export function negotiateClientSchema(
  clientSchema: number,
  runtimeSchema: number
): 'ok' | 'migrate-on-read' | 'clear-and-rederive' {
  if (clientSchema === runtimeSchema) return 'ok';
  if (clientSchema === runtimeSchema - 1) return 'migrate-on-read'; // one behind → transform
  return 'clear-and-rederive'; // older/unknown → drop local state, re-derive from server
}
