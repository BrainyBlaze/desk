import type { DeskGroupLayout, DeskLayoutKind, DeskLayoutSizes, SessionSpec } from '../core/types.js';

export interface DeskSessionView {
  spec: SessionSpec;
  state: 'running' | 'missing';
}

export interface DeskGroupLayoutView {
  kind: DeskLayoutKind;
  cellCount: number;
  /** persisted drag-resized split sizes (percentages); applied only when shape matches */
  sizes?: DeskLayoutSizes;
}

export interface DeskGroupView {
  id: string;
  groupId: string;
  label: string;
  projectId: string;
  projectLabel: string;
  projectCwd: string;
  /** explicit sidebar order; undefined falls back to manifest position */
  order?: number;
  layout: DeskGroupLayoutView;
  running: number;
  missing: number;
  sessions: DeskSessionView[];
}

export interface DeskProjectView {
  id: string;
  label: string;
  cwd: string;
  configured: boolean;
  /** explicit sidebar order; undefined falls back to manifest position */
  order?: number;
  running: number;
  missing: number;
  groups: DeskGroupView[];
}

export interface DeskViewModel {
  totals: {
    projects: number;
    groups: number;
    sessions: number;
    running: number;
    missing: number;
  };
  projects: DeskProjectView[];
  groups: DeskGroupView[];
}

export interface DeskGroupSeed {
  id: string;
  label?: string;
  projectId?: string;
  projectLabel?: string;
  projectCwd?: string;
  layout?: DeskGroupLayout;
  order?: number;
  projectOrder?: number;
}

export interface DeskProjectSeed {
  id: string;
  label?: string;
  cwd: string;
  order?: number;
}

export function buildDeskViewModel(
  sessions: SessionSpec[],
  runningSessions: Set<string>,
  groupSeeds: DeskGroupSeed[] = [],
  projectSeeds: DeskProjectSeed[] = []
): DeskViewModel {
  const groups = new Map<string, DeskGroupView>();
  const projects = new Map<string, DeskProjectView>();

  for (const seed of projectSeeds) {
    ensureProject(projects, {
      id: seed.id,
      label: seed.label ?? seed.id,
      cwd: seed.cwd,
      configured: true,
      order: seed.order
    });
  }

  for (const seed of groupSeeds) {
    const project = ensureProject(projects, {
      id: seed.projectId ?? 'workspace',
      label: seed.projectLabel ?? 'Workspace',
      cwd: seed.projectCwd ?? '',
      order: seed.projectOrder
    });
    const group: DeskGroupView = {
      id: seed.projectId ? `${seed.projectId}:${seed.id}` : seed.id,
      groupId: seed.id,
      label: seed.label ?? seed.id,
      projectId: project.id,
      projectLabel: project.label,
      projectCwd: project.cwd,
      order: seed.order,
      layout: normalizeLayout(seed.layout),
      running: 0,
      missing: 0,
      sessions: []
    };
    groups.set(group.id, group);
    project.groups.push(group);
  }

  for (const spec of sessions) {
    const state = runningSessions.has(spec.tmuxSession) ? 'running' : 'missing';
    const project = ensureProject(projects, { ...projectFromSession(spec), order: spec.projectOrder });
    const groupKey = `${project.id}:${spec.groupId}`;
    let group = groups.get(groupKey);

    if (!group) {
      group = {
        id: groupKey,
        groupId: spec.groupId,
        label: spec.groupLabel,
        projectId: project.id,
        projectLabel: project.label,
        projectCwd: project.cwd,
        order: spec.groupOrder,
        layout: normalizeLayout(spec.groupLayout),
        running: 0,
        missing: 0,
        sessions: []
      };
      groups.set(groupKey, group);
      project.groups.push(group);
    }

    group.sessions.push({ spec, state });
    if (state === 'running') {
      group.running += 1;
    } else {
      group.missing += 1;
    }
  }

  // Apply explicit sidebar order (drag-reorder). Items without an order keep
  // their manifest position via the stable index fallback.
  for (const group of groups.values()) {
    group.sessions = sortByOrder(group.sessions, (session) => session.spec.order);
  }
  for (const project of projects.values()) {
    project.groups = sortByOrder(project.groups, (group) => group.order);
  }

  const groupViews = [...groups.values()];
  const projectViews = sortByOrder([...projects.values()], (project) => project.order);
  const running = groupViews.reduce((total, group) => total + group.running, 0);
  const missing = groupViews.reduce((total, group) => total + group.missing, 0);

  for (const project of projectViews) {
    project.running = project.groups.reduce((total, group) => total + group.running, 0);
    project.missing = project.groups.reduce((total, group) => total + group.missing, 0);
  }

  return {
    totals: {
      projects: projectViews.length,
      groups: groupViews.length,
      sessions: sessions.length,
      running,
      missing
    },
    projects: projectViews,
    groups: groupViews
  };
}

/**
 * Stable order-or-position sort: items with an explicit `order` sort by it;
 * items without one keep their current array index. With all-undefined orders
 * this is the identity (manifest order); after a reorder every sibling has an
 * order so they sort exactly as dragged.
 */
function sortByOrder<T>(items: T[], getOrder: (item: T) => number | undefined): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (getOrder(a.item) ?? a.index) - (getOrder(b.item) ?? b.index))
    .map((entry) => entry.item);
}

function ensureProject(
  projects: Map<string, DeskProjectView>,
  input: { id: string; label: string; cwd: string; configured?: boolean; order?: number }
): DeskProjectView {
  let project = projects.get(input.id);
  if (!project) {
    project = {
      id: input.id,
      label: input.label,
      cwd: input.cwd,
      configured: 'configured' in input ? Boolean(input.configured) : false,
      order: input.order,
      running: 0,
      missing: 0,
      groups: []
    };
    projects.set(input.id, project);
  } else {
    if (input.configured) {
      project.configured = true;
    }
    // A later seed/spec may carry the order the first sighting lacked.
    if (input.order !== undefined && project.order === undefined) {
      project.order = input.order;
    }
  }
  return project;
}

function projectFromSession(spec: SessionSpec): { id: string; label: string; cwd: string; configured: boolean } {
  if (spec.projectId) {
    return {
      id: spec.projectId,
      label: spec.projectLabel ?? spec.projectId,
      cwd: spec.projectCwd ?? spec.cwd,
      configured: true
    };
  }
  const label = basename(spec.cwd);
  return {
    id: `cwd-${slugPart(spec.cwd)}`,
    label,
    cwd: spec.cwd,
    configured: false
  };
}

function normalizeLayout(layout?: DeskGroupLayout): DeskGroupLayoutView {
  const kind = layout?.kind ?? '1x1';
  // custom and linear both carry an explicit cell count; they differ only in how
  // the multiplexer arranges those cells (sqrt grid vs a single row).
  if (kind === 'custom' || kind === 'linear') {
    return { kind, cellCount: Math.max(1, Math.min(16, layout?.cells ?? 1)), sizes: layout?.sizes };
  }
  return { kind, cellCount: Number(kind[0]) ** 2, sizes: layout?.sizes };
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function slugPart(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
