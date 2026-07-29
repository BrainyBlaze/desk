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

import type { AgentProfile, DeskGroup, DeskManifest, DeskProject, DeskSession, DeskSettings } from './types.js';
import { migrateManifestSessions, type LegacySessionEntry, type ManifestMigration } from '../shared/migration/index.js';

const LEGACY_DEFAULT_NAMESPACE = 'agentdesk';

export interface LegacyIdentityOptions {
  /** Home directory used by the v0.3.1 `~` expansion and root-session fallback. */
  homeDir?: string;
  /** v0.3.1 runtime namespace. Desk's shipped/default namespace was `agentdesk`. */
  namespace?: string;
}

export type LegacyDeskSession = Omit<DeskSession, 'sessionId'> & {
  sessionId?: string;
  /** Migration-only source key; runtime manifests reject it. */
  tmuxSession?: string;
};
export type LegacyDeskGroup = Omit<DeskGroup, 'sessions'> & { sessions: LegacyDeskSession[] };
export type LegacyDeskProject = Omit<DeskProject, 'groups'> & { groups: LegacyDeskGroup[] };
export interface LegacyDeskManifest {
  settings?: DeskSettings;
  /**
   * Profiles are NOT part of the identity migration — they carry no
   * sessionId — but they must survive it. The type carries them so the
   * reconstruction below cannot silently drop the key.
   */
  profiles?: AgentProfile[];
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
export function deskManifestToEntries(
  manifest: LegacyDeskManifest,
  options: LegacyIdentityOptions = {}
): LegacySessionEntry[] {
  const namespace = options.namespace ?? LEGACY_DEFAULT_NAMESPACE;
  const homeDir = options.homeDir ?? '';
  const entries: LegacySessionEntry[] = [];
  const append = (
    session: LegacyDeskSession,
    pathParts: readonly string[],
    inheritedCwd: string
  ): void => {
    const cwd = expandLegacyHome(session.cwd ?? inheritedCwd, homeDir);
    const entry: LegacySessionEntry = { name: session.name };
    if (session.sessionId !== undefined) {
      entry.sessionId = session.sessionId;
    }
    entry.tmuxSession =
      session.tmuxSession ??
      [
        namespace,
        ...pathParts.map(slugPart),
        slugPart(session.name),
        session.resume
          ? session.resume.slice(0, 8)
          : shortHash(legacySessionHashSeed(session, cwd))
      ]
        .filter(Boolean)
        .join('-');
    entries.push(entry);
  };

  for (const group of manifest.groups) {
    for (const session of group.sessions) {
      append(session, [group.id], homeDir);
    }
  }
  for (const project of manifest.projects ?? []) {
    for (const group of project.groups) {
      for (const session of group.sessions) {
        append(session, [project.id, group.id], project.cwd);
      }
    }
  }
  return entries;
}

/** Preserve or mint §10 identities, yielding ids + the tmux→sessionId map. */
export function buildManifestMigration(
  manifest: LegacyDeskManifest,
  options: LegacyIdentityOptions = {}
): ManifestMigration {
  return migrateManifestSessions(deskManifestToEntries(manifest, options));
}

function expandLegacyHome(path: string, homeDir: string): string {
  if (path === '~') {
    return homeDir;
  }
  if (path.startsWith('~/')) {
    return `${homeDir}${path.slice(1)}`;
  }
  return path;
}

function legacySessionHashSeed(session: LegacyDeskSession, cwd: string): string {
  if (session.command) {
    return session.command;
  }
  return [
    session.agent ?? 'command',
    session.name,
    cwd,
    session.bypassPermissions === false ? 'ask' : 'allow'
  ].join('|');
}

function slugPart(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
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
  // Every top-level key the manifest carries must be reconstructed here:
  // this function REPLACES the manifest, so an omitted key is silent data
  // loss on the next write (profiles were lost exactly this way).
  return {
    ...(manifest.settings !== undefined ? { settings: manifest.settings } : {}),
    ...(manifest.profiles !== undefined ? { profiles: manifest.profiles } : {}),
    groups: manifest.groups.map(mapGroup),
    ...(manifest.projects !== undefined ? { projects: manifest.projects.map(mapProject) } : {})
  };
}
