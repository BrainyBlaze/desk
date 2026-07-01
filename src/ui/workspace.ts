import type { DeskGroupView, DeskProjectView, DeskSessionView, DeskViewModel } from './model.js';

export interface WorkspaceSelection {
  projectId?: string;
  groupId?: string;
  tmuxSession?: string;
}

export interface WorkspaceCell {
  id: string;
  label: string;
  sessions: DeskSessionView[];
  activeSession?: DeskSessionView;
}

export interface WorkspaceState {
  activeProject: DeskProjectView;
  activeGroup: DeskGroupView;
  activeSession?: DeskSessionView;
  sessionTabs: DeskSessionView[];
  multiplexerCells: WorkspaceCell[];
}

export function buildWorkspaceState(view: DeskViewModel, selection: WorkspaceSelection): WorkspaceState {
  if (view.groups.length === 0) {
    throw new Error('workspace has no groups');
  }

  const activeGroup =
    view.groups.find((group) => group.id === selection.groupId) ??
    view.groups.find((group) => group.projectId === selection.projectId) ??
    view.groups.find((group) => group.sessions.some((session) => session.spec.tmuxSession === selection.tmuxSession)) ??
    view.groups[0]!;
  const activeProject = view.projects.find((project) => project.id === activeGroup.projectId) ?? view.projects[0]!;

  const activeSession =
    activeGroup.sessions.find((session) => session.spec.tmuxSession === selection.tmuxSession) ??
    activeGroup.sessions[0];

  return {
    activeProject,
    activeGroup,
    activeSession,
    sessionTabs: activeGroup.sessions,
    multiplexerCells: buildMultiplexerCells(activeGroup, activeSession)
  };
}

function buildMultiplexerCells(group: DeskGroupView, activeSession?: DeskSessionView): WorkspaceCell[] {
  const cells = Array.from({ length: group.layout.cellCount }, (_, index) => ({
    id: `${group.id}:cell-${index + 1}`,
    label: String(index + 1),
    sessions: [] as DeskSessionView[],
    activeSession: undefined as DeskSessionView | undefined
  }));

  for (const [index, session] of group.sessions.entries()) {
    cells[index % cells.length]!.sessions.push(session);
  }

  for (const cell of cells) {
    cell.activeSession =
      cell.sessions.find((session) => session.spec.tmuxSession === activeSession?.spec.tmuxSession) ?? cell.sessions[0];
  }

  return cells;
}
