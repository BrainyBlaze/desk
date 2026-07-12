import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { AlertTriangle, ChevronDown, CircleAlert, ClipboardCopy, FileCode, FilePlus, Folder, FolderPlus, FolderTree, GitBranch, GitCompareArrows, History, Home, ListTree, RefreshCw, RotateCcw, Save, Search, StickyNote } from 'lucide-react';
import { formatSaveState, publishStatus, relativeToRootPath, type StatusSegment } from '../statusSegments.js';
import { lspStatusSegment } from './lsp/statusSegment.js';
import { getLspStatus, lspStatusKey, subscribeLspStatus } from './lsp/lspStatusStore.js';
import { ProblemsPanel } from './ProblemsPanel.js';
import { aggregateProblems, type ProblemEntry, type ProblemsModel } from './problemsModel.js';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import { CLIP_OCTAGON_TINY, Cmd, DeskPanel, IconButton, Modal, TextReveal, useDeskTheme } from '../arwes/primitives.js';
import {
  gitBrowseUrl,
  gitDiscard,
  gitLineDiff,
  gitLog,
  gitStage,
  gitStatusMap,
  gitUnstage,
  type GitLineDiffResult,
  type GitLogCommit
} from '../git/gitClient.js';
import { shortTimeAgo } from '../git/gitStatusMeta.js';
import { bumpGitRevision, useGitRevision } from '../gitRevision.js';
import { publishEditorRoot } from '../editorRoot.js';
import {
  buildTreeGitModel,
  EMPTY_TREE_GIT_MODEL,
  owningRepoOf,
  repoRelative,
  type TreeGitModel
} from './gitTreeModel.js';
import {
  AGENT_SIDEBAR_MAX_SIZE,
  AGENT_SIDEBAR_MIN_SIZE,
  EDITOR_SIDEBAR_STORAGE_KEY,
  NOTES_SIDEBAR_STORAGE_KEY,
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
import { fetchSettings, saveSettings, type DeskAutosaveMode } from '../api.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { FsWatchSocket, fsCreate, fsCreateApply, fsCreatePreview, fsDelete, fsDeleteApply, fsDeletePreview, fsHome, fsNotesHome, fsNotesState, fsRead, fsRename, fsRenameApply, fsRenamePreview, fsRootFor, fsSaveNotesState, fsSearchFiles, fsValidate, fsWrite, enumerateSubtree, fileOpDirtyBlock, remapSubtreePath, resourceOpPaths, type FileOperationDescriptor, type FileOpPreviewResult, type LspFileResourceOperation, type LspRenamePreviewChange } from './fsClient.js';
import { deriveNoteName, isUntitledNote, noteFileName } from './noteNames.js';
import { ExplorerTree, type ExplorerTreeActions, type TreeGitIntegration, type TreeGitMenuSpec } from './ExplorerTree.js';
import { SearchPanel } from './SearchPanel.js';
import { EditorTabs, type TabMeta } from './EditorTabs.js';
import { MonacoHost, type RevealTarget } from './MonacoHost.js';
import { closeTab, fileNameOf, moveTab, openTab } from './editorState.js';
import { initMonaco, languageForPath, monaco } from './monacoSetup.js';
import type { EditorLspBinding } from './lsp/editorLspBinding.js';
import { perfMarkFirst, perfMarkOpen } from './lsp/perfTelemetry.js';
import { isMarkdownFile, rawFileUrl, viewerKindFor, type ViewerKind } from './fileKinds.js';
import { ImageView } from './viewers/ImageView.js';
import { PdfView } from './viewers/PdfView.js';

// Heavy renderer (react-markdown + katex + mermaid) loads on first use only.
const MarkdownView = lazy(() => import('./viewers/MarkdownView.js'));

type SidebarMode = 'tree' | 'search';

interface OpenFile {
  /** current absolute path — updated in place when an untitled note is renamed */
  path: string;
  model: monaco.editor.ITextModel | null;
  savedVersionId: number;
  mtimeMs: number;
  dirty: boolean;
  conflict: boolean;
  deleted: boolean;
  readonlyReason: 'binary' | 'too-large' | null;
  size: number;
  /** image/pdf tabs render in a dedicated viewer instead of Monaco */
  viewer: ViewerKind;
  /** markdown tabs: show the rendered preview instead of the source */
  renderMarkdown: boolean;
  /** bumped on disk changes so viewers re-fetch the raw bytes */
  rawRevision: number;
}

interface ExistingTextModelForLsp {
  uri: { toString(): string };
  getLanguageId(): string;
  getValue(): string;
}

interface ExistingTextFileForLsp {
  model: ExistingTextModelForLsp | null;
}

export function openExistingTextModelsForLspBinding(
  files: Iterable<ExistingTextFileForLsp>,
  binding: Pick<EditorLspBinding, 'openModel'>
): void {
  for (const file of files) {
    if (!file.model) {
      continue;
    }
    binding.openModel(
      { uri: file.model.uri.toString(), languageId: file.model.getLanguageId() },
      file.model.getValue()
    );
  }
}

interface EditorPersistBlock {
  root: string | null;
  openFiles: string[];
  activeFile: string | null;
}

export interface AutosaveConfig {
  mode: DeskAutosaveMode;
  delayMs: number;
}

// One generic file-operation transaction dialog (rename/move, create, delete; file or folder).
type FileOpDialogState =
  | {
      mode: 'preview';
      op: FileOperationDescriptor;
      previewId: string;
      changes: LspRenamePreviewChange[];
      resourceOps: LspFileResourceOperation[];
      busy: boolean;
      error: string | null;
    }
  | { mode: 'error'; op: FileOperationDescriptor; message: string };

/** Past-tense verb for an operation, used in error/status copy. */
function fileOpVerb(op: FileOperationDescriptor): string {
  return op.type === 'rename' ? 'rename' : op.type === 'create' ? 'create' : 'delete';
}

/** Header summary line for the dialog (file-name level only; no absolute paths surfaced loudly). */
function fileOpSummary(op: FileOperationDescriptor): string {
  if (op.type === 'rename') {
    return `${fileNameOf(op.from)} -> ${fileNameOf(op.to)}`;
  }
  return fileNameOf(op.path);
}

function fileOpPreviewMessage(op: FileOperationDescriptor, reason?: string): string {
  const verb = fileOpVerb(op);
  switch (reason) {
    case 'out-of-root-edit':
      return `This ${verb} cannot be auto-applied safely (changes outside the workspace).`;
    case 'conflicting-edits':
      return `This ${verb} cannot be auto-applied safely (conflicting edits).`;
    case 'unsupported-workspace-edit':
      return `This ${verb} cannot be auto-applied safely (unsupported changes).`;
    case 'stale-file':
      return `Files changed since preview. Run the ${verb} again.`;
    default:
      return `The language server could not produce a safe ${verb} preview.`;
  }
}

function fileOpApplyMessage(op: FileOperationDescriptor, error: string): string {
  if (error === 'files changed since preview') {
    return `Files changed since preview. Run the ${fileOpVerb(op)} again.`;
  }
  if (error === 'preview expired') {
    return `This preview expired. Run the ${fileOpVerb(op)} again.`;
  }
  return `Applying the ${fileOpVerb(op)} failed.`;
}

function renameButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    background: 'transparent',
    border: '1px solid var(--desk-line)',
    borderRadius: 3,
    color: 'var(--desk-text)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontSize: 11
  };
}

