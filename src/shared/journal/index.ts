// Journal read/replay (spec §4.9, §7.4). Pure src/shared read-side; the atch C
// fork owns the journal WRITE (segment format), the daemon owns replay for
// recovery (§8.1) and history (§7.4).
export * from './journalReplay.js';
