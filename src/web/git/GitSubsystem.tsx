import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloudDownload,
  Columns2,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
  HelpCircle,
  RefreshCw,
  Rows2,
  Star,
  Upload,
  X
} from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import { formatAheadBehind, gitStatusCounts, publishStatus, type StatusSegment } from '../statusSegments.js';
import { CLIP_OCTAGON_TINY, Cmd, DeskPanel, IconButton, Modal, Pill, TextReveal } from '../arwes/primitives.js';
import {
  AGENT_SIDEBAR_MAX_SIZE,
  AGENT_SIDEBAR_MIN_SIZE,
  GIT_SIDEBAR_STORAGE_KEY,
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
import { fetchSettings, saveSettings } from '../api.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { fsHome, fsValidate } from '../editor/fsClient.js';
import { EditorTabs, type TabMeta } from '../editor/EditorTabs.js';
import { closeTab, fileNameOf, moveTab, openTab } from '../editor/editorState.js';
import { initMonaco, languageForPath, monaco } from '../editor/monacoSetup.js';
import { ChangesPanel, type ChangeGroup } from './ChangesPanel.js';
import { BranchesPanel } from './BranchesPanel.js';
import { HistoryPanel } from './HistoryPanel.js';
import { DiffHost, type DiffModels } from './DiffHost.js';
import {
  gitBranchDiff,
  gitBranches,
  gitBrowseUrl,
  gitCheckout,
  gitCommit,
  gitCommitDetail,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiff,
  gitDiscard,
  gitGitHubInfo,
  gitLog,
  gitRemoveWorktree,
  gitRepos,
  gitRevert,
  gitStage,
  gitStatus,
  gitSync,
  gitUnstage,
  type GitBranchesInfo,
  type GitBranchRef,
  type GitCommitDetail,
  type GitCommitFile,
  type GitDiffMode,
  type GitHubInfo,
  type GitLogCommit,
  type GitRepoSummary,
  type GitStatus,
  type GitStatusEntry,
  type GitSyncOp,
  type GitWorktree
} from './gitClient.js';
import { bumpGitRevision } from '../gitRevision.js';
import { getEditorRoot, useEditorRoot } from '../editorRoot.js';

const REPO_STORAGE_KEY = 'desk.gitRepo';
const STATUS_POLL_MS = 3000;
const LOG_PAGE = 60;

interface DiffSpec {
  key: string;
  path: string;
  origPath?: string;
  mode: GitDiffMode;
  sha?: string;
  /** range mode: merge-base sha + branch ref */
  range?: { base: string; ref: string };
  label: string;
}

const REPO_RECENTS_KEY = 'desk.gitRepoRecents';

function readRepoRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REPO_RECENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function recordRepoRecent(path: string): void {
  const next = [path, ...readRepoRecents().filter((item) => item !== path)].slice(0, 8);
  localStorage.setItem(REPO_RECENTS_KEY, JSON.stringify(next));
}

interface DiffEntry {
  models: DiffModels | null;
  error: 'binary' | 'too-large' | null;
  loading: boolean;
}

export interface GitNavigateTarget {
  /** absolute repo root to select */
  repo: string;
  /** repo-relative file: opens its diff (worktree, or the commit when sha set) */
  path?: string;
  sha?: string;
}

export function GitSubsystem({
  active,
  onError,
  onOpenFile,
  onRevealInExplorer,
  onSidebarCollapsedChange,
  registerSidebarToggle,
  registerNavigator,
  serverSidebarWidth
}: {
  active: boolean;
  /** open a file (absolute path) in the editor subsystem */
  onOpenFile: (path: string) => void;
  /** open + reveal a file (absolute path) in the editor's explorer tree */
  onRevealInExplorer?: (path: string) => void;
  onError: (message: string) => void;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  registerSidebarToggle?: (toggle: () => void) => void;
  /** registers a navigator so the editor can jump here (repo / diff / commit) */
  registerNavigator?: (navigate: (target: GitNavigateTarget) => void) => void;
  /** width from desk.yml (arrives after the settings fetch); reconciles the panel */
  serverSidebarWidth?: number;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const narrowViewport = useNarrowViewport();
  const [booted, setBooted] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitRepoSummary[]>([]);
  const [scanning, setScanning] = useState(false);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [github, setGithub] = useState<GitHubInfo | null>(null);
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [details, setDetails] = useState<Map<string, GitCommitDetail>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  // Branches starts collapsed: the split keeps its familiar two-section look
  // until the explorer is asked for.
  const [branchesCollapsed, setBranchesCollapsed] = useState(true);
  const [branchesInfo, setBranchesInfo] = useState<GitBranchesInfo>({ branches: [], worktrees: [] });
  const branchesPanelSectionRef = useRef<PanelImperativeHandle | null>(null);
  const changesPanelRef = useRef<PanelImperativeHandle | null>(null);
  const historyPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [opBusy, setOpBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState('');
  // Branch compare WITHOUT checkout: ref → files vs merge-base(HEAD, ref).
  const [compare, setCompare] = useState<{ ref: string; baseSha: string; refSha: string; files: GitCommitFile[]; loading: boolean } | null>(null);
  const [branchFrom, setBranchFrom] = useState<string | null>(null);
  const [branchName, setBranchName] = useState('');
  const [sideBySide, setSideBySide] = useState(true);
  const [gitHelpOpen, setGitHelpOpen] = useState(false);
  const repoSearchRef = useRef<HTMLInputElement | null>(null);

  // Repo picker: filter + recents-first grouping. Recents re-read per open.
  const pickerGroups = useMemo(() => {
    const query = repoQuery.trim().toLowerCase();
    if (query !== '') {
      const matches = repos
        .filter((repo) => repo.name.toLowerCase().includes(query) || repo.path.toLowerCase().includes(query))
        .sort((a, b) => {
          const aIndex = a.name.toLowerCase().indexOf(query);
          const bIndex = b.name.toLowerCase().indexOf(query);
          return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex) || a.name.localeCompare(b.name);
        });
      return [{ label: '', repos: matches }];
    }
    const byPath = new Map(repos.map((repo) => [repo.path, repo]));
    const recents = readRepoRecents()
      .map((path) => byPath.get(path))
      .filter((repo): repo is GitRepoSummary => repo !== undefined);
    if (recents.length === 0) {
      return [{ label: '', repos: [...repos].sort((a, b) => a.name.localeCompare(b.name)) }];
    }
    const recentSet = new Set(recents.map((repo) => repo.path));
    const rest = repos.filter((repo) => !recentSet.has(repo.path)).sort((a, b) => a.name.localeCompare(b.name));
    return [
      { label: 'Recent', repos: recents },
      { label: 'All repos', repos: rest }
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, repoQuery, pickerOpen]);

  // Focus the filter on open (twice: the panel animates in and can re-grab).
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const focus = (): void => repoSearchRef.current?.focus();
    const raf = window.requestAnimationFrame(focus);
    const timer = window.setTimeout(focus, 160);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [pickerOpen]);

  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((value) => value + 1), []);

  const tabsRef = useRef<string[]>([]);
  const activeTabRef = useRef<string | null>(null);
  const specsRef = useRef(new Map<string, DiffSpec>());
  const diffsRef = useRef(new Map<string, DiffEntry>());
  const statusFingerprintRef = useRef('');
  const repoRef = useRef<string | null>(null);
  repoRef.current = repoPath;
  const rootRef = useRef<string | null>(null);
  rootRef.current = root;
  // Bumped on repo switches; async flows abort when stale.
  const repoGenRef = useRef(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // Inbound editor→git navigation (declared early: scanRepos drains it).
  const pendingNavRef = useRef<GitNavigateTarget | null>(null);
  const applyNavigateRef = useRef<(target: GitNavigateTarget) => void>(() => undefined);
  const scanningRef = useRef(false);
  const drainPendingNavRef = useRef<() => void>(() => undefined);

  /* ---------- sidebar collapse (same mechanics as EditorSubsystem) ---------- */
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedCollapse(GIT_SIDEBAR_STORAGE_KEY, onSidebarCollapsedChange);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const restoringSidebarRef = useRef(false);
  // Persisted width: localStorage cache for instant boot, desk.yml as truth.
  const initialWidthRef = useRef(
    readStoredSidebarWidth(localStorage.getItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}git`)) ?? 180
  );
  const sidebarWidthRef = useRef(initialWidthRef.current);
  const widthPersisterRef = useRef<((px: number) => void) | null>(null);
  if (widthPersisterRef.current === null) {
    widthPersisterRef.current = createSidebarWidthPersister('git', (sidebars) => saveSettings({ sidebars }));
  }
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const sidebarAnimTimerRef = useRef<number | undefined>(undefined);
  const pendingSnapCollapseRef = useRef(false);
  const collapseSidebarRef = useRef<() => void>(() => undefined);
  const toggleSidebarRef = useRef<() => void>(() => undefined);


  // Bottom status bar context: repo, branch, sync arrows, working-tree counts.
  useEffect(() => {
    if (!repoPath) {
      publishStatus('git', [
        { key: 'repo', icon: <FolderGit2 size={11} />, text: 'no repository selected', hint: 'Pick a repository in the sidebar' }
      ]);
      return;
    }
    const repoName = repos.find((repo) => repo.path === repoPath)?.name ?? repoPath.split('/').filter(Boolean).at(-1) ?? repoPath;
    const segments: StatusSegment[] = [
      { key: 'repo', icon: <FolderGit2 size={11} />, text: repoName, hint: repoPath }
    ];
    const info = status?.branchInfo;
    if (info) {
      segments.push({
        key: 'branch',
        icon: <GitBranch size={11} />,
        text: info.detached ? `detached @ ${info.oid?.slice(0, 7) ?? '?'}` : info.branch ?? '?',
        tone: info.detached ? 'warn' : undefined,
        hint: info.upstream ? `Tracking ${info.upstream}` : 'No upstream'
      });
      const arrows = formatAheadBehind(info.ahead, info.behind);
      if (arrows) {
        segments.push({
          key: 'sync',
          text: arrows,
          tone: info.behind > 0 ? 'warn' : 'accent',
          hint: `${info.ahead} ahead, ${info.behind} behind ${info.upstream ?? 'upstream'}`
        });
      }
      const counts = gitStatusCounts(status.entries);
      if (counts.conflicted > 0) {
        segments.push({ key: 'conflicts', text: `${counts.conflicted} conflicts`, tone: 'danger' });
      }
      if (counts.staged > 0 || counts.changed > 0) {
        segments.push({
          key: 'changes',
          text: `${counts.staged} staged • ${counts.changed} changed`,
          tone: counts.staged > 0 ? 'ok' : 'warn',
          hint: 'Working tree state'
        });
      } else if (counts.conflicted === 0) {
        segments.push({ key: 'changes', text: 'clean', tone: 'ok', hint: 'Working tree clean' });
      }
    }
    publishStatus('git', segments);
  }, [repoPath, repos, status]);

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
    localStorage.setItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}git`, String(width));
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
    // Guard: if we're currently animating a manual toggle, don't overwrite the layout.
    if (restoringSidebarRef.current) {
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
    document.getElementById('git-sidebar-tree')?.parentElement?.classList.add('sidebarAnimating');
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

  /* ---------- changes/history/branches vertical split ---------- */

  type SectionId = 'changes' | 'history' | 'branches';

  const sectionRef = (which: SectionId): React.RefObject<PanelImperativeHandle | null> =>
    which === 'changes' ? changesPanelRef : which === 'history' ? historyPanelRef : branchesPanelSectionRef;
  const sectionCollapsed = (which: SectionId): boolean =>
    which === 'changes' ? changesCollapsed : which === 'history' ? historyCollapsed : branchesCollapsed;
  const setSectionCollapsed = (which: SectionId, value: boolean): void => {
    if (which === 'changes') {
      setChangesCollapsed(value);
    } else if (which === 'history') {
      setHistoryCollapsed(value);
    } else {
      setBranchesCollapsed(value);
    }
  };

  function toggleSection(which: SectionId): void {
    const ref = sectionRef(which);
    const collapsed = sectionCollapsed(which);
    if (collapsed) {
      ref.current?.expand();
      // A drag-snapped panel re-expands to its pre-collapse size, which is the
      // minimum — too small to be useful. Give it a real share back, unless
      // every sibling is collapsed (resizing would drag a sibling open too).
      const siblings = (['changes', 'history', 'branches'] as SectionId[]).filter((id) => id !== which);
      const allSiblingsCollapsed = siblings.every((id) => sectionCollapsed(id));
      const size = ref.current?.getSize();
      if (!allSiblingsCollapsed && size && size.asPercentage < 25) {
        if (which === 'branches' && !sectionCollapsed('history')) {
          // The library bills the ADJACENT panel — for first-position branches
          // that is Changes, which gets squeezed straight through its minimum
          // into collapse. Shrink History first (its space flows to Changes),
          // then let the branches resize reclaim it from Changes: net effect,
          // History pays and Changes keeps its share.
          const historySize = historyPanelRef.current?.getSize();
          if (historySize && historySize.asPercentage > 25) {
            historyPanelRef.current?.resize(`${Math.max(15, historySize.asPercentage - 38)}%`);
          }
        }
        ref.current?.resize('38%');
      }
    } else {
      ref.current?.collapse();
    }
    // Eager state flip for instant chevron/body response; handleSectionResize
    // keeps it honest when the panel is resized by dragging instead.
    setSectionCollapsed(which, !collapsed);
  }

  function handleSectionResize(which: SectionId, size: PanelSize): void {
    // Resize events from the hidden (display: none) layout report 0px and
    // must not clobber the collapsed state — same guard as the sidebar.
    if (!active) {
      return;
    }
    setSectionCollapsed(which, size.inPixels <= 30);
  }

  // Re-apply section collapse when the subsystem becomes visible again (the
  // panels mount while hidden, so the imperative state can get lost).
  useEffect(() => {
    if (!active) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (changesCollapsed) {
        changesPanelRef.current?.collapse();
      }
      if (historyCollapsed) {
        historyPanelRef.current?.collapse();
      }
      if (branchesCollapsed) {
        branchesPanelSectionRef.current?.collapse();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* ---------- repo picker dropdown ---------- */
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (pickerRef.current && event.target instanceof Node && !pickerRef.current.contains(event.target)) {
        setPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  /* ---------- data loading ---------- */

  const report = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError]
  );

  const refreshStatus = useCallback(async (): Promise<GitStatus | null> => {
    const repo = repoRef.current;
    const rootDir = rootRef.current;
    if (!repo || !rootDir) {
      return null;
    }
    const gen = repoGenRef.current;
    const next = await gitStatus(rootDir, repo);
    if (repoGenRef.current !== gen) {
      return null;
    }
    setStatus(next);
    return next;
  }, []);

  const loadLog = useCallback(async (reset: boolean): Promise<void> => {
    const repo = repoRef.current;
    const rootDir = rootRef.current;
    if (!repo || !rootDir) {
      return;
    }
    const gen = repoGenRef.current;
    const skipCount = reset ? 0 : commitsCountRef.current;
    const page = await gitLog(rootDir, repo, LOG_PAGE, skipCount);
    if (repoGenRef.current !== gen) {
      return;
    }
    setCommits((current) => {
      const merged = reset ? page.commits : [...current, ...page.commits];
      commitsCountRef.current = merged.length;
      return merged;
    });
    setHasMore(page.hasMore);
  }, []);
  const commitsCountRef = useRef(0);

  const refreshLiveDiffs = useCallback(async (): Promise<void> => {
    const repo = repoRef.current;
    const rootDir = rootRef.current;
    if (!repo || !rootDir) {
      return;
    }
    const gen = repoGenRef.current;
    for (const [key, spec] of specsRef.current) {
      if (spec.mode !== 'worktree' && spec.mode !== 'index') {
        continue; // commit/range content is immutable
      }
      const entry = diffsRef.current.get(key);
      if (!entry?.models) {
        continue;
      }
      try {
        const result = await gitDiff(rootDir, repo, spec.path, spec.mode, undefined, spec.origPath);
        if (repoGenRef.current !== gen || diffsRef.current.get(key) !== entry || !entry.models) {
          continue;
        }
        if (result.ok) {
          if (entry.models.original.getValue() !== result.original) {
            entry.models.original.setValue(result.original);
          }
          if (entry.models.modified.getValue() !== result.modified) {
            entry.models.modified.setValue(result.modified);
          }
        }
      } catch {
        // transient refresh failures keep the previous content
      }
    }
  }, []);

  const loadBranches = useCallback(async (): Promise<void> => {
    const repo = repoRef.current;
    const rootDir = rootRef.current;
    if (!repo || !rootDir) {
      return;
    }
    const gen = repoGenRef.current;
    try {
      const info = await gitBranches(rootDir, repo);
      if (repoGenRef.current === gen) {
        setBranchesInfo(info);
      }
    } catch (err) {
      report(err);
    }
  }, [report]);

  const refreshAll = useCallback(
    async (options: { log?: boolean } = {}): Promise<void> => {
      try {
        const next = await refreshStatus();
        if (next) {
          const fingerprint = JSON.stringify(next);
          const changed = fingerprint !== statusFingerprintRef.current;
          statusFingerprintRef.current = fingerprint;
          // Live worktree/staged diffs can change even when the porcelain status
          // fingerprint does NOT — further edits to an already-modified file keep
          // the letter 'M'. So refresh open diff tabs every tick; otherwise an
          // open diff went permanently stale as the file kept changing. loadLog
          // and loadBranches only change with the status, so keep them gated.
          const tasks: Array<Promise<unknown>> = [refreshLiveDiffs()];
          if (changed || options.log) {
            tasks.push(loadLog(true), loadBranches());
          }
          await Promise.all(tasks);
        }
      } catch (err) {
        report(err);
      }
    },
    [refreshStatus, loadLog, refreshLiveDiffs, loadBranches, report]
  );

  const scanRepos = useCallback(
    async (rootDir: string, preferred?: string | null): Promise<void> => {
      setScanning(true);
      scanningRef.current = true;
      try {
        const found = await gitRepos(rootDir);
        setRepos(found);
        const stored = preferred ?? localStorage.getItem(REPO_STORAGE_KEY);
        const pick =
          found.find((repo) => repo.path === stored) ??
          found.find((repo) => repo.path === rootDir) ??
          found[0] ??
          null;
        selectRepo(pick?.path ?? null);
      } catch (err) {
        report(err);
      } finally {
        setScanning(false);
        scanningRef.current = false;
        // Navigation that arrived mid-boot/mid-scan would have been wiped by
        // the selectRepo above (it clears all diff tabs) — apply it now.
        drainPendingNavRef.current();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report]
  );

  function disposeAllDiffs(): void {
    const entries = [...diffsRef.current.values()];
    diffsRef.current.clear();
    specsRef.current.clear();
    disposeDeferred(entries);
  }

  /**
   * Model disposal must happen after React commits the tab-state change:
   * the DiffHost effect detaches the models from the diff editor first, and
   * disposing a still-attached model throws inside Monaco.
   */
  function disposeDeferred(entries: DiffEntry[]): void {
    window.setTimeout(() => {
      for (const entry of entries) {
        entry.models?.original.dispose();
        entry.models?.modified.dispose();
      }
    }, 0);
  }

  function selectRepo(path: string | null): void {
    repoGenRef.current += 1;
    repoRef.current = path;
    disposeAllDiffs();
    tabsRef.current = [];
    activeTabRef.current = null;
    setTabs([]);
    setActiveTab(null);
    setStatus(null);
    setGithub(null);
    setCommits([]);
    commitsCountRef.current = 0;
    setHasMore(false);
    setDetails(new Map());
    setExpanded(new Set());
    setCommitMessage('');
    setAmend(false);
    setBranchesInfo({ branches: [], worktrees: [] });
    setCompare(null);
    statusFingerprintRef.current = '';
    setRepoPath(path);
    setPickerOpen(false);
    setRepoQuery('');
    if (path && isNarrowViewport()) {
      collapseSidebarRef.current(); // drawer behavior on phones
    }
    if (path) {
      localStorage.setItem(REPO_STORAGE_KEY, path);
      recordRepoRecent(path);
      const gen = repoGenRef.current;
      void refreshAll({ log: true });
      void gitGitHubInfo(rootRef.current ?? '', path)
        .then((info) => {
          if (repoGenRef.current === gen) {
            setGithub(info);
          }
        })
        .catch(() => undefined);
    }
  }

  // Lazy boot: the git root is the editor's root (desk.yml), fallback home.
  useEffect(() => {
    if (!active || booted) {
      return;
    }
    setBooted(true);
    void (async () => {
      try {
        const settings = await fetchSettings();
        // An interactive root change this session beats persisted settings —
        // its persist POST may still be in flight when this GET resolves.
        const saved = getEditorRoot() ?? settings.editor?.root;
        let resolved: string | null = null;
        if (saved) {
          const check = await fsValidate(saved);
          if (check.ok) {
            resolved = check.resolved ?? saved;
          }
        }
        if (!resolved) {
          resolved = await fsHome();
        }
        rootRef.current = resolved;
        setRoot(resolved);
        await scanRepos(resolved);
      } catch (err) {
        report(err);
      }
    })();
  }, [active, booted, report, scanRepos]);

  // Follow interactive editor root changes live: reading settings only at
  // boot left git scoped to the old root until a full page reload. Runs even
  // while hidden (the subsystem stays mounted) so switching to git after a
  // root change shows the new root's repos immediately.
  const liveEditorRoot = useEditorRoot();
  useEffect(() => {
    if (!booted || !liveEditorRoot || liveEditorRoot === rootRef.current) {
      return;
    }
    rootRef.current = liveEditorRoot;
    setRoot(liveEditorRoot);
    void scanRepos(liveEditorRoot);
  }, [liveEditorRoot, booted, scanRepos]);

  // Status polling while the subsystem is on screen.
  useEffect(() => {
    if (!active || !repoPath) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshAll();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, repoPath, refreshAll]);

  useEffect(() => {
    return () => disposeAllDiffs();
  }, []);

  /* ---------- diff tabs ---------- */

  const setTabState = useCallback((nextTabs: string[], nextActive: string | null) => {
    tabsRef.current = nextTabs;
    activeTabRef.current = nextActive;
    setTabs(nextTabs);
    setActiveTab(nextActive);
  }, []);

  const loadDiff = useCallback(
    async (spec: DiffSpec): Promise<void> => {
      const repo = repoRef.current;
      const rootDir = rootRef.current;
      if (!repo || !rootDir) {
        return;
      }
      const gen = repoGenRef.current;
      const entry: DiffEntry = { models: null, error: null, loading: true };
      diffsRef.current.set(spec.key, entry);
      bump();
      try {
        const result = await gitDiff(rootDir, repo, spec.path, spec.mode, spec.sha, spec.origPath, spec.range);
        if (repoGenRef.current !== gen || diffsRef.current.get(spec.key) !== entry) {
          return;
        }
        if (result.ok) {
          initMonaco();
          const language = languageForPath(spec.path);
          entry.models = {
            original: monaco.editor.createModel(result.original, language),
            modified: monaco.editor.createModel(result.modified, language)
          };
        } else {
          entry.error = result.reason;
        }
      } catch (err) {
        diffsRef.current.delete(spec.key);
        report(err);
      } finally {
        entry.loading = false;
        bump();
      }
    },
    [bump, report]
  );

  const openDiffTab = useCallback(
    (spec: DiffSpec): void => {
      if (!specsRef.current.has(spec.key)) {
        specsRef.current.set(spec.key, spec);
        void loadDiff(spec);
        bleeps.open?.play();
      }
      const next = openTab(tabsRef.current, activeTabRef.current, spec.key);
      setTabState(next.tabs, next.active);
    },
    [loadDiff, setTabState, bleeps]
  );

  const handleCloseTab = useCallback(
    (key: string) => {
      const entry = diffsRef.current.get(key);
      diffsRef.current.delete(key);
      specsRef.current.delete(key);
      const next = closeTab(tabsRef.current, activeTabRef.current, key);
      setTabState(next.tabs, next.active);
      if (entry) {
        disposeDeferred([entry]);
      }
    },
    // disposeDeferred is a stable function declaration within the component
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setTabState]
  );

  const handleCloseOthers = useCallback(
    (keep: string) => {
      for (const key of [...tabsRef.current]) {
        if (key !== keep) {
          handleCloseTab(key);
        }
      }
    },
    [handleCloseTab]
  );

  const handleCloseAll = useCallback(() => {
    for (const key of [...tabsRef.current]) {
      handleCloseTab(key);
    }
  }, [handleCloseTab]);

  const openEntryDiff = useCallback(
    (entry: GitStatusEntry, group: ChangeGroup): void => {
      const mode: GitDiffMode = group === 'staged' ? 'index' : 'worktree';
      openDiffTab({
        key: `${mode}:${entry.path}`,
        path: entry.path,
        origPath: entry.origPath,
        mode,
        label: `${fileNameOf(entry.path)} (${group === 'staged' ? 'Staged' : 'Working Tree'})`
      });
    },
    [openDiffTab]
  );

  const openCommitFileDiff = useCallback(
    (commit: GitLogCommit, file: GitCommitFile): void => {
      openDiffTab({
        key: `commit:${commit.sha}:${file.path}`,
        path: file.path,
        origPath: file.origPath,
        mode: 'commit',
        sha: commit.sha,
        label: `${fileNameOf(file.path)} @ ${commit.sha.slice(0, 7)}`
      });
    },
    [openDiffTab]
  );

  /* ---------- branch compare (no checkout) ---------- */

  const toggleCompare = useCallback(
    (ref: string): void => {
      const repo = repoRef.current;
      const rootDir = rootRef.current;
      if (!repo || !rootDir) {
        return;
      }
      if (compare?.ref === ref) {
        setCompare(null);
        return;
      }
      const gen = repoGenRef.current;
      setCompare({ ref, baseSha: '', refSha: '', files: [], loading: true });
      void gitBranchDiff(rootDir, repo, ref)
        .then((diff) => {
          if (repoGenRef.current === gen) {
            setCompare((current) =>
              current?.ref === ref ? { ref, baseSha: diff.baseSha, refSha: diff.refSha, files: diff.files, loading: false } : current
            );
          }
        })
        .catch((err: unknown) => {
          if (repoGenRef.current === gen) {
            setCompare((current) => (current?.ref === ref ? null : current));
            report(err);
          }
        });
    },
    [compare, report]
  );

  const openCompareFileDiff = useCallback(
    (file: GitCommitFile): void => {
      if (!compare || compare.loading) {
        return;
      }
      const shortRef = compare.ref.split('/').pop() ?? compare.ref;
      openDiffTab({
        key: `range:${compare.ref}:${file.path}`,
        path: file.path,
        origPath: file.origPath,
        mode: 'range',
        range: { base: compare.baseSha, ref: compare.refSha },
        label: `${fileNameOf(file.path)} @ ${shortRef}`
      });
    },
    [compare, openDiffTab]
  );

  /* ---------- inbound navigation (editor → git) ---------- */
  // Trampoline refs (declared near the top): navigation can arrive before
  // this subsystem ever booted — the editor's "open diff" may be the user's
  // FIRST visit here — and is stashed until the boot scan settles.
  applyNavigateRef.current = (target) => {
    if (repoRef.current !== target.repo) {
      selectRepo(target.repo);
    }
    if (!target.path) {
      return;
    }
    if (target.sha) {
      openDiffTab({
        key: `commit:${target.sha}:${target.path}`,
        path: target.path,
        mode: 'commit',
        sha: target.sha,
        label: `${fileNameOf(target.path)} @ ${target.sha.slice(0, 7)}`
      });
    } else {
      openDiffTab({
        key: `worktree:${target.path}`,
        path: target.path,
        mode: 'worktree',
        label: `${fileNameOf(target.path)} (Working Tree)`
      });
    }
  };

  const bootedRef = useRef(false);
  bootedRef.current = booted && root !== null;
  useEffect(() => {
    registerNavigator?.((target) => {
      // Boot ends with scanRepos calling selectRepo (which clears all diff
      // tabs) — navigating any earlier would be wiped, so stash until then.
      if (!bootedRef.current || scanningRef.current) {
        pendingNavRef.current = target;
        return;
      }
      applyNavigateRef.current(target);
    });
  }, [registerNavigator]);

  drainPendingNavRef.current = () => {
    if (pendingNavRef.current) {
      const target = pendingNavRef.current;
      pendingNavRef.current = null;
      applyNavigateRef.current(target);
    }
  };

  /* ---------- mutations ---------- */

  const mutate = useCallback(
    async (operation: () => Promise<GitStatus>, options: { deploy?: boolean; log?: boolean } = {}): Promise<boolean> => {
      const gen = repoGenRef.current;
      setOpBusy(true);
      try {
        const next = await operation();
        if (repoGenRef.current !== gen) {
          return true;
        }
        setStatus(next);
        statusFingerprintRef.current = JSON.stringify(next);
        // The fs watcher skips .git — tell the editor's tree decorations.
        bumpGitRevision();
        if (options.deploy) {
          bleeps.deploy?.play();
        }
        await Promise.all([options.log === false ? Promise.resolve() : loadLog(true), refreshLiveDiffs(), loadBranches()]);
        return true;
      } catch (err) {
        report(err);
        return false;
      } finally {
        setOpBusy(false);
      }
    },
    [bleeps, loadLog, refreshLiveDiffs, loadBranches, report]
  );

  const requireRepo = (): { root: string; repo: string } | null => {
    const rootDir = rootRef.current;
    const repo = repoRef.current;
    return rootDir && repo ? { root: rootDir, repo } : null;
  };

  const handleStage = (paths: string[]): void => {
    const target = requireRepo();
    if (target) {
      void mutate(() => gitStage(target.root, target.repo, paths), { log: false });
    }
  };

  const handleUnstage = (paths: string[]): void => {
    const target = requireRepo();
    if (target) {
      void mutate(() => gitUnstage(target.root, target.repo, paths), { log: false });
    }
  };

  const handleDiscard = (entries: GitStatusEntry[]): void => {
    const target = requireRepo();
    if (!target) {
      return;
    }
    const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
    const untracked = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
    void mutate(() => gitDiscard(target.root, target.repo, tracked, untracked), { log: false });
  };

  const handleCommit = (): void => {
    const target = requireRepo();
    if (!target || !status) {
      return;
    }
    const staged = status.entries.some((entry) => !entry.conflicted && !entry.untracked && entry.index !== '.');
    const message = commitMessage.trim();
    if (message === '' && !amend) {
      onError('commit message is required');
      return;
    }
    let all = false;
    if (!staged && !amend) {
      if (!window.confirm('No staged changes. Stage all tracked changes and commit?')) {
        return;
      }
      all = true;
    }
    void mutate(() => gitCommit(target.root, target.repo, message, { amend, all }), { deploy: true }).then(
      (ok) => {
        if (ok) {
          setCommitMessage('');
          setAmend(false);
        }
      }
    );
  };

  const handleSync = (op: GitSyncOp): void => {
    const target = requireRepo();
    if (target) {
      void mutate(() => gitSync(target.root, target.repo, op), { deploy: op !== 'fetch' });
    }
  };

  const handleCheckout = (ref: string): void => {
    const target = requireRepo();
    if (target) {
      void mutate(() => gitCheckout(target.root, target.repo, ref), { deploy: true });
    }
  };

  const handleRevert = (commit: GitLogCommit): void => {
    const target = requireRepo();
    if (target && window.confirm(`Revert "${commit.subject}"? This creates a new commit undoing it.`)) {
      void mutate(() => gitRevert(target.root, target.repo, commit.sha), { deploy: true });
    }
  };

  const handleCreateBranch = (): void => {
    const target = requireRepo();
    const name = branchName.trim();
    if (!target || !branchFrom || name === '') {
      return;
    }
    setBranchFrom(null);
    setBranchName('');
    void mutate(() => gitCreateBranch(target.root, target.repo, name, branchFrom), { deploy: true });
  };

  const handleDeleteBranch = (branch: GitBranchRef): void => {
    const target = requireRepo();
    if (!target || !window.confirm(`Delete branch "${branch.name}"?`)) {
      return;
    }
    setOpBusy(true);
    void gitDeleteBranch(target.root, target.repo, branch.name)
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (/not fully merged/i.test(message)) {
          if (window.confirm(`"${branch.name}" is not fully merged. Force delete and lose its commits?`)) {
            await gitDeleteBranch(target.root, target.repo, branch.name, true);
            return;
          }
          return;
        }
        throw err;
      })
      .then(() => loadBranches())
      .catch(report)
      .finally(() => setOpBusy(false));
  };

  const handleOpenWorktree = (tree: GitWorktree): void => {
    bleeps.click?.play();
    selectRepo(tree.path);
  };

  const handleRemoveWorktree = (tree: GitWorktree): void => {
    const target = requireRepo();
    if (!target || !window.confirm(`Remove worktree "${tree.path}"?\nIts checked-out branch stays; uncommitted changes there block removal.`)) {
      return;
    }
    setOpBusy(true);
    void gitRemoveWorktree(target.root, target.repo, tree.path)
      .then(() => loadBranches())
      .catch(report)
      .finally(() => setOpBusy(false));
  };

  const handleCopyText = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    bleeps.click?.play();
  };

  const handleBrowse = (targetSpec: { sha?: string; path?: string } = {}): void => {
    const target = requireRepo();
    if (!target) {
      return;
    }
    void gitBrowseUrl(target.root, target.repo, targetSpec)
      .then((result) => {
        if (result.ok && result.url) {
          window.open(result.url, '_blank', 'noopener');
        } else if (result.error) {
          onError(result.error);
        }
      })
      .catch(report);
  };

  const toggleCommitExpanded = (sha: string): void => {
    const isExpanding = !expanded.has(sha);
    // Keep the updater pure (React StrictMode invokes it twice): only toggle the set here.
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sha)) {
        next.delete(sha);
      } else {
        next.add(sha);
      }
      return next;
    });
    // Fire the detail fetch once, outside the updater, only when expanding a commit we
    // have not loaded yet.
    if (isExpanding && !details.has(sha)) {
      const target = requireRepo();
      if (target) {
        const gen = repoGenRef.current;
        void gitCommitDetail(target.root, target.repo, sha)
          .then((detail) => {
            if (repoGenRef.current === gen) {
              setDetails((map) => new Map(map).set(sha, detail));
            }
          })
          .catch(report);
      }
    }
  };

  const handleLoadMore = (): void => {
    setLoadingMore(true);
    void loadLog(false)
      .catch(report)
      .finally(() => setLoadingMore(false));
  };

  /* ---------- derived render data ---------- */

  const selectedRepo = repos.find((repo) => repo.path === repoPath) ?? null;
  const branchInfo = status?.branchInfo ?? null;
  const branchLabel = branchInfo
    ? branchInfo.detached
      ? `detached @ ${branchInfo.oid?.slice(0, 7) ?? '?'}`
      : branchInfo.branch ?? '(no branch)'
    : selectedRepo?.branch ?? '…';

  const tabLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const key of tabs) {
      map.set(key, specsRef.current.get(key)?.label ?? fileNameOf(key));
    }
    return map;
  }, [tabs]);

  const tabMeta = useMemo(() => {
    const map = new Map<string, TabMeta>();
    for (const key of tabs) {
      map.set(key, { dirty: false, conflict: false, deleted: false, markdown: false, rendered: false });
    }
    return map;
  }, [tabs]);

  const activeSpec = activeTab ? specsRef.current.get(activeTab) ?? null : null;
  const activeDiff = activeTab ? diffsRef.current.get(activeTab) ?? null : null;

  return (
    <Group
      orientation="horizontal"
      className={`subsystemPanels editorPanels ${sidebarCollapsed ? 'editorSidebarCollapsed' : ''} ${sidebarAnimating ? 'sidebarAnimating' : ''}`}
      id="desk-git-sidebar-v1"
    >
      <Panel
        id="git-sidebar-tree"
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
        <aside className="editorTreePanelInner editorSidebar gitSidebar">
          <div className="sidebarHeader">
            <div className="railTitle">
              <GitBranch size={12} />
              <TextReveal as="span" manager="decipher">Source Control</TextReveal>
            </div>
            <div className="railActions">
              <IconButton
                icon={<CloudDownload size={12} />}
                label="Fetch from remotes"
                disabled={!repoPath || opBusy}
                onClick={() => handleSync('fetch')}
              />
              <IconButton
                icon={<RefreshCw size={12} />}
                label="Rescan repositories"
                disabled={!root || scanning}
                onClick={() => {
                  if (root) {
                    void scanRepos(root, repoPath);
                  }
                }}
              />
              <IconButton icon={<HelpCircle size={12} />} label="Help" onClick={() => setGitHelpOpen(true)} />
            </div>
          </div>

          <div className="editorRootSelect" ref={pickerRef}>
            <button
              type="button"
              className={`editorRootButton ${pickerOpen ? 'open' : ''}`}
              style={{ clipPath: CLIP_OCTAGON_TINY }}
              title={repoPath ?? 'Pick repository'}
              onMouseEnter={() => bleeps.hover?.play()}
              onClick={() => {
                bleeps.click?.play();
                setRepoQuery('');
                setPickerOpen((open) => !open);
              }}
            >
              <FolderGit2 size={12} />
              <span className="editorRootPath">
                {scanning
                  ? 'scanning…'
                  : selectedRepo
                    ? selectedRepo.name
                    : repoPath
                      ? repoPath.split('/').filter(Boolean).pop() // worktree outside the scan root
                      : repos.length === 0
                        ? 'no repositories'
                        : 'select repo…'}
              </span>
              {selectedRepo ? (
                <small className="gitRepoTriggerMeta">
                  {selectedRepo.detached ? 'detached' : selectedRepo.branch ?? ''}
                  {selectedRepo.changes > 0 ? ` •${selectedRepo.changes}` : ''}
                </small>
              ) : null}
              <ChevronDown size={12} className={pickerOpen ? 'flip' : ''} />
            </button>
            {pickerOpen ? (
              <Animator combine manager="stagger" duration={{ enter: 0.18, stagger: 0.02 }}>
                <Animated className="editorRootPanel gitRepoPanel" animated={['fade', ['y', -6, 0]]} style={{ clipPath: CLIP_OCTAGON_TINY }}>
                  <input
                    ref={repoSearchRef}
                    className="treeInlineInput gitRepoSearch"
                    placeholder={`filter ${repos.length} repos…`}
                    value={repoQuery}
                    onChange={(event) => setRepoQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        const first = pickerGroups.flatMap((group) => group.repos)[0];
                        if (first) {
                          bleeps.click?.play();
                          selectRepo(first.path);
                        }
                      }
                    }}
                  />
                  <div className="gitRepoOptions">
                    {pickerGroups.map((group) => (
                      <Fragment key={group.label}>
                        {group.label !== '' ? <div className="gitRepoGroupLabel">{group.label}</div> : null}
                        {group.repos.map((repo) => (
                          <Animator key={repo.path}>
                            <Animated
                              as="button"
                              type="button"
                              className={`deskSelectOption gitRepoOption ${repo.path === repoPath ? 'selected' : ''} ${repo.changes > 0 ? 'dirty' : ''}`}
                              animated={['flicker']}
                              title={repo.path}
                              onMouseEnter={() => bleeps.hover?.play()}
                              onClick={() => {
                                bleeps.click?.play();
                                selectRepo(repo.path);
                              }}
                            >
                              <FolderGit2 size={11} />
                              <span className="gitRepoName">{repo.name}</span>
                              <small className="gitRepoBranch">
                                {repo.detached ? 'detached' : repo.branch ?? '—'}
                                {repo.ahead > 0 ? ` ↑${repo.ahead}` : ''}
                                {repo.behind > 0 ? ` ↓${repo.behind}` : ''}
                              </small>
                              {repo.changes > 0 ? <Pill tone="warn">{repo.changes}</Pill> : null}
                            </Animated>
                          </Animator>
                        ))}
                      </Fragment>
                    ))}
                    {pickerGroups.every((group) => group.repos.length === 0) ? (
                      <div className="gitEmptyNote small">No repos match “{repoQuery}”.</div>
                    ) : null}
                  </div>
                </Animated>
              </Animator>
            ) : null}
          </div>

          {repoPath ? (
            <>
              <div className="gitBranchBar">
                <span className="gitBranchName" title={branchInfo?.upstream ?? branchLabel}>
                  <GitBranch size={11} />
                  <span>{branchLabel}</span>
                </span>
                {branchInfo && branchInfo.ahead > 0 ? <Pill tone="ok" title="commits ahead of upstream"><ArrowUp size={9} /> {branchInfo.ahead}</Pill> : null}
                {branchInfo && branchInfo.behind > 0 ? <Pill tone="warn" title="commits behind upstream"><ArrowDown size={9} /> {branchInfo.behind}</Pill> : null}
                <span className="gitRowActions gitSyncActions">
                  {branchInfo && !branchInfo.upstream && !branchInfo.detached ? (
                    <IconButton icon={<Upload size={12} />} label="Publish branch" disabled={opBusy} onClick={() => handleSync('publish')} />
                  ) : (
                    <>
                      <IconButton icon={<ArrowDown size={12} />} label="Pull (fast-forward)" disabled={opBusy} onClick={() => handleSync('pull')} />
                      <IconButton icon={<ArrowUp size={12} />} label="Push" disabled={opBusy} onClick={() => handleSync('push')} />
                    </>
                  )}
                </span>
              </div>

              {github?.available ? (
                <Animator>
                  <Animated className="gitHubCard" animated={['flicker', ['y', -4, 0]]} style={{ clipPath: CLIP_OCTAGON_TINY }}>
                    <span className="gitHubName" title={github.description ?? github.nameWithOwner}>
                      <TextReveal as="span" manager="decipher">{github.nameWithOwner ?? ''}</TextReveal>
                    </span>
                    {typeof github.stargazerCount === 'number' ? (
                      <Pill title="stars"><Star size={9} /> {github.stargazerCount}</Pill>
                    ) : null}
                    <Pill tone="muted">{github.isPrivate ? 'private' : 'public'}</Pill>
                    {github.pullRequest ? (
                      <button
                        type="button"
                        className="gitPrChip"
                        title={`#${github.pullRequest.number} ${github.pullRequest.title}`}
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          window.open(github.pullRequest!.url, '_blank', 'noopener');
                        }}
                      >
                        <GitPullRequest size={10} />
                        <span>#{github.pullRequest.number}</span>
                        <small>{github.pullRequest.isDraft ? 'draft' : github.pullRequest.state.toLowerCase()}</small>
                      </button>
                    ) : null}
                    <IconButton icon={<ExternalLink size={11} />} label="Open on GitHub" onClick={() => handleBrowse()} />
                  </Animated>
                </Animator>
              ) : null}

              {/* Branches leads: picking/comparing a branch frames the changes
                  below it. New group id — the library keeps per-id layouts and
                  a reordered group under the old id restores stale sizes. */}
              <Group orientation="vertical" className="gitSectionsGroup" id="desk-git-sections-v2">
                <Panel
                  id="git-branches-section"
                  panelRef={branchesPanelSectionRef}
                  defaultSize="28px"
                  minSize="110px"
                  collapsedSize="28px"
                  collapsible
                  onResize={(size) => handleSectionResize('branches', size)}
                  className="gitSectionPanel"
                >
                  <BranchesPanel
                    branches={branchesInfo.branches}
                    worktrees={branchesInfo.worktrees}
                    repoPath={repoPath}
                    busy={opBusy}
                    collapsed={branchesCollapsed}
                    onToggleCollapsed={() => toggleSection('branches')}
                    onCheckout={handleCheckout}
                    onCreateBranch={(sha) => {
                      setBranchName('');
                      setBranchFrom(sha);
                    }}
                    onDeleteBranch={handleDeleteBranch}
                    onOpenWorktree={handleOpenWorktree}
                    onRemoveWorktree={handleRemoveWorktree}
                    onCopy={handleCopyText}
                    compare={compare}
                    onToggleCompare={toggleCompare}
                    onOpenCompareFile={openCompareFileDiff}
                  />
                </Panel>
                <Separator className="panelResizeHandle" disabled={branchesCollapsed || changesCollapsed} />
                <Panel
                  id="git-changes-section"
                  panelRef={changesPanelRef}
                  defaultSize="45%"
                  minSize="140px"
                  collapsedSize="28px"
                  collapsible
                  onResize={(size) => handleSectionResize('changes', size)}
                  className="gitSectionPanel"
                >
                  <ChangesPanel
                    status={status}
                    busy={opBusy}
                    message={commitMessage}
                    amend={amend}
                    collapsed={changesCollapsed}
                    onToggleCollapsed={() => toggleSection('changes')}
                    onMessageChange={setCommitMessage}
                    onAmendChange={setAmend}
                    onCommit={handleCommit}
                    onOpenDiff={openEntryDiff}
                    onOpenFile={(path) => onOpenFile(`${repoPath}/${path}`)}
                    onRevealInExplorer={
                      onRevealInExplorer ? (path) => onRevealInExplorer(`${repoPath}/${path}`) : undefined
                    }
                    onStage={handleStage}
                    onUnstage={handleUnstage}
                    onDiscard={handleDiscard}
                  />
                </Panel>
                <Separator className="panelResizeHandle" disabled={changesCollapsed || historyCollapsed} />
                <Panel
                  id="git-history-section"
                  panelRef={historyPanelRef}
                  minSize="110px"
                  collapsedSize="28px"
                  collapsible
                  onResize={(size) => handleSectionResize('history', size)}
                  className="gitSectionPanel"
                >
                  <HistoryPanel
                    commits={commits}
                    hasMore={hasMore}
                    loadingMore={loadingMore}
                    collapsed={historyCollapsed}
                    details={details}
                    expanded={expanded}
                    onToggleCollapsed={() => toggleSection('history')}
                    onToggleCommit={toggleCommitExpanded}
                    onLoadMore={handleLoadMore}
                    onOpenCommitFile={openCommitFileDiff}
                    onCheckout={handleCheckout}
                    onCreateBranch={(sha) => {
                      setBranchName('');
                      setBranchFrom(sha);
                    }}
                    onRevert={handleRevert}
                    onBrowse={(sha) => handleBrowse({ sha })}
                  />
                </Panel>
              </Group>
            </>
          ) : (
            <div className="gitEmptyNote">
              <TextReveal as="span" manager="sequence">
                {scanning ? 'Scanning for repositories…' : `No git repositories under ${root ?? '…'}.`}
              </TextReveal>
            </div>
          )}
        </aside>
      </Panel>
      <Separator className="panelResizeHandle" disabled={sidebarCollapsed} onPointerDown={() => setSidebarHandleDragActive(true)} />
      <Panel id="git-surface" minSize={surfaceMinSize(narrowViewport)} className="subsystemSurface">
        {narrowViewport && !sidebarCollapsed ? (
          <button type="button" className="drawerScrim" aria-label="Close sidebar" onClick={() => collapseSidebarRef.current()} />
        ) : null}
        <main className="editorStage">
          <EditorTabs
            tabs={tabs}
            active={activeTab}
            meta={tabMeta}
            labels={tabLabelMap}
            onSelect={(key) => {
              activeTabRef.current = key;
              setActiveTab(key);
            }}
            onClose={handleCloseTab}
            onCloseOthers={handleCloseOthers}
            onCloseAll={handleCloseAll}
            onToggleRender={() => undefined}
            onMove={(from, to) => {
              const next = moveTab(tabsRef.current, from, to);
              setTabState(next, activeTabRef.current);
            }}
          />
          {activeSpec ? (
            <div className="gitDiffToolbar">
              <span className="gitDiffPath" title={activeSpec.path}>
                {activeSpec.path}
              </span>
              <Pill tone={activeSpec.mode === 'commit' ? 'muted' : undefined}>
                {activeSpec.mode === 'commit' ? activeSpec.sha?.slice(0, 7) : activeSpec.mode === 'index' ? 'staged' : 'working tree'}
              </Pill>
              <span className="gitRowActions">
                <IconButton
                  icon={sideBySide ? <Rows2 size={12} /> : <Columns2 size={12} />}
                  label={sideBySide ? 'Inline view' : 'Side-by-side view'}
                  onClick={() => setSideBySide((value) => !value)}
                />
              </span>
            </div>
          ) : null}
          {activeSpec && activeDiff ? (
            activeDiff.error ? (
              <DeskPanel texture>
                <div className="editorPlaceholder">
                  <TextReveal as="span" manager="sequence">
                    {activeDiff.error === 'binary' ? 'Binary file — no text diff.' : 'File too large to diff.'}
                  </TextReveal>
                </div>
              </DeskPanel>
            ) : (
              <div className="editorHostWrap">
                <DiffHost models={activeDiff.models} activeKey={activeTab} sideBySide={sideBySide} />
                {activeDiff.loading ? <div className="viewerOverlay"><div className="viewerStatus">loading diff…</div></div> : null}
              </div>
            )
          ) : (
            <DeskPanel texture>
              <div className="editorPlaceholder">
                <TextReveal as="span" manager="sequence">Open a change or a commit file to view its diff.</TextReveal>
              </div>
            </DeskPanel>
          )}
        </main>
      </Panel>
      {branchFrom ? (
        <Modal title="Create branch" icon={<GitBranchPlus size={13} />} onClose={() => setBranchFrom(null)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">New branch at {branchFrom.slice(0, 10)}</span>
            <input
              className="treeInlineInput"
              autoFocus
              placeholder="branch name"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleCreateBranch();
                }
              }}
            />
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setBranchFrom(null)} />
              <Cmd
                icon={<GitBranchPlus size={12} />}
                label="Create & checkout"
                disabled={branchName.trim() === ''}
                onClick={handleCreateBranch}
              />
            </div>
          </div>
        </Modal>
      ) : null}

      {gitHelpOpen ? (
        <Modal title="Source Control" icon={<GitBranch size={13} />} onClose={() => setGitHelpOpen(false)}>
          <div style={{ padding: '16px 14px', color: 'var(--desk-text-dim)', fontSize: '12px', lineHeight: '1.5' }}>
            <div>Git source control tracks changes across repositories in your workspace. View uncommitted changes, staged files, commit history, and branch information all in one place.</div>
            <div style={{ marginTop: '12px' }}>Stage changes by selecting files, write commit messages with templates, and push or pull from remotes. Browse commit history with full diffs to understand what changed and why. Create, switch, and compare branches without leaving Desk.</div>
            <div style={{ marginTop: '12px' }}>Use the fetch button to download remote changes, rescan to refresh repositories, and interact with GitHub pull requests and issues directly from the history view.</div>
            <div style={{ marginTop: '12px' }}>
              <a href="https://docs.desk.cloud/github-operations/" target="_blank" rel="noopener noreferrer" style={{ color: '#4dd9ff', textDecoration: 'underline', cursor: 'pointer' }}>
                Read full documentation →
              </a>
            </div>
          </div>
        </Modal>
      ) : null}
    </Group>
  );
}
