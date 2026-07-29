// Durable generation / tombstone ledger (spec §4.8.1, H8). Pure logic over a
// durable append-only PORT; the daemon owns the fsync'd file (long-lived,
// per-user), which `rm` NEVER deletes. This is the source of truth for the
// §6.3 generation fence's `currentGeneration`.
//
// Why it must be separate from the per-session registry file: the registry holds
// the CURRENT generation, but `rm <session>` removes it (§11.2). If generation
// lived only there, reusing the same sessionId would RESET it to 1 — and a
// delayed OLD hook carrying generation=1 would then pass the fence against the
// NEW session. The ledger keeps a per-sessionId TOMBSTONE (the last-allocated
// generation) that survives deletion, so a recreated session always gets
// max(ever_seen)+1 and a generation is never reissued.

/** The durable backing the daemon fsyncs (append-only file). */
export interface GenerationLedgerStore {
  /** Last generation ever allocated for this sessionId, tombstone-inclusive; 0 if never. */
  read(sessionId: string): number;
  /** Persist (append + fsync) the new last-allocated generation. */
  write(sessionId: string, generation: number): void;
}

export class GenerationLedger {
  constructor(private readonly store: GenerationLedgerStore) {}

  /**
   * Allocate the next generation for a (possibly-reused) sessionId: max+1,
   * strictly monotonic, tombstone-surviving. The daemon MUST fsync this (inside
   * `store.write`) BEFORE it writes the master's registry file and BEFORE it
   * spawns any child — so a crash never reissues a generation (§4.8.1).
   */
  allocate(sessionId: string): number {
    const next = this.store.read(sessionId) + 1;
    this.store.write(sessionId, next);
    return next;
  }

  /** The current (last-allocated) generation — what the §6.3 fence compares against. */
  current(sessionId: string): number {
    return this.store.read(sessionId);
  }
}

/**
 * In-memory reference ledger — the executable spec for §4.8.1. NEVER deletes an
 * entry (that IS the tombstone), and NEVER lowers a recorded max (compaction
 * must not reissue a generation). Session deletion removes the registry
 * elsewhere but leaves this entry intact.
 */
export class InMemoryGenerationLedger implements GenerationLedgerStore {
  private ledger = new Map<string, number>();

  read(sessionId: string): number {
    return this.ledger.get(sessionId) ?? 0;
  }

  write(sessionId: string, generation: number): void {
    const prev = this.ledger.get(sessionId) ?? 0;
    // Monotonic guard: a write may only RAISE the recorded max (compaction and
    // replay must never lower it, else a generation could be reissued).
    if (generation <= prev) return;
    this.ledger.set(sessionId, generation);
  }

  /**
   * Session deletion (§11.2): the registry file is removed elsewhere; the ledger
   * entry is DELIBERATELY retained as the tombstone. Present for documentation —
   * it is intentionally a no-op on the ledger value.
   */
  tombstoneOnDelete(_sessionId: string): void {
    // no-op: the entry stays so a recreated session gets max+1.
  }
}
