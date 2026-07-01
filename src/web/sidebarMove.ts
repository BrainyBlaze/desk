export interface SidebarMoveSessionLike {
  spec: {
    name: string;
    tmuxSession: string;
  };
}

export interface SidebarMoveGroupLike {
  id: string;
  groupId?: string;
  sessions: SidebarMoveSessionLike[];
}

export interface SidebarMoveProjectLike<TGroup extends SidebarMoveGroupLike = SidebarMoveGroupLike> {
  groups: TGroup[];
}

export interface SidebarMoveSnapshotLike {
  view: {
    projects: Array<{
      groups: SidebarMoveGroupLike[];
    }>;
  };
}

export interface SidebarDropDataLike {
  getData(type: string): string;
}

export function getProjectDropGroup<TGroup extends SidebarMoveGroupLike>(project: SidebarMoveProjectLike<TGroup>): TGroup | undefined {
  return project.groups[0];
}

export function getMovedSessionTmux(
  snapshot: SidebarMoveSnapshotLike,
  targetGroupId: string,
  sessionName: string
): string | undefined {
  for (const project of snapshot.view.projects) {
    const group = project.groups.find((candidate) => candidate.id === targetGroupId);
    const session = group?.sessions.find((candidate) => candidate.spec.name === sessionName);
    if (session) {
      return session.spec.tmuxSession;
    }
  }
  return undefined;
}

export function getSidebarDropSessionTmux(dataTransfer: SidebarDropDataLike | null | undefined): string | undefined {
  if (!dataTransfer) {
    return undefined;
  }
  return (
    dataTransfer.getData('application/x-desk-session') ||
    dataTransfer.getData('text/plain') ||
    undefined
  );
}