export function EditorSubsystem({
  active,
  rootShortcuts,
  autosave,
  variant = 'editor',
  onError,
  onSidebarCollapsedChange,
  registerSidebarToggle,
  registerFileOpener,
  registerFileReveal,
  registerNoteCreator,
  serverSidebarWidth,
  onRevealInGit,
  createLspBinding
}: {
  active: boolean;
  rootShortcuts: string[];
  autosave: AutosaveConfig;
  /**
   * 'notes' pins the root to ~/.config/desk/notes (no root picker), persists
   * tabs in the settings.notes block, always autosaves (mtime-guarded), and
   * auto-names untitled notes from their content.
   */
  variant?: 'editor' | 'notes';
  onError: (message: string) => void;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  registerSidebarToggle?: (toggle: () => void) => void;
  /** exposes openFile so other subsystems (git) can jump into the editor */
  registerFileOpener?: (open: (path: string) => void) => void;
  /** exposes open+reveal-in-tree (git subsystem's "reveal in explorer") */
  registerFileReveal?: (reveal: (path: string) => void) => void;
  /** notes variant: exposes create-note so the rail/terminals can mint notes */
  registerNoteCreator?: (create: (content?: string) => void) => void;
  /** width from desk.yml (arrives after the settings fetch); reconciles the panel */
  serverSidebarWidth?: number;
  /** jump to the git subsystem (repo / worktree diff / commit diff) */
  onRevealInGit?: (target: { repo: string; path?: string; sha?: string }) => void;
  /**
   * Optional LSP wiring seam (default off). When provided, the subsystem builds a binding per
   * workspace root and forwards model open/close to it so providers register/dispose with the
   * editor lifecycle. Undefined (production today, until config plumbing lands) = no LSP, no
   * behavior change.
   */
  createLspBinding?: (params: { workspaceRoot: string }) => EditorLspBinding;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const isNotes = variant === 'notes';
  const narrowViewport = useNarrowViewport();
  const panelId = isNotes ? 'notes-sidebar-tree' : 'editor-sidebar-tree';
  const groupDomId = isNotes ? 'desk-notes-sidebar-v1' : 'desk-editor-sidebar-v1';
  const collapseStorageKey = isNotes ? NOTES_SIDEBAR_STORAGE_KEY : EDITOR_SIDEBAR_STORAGE_KEY;
  // Notes always autosave: casual capture must never be lost to a forgotten
  // Ctrl+S. The writes stay mtime-guarded like every other save.
  const effectiveAutosave: AutosaveConfig = isNotes ? { mode: 'after-delay', delayMs: 1000 } : autosave;
  const watcherRef = useRef<FsWatchSocket | null>(null);
  // LSP binding for the current root (null unless createLspBinding is injected and a root is set).
  const lspBindingRef = useRef<EditorLspBinding | null>(null);
  const [booted, setBooted] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('tree');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerValue, setPickerValue] = useState('');
  const treeActionsRef = useRef<ExplorerTreeActions>({
    createFile: () => undefined,
    createDir: () => undefined,
    refresh: () => undefined,
    revealPath: async () => undefined
  });
  const registerTreeActions = useCallback((actions: ExplorerTreeActions) => {
    treeActionsRef.current = actions;
  }, []);
  const rootSelectRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootSelectRef.current && event.target instanceof Node && !rootSelectRef.current.contains(event.target)) {
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

  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedCollapse(collapseStorageKey, onSidebarCollapsedChange);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const restoringSidebarRef = useRef(false);
  // Persisted width: localStorage cache for instant boot, desk.yml as truth.
  const initialWidthRef = useRef(
    readStoredSidebarWidth(localStorage.getItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}${variant}`)) ?? 180
  );
  const sidebarWidthRef = useRef(initialWidthRef.current);
  const widthPersisterRef = useRef<((px: number) => void) | null>(null);
  if (widthPersisterRef.current === null) {
    widthPersisterRef.current = createSidebarWidthPersister(variant, (sidebars) => saveSettings({ sidebars }));
  }
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const sidebarAnimTimerRef = useRef<number | undefined>(undefined);
  const pendingSnapCollapseRef = useRef(false);
  const collapseSidebarRef = useRef<() => void>(() => undefined);
  const toggleSidebarRef = useRef<() => void>(() => undefined);

  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [renderTick, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((value) => value + 1), []);

  const filesRef = useRef(new Map<string, OpenFile>());
  // Synchronous mirrors of tabs/activeTab so async flows (sequential restore,
  // rapid open/close) never act on stale closures.
  const tabsRef = useRef<string[]>([]);
  const activeTabRef = useRef<string | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const restoredRef = useRef(false);
  // True while the one-shot restore loop replays remembered tabs; suppresses
  // the debounced persists those replays would otherwise fire.
  const restoringRef = useRef(false);
  // Bumped every time the root changes; async flows capture it before each
  // await and abort if a root switch landed in the meantime.
  const rootGenRef = useRef(0);
  // Autosave config mirror so timers and listeners always read fresh values.
  const autosaveRef = useRef(effectiveAutosave);
  autosaveRef.current = effectiveAutosave;
  // Per-file idle timers (after-delay mode) and an in-flight write guard so a
  // slow disk can never produce overlapping writes for the same path.
  const autosaveTimersRef = useRef(new Map<string, number>());
  const savingPathsRef = useRef(new Set<string>());
  // Notes variant: assigned below (declaration order), invoked from writeFile.
  const renameNoteRef = useRef<(path: string, content: string) => void>(() => undefined);

  const shortcuts = useMemo(() => [...new Set(rootShortcuts.filter((path) => path.trim() !== ''))], [rootShortcuts]);

  // The socket only exists while the subsystem has been activated at least once.
  if (active && watcherRef.current === null) {
    watcherRef.current = new FsWatchSocket();
  }

  // Build (and replace) the LSP binding per workspace root. A root switch runs the cleanup first
  // (disposeAll -> the controller's dispose-before-new-session), then a fresh binding is created
  // for the new root. Default off: createLspBinding undefined -> the ref stays null and every
  // forwarding below is a no-op, leaving behavior identical to today.
  useEffect(() => {
    if (!createLspBinding || root === null) {
      return undefined;
    }
    const binding = createLspBinding({ workspaceRoot: root });
    lspBindingRef.current = binding;
    openExistingTextModelsForLspBinding(filesRef.current.values(), binding);
    return () => {
      binding.disposeAll();
      if (lspBindingRef.current === binding) {
        lspBindingRef.current = null;
      }
    };
  }, [root, createLspBinding]);

  useEffect(() => {
    return () => {
      for (const file of filesRef.current.values()) {
        file.model?.dispose();
      }
      filesRef.current.clear();
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      for (const timer of autosaveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      autosaveTimersRef.current.clear();
      watcherRef.current?.dispose();
      watcherRef.current = null;
    };
  }, []);

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
    localStorage.setItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}${variant}`, String(width));
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
    // A drag released below the collapse threshold snaps the sidebar shut
    // (animated) instead of leaving a dead strip at minimum width.
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
    // panel.collapse()/expand() write the target style synchronously, before React
    // commits state — the transition class must be on the DOM in the same tick.
    // (react-resizable-panels sizes panels via flex-grow; the CSS transitions it.)
    document.getElementById(panelId)?.parentElement?.classList.add('sidebarAnimating');
    setSidebarAnimating(true);
    window.clearTimeout(sidebarAnimTimerRef.current);
    sidebarAnimTimerRef.current = window.setTimeout(() => setSidebarAnimating(false), 340);
  }

  function collapseSidebar(): void {
    markSidebarAnimating();
    // Guard for the whole animation: mid-transition resize events would sync
    // the collapsed state back to false and reopen the panel.
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.collapse();
    setSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 360);
  }

  function snapCollapseSidebar(): void {
    // Post-drag snap must be instant: animating here makes the library's
    // resize reconciliation read the mid-transition width and write it back,
    // cancelling the collapse entirely.
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
    // Keep the guard up for the whole animation: intermediate widths during the
    // expand transition must not re-trigger the collapse threshold.
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
    // Unlike the agents Group, this one stays mounted while the subsystem is
    // hidden (display: none) — resize events from the zero-width layout must
    // not clobber the stored collapsed state.
    if (!active || restoringSidebarRef.current) {
      return;
    }
    if (isNarrowViewport()) {
      // Overlay drawer (phones): the library's split is virtual — its resize
      // events (mount echoes included) must not drive the drawer state.
      return;
    }
    // Keep React state in sync with the panel's REAL size only. Collapsing
    // mid-drag gets overridden by the live drag and leaves a hidden-content
    // gap, so a below-threshold drag is snapped on pointer release instead.
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

  const setTabState = useCallback((nextTabs: string[], nextActive: string | null) => {
    tabsRef.current = nextTabs;
    activeTabRef.current = nextActive;
    setTabs(nextTabs);
    setActiveTab(nextActive);
  }, []);

  /* ---------- git awareness (editor variant only) ----------
   * The tree reports its visible dirs; /api/git/status-map statuses the repos
   * owning them (never the full scan). Refreshes ride existing signals — fs
   * watch events, saves, the cross-subsystem gitRevision bump — debounced and
   * fingerprinted so unchanged status costs no re-render. */
  const gitEnabled = !isNotes;
  const [gitModel, setGitModel] = useState<TreeGitModel>(EMPTY_TREE_GIT_MODEL);
  const gitModelRef = useRef(gitModel);
  gitModelRef.current = gitModel;
  const visibleDirsRef = useRef<string[]>([]);
  const visibleDirsFpRef = useRef('');
  const gitFingerprintRef = useRef('');
  const gitRefreshTimerRef = useRef<number | null>(null);
  const gitRevision = useGitRevision();
  const [gutter, setGutter] = useState<{ path: string; result: GitLineDiffResult } | null>(null);
  const [gutterTick, setGutterTick] = useState(0);
  const [historyTarget, setHistoryTarget] = useState<{ path: string; repo: string } | null>(null);
  const [historyCommits, setHistoryCommits] = useState<GitLogCommit[] | null>(null);

  const refreshGitModel = useCallback(async (): Promise<void> => {
    const rootDir = root;
    if (!gitEnabled || !rootDir) {
      return;
    }
    // Visible tree dirs PLUS the parents of open tabs: restored tabs (and
    // cross-subsystem opens) need their repo in the model for the gutter and
    // the status-bar branch segment even while the tree is still collapsed.
    const paths = new Set(visibleDirsRef.current);
    for (const tab of tabsRef.current) {
      const parent = tab.slice(0, tab.lastIndexOf('/'));
      if (parent.startsWith(rootDir)) {
        paths.add(parent);
      }
    }
    if (paths.size === 0) {
      return;
    }
    try {
      const repos = await gitStatusMap(rootDir, [...paths]);
      const fingerprint = JSON.stringify(repos);
      if (fingerprint === gitFingerprintRef.current) {
        return;
      }
      gitFingerprintRef.current = fingerprint;
      setGitModel(buildTreeGitModel(repos, rootDir));
    } catch {
      // transient (server restart, repo mid-gc) — keep the previous decorations
    }
  }, [root, gitEnabled]);

  const scheduleGitRefresh = useCallback((): void => {
    if (!gitEnabled) {
      return;
    }
    if (gitRefreshTimerRef.current !== null) {
      window.clearTimeout(gitRefreshTimerRef.current);
    }
    gitRefreshTimerRef.current = window.setTimeout(() => {
      gitRefreshTimerRef.current = null;
      void refreshGitModel();
    }, 500);
  }, [refreshGitModel, gitEnabled]);

  useEffect(() => {
    return () => {
      if (gitRefreshTimerRef.current !== null) {
        window.clearTimeout(gitRefreshTimerRef.current);
      }
    };
  }, []);

  const handleVisibleDirs = useCallback(
    (dirs: string[]): void => {
      const fingerprint = dirs.join('\n');
      if (fingerprint === visibleDirsFpRef.current) {
        return;
      }
      visibleDirsFpRef.current = fingerprint;
      visibleDirsRef.current = dirs;
      scheduleGitRefresh();
    },
    [scheduleGitRefresh]
  );

  // Root switches invalidate decorations; the tree re-reports its dirs.
  useEffect(() => {
    gitFingerprintRef.current = '';
    visibleDirsFpRef.current = '';
    setGitModel(EMPTY_TREE_GIT_MODEL);
    setGutter(null);
    setHistoryTarget(null);
  }, [root]);

  // Stage/commit/discard in the git subsystem (or our own menu) → re-fetch.
  useEffect(() => {
    scheduleGitRefresh();
  }, [gitRevision, scheduleGitRefresh]);

  // Newly opened tabs widen the status-map scope (their repo may be unseen).
  useEffect(() => {
    scheduleGitRefresh();
  }, [tabs, scheduleGitRefresh]);

  // Any fs change can flip a repo's status (the watcher skips .git, so this
  // catches edits/creates/deletes — git-only mutations arrive via gitRevision).
  useEffect(() => {
    const watcher = watcherRef.current;
    if (!watcher || !gitEnabled || !active) {
      return;
    }
    return watcher.onEvent(() => scheduleGitRefresh());
  }, [scheduleGitRefresh, gitEnabled, active]);

  // Gutter hunks for the active tab (worktree+index vs HEAD).
  useEffect(() => {
    if (!gitEnabled || !root || !activeTab) {
      setGutter(null);
      return;
    }
    const repo = owningRepoOf(activeTab, gitModel.repoRoots);
    if (!repo) {
      setGutter(null);
      return;
    }
    let stale = false;
    void gitLineDiff(root, repo, repoRelative(activeTab, repo))
      .then((result) => {
        if (!stale) {
          setGutter({ path: activeTab, result });
        }
      })
      .catch(() => {
        if (!stale) {
          setGutter(null);
        }
      });
    return () => {
      stale = true;
    };
  }, [gitEnabled, root, activeTab, gitModel, gitRevision, gutterTick]);

  // Per-file history modal data.
  useEffect(() => {
    if (!historyTarget || !root) {
      setHistoryCommits(null);
      return;
    }
    let stale = false;
    void gitLog(root, historyTarget.repo, 60, 0, repoRelative(historyTarget.path, historyTarget.repo))
      .then((page) => {
        if (!stale) {
          setHistoryCommits(page.commits);
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          onError(err instanceof Error ? err.message : String(err));
          setHistoryTarget(null);
        }
      });
    return () => {
      stale = true;
    };
  }, [historyTarget, root, onError]);

  const treeGit = useMemo<TreeGitIntegration | undefined>(() => {
    if (!gitEnabled || !root) {
      return undefined;
    }
    const model = gitModel;
    const rootDir = root;
    const run = (operation: Promise<unknown>): void => {
      void operation
        .then(() => bumpGitRevision())
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
    };
    const menuFor = (path: string): TreeGitMenuSpec | null => {
      const repo = owningRepoOf(path, model.repoRoots);
      if (!repo) {
        return null;
      }
      const rel = repoRelative(path, repo);
      const entry = model.entries.get(path);
      return {
        canStage: Boolean(entry && (entry.untracked || entry.worktree !== '.')),
        canUnstage: Boolean(entry && !entry.untracked && entry.index !== '.'),
        canDiscard: Boolean(entry && (entry.untracked || entry.worktree !== '.')),
        openDiff: () => onRevealInGit?.({ repo, path: rel }),
        stage: () => run(gitStage(rootDir, repo, [rel])),
        unstage: () => run(gitUnstage(rootDir, repo, [rel])),
        discard: () => run(entry?.untracked ? gitDiscard(rootDir, repo, [], [rel]) : gitDiscard(rootDir, repo, [rel], [])),
        history: () => setHistoryTarget({ path, repo }),
        copyGitHubUrl: () =>
          void gitBrowseUrl(rootDir, repo, { path: rel })
            .then((result) => {
              if (result.ok && result.url) {
                return navigator.clipboard?.writeText(result.url);
              }
              onError(result.error ?? 'gh browse failed');
              return undefined;
            })
            .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      };
    };
    return {
      badgeFor: (path) => model.badges.get(path) ?? null,
      dirHasChanges: (path) => model.changedDirs.has(path),
      repoChipFor: (path) => model.repoChips.get(path) ?? null,
      menuFor
    };
  }, [gitEnabled, root, gitModel, onRevealInGit, onError]);

  /* ---------- quick-open palette (Ctrl+P) ---------- */
  const recentKey = `desk.${variant}.recentFiles`;
  const readRecent = useCallback((): string[] => {
    try {
      const parsed = JSON.parse(localStorage.getItem(recentKey) ?? '[]') as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }, [recentKey]);
  const recordRecent = useCallback(
    (path: string): void => {
      const next = [path, ...readRecent().filter((item) => item !== path)].slice(0, 30);
      localStorage.setItem(recentKey, JSON.stringify(next));
    },
    [readRecent, recentKey]
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteResults, setPaletteResults] = useState<string[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);

  // autoFocus loses to Monaco's own focus management (the editor re-grabs
  // focus after render); assert focus after the modal commits, twice.
  useEffect(() => {
    if (!paletteOpen) {
      return;
    }
    const focus = (): void => paletteInputRef.current?.focus();
    const raf = window.requestAnimationFrame(focus);
    const timer = window.setTimeout(focus, 160);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [paletteOpen]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault();
        event.stopPropagation();
        setPaletteQuery('');
        setPaletteIndex(0);
        setPaletteOpen(true);
      }
    };
    // Capture phase: the keypress must win against Monaco's own keybindings.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active]);

  useEffect(() => {
    if (!paletteOpen || !root) {
      return;
    }
    const query = paletteQuery.trim();
    if (query === '') {
      // Recent files for this root, most recent first.
      setPaletteResults(readRecent().filter((path) => path.startsWith(`${root}/`)));
      setPaletteIndex(0);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      void fsSearchFiles(root, query)
        .then((page) => {
          if (!stale) {
            // fsSearchFiles returns ROOT-RELATIVE paths (rg runs with cwd=root).
            // openFile resolves a relative path against the server cwd and
            // rejects it as "escapes the explorer root", so quick-open used to
            // fail for any root != server cwd (and mint a broken relative-keyed
            // tab when they matched). Resolve to absolute here, as SearchPanel does.
            setPaletteResults(page.matches.map((match) => (root.endsWith('/') ? `${root}${match.path}` : `${root}/${match.path}`)));
            setPaletteIndex(0);
          }
        })
        .catch(() => undefined);
    }, 140);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [paletteOpen, paletteQuery, root, readRecent]);

  /* ---------- bottom status bar context ----------
   * Cursor moves arrive per keystroke; routing them through React state would
   * re-render the whole subsystem, so the position lives in a ref and the
   * publish function (rebuilt each render to capture fresh state) is invoked
   * directly. publishStatus dedupes on segment identity (text/tone/hint/icon/onClick),
   * so a re-publish with unchanged fields and stable handlers costs nothing. */
  // --- Problems / diagnostics panel. Aggregates Monaco markers for the CURRENT open
  // in-root text models (never the global marker store) and toggles a collapsible bottom panel from
  // a stable status-bar segment. Editor-only; no backend/settings/transport involvement. ---
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [problemsPanelHeight, setProblemsPanelHeight] = useState(200);
  const [problemsModel, setProblemsModel] = useState<ProblemsModel>({
    groups: [],
    counts: { errors: 0, warnings: 0, infos: 0 },
    total: 0
  });
  const toggleProblems = useCallback(() => setProblemsOpen((open) => !open), []);
  const closeProblems = useCallback(() => setProblemsOpen(false), []);
  // Read-only LSP status segment (status update): the app-layer wiring writes per-(root,language) lifecycle/
  // progress into a module store; this tick re-publishes the status bar when the active file's entry
  // changes. No command surface -- the segment renders server-derived state only.
  const [lspStatusTick, setLspStatusTick] = useState(0);
  useEffect(() => subscribeLspStatus(() => setLspStatusTick((tick) => tick + 1)), []);
  const recomputeProblems = useCallback(() => {
    const currentRoot = root;
    const prefix = currentRoot ? (currentRoot.endsWith('/') ? currentRoot : `${currentRoot}/`) : null;
    const entries: ProblemEntry[] = [];
    for (const [path, file] of filesRef.current) {
      const model = file.model;
      if (!model || model.uri.scheme !== 'file') {
        continue;
      }
      if (prefix && path !== currentRoot && !path.startsWith(prefix)) {
        continue; // in-root open text models only
      }
      const rel = relativeToRootPath(path, currentRoot);
      for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
        const rawCode = marker.code;
        const code =
          rawCode && typeof rawCode === 'object'
            ? String((rawCode as { value?: unknown }).value ?? '')
            : rawCode != null
              ? String(rawCode)
              : undefined;
        const entry: ProblemEntry = {
          uri: path,
          path: rel,
          severity: marker.severity,
          message: marker.message,
          line: marker.startLineNumber,
          column: marker.startColumn
        };
        if (marker.source) {
          entry.source = marker.source;
        }
        if (code) {
          entry.code = code;
        }
        entries.push(entry);
      }
    }
    setProblemsModel(aggregateProblems(entries));
    if (entries.length > 0) {
      // LSP telemetry (no-op unless DESK_LSP_PERF). Problems rows are marker-derived, so the first
      // non-empty aggregation is both the first diagnostic marker and the first Problems update.
      perfMarkFirst('diagnosticMarker');
      perfMarkFirst('problemsUpdate');
    }
  }, [root]);
  // Monaco fires onDidChangeMarkers on every marker add/change/clear and on model/session disposal,
  // so update/clear/no-stale (model close, session dispose, root switch) all flow from this one sub.
  useEffect(() => {
    recomputeProblems();
    const sub = monaco.editor.onDidChangeMarkers(() => recomputeProblems());
    return () => sub.dispose();
  }, [recomputeProblems, renderTick, tabs]);
  // Collapse on a workspace-root switch so no prior-root problem view lingers.
  useEffect(() => {
    setProblemsOpen(false);
  }, [root]);
  const revealProblem = useCallback((uri: string, line: number, column: number) => {
    void openFileRef.current(uri, { line, column });
  }, []);
  const cursorRef = useRef<{ line: number; column: number } | null>(null);
  const publishBarRef = useRef<() => void>(() => undefined);
  publishBarRef.current = () => {
    const scope = isNotes ? 'notes' : 'editor';
    if (!activeTab) {
      publishStatus(scope, [
        { key: 'file', icon: <FileCode size={11} />, text: isNotes ? 'no note open' : 'no file open' }
      ]);
      return;
    }
    const file = filesRef.current.get(activeTab);
    let dirtyCount = 0;
    for (const open of filesRef.current.values()) {
      if (open.dirty) {
        dirtyCount += 1;
      }
    }
    const segments: StatusSegment[] = [
      {
        key: 'file',
        icon: isNotes ? <StickyNote size={11} /> : <FileCode size={11} />,
        text: relativeToRootPath(activeTab, root),
        hint: `${activeTab} — click to copy the absolute path`,
        onClick: () => {
          void navigator.clipboard?.writeText(activeTab).catch(() => undefined);
        }
      }
    ];
    if (file?.readonlyReason) {
      segments.push({
        key: 'state',
        text: file.readonlyReason === 'binary' ? 'read-only: binary' : 'read-only: too large',
        tone: 'warn'
      });
    } else if (file?.conflict) {
      segments.push({ key: 'state', text: 'disk conflict', tone: 'danger', hint: 'File changed on disk under your edits' });
    } else if (file?.deleted) {
      segments.push({ key: 'state', text: 'deleted on disk', tone: 'danger' });
    } else {
      const save = formatSaveState(dirtyCount);
      segments.push({
        key: 'state',
        text: save.text,
        tone: save.tone,
        hint:
          effectiveAutosave.mode === 'off'
            ? 'Autosave off — Ctrl+S to save'
            : `Autosave: ${effectiveAutosave.mode}${effectiveAutosave.mode === 'after-delay' ? ` (${effectiveAutosave.delayMs}ms)` : ''}`
      });
    }
    if (file?.model && !file.viewer) {
      segments.push({ key: 'lang', text: file.model.getLanguageId(), hint: 'Language' });
      const cursor = cursorRef.current;
      if (cursor) {
        segments.push({ key: 'cursor', text: `Ln ${cursor.line}, Col ${cursor.column}` });
      }
      // Read-only LSP status for this file's language (only present when a session exists for it).
      if (!isNotes && root) {
        const lspStatus = getLspStatus(lspStatusKey(root, file.model.getLanguageId()));
        const lspSegment = lspStatus ? lspStatusSegment(lspStatus) : null;
        if (lspSegment) {
          segments.push(lspSegment);
        }
      }
    } else if (file?.viewer) {
      segments.push({ key: 'lang', text: `${file.viewer} viewer` });
    }
    if (gitEnabled) {
      const repoRoot = owningRepoOf(activeTab, gitModelRef.current.repoRoots);
      const chip = repoRoot ? gitModelRef.current.repoChips.get(repoRoot) : null;
      if (repoRoot && chip) {
        segments.push({
          key: 'git',
          icon: <GitBranch size={11} />,
          text: `${chip.branch ?? 'detached'}${chip.changes > 0 ? ` • ${chip.changes}` : ''}`,
          tone: chip.changes > 0 ? 'warn' : undefined,
          hint: `${repoRoot} — click to open in source control`,
          onClick: onRevealInGit ? () => onRevealInGit({ repo: repoRoot }) : undefined
        });
      }
    }
    if (tabs.length > 1) {
      segments.push({ key: 'tabs', text: `${tabs.length} open` });
    }
    if (!isNotes) {
      const { errors, warnings } = problemsModel.counts;
      segments.push({
        key: 'problems',
        icon: <CircleAlert size={11} />,
        text: `Problems: ${errors}/${warnings}`,
        tone: errors > 0 ? 'danger' : warnings > 0 ? 'warn' : undefined,
        hint: `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} - click to toggle the Problems panel`,
        // toggleProblems has a stable identity, so a count-unchanged re-publish is deduped by the
        // segment equality (which now includes onClick); the functional setter always reads/writes
        // the live panel state, so it never strands.
        onClick: toggleProblems
      });
    }
    publishStatus(scope, segments);
  };
  useEffect(() => {
    publishBarRef.current();
    // renderTick covers dirty/conflict flips (every mutation calls bump()).
  }, [activeTab, tabs, root, renderTick, isNotes, gitModel, problemsModel, lspStatusTick]);

  /** Debounced persistence of the full editor settings block. */
  const persistEditor = useCallback(
    (block: EditorPersistBlock) => {
      if (restoringRef.current) {
        return;
      }
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = window.setTimeout(() => {
        persistTimerRef.current = null;
        const save = isNotes
          ? fsSaveNotesState({ openFiles: block.openFiles, activeFile: block.activeFile })
          : saveSettings({
              editor: { root: block.root ?? undefined, openFiles: block.openFiles, activeFile: block.activeFile }
            });
        void save.catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
      }, 800);
    },
    [onError, isNotes]
  );

  const writeFile = useCallback(
    async (path: string, overwrite: boolean): Promise<void> => {
      if (!root) {
        return;
      }
      const file = filesRef.current.get(path);
      if (!file?.model || savingPathsRef.current.has(path)) {
        return;
      }
      savingPathsRef.current.add(path);
      try {
        // Snapshot content and version together: keystrokes typed while the
        // write is in flight must stay dirty (they are not on disk).
        const contentAtSave = file.model.getValue();
        const versionAtSave = file.model.getAlternativeVersionId();
        const result = await fsWrite(root, path, contentAtSave, overwrite ? undefined : file.mtimeMs);
        // The tab may have closed (or the root switched) while writing.
        if (filesRef.current.get(path) !== file || !file.model) {
          return;
        }
        if (result.ok) {
          file.mtimeMs = result.mtimeMs;
          file.savedVersionId = versionAtSave;
          file.dirty = file.model.getAlternativeVersionId() !== versionAtSave;
          file.conflict = false;
          file.deleted = false;
          if (isNotes && isUntitledNote(fileNameOf(file.path)) && contentAtSave.trim() !== '') {
            // First save with real content: adopt a content-derived filename.
            renameNoteRef.current(file.path, contentAtSave);
          }
          // Disk changed: tree badges and the gutter both need a re-read.
          scheduleGitRefresh();
          setGutterTick((tick) => tick + 1);
        } else {
          file.conflict = true;
        }
        bump();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        savingPathsRef.current.delete(path);
      }
    },
    [root, bump, onError, isNotes, scheduleGitRefresh]
  );

  /**
   * Autosave is strictly weaker than a manual save: it stays mtime-guarded
   * (never overwrites disk changes from agents) and refuses files that are in
   * conflict, deleted on disk, read-only, or already clean. A guarded write
   * that loses the race surfaces the Reload / Keep-mine banner instead of
   * silently picking a side.
   */
  const autosaveFile = useCallback(
    async (path: string): Promise<void> => {
      const file = filesRef.current.get(path);
      if (!file?.model || !file.dirty || file.conflict || file.deleted || file.readonlyReason) {
        return;
      }
      await writeFile(path, false);
    },
    [writeFile]
  );

  /** after-delay mode: (re)arm the per-file idle timer on every keystroke. */
  const scheduleAutosave = useCallback(
    (path: string) => {
      if (autosaveRef.current.mode !== 'after-delay') {
        return;
      }
      const timers = autosaveTimersRef.current;
      const existing = timers.get(path);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      timers.set(
        path,
        window.setTimeout(() => {
          timers.delete(path);
          void autosaveFile(path);
        }, autosaveRef.current.delayMs)
      );
    },
    [autosaveFile]
  );

  const cancelAutosave = useCallback((path: string) => {
    const timer = autosaveTimersRef.current.get(path);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      autosaveTimersRef.current.delete(path);
    }
  }, []);

  const saveAllDirty = useCallback(() => {
    for (const path of filesRef.current.keys()) {
      void autosaveFile(path);
    }
  }, [autosaveFile]);

  // on-focus-change mode: flush dirty buffers when the window blurs or the
  // user leaves the editor subsystem.
  useEffect(() => {
    const onWindowBlur = (): void => {
      if (autosaveRef.current.mode === 'on-focus-change') {
        saveAllDirty();
      }
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [saveAllDirty]);

  useEffect(() => {
    if (!active && autosaveRef.current.mode === 'on-focus-change') {
      saveAllDirty();
    }
  }, [active, saveAllDirty]);

  // Leaving after-delay mode cancels every pending idle timer.
  useEffect(() => {
    if (effectiveAutosave.mode !== 'after-delay') {
      for (const timer of autosaveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      autosaveTimersRef.current.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAutosave.mode]);

  const openFile = useCallback(
    async (path: string, revealTarget?: RevealTarget, render = false): Promise<void> => {
      if (!root) {
        return;
      }
      const gen = rootGenRef.current;
      const files = filesRef.current;
      if (!files.has(path)) {
        // Images and PDFs never go through Monaco — the viewer fetches the
        // raw bytes itself, so there is nothing to read here.
        const viewerKind = viewerKindFor(fileNameOf(path));
        if (viewerKind) {
          files.set(path, {
            path,
            model: null,
            savedVersionId: 0,
            mtimeMs: 0,
            dirty: false,
            conflict: false,
            deleted: false,
            readonlyReason: null,
            size: 0,
            viewer: viewerKind,
            renderMarkdown: false,
            rawRevision: 0
          });
          watcherRef.current?.watch(path);
        } else {
        try {
          const result = await fsRead(root, path);
          if (rootGenRef.current !== gen) {
            // Root switched while the read was in flight — this file belongs
            // to the old root, so drop it without touching state or settings.
            return;
          }
          if (result.ok) {
            initMonaco();
            const uri = monaco.Uri.file(path);
            // A model for this Uri may survive a previous open (createModel
            // throws on duplicates) — reuse it with fresh content.
            const existing = monaco.editor.getModel(uri);
            if (existing) {
              existing.setValue(result.content);
            }
            const model = existing ?? monaco.editor.createModel(result.content, languageForPath(path), uri);
            const file: OpenFile = {
              path,
              model,
              savedVersionId: model.getAlternativeVersionId(),
              mtimeMs: result.mtimeMs,
              dirty: false,
              conflict: false,
              deleted: false,
              readonlyReason: null,
              size: result.size,
              viewer: null,
              renderMarkdown: false,
              rawRevision: 0
            };
            model.onDidChangeContent((event) => {
              const dirty = model.getAlternativeVersionId() !== file.savedVersionId;
              if (dirty !== file.dirty) {
                file.dirty = dirty;
                bump();
              }
              if (dirty) {
                scheduleAutosave(file.path);
              }
              // Editor-owned didChange: push the live buffer edit so edit-sensitive LSP features see
              // unsaved content (the binding no-ops for disabled/untracked models).
              lspBindingRef.current?.changeModel(
                { uri: model.uri.toString(), languageId: model.getLanguageId() },
                { changes: event.changes, fullText: model.getValue() }
              );
            });
            files.set(path, file);
            // LSP telemetry (no-op unless DESK_LSP_PERF): t0 for first-result timings of this open.
            perfMarkOpen();
            // Only successfully-created text models reach here; viewer/binary/readonly tabs below
            // keep model: null and never register. didOpen carries the live model text snapshot.
            lspBindingRef.current?.openModel(
              { uri: model.uri.toString(), languageId: model.getLanguageId() },
              model.getValue()
            );
          } else {
            files.set(path, {
              path,
              model: null,
              savedVersionId: 0,
              mtimeMs: 0,
              dirty: false,
              conflict: false,
              deleted: false,
              readonlyReason: result.reason,
              size: result.size,
              viewer: null,
              renderMarkdown: false,
              rawRevision: 0
            });
          }
          watcherRef.current?.watch(path);
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err));
          return;
        }
        }
      }
      if (render && isMarkdownFile(fileNameOf(path))) {
        const file = filesRef.current.get(path);
        if (file?.model && !file.renderMarkdown) {
          file.renderMarkdown = true;
          // openTab below may be a state no-op for an already-open tab, so
          // force a render for the mode flip.
          bump();
        }
      }
      const next = openTab(tabsRef.current, activeTabRef.current, path);
      setTabState(next.tabs, next.active);
      if (!restoringRef.current) {
        recordRecent(path); // quick-open palette ranking
      }
      if (!restoringRef.current && isNarrowViewport()) {
        collapseSidebarRef.current(); // drawer behavior on phones
      }
      persistEditor({ root, openFiles: next.tabs, activeFile: next.active });
      if (revealTarget && filesRef.current.get(path)?.model) {
        setReveal(revealTarget);
      }
    },
    [root, bump, onError, persistEditor, setTabState, scheduleAutosave, recordRecent]
  );

  // Always-current mirrors so the cross-root opener (a stable, dep-free callback)
  // reads live values without a stale closure.
  const rootRef = useRef(root);
  rootRef.current = root;
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // Opens a path that may live OUTSIDE the current root (e.g. a file link from a
  // chat in another project): under the current root → open directly; otherwise
  // derive a containing root, switch to it, and retry the open until the tab
  // appears. The retry is TIME-driven (not React-state-driven) because the boot
  // root-restore can re-set the SAME root while bumping the read generation,
  // silently dropping an in-flight read with no re-render to react to.
  const openPathAcrossRoots = useCallback(async (path: string): Promise<void> => {
    let target: { root: string; path: string; isDir: boolean };
    try {
      target = await fsRootFor(path);
    } catch {
      return; // unresolvable path — nothing to do
    }
    if (rootRef.current !== target.root) {
      setRoot(target.root);
    }
    // Retry across the boot root-restore race: the editor can re-set the SAME
    // root while bumping the read generation, dropping in-flight work with no
    // re-render to react to. A directory is REVEALED in the tree (opening it as a
    // file would error); a file is opened in a tab.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (rootRef.current !== target.root) {
        setRoot(target.root); // a racing boot/restore moved root — re-assert
        continue;
      }
      if (target.isDir) {
        setSidebarMode('tree');
        await treeActionsRef.current.revealPath(target.path, true);
        if (document.querySelector(`[data-tree-path="${CSS.escape(target.path)}"]`)) {
          return; // revealed (the freshly-switched root's tree may still be mounting otherwise)
        }
      } else {
        if (tabsRef.current.includes(target.path)) {
          return; // opened
        }
        await openFileRef.current(target.path);
      }
    }
  }, []);

  // Cross-subsystem opens (chat/git file links). Registered once; reads live
  // state via refs, so a link opens even when no folder is open yet.
  useEffect(() => {
    registerFileOpener?.((path) => void openPathAcrossRoots(path));
  }, [openPathAcrossRoots, registerFileOpener]);

  // "Reveal in explorer" from the git subsystem: open + expand + flash.
  useEffect(() => {
    if (root) {
      registerFileReveal?.((path) => {
        setSidebarMode('tree');
        void openFile(path);
        void treeActionsRef.current.revealPath(path);
      });
    }
  }, [root, openFile, registerFileReveal]);

  const handleClose = useCallback(
    (path: string) => {
      const file = filesRef.current.get(path);
      if (file?.dirty && !window.confirm(`Discard unsaved changes in ${path}?`)) {
        return;
      }
      cancelAutosave(path);
      // Capture uri/languageId before disposing the model (dispose loses both).
      if (file?.model) {
        lspBindingRef.current?.closeModel({ uri: file.model.uri.toString(), languageId: file.model.getLanguageId() });
      }
      file?.model?.dispose();
      filesRef.current.delete(path);
      watcherRef.current?.unwatch(path);
      const next = closeTab(tabsRef.current, activeTabRef.current, path);
      setTabState(next.tabs, next.active);
      persistEditor({ root, openFiles: next.tabs, activeFile: next.active });
    },
    [root, persistEditor, setTabState, cancelAutosave]
  );

  const handleCloseOthers = useCallback(
    (keep: string) => {
      // handleClose updates tabsRef synchronously, so iterate over a snapshot.
      for (const path of [...tabsRef.current]) {
        if (path !== keep) {
          handleClose(path);
        }
      }
    },
    [handleClose]
  );

  const handleCloseAll = useCallback(() => {
    for (const path of [...tabsRef.current]) {
      handleClose(path);
    }
  }, [handleClose]);

  const toggleRender = useCallback(
    (path: string) => {
      const file = filesRef.current.get(path);
      if (file?.model && isMarkdownFile(fileNameOf(path))) {
        file.renderMarkdown = !file.renderMarkdown;
        bump();
      }
    },
    [bump]
  );

  /** Re-key an open file after an on-disk rename (tab, watcher, autosave, persistence). */
  const adoptRenamedPath = useCallback(
    (oldPath: string, newPath: string) => {
      const file = filesRef.current.get(oldPath);
      if (!file) {
        return;
      }
      cancelAutosave(oldPath);
      filesRef.current.delete(oldPath);
      filesRef.current.set(newPath, file);
      file.path = newPath;
      watcherRef.current?.unwatch(oldPath);
      watcherRef.current?.watch(newPath);
      const nextTabs = tabsRef.current.map((tab) => (tab === oldPath ? newPath : tab));
      const nextActive = activeTabRef.current === oldPath ? newPath : activeTabRef.current;
      setTabState(nextTabs, nextActive);
      persistEditor({ root, openFiles: nextTabs, activeFile: nextActive });
    },
    [root, cancelAutosave, setTabState, persistEditor]
  );

  /** Notes: replace an untitled filename with one derived from the content. */
  const renameNoteForContent = useCallback(
    async (oldPath: string, content: string): Promise<void> => {
      if (!root) {
        return;
      }
      const base = deriveNoteName(content);
      if (base === 'untitled') {
        return;
      }
      const dir = oldPath.slice(0, oldPath.lastIndexOf('/'));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = `${dir}/${noteFileName(base, attempt)}`;
        if (candidate === oldPath) {
          return;
        }
        try {
          await fsRename(root, oldPath, candidate);
          adoptRenamedPath(oldPath, candidate);
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(message)) {
            return; // real failure — silently keep the untitled name
          }
        }
      }
    },
    [root, adoptRenamedPath]
  );
  renameNoteRef.current = (path, content) => void renameNoteForContent(path, content);

  // LSP-aware rename: for a file under an LSP-active root, ask the server (non-mutating
  // willRenameFiles preview) what references would change, show a dialog, and only mutate on
  // explicit Apply. Folders, non-LSP roots, and no-edit results fall back to a plain rename.
  const [fileOpDialog, setFileOpDialog] = useState<FileOpDialogState | null>(null);
  const fileOpDialogRef = useRef<FileOpDialogState | null>(null);
  fileOpDialogRef.current = fileOpDialog;

  /** Force-close every open tab under `dir` (== or descendant). Used after a delete/before rekey. */
  const closeSubtree = useCallback(
    (dir: string) => {
      for (const open of enumerateSubtree(tabsRef.current, dir)) {
        handleClose(open);
      }
    },
    [handleClose]
  );

  const plainRename = useCallback(
    async (from: string, to: string): Promise<void> => {
      if (!root) {
        return;
      }
      await fsRename(root, from, to);
      // Rekey the renamed open tab(s): single file, or every open file under a renamed folder.
      const openUnder = enumerateSubtree(tabsRef.current, from);
      const activeOld = activeTabRef.current;
      const pairs = openUnder.map((old) => ({ old, next: remapSubtreePath(old, from, to) }));
      for (const { old } of pairs) {
        handleClose(old);
      }
      const ordered = [...pairs].sort((a, b) => Number(a.old === activeOld) - Number(b.old === activeOld));
      for (const { next } of ordered) {
        if (next) {
          await openFile(next);
        }
      }
    },
    [root, handleClose, openFile]
  );

  const plainCreate = useCallback(
    async (path: string, kind: 'file' | 'dir'): Promise<void> => {
      if (!root) {
        return;
      }
      await fsCreate(root, path, kind);
    },
    [root]
  );

  const plainDelete = useCallback(
    async (path: string): Promise<void> => {
      if (!root) {
        return;
      }
      await fsDelete(root, path);
      closeSubtree(path);
    },
    [root, closeSubtree]
  );

  // Rekey every open tab/model under `from` -> `to` (single file or a renamed folder subtree),
  // active tab last so it ends focused. Shared by the user rename op and resource-op renames.
  const reconcileRename = useCallback(
    async (from: string, to: string): Promise<void> => {
      const openUnder = enumerateSubtree(tabsRef.current, from);
      if (openUnder.length === 0) {
        return;
      }
      const activeOld = activeTabRef.current;
      const pairs = openUnder.map((old) => ({ old, next: remapSubtreePath(old, from, to) }));
      for (const { old } of pairs) {
        handleClose(old);
      }
      const ordered = [...pairs].sort((a, b) => Number(a.old === activeOld) - Number(b.old === activeOld));
      for (const { next } of ordered) {
        if (next) {
          await openFile(next);
        }
      }
    },
    [handleClose, openFile]
  );

  // Reconcile open tabs/models AFTER a successful apply only. The user op: rename/move rekeys the
  // subtree operation.from -> operation.to; delete force-closes the subtree; create does nothing.
  // Then the server-driven resourceOps (4c, file-only) are reconciled as the AUTHORITATIVE server
  // file-op list (NOT changedFiles): RenameFile rekeys old->new, DeleteFile force-closes, CreateFile
  // does not auto-open. Edited importers in `changes` reload-if-clean via the fs watcher.
  const reconcileFileOp = useCallback(
    async (op: FileOperationDescriptor, resourceOps: LspFileResourceOperation[] = []): Promise<void> => {
      if (op.type === 'rename') {
        await reconcileRename(op.from, op.to);
      } else if (op.type === 'delete') {
        closeSubtree(op.path);
      }
      for (const resourceOp of resourceOps) {
        if (resourceOp.type === 'rename') {
          await reconcileRename(resourceOp.from, resourceOp.to);
        } else if (resourceOp.type === 'delete') {
          closeSubtree(resourceOp.path);
        }
        // create: no auto-open (tree refresh only).
      }
    },
    [reconcileRename, closeSubtree]
  );

  // Preview-first: when createLspBinding is defined the editor tries the non-mutating preview, then
  // falls back to exactly one plain op on no-capability/no-running-session/no-edits. The editor never
  // reads LSP capabilities; the backend is authoritative. 409 -> static error dialog, no mutation.
  const runFileOpPreview = useCallback(
    async (op: FileOperationDescriptor, preview: FileOpPreviewResult, plainFallback: () => Promise<void>): Promise<void> => {
      if (!preview.ok) {
        // Static error (incl resource-ops-not-supported): never a silent plain-op fallback.
        setFileOpDialog({ mode: 'error', op, message: fileOpPreviewMessage(op, preview.reason) });
        return;
      }
      // Dialog-ready when ready AND (text edits OR contained resource ops) exist. A resourceOps-only
      // preview (changes empty) still opens the dialog; plain fallback only when BOTH arrays are empty.
      if (preview.status !== 'ready' || (preview.changes.length === 0 && preview.resourceOps.length === 0)) {
        await plainFallback();
        return;
      }
      setFileOpDialog({
        mode: 'preview',
        op: preview.operation,
        previewId: preview.previewId,
        changes: preview.changes,
        resourceOps: preview.resourceOps,
        busy: false,
        error: null
      });
    },
    []
  );

  const requestRename = useCallback(
    async (from: string, to: string, kind: 'file' | 'dir'): Promise<void> => {
      if (!root) {
        return;
      }
      if (!createLspBinding) {
        await plainRename(from, to);
        return;
      }
      const op: FileOperationDescriptor = { type: 'rename', from, to, kind: kind === 'dir' ? 'folder' : 'file' };
      await runFileOpPreview(op, await fsRenamePreview(root, from, to), () => plainRename(from, to));
    },
    [root, createLspBinding, plainRename, runFileOpPreview]
  );

  const requestCreate = useCallback(
    async (path: string, kind: 'file' | 'dir'): Promise<void> => {
      if (!root) {
        return;
      }
      if (!createLspBinding) {
        await plainCreate(path, kind);
        return;
      }
      const op: FileOperationDescriptor = { type: 'create', path, kind: kind === 'dir' ? 'folder' : 'file' };
      await runFileOpPreview(op, await fsCreatePreview(root, path, kind), () => plainCreate(path, kind));
    },
    [root, createLspBinding, plainCreate, runFileOpPreview]
  );

  const requestDelete = useCallback(
    async (path: string, kind: 'file' | 'dir'): Promise<void> => {
      if (!root) {
        return;
      }
      if (!createLspBinding) {
        await plainDelete(path);
        return;
      }
      const op: FileOperationDescriptor = { type: 'delete', path, kind: kind === 'dir' ? 'folder' : 'file' };
      await runFileOpPreview(op, await fsDeletePreview(root, path), () => plainDelete(path));
    },
    [root, createLspBinding, plainDelete, runFileOpPreview]
  );

  const confirmFileOpApply = useCallback(async (): Promise<void> => {
    const dialog = fileOpDialogRef.current;
    if (!root || !dialog || dialog.mode !== 'preview' || dialog.busy) {
      return;
    }
    const op = dialog.op;
    // Dirty hard-block: any dirty open file in the operated source subtree (rename/move/delete) or in
    // the preview touched set. Backend fingerprints remain the authoritative stale check.
    const sourceDir = op.type === 'rename' ? op.from : op.type === 'delete' ? op.path : undefined;
    const dirtyOpen = [...tabsRef.current].filter((path) => filesRef.current.get(path)?.dirty);
    const blocked = fileOpDirtyBlock({
      dirtyPaths: dirtyOpen,
      sourceDir,
      touchedPaths: dialog.changes.map((change) => change.path),
      resourceOpPaths: resourceOpPaths(dialog.resourceOps)
    });
    if (blocked.length > 0) {
      setFileOpDialog({ ...dialog, error: `Save or discard changes in ${blocked.map(fileNameOf).join(', ')} before applying.` });
      return;
    }
    setFileOpDialog({ ...dialog, busy: true, error: null });
    const result =
      op.type === 'rename'
        ? await fsRenameApply(root, dialog.previewId)
        : op.type === 'create'
          ? await fsCreateApply(root, dialog.previewId)
          : await fsDeleteApply(root, dialog.previewId);
    if (result.ok) {
      setFileOpDialog(null);
      // Reconcile only after backend ok; the apply result's operation + resourceOps are authoritative.
      await reconcileFileOp(result.operation, result.resourceOps);
      return;
    }
    const message =
      result.error === 'lsp file operation rollback failed'
        ? `Apply failed and changes could not be fully rolled back. Review: ${(result.affectedPaths ?? []).join(', ') || 'affected files'}.`
        : fileOpApplyMessage(op, result.error);
    setFileOpDialog({ ...dialog, busy: false, error: message });
  }, [root, reconcileFileOp]);

  // Secondary action: skip the LSP refactor edits and perform just the plain fs op.
  const skipFileOpRefactor = useCallback(async (): Promise<void> => {
    const dialog = fileOpDialogRef.current;
    if (!dialog) {
      return;
    }
    const op = dialog.op;
    setFileOpDialog(null);
    if (op.type === 'rename') {
      await plainRename(op.from, op.to);
    } else if (op.type === 'create') {
      await plainCreate(op.path, op.kind === 'folder' ? 'dir' : 'file');
    } else {
      await plainDelete(op.path);
    }
  }, [plainRename, plainCreate, plainDelete]);

  /**
   * Mint a new note (optionally pre-filled) and open it. Requests arriving
   * before the root is ready (e.g. terminal "create note" on first activation)
   * queue up and drain once boot finishes.
   */
  const pendingNotesRef = useRef<Array<string | undefined>>([]);
  const createNote = useCallback(
    async (content?: string): Promise<void> => {
      if (!root) {
        pendingNotesRef.current.push(content);
        return;
      }
      const base = deriveNoteName(content);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const path = `${root}/${noteFileName(base, attempt)}`;
        try {
          await fsCreate(root, path, 'file');
          if (content) {
            await fsWrite(root, path, content);
          }
          await openFile(path);
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(message)) {
            onError(message);
            return;
          }
        }
      }
      onError('could not allocate a note filename');
    },
    [root, openFile, onError]
  );
  const createNoteRef = useRef(createNote);
  createNoteRef.current = createNote;

  useEffect(() => {
    if (isNotes) {
      registerNoteCreator?.((content) => void createNoteRef.current(content));
    }
  }, [registerNoteCreator, isNotes]);

  // Drain note-creations that arrived before the root was ready.
  useEffect(() => {
    if (!root || pendingNotesRef.current.length === 0) {
      return;
    }
    const pending = [...pendingNotesRef.current];
    pendingNotesRef.current = [];
    void (async () => {
      for (const content of pending) {
        await createNoteRef.current(content);
      }
    })();
  }, [root]);

  const handleSave = useCallback(
    async (overwrite = false): Promise<void> => {
      const path = activeTabRef.current;
      if (path) {
        cancelAutosave(path); // a manual save supersedes any pending idle save
        await writeFile(path, overwrite);
      }
    },
    [writeFile, cancelAutosave]
  );

  const reloadFromDisk = useCallback(
    async (path: string): Promise<void> => {
      if (!root) {
        return;
      }
      const file = filesRef.current.get(path);
      if (!file?.model) {
        return;
      }
      try {
        const versionBefore = file.model.getAlternativeVersionId();
        const result = await fsRead(root, path);
        if (!result.ok) {
          return;
        }
        // The file may have been closed (or the root switched) mid-read.
        if (filesRef.current.get(path) !== file || !file.model) {
          return;
        }
        // Keystrokes typed while the read was in flight must not be clobbered
        // by setValue — flag the conflict and let the user decide instead.
        if (file.model.getAlternativeVersionId() !== versionBefore) {
          file.conflict = true;
          bump();
          return;
        }
        // Skip the rewrite when content matches (e.g. the change event from
        // our own save) so the undo stack and cursor survive.
        if (file.model.getValue() !== result.content) {
          file.model.setValue(result.content);
        }
        file.mtimeMs = result.mtimeMs;
        file.savedVersionId = file.model.getAlternativeVersionId();
        file.dirty = false;
        file.conflict = false;
        file.deleted = false;
        setGutterTick((tick) => tick + 1); // external edit landed — re-read hunks
        bump();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [root, bump, onError]
  );

  // Disk events for open files (directory events are the tree's job).
  useEffect(() => {
    const watcher = watcherRef.current;
    if (!watcher) {
      return;
    }
    return watcher.onEvent((event) => {
      if (event.path !== event.watched) {
        return;
      }
      const file = filesRef.current.get(event.path);
      if (!file) {
        return;
      }
      if (event.event === 'unlink') {
        file.deleted = true;
        bump();
      } else if (event.event === 'change') {
        if (file.viewer) {
          // Image/pdf viewers re-fetch the raw bytes on the next render.
          file.deleted = false;
          file.rawRevision += 1;
          bump();
        } else if (file.dirty) {
          file.conflict = true;
          bump();
        } else {
          void reloadFromDisk(event.path);
        }
      }
    });
    // `active` must be a dep: the watcher is created lazily in the render body only once
    // active flips true, so without it this effect runs once at mount (watcher null → no
    // subscription) and never re-runs — open-file disk events then go unwatched for any
    // session that did not boot with the editor active.
  }, [active, bump, reloadFromDisk]);

  // Lazy boot: resolve the root from settings, falling back to home.
  useEffect(() => {
    if (!active || booted) {
      return;
    }
    setBooted(true);
    void (async () => {
      try {
        if (isNotes) {
          const notesRoot = await fsNotesHome();
          rootGenRef.current += 1;
          setRoot(notesRoot);
          return;
        }
        const settings = await fetchSettings();
        const saved = settings.editor?.root;
        if (saved) {
          const check = await fsValidate(saved);
          if (check.ok) {
            rootGenRef.current += 1;
            setRoot(check.resolved ?? saved);
            return;
          }
        }
        const home = await fsHome();
        rootGenRef.current += 1;
        setRoot(home);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [active, booted, onError, isNotes]);

  // One-shot restore of the previous session's open files.
  useEffect(() => {
    if (!root || restoredRef.current) {
      return;
    }
    restoredRef.current = true;
    const gen = rootGenRef.current;
    restoringRef.current = true;
    void (async () => {
      try {
        const state = isNotes ? await fsNotesState() : (await fetchSettings()).editor;
        for (const path of state?.openFiles ?? []) {
          if (rootGenRef.current !== gen) {
            return; // root switched mid-restore — abandon the old root's tabs
          }
          // Sequential: openFile reports failures via onError and continues.
          await openFile(path);
        }
        if (rootGenRef.current !== gen) {
          return;
        }
        const remembered = state?.activeFile;
        if (remembered && tabsRef.current.includes(remembered)) {
          activeTabRef.current = remembered;
          setActiveTab(remembered);
        }
        // Single persist with the final restored state — the per-open persists
        // were suppressed so the remembered activeFile is not clobbered.
        restoringRef.current = false;
        persistEditor({ root, openFiles: tabsRef.current, activeFile: activeTabRef.current });
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        restoringRef.current = false;
      }
    })();
  }, [root, openFile, onError, persistEditor, isNotes]);

  const applyRoot = async (candidate: string): Promise<void> => {
    const path = candidate.trim();
    if (!path) {
      return;
    }
    try {
      const check = await fsValidate(path);
      if (!check.ok) {
        onError(check.error ?? `not a directory: ${path}`);
        return;
      }
      const resolved = check.resolved ?? path;
      // Switching root disposes every open model and clears the tab list. Confirm
      // first if any buffer is unsaved — otherwise switching root silently threw
      // away in-progress edits (only per-tab close had a dirty guard).
      const dirtyPaths = [...filesRef.current.entries()].filter(([, file]) => file.dirty).map(([openPath]) => openPath);
      if (dirtyPaths.length > 0) {
        const summary = dirtyPaths.length === 1 ? dirtyPaths[0] : `${dirtyPaths.length} files`;
        if (!window.confirm(`Discard unsaved changes in ${summary} and switch workspace root?`)) {
          return;
        }
      }
      // Invalidate in-flight opens/restores from the previous root and stop
      // suppressing persistence so the new root is written out.
      rootGenRef.current += 1;
      restoringRef.current = false;
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      for (const timer of autosaveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      autosaveTimersRef.current.clear();
      for (const [openPath, file] of filesRef.current) {
        file.model?.dispose();
        watcherRef.current?.unwatch(openPath);
      }
      filesRef.current.clear();
      setTabState([], null);
      setRoot(resolved);
      setPickerOpen(false);
      persistEditor({ root: resolved, openFiles: [], activeFile: null });
      if (!isNotes) {
        publishEditorRoot(resolved);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const tabMeta = useMemo(() => {
    const map = new Map<string, TabMeta>();
    for (const tab of tabs) {
      const file = filesRef.current.get(tab);
      map.set(tab, {
        dirty: file?.dirty ?? false,
        conflict: file?.conflict ?? false,
        deleted: file?.deleted ?? false,
        markdown: Boolean(file?.model) && isMarkdownFile(fileNameOf(tab)),
        rendered: file?.renderMarkdown ?? false
      });
    }
    return map;
    // renderTick invalidates the memo when mutable OpenFile flags change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeTab, renderTick]);

  const activeFile = activeTab ? filesRef.current.get(activeTab) ?? null : null;
  const builtTheme = useDeskTheme();

  // Active viewer panel (image, pdf, or rendered markdown) — overlays the
  // always-mounted Monaco host so per-tab view state survives mode switches.
  const viewerNode =
    activeTab && activeFile
      ? activeFile.viewer === 'image' && root
        ? <ImageView src={rawFileUrl(root, activeTab, activeFile.rawRevision)} name={fileNameOf(activeTab)} />
        : activeFile.viewer === 'pdf' && root
          ? <PdfView src={rawFileUrl(root, activeTab, activeFile.rawRevision)} name={fileNameOf(activeTab)} />
          : activeFile.renderMarkdown && activeFile.model && root
            ? (
                <Suspense fallback={<div className="viewerStatus">loading renderer…</div>}>
                  <MarkdownView
                    model={activeFile.model}
                    path={activeTab}
                    root={root}
                    mode={builtTheme.mode}
                    onOpenPath={(target) => void openFile(target)}
                  />
                </Suspense>
              )
            : null
      : null;

  return (
    <Group
      orientation="horizontal"
      className={`subsystemPanels editorPanels ${sidebarCollapsed ? 'editorSidebarCollapsed' : ''} ${sidebarAnimating ? 'sidebarAnimating' : ''}`}
      id={groupDomId}
    >
      <Panel
        id={panelId}
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
        <aside className="editorTreePanelInner editorSidebar">
          <div className="sidebarHeader">
            <div className="railTitle">
              {isNotes ? <StickyNote size={12} /> : <FolderTree size={12} />}
              <TextReveal as="span" manager="decipher">{isNotes ? 'Notes' : 'Files'}</TextReveal>
            </div>
            <div className="railActions">
              <IconButton
                icon={<FilePlus size={12} />}
                label={isNotes ? 'New note' : 'New file'}
                disabled={(isNotes ? false : sidebarMode !== 'tree') || !root}
                onClick={() => {
                  if (isNotes) {
                    // Direct creation: untitled note opens immediately in the
                    // editor; the first save names it from the content.
                    setSidebarMode('tree');
                    void createNoteRef.current();
                  } else {
                    treeActionsRef.current.createFile();
                  }
                }}
              />
              <IconButton
                icon={<FolderPlus size={12} />}
                label="New directory"
                disabled={sidebarMode !== 'tree' || !root}
                onClick={() => treeActionsRef.current.createDir()}
              />
              <IconButton
                icon={<RefreshCw size={12} />}
                label="Refresh"
                disabled={sidebarMode !== 'tree' || !root}
                onClick={() => treeActionsRef.current.refresh()}
              />
              <IconButton
                icon={sidebarMode === 'search' ? <ListTree size={12} /> : <Search size={12} />}
                label={sidebarMode === 'search' ? 'Browse files' : 'Search files'}
                onClick={() => setSidebarMode((mode) => (mode === 'search' ? 'tree' : 'search'))}
              />
            </div>
          </div>
          {isNotes ? null : (
          <div className="editorRootSelect" ref={rootSelectRef}>
            <button
              type="button"
              className={`editorRootButton ${pickerOpen ? 'open' : ''}`}
              style={{ clipPath: CLIP_OCTAGON_TINY }}
              title={root ?? 'Pick root directory'}
              onMouseEnter={() => bleeps.hover?.play()}
              onClick={() => {
                bleeps.click?.play();
                setPickerValue(root ?? '');
                setPickerOpen((open) => !open);
              }}
            >
              <Home size={12} />
              <span className="editorRootPath">{root ?? 'select root…'}</span>
              <ChevronDown size={12} className={pickerOpen ? 'flip' : ''} />
            </button>
            {pickerOpen ? (
              <Animator combine manager="stagger" duration={{ enter: 0.18, stagger: 0.02 }}>
                <Animated className="editorRootPanel" animated={['fade', ['y', -6, 0]]} style={{ clipPath: CLIP_OCTAGON_TINY }}>
                  <input
                    className="treeInlineInput"
                    autoFocus
                    placeholder="/absolute/path"
                    value={pickerValue}
                    onChange={(event) => setPickerValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void applyRoot(pickerValue);
                      }
                    }}
                  />
                  <Animator>
                    <Animated
                      as="button"
                      type="button"
                      className="deskSelectOption"
                      animated={['flicker']}
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        void fsHome()
                          .then((home) => applyRoot(home))
                          .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
                      }}
                    >
                      <Home size={11} />
                      <span>~ (home)</span>
                    </Animated>
                  </Animator>
                  {shortcuts.map((path) => (
                    <Animator key={path}>
                      <Animated
                        as="button"
                        type="button"
                        className={`deskSelectOption ${path === root ? 'selected' : ''}`}
                        animated={['flicker']}
                        title={path}
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          void applyRoot(path);
                        }}
                      >
                        <Folder size={11} />
                        <span>{path}</span>
                      </Animated>
                    </Animator>
                  ))}
                </Animated>
              </Animator>
            ) : null}
          </div>
          )}
          {sidebarMode === 'tree' && root && watcherRef.current ? (
            <ExplorerTree
              root={root}
              watcher={watcherRef.current}
              activePath={activeTab}
              onOpenFile={(path) => void openFile(path)}
              onOpenRendered={(path) => void openFile(path, undefined, true)}
              onRenameFile={requestRename}
              onCreateFile={requestCreate}
              onDeleteFile={requestDelete}
              onError={onError}
              registerActions={registerTreeActions}
              git={treeGit}
              onVisibleDirsChange={gitEnabled ? handleVisibleDirs : undefined}
            />
          ) : null}
          {root && sidebarMode === 'search' ? (
            <SearchPanel
              root={root}
              onOpenFile={(path, revealTarget) => void openFile(path, revealTarget)}
              onError={onError}
            />
          ) : null}
        </aside>
      </Panel>
      <Separator className="panelResizeHandle" disabled={sidebarCollapsed} onPointerDown={() => setSidebarHandleDragActive(true)} />
      <Panel id={isNotes ? 'notes-surface' : 'editor-surface'} minSize={surfaceMinSize(narrowViewport)} className="subsystemSurface">
        {narrowViewport && !sidebarCollapsed ? (
          <button type="button" className="drawerScrim" aria-label="Close sidebar" onClick={() => collapseSidebarRef.current()} />
        ) : null}
        <main className="editorStage">
          <EditorTabs
            tabs={tabs}
            active={activeTab}
            meta={tabMeta}
            onSelect={(path) => {
              const previous = activeTabRef.current;
              if (previous && previous !== path && autosaveRef.current.mode === 'on-focus-change') {
                void autosaveFile(previous);
              }
              activeTabRef.current = path;
              setActiveTab(path);
              persistEditor({ root, openFiles: tabsRef.current, activeFile: path });
            }}
            onClose={handleClose}
            onCloseOthers={handleCloseOthers}
            onCloseAll={handleCloseAll}
            onToggleRender={toggleRender}
            onMove={(from, to) => {
              const next = moveTab(tabsRef.current, from, to);
              setTabState(next, activeTabRef.current);
              persistEditor({ root, openFiles: next, activeFile: activeTabRef.current });
            }}
            extraMenuItems={(path) => {
              const items = [
                {
                  icon: <ClipboardCopy size={12} />,
                  label: 'Copy path',
                  action: () => void navigator.clipboard?.writeText(path).catch(() => undefined)
                },
                {
                  icon: <ListTree size={12} />,
                  label: 'Reveal in tree',
                  action: () => {
                    setSidebarMode('tree');
                    void treeActionsRef.current.revealPath(path);
                  }
                }
              ];
              if (gitEnabled && root) {
                const repo = owningRepoOf(path, gitModelRef.current.repoRoots);
                if (repo) {
                  if (gitModelRef.current.badges.has(path)) {
                    items.push({
                      icon: <GitCompareArrows size={12} />,
                      label: 'Open diff',
                      action: () => onRevealInGit?.({ repo, path: repoRelative(path, repo) })
                    });
                  }
                  items.push({
                    icon: <History size={12} />,
                    label: 'File history',
                    action: () => setHistoryTarget({ path, repo })
                  });
                }
              }
              return items;
            }}
          />
          {activeFile?.conflict || activeFile?.deleted ? (
            <div className="editorConflictBanner">
              <AlertTriangle size={12} />
              <span>
                {activeFile.deleted
                  ? 'Deleted on disk — saving will recreate it.'
                  : 'Changed on disk while you have unsaved edits.'}
              </span>
              {!activeFile.deleted ? (
                <Cmd
                  icon={<RotateCcw size={12} />}
                  label="Reload"
                  onClick={() => activeTab && void reloadFromDisk(activeTab)}
                />
              ) : null}
              <Cmd
                icon={<Save size={12} />}
                label={activeFile.deleted ? 'Re-save' : 'Keep mine'}
                tone="danger"
                onClick={() => void handleSave(true)}
              />
            </div>
          ) : null}
          {activeFile?.readonlyReason ? (
            <DeskPanel texture>
              <div className="editorPlaceholder">
                <TextReveal as="span" manager="sequence">
                  {activeFile.readonlyReason === 'binary'
                    ? 'Binary file — view it elsewhere.'
                    : `File too large to edit (${Math.round(activeFile.size / 1024)} KB).`}
                </TextReveal>
              </div>
            </DeskPanel>
          ) : activeFile ? (
            <div className="editorHostWrap">
              <MonacoHost
                model={activeFile.model}
                activePath={activeTab}
                reveal={reveal}
                onRevealConsumed={() => setReveal(null)}
                onSave={() => void handleSave()}
                onCursor={(position) => {
                  cursorRef.current = position;
                  publishBarRef.current();
                }}
                gutter={gutter && gutter.path === activeTab ? gutter.result : null}
              />
              {viewerNode ? <div className="viewerOverlay">{viewerNode}</div> : null}
            </div>
          ) : (
            <DeskPanel texture>
              <div className="editorPlaceholder">
                <TextReveal as="span" manager="sequence">Open a file to start editing.</TextReveal>
              </div>
            </DeskPanel>
          )}
          {isNotes ? null : (
            <ProblemsPanel
              model={problemsModel}
              open={problemsOpen}
              height={problemsPanelHeight}
              onResizeHeight={setProblemsPanelHeight}
              onClose={closeProblems}
              onReveal={revealProblem}
            />
          )}
          {historyTarget && root ? (
            <Modal
              title={`History — ${fileNameOf(historyTarget.path)}`}
              icon={<History size={13} />}
              onClose={() => setHistoryTarget(null)}
            >
              <div className="fileHistoryList">
                {historyCommits === null ? (
                  <span className="fileHistoryEmpty">loading…</span>
                ) : historyCommits.length === 0 ? (
                  <span className="fileHistoryEmpty">No commits touch this file.</span>
                ) : (
                  historyCommits.map((commit) => (
                    <button
                      key={commit.sha}
                      type="button"
                      className="fileHistoryRow"
                      title={`${commit.sha}\n${commit.author} — ${commit.date}`}
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        const target = historyTarget;
                        setHistoryTarget(null);
                        onRevealInGit?.({
                          repo: target.repo,
                          path: repoRelative(target.path, target.repo),
                          sha: commit.sha
                        });
                      }}
                    >
                      <code className="fileHistorySha">{commit.sha.slice(0, 7)}</code>
                      <span className="fileHistorySubject">{commit.subject}</span>
                      <small className="fileHistoryMeta">
                        {commit.author} · {shortTimeAgo(commit.date)}
                      </small>
                    </button>
                  ))
                )}
              </div>
            </Modal>
          ) : null}
          {fileOpDialog ? (
            <Modal title={`LSP-aware ${fileOpVerb(fileOpDialog.op)}`} icon={<FileCode size={13} />} onClose={() => setFileOpDialog(null)}>
              {fileOpDialog.mode === 'preview' ? (
                <div className="thinForm modalForm">
                  <small className="settingsHint" style={{ opacity: 0.7 }}>You requested:</small>
                  <span className="settingsSectionLabel">{fileOpSummary(fileOpDialog.op)}</span>
                  {fileOpDialog.changes.length > 0 ? (
                    <>
                      <small className="settingsHint">
                        Update references in {fileOpDialog.changes.length} file
                        {fileOpDialog.changes.length === 1 ? '' : 's'}:
                      </small>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflow: 'auto' }}>
                        {fileOpDialog.changes.map((change) => (
                          <div key={change.path} style={{ fontSize: 11 }}>
                            {change.path}{' '}
                            <span style={{ opacity: 0.6 }}>
                              ({change.edits.length} edit{change.edits.length === 1 ? '' : 's'})
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {fileOpDialog.resourceOps.length > 0 ? (
                    <>
                      <small className="settingsHint" style={{ marginTop: 4 }}>The language server will also change files on disk:</small>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflow: 'auto' }}>
                        {fileOpDialog.resourceOps.filter((r) => r.type === 'create').map((r) => (
                          <div key={`c:${r.type === 'create' ? r.path : ''}`} style={{ fontSize: 11 }}>
                            <span style={{ opacity: 0.6 }}>CREATE</span> {r.type === 'create' ? r.path : ''}
                          </div>
                        ))}
                        {fileOpDialog.resourceOps.filter((r) => r.type === 'rename').map((r) => (
                          <div key={`r:${r.type === 'rename' ? r.from : ''}`} style={{ fontSize: 11 }}>
                            <span style={{ opacity: 0.6 }}>RENAME</span> {r.type === 'rename' ? `${r.from} -> ${r.to}` : ''}
                          </div>
                        ))}
                        {fileOpDialog.resourceOps.filter((r) => r.type === 'delete').map((r) => (
                          <div key={`d:${r.type === 'delete' ? r.path : ''}`} style={{ fontSize: 11, fontWeight: 600, color: 'var(--desk-danger, #ff5f56)' }}>
                            DELETE {r.type === 'delete' ? r.path : ''}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {fileOpDialog.error ? (
                    <small className="settingsHint" style={{ color: 'var(--desk-warn, #e6a500)' }}>
                      {fileOpDialog.error}
                    </small>
                  ) : null}
                  <div className="autosaveRow">
                    <button
                      type="button"
                      disabled={fileOpDialog.busy}
                      onClick={() => void confirmFileOpApply()}
                      style={renameButtonStyle(fileOpDialog.busy)}
                    >
                      {fileOpDialog.resourceOps.length > 0
                        ? `Apply ${fileOpVerb(fileOpDialog.op)} + file changes`
                        : `Apply ${fileOpVerb(fileOpDialog.op)} + update references`}
                    </button>
                    {/* No edits-only/skip path when the transaction contains resource ops: it is all-or-nothing. */}
                    {fileOpDialog.resourceOps.length === 0 ? (
                      <button
                        type="button"
                        disabled={fileOpDialog.busy}
                        onClick={() => void skipFileOpRefactor()}
                        style={renameButtonStyle(fileOpDialog.busy)}
                      >
                        {fileOpVerb(fileOpDialog.op) === 'rename' ? 'Rename only' : `${fileOpDialog.op.type === 'create' ? 'Create' : 'Delete'} without edits`}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={fileOpDialog.busy}
                      onClick={() => setFileOpDialog(null)}
                      style={renameButtonStyle(fileOpDialog.busy)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="thinForm modalForm">
                  <small className="settingsHint">{fileOpDialog.message}</small>
                  <div className="autosaveRow">
                    <button type="button" onClick={() => void skipFileOpRefactor()} style={renameButtonStyle(false)}>
                      {fileOpVerb(fileOpDialog.op) === 'rename' ? 'Rename only' : `${fileOpDialog.op.type === 'create' ? 'Create' : 'Delete'} without edits`}
                    </button>
                    <button type="button" onClick={() => setFileOpDialog(null)} style={renameButtonStyle(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Modal>
          ) : null}
          {paletteOpen && root ? (
            <Modal title="Go to file" icon={<Search size={13} />} onClose={() => setPaletteOpen(false)}>
              <div className="quickOpen">
                <input
                  ref={paletteInputRef}
                  className="treeInlineInput quickOpenInput"
                  autoFocus
                  placeholder="fuzzy file name… (↑↓ to move, Enter to open)"
                  value={paletteQuery}
                  onChange={(event) => setPaletteQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setPaletteIndex((index) => Math.min(index + 1, paletteResults.length - 1));
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setPaletteIndex((index) => Math.max(index - 1, 0));
                    } else if (event.key === 'Enter') {
                      const target = paletteResults[paletteIndex];
                      if (target) {
                        setPaletteOpen(false);
                        void openFile(target);
                      }
                    }
                  }}
                />
                <div className="quickOpenResults">
                  {paletteResults.length === 0 ? (
                    <span className="fileHistoryEmpty">
                      {paletteQuery.trim() === '' ? 'No recent files yet.' : 'No matches.'}
                    </span>
                  ) : (
                    paletteResults.slice(0, 40).map((path, index) => (
                      <button
                        key={path}
                        type="button"
                        className={`quickOpenRow ${index === paletteIndex ? 'selected' : ''}`}
                        title={path}
                        onMouseEnter={() => setPaletteIndex(index)}
                        onClick={() => {
                          bleeps.click?.play();
                          setPaletteOpen(false);
                          void openFile(path);
                        }}
                      >
                        <span className="quickOpenName">{fileNameOf(path)}</span>
                        <small className="quickOpenDir">{relativeToRootPath(path, root)}</small>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </Modal>
          ) : null}
        </main>
      </Panel>
    </Group>
  );
}
