export interface SidebarCountProjectLike {
  groups: Array<{
    sessions: unknown[];
  }>;
}

export function countSidebarAgents(projects: SidebarCountProjectLike[]): number {
  return projects.reduce(
    (projectTotal, project) =>
      projectTotal + project.groups.reduce((groupTotal, group) => groupTotal + group.sessions.length, 0),
    0
  );
}
