import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { buildSessionSpecs, parseDeskManifest } from './manifest.js';
import type { DeskGroup, DeskGroupLayout, DeskLayoutSizes, DeskManifest, DeskSession, SessionSpec } from './types.js';

export interface ResolveDefaultManifestPathOptions {
  homeDir?: string;
  configHome?: string;
}

export interface AddSessionOptions {
  groupId: string;
  groupLabel?: string;
  session: DeskSession;
}

export interface AddGroupOptions {
  groupId: string;
  groupLabel?: string;
  layout?: DeskGroupLayout;
}

export interface AddProjectOptions {
  projectId: string;
  projectLabel?: string;
  cwd: string;
}

export interface AddProjectGroupOptions extends AddGroupOptions {
  projectId: string;
}

export interface AddProjectSessionOptions {
  projectId: string;
  groupId: string;
  session: DeskSession;
}

export interface EditProjectOptions {
  projectId: string;
  projectLabel?: string;
  cwd: string;
  currentCwd?: string;
}

export interface DeleteProjectOptions {
  projectId: string;
  cwd?: string;
}

export interface EditProjectGroupOptions extends AddProjectGroupOptions {
  currentGroupId?: string;
  projectCwd?: string;
}

export interface DeleteProjectGroupOptions {
  projectId: string;
  groupId: string;
  projectCwd?: string;
}

export interface EditProjectSessionOptions extends AddProjectSessionOptions {
  currentName: string;
  projectCwd?: string;
}

export interface DeleteProjectSessionOptions {
  projectId: string;
  groupId: string;
  sessionName: string;
  projectCwd?: string;
}

export interface MoveProjectSessionOptions {
  sourceProjectId: string;
  sourceGroupId: string;
  sourceSessionName: string;
  sourceProjectCwd?: string;
  targetProjectId: string;
  targetGroupId: string;
  targetProjectCwd?: string;
}

export function resolveDefaultManifestPath(options: ResolveDefaultManifestPathOptions = {}): string {
  const home = options.homeDir ?? homedir();
  const configHome = options.configHome ?? `${home}/.config`;
  return `${configHome}/desk/desk.yml`;
}

export function createEmptyManifest(): DeskManifest {
  return { groups: [] };
}

export function readManifestFile(path: string): DeskManifest {
  if (!existsSync(path)) {
    return createEmptyManifest();
  }
  const source = readFileSync(path, 'utf8');
  // A blank file is corruption (e.g. an interrupted write), not a valid
  // manifest — treat it as empty so the app degrades instead of throwing on
  // every request. A real manifest is never just whitespace.
  if (source.trim() === '') {
    return createEmptyManifest();
  }
  return parseDeskManifest(source);
}

export function writeManifestFile(path: string, manifest: DeskManifest): void {
  const serialized = serializeDeskManifest(manifest);
  // Never persist an empty/whitespace payload — that would wipe the config.
  if (serialized.trim() === '') {
    throw new Error('refusing to write an empty desk manifest');
  }
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: a crash mid-write leaves the temp file, never a truncated
  // or 0-byte manifest. rename(2) is atomic on the same filesystem.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, serialized);
  renameSync(tmp, path);
}

export function serializeDeskManifest(manifest: DeskManifest): string {
  return YAML.stringify(manifest, {
    lineWidth: 100
  });
}

export function addSessionToManifest(manifest: DeskManifest, options: AddSessionOptions): DeskManifest {
  const groups = manifest.groups.map((group) => ({
    ...group,
    sessions: [...group.sessions]
  }));
  let group = groups.find((candidate) => candidate.id === options.groupId);

  if (!group) {
    group = {
      id: options.groupId,
      label: options.groupLabel,
      sessions: []
    };
    groups.push(group);
  }

  if (group.sessions.some((session) => session.name === options.session.name)) {
    throw new Error(`session ${options.session.name} already exists in group ${options.groupId}`);
  }

  group.sessions.push(options.session);
  return { ...manifest, groups };
}

export function addGroupToManifest(manifest: DeskManifest, options: AddGroupOptions): DeskManifest {
  const groups = manifest.groups.map((group) => ({
    ...group,
    sessions: [...group.sessions]
  }));

  if (groups.some((group) => group.id === options.groupId)) {
    throw new Error(`group ${options.groupId} already exists`);
  }

  const group: DeskGroup = {
    id: options.groupId,
    label: options.groupLabel,
    sessions: []
  };
  if (options.layout) {
    group.layout = options.layout;
  }
  groups.push(group);

  return { ...manifest, groups };
}

export function addProjectToManifest(manifest: DeskManifest, options: AddProjectOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  if (projects.some((project) => project.id === options.projectId)) {
    throw new Error(`project ${options.projectId} already exists`);
  }
  projects.push({
    id: options.projectId,
    label: options.projectLabel,
    cwd: options.cwd,
    groups: []
  });
  return { ...manifest, projects };
}

