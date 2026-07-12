import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Copy,
  ExternalLink,
  FilePlus2,
  Filter,
  HelpCircle,
  KeyRound,
  LayoutGrid,
  Link2,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Rows3,
  ScanEye,
  SquareKanban,
  Trash2,
  UserPlus,
  X
} from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import { publishStatus, type StatusSegment } from '../statusSegments.js';
import { CLIP_OCTAGON_TINY, Cmd, DeskPanel, DeskSelect, IconButton, Modal, Pill, TextReveal } from '../arwes/primitives.js';
import {
  AGENT_SIDEBAR_MAX_SIZE,
  AGENT_SIDEBAR_MIN_SIZE,
  PROJECTS_SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_PREFIX,
  clampSidebarWidth,
  createSidebarWidthPersister,
  isAgentSidebarCollapseSize,
  isSidebarHandleDragActive,
  setSidebarHandleDragActive,
  isNarrowViewport,
  surfaceMinSize,
  useNarrowViewport,
  readStoredSidebarCollapsed,
  readStoredSidebarWidth
} from '../sidebarPanel.js';
import { usePersistedCollapse } from '../usePersistedCollapse.js';
import { saveSettings } from '../api.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import {
  MissingScopeError,
  addItemByUrl,
  archiveItem,
  commentOnItem,
  convertDraft,
  createDraft,
  createProject,
  deleteItem,
  editDraft,
  editIssue,
  linkProjectRepo,
  moveItemPosition,
  postStatusUpdate,
  projectsAuth,
  projectsBoard,
  projectsList,
  projectsOwners,
  setFieldValue,
  type FieldValuePayload,
  type ProjectBoard,
  type ProjectField,
  type ProjectItem,
  type ProjectOwner,
  type ProjectStatusUpdate,
  type ProjectSummary,
  type ProjectsAuth
} from './projectsClient.js';
import {
  groupItems,
  groupableFields,
  matchesFilter,
  optionColor,
  parseFilter,
  sortItems,
  valueFor,
  type BoardColumn,
  type SortDirection
} from './projectsModel.js';
import { BoardView } from './BoardView.js';
import { TableView } from './TableView.js';
import { ItemDrawer } from './ItemDrawer.js';
import { useClampedMenu } from '../menuPosition.js';

const PROJECT_STORAGE_KEY = 'desk.ghProject';
const POLL_MS = 45_000;

type StageLayout = 'board' | 'table';

interface ItemMenuState {
  x: number;
  y: number;
  item: ProjectItem;
}

type ModalState =
  | { kind: 'add-item'; column: BoardColumn | null }
  | { kind: 'convert-draft'; item: ProjectItem }
  | { kind: 'status-update' }
  | { kind: 'new-project' }
  | { kind: 'link-repo' }
  | { kind: 'delete-item'; item: ProjectItem }
  | null;

const STATUS_TONES: Record<ProjectStatusUpdate['status'], { label: string; tone: 'ok' | 'warn' | 'muted' | 'error' }> = {
  ON_TRACK: { label: 'on track', tone: 'ok' },
  AT_RISK: { label: 'at risk', tone: 'warn' },
  OFF_TRACK: { label: 'off track', tone: 'error' },
  COMPLETE: { label: 'complete', tone: 'ok' },
  INACTIVE: { label: 'inactive', tone: 'muted' }
};

