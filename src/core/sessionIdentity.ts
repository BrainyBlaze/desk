// Product-side glue for the §10 manifest transform (cutover Phase 2, Step 1).
// Bridges the product's DeskManifest to the pure, layering-clean migration
// transform in src/shared/migration: flatten the manifest's sessions to the
// transform's structural entries, preserve or mint identities, and
// (round-trip) apply the sessionIds back onto a new manifest.
//
// Pure and non-mutating — returns new objects, never touches the live store.
// The store read/write that consumes this is the gated Phase 2/3 work; this only
// decides the identities. The flatten and apply MUST traverse in the identical
// order so entry[i] corresponds to the i-th session in both directions.

import type { DeskGroup, DeskManifest, DeskProject, DeskSession, DeskSettings } from './types.js';
import { migrateManifestSessions, type LegacySessionEntry, type ManifestMigration } from '../shared/migration/index.js';

export type LegacyDeskSession = Omit<DeskSession, 'sessionId'> & {
  sessionId?: string;
  /** Migration-only source key; runtime manifests reject it. */
  tmuxSession?: string;
};
export type LegacyDeskGroup = Omit<DeskGroup, 'sessions'> & { sessions: LegacyDeskSession[] };
export type LegacyDeskProject = Omit<DeskProject, 'groups'> & { groups: LegacyDeskGroup[] };
export interface LegacyDeskManifest {
  settings?: DeskSettings;
  groups: LegacyDeskGroup[];
  projects?: LegacyDeskProject[];
}

/** Canonical session traversal: top-level groups in order, then projects in order. */
export function collectSessions(manifest: DeskManifest): DeskSession[];
export function collectSessions(manifest: LegacyDeskManifest): LegacyDeskSession[];
export function collectSessions(manifest: LegacyDeskManifest): LegacyDeskSession[] {
  const out: LegacyDeskSession[] = [];
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
export function deskManifestToEntries(manifest: LegacyDeskManifest): LegacySessionEntry[] {
  return collectSessions(manifest).map((session) => {
    const entry: LegacySessionEntry = { name: session.name };
    if (session.sessionId !== undefined) {
      entry.sessionId = session.sessionId;
    }
    if (session.tmuxSession !== undefined) {
      entry.tmuxSession = session.tmuxSession;
    }
    return entry;
  });
}

/** Preserve or mint §10 identities, yielding ids + the tmux→sessionId map. */
export function buildManifestMigration(manifest: LegacyDeskManifest): ManifestMigration {
  return migrateManifestSessions(deskManifestToEntries(manifest));
}

/**
 * Return a NEW manifest with each session's `sessionId` populated from the
 * migration, assigning ids in the SAME traversal order as deskManifestToEntries
 * so migration.entries[i] lines up with the i-th session. Non-mutating.
 */
export function applyMigratedSessionIds(manifest: LegacyDeskManifest, migration: ManifestMigration): DeskManifest {
  // Fail closed: a cardinality mismatch means the migration was not built from
  // THIS manifest, so applying it would silently write sessionId: undefined onto
  // the tail sessions. Refuse to partially apply a cutover identity transform.
  const count = collectSessions(manifest).length;
  if (migration.entries.length !== count) {
    throw new Error(`§10 apply: migration has ${migration.entries.length} entries but the manifest has ${count} sessions; refusing to partially apply`);
  }
  let i = 0;
  const withId = (session: LegacyDeskSession): DeskSession => {
    const { tmuxSession: _legacyIdentity, ...runtimeSession } = session;
    return { ...runtimeSession, sessionId: migration.entries[i++].sessionId };
  };
  const mapGroup = (group: LegacyDeskGroup): DeskGroup => ({ ...group, sessions: group.sessions.map(withId) });
  const mapProject = (project: LegacyDeskProject): DeskProject => ({ ...project, groups: project.groups.map(mapGroup) });
  return {
    ...(manifest.settings !== undefined ? { settings: manifest.settings } : {}),
    groups: manifest.groups.map(mapGroup),
    ...(manifest.projects !== undefined ? { projects: manifest.projects.map(mapProject) } : {})
  };
}