export function addGroupToProjectManifest(manifest: DeskManifest, options: AddProjectGroupOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (!project) {
    throw new Error(`project ${options.projectId} does not exist`);
  }
  if (project.groups.some((group) => group.id === options.groupId)) {
    throw new Error(`group ${options.groupId} already exists in project ${options.projectId}`);
  }
  project.groups.push({
    id: options.groupId,
    label: options.groupLabel,
    layout: options.layout,
    sessions: []
  });
  return { ...manifest, projects };
}

export function addSessionToProjectManifest(manifest: DeskManifest, options: AddProjectSessionOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (!project) {
    throw new Error(`project ${options.projectId} does not exist`);
  }
  const group = project.groups.find((candidate) => candidate.id === options.groupId);
  if (!group) {
    throw new Error(`group ${options.groupId} does not exist in project ${options.projectId}`);
  }
  if (group.sessions.some((session) => session.name === options.session.name)) {
    throw new Error(`session ${options.session.name} already exists in group ${options.groupId}`);
  }
  group.sessions.push(options.session);
  return { ...manifest, projects };
}

export function editProjectInManifest(manifest: DeskManifest, options: EditProjectOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    project.label = options.projectLabel;
    project.cwd = options.cwd;
    return { ...manifest, projects };
  }

  const currentCwd = options.currentCwd ?? options.cwd;
  const groups = cloneGroups(manifest);
  let updated = false;
  for (const group of groups) {
    group.sessions = group.sessions.map((session) => {
      if (!session.cwd || !cwdMatches(session.cwd, currentCwd)) {
        return session;
      }
      updated = true;
      return { ...session, cwd: options.cwd };
    });
  }
  if (!updated) {
    throw new Error(`project ${options.projectId} does not exist`);
  }
  return { ...manifest, groups, projects: manifest.projects };
}

export function deleteProjectFromManifest(manifest: DeskManifest, options: DeleteProjectOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  if (projects.some((project) => project.id === options.projectId)) {
    return { ...manifest, projects: projects.filter((project) => project.id !== options.projectId) };
  }

  if (!options.cwd) {
    throw new Error(`project ${options.projectId} does not exist`);
  }
  const groups = cloneGroups(manifest)
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) => !session.cwd || !cwdMatches(session.cwd, options.cwd!))
    }))
    .filter((group) => group.sessions.length > 0);
  return { ...manifest, groups, projects: manifest.projects };
}

export function editGroupInManifest(manifest: DeskManifest, options: EditProjectGroupOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  const currentGroupId = options.currentGroupId ?? options.groupId;
  if (project) {
    const group = project.groups.find((candidate) => candidate.id === currentGroupId);
    if (!group) {
      throw new Error(`group ${currentGroupId} does not exist in project ${options.projectId}`);
    }
    group.id = options.groupId;
    group.label = options.groupLabel;
    group.layout = options.layout;
    return { ...manifest, projects };
  }

  const groups = cloneGroups(manifest);
  const group = groups.find((candidate) => candidate.id === currentGroupId);
  if (!group) {
    throw new Error(`group ${currentGroupId} does not exist`);
  }
  group.id = options.groupId;
  group.label = options.groupLabel;
  group.layout = options.layout;
  return { ...manifest, groups, projects: manifest.projects };
}

export function deleteGroupFromManifest(manifest: DeskManifest, options: DeleteProjectGroupOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    project.groups = project.groups.filter((group) => group.id !== options.groupId);
    return { ...manifest, projects };
  }

  const groups = cloneGroups(manifest)
    .map((group) => {
      if (group.id !== options.groupId) {
        return group;
      }
      if (!options.projectCwd) {
        return undefined;
      }
      return {
        ...group,
        sessions: group.sessions.filter((session) => !session.cwd || !cwdMatches(session.cwd, options.projectCwd!))
      };
    })
    .filter((group): group is DeskGroup => Boolean(group && group.sessions.length > 0));
  return { ...manifest, groups, projects: manifest.projects };
}

export function editSessionInManifest(manifest: DeskManifest, options: EditProjectSessionOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    const group = project.groups.find((candidate) => candidate.id === options.groupId);
    if (!group) {
      throw new Error(`group ${options.groupId} does not exist in project ${options.projectId}`);
    }
    group.sessions = replaceSession(group.sessions, options.currentName, options.session);
    return { ...manifest, projects };
  }

  const groups = cloneGroups(manifest);
  const group = groups.find((candidate) => candidate.id === options.groupId);
  if (!group) {
    throw new Error(`group ${options.groupId} does not exist`);
  }
  group.sessions = replaceSession(group.sessions, options.currentName, options.session, options.projectCwd);
  return { ...manifest, groups, projects: manifest.projects };
}

