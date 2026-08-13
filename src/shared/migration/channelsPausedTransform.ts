// Channels operator-pause store transform (spec §10). Re-keys the paused-sessions
// store (channelsPaused.ts, <home>/_engine/paused.json) from the legacy
// tmuxSession to the daemon-native sessionId via the canonical tmuxSession→sessionId
// map the manifest transform mints.
//
// Pure + structural (no src/server import): the product adapter reads/writes the
// JSON store; this decides the re-key and REPORTS entries whose tmuxSession has
// no sessionId, so a live operator pause on a session that vanished from the
// manifest surfaces rather than being silently dropped.

/** A paused entry as stored today (keyed by tmuxSession). */
export interface LegacyPausedEntry {
  tmuxSession: string;
  pausedAt: string;
  reason?: string;
}

/** The migrated entry, keyed by sessionId. */
export interface MigratedPausedEntry {
  sessionId: string;
  pausedAt: string;
  reason?: string;
}

export interface PausedStoreMigration {
  items: MigratedPausedEntry[];
  /** Paused entries whose tmuxSession has no sessionId (session gone from the manifest). */
  dropped: LegacyPausedEntry[];
}

/** Re-key the paused store; an unmapped tmuxSession is reported, never silently lost. */
export function migratePausedStore(
  items: readonly LegacyPausedEntry[],
  tmuxToSessionId: ReadonlyMap<string, string>
): PausedStoreMigration {
  const migrated: MigratedPausedEntry[] = [];
  const dropped: LegacyPausedEntry[] = [];
  for (const item of items) {
    const sessionId = tmuxToSessionId.get(item.tmuxSession);
    if (sessionId === undefined) {
      dropped.push(item);
      continue;
    }
    const out: MigratedPausedEntry = { sessionId, pausedAt: item.pausedAt };
    if (item.reason !== undefined) {
      out.reason = item.reason;
    }
    migrated.push(out);
  }
  return { items: migrated, dropped };
}