export function ProjectsSubsystem({
  active,
  onError,
  onInfo,
  onSidebarCollapsedChange,
  registerSidebarToggle,
  serverSidebarWidth
}: {
  active: boolean;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  registerSidebarToggle?: (toggle: () => void) => void;
  /** width from desk.yml (arrives after the settings fetch); reconciles the panel */
  serverSidebarWidth?: number;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const narrowViewport = useNarrowViewport();
  const [booted, setBooted] = useState(false);
  const [auth, setAuth] = useState<ProjectsAuth | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [board, setBoard] = useState<ProjectBoard | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectsHelpOpen, setProjectsHelpOpen] = useState(false);
  const [layout, setLayout] = useState<StageLayout>('board');
  const [filterText, setFilterText] = useState('');
  const [groupFieldId, setGroupFieldId] = useState<string | null>(null);
  const [sortFieldId, setSortFieldId] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showArchived, setShowArchived] = useState(false);
  const [activeItem, setActiveItem] = useState<ProjectItem | null>(null);
  const [drawerRevision, setDrawerRevision] = useState(0);
  const [menu, setMenu] = useState<ItemMenuState | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [modalText, setModalText] = useState('');
  const [modalBody, setModalBody] = useState('');
  const [modalStatus, setModalStatus] = useState<ProjectStatusUpdate['status']>('ON_TRACK');
  const [owners, setOwners] = useState<ProjectOwner[]>([]);
  const [modalOwner, setModalOwner] = useState('');
  const [opBusy, setOpBusy] = useState(false);
  const opInFlightRef = useRef(0);
  const boardEpochRef = useRef(0);

  const projectIdRef = useRef<string | null>(null);
  projectIdRef.current = projectId;
  const boardGenRef = useRef(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useClampedMenu(menu);

  // Bottom status bar context: which board, item pressure, gh identity.
  useEffect(() => {
    if (!auth?.ok) {
      publishStatus('projects', [
        { key: 'board', icon: <SquareKanban size={11} />, text: 'gh not authenticated', tone: 'warn', hint: auth?.reason ?? 'GitHub CLI auth required' }
      ]);
      return;
    }
    if (!board) {
      publishStatus('projects', [
        { key: 'board', icon: <SquareKanban size={11} />, text: loadingBoard ? 'loading board…' : 'no board selected', hint: 'Pick a project board in the sidebar' }
      ]);
      return;
    }
    const live = board.items.filter((item) => !item.isArchived);
    const openCount = live.filter((item) => (item.content?.state ?? 'OPEN').toUpperCase() === 'OPEN').length;
    const archived = board.items.length - live.length;
    const segments: StatusSegment[] = [
      {
        key: 'board',
        icon: <SquareKanban size={11} />,
        text: `${board.owner.login}/${board.title}`,
        hint: `${board.public ? 'Public' : 'Private'} project #${board.number} — click to copy URL`,
        onClick: () => {
          void navigator.clipboard?.writeText(board.url).catch(() => undefined);
        }
      },
      {
        key: 'items',
        text: `${openCount} open / ${live.length} items${archived > 0 ? ` (+${archived} archived)` : ''}`,
        tone: openCount > 0 ? 'accent' : 'ok',
        hint: 'Open items on this board'
      }
    ];
    if (board.truncated) {
      segments.push({ key: 'truncated', text: 'truncated', tone: 'warn', hint: 'Board has more items than were fetched' });
    }
    if (auth.login) {
      segments.push({ key: 'login', text: `gh: ${auth.login}`, hint: 'GitHub CLI identity' });
    }
    publishStatus('projects', segments);
  }, [auth, board, loadingBoard]);

  /* ---------- sidebar collapse (same mechanics as the other subsystems) ---------- */
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedCollapse(PROJECTS_SIDEBAR_STORAGE_KEY, onSidebarCollapsedChange);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const restoringSidebarRef = useRef(false);
  // Persisted width: localStorage cache for instant boot, desk.yml as truth.
  const initialWidthRef = useRef(
    readStoredSidebarWidth(localStorage.getItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}projects`)) ?? 180
  );
  const sidebarWidthRef = useRef(initialWidthRef.current);
  const widthPersisterRef = useRef<((px: number) => void) | null>(null);
  if (widthPersisterRef.current === null) {
    widthPersisterRef.current = createSidebarWidthPersister('projects', (sidebars) => saveSettings({ sidebars }));
  }
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const sidebarAnimTimerRef = useRef<number | undefined>(undefined);
  const pendingSnapCollapseRef = useRef(false);
  const collapseSidebarRef = useRef<() => void>(() => undefined);
  const toggleSidebarRef = useRef<() => void>(() => undefined);


  useEffect(() => {
    // desk.yml width arrived (or changed in another browser): adopt it.
    if (serverSidebarWidth === undefined) {
      return;
    }
    const width = clampSidebarWidth(serverSidebarWidth);
    if (width === sidebarWidthRef.current) {
      return;
    }
    sidebarWidthRef.current = width;
    localStorage.setItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}projects`, String(width));
    if (!sidebarPanelRef.current?.isCollapsed()) {
      restoringSidebarRef.current = true;
      sidebarPanelRef.current?.resize(`${width}px`);
      window.setTimeout(() => {
        restoringSidebarRef.current = false;
      }, 120);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSidebarWidth]);

  useEffect(() => {
    const onPointerUp = (): void => {
      setSidebarHandleDragActive(false);
      if (pendingSnapCollapseRef.current) {
        pendingSnapCollapseRef.current = false;
        collapseSidebarRef.current();
      }
    };
    document.addEventListener('pointerup', onPointerUp);
    return () => document.removeEventListener('pointerup', onPointerUp);
  }, []);

  useLayoutEffect(() => {
    // The panel group cannot lay out while the mount is display:none, so on
    // activation it re-derives a STALE flexGrow layout (visibly wrong after a
    // window resize). Re-assert collapse state and persisted width
    // synchronously before paint, then once more after the group's
    // ResizeObserver pass, which can overwrite the first fix. The restoring
    // guard + change-only persist keep all of this from echoing back.
    if (!active) {
      restoringSidebarRef.current = false;
      return;
    }
    restoringSidebarRef.current = true;
    const assertLayout = (): void => {
      if (sidebarCollapsed) {
        sidebarPanelRef.current?.collapse();
        return;
      }
      if (sidebarPanelRef.current?.isCollapsed()) {
        sidebarPanelRef.current.expand();
      }
      sidebarPanelRef.current?.resize(`${sidebarWidthRef.current}px`);
    };
    // Double rAF: the group's ResizeObserver measures during the first frame
    // after unhide; resizing before that computes percentages against a stale
    // total ("Invalid panel layout") and corrupts the group. One frame of the
    // re-derived layout may flash; the second pass settles stragglers.
    let secondPass: number | undefined;
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        assertLayout();
        secondPass = window.setTimeout(() => {
          assertLayout();
          window.setTimeout(() => {
            restoringSidebarRef.current = false;
          }, 120);
        }, 80);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(secondPass);
    };
  }, [sidebarCollapsed, active]);

  useEffect(() => {
    registerSidebarToggle?.(() => toggleSidebarRef.current());
  }, [registerSidebarToggle]);

  function markSidebarAnimating(): void {
    document.getElementById('projects-sidebar-tree')?.parentElement?.classList.add('sidebarAnimating');
    setSidebarAnimating(true);
    window.clearTimeout(sidebarAnimTimerRef.current);
    sidebarAnimTimerRef.current = window.setTimeout(() => setSidebarAnimating(false), 340);
  }

  function collapseSidebar(): void {
    markSidebarAnimating();
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.collapse();
    setSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 360);
  }

  function snapCollapseSidebar(): void {
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.collapse();
    setSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 120);
  }
  collapseSidebarRef.current = snapCollapseSidebar;

  function expandSidebar(): void {
    markSidebarAnimating();
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.expand();
    sidebarPanelRef.current?.resize(`${sidebarWidthRef.current}px`);
    setSidebarCollapsed(false);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 360);
  }

  function toggleSidebar(): void {
    if (sidebarCollapsed || sidebarPanelRef.current?.isCollapsed()) {
      expandSidebar();
      return;
    }
    collapseSidebar();
  }
  toggleSidebarRef.current = toggleSidebar;

  function handleSidebarResize(size: PanelSize): void {
    if (!active || restoringSidebarRef.current) {
      return;
    }
    if (isNarrowViewport()) {
      // Overlay drawer (phones): the library's split is virtual — its resize
      // events (mount echoes included) must not drive the drawer state.
      return;
    }
    if (size.inPixels <= 1) {
      pendingSnapCollapseRef.current = false;
      setSidebarCollapsed(true);
      return;
    }
    setSidebarCollapsed(false);
    pendingSnapCollapseRef.current = isAgentSidebarCollapseSize(size.inPixels);
    const width = clampSidebarWidth(size.inPixels);
    if (isSidebarHandleDragActive() && width !== sidebarWidthRef.current) {
      // Only widths from a real handle drag are recorded: mount echoes,
      // unhide relayouts and window scaling all emit resize events too, and
      // persisting those is exactly how widths drift.
      sidebarWidthRef.current = width;
      widthPersisterRef.current?.(width);
    }
  }

  /* ---------- dropdown/menu dismissal ---------- */
  useEffect(() => {
    if (!pickerOpen && !menu) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (pickerRef.current && target && !pickerRef.current.contains(target)) {
        setPickerOpen(false);
      }
      // Only dismiss the context menu when the press is OUTSIDE it. Dismissing
      // unconditionally on pointerdown unmounted the menu before the button's
      // click could land, so every menu action (Open details, Archive, Assign
      // me, Copy URL, Remove) was dead. menuItem's own onClick closes the menu.
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        setMenu(null);
      } else if (!menuRef.current) {
        setMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen, menu]);

  /* ---------- data ---------- */

  const report = useCallback(
    (err: unknown) => {
      if (err instanceof MissingScopeError) {
        setAuth((current) => (current ? { ...current, ok: false, missingScope: true } : { ok: false, login: null, missingScope: true }));
        return;
      }
      onError(err instanceof Error ? err.message : String(err));
    },
    [onError]
  );

  const loadBoard = useCallback(async (id: string, quiet = false, expectedEpoch?: number): Promise<void> => {
    const gen = (boardGenRef.current += quiet ? 0 : 1);
    if (!quiet) {
      setLoadingBoard(true);
    }
    try {
      const next = await projectsBoard(id);
      const current = projectIdRef.current === id && boardGenRef.current === gen;
      // Any guarded fetch (a poll OR the coalesced post-op reload) is stale if a mutation
      // started (epoch changed) or is still in flight since this fetch began — its snapshot
      // must not overwrite newer optimistic state.
      const epochStale =
        expectedEpoch !== undefined && (boardEpochRef.current !== expectedEpoch || opInFlightRef.current > 0);
      if (current && !epochStale) {
        setBoard(next);
        // keep the drawer's item reference fresh
        setActiveItem((currentItem) => (currentItem ? next.items.find((item) => item.id === currentItem.id) ?? null : null));
      }
    } catch (err) {
      report(err);
    } finally {
      if (!quiet) {
        setLoadingBoard(false);
      }
    }
  }, [report]);

  const selectProject = useCallback(
    (id: string | null): void => {
      boardGenRef.current += 1;
      setProjectId(id);
      if (id && isNarrowViewport()) {
        collapseSidebarRef.current(); // drawer behavior on phones
      }
      setBoard(null);
      setActiveItem(null);
      setGroupFieldId(null);
      setSortFieldId(null);
      setFilterText('');
      setPickerOpen(false);
      if (id) {
        localStorage.setItem(PROJECT_STORAGE_KEY, id);
        void loadBoard(id);
      }
    },
    [loadBoard]
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    const pollEpoch = boardEpochRef.current;
    try {
      const list = await projectsList();
      setProjects(list.projects);
    } catch (err) {
      report(err);
      return;
    }
    // Bail if a mutation started while we were fetching — its optimistic state is truth now.
    if (boardEpochRef.current !== pollEpoch || opInFlightRef.current > 0) {
      return;
    }
    const id = projectIdRef.current;
    if (id) {
      await loadBoard(id, true, pollEpoch);
    }
  }, [loadBoard, report]);

  // Lazy boot: auth probe → project list → restore last project.
  useEffect(() => {
    if (!active || booted) {
      return;
    }
    setBooted(true);
    void (async () => {
      try {
        const probe = await projectsAuth();
        setAuth(probe);
        if (!probe.ok) {
          return;
        }
        const list = await projectsList();
        setProjects(list.projects);
        const stored = localStorage.getItem(PROJECT_STORAGE_KEY);
        const open = list.projects.filter((project) => !project.closed);
        const pick = list.projects.find((project) => project.id === stored) ?? open[0] ?? list.projects[0] ?? null;
        selectProject(pick?.id ?? null);
      } catch (err) {
        report(err);
      }
    })();
  }, [active, booted, report, selectProject]);

  useEffect(() => {
    if (!active || !projectId || !auth?.ok) {
      return;
    }
    const timer = window.setInterval(() => {
      // Skip the background reload while any mutation is in flight, otherwise it clobbers
      // the optimistic board (the card snaps back until the op's own reload lands).
      if (opInFlightRef.current === 0) {
        void refreshAll();
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, projectId, auth, refreshAll]);

  /* ---------- mutations (optimistic where cheap, refetch after) ---------- */

  const runOp = useCallback(
    async (operation: () => Promise<unknown>, options: { deploy?: boolean; quietReload?: boolean } = {}): Promise<boolean> => {
      // Single-flight counter + board epoch: overlapping ops all release before the poll
      // unblocks, and the epoch bump invalidates any poll already in flight (its board
      // snapshot predates this optimistic change).
      opInFlightRef.current += 1;
      boardEpochRef.current += 1;
      setOpBusy(true);
      try {
        await operation();
        if (options.deploy) {
          bleeps.deploy?.play();
        }
        return true;
      } catch (err) {
        report(err);
        return false;
      } finally {
        opInFlightRef.current -= 1;
        if (opInFlightRef.current === 0) {
          setOpBusy(false);
          // Coalesced reload after the LAST concurrent op settles: one authoritative sync
          // to server truth (committing successes, rolling back any failed optimistic
          // state) so an earlier op's reload can't clobber a later op still in flight.
          // Guarded by its own epoch: if op B starts during this reload, its epoch bump
          // rejects this now-stale response and B's own last-settler reload wins.
          const id = projectIdRef.current;
          if (id) {
            const reloadEpoch = boardEpochRef.current;
            await loadBoard(id, true, reloadEpoch);
          }
        }
      }
    },
    [bleeps, loadBoard, report]
  );

  /** Optimistically rewrite one item's field value locally before the API call. */
  const applyLocalFieldValue = useCallback((itemId: string, field: ProjectField, payload: FieldValuePayload): void => {
    setBoard((current) => {
      if (!current) {
        return current;
      }
      const items = current.items.map((item) => {
        if (item.id !== itemId) {
          return item;
        }
        const nodes = item.fieldValues.nodes.filter((value) => value.field?.id !== field.id);
        if (!('clear' in payload)) {
          if ('optionId' in payload) {
            const option = field.options?.find((candidate) => candidate.id === payload.optionId);
            nodes.push({ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { id: field.id }, optionId: payload.optionId, name: option?.name, color: option?.color });
          } else if ('iterationId' in payload) {
            const iterations = [...(field.configuration?.iterations ?? []), ...(field.configuration?.completedIterations ?? [])];
            const iteration = iterations.find((candidate) => candidate.id === payload.iterationId);
            nodes.push({ __typename: 'ProjectV2ItemFieldIterationValue', field: { id: field.id }, iterationId: payload.iterationId, title: iteration?.title });
          } else if ('text' in payload) {
            nodes.push({ __typename: 'ProjectV2ItemFieldTextValue', field: { id: field.id }, text: payload.text });
          } else if ('number' in payload) {
            nodes.push({ __typename: 'ProjectV2ItemFieldNumberValue', field: { id: field.id }, number: payload.number });
          } else if ('date' in payload) {
            nodes.push({ __typename: 'ProjectV2ItemFieldDateValue', field: { id: field.id }, date: payload.date });
          }
        }
        return { ...item, fieldValues: { nodes } };
      });
      return { ...current, items };
    });
  }, []);

  const handleSetField = useCallback(
    (item: ProjectItem, field: ProjectField, payload: FieldValuePayload): void => {
      const id = projectIdRef.current;
      if (!id) {
        return;
      }
      applyLocalFieldValue(item.id, field, payload);
      void runOp(() => setFieldValue(id, item.id, field.id, payload));
    },
    [applyLocalFieldValue, runOp]
  );

  /* ---------- derived render data ---------- */

  const fields = useMemo(() => board?.fields.nodes ?? [], [board]);
  const groupCandidates = useMemo(() => groupableFields(fields), [fields]);
  const groupField = useMemo(
    () => groupCandidates.find((field) => field.id === groupFieldId) ?? groupCandidates.find((field) => field.name === 'Status') ?? groupCandidates[0] ?? null,
    [groupCandidates, groupFieldId]
  );
  const sortField = useMemo(() => fields.find((field) => field.id === sortFieldId) ?? null, [fields, sortFieldId]);
  const filter = useMemo(() => parseFilter(filterText), [filterText]);

  const visibleItems = useMemo(() => {
    let items = (board?.items ?? []).filter((item) => showArchived || !item.isArchived);
    items = items.filter((item) => matchesFilter(item, filter, fields));
    return sortItems(items, sortField, sortDirection);
  }, [board, filter, fields, sortField, sortDirection, showArchived]);

  const columns = useMemo(
    () => (groupField ? groupItems(visibleItems, groupField) : []),
    [visibleItems, groupField]
  );

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const visibleProjects = projects.filter((project) => showClosed || !project.closed || project.id === projectId);
  const latestStatus = board?.statusUpdates.nodes[0] ?? null;

  /* ---------- item operations ---------- */

  const moveToColumn = useCallback(
    (item: ProjectItem, column: BoardColumn): void => {
      if (!groupField) {
        return;
      }
      const current = valueFor(item, groupField.id);
      if ((current?.optionId ?? current?.iterationId ?? null) === (column.optionId ?? column.iterationId)) {
        return;
      }
      const payload: FieldValuePayload = column.optionId
        ? { optionId: column.optionId }
        : column.iterationId
          ? { iterationId: column.iterationId }
          : { clear: true };
      handleSetField(item, groupField, payload);
    },
    [groupField, handleSetField]
  );

  const dropOnCard = useCallback(
    (item: ProjectItem, column: BoardColumn, after: ProjectItem): void => {
      const id = projectIdRef.current;
      if (!id || !groupField) {
        return;
      }
      const current = valueFor(item, groupField.id);
      const sameColumn =
        (current?.optionId ?? current?.iterationId ?? null) === (column.optionId ?? column.iterationId ?? null);
      const payload: FieldValuePayload = column.optionId
        ? { optionId: column.optionId }
        : column.iterationId
          ? { iterationId: column.iterationId }
          : { clear: true };
      if (!sameColumn) {
        applyLocalFieldValue(item.id, groupField, payload);
      }
      // Sequence the field move then the position move inside ONE runOp so a single
      // reload reflects both — two independent runOps raced and snapped the card back.
      void runOp(async () => {
        if (!sameColumn) {
          await setFieldValue(id, item.id, groupField.id, payload);
        }
        await moveItemPosition(id, item.id, after.id);
      });
    },
    [groupField, applyLocalFieldValue, runOp]
  );

  const openOnGitHub = useCallback((item: ProjectItem): void => {
    if (item.content?.url) {
      window.open(item.content.url, '_blank', 'noopener');
    }
  }, []);

  const assignSelf = useCallback(
    (item: ProjectItem): void => {
      const login = auth?.login;
      const repo = item.content?.repository?.nameWithOwner;
      const number = item.content?.number;
      if (!login || !repo || number === undefined) {
        return;
      }
      void runOp(
        () => editIssue(repo, number, item.type === 'PULL_REQUEST' ? 'pr' : 'issue', { addAssignees: [login] }),
        { deploy: true }
      );
    },
    [auth, runOp]
  );

  const issueState = useCallback(
    (item: ProjectItem, state: 'close' | 'reopen'): void => {
      const repo = item.content?.repository?.nameWithOwner;
      const number = item.content?.number;
      if (!repo || number === undefined) {
        return;
      }
      void runOp(() => editIssue(repo, number, item.type === 'PULL_REQUEST' ? 'pr' : 'issue', { state }), { deploy: true }).then(() =>
        setDrawerRevision((value) => value + 1)
      );
    },
    [runOp]
  );

  const archiveToggle = useCallback(
    (item: ProjectItem): void => {
      const id = projectIdRef.current;
      if (id) {
        void runOp(() => archiveItem(id, item.id, item.isArchived), { deploy: true });
      }
    },
    [runOp]
  );

  const sendComment = useCallback(
    async (item: ProjectItem, body: string): Promise<boolean> => {
      const repo = item.content?.repository?.nameWithOwner;
      const number = item.content?.number;
      if (!repo || number === undefined) {
        return false;
      }
      const ok = await runOp(() => commentOnItem(repo, number, item.type === 'PULL_REQUEST' ? 'pr' : 'issue', body));
      if (ok) {
        setDrawerRevision((value) => value + 1);
      }
      return ok;
    },
    [runOp]
  );

  const saveDraft = useCallback(
    (item: ProjectItem, title: string, body: string): void => {
      const draftId = item.content?.id;
      if (draftId) {
        void runOp(() => editDraft(draftId, title, body), { deploy: true }).then(() => setDrawerRevision((value) => value + 1));
      }
    },
    [runOp]
  );

  /* ---------- modal submit ---------- */

  const submitModal = useCallback((): void => {
    const id = projectIdRef.current;
    const text = modalText.trim();
    if (!modal) {
      return;
    }
    if (modal.kind === 'add-item' && id) {
      if (text === '') {
        return;
      }
      setModal(null);
      if (/^https:\/\/github\.com\//.test(text)) {
        void runOp(() => addItemByUrl(id, text), { deploy: true });
      } else {
        void runOp(
          async () => {
            const created = await createDraft(id, text, modalBody.trim() || undefined);
            const column = modal.column;
            if (column && groupField && (column.optionId || column.iterationId)) {
              await setFieldValue(
                id,
                created.itemId,
                groupField.id,
                column.optionId ? { optionId: column.optionId } : { iterationId: column.iterationId! }
              );
            }
          },
          { deploy: true }
        );
      }
    } else if (modal.kind === 'convert-draft') {
      if (text === '') {
        return;
      }
      setModal(null);
      void runOp(() => convertDraft(modal.item.id, text), { deploy: true });
    } else if (modal.kind === 'status-update' && id) {
      if (text === '') {
        return;
      }
      setModal(null);
      void runOp(() => postStatusUpdate(id, text, modalStatus), { deploy: true });
    } else if (modal.kind === 'new-project') {
      if (text === '' || modalOwner === '') {
        return;
      }
      setModal(null);
      void (async () => {
        try {
          const created = await createProject(modalOwner, text);
          onInfo(`Project created: ${text}`);
          const list = await projectsList();
          setProjects(list.projects);
          selectProject(created.project.id);
        } catch (err) {
          report(err);
        }
      })();
    } else if (modal.kind === 'link-repo' && id) {
      if (text === '') {
        return;
      }
      setModal(null);
      void runOp(() => linkProjectRepo(id, text), { deploy: true }).then((ok) => {
        if (ok) {
          onInfo(`Linked ${text}`);
        }
      });
    } else if (modal.kind === 'delete-item' && id) {
      setModal(null);
      setActiveItem((current) => (current?.id === modal.item.id ? null : current));
      void runOp(() => deleteItem(id, modal.item.id), { deploy: true });
    }
  }, [modal, modalText, modalBody, modalStatus, modalOwner, groupField, runOp, report, onInfo, selectProject]);

  const openModal = useCallback((next: Exclude<ModalState, null>): void => {
    setModalText('');
    setModalBody('');
    setModalStatus('ON_TRACK');
    if (next.kind === 'new-project') {
      void projectsOwners()
        .then((payload) => {
          setOwners(payload.owners);
          setModalOwner(payload.owners[0]?.id ?? '');
        })
        .catch(report);
    }
    setModal(next);
  }, [report]);

  /* ---------- context menu ---------- */

  const itemMenu = (event: MouseEvent, item: ProjectItem): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, item });
  };

  const menuItem = (icon: ReactNode, label: string, danger: boolean, action: () => void): JSX.Element => (
    <Animator key={label}>
      <Animated animated={['fade', ['x', -6, 0]]}>
        <button
          type="button"
          className={`treeMenuItem ${danger ? 'treeMenuDanger' : ''}`}
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
            setMenu(null);
            action();
          }}
        >
          {icon}
          {label}
        </button>
      </Animated>
    </Animator>
  );

  /* ---------- render ---------- */

  const authGate = auth && !auth.ok;

  return (
    <Group
      orientation="horizontal"
      className={`subsystemPanels editorPanels ${sidebarCollapsed ? 'editorSidebarCollapsed' : ''} ${sidebarAnimating ? 'sidebarAnimating' : ''}`}
      id="desk-projects-sidebar-v1"
    >
      <Panel
        id="projects-sidebar-tree"
        panelRef={sidebarPanelRef}
        defaultSize={`${initialWidthRef.current}px`}
        minSize={AGENT_SIDEBAR_MIN_SIZE}
        maxSize={AGENT_SIDEBAR_MAX_SIZE}
        collapsedSize="0px"
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleSidebarResize}
        className="editorTreePanel"
      >
        <aside className="editorTreePanelInner editorSidebar projSidebar">
          <div className="sidebarHeader">
            <div className="railTitle">
              <SquareKanban size={12} />
              <TextReveal as="span" manager="decipher">Projects</TextReveal>
            </div>
            <div className="railActions">
              <IconButton
                icon={<Plus size={12} />}
                label="New project"
                disabled={authGate === true}
                onClick={() => openModal({ kind: 'new-project' })}
              />
              <IconButton
                icon={<RefreshCw size={12} />}
                label="Refresh"
                disabled={authGate === true}
                onClick={() => void refreshAll()}
              />
              <IconButton icon={<HelpCircle size={12} />} label="Help" onClick={() => setProjectsHelpOpen(true)} />
            </div>
          </div>

          <div className="editorRootSelect" ref={pickerRef}>
            <button
              type="button"
              className={`editorRootButton ${pickerOpen ? 'open' : ''}`}
              style={{ clipPath: CLIP_OCTAGON_TINY }}
              title={selectedProject ? `${selectedProject.owner.login} / ${selectedProject.title}` : 'Pick project'}
              onMouseEnter={() => bleeps.hover?.play()}
              onClick={() => {
                bleeps.click?.play();
                setPickerOpen((open) => !open);
              }}
            >
              <SquareKanban size={12} />
              <span className="editorRootPath">
                {selectedProject ? selectedProject.title : projects.length === 0 ? 'no projects' : 'select project…'}
              </span>
              <ChevronDown size={12} className={pickerOpen ? 'flip' : ''} />
            </button>
            {pickerOpen ? (
              <Animator combine manager="stagger" duration={{ enter: 0.18, stagger: 0.02 }}>
                <Animated className="editorRootPanel" animated={['fade', ['y', -6, 0]]} style={{ clipPath: CLIP_OCTAGON_TINY }}>
                  {visibleProjects.map((project) => (
                    <Animator key={project.id}>
                      <Animated
                        as="button"
                        type="button"
                        className={`deskSelectOption gitRepoOption ${project.id === projectId ? 'selected' : ''}`}
                        animated={['flicker']}
                        title={`${project.owner.login}/${project.title} (#${project.number})`}
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          selectProject(project.id);
                        }}
                      >
                        <SquareKanban size={11} />
                        <span className="gitRepoName">{project.title}</span>
                        <small className="gitRepoBranch">{project.owner.login}</small>
                        {project.closed ? <Pill tone="muted">closed</Pill> : <Pill>{project.items.totalCount}</Pill>}
                      </Animated>
                    </Animator>
                  ))}
                  <Animator>
                    <Animated
                      as="button"
                      type="button"
                      className="deskSelectOption"
                      animated={['flicker']}
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        setShowClosed((value) => !value);
                      }}
                    >
                      <ScanEye size={11} />
                      <span>{showClosed ? 'hide closed projects' : 'show closed projects'}</span>
                    </Animated>
                  </Animator>
                </Animated>
              </Animator>
            ) : null}
          </div>

          {board ? (
            <>
              <Animator>
                <Animated className="gitHubCard projMetaCard" animated={['flicker', ['y', -4, 0]]} style={{ clipPath: CLIP_OCTAGON_TINY }}>
                  <span className="gitHubName" title={board.shortDescription ?? board.title}>
                    <TextReveal as="span" manager="decipher">{`${board.owner.login} / #${board.number}`}</TextReveal>
                  </span>
                  <Pill tone="muted">{board.public ? 'public' : 'private'}</Pill>
                  {board.closed ? <Pill tone="warn">closed</Pill> : null}
                  <IconButton icon={<Link2 size={11} />} label="Link a repository" onClick={() => openModal({ kind: 'link-repo' })} />
                  <IconButton
                    icon={<ExternalLink size={11} />}
                    label="Open on GitHub"
                    onClick={() => window.open(board.url, '_blank', 'noopener')}
                  />
                </Animated>
              </Animator>
              {board.shortDescription ? <div className="projDescription">{board.shortDescription}</div> : null}

              <div className="projSideSection">
                <div className="gitGroupHeader">
                  <TextReveal as="span" manager="decipher" className="gitGroupLabel">Status</TextReveal>
                  {latestStatus ? (
                    <Pill tone={STATUS_TONES[latestStatus.status].tone === 'error' ? 'warn' : (STATUS_TONES[latestStatus.status].tone as 'ok' | 'warn' | 'muted')}>
                      {STATUS_TONES[latestStatus.status].label}
                    </Pill>
                  ) : (
                    <Pill tone="muted">none</Pill>
                  )}
                  <span className="gitRowActions">
                    <IconButton icon={<MessageSquarePlus size={11} />} label="Post status update" onClick={() => openModal({ kind: 'status-update' })} />
                  </span>
                </div>
                {board.statusUpdates.nodes.slice(0, 3).map((update) => (
                  <div key={update.id} className={`projStatusUpdate ${update.status.toLowerCase()}`} title={update.body}>
                    <header>
                      <i className={`projStatusDot ${update.status.toLowerCase()}`} />
                      <strong>{STATUS_TONES[update.status].label}</strong>
                      <small>
                        @{update.creator?.login ?? '?'} · {new Date(update.createdAt).toLocaleDateString()}
                      </small>
                    </header>
                    <span>{update.body}</span>
                  </div>
                ))}
              </div>

              {board.views.nodes.length > 0 ? (
                <div className="projSideSection">
                  <div className="gitGroupHeader">
                    <TextReveal as="span" manager="decipher" className="gitGroupLabel">Views</TextReveal>
                    <Pill tone="muted">read-only</Pill>
                  </div>
                  {board.views.nodes.map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      className="projViewRow"
                      title={view.filter ?? view.name}
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        setFilterText(view.filter ?? '');
                        setLayout(view.layout === 'TABLE_LAYOUT' ? 'table' : 'board');
                      }}
                    >
                      {view.layout === 'TABLE_LAYOUT' ? <Rows3 size={11} /> : <LayoutGrid size={11} />}
                      <span>{view.name}</span>
                      {view.filter ? <Filter size={9} className="projViewHasFilter" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : authGate ? null : (
            <div className="gitEmptyNote">
              <TextReveal as="span" manager="sequence">{loadingBoard ? 'Loading project…' : 'No project selected.'}</TextReveal>
            </div>
          )}
        </aside>
      </Panel>
      <Separator className="panelResizeHandle" disabled={sidebarCollapsed} onPointerDown={() => setSidebarHandleDragActive(true)} />
      <Panel id="projects-surface" minSize={surfaceMinSize(narrowViewport)} className="subsystemSurface">
        {narrowViewport && !sidebarCollapsed ? (
          <button type="button" className="drawerScrim" aria-label="Close sidebar" onClick={() => collapseSidebarRef.current()} />
        ) : null}
        <main className="editorStage projStage">
          {authGate ? (
            <DeskPanel texture>
              <div className="editorPlaceholder projAuthGate">
                <KeyRound size={28} />
                <TextReveal as="strong" manager="decipher">GitHub Projects needs the `project` token scope.</TextReveal>
                <span className="projAuthDetail">
                  {auth?.login ? `Signed in as ${auth.login}. ` : 'Not signed in to gh. '}
                  Run this in a regular terminal, then re-check:
                </span>
                <code className="projAuthCmd">gh auth refresh -s project</code>
                <Cmd
                  icon={<RefreshCw size={12} />}
                  label="Re-check"
                  onClick={() => {
                    void projectsAuth().then((probe) => {
                      setAuth(probe);
                      if (probe.ok) {
                        setBooted(false); // reboot the subsystem with the new scope
                      }
                    }).catch(report);
                  }}
                />
              </div>
            </DeskPanel>
          ) : board ? (
            <>
              <div className="gitDiffToolbar projToolbar">
                <span className="searchInputRow projFilterRow">
                  <Filter size={11} />
                  <input
                    className="treeInlineInput"
                    placeholder='Filter: text, status:done, -label:bug, is:open, no:iteration'
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                  />
                  {filterText !== '' ? (
                    <IconButton icon={<X size={11} />} label="Clear filter" onClick={() => setFilterText('')} />
                  ) : null}
                </span>
                <Pill tone="muted">{visibleItems.length} / {board.items.length}</Pill>
                {board.truncated ? <Pill tone="warn">truncated</Pill> : null}
                {layout === 'board' && groupCandidates.length > 1 ? (
                  <DeskSelect
                    value={groupField?.id ?? ''}
                    options={groupCandidates.map((field) => ({ value: field.id, label: `by ${field.name}` }))}
                    onChange={(value) => setGroupFieldId(value)}
                  />
                ) : null}
                <span className="gitRowActions">
                  <IconButton
                    icon={showArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                    label={showArchived ? 'Hide archived' : 'Show archived'}
                    onClick={() => setShowArchived((value) => !value)}
                  />
                  <IconButton
                    icon={<FilePlus2 size={12} />}
                    label="Add item (URL or draft)"
                    onClick={() => openModal({ kind: 'add-item', column: null })}
                  />
                  <IconButton
                    icon={layout === 'board' ? <Rows3 size={12} /> : <LayoutGrid size={12} />}
                    label={layout === 'board' ? 'Table layout' : 'Board layout'}
                    onClick={() => {
                      bleeps.slide?.play();
                      setLayout((current) => (current === 'board' ? 'table' : 'board'));
                    }}
                  />
                </span>
              </div>
              <div className="projStageBody">
                {layout === 'board' && groupField ? (
                  <BoardView
                    columns={columns}
                    activeItemId={activeItem?.id ?? null}
                    onSelectItem={setActiveItem}
                    onItemMenu={itemMenu}
                    onMoveToColumn={moveToColumn}
                    onDropOnCard={dropOnCard}
                    onAddToColumn={(column) => openModal({ kind: 'add-item', column })}
                  />
                ) : (
                  <TableView
                    items={visibleItems}
                    fields={fields}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    activeItemId={activeItem?.id ?? null}
                    onSort={(field) => {
                      if (sortFieldId === field.id) {
                        setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
                      } else {
                        setSortFieldId(field.id);
                        setSortDirection('asc');
                      }
                    }}
                    onSelectItem={setActiveItem}
                    onItemMenu={itemMenu}
                    onSetField={handleSetField}
                  />
                )}
                <ItemDrawer
                  item={activeItem}
                  fields={fields}
                  viewerLogin={auth?.login ?? null}
                  revision={drawerRevision}
                  onClose={() => setActiveItem(null)}
                  onSetField={handleSetField}
                  onIssueState={issueState}
                  onAssignSelf={assignSelf}
                  onComment={sendComment}
                  onArchive={archiveToggle}
                  onConvertDraft={(item) => openModal({ kind: 'convert-draft', item })}
                  onEditDraft={saveDraft}
                  onOpenExternal={openOnGitHub}
                  onError={report}
                />
              </div>
            </>
          ) : (
            <DeskPanel texture>
              <div className="editorPlaceholder">
                <TextReveal as="span" manager="sequence">
                  {loadingBoard ? 'Loading project…' : 'Select or create a GitHub Project to begin.'}
                </TextReveal>
              </div>
            </DeskPanel>
          )}
        </main>
      </Panel>

      {menu ? (
        <div ref={menuRef} className="treeContextMenu" style={{ left: menu.x, top: menu.y, clipPath: CLIP_OCTAGON_TINY }}>
          <Animator combine manager="stagger" duration={{ stagger: 0.015 }}>
            {menuItem(<ScanEye size={12} />, 'Open details', false, () => setActiveItem(menu.item))}
            {menu.item.content?.url
              ? menuItem(<ExternalLink size={12} />, 'Open on GitHub', false, () => openOnGitHub(menu.item))
              : null}
            {groupField && groupField.dataType === 'SINGLE_SELECT'
              ? (groupField.options ?? []).slice(0, 6).map((option) => (
                  <Animator key={option.id}>
                    <Animated animated={['fade', ['x', -6, 0]]}>
                      <button
                        type="button"
                        className="treeMenuItem"
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          setMenu(null);
                          handleSetField(menu.item, groupField, { optionId: option.id });
                        }}
                      >
                        <i className="projColumnDot" style={{ background: optionColor(option.color) }} />
                        {option.name}
                      </button>
                    </Animated>
                  </Animator>
                ))
              : null}
            {menu.item.content?.repository && auth?.login
              ? menuItem(<UserPlus size={12} />, 'Assign me', false, () => assignSelf(menu.item))
              : null}
            {menuItem(
              menu.item.isArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />,
              menu.item.isArchived ? 'Unarchive' : 'Archive',
              false,
              () => archiveToggle(menu.item)
            )}
            {menu.item.content?.url
              ? menuItem(<Copy size={12} />, 'Copy URL', false, () => {
                  void navigator.clipboard.writeText(menu.item.content!.url!).catch(() => undefined);
                })
              : null}
            {menuItem(<Trash2 size={12} />, 'Remove from project', true, () => openModal({ kind: 'delete-item', item: menu.item }))}
          </Animator>
        </div>
      ) : null}

      {renderModal()}

      {projectsHelpOpen ? (
        <Modal title="Projects" icon={<SquareKanban size={13} />} onClose={() => setProjectsHelpOpen(false)}>
          <div style={{ padding: '16px 14px', color: 'var(--desk-text-dim)', fontSize: '12px', lineHeight: '1.5' }}>
            <div>GitHub Projects are structured issue trackers that integrate with repositories. Desk syncs project boards to organize work, track issues, and coordinate pull requests across your agent teams.</div>
            <div style={{ marginTop: '12px' }}>Each GitHub Project becomes a working space in Desk. Create agent groups within projects to divide work by feature, milestone, or team. Items on the board include issues, drafts, and pull requests with full details and custom fields.</div>
            <div style={{ marginTop: '12px' }}>Use the plus icon (+) to connect a new GitHub Project, or refresh to sync the latest changes. Filter items by status, label, iteration, or custom fields. Archive completed projects while preserving history for future reference.</div>
            <div style={{ marginTop: '12px' }}>
              <a href="https://docs.desk.cloud/github-projects/" target="_blank" rel="noopener noreferrer" style={{ color: '#4dd9ff', textDecoration: 'underline', cursor: 'pointer' }}>
                Read full documentation →
              </a>
            </div>
          </div>
        </Modal>
      ) : null}
    </Group>
  );

  function renderModal(): ReactNode {
    if (!modal) {
      return null;
    }
    if (modal.kind === 'delete-item') {
      return (
        <Modal title="Remove item" icon={<Trash2 size={13} />} tone="danger" onClose={() => setModal(null)}>
          <div className="confirmBody">
            <span>
              Remove <strong>{modal.item.content?.title ?? 'item'}</strong> from the project?
              {modal.item.type === 'DRAFT_ISSUE' ? ' Drafts are deleted permanently.' : ' The issue/PR itself is kept.'}
            </span>
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setModal(null)} />
              <Cmd icon={<Trash2 size={12} />} label="Remove" tone="danger" onClick={submitModal} />
            </div>
          </div>
        </Modal>
      );
    }
    const meta: Record<string, { title: string; icon: ReactNode; placeholder: string; multiline?: boolean; help?: string }> = {
      'add-item': {
        title: modal.kind === 'add-item' && modal.column ? `Add to ${modal.column.label}` : 'Add item',
        icon: <FilePlus2 size={13} />,
        placeholder: 'Issue/PR URL — or a title to create a draft'
      },
      'convert-draft': { title: 'Convert draft to issue', icon: <FilePlus2 size={13} />, placeholder: 'owner/repo' },
      'status-update': { title: 'Post status update', icon: <MessageSquarePlus size={13} />, placeholder: 'What changed?', multiline: true },
      'new-project': {
        title: 'New project',
        icon: <Plus size={13} />,
        placeholder: 'Project title',
        help: 'Create a new GitHub project for organizing work. Select an owner (user or organization), enter a project title, and specify the working directory where Desk will manage this project.'
      },
      'link-repo': { title: 'Link repository', icon: <Link2 size={13} />, placeholder: 'owner/repo' }
    };
    const entry = meta[modal.kind]!;
    return (
      <Modal title={entry.title} icon={entry.icon} help={entry.help} onClose={() => setModal(null)}>
        <div className="thinForm modalForm">
          {modal.kind === 'new-project' ? (
            <DeskSelect
              value={modalOwner}
              options={owners.map((owner) => ({ value: owner.id, label: `${owner.login} (${owner.kind})` }))}
              placeholder="Owner"
              onChange={setModalOwner}
            />
          ) : null}
          {modal.kind === 'status-update' ? (
            <DeskSelect
              value={modalStatus}
              options={(Object.keys(STATUS_TONES) as Array<ProjectStatusUpdate['status']>).map((status) => ({
                value: status,
                label: STATUS_TONES[status].label
              }))}
              onChange={(value) => setModalStatus(value as ProjectStatusUpdate['status'])}
            />
          ) : null}
          {entry.multiline ? (
            <textarea
              className="gitCommitInput"
              rows={4}
              autoFocus
              placeholder={entry.placeholder}
              value={modalText}
              onChange={(event) => setModalText(event.target.value)}
            />
          ) : (
            <input
              className="treeInlineInput"
              autoFocus
              placeholder={entry.placeholder}
              value={modalText}
              onChange={(event) => setModalText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submitModal();
                }
              }}
            />
          )}
          {modal.kind === 'add-item' && !/^https:\/\/github\.com\//.test(modalText) && modalText.trim() !== '' ? (
            <textarea
              className="gitCommitInput"
              rows={3}
              placeholder="Draft body (optional, markdown)"
              value={modalBody}
              onChange={(event) => setModalBody(event.target.value)}
            />
          ) : null}
          <div className="confirmActions">
            <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setModal(null)} />
            <Cmd icon={entry.icon} label="Confirm" disabled={opBusy || modalText.trim() === ''} onClick={submitModal} />
          </div>
        </div>
      </Modal>
    );
  }
}