export function deleteSessionFromManifest(manifest: DeskManifest, options: DeleteProjectSessionOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    const group = project.groups.find((candidate) => candidate.id === options.groupId);
    if (!group) {
      throw new Error(`group ${options.groupId} does not exist in project ${options.projectId}`);
    }
    group.sessions = group.sessions.filter((session) => session.name !== options.sessionName);
    return { ...manifest, projects };
  }

  const groups = cloneGroups(manifest);
  const group = groups.find((candidate) => candidate.id === options.groupId);
  if (!group) {
    throw new Error(`group ${options.groupId} does not exist`);
  }
  group.sessions = group.sessions.filter(
    (session) =>
      session.name !== options.sessionName ||
      Boolean(options.projectCwd && session.cwd && !cwdMatches(session.cwd, options.projectCwd))
  );
  return { ...manifest, groups, projects: manifest.projects };
}

export function moveSessionInManifest(manifest: DeskManifest, options: MoveProjectSessionOptions): DeskManifest {
  const sourceSpec = findMoveSourceSpec(manifest, options);
  const projects = cloneProjects(manifest);
  const groups = cloneGroups(manifest);
  const session = materializeMovedSession(removeSession(projects, groups, options), sourceSpec);
  const targetProject = projects.find((project) => project.id === options.targetProjectId);
  if (targetProject) {
    const targetGroup = targetProject.groups.find((group) => group.id === options.targetGroupId);
    if (!targetGroup) {
      throw new Error(`group ${options.targetGroupId} does not exist in project ${options.targetProjectId}`);
    }
    if (targetGroup.sessions.some((candidate) => candidate.name === session.name)) {
      throw new Error(`session ${session.name} already exists in group ${options.targetGroupId}`);
    }
    targetGroup.sessions.push(session);
    return { ...manifest, groups, projects };
  }

  const targetGroup = groups.find((group) => group.id === options.targetGroupId);
  if (!targetGroup) {
    throw new Error(`group ${options.targetGroupId} does not exist`);
  }
  if (targetGroup.sessions.some((candidate) => candidate.name === session.name)) {
    throw new Error(`session ${session.name} already exists in group ${options.targetGroupId}`);
  }
  targetGroup.sessions.push(session);
  return { ...manifest, groups, projects: manifest.projects };
}

export interface SetGroupLayoutSizesOptions {
  projectId: string;
  groupId: string;
  projectCwd?: string;
  sizes: DeskLayoutSizes;
}

/**
 * Merges drag-resized panel split sizes into a group's layout, preserving its
 * kind/cells. Separate from editGroupInManifest (which replaces layout) so a
 * resize never disturbs the layout kind or cell count.
 */
export function setGroupLayoutSizesInManifest(manifest: DeskManifest, options: SetGroupLayoutSizesOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    const group = project.groups.find((candidate) => candidate.id === options.groupId);
    if (!group) {
      throw new Error(`group ${options.groupId} does not exist in project ${options.projectId}`);
    }
    group.layout = { ...(group.layout ?? {}), sizes: options.sizes };
    return { ...manifest, projects };
  }

  const groups = cloneGroups(manifest);
  const group = groups.find((candidate) => candidate.id === options.groupId);
  if (!group) {
    throw new Error(`group ${options.groupId} does not exist`);
  }
  group.layout = { ...(group.layout ?? {}), sizes: options.sizes };
  return { ...manifest, groups, projects: manifest.projects };
}

/**
 * Assigns `order` to each item by its position in `orderedIds`, then sorts the
 * array to match. Items missing from orderedIds keep their order/position via a
 * stable index fallback — robust to a stale id list racing a concurrent edit.
 */
function applyOrder<T extends { order?: number }>(items: T[], orderedIds: string[], idOf: (item: T) => string): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  const ranked = items.map((item) => {
    const next = rank.get(idOf(item));
    return next === undefined ? item : { ...item, order: next };
  });
  return ranked
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? a.index) - (b.item.order ?? b.index))
    .map((entry) => entry.item);
}

export function reorderProjectsInManifest(manifest: DeskManifest, orderedProjectIds: string[]): DeskManifest {
  const projects = applyOrder(cloneProjects(manifest), orderedProjectIds, (project) => project.id);
  return { ...manifest, projects };
}

export interface ReorderGroupsOptions {
  projectId: string;
  orderedGroupIds: string[];
}

