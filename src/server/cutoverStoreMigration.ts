// Cutover store-migration executors (cutover Phase 2, Step 2). Re-key the
// engine's on-disk stores from the legacy tmuxSession to the atch-native
// sessionId, driving the pure §10 transforms over real files.
//
// Canary-safe by construction: every executor takes an explicit sourceRoot
// (read ONLY) and a distinct targetRoot (written), so it never mutates the live
// store — the canary points source at the live data root and target at its
// isolated data root. Pointing target at the live root is possible but is the
// gated Phase 5 commit, never done here.

import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsOps.js';
import { migratePausedStore, type LegacyPausedEntry, type MigratedPausedEntry } from '../shared/migration/index.js';

/** Version 2 = the sessionId-keyed paused store (version 1 was tmuxSession-keyed). */
const PAUSED_STORE_VERSION = 2;

export interface PausedMigrationReport {
  migrated: MigratedPausedEntry[];
  /** Paused entries whose tmuxSession has no sessionId in the map — reported, not silently lost. */
  dropped: LegacyPausedEntry[];
}

/**
 * Migrate the operator-pause store (`<root>/_engine/paused.json`) from the legacy
 * tmuxSession key to sessionId via the manifest's tmuxSession→sessionId map,
 * reading from sourceRoot and writing the version-2 store to targetRoot. A
 * missing source store migrates to an empty target; a malformed source store
 * throws (fail-closed — never silently drop live operator pauses).
 */
export function migratePausedStoreFile(sourceRoot: string, targetRoot: string, tmuxToSessionId: ReadonlyMap<string, string>): PausedMigrationReport {
  const legacy = readLegacyPaused(join(sourceRoot, '_engine', 'paused.json'));
  const result = migratePausedStore(legacy, tmuxToSessionId);
  const targetDir = join(targetRoot, '_engine');
  mkdirSync(targetDir, { recursive: true });
  writeFileAtomic(join(targetDir, 'paused.json'), `${JSON.stringify({ version: PAUSED_STORE_VERSION, items: result.items }, null, 2)}\n`);
  return { migrated: result.items, dropped: result.dropped };
}

/** Read the legacy (version-1, tmuxSession-keyed) paused store as transform entries. */
function readLegacyPaused(path: string): LegacyPausedEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown };
  if (!Array.isArray(parsed.items)) {
    throw new Error(`cutover: malformed paused store at ${path} — refusing to migrate (fail-closed)`);
  }
  return parsed.items.map((raw) => {
    const item = raw as { tmuxSession?: unknown; pausedAt?: unknown; reason?: unknown };
    if (typeof item.tmuxSession !== 'string' || typeof item.pausedAt !== 'string') {
      throw new Error(`cutover: malformed paused entry in ${path} — refusing to migrate (fail-closed)`);
    }
    const entry: LegacyPausedEntry = { tmuxSession: item.tmuxSession, pausedAt: item.pausedAt };
    if (typeof item.reason === 'string') {
      entry.reason = item.reason;
    }
    return entry;
  });
}
