// Product-side glue for the §10 manifest transform (cutover Phase 2, Step 1).
// Bridges the product's DeskManifest to the pure, layering-clean migration
// transform in src/shared/migration: flatten the manifest's sessions to the
// transform's structural entries, run the mint, and (round-trip) apply the
// minted sessionIds back onto a new manifest.
//
// Pure and non-mutating — returns new objects, never touches the live store.
// The store read/write that consumes this is the gated Phase 2/3 work; this only
// decides the identities. The flatten and apply MUST traverse in the identical
// order so entry[i] corresponds to the i-th session in both directions.

import type { DeskGroup, DeskManifest, DeskProject, DeskSession } from './types.js';
import { migrateManifestSessions, type LegacySessionEntry, type ManifestMigration } from '../shared/migration/index.js';

/** Canonical session traversal: top-level groups in order, then projects in order. */
function collectSessions(manifest: DeskManifest): DeskSession[] {
  const out: DeskSession[] = [];
  for (const group of manifest.groups) {
    out.push(...group.sessions);
  }
  for (const project of manifest.projects ?? []) {
    for (const group of project.groups) {
      out.push(...group.sessions);
    }
  }
  return out;
}

/** Flatten the manifest's sessions to the migration transform's structural entries. */
export function deskManifestToEntries(manifest: DeskManifest): LegacySessionEntry[] {
  return collectSessions(manifest).map((session) => {
    const entry: LegacySessionEntry = { name: session.name };
    if (session.tmuxSession !== undefined) {
      entry.tmuxSession = session.tmuxSession;
    }
    return entry;
  });
}

/** Run the §10 manifest mint over the product manifest, yielding ids + the tmux→sessionId map. */
export function buildManifestMigration(manifest: DeskManifest): ManifestMigration {
  return migrateManifestSessions(deskManifestToEntries(manifest));
}

/**
 * Return a NEW manifest with each session's `sessionId` populated from the
 * migration, assigning ids in the SAME traversal order as deskManifestToEntries
 * so migration.entries[i] lines up with the i-th session. Non-mutating.
 */
export function applyMigratedSessionIds(manifest: DeskManifest, migration: ManifestMigration): DeskManifest {
  // Fail closed: a cardinality mismatch means the migration was not built from
  // THIS manifest, so applying it would silently write sessionId: undefined onto
  // the tail sessions. Refuse to partially apply a cutover identity transform.
  const count = collectSessions(manifest).length;
  if (migration.entries.length !== count) {
    throw new Error(`§10 apply: migration has ${migration.entries.length} entries but the manifest has ${count} sessions; refusing to partially apply`);
  }
  let i = 0;
  const withId = (session: DeskSession): DeskSession => ({ ...session, sessionId: migration.entries[i++].sessionId });
  const mapGroup = (group: DeskGroup): DeskGroup => ({ ...group, sessions: group.sessions.map(withId) });
  const mapProject = (project: DeskProject): DeskProject => ({ ...project, groups: project.groups.map(mapGroup) });
  return {
    ...manifest,
    groups: manifest.groups.map(mapGroup),
    ...(manifest.projects !== undefined ? { projects: manifest.projects.map(mapProject) } : {})
  };
}