export function reorderGroupsInManifest(manifest: DeskManifest, options: ReorderGroupsOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    project.groups = applyOrder(project.groups, options.orderedGroupIds, (group) => group.id);
    return { ...manifest, projects };
  }
  // Legacy top-level groups (no project scope).
  const groups = applyOrder(cloneGroups(manifest), options.orderedGroupIds, (group) => group.id);
  return { ...manifest, groups, projects: manifest.projects };
}

export interface ReorderSessionsOptions {
  projectId: string;
  groupId: string;
  projectCwd?: string;
  orderedSessionNames: string[];
}

export function reorderSessionsInManifest(manifest: DeskManifest, options: ReorderSessionsOptions): DeskManifest {
  const projects = cloneProjects(manifest);
  const project = projects.find((candidate) => candidate.id === options.projectId);
  if (project) {
    const group = project.groups.find((candidate) => candidate.id === options.groupId);
    if (!group) {
      throw new Error(`group ${options.groupId} does not exist in project ${options.projectId}`);
    }
    group.sessions = applyOrder(group.sessions, options.orderedSessionNames, (session) => session.name);
    return { ...manifest, projects };
  }
  const groups = cloneGroups(manifest);
  const group = groups.find((candidate) => candidate.id === options.groupId);
  if (!group) {
    throw new Error(`group ${options.groupId} does not exist`);
  }
  group.sessions = applyOrder(group.sessions, options.orderedSessionNames, (session) => session.name);
  return { ...manifest, groups, projects: manifest.projects };
}

export function resolveManifestPath(path?: string): string {
  if (path) {
    return resolve(path);
  }
  return resolveDefaultManifestPath();
}

function cloneProjects(manifest: DeskManifest): NonNullable<DeskManifest['projects']> {
  return [...(manifest.projects ?? [])].map((project) => ({
    ...project,
    groups: project.groups.map((group) => ({
      ...group,
      sessions: [...group.sessions]
    }))
  }));
}

function cloneGroups(manifest: DeskManifest): DeskGroup[] {
  return manifest.groups.map((group) => ({
    ...group,
    sessions: [...group.sessions]
  }));
}

function replaceSession(sessions: DeskSession[], currentName: string, nextSession: DeskSession, cwd?: string): DeskSession[] {
  let replaced = false;
  const next = sessions.map((session) => {
    if (session.name !== currentName || (cwd && session.cwd && !cwdMatches(session.cwd, cwd))) {
      return session;
    }
    replaced = true;
    // Preserve the pinned tmux session name unless the edit provides one:
    // dropping it would re-derive the name and orphan the running session.
    if (nextSession.tmuxSession === undefined && session.tmuxSession !== undefined) {
      return { ...nextSession, tmuxSession: session.tmuxSession };
    }
    return nextSession;
  });
  if (!replaced) {
    throw new Error(`session ${currentName} does not exist`);
  }
  return next;
}

function removeSession(projects: NonNullable<DeskManifest['projects']>, groups: DeskGroup[], options: MoveProjectSessionOptions): DeskSession {
  const sourceProject = projects.find((project) => project.id === options.sourceProjectId);
  const sourceGroup = sourceProject
    ? sourceProject.groups.find((group) => group.id === options.sourceGroupId)
    : groups.find((group) => group.id === options.sourceGroupId);
  if (!sourceGroup) {
    throw new Error(`group ${options.sourceGroupId} does not exist`);
  }
  const index = sourceGroup.sessions.findIndex(
    (session) =>
      session.name === options.sourceSessionName &&
      (Boolean(sourceProject) || !options.sourceProjectCwd || !session.cwd || cwdMatches(session.cwd, options.sourceProjectCwd))
  );
  if (index < 0) {
    throw new Error(`session ${options.sourceSessionName} does not exist`);
  }
  const [session] = sourceGroup.sessions.splice(index, 1);
  return session!;
}

function findMoveSourceSpec(manifest: DeskManifest, options: MoveProjectSessionOptions): SessionSpec | undefined {
  const cwd = options.sourceProjectCwd ? expandHome(options.sourceProjectCwd) : undefined;
  return buildSessionSpecs(manifest, { homeDir: homedir() }).find(
    (session) =>
      session.groupId === options.sourceGroupId &&
      session.name === options.sourceSessionName &&
      (session.projectId === options.sourceProjectId || (!session.projectId && Boolean(cwd) && cwdMatches(session.cwd, cwd!)))
  );
}

function materializeMovedSession(session: DeskSession, sourceSpec: SessionSpec | undefined): DeskSession {
  return {
    ...session,
    cwd: session.cwd ?? sourceSpec?.cwd,
    tmuxSession: session.tmuxSession ?? sourceSpec?.tmuxSession
  };
}

function cwdMatches(candidate: string, target: string): boolean {
  return candidate === target || expandHome(candidate) === expandHome(target);
}

function expandHome(value: string): string {
  return value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value;
}
