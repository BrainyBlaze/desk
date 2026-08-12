// Manifest session-identity transform (spec §10, phase 3 transform + phase 4
// validate). Re-keys a session manifest from the legacy tmux identity to the
// daemon-native sessionId, preserving an existing durable identity or minting a
// grammar-valid, globally-unique sessionId for a legacy session, and emitting
// the canonical tmuxSession→sessionId map that every other
// §10 store transform (channelsPaused, resume state, AgentSurface) re-keys
// against.
//
// Pure and layering-clean: it takes a STRUCTURAL legacy entry, never the
// product's DeskManifest (src/shared must not depend on src/core). The product
// adapter that flattens DeskManifest → entries and re-nests the migrated ids is
// the gated cutover glue and lives in the product layer, not here.
//
// Deterministic in entry order, so a resumed `transform` phase re-run over the
// restored backup preserves or mints byte-identical ids (§10 resumable phase
// FSM).

import { checkGlobalUniqueness, isValidSessionId, mintSessionId } from './sessionId.js';

/** A session as the transform needs it: name, optional durable id, and optional tmux identity. */
export interface LegacySessionEntry {
  /** Human name; the mint source for the sessionId. */
  name: string;
  /** Durable identity to preserve; absent on a legacy manifest entry. */
  sessionId?: string;
  /** Legacy tmux identity; when present it becomes a re-key map entry. */
  tmuxSession?: string;
}

/** A migrated session: its durable sessionId plus the tmux identity it came from (if any). */
export interface MigratedSessionEntry {
  name: string;
  sessionId: string;
  /** The legacy tmuxSession this session migrated from, if it had one. */
  tmuxSession?: string;
}

export interface ManifestMigration {
  entries: MigratedSessionEntry[];
  /** tmuxSession → sessionId: the canonical re-key spine for the other §10 stores. */
  tmuxToSessionId: Map<string, string>;
}

export type ManifestValidation =
  | { ok: true }
  | { ok: false; reason: 'sessionid-collision'; value: string }
  | { ok: false; reason: 'sessionid-grammar'; value: string }
  | { ok: false; reason: 'duplicate-tmux-session'; value: string };

/**
 * Phase 3 — transform. Preserve each existing sessionId and mint only missing
 * ids (from the name, deduped globally so name collisions get a numeric suffix),
 * preserving the tmux identity → sessionId map. Existing ids are reserved before
 * minting so traversal order cannot steal a durable identity. Always succeeds;
 * correctness is asserted separately by validateManifestMigration so the phase
 * FSM's validate step is an explicit, fail-closed gate before commit.
 */
export function migrateManifestSessions(entries: readonly LegacySessionEntry[]): ManifestMigration {
  const taken = new Set<string>();
  for (const entry of entries) {
    if (entry.sessionId !== undefined) {
      taken.add(entry.sessionId);
    }
  }

  const migrated: MigratedSessionEntry[] = [];
  const tmuxToSessionId = new Map<string, string>();
  for (const entry of entries) {
    const sessionId = entry.sessionId ?? mintSessionId(entry.name, taken);
    if (entry.sessionId === undefined) {
      taken.add(sessionId);
    }
    const out: MigratedSessionEntry = { name: entry.name, sessionId };
    if (entry.tmuxSession !== undefined) {
      out.tmuxSession = entry.tmuxSession;
      // A duplicate legacy tmuxSession would silently collapse the map here;
      // validateManifestMigration reports it against the source entries so the
      // migration aborts before commit rather than losing a re-key.
      tmuxToSessionId.set(entry.tmuxSession, sessionId);
    }
    migrated.push(out);
  }
  return { entries: migrated, tmuxToSessionId };
}

/**
 * Phase 4 — validate (fail-closed, before commit). Rejects on any grammar
 * violation, sessionId collision, or a legacy tmuxSession that mapped to more
 * than one session (the map must be injective for the re-key to be lossless).
 * Runs against the ORIGINAL entries so tmux duplicates are caught even though
 * the transform's map deduped them.
 */
export function validateManifestMigration(entries: readonly LegacySessionEntry[], migration: ManifestMigration): ManifestValidation {
  for (const m of migration.entries) {
    if (!isValidSessionId(m.sessionId)) {
      return { ok: false, reason: 'sessionid-grammar', value: m.sessionId };
    }
  }
  const uniq = checkGlobalUniqueness(migration.entries.map((m) => m.sessionId));
  if (!uniq.ok) {
    return { ok: false, reason: 'sessionid-collision', value: uniq.duplicate };
  }
  const tmuxSeen = new Set<string>();
  for (const entry of entries) {
    if (entry.tmuxSession === undefined) {
      continue;
    }
    if (tmuxSeen.has(entry.tmuxSession)) {
      return { ok: false, reason: 'duplicate-tmux-session', value: entry.tmuxSession };
    }
    tmuxSeen.add(entry.tmuxSession);
  }
  return { ok: true };
}
