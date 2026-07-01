/**
 * Pulse-driven liveness patching. The 2s pulse carries the live tmux session
 * set; this folds it into the existing snapshot WITHOUT replacing object
 * identities that did not change — TerminalSurface keys its socket lifecycle
 * on session identity, so an over-eager rebuild would reconnect every
 * terminal on every tick.
 */

import type { DeskGroupView, DeskProjectView, DeskViewModel } from '../ui/model.js';

/** Returns the SAME view object when no session changed run-state. */
export function patchViewLiveness(view: DeskViewModel, running: ReadonlySet<string>): DeskViewModel {
  let changed = false;
  const patched = new Map<string, DeskGroupView>();
  for (const group of view.groups) {
    let groupChanged = false;
    const sessions = group.sessions.map((session) => {
      const state: 'running' | 'missing' = running.has(session.spec.tmuxSession) ? 'running' : 'missing';
      if (state === session.state) {
        return session;
      }
      groupChanged = true;
      return { ...session, state };
    });
    if (!groupChanged) {
      patched.set(group.id, group);
      continue;
    }
    changed = true;
    const runningCount = sessions.filter((session) => session.state === 'running').length;
    patched.set(group.id, {
      ...group,
      sessions,
      running: runningCount,
      missing: sessions.length - runningCount
    });
  }
  if (!changed) {
    return view;
  }
  // Projects and the flat group list alias the same group objects — keep the
  // aliasing intact in the patched view.
  const groups = view.groups.map((group) => patched.get(group.id) ?? group);
  const projects = view.projects.map((project): DeskProjectView => {
    const projectGroups = project.groups.map((group) => patched.get(group.id) ?? group);
    if (projectGroups.every((group, index) => group === project.groups[index])) {
      return project;
    }
    return {
      ...project,
      groups: projectGroups,
      running: projectGroups.reduce((total, group) => total + group.running, 0),
      missing: projectGroups.reduce((total, group) => total + group.missing, 0)
    };
  });
  const runningTotal = groups.reduce((total, group) => total + group.running, 0);
  return {
    totals: {
      ...view.totals,
      running: runningTotal,
      missing: view.totals.sessions - runningTotal
    },
    projects,
    groups
  };
}
