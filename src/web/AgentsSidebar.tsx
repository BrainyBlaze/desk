import { memo, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Animated, Animator, FrameUnderline, useBleeps } from '@arwes/react';
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Folder,
  HelpCircle,
  Info,
  LayoutGrid,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  Zap
} from 'lucide-react';
import { IconButton, Modal } from './arwes/primitives.js';
import type { DeskBleepName } from './arwes/bleeps.js';
import { LIST_REVEAL, LIST_ROW_DURATION } from './arwes/motion.js';
import { countSidebarAgents } from './sidebarCounts.js';
import { computeReorder, getReorderData, setReorderData } from './sidebarReorder.js';
import { getSidebarDropSessionTmux } from './sidebarMove.js';
import { StatusDot } from './statusDot.js';
import type { DeskGroupView, DeskProjectView, DeskSessionView } from '../ui/model.js';

function ActionCluster({ children }: { children: ReactNode }): JSX.Element {
  return <div className="treeActions">{children}</div>;
}

function AgentsSidebarImpl({
  projects,
  attention,
  activeProjectId,
  activeGroupId,
  activeTmux,
  collapsedProjects,
  collapsedGroups,
  onAddProject,
  onExpandAll,
  onCollapseAll,
  onToggleProject,
  onToggleGroup,
  onAddGroup,
  onAddSession,
  onProjectInfo,
  onProjectEdit,
  onProjectDelete,
  onGroupInfo,
  onGroupEdit,
  onGroupDelete,
  onSessionInfo,
  onSessionEdit,
  onSessionDelete,
  onSessionRestart,
  onSessionRepair,
  onGroupBoot,
  onDragSession,
  onDropSession,
  onDropSessionToProject,
  onReorderProjects,
  onReorderGroups,
  onReorderSessions,
  onSelectProject,
  onSelectGroup,
  onSelectSession
}: {
  projects: DeskProjectView[];
  attention: Record<string, { attention: true; since: string }>;
  activeProjectId?: string;
  activeGroupId?: string;
  activeTmux?: string;
  collapsedProjects: Record<string, boolean>;
  collapsedGroups: Record<string, boolean>;
  onAddProject: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onToggleProject: (project: DeskProjectView) => void;
  onToggleGroup: (group: DeskGroupView) => void;
  onAddGroup: (project: DeskProjectView) => void;
  onAddSession: (group: DeskGroupView) => void;
  onProjectInfo: (project: DeskProjectView) => void;
  onProjectEdit: (project: DeskProjectView) => void;
  onProjectDelete: (project: DeskProjectView) => void;
  onGroupInfo: (group: DeskGroupView) => void;
  onGroupEdit: (group: DeskGroupView) => void;
  onGroupDelete: (group: DeskGroupView) => void;
  onSessionInfo: (session: DeskSessionView, group: DeskGroupView) => void;
  onSessionEdit: (session: DeskSessionView, group: DeskGroupView) => void;
  onSessionDelete: (session: DeskSessionView, group: DeskGroupView) => void;
  onSessionRestart: (session: DeskSessionView, group: DeskGroupView) => void;
  onSessionRepair: () => void;
  onGroupBoot: (group: DeskGroupView) => void;
  onDragSession: (value: { session: DeskSessionView; group: DeskGroupView } | null) => void;
  onDropSession: (group: DeskGroupView, tmuxSession?: string) => void;
  onDropSessionToProject: (project: DeskProjectView, tmuxSession?: string) => void;
  onReorderProjects: (orderedProjectIds: string[]) => void;
  onReorderGroups: (projectId: string, orderedGroupIds: string[]) => void;
  onReorderSessions: (projectId: string, groupId: string, projectCwd: string, orderedSessionNames: string[]) => void;
  onSelectProject: (project: DeskProjectView) => void;
  onSelectGroup: (group: DeskGroupView) => void;
  onSelectSession: (session: DeskSessionView, group: DeskGroupView) => void;
}): JSX.Element {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const pointerDragTmuxRef = useRef<string | undefined>(undefined);
  const pointerDragIdRef = useRef<number | undefined>(undefined);
  const bleeps = useBleeps<DeskBleepName>();
  // Tree filter: substring on session name / tmux target (group and project
  // labels match their whole subtree), plus a needs-input-only chip. While
  // filtering, collapse state is ignored so matches are always on screen.
  const [filter, setFilter] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [agentsHelpOpen, setAgentsHelpOpen] = useState(false);
  const filterText = filter.trim().toLowerCase();
  const filtering = filterText !== '' || attentionOnly;
  const attentionTotal = projects.reduce(
    (total, project) =>
      total +
      project.groups.reduce(
        (groupTotal, group) =>
          groupTotal + group.sessions.filter((session) => attention[session.spec.tmuxSession]).length,
        0
      ),
    0
  );
  const visibleGroupSessions = (group: DeskGroupView, labelMatched: boolean): DeskSessionView[] => {
    let sessions = group.sessions;
    if (attentionOnly) {
      sessions = sessions.filter((session) => attention[session.spec.tmuxSession]);
    }
    if (filterText === '' || labelMatched || group.label.toLowerCase().includes(filterText)) {
      return sessions;
    }
    return sessions.filter(
      (session) =>
        session.spec.name.toLowerCase().includes(filterText) ||
        session.spec.tmuxSession.toLowerCase().includes(filterText)
    );
  };

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) {
      return;
    }
    const findProject = (projectId: string | undefined): DeskProjectView | undefined =>
      projectId ? projects.find((project) => project.id === projectId) : undefined;
    const findGroup = (projectId: string | undefined, groupId: string | undefined): DeskGroupView | undefined =>
      findProject(projectId)?.groups.find((group) => group.groupId === groupId);

    // A pointerdown only ARMS a candidate; it becomes a drag after real
    // movement. Without the threshold every click/tap was swallowed by the
    // drop path (pointerup stopPropagation), so sessions could never be
    // plainly selected — the row's own onClick never fired.
    let armedX = 0;
    let armedY = 0;
    let dragging = false;
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      pointerDragTmuxRef.current = undefined;
      pointerDragIdRef.current = undefined;
      dragging = false;
      onDragSession(null);
      if (!(event.target instanceof Element)) {
        return;
      }
      const sessionNode = event.target.closest<HTMLElement>('[data-sidebar-session="true"]');
      const tmuxSession = sessionNode?.dataset.tmuxSession;
      if (!tmuxSession) {
        return;
      }
      pointerDragTmuxRef.current = tmuxSession;
      pointerDragIdRef.current = event.pointerId;
      armedX = event.clientX;
      armedY = event.clientY;
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const tmuxSession = pointerDragTmuxRef.current;
      if (!tmuxSession || dragging || event.pointerId !== pointerDragIdRef.current) {
        return;
      }
      if (Math.abs(event.clientX - armedX) < 6 && Math.abs(event.clientY - armedY) < 6) {
        return;
      }
      dragging = true;
      const sessionNode = tree.querySelector<HTMLElement>(`[data-tmux-session="${CSS.escape(tmuxSession)}"]`);
      const groupNode = sessionNode?.closest<HTMLElement>('[data-sidebar-group="true"]');
      const group = findGroup(groupNode?.dataset.projectId, groupNode?.dataset.groupId);
      const session = group?.sessions.find((candidate) => candidate.spec.tmuxSession === tmuxSession);
      if (group && session) {
        onDragSession({ session, group });
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      const tmuxSession = pointerDragTmuxRef.current;
      const pointerId = pointerDragIdRef.current;
      if (pointerId !== undefined && event.pointerId !== pointerId) {
        return;
      }
      pointerDragTmuxRef.current = undefined;
      pointerDragIdRef.current = undefined;
      if (!dragging) {
        // plain click/tap: let the row's own onClick handle selection
        onDragSession(null);
        return;
      }
      dragging = false;
      if (!tmuxSession || !(event.target instanceof Element)) {
        onDragSession(null);
        return;
      }
      const groupNode = event.target.closest<HTMLElement>('[data-sidebar-group="true"]');
      if (groupNode) {
        const group = findGroup(groupNode.dataset.projectId, groupNode.dataset.groupId);
        if (group) {
          event.preventDefault();
          event.stopPropagation();
          onDropSession(group, tmuxSession);
          onDragSession(null);
          return;
        }
      }
      const projectNode = event.target.closest<HTMLElement>('[data-sidebar-project="true"]');
      const project = findProject(projectNode?.dataset.projectId);
      if (project) {
        event.preventDefault();
        event.stopPropagation();
        onDropSessionToProject(project, tmuxSession);
      }
      onDragSession(null);
    };

    tree.addEventListener('pointerdown', handlePointerDown, true);
    tree.addEventListener('pointermove', handlePointerMove, true);
    tree.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      tree.removeEventListener('pointerdown', handlePointerDown, true);
      tree.removeEventListener('pointermove', handlePointerMove, true);
      tree.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, [onDragSession, onDropSession, onDropSessionToProject, projects]);

  return (
    <aside className="agentsSidebar">
      <div className="sidebarHeader">
        <div className="railTitle">
          <Activity size={12} />
          <span>Agents</span>
          <small>{countSidebarAgents(projects)}</small>
        </div>
        <div className="railActions">
          <IconButton icon={<ChevronsDown size={12} />} label="Expand all" onClick={onExpandAll} />
          <IconButton icon={<ChevronsUp size={12} />} label="Collapse all" onClick={onCollapseAll} />
          <IconButton icon={<Plus size={12} />} label="Add project" onClick={onAddProject} />
          <IconButton icon={<HelpCircle size={12} />} label="Help" onClick={() => setAgentsHelpOpen(true)} />
        </div>
      </div>
      <div className="sidebarFilterRow">
        <input
          className="treeInlineInput sidebarFilterInput"
          placeholder="filter sessions…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter !== '') {
              event.stopPropagation();
              setFilter('');
            }
          }}
        />
        <button
          type="button"
          className={`sidebarFilterChip ${attentionOnly ? 'active' : ''}`}
          title={attentionOnly ? 'Showing only sessions needing input' : 'Show only sessions needing input'}
          aria-pressed={attentionOnly}
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
            setAttentionOnly((value) => !value);
          }}
        >
          <Bell size={10} />
          {attentionTotal > 0 ? <span>{attentionTotal}</span> : null}
        </button>
      </div>
      <div className="projectTree" ref={treeRef}>
        {projects.map((project) => {
          const projectLabelMatched = filterText !== '' && project.label.toLowerCase().includes(filterText);
          const groupViews = project.groups.map((group) => ({
            group,
            sessions: visibleGroupSessions(group, projectLabelMatched)
          }));
          if (filtering && !projectLabelMatched && groupViews.every((view) => view.sessions.length === 0)) {
            return null;
          }
          const projectAttention = project.groups.some((group) =>
            group.sessions.some((session) => attention[session.spec.tmuxSession])
          );
          const projectCollapsed = filtering ? false : Boolean(collapsedProjects[project.id]);
          return (
          <section
            key={project.id}
            className={`projectNode ${project.id === activeProjectId ? 'selected' : ''}`}
            data-sidebar-project="true"
            data-project-id={project.id}
          >
            <div
              className="treeRow projectRow"
              draggable
              onDragStart={(event) => {
                setReorderData(event.dataTransfer, { kind: 'project', projectId: project.id, id: project.id });
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // Reorder takes priority over the session-move drop; the two use
                // different dataTransfer MIME types so they never collide.
                const reorder = getReorderData(event.dataTransfer);
                if (reorder?.kind === 'project') {
                  const ids = projects.map((candidate) => candidate.id);
                  const ordered = computeReorder(ids, reorder.id, project.id);
                  if (ordered !== ids) {
                    onReorderProjects(ordered);
                  }
                  return;
                }
                onDropSessionToProject(project, getSidebarDropSessionTmux(event.dataTransfer));
              }}
            >
              <button
                className="treeToggle"
                type="button"
                aria-label={projectCollapsed ? 'Expand project' : 'Collapse project'}
                onClick={() => onToggleProject(project)}
              >
                {projectCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
              {project.id === activeProjectId ? <FrameUnderline squareSize={6} strokeWidth={1} /> : null}
              <button
                className="treeMain"
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={() => {
                  bleeps.click?.play();
                  onSelectProject(project);
                }}
                title={project.cwd}
              >
                <Folder size={13} />
                <span>{project.label}</span>
                <span className="treeMeta">
                  <small>{project.running}/{project.running + project.missing}</small>
                  {projectCollapsed && projectAttention ? (
                    <i className="treeAttnDot" title="A session inside needs input" aria-label="needs input" />
                  ) : null}
                </span>
              </button>
              <ActionCluster>
                <IconButton icon={<Plus size={11} />} label="Add group" onClick={() => onAddGroup(project)} />
                <IconButton icon={<Info size={11} />} label="Project info" onClick={() => onProjectInfo(project)} />
                <IconButton icon={<Pencil size={11} />} label="Edit project" onClick={() => onProjectEdit(project)} />
                <IconButton icon={<Trash2 size={11} />} label="Delete project" onClick={() => onProjectDelete(project)} />
              </ActionCluster>
            </div>
            {!projectCollapsed ? (
              <div className="groupBranch">
                {groupViews.map(({ group, sessions: visibleSessions }) => {
                  if (filtering && visibleSessions.length === 0 && !projectLabelMatched) {
                    return null;
                  }
                  const groupAttention = group.sessions.some((session) => attention[session.spec.tmuxSession]);
                  const groupCollapsed = filtering ? false : Boolean(collapsedGroups[group.id]);
                  return (
                  <section
                    key={group.id}
                    className={`groupNode ${group.id === activeGroupId ? 'selected' : ''}`}
                    data-sidebar-group="true"
                    data-project-id={project.id}
                    data-group-id={group.groupId}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const reorder = getReorderData(event.dataTransfer);
                      // Group reorder only within the same project; session reorder
                      // lands on a session row (handled below), not here.
                      if (reorder?.kind === 'group' && reorder.projectId === project.id) {
                        const ids = project.groups.map((candidate) => candidate.groupId);
                        const ordered = computeReorder(ids, reorder.id, group.groupId);
                        if (ordered !== ids) {
                          onReorderGroups(project.id, ordered);
                        }
                        return;
                      }
                      if (reorder?.kind === 'session' && reorder.projectId === project.id && reorder.groupId === group.groupId) {
                        return; // same-group session on the group area is a no-op (reorder by dropping on a session row)
                      }
                      // Cross-group session move (the session drag also carries its tmux id).
                      onDropSession(group, getSidebarDropSessionTmux(event.dataTransfer));
                    }}
                  >
                  <div
                    className="treeRow groupRow"
                    draggable
                    onDragStart={(event) => {
                      event.stopPropagation();
                      setReorderData(event.dataTransfer, { kind: 'group', projectId: project.id, groupId: group.groupId, id: group.groupId });
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <button
                      className="treeToggle"
                      type="button"
                      aria-label={groupCollapsed ? 'Expand group' : 'Collapse group'}
                      onClick={() => onToggleGroup(group)}
                    >
                      {groupCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {group.id === activeGroupId ? <FrameUnderline squareSize={6} strokeWidth={1} /> : null}
                    <button
                      className="treeMain"
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        onSelectGroup(group);
                      }}
                      title={group.label}
                    >
                      <LayoutGrid size={12} />
                      <span>{group.label}</span>
                      {/* Liveness over config trivia: layout kind moves to the
                          tooltip; the count mirrors the project rows. Count and
                          the needs-input lamp share one cell (count first) so the
                          lamp never bumps the count off the row's single line. */}
                      <span className="treeMeta">
                        <small title={group.layout.kind}>
                          {group.sessions.filter((candidate) => candidate.state === 'running').length}/{group.sessions.length}
                        </small>
                        {groupCollapsed && groupAttention ? (
                          <i className="treeAttnDot" title="A session inside needs input" aria-label="needs input" />
                        ) : null}
                      </span>
                    </button>
                    <ActionCluster>
                      {group.missing > 0 ? (
                        <IconButton
                          icon={<Zap size={11} />}
                          label={`Boot ${group.missing} missing session${group.missing === 1 ? '' : 's'}`}
                          onClick={() => {
                            bleeps.deploy?.play();
                            onGroupBoot(group);
                          }}
                        />
                      ) : null}
                      <IconButton icon={<Plus size={11} />} label="Add session" onClick={() => onAddSession(group)} />
                      <IconButton icon={<Info size={11} />} label="Group info" onClick={() => onGroupInfo(group)} />
                      <IconButton icon={<Pencil size={11} />} label="Edit group" onClick={() => onGroupEdit(group)} />
                      <IconButton icon={<Trash2 size={11} />} label="Delete group" onClick={() => onGroupDelete(group)} />
                    </ActionCluster>
                  </div>
                  {!groupCollapsed ? (
                    <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
                      <div className="sessionBranch">
                        {visibleSessions.map((session) => (
                          <Animator key={session.spec.tmuxSession} duration={LIST_ROW_DURATION}>
                            <Animated
                              className={`treeRow sessionNode ${session.spec.tmuxSession === activeTmux ? 'selected' : ''}`}
                              animated={['fade', ['x', -10, 0]]}
                              data-sidebar-session="true"
                              data-tmux-session={session.spec.tmuxSession}
                              draggable
                              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                                event.stopPropagation();
                                setReorderData(event.dataTransfer, {
                                  kind: 'session',
                                  projectId: group.projectId,
                                  groupId: group.groupId,
                                  id: session.spec.name
                                });
                                // Also expose the tmux session so a cross-group drop still moves it.
                                event.dataTransfer.setData('application/x-desk-session', session.spec.tmuxSession);
                                event.dataTransfer.effectAllowed = 'move';
                              }}
                              onDragOver={(event: DragEvent<HTMLDivElement>) => {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                              }}
                              onDrop={(event: DragEvent<HTMLDivElement>) => {
                                const reorder = getReorderData(event.dataTransfer);
                                if (reorder?.kind === 'session' && reorder.projectId === group.projectId && reorder.groupId === group.groupId) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  const names = group.sessions.map((candidate) => candidate.spec.name);
                                  const ordered = computeReorder(names, reorder.id, session.spec.name);
                                  if (ordered !== names) {
                                    onReorderSessions(group.projectId, group.groupId, group.projectCwd, ordered);
                                  }
                                }
                                // A cross-group session drop falls through to the group section's onDrop (move).
                              }}
                            >
                              {session.spec.tmuxSession === activeTmux ? <FrameUnderline squareSize={6} strokeWidth={1} /> : null}
                              <span className="treeToggle spacer" aria-hidden="true" />
                              <button
                                className="treeMain"
                                onMouseEnter={() => bleeps.hover?.play()}
                                onClick={() => {
                                  bleeps.click?.play();
                                  onSelectSession(session, group);
                                }}
                                title={session.spec.tmuxSession}
                              >
                                <StatusDot state={session.state} attention={Boolean(attention[session.spec.tmuxSession])} />
                                <span>{session.spec.name}</span>
                              </button>
                              <ActionCluster>
                                <IconButton icon={<Info size={10} />} label="Session info" onClick={() => onSessionInfo(session, group)} />
                                <IconButton icon={<Pencil size={10} />} label="Edit session" onClick={() => onSessionEdit(session, group)} />
                                <IconButton
                                  icon={<RotateCw size={10} />}
                                  label="Reload session"
                                  onClick={() => {
                                    bleeps.deploy?.play();
                                    onSessionRestart(session, group);
                                  }}
                                />
                                {/*
                                  Repair remains wired for non-sidebar recovery paths, but the
                                  per-session sidebar action is intentionally hidden: accidental
                                  clicks can mutate live tmux windows.
                                  <IconButton icon={<Wrench size={10} />} label="Repair session" onClick={onSessionRepair} />
                                */}
                                <IconButton icon={<Trash2 size={10} />} label="Delete session" onClick={() => onSessionDelete(session, group)} />
                              </ActionCluster>
                            </Animated>
                          </Animator>
                        ))}
                      </div>
                    </Animator>
                  ) : null}
                </section>
                  );
                })}
              </div>
            ) : null}
          </section>
          );
        })}
      </div>

      {agentsHelpOpen ? (
        <Modal title="Agents" icon={<Activity size={13} />} onClose={() => setAgentsHelpOpen(false)}>
          <div style={{ padding: '16px 14px', color: 'var(--desk-text-dim)', fontSize: '12px', lineHeight: '1.5' }}>
            <div>Agents are AI assistants and execution environments that work on tasks. Each agent is a tmux session with Claude or another AI running commands.</div>
            <div style={{ marginTop: '12px' }}>Create agent projects to organize work, add groups to coordinate on related tasks, and create sessions for individual agents to execute work.</div>
            <div style={{ marginTop: '12px' }}>Use the boot button to start missing sessions, edit to modify names and settings, and delete to remove sessions. Sessions show live status with a dot indicator — green for running, yellow for waiting for input, gray for inactive.</div>
            <div style={{ marginTop: '12px' }}>Active sessions appear in the terminal multiplexer where you can see output and send input. Featured messages can reference agents with @name mentions to direct messages and task assignments.</div>
            <div style={{ marginTop: '12px' }}>
              <a href="https://docs.desk.cloud/agents-and-terminals/" target="_blank" rel="noopener noreferrer" style={{ color: '#4dd9ff', textDecoration: 'underline', cursor: 'pointer' }}>
                Read full documentation →
              </a>
            </div>
          </div>
        </Modal>
      ) : null}
    </aside>
  );
}

export const AgentsSidebar = memo(AgentsSidebarImpl);
