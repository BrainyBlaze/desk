import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode
} from 'react';
import {
  Animated,
  Animator,
  AnimatorGeneralProvider,
  BleepsOnAnimator,
  BleepsProvider,
  FrameLines,
  useBleeps
} from '@arwes/react';
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Braces,
  CheckCheck,
  Copy,
  FileCode,
  Folder,
  FolderPlus,
  FolderTree,
  GitBranch,
  Palette,
  Info,
  LayoutGrid,
  MessagesSquare,
  NotebookPen,
  Plus,
  RefreshCw,
  RotateCw,
  Settings as SettingsIcon,
  Skull,
  SquareKanban,
  SquareTerminal,
  StickyNote,
  TerminalSquare,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
  X,
  Zap
} from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import {
  addGroup,
  addProject,
  addProjectGroup,
  addProjectSession,
  addSession,
  clearAttention,
  deleteProject,
  deleteProjectGroup,
  deleteProjectSession,
  editProject,
  editProjectGroup,
  editProjectSession,
  setSessionUiMode,
  ApiCodeError,
  fetchDeskSnapshot,
  killAllAgents,
  fetchSettings,
  clearAllEvents,
  markEventsRead,
  moveProjectSession,
  reorderProjects,
  reorderGroups,
  reorderSessions,
  saveGroupLayoutSizes,
  saveSettings,
  saveLspSettings,
  fetchDetectedLanguages,
  restartProjectSession,
  upDesk,
  type AgentEvent,
  type DeskAutosaveMode,
  type DeskFetchedUiSettings,
  type DeskUiSettings
} from './api.js';
import { fireAndForget, toErrorMessage } from './asyncSafe.js';
import { reconcileInitialSetting } from './initialSettingsReconcile.js';
import { TerminalSurface } from './TerminalSurface.js';
import { StatusBar } from './StatusBar.js';
import { publishStatus, type StatusSegment } from './statusSegments.js';
import {
  SIDEBAR_WIDTH_STORAGE_PREFIX,
  clampSidebarWidth,
  createSidebarWidthPersister,
  readStoredSidebarWidth,
  AGENT_SIDEBAR_MAX_SIZE,
  AGENT_SIDEBAR_MIN_SIZE,
  AGENT_SIDEBAR_STORAGE_KEY,
  isAgentSidebarCollapseSize,
  isNarrowViewport,
  isSidebarHandleDragActive,
  setSidebarHandleDragActive,
  surfaceMinSize,
  useNarrowViewport,
  readStoredSidebarCollapsed
} from './sidebarPanel.js';
import { usePersistedCollapse } from './usePersistedCollapse.js';
import { useSubsystemSidebars } from './useSubsystemSidebars.js';
import { getMovedSessionTmux, getProjectDropGroup } from './sidebarMove.js';
import { usePulse } from './usePulse.js';
import { useStableCallbacks } from './stableCallbacks.js';
import { useClampedMenu } from './menuPosition.js';
import { shortTimeAgo } from './git/gitStatusMeta.js';
import { buildSessionPayload } from './sessionFormPayload.js';
import { SESSION_AGENT_OPTIONS, supportsBypassPermissions, supportsNativeUi } from './sessionAgentOptions.js';
import type { DeskSessionUiMode } from '../core/types.js';
import { CommandButton } from './headerPrimitives.js';
import { WorkspaceHeader } from './WorkspaceHeader.js';
import { AgentsSidebar } from './AgentsSidebar.js';
import { AgentMultiplexer } from './AgentMultiplexer.js';
import { StatusDot } from './statusDot.js';
import type { LayoutKind, PanelCell } from './muxLayout.js';
import type { DeskGroupView, DeskProjectView, DeskSessionView } from '../ui/model.js';
import { buildWorkspaceState } from '../ui/workspace.js';
import type { DeskSnapshot } from './types.js';
import { createDeskBleepsSettings, readStoredMuted, MUTED_STORAGE_KEY, type DeskBleepName } from './arwes/bleeps.js';
import { DESK_DURATIONS, isReducedMotion } from './arwes/motion.js';
import {
  DESK_THEMES,
  DESK_THEME_NAMES,
  THEME_STORAGE_KEY,
  createDeskTheme,
  readStoredTheme,
  type DeskThemeName
} from './arwes/theme.js';
import {
  BackdropField,
  CLIP_OCTAGON_TINY,
  DeskSelect,
  DeskThemeContext,
  IconButton,
  Modal,
  TextReveal
} from './arwes/primitives.js';
import { EditorSubsystem } from './editor/EditorSubsystem.js';
import { resolveLspConfig, makeCreateLspBinding, type LspUiConfig } from './editor/lsp/appLspWiring.js';
import { setLspStatus, clearLspStatus, lspStatusKey } from './editor/lsp/lspStatusStore.js';
import { useEditorRoot } from './editorRoot.js';
import { installLspProviders } from './editor/lsp/monacoLspClient.js';
import { createBuiltinCoexistenceController } from './editor/lsp/monacoBuiltinCoexistence.js';
import { createMonacoDiagnostics } from './editor/lsp/monacoDiagnostics.js';
import { GitSubsystem, type GitNavigateTarget } from './git/GitSubsystem.js';
import { ProjectsSubsystem } from './projects/ProjectsSubsystem.js';
import { ChannelsSubsystem } from './channels/ChannelsSubsystem.js';

type Subsystem = 'agents' | 'editor' | 'git' | 'notes' | 'projects' | 'channels';
const SUBSYSTEMS: readonly Subsystem[] = ['agents', 'editor', 'git', 'notes', 'projects', 'channels'];
function readStoredSubsystem(value: string | null): Subsystem {
  return value !== null && (SUBSYSTEMS as readonly string[]).includes(value) ? (value as Subsystem) : 'agents';
}
type ToastTone = 'error' | 'ok' | 'info';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}
type ModalMode =
  | 'addProject'
  | 'addGroup'
  | 'addSession'
  | 'projectInfo'
  | 'groupInfo'
  | 'sessionInfo'
  | 'editProject'
  | 'editGroup'
  | 'editSession'
  | 'deleteProject'
  | 'deleteGroup'
  | 'deleteSession'
  | 'restartSession'
  | 'switchUiMode'
  | 'settings'
  | 'killAll'
  | null;

interface ProjectForm {
  projectId: string;
  projectLabel: string;
  cwd: string;
}

interface GroupForm {
  projectId: string;
  groupId: string;
  groupLabel: string;
  layoutKind: LayoutKind;
  customCells: number;
}

interface SessionForm {
  projectId: string;
  groupId: string;
  name: string;
  cwd: string;
  agent: string;
  resume: string;
  initialResume: string;
  bypassPermissions: boolean;
  command: string;
  uiMode: DeskSessionUiMode;
  model: string;
}

const emptyProjectForm: ProjectForm = {
  projectId: '',
  projectLabel: '',
  cwd: '~/projects/'
};

const emptyGroupForm: GroupForm = {
  projectId: '',
  groupId: '',
  groupLabel: '',
  layoutKind: '2x2',
  customCells: 4
};

const emptySessionForm: SessionForm = {
  projectId: '',
  groupId: '',
  name: '',
  cwd: '',
  agent: 'codex',
  resume: '',
  initialResume: '',
  bypassPermissions: true,
  command: '',
  uiMode: 'native',
  model: ''
};

export function App(): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [snapshot, setSnapshot] = useState<DeskSnapshot | null>(null);
  const narrowViewport = useNarrowViewport();
  const [subsystem, setSubsystem] = useState<Subsystem>(() => readStoredSubsystem(localStorage.getItem('desk.subsystem')));
  // Keep-alive multiplexer mounts: the active group plus the most recently
  // visited ones stay mounted hidden, so switching back reuses live
  // terminals — no socket/PTY churn, no WebGL context churn, no tmux resize
  // storm. The agents subsystem itself is also display-gated now instead of
  // unmounting on subsystem switches (every other subsystem already worked
  // that way), which retired the fresh-group-id remount trick the panel
  // registry used to require.
  const muxLruRef = useRef<string[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(
    () => localStorage.getItem('desk.activeProject') ?? undefined
  );
  const [activeGroupId, setActiveGroupId] = useState<string | undefined>(
    () => localStorage.getItem('desk.activeGroup') ?? undefined
  );
  const [selectedTmux, setSelectedTmux] = useState<string | undefined>(
    () => localStorage.getItem('desk.activeSession') ?? undefined
  );
  const [cellAssignments, setCellAssignments] = useState<Record<string, Record<string, number>>>(() =>
    readJsonStorage<Record<string, Record<string, number>>>('desk.cellAssignments')
  );
  const [cellActiveSessions, setCellActiveSessions] = useState<Record<string, Record<string, string>>>(() =>
    readJsonStorage<Record<string, Record<string, string>>>('desk.cellActiveSessions')
  );
  const [terminalRevisions, setTerminalRevisions] = useState<Record<string, number>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() =>
    readJsonStorage<Record<string, boolean>>('desk.collapsedProjects')
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() =>
    readJsonStorage<Record<string, boolean>>('desk.collapsedGroups')
  );
  const [agentSidebarCollapsed, setAgentSidebarCollapsed] = usePersistedCollapse(AGENT_SIDEBAR_STORAGE_KEY);
  // Mirrors EditorSubsystem's collapsed state for rail-button styling only —
  // the editor subsystem owns the panel mechanics.
  const sidebars = useSubsystemSidebars();
  const { editor: editorSidebar, git: gitSidebar, notes: notesSidebar, projects: projectsSidebar, channels: channelsSidebar } = sidebars;
  const [channelsUnread, setChannelsUnread] = useState(0);
  // Registered by the channels subsystem; jumps to a specific message.
  const channelsNavigatorRef = useRef<((channel: string, messageId?: string, thread?: string) => void) | null>(null);
  // Registered by the notes subsystem; pre-boot requests queue inside it.
  const noteCreatorRef = useRef<((content?: string) => void) | null>(null);
  // Right-click menu over selected terminal text (copy / create note).
  const [terminalMenu, setTerminalMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  // Agents quick-switcher (Ctrl+K; Ctrl+Shift+K even from inside a terminal).
  const [agentPaletteOpen, setAgentPaletteOpen] = useState(false);
  // The git subsystem's "Open file" jumps into the editor; the opener appears
  // once the editor has a root, so early requests are parked until then.
  const editorFileOpenerRef = useRef<((path: string) => void) | null>(null);
  const pendingEditorOpenRef = useRef<string | null>(null);
  // Editor ⇄ git navigation, both directions trampoline through App with a
  // pending slot — either side may not have booted when the jump happens.
  const editorRevealRef = useRef<((path: string) => void) | null>(null);
  const pendingEditorRevealRef = useRef<string | null>(null);
  const gitNavigatorRef = useRef<((target: GitNavigateTarget) => void) | null>(null);
  const pendingGitNavRef = useRef<GitNavigateTarget | null>(null);
  const [draggedTmux, setDraggedTmux] = useState<string | null>(null);
  const agentSidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const restoringAgentSidebarRef = useRef(false);
  // Persisted agents-sidebar width: localStorage cache, desk.yml as truth.
  const agentInitialWidthRef = useRef(
    readStoredSidebarWidth(localStorage.getItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}agents`)) ?? 180
  );
  const agentSidebarWidthRef = useRef(agentInitialWidthRef.current);
  const agentWidthPersisterRef = useRef<((px: number) => void) | null>(null);
  if (agentWidthPersisterRef.current === null) {
    agentWidthPersisterRef.current = createSidebarWidthPersister('agents', (sidebars) => saveSettings({ sidebars }));
  }
  // Widths fetched from desk.yml; handed to the subsystems that own panels.
  const [sidebarWidths, setSidebarWidths] = useState<Record<string, number> | undefined>(undefined);
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const sidebarAnimTimerRef = useRef<number | undefined>(undefined);
  const pendingSnapCollapseRef = useRef(false);
  const collapseSidebarRef = useRef<() => void>(() => undefined);
  const draggedSidebarSessionRef = useRef<{ session: DeskSessionView; group: DeskGroupView } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(0);
  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const pushToast = useCallback((message: string, tone: ToastTone = 'error') => {
    const id = (toastSeqRef.current += 1);
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
  }, []);
  // Back-compat shim: existing `setError(msg)` calls become error toasts;
  // `setError(null)` (clear-before-action) is a no-op since toasts auto-dismiss.
  const setError = useCallback(
    (message: string | null) => {
      if (message) {
        pushToast(message, 'error');
      }
    },
    [pushToast]
  );
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalMode>(null);
  // Second-stage confirm: true once the server answered resume-not-captured and
  // the user must explicitly accept starting a fresh conversation.
  const [uiModeSwitchDiscard, setUiModeSwitchDiscard] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectForm>(emptyProjectForm);
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm);
  const [sessionForm, setSessionForm] = useState<SessionForm>(emptySessionForm);
  const [modalProject, setModalProject] = useState<DeskProjectView | undefined>();
  const [modalGroup, setModalGroup] = useState<DeskGroupView | undefined>();
  const [modalSession, setModalSession] = useState<DeskSessionView | undefined>();
  const [attention, setAttention] = useState<Record<string, { attention: true; since: string }>>({});
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [unreadEvents, setUnreadEvents] = useState(0);
  // The 2s pulse loop (telemetry + attention/events + snapshot liveness) owns
  // systemSnapshot/systemError/telemetryHistory; it writes the
  // attention/events/snapshot state below through these setters so the coupling
  // is preserved exactly. App invalidates in-flight attention payloads before
  // applying its own optimistic attention/event mutations.
  const { systemSnapshot, systemError, telemetryHistoryRef, invalidateAttentionPulse } = usePulse({
    setSnapshot,
    setAttention,
    setAgentEvents,
    setUnreadEvents
  });
  const [notifOpen, setNotifOpen] = useState(() => localStorage.getItem('desk.notifOpen') === 'true');
  const [notifWidth, setNotifWidth] = useState(() => {
    const stored = Number(localStorage.getItem('desk.notifWidth'));
    return Number.isFinite(stored) && stored >= 260 && stored <= 560 ? stored : 340;
  });
  const [muted, setMuted] = useState(() => readStoredMuted(localStorage.getItem(MUTED_STORAGE_KEY)));
  const [interacted, setInteracted] = useState(false);
  const [booted, setBooted] = useState(false);
  const reduced = useMemo(() => isReducedMotion(), []);
  const [themeName, setThemeName] = useState<DeskThemeName>(() => readStoredTheme(localStorage.getItem(THEME_STORAGE_KEY)));
  const [autosaveMode, setAutosaveMode] = useState<DeskAutosaveMode>('off');
  const [autosaveDelayMs, setAutosaveDelayMs] = useState(1000);
  // LSP enablement from desk.yml (read-only). Default-disabled => factory is undefined =>
  // EditorSubsystem behaves exactly as before. Memoized so its identity is stable across renders
  // (EditorSubsystem keys its binding effect on createLspBinding; an unstable identity would churn
  // sessions). registerProviders is the real installLspProviders.
  const [lspConfig, setLspConfig] = useState<LspUiConfig>({ enabled: false, languages: [] });
  // One stable coexistence controller shared across both EditorSubsystem mounts (its per-language/
  // per-feature refcount over the global Monaco defaults must be process-wide, not per-binding).
  const lspCoexistence = useMemo(() => createBuiltinCoexistenceController(), []);
  const lspDiagnostics = useMemo(() => createMonacoDiagnostics(), []);
  const createLspBinding = useMemo(
    () =>
      makeCreateLspBinding(lspConfig, {
        registerProviders: installLspProviders,
        coexistence: lspCoexistence,
        attachDiagnostics: lspDiagnostics.attach,
        // Read-only status surface (status update): store per-(root,language) lifecycle/progress for the status bar.
        onSessionStatus: ({ workspaceRoot, languageId, status }) =>
          setLspStatus(lspStatusKey(workspaceRoot, languageId), status),
        onSessionClosed: ({ workspaceRoot, languageId }) => clearLspStatus(lspStatusKey(workspaceRoot, languageId))
      }) ?? undefined,
    [lspConfig, lspCoexistence, lspDiagnostics]
  );
  // Auto-detect LSP model: the only persisted UI control is the master enabled toggle. The active
  // editor languages are NOT read from persisted settings.lsp.languages; they are derived at runtime
  // from server-side detection of the active editor root. lspConfig = enabled ? detected : [].
  const [lspEnabled, setLspEnabled] = useState(false);
  // Per-language user denylist (server-normalized). Subtracts from detected at runtime; the master
  // enabled toggle still gates everything. Adopted from the server on every read/save -- never the
  // client's optimistic guess (honesty-in-surfaces: the displayed state is the persisted truth).
  const [lspDisabledLanguages, setLspDisabledLanguages] = useState<string[]>([]);
  const [detectedLanguages, setDetectedLanguages] = useState<string[]>([]);
  const [lspDetectionTruncated, setLspDetectionTruncated] = useState(false);
  const [lspDetectionState, setLspDetectionState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [lspSaving, setLspSaving] = useState(false);
  const [lspSaveError, setLspSaveError] = useState(false);
  const initialSettingsEditRevisionsRef = useRef({
    theme: 0,
    muted: 0,
    autosaveMode: 0,
    autosaveDelayMs: 0,
    lsp: 0
  });
  const currentInitialSettingsRef = useRef({ themeName, muted, autosaveMode, autosaveDelayMs });
  currentInitialSettingsRef.current = { themeName, muted, autosaveMode, autosaveDelayMs };
  const handleThemeNameChange = useCallback((next: DeskThemeName) => {
    initialSettingsEditRevisionsRef.current.theme += 1;
    currentInitialSettingsRef.current.themeName = next;
    setThemeName(next);
  }, []);
  const handleMutedChange = useCallback((next: boolean) => {
    initialSettingsEditRevisionsRef.current.muted += 1;
    currentInitialSettingsRef.current.muted = next;
    setMuted(next);
  }, []);
  const handleAutosaveModeChange = useCallback((next: DeskAutosaveMode) => {
    initialSettingsEditRevisionsRef.current.autosaveMode += 1;
    currentInitialSettingsRef.current.autosaveMode = next;
    setAutosaveMode(next);
  }, []);
  const handleAutosaveDelayChange = useCallback((next: number) => {
    initialSettingsEditRevisionsRef.current.autosaveDelayMs += 1;
    currentInitialSettingsRef.current.autosaveDelayMs = next;
    setAutosaveDelayMs(next);
  }, []);
  // Boot/restore editor root is not published to the editor-root signal (see editorRoot.ts); capture
  // the persisted one so detection runs for the initially-restored workspace, then track live changes.
  const [bootEditorRoot, setBootEditorRoot] = useState<string | null>(null);
  const liveEditorRoot = useEditorRoot();
  const activeEditorRoot = liveEditorRoot ?? bootEditorRoot;
  const activeEditorRootRef = useRef<string | null>(null);
  activeEditorRootRef.current = activeEditorRoot;
  // Generation guard: ignore stale detection responses after a rapid root switch.
  const detectionGenRef = useRef(0);
  const runLspDetection = useCallback((root: string | null, refresh: boolean): Promise<void> => {
    const generation = ++detectionGenRef.current;
    if (!root) {
      setDetectedLanguages([]);
      setLspDetectionTruncated(false);
      setLspDetectionState('idle');
      return Promise.resolve();
    }
    setLspDetectionState('loading');
    return fetchDetectedLanguages(root, { refresh })
      .then((result) => {
        if (generation !== detectionGenRef.current) {
          return;
        }
        setDetectedLanguages(result.languages);
        setLspDetectionTruncated(result.truncated);
        setLspDetectionState('idle');
      })
      .catch(() => {
        if (generation !== detectionGenRef.current) {
          return;
        }
        // Fail closed: an invalid/out-of-root candidate or transient error activates nothing.
        setDetectedLanguages([]);
        setLspDetectionTruncated(false);
        setLspDetectionState('error');
      });
  }, []);
  // Re-scan the active root (debounced) whenever it changes while LSP is enabled or the Settings
  // panel is open. Detection is read-only and TTL-cached server-side; the result drives the runtime
  // allowlist below. Nothing is written to desk.yml.
  useEffect(() => {
    if (!activeEditorRoot || (!lspEnabled && modal !== 'settings')) {
      return;
    }
    const handle = window.setTimeout(() => {
      void runLspDetection(activeEditorRootRef.current, false);
    }, 400);
    return () => window.clearTimeout(handle);
  }, [activeEditorRoot, lspEnabled, modal, runLspDetection]);
  // Runtime editor allowlist = persisted enabled + CURRENT detection output. Never derived from
  // persisted settings.lsp.languages, so an empty persisted list does not disable LSP.
  useEffect(() => {
    setLspConfig(
      resolveLspConfig({ enabled: lspEnabled, languages: detectedLanguages, disabledLanguages: lspDisabledLanguages })
    );
  }, [lspEnabled, detectedLanguages, lspDisabledLanguages]);
  // Adopt the server-normalized LSP block as the single source of truth after any save.
  const adoptServerLsp = useCallback((lsp: DeskFetchedUiSettings['lsp']) => {
    setLspEnabled(lsp?.enabled === true);
    setLspDisabledLanguages(Array.isArray(lsp?.disabledLanguages) ? lsp.disabledLanguages : []);
  }, []);
  const handleLspEnabledChange = useCallback(
    (next: boolean) => {
      initialSettingsEditRevisionsRef.current.lsp += 1;
      setLspSaving(true);
      setLspSaveError(false);
      // Carry the current denylist through the master-toggle save so it is preserved server-side.
      void saveLspSettings({ enabled: next, disabledLanguages: lspDisabledLanguages })
        .then((saved) => {
          // On failure the state keeps its last server-confirmed value, which reverts the control.
          adoptServerLsp(saved.lsp);
        })
        .catch(() => {
          setLspSaveError(true);
        })
        .finally(() => {
          setLspSaving(false);
        });
    },
    [lspDisabledLanguages, adoptServerLsp]
  );
  // Toggle a single detected language on/off by editing the denylist, then adopt the normalized
  // server response. Disabling adds the id; enabling removes it. enabled stays as-is.
  const handleLspLanguageToggle = useCallback(
    (languageId: string, nextEnabled: boolean) => {
      initialSettingsEditRevisionsRef.current.lsp += 1;
      const current = new Set(lspDisabledLanguages);
      if (nextEnabled) {
        current.delete(languageId);
      } else {
        current.add(languageId);
      }
      const nextDisabled = Array.from(current);
      setLspSaving(true);
      setLspSaveError(false);
      void saveLspSettings({ enabled: lspEnabled, disabledLanguages: nextDisabled })
        .then((saved) => {
          adoptServerLsp(saved.lsp);
        })
        .catch(() => {
          setLspSaveError(true);
        })
        .finally(() => {
          setLspSaving(false);
        });
    },
    [lspDisabledLanguages, lspEnabled, adoptServerLsp]
  );
  const handleLspRefresh = useCallback(() => {
    void runLspDetection(activeEditorRootRef.current, true);
  }, [runLspDetection]);
  const builtTheme = useMemo(() => createDeskTheme(themeName), [themeName]);
  const themeVars = useMemo(() => builtTheme.vars as CSSProperties, [builtTheme]);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, themeName);
    // Never save before the server settings have loaded: the mount run would
    // clobber the stored theme with this browser's default.
    if (settingsLoadedRef.current) {
      fireAndForget(saveSettings({ theme: themeName }), 'save theme');
    }
  }, [themeName]);

  useEffect(() => {
    localStorage.setItem('desk.notifOpen', String(notifOpen));
  }, [notifOpen]);

  const bleepsSettings = useMemo(() => createDeskBleepsSettings(muted || !interacted), [muted, interacted]);
  const settingsLoadedRef = useRef(false);

  useEffect(() => {
    // desk.yml settings are the source of truth (localStorage is just an
    // instant-boot cache to avoid a theme flash before this fetch lands).
    const revisionsAtRequest = { ...initialSettingsEditRevisionsRef.current };
    void fetchSettings()
      .then((settings) => {
        const revisions = initialSettingsEditRevisionsRef.current;
        const current = currentInitialSettingsRef.current;
        const themeSetting = reconcileInitialSetting(
          typeof settings.theme === 'string' ? readStoredTheme(settings.theme) : undefined,
          current.themeName,
          revisions.theme !== revisionsAtRequest.theme
        );
        const mutedSetting = reconcileInitialSetting(
          typeof settings.muted === 'boolean' ? settings.muted : undefined,
          current.muted,
          revisions.muted !== revisionsAtRequest.muted
        );
        const autosaveModeSetting = reconcileInitialSetting(
          settings.editor?.autosave,
          current.autosaveMode,
          revisions.autosaveMode !== revisionsAtRequest.autosaveMode
        );
        const autosaveDelaySetting = reconcileInitialSetting(
          typeof settings.editor?.autosaveDelayMs === 'number' ? settings.editor.autosaveDelayMs : undefined,
          current.autosaveDelayMs,
          revisions.autosaveDelayMs !== revisionsAtRequest.autosaveDelayMs
        );
        if (themeSetting.adoptServer) {
          setThemeName(themeSetting.value);
        }
        if (mutedSetting.adoptServer) {
          setMuted(mutedSetting.value);
        }
        if (autosaveModeSetting.adoptServer) {
          setAutosaveMode(autosaveModeSetting.value);
        }
        if (autosaveDelaySetting.adoptServer) {
          setAutosaveDelayMs(autosaveDelaySetting.value);
        }
        // Auto-detect model: take ONLY the persisted master enabled flag + per-language denylist
        // here; the active languages come from runtime detection (below), never from persisted
        // settings.lsp.languages.
        if (revisions.lsp === revisionsAtRequest.lsp) {
          setLspEnabled(settings.lsp?.enabled === true);
          setLspDisabledLanguages(
            Array.isArray(settings.lsp?.disabledLanguages) ? settings.lsp.disabledLanguages : []
          );
        }
        setBootEditorRoot(typeof settings.editor?.root === 'string' ? settings.editor.root : null);
        if (settings.sidebars && typeof settings.sidebars === 'object') {
          setSidebarWidths(settings.sidebars);
          const agentsWidth = settings.sidebars.agents;
          const hadCache =
            readStoredSidebarWidth(localStorage.getItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}agents`)) !== null;
          if (typeof agentsWidth === 'number' && Number.isFinite(agentsWidth)) {
            const width = clampSidebarWidth(agentsWidth);
            if (hadCache) {
              // The cache is this browser's latest user action (it can be
              // newer than the server when a reload lands mid-debounce) —
              // keep it and sync the server instead of clobbering the drag.
              if (width !== agentSidebarWidthRef.current) {
                agentWidthPersisterRef.current?.(agentSidebarWidthRef.current);
              }
            } else if (width !== agentSidebarWidthRef.current) {
              agentSidebarWidthRef.current = width;
              localStorage.setItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}agents`, String(width));
              if (!agentSidebarPanelRef.current?.isCollapsed()) {
                restoringAgentSidebarRef.current = true;
                agentSidebarPanelRef.current?.resize(`${width}px`);
                window.setTimeout(() => {
                  restoringAgentSidebarRef.current = false;
                }, 120);
              }
            }
          }
        }
        settingsLoadedRef.current = true;
        const catchup: DeskUiSettings = {};
        if (themeSetting.persistCurrent) {
          catchup.theme = themeSetting.value;
        }
        if (mutedSetting.persistCurrent) {
          catchup.muted = mutedSetting.value;
        }
        const editorCatchup: NonNullable<DeskUiSettings['editor']> = {};
        if (autosaveModeSetting.persistCurrent) {
          editorCatchup.autosave = autosaveModeSetting.value;
        }
        if (autosaveDelaySetting.persistCurrent) {
          editorCatchup.autosaveDelayMs = autosaveDelaySetting.value;
        }
        if (Object.keys(editorCatchup).length > 0) {
          catchup.editor = editorCatchup;
        }
        if (settings.theme === undefined) {
          // First run with no stored settings: adopt this browser's choice.
          catchup.theme = themeSetting.value;
          catchup.muted = mutedSetting.value;
        }
        if (Object.keys(catchup).length > 0) {
          fireAndForget(saveSettings(catchup), 'reconcile initial settings');
        }
      })
      .catch((error) => {
        // The fetch failed, so there is no loaded server state to clobber —
        // release the persistence gate so later user changes still save (partial
        // saves merge server-side), and surface the failure instead of dropping it.
        const revisions = initialSettingsEditRevisionsRef.current;
        const current = currentInitialSettingsRef.current;
        const catchup: DeskUiSettings = {};
        if (revisions.theme !== revisionsAtRequest.theme) {
          catchup.theme = current.themeName;
        }
        if (revisions.muted !== revisionsAtRequest.muted) {
          catchup.muted = current.muted;
        }
        const editorCatchup: NonNullable<DeskUiSettings['editor']> = {};
        if (revisions.autosaveMode !== revisionsAtRequest.autosaveMode) {
          editorCatchup.autosave = current.autosaveMode;
        }
        if (revisions.autosaveDelayMs !== revisionsAtRequest.autosaveDelayMs) {
          editorCatchup.autosaveDelayMs = current.autosaveDelayMs;
        }
        if (Object.keys(editorCatchup).length > 0) {
          catchup.editor = editorCatchup;
        }
        settingsLoadedRef.current = true;
        if (Object.keys(catchup).length > 0) {
          fireAndForget(saveSettings(catchup), 'recover settings edits after initial load failure');
        }
        console.warn(`[desk] initial settings load failed: ${toErrorMessage(error)}`);
      });
    setBooted(true);
    const unlock = (): void => setInteracted(true);
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    localStorage.setItem(MUTED_STORAGE_KEY, muted ? '1' : '0');
    if (settingsLoadedRef.current) {
      fireAndForget(saveSettings({ muted }), 'save muted');
    }
  }, [muted]);

  useEffect(() => {
    // The server merges editor keys, so this never clobbers root/openFiles.
    if (settingsLoadedRef.current) {
      fireAndForget(saveSettings({ editor: { autosave: autosaveMode, autosaveDelayMs } }), 'save editor settings');
    }
  }, [autosaveMode, autosaveDelayMs]);

  const workspace = useMemo(() => {
    if (!snapshot || snapshot.view.groups.length === 0) {
      return null;
    }
    const selectedProject = snapshot.view.projects.find((project) => project.id === activeProjectId);
    if (selectedProject && selectedProject.groups.length === 0) {
      return null;
    }
    return buildWorkspaceState(snapshot.view, {
      projectId: activeProjectId,
      groupId: activeGroupId,
      tmuxSession: selectedTmux
    });
  }, [activeGroupId, activeProjectId, selectedTmux, snapshot]);

  const activeProject = workspace?.activeProject ?? snapshot?.view.projects.find((project) => project.id === activeProjectId) ?? snapshot?.view.projects[0];
  const activeGroup = workspace?.activeGroup;
  // Keep-alive warm budget: the active group leads; recently visited groups stay
  // mounted hidden so switching back is a pure show/hide — no remount, no socket
  // churn. This was a fixed LRU of 3 groups, which made most switches in a
  // 14-group workspace cold-remount. With the terminal broker delivering output
  // ONLY to visible surfaces, a hidden warm cell parses nothing, so we can keep
  // many groups warm cheaply. The cap is a session-count budget (not a group
  // count) so a few large grids and many solos both behave, and it stays at/under
  // the server's warm-PTY ceiling. The active group is always kept even if it
  // alone exceeds the budget. Groups removed from the manifest fall out.
  const maxWarmSessions = narrowViewport ? 16 : 40;
  const mountedMuxGroups = useMemo(() => {
    if (!snapshot) {
      return [] as DeskGroupView[];
    }
    const known = new Set(snapshot.view.groups.map((group) => group.id));
    let lru = muxLruRef.current.filter((id) => known.has(id));
    if (activeGroup && lru[0] !== activeGroup.id) {
      lru = [activeGroup.id, ...lru.filter((id) => id !== activeGroup.id)];
    }
    const byId = new Map(snapshot.view.groups.map((group) => [group.id, group]));
    const warm: DeskGroupView[] = [];
    let remaining = maxWarmSessions;
    for (const id of lru) {
      const group = byId.get(id);
      if (!group) {
        continue;
      }
      // Stop adding once the budget is spent, but never drop the active group.
      if (warm.length > 0 && group.sessions.length > remaining) {
        break;
      }
      warm.push(group);
      remaining -= group.sessions.length;
    }
    muxLruRef.current = warm.map((group) => group.id);
    return warm;
  }, [activeGroup, maxWarmSessions, snapshot]);

  // Agents status-bar context: identity of the selected session. Project and
  // group already live in the topbar scope cell — the bar adds what is
  // missing: which session, which agent, its liveness, and a copyable tmux
  // target for `tmux attach -t`.
  useEffect(() => {
    const session = snapshot?.view.projects
      .flatMap((project) => project.groups)
      .flatMap((group) => group.sessions)
      .find((candidate) => candidate.spec.tmuxSession === selectedTmux);
    if (!session) {
      publishStatus('agents', [
        { key: 'session', icon: <TerminalSquare size={11} />, text: 'no session selected', hint: 'Select a session in the sidebar' }
      ]);
      return;
    }
    const segments: StatusSegment[] = [
      {
        key: 'session',
        icon: <TerminalSquare size={11} />,
        text: session.spec.name,
        tone: session.state === 'running' ? 'ok' : 'warn',
        hint: `${session.state} • ${session.spec.command}`
      },
      { key: 'agent', icon: <Bot size={11} />, text: session.spec.agent ?? 'shell', hint: 'Agent kind' },
      { key: 'cwd', icon: <Folder size={11} />, text: session.spec.cwd, hint: `Working directory: ${session.spec.cwd}` },
      {
        key: 'tmux',
        icon: <Copy size={11} />,
        text: session.spec.tmuxSession,
        hint: `Copy tmux target — tmux attach -t ${session.spec.tmuxSession}`,
        onClick: () => {
          const copied = navigator.clipboard?.writeText(session.spec.tmuxSession);
          if (copied) {
            void copied
              .then(() => pushToast(`Copied ${session.spec.tmuxSession}`, 'ok'))
              .catch(() => pushToast('Copy failed', 'error'));
          } else {
            pushToast('Copy failed', 'error');
          }
        }
      }
    ];
    if (selectedTmux && attention[selectedTmux]) {
      segments.push({ key: 'attn', icon: <Bell size={11} />, text: 'needs input', tone: 'danger', hint: 'This agent is waiting for you' });
    }
    publishStatus('agents', segments);
  }, [attention, pushToast, selectedTmux, snapshot]);

  // App-wide signals for the status bar's right side. System metrics live in
  // the topbar; these are the workflow ones: agents waiting on input, unread
  // events/messages, muted sound, and snapshot sync state.
  const attentionCount = Object.keys(attention).length;
  const statusGlobals = useMemo<StatusSegment[]>(() => {
    const segments: StatusSegment[] = [];
    if (attentionCount > 0) {
      segments.push({
        key: 'attention',
        icon: <Bell size={11} />,
        text: `${attentionCount} need${attentionCount === 1 ? 's' : ''} input`,
        tone: 'danger',
        hint: 'Agents waiting for input — click to open agents',
        onClick: () => setSubsystem('agents')
      });
    }
    if (unreadEvents > 0) {
      segments.push({
        key: 'events',
        icon: <Activity size={11} />,
        text: `${unreadEvents} events`,
        tone: 'warn',
        hint: 'Unread agent events — click to open the drawer',
        onClick: () => setNotifOpen(true)
      });
    }
    if (channelsUnread > 0) {
      segments.push({
        key: 'channels',
        icon: <MessagesSquare size={11} />,
        text: String(channelsUnread),
        tone: 'warn',
        hint: 'Unread channel messages — click to open channels',
        onClick: () => setSubsystem('channels')
      });
    }
    if (muted) {
      segments.push({
        key: 'muted',
        icon: <VolumeX size={11} />,
        text: 'muted',
        hint: 'Sounds are muted — click to unmute',
        onClick: () => handleMutedChange(false)
      });
    }
    segments.push({
      key: 'sync',
      icon: <RefreshCw size={11} />,
      text: busy ? 'syncing' : 'live',
      tone: busy ? undefined : 'ok',
      hint: 'Snapshot sync — click to refresh now',
      onClick: () => {
        void refresh();
      }
    });
    return segments;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attentionCount, busy, channelsUnread, muted, unreadEvents]);

  useEffect(() => {
    localStorage.setItem('desk.subsystem', subsystem);
  }, [subsystem]);

  useEffect(() => {
    localStorage.setItem('desk.cellAssignments', JSON.stringify(cellAssignments));
  }, [cellAssignments]);

  useEffect(() => {
    localStorage.setItem('desk.cellActiveSessions', JSON.stringify(cellActiveSessions));
  }, [cellActiveSessions]);

  useEffect(() => {
    localStorage.setItem('desk.collapsedProjects', JSON.stringify(collapsedProjects));
  }, [collapsedProjects]);

  useEffect(() => {
    localStorage.setItem('desk.collapsedGroups', JSON.stringify(collapsedGroups));
  }, [collapsedGroups]);

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

  useEffect(() => {
    if (!terminalMenu) {
      return;
    }
    const close = (): void => setTerminalMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setTerminalMenu(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [terminalMenu]);

  useEffect(() => {
    // Agents keyboard model: Ctrl+K quick-switcher (Ctrl+Shift+K even while a
    // terminal owns the keyboard — legacy terminal encodings cannot express
    // the shifted variant separately, so no shell loses anything), Ctrl+Alt+1..9
    // focus cell N, Ctrl+Alt+←/→ previous/next session across the whole tree.
    if (subsystem !== 'agents') {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      const key = event.key;
      // Never hijack keys while a modal is open or the user is typing in a field.
      // Ctrl+Alt+digit is indistinguishable from AltGr+digit on European layouts,
      // so typing an AltGr symbol into a modal field or the sidebar filter used to
      // be swallowed and refocus a cell; and the palette / cell-focus / session-nav
      // shortcuts must not fire behind an open modal.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        modal !== null ||
        (target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable))
      ) {
        return;
      }
      const inTerminal = target !== null && Boolean(target.closest('.terminalSurfaceShell'));
      if (event.ctrlKey && !event.altKey && key.toLowerCase() === 'k' && (event.shiftKey || !inTerminal)) {
        event.preventDefault();
        event.stopPropagation();
        setAgentPaletteOpen(true);
        return;
      }
      if (!event.ctrlKey || !event.altKey) {
        return;
      }
      if (key >= '1' && key <= '9') {
        if (!activeGroup) {
          return;
        }
        const cells = buildPanelCells(
          activeGroup,
          cellAssignments[activeGroup.id] ?? {},
          cellActiveSessions[activeGroup.id] ?? {},
          selectedTmux
        );
        const cell = cells[Number(key) - 1];
        const target = cell?.activeSession ?? cell?.sessions[0];
        if (cell && target) {
          event.preventDefault();
          event.stopPropagation();
          selectCellSession(activeGroup, cell, target);
        }
        return;
      }
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        const all = (snapshot?.view.projects ?? []).flatMap((project) =>
          project.groups.flatMap((group) => group.sessions)
        );
        if (all.length === 0) {
          return;
        }
        const index = all.findIndex((session) => session.spec.tmuxSession === selectedTmux);
        const step = key === 'ArrowRight' ? 1 : -1;
        const next = index === -1 ? all[0] : all[(index + step + all.length) % all.length];
        event.preventDefault();
        event.stopPropagation();
        revealAgentSession(next.spec.tmuxSession);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // selectCellSession/revealAgentSession are per-render closures over the same state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup, cellActiveSessions, cellAssignments, selectedTmux, snapshot, subsystem, modal]);

  useEffect(() => {
    // The agents group REMOUNTS on subsystem switches and gets its width from
    // defaultSize (the live ref) — reliable across viewport changes. Do NOT
    // resize() here: the library keeps stale per-id internal sizes across
    // remounts and converts px against the wrong total, corrupting the
    // layout. Only collapse state needs reconciling.
    if (subsystem !== 'agents') {
      return;
    }
    window.requestAnimationFrame(() => {
      if (agentSidebarCollapsed) {
        agentSidebarPanelRef.current?.collapse();
      } else if (agentSidebarPanelRef.current?.isCollapsed()) {
        agentSidebarPanelRef.current.expand();
      }
    });
  }, [agentSidebarCollapsed, subsystem]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    setActiveProjectId(workspace.activeProject.id);
    setActiveGroupId(workspace.activeGroup.id);
    localStorage.setItem('desk.activeProject', workspace.activeProject.id);
    localStorage.setItem('desk.activeGroup', workspace.activeGroup.id);
    if (workspace.activeSession) {
      setSelectedTmux(workspace.activeSession.spec.tmuxSession);
      localStorage.setItem('desk.activeSession', workspace.activeSession.spec.tmuxSession);
    }
  }, [workspace?.activeProject.id, workspace?.activeGroup.id, workspace?.activeSession?.spec.tmuxSession]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const next = await fetchDeskSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function upMissing(): Promise<void> {
    setBusy(true);
    try {
      await upDesk(false);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const next = await addProject(projectForm);
      setSnapshot(next);
      setActiveProjectId(projectForm.projectId);
      setProjectForm(emptyProjectForm);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitGroup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const layout = buildLayoutPayload(groupForm);
      const targetProject = snapshot?.view.projects.find((project) => project.id === groupForm.projectId);
      const next = targetProject?.configured
        ? await addProjectGroup({
            projectId: groupForm.projectId,
            groupId: groupForm.groupId,
            groupLabel: groupForm.groupLabel,
            layout
          })
        : await addGroup({ groupId: groupForm.groupId, groupLabel: groupForm.groupLabel });
      setSnapshot(next);
      setActiveProjectId(groupForm.projectId || activeProjectId);
      setActiveGroupId(groupForm.projectId ? `${groupForm.projectId}:${groupForm.groupId}` : groupForm.groupId);
      setSelectedTmux(undefined);
      setGroupForm(emptyGroupForm);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitSession(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const session = buildSessionPayload(sessionForm);
      const targetProject = snapshot?.view.projects.find((project) => project.id === sessionForm.projectId);
      const next = targetProject?.configured
        ? await addProjectSession({
            projectId: sessionForm.projectId,
            groupId: sessionForm.groupId,
            session
          })
        : await addSession({
            groupId: sessionForm.groupId,
            groupLabel: modalGroup?.label,
            session: { ...session, cwd: session.cwd ?? targetProject?.cwd ?? '' }
          });
      setSnapshot(next);
      setActiveProjectId(sessionForm.projectId || activeProjectId);
      setActiveGroupId(sessionForm.projectId ? `${sessionForm.projectId}:${sessionForm.groupId}` : sessionForm.groupId);
      setSessionForm(emptySessionForm);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitProjectEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!modalProject) {
      return;
    }
    setBusy(true);
    try {
      const next = await editProject({
        projectId: modalProject.id,
        projectLabel: projectForm.projectLabel,
        cwd: projectForm.cwd,
        currentCwd: modalProject.cwd
      });
      setSnapshot(next);
      setActiveProjectId(modalProject.id);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitGroupEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!modalGroup) {
      return;
    }
    setBusy(true);
    try {
      const next = await editProjectGroup({
        projectId: modalGroup.projectId,
        currentGroupId: modalGroup.groupId,
        groupId: groupForm.groupId,
        groupLabel: groupForm.groupLabel,
        projectCwd: modalGroup.projectCwd,
        layout: buildLayoutPayload(groupForm)
      });
      setSnapshot(next);
      setActiveProjectId(modalGroup.projectId);
      setActiveGroupId(`${modalGroup.projectId}:${groupForm.groupId}`);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitSessionEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!modalSession || !modalGroup) {
      return;
    }
    // UI-mode changes must go through the atomic switch endpoint (spec §7):
    // divert to a restart-style confirm instead of the manifest-only edit.
    const currentUiMode = modalSession.spec.uiMode ?? 'terminal';
    if (sessionForm.uiMode !== currentUiMode) {
      setUiModeSwitchDiscard(false);
      setModal('switchUiMode');
      return;
    }
    setBusy(true);
    try {
      const next = await editProjectSession({
        projectId: modalGroup.projectId,
        groupId: modalGroup.groupId,
        currentName: modalSession.spec.name,
        projectCwd: modalGroup.projectCwd,
        session: buildSessionPayload(sessionForm)
      });
      setSnapshot(next);
      setActiveProjectId(modalGroup.projectId);
      setActiveGroupId(modalGroup.id);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteProject(): Promise<void> {
    if (!modalProject) {
      return;
    }
    setBusy(true);
    try {
      const next = await deleteProject({ projectId: modalProject.id, cwd: modalProject.cwd });
      setSnapshot(next);
      setActiveProjectId(undefined);
      setActiveGroupId(undefined);
      setSelectedTmux(undefined);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteGroup(): Promise<void> {
    if (!modalGroup) {
      return;
    }
    setBusy(true);
    try {
      const next = await deleteProjectGroup({
        projectId: modalGroup.projectId,
        groupId: modalGroup.groupId,
        projectCwd: modalGroup.projectCwd
      });
      setSnapshot(next);
      setActiveGroupId(undefined);
      setSelectedTmux(undefined);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteSession(): Promise<void> {
    if (!modalSession || !modalGroup) {
      return;
    }
    setBusy(true);
    try {
      const next = await deleteProjectSession({
        projectId: modalGroup.projectId,
        groupId: modalGroup.groupId,
        sessionName: modalSession.spec.name,
        projectCwd: modalGroup.projectCwd,
        tmuxSession: modalSession.spec.tmuxSession
      });
      setSnapshot(next);
      setSelectedTmux(undefined);
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmUiModeSwitch(): Promise<void> {
    if (!modalSession || !modalGroup) {
      return;
    }
    setBusy(true);
    let editedSnapshot: DeskSnapshot | null = null;
    try {
      // Persist the non-mode edits first, carrying the CURRENT mode so the
      // manifest-only route never flips uiMode without a respawn; then run the
      // atomic switch, which re-reads the fresh manifest and kills + starts.
      if (!uiModeSwitchDiscard) {
        editedSnapshot = await editProjectSession({
          projectId: modalGroup.projectId,
          groupId: modalGroup.groupId,
          currentName: modalSession.spec.name,
          projectCwd: modalGroup.projectCwd,
          session: buildSessionPayload({ ...sessionForm, uiMode: modalSession.spec.uiMode ?? 'terminal' })
        });
      }
      const next = await setSessionUiMode({
        tmuxSession: modalSession.spec.tmuxSession,
        uiMode: sessionForm.uiMode,
        confirmDiscard: uiModeSwitchDiscard
      });
      setSnapshot(next);
      setTerminalRevisions((current) => ({
        ...current,
        [modalSession.spec.tmuxSession]: (current[modalSession.spec.tmuxSession] ?? 0) + 1
      }));
      setUiModeSwitchDiscard(false);
      setModal(null);
      setError(null);
    } catch (err) {
      if (err instanceof ApiCodeError && err.code === 'resume-not-captured' && !uiModeSwitchDiscard) {
        // Re-render the confirm as an explicit discard warning; the next
        // confirm retries with confirmDiscard so nothing is lost silently.
        if (editedSnapshot) {
          setSnapshot(editedSnapshot);
        }
        setUiModeSwitchDiscard(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function restartExistingSession(session: DeskSessionView, group: DeskGroupView): Promise<void> {
    setBusy(true);
    try {
      setActiveProjectId(group.projectId);
      setActiveGroupId(group.id);
      setSelectedTmux(session.spec.tmuxSession);
      const next = await restartProjectSession({ tmuxSession: session.spec.tmuxSession });
      setSnapshot(next);
      setActiveProjectId(group.projectId);
      setActiveGroupId(group.id);
      setSelectedTmux(session.spec.tmuxSession);
      setTerminalRevisions((current) => ({
        ...current,
        [session.spec.tmuxSession]: (current[session.spec.tmuxSession] ?? 0) + 1
      }));
      setModal(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addLayoutCell(group: DeskGroupView): Promise<void> {
    if (group.layout.cellCount >= 16) {
      return;
    }
    setBusy(true);
    try {
      const next = await editProjectGroup({
        projectId: group.projectId,
        currentGroupId: group.groupId,
        groupId: group.groupId,
        groupLabel: group.label,
        projectCwd: group.projectCwd,
        // Preserve a linear row when adding a cell; any other kind becomes custom.
        layout: { kind: group.layout.kind === 'linear' ? 'linear' : 'custom', cells: group.layout.cellCount + 1 }
      });
      setSnapshot(next);
      setActiveProjectId(group.projectId);
      setActiveGroupId(group.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeLayoutCell(group: DeskGroupView, cell: PanelCell): Promise<void> {
    if (group.layout.cellCount <= 1) {
      return;
    }
    setBusy(true);
    try {
      const next = await editProjectGroup({
        projectId: group.projectId,
        currentGroupId: group.groupId,
        groupId: group.groupId,
        groupLabel: group.label,
        projectCwd: group.projectCwd,
        layout: { kind: group.layout.kind === 'linear' ? 'linear' : 'custom', cells: group.layout.cellCount - 1 }
      });
      setCellAssignments((current) => {
        const currentGroup = current[group.id] ?? {};
        const reassigned = Object.fromEntries(
          Object.entries(currentGroup).map(([tmuxSession, index]) => [
            tmuxSession,
            index === cell.index ? 0 : Math.min(index, group.layout.cellCount - 2)
          ])
        );
        return { ...current, [group.id]: reassigned };
      });
      setSnapshot(next);
      setActiveProjectId(group.projectId);
      setActiveGroupId(group.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setDraggedSidebarSession(value: { session: DeskSessionView; group: DeskGroupView } | null): void {
    draggedSidebarSessionRef.current = value;
  }

  function resolveSidebarDrag(tmuxSession?: string): { session: DeskSessionView; group: DeskGroupView } | null {
    if (tmuxSession && snapshot) {
      for (const project of snapshot.view.projects) {
        for (const group of project.groups) {
          const session = group.sessions.find((candidate) => candidate.spec.tmuxSession === tmuxSession);
          if (session) {
            return { session, group };
          }
        }
      }
    }
    return draggedSidebarSessionRef.current;
  }

  async function moveSidebarSession(targetGroup: DeskGroupView, tmuxSession?: string): Promise<void> {
    const draggedSession = resolveSidebarDrag(tmuxSession);
    if (!draggedSession || draggedSession.group.id === targetGroup.id) {
      setDraggedSidebarSession(null);
      return;
    }
    setBusy(true);
    try {
      const next = await moveProjectSession({
        sourceProjectId: draggedSession.group.projectId,
        sourceGroupId: draggedSession.group.groupId,
        sourceSessionName: draggedSession.session.spec.name,
        sourceProjectCwd: draggedSession.group.projectCwd,
        targetProjectId: targetGroup.projectId,
        targetGroupId: targetGroup.groupId,
        targetProjectCwd: targetGroup.projectCwd
      });
      setSnapshot(next);
      setActiveProjectId(targetGroup.projectId);
      setActiveGroupId(targetGroup.id);
      setSelectedTmux(getMovedSessionTmux(next, targetGroup.id, draggedSession.session.spec.name));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setDraggedSidebarSession(null);
    }
  }

  function expandAllTree(): void {
    setCollapsedProjects({});
    setCollapsedGroups({});
  }

  function collapseAllTree(): void {
    const projects = Object.fromEntries((snapshot?.view.projects ?? []).map((project) => [project.id, true]));
    const groups = Object.fromEntries((snapshot?.view.groups ?? []).map((group) => [group.id, true]));
    setCollapsedProjects(projects);
    setCollapsedGroups(groups);
  }

  function markSidebarAnimating(): void {
    // panel.collapse()/expand() write the target style synchronously, before React
    // commits state — the transition class must be on the DOM in the same tick.
    // (react-resizable-panels sizes panels via flex-grow; the CSS transitions it.)
    document.getElementById('agents-sidebar-tree')?.parentElement?.classList.add('sidebarAnimating');
    setSidebarAnimating(true);
    window.clearTimeout(sidebarAnimTimerRef.current);
    sidebarAnimTimerRef.current = window.setTimeout(() => setSidebarAnimating(false), 340);
  }

  function collapseAgentSidebar(): void {
    markSidebarAnimating();
    // Guard for the whole animation: mid-transition resize events would sync
    // the collapsed state back to false and reopen the panel.
    restoringAgentSidebarRef.current = true;
    agentSidebarPanelRef.current?.collapse();
    setAgentSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringAgentSidebarRef.current = false;
    }, 360);
  }

  function snapCollapseSidebar(): void {
    // Post-drag snap must be instant: animating here makes the library's
    // resize reconciliation read the mid-transition width and write it back,
    // cancelling the collapse entirely.
    restoringAgentSidebarRef.current = true;
    agentSidebarPanelRef.current?.collapse();
    setAgentSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringAgentSidebarRef.current = false;
    }, 120);
  }
  collapseSidebarRef.current = snapCollapseSidebar;

  function expandAgentSidebar(): void {
    markSidebarAnimating();
    restoringAgentSidebarRef.current = true;
    agentSidebarPanelRef.current?.expand();
    agentSidebarPanelRef.current?.resize(`${agentSidebarWidthRef.current}px`);
    setAgentSidebarCollapsed(false);
    // Keep the guard up for the whole animation: intermediate widths during the
    // expand transition must not re-trigger the collapse threshold.
    window.setTimeout(() => {
      restoringAgentSidebarRef.current = false;
    }, 360);
  }

  function toggleAgentSidebar(): void {
    if (agentSidebarCollapsed || agentSidebarPanelRef.current?.isCollapsed()) {
      expandAgentSidebar();
      return;
    }
    collapseAgentSidebar();
  }

  function handleAgentSidebarResize(size: PanelSize): void {
    if (restoringAgentSidebarRef.current) {
      return;
    }
    if (isNarrowViewport()) {
      // Overlay drawer (phones): the library's split is virtual — its resize
      // events (mount echoes included) must not drive the drawer state, or
      // the boot-time echo of defaultSize re-opens a collapsed drawer.
      return;
    }
    // Keep React state in sync with the panel's REAL size only. Collapsing
    // mid-drag gets overridden by the live drag and leaves a hidden-content
    // gap, so a below-threshold drag is snapped on pointer release instead.
    if (size.inPixels <= 1) {
      pendingSnapCollapseRef.current = false;
      setAgentSidebarCollapsed(true);
      return;
    }
    setAgentSidebarCollapsed(false);
    pendingSnapCollapseRef.current = isAgentSidebarCollapseSize(size.inPixels);
    const width = clampSidebarWidth(size.inPixels);
    if (isSidebarHandleDragActive() && width !== agentSidebarWidthRef.current) {
      // Only widths from a real handle drag are recorded: mount echoes,
      // unhide relayouts and window scaling all emit resize events too, and
      // persisting those is exactly how widths drift.
      agentSidebarWidthRef.current = width;
      agentWidthPersisterRef.current?.(width);
    }
  }

  function toggleProject(project: DeskProjectView): void {
    setCollapsedProjects((current) => ({ ...current, [project.id]: !current[project.id] }));
  }

  function toggleGroup(group: DeskGroupView): void {
    setCollapsedGroups((current) => ({ ...current, [group.id]: !current[group.id] }));
  }

  function openAddProject(): void {
    setProjectForm(emptyProjectForm);
    setModal('addProject');
  }

  function openAddGroup(project?: DeskProjectView): void {
    const targetProject = project ?? activeProject;
    setModalProject(targetProject);
    const isFirstGroup = (targetProject?.groups?.length ?? 0) === 0;
    setGroupForm({
      ...emptyGroupForm,
      projectId: targetProject?.id ?? '',
      groupId: isFirstGroup ? 'main' : '',
      groupLabel: isFirstGroup ? 'Main' : ''
    });
    setModal('addGroup');
  }

  function openAddSession(group?: DeskGroupView): void {
    const targetGroup = group ?? activeGroup;
    setModalGroup(targetGroup);
    setSessionForm({
      ...emptySessionForm,
      projectId: targetGroup?.projectId ?? '',
      groupId: targetGroup?.groupId ?? '',
      cwd: targetGroup?.projectCwd ?? ''
    });
    setModal('addSession');
  }

  function openProjectModal(mode: ModalMode, project: DeskProjectView): void {
    setModalProject(project);
    setProjectForm({
      projectId: project.id,
      projectLabel: project.label,
      cwd: project.cwd
    });
    setModal(mode);
  }

  function openGroupModal(mode: ModalMode, group: DeskGroupView): void {
    setModalGroup(group);
    setModalProject(snapshot?.view.projects.find((project) => project.id === group.projectId));
    setGroupForm({
      projectId: group.projectId,
      groupId: group.groupId,
      groupLabel: group.label,
      layoutKind: group.layout.kind,
      customCells: group.layout.cellCount
    });
    setModal(mode);
  }

  function openSessionModal(mode: ModalMode, session: DeskSessionView, group?: DeskGroupView): void {
    setSelectedTmux(session.spec.tmuxSession);
    setModalSession(session);
    setModalGroup(group ?? activeGroup);
    setSessionForm({
      projectId: session.spec.projectId ?? group?.projectId ?? '',
      groupId: session.spec.groupId,
      name: session.spec.name,
      cwd: session.spec.cwd,
      agent: session.spec.agent ?? 'codex',
      resume: session.spec.resume ?? '',
      initialResume: session.spec.resume ?? '',
      bypassPermissions: session.spec.bypassPermissions ?? true,
      // Only custom commands belong in the editable command field; the derived
      // launch command must not be persisted back as a custom command.
      command: session.spec.customCommand ? session.spec.command : '',
      uiMode: session.spec.uiMode ?? 'terminal',
      model: session.spec.model ?? ''
    });
    setModal(mode);
  }

  function selectProject(project: DeskProjectView): void {
    setActiveProjectId(project.id);
    const firstGroup = project.groups[0];
    setActiveGroupId(firstGroup?.id);
    setSelectedTmux(firstGroup?.sessions[0]?.spec.tmuxSession);
  }

  function selectGroup(group: DeskGroupView): void {
    setActiveProjectId(group.projectId);
    setActiveGroupId(group.id);
    setSelectedTmux(group.sessions[0]?.spec.tmuxSession);
  }

  function openAgentEvent(event: AgentEvent): void {
    invalidateAttentionPulse();
    setAgentEvents((current) => current.map((e) => (e.id === event.id ? { ...e, read: true } : e)));
    setUnreadEvents((count) => Math.max(0, count - (event.read ? 0 : 1)));
    fireAndForget(markEventsRead({ ids: [event.id] }), 'mark event read');
    // Reading an event acknowledges its session's sidebar lamp, even when the
    // session is gone from the snapshot and cannot be revealed anymore.
    if (event.tmuxSession) {
      touchSession(event.tmuxSession);
    }
    if (event.kind === 'channel') {
      // Jump to the channels subsystem and reveal the exact message.
      setSubsystem('channels');
      if (event.channel) {
        channelsNavigatorRef.current?.(event.channel, event.messageId, event.thread);
      }
      return;
    }
    revealAgentSession(event.tmuxSession);
  }

  /** Jump to the agents subsystem with the given session selected + revealed. */
  function revealAgentSession(tmuxSession: string): void {
    for (const project of snapshot?.view.projects ?? []) {
      for (const group of project.groups) {
        const session = group.sessions.find((candidate) => candidate.spec.tmuxSession === tmuxSession);
        if (session) {
          // Jump to agents first so the sidebar/terminal exist when the
          // reveal scroll fires (deferred 80ms).
          setSubsystem('agents');
          touchSession(session.spec.tmuxSession);
          setActiveProjectId(group.projectId);
          setActiveGroupId(group.id);
          setSelectedTmux(session.spec.tmuxSession);
          revealSidebarSession(group, session.spec.tmuxSession);
          return;
        }
      }
    }
  }

  function markAllEventsRead(): void {
    invalidateAttentionPulse();
    setAgentEvents((current) => current.map((e) => ({ ...e, read: true })));
    setUnreadEvents(0);
    // Acknowledging every event acknowledges every sidebar lamp with it
    // (the server mirrors this; clearing locally avoids the poll lag).
    setAttention({});
    fireAndForget(markEventsRead({ all: true }), 'mark all events read');
  }

  async function confirmKillAll(): Promise<void> {
    setBusy(true);
    try {
      bleeps.alarm?.play();
      const result = await killAllAgents();
      pushToast(`Kill switch: ${result.killedSessions.length} sessions, ${result.killedPids.length} processes terminated.`, 'ok');
      setModal(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function clearAgentEvents(): void {
    invalidateAttentionPulse();
    setAgentEvents([]);
    setUnreadEvents(0);
    setAttention({});
    fireAndForget(clearAllEvents(), 'clear all events');
  }

  function touchSession(tmuxSession: string): void {
    recordAgentRecent(tmuxSession);
    invalidateAttentionPulse();
    setAttention((current) => {
      if (!current[tmuxSession]) {
        return current;
      }
      const next = { ...current };
      delete next[tmuxSession];
      return next;
    });
    // The server marks this session's events read on touch; mirror it locally
    // so the drawer and the unread lamp agree without waiting for the poll.
    setAgentEvents((current) => {
      let unreadDelta = 0;
      const next = current.map((event) => {
        if (event.tmuxSession === tmuxSession && !event.read) {
          unreadDelta += 1;
          return { ...event, read: true };
        }
        return event;
      });
      if (unreadDelta > 0) {
        setUnreadEvents((count) => Math.max(0, count - unreadDelta));
        return next;
      }
      return current;
    });
    fireAndForget(clearAttention(tmuxSession), 'clear attention');
  }

  function revealSidebarSession(group: DeskGroupView, tmuxSession: string): void {
    setCollapsedProjects((current) => (group.projectId && current[group.projectId] ? { ...current, [group.projectId]: false } : current));
    setCollapsedGroups((current) => (current[group.id] ? { ...current, [group.id]: false } : current));
    window.setTimeout(() => {
      document
        .querySelector(`[data-sidebar-session="true"][data-tmux-session="${CSS.escape(tmuxSession)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 80);
  }

  function selectCellSession(group: DeskGroupView, cell: PanelCell, session: DeskSessionView): void {
    touchSession(session.spec.tmuxSession);
    setActiveProjectId(group.projectId);
    setActiveGroupId(group.id);
    setSelectedTmux(session.spec.tmuxSession);
    revealSidebarSession(group, session.spec.tmuxSession);
    setCellActiveSessions((current) => ({
      ...current,
      [group.id]: {
        ...(current[group.id] ?? {}),
        [cell.id]: session.spec.tmuxSession
      }
    }));
  }

  function assignDraggedSession(group: DeskGroupView, cell: PanelCell): void {
    if (!draggedTmux) {
      return;
    }
    setCellAssignments((current) => ({
      ...current,
      [group.id]: {
        ...(current[group.id] ?? {}),
        [draggedTmux]: cell.index
      }
    }));
    setCellActiveSessions((current) => ({
      ...current,
      [group.id]: {
        ...(current[group.id] ?? {}),
        [cell.id]: draggedTmux
      }
    }));
    setDraggedTmux(null);
  }

  /** Tap-to-assign for empty cells — the DnD path without the drag. */
  function assignSessionToCell(group: DeskGroupView, cell: PanelCell, session: DeskSessionView): void {
    setCellAssignments((current) => ({
      ...current,
      [group.id]: {
        ...(current[group.id] ?? {}),
        [session.spec.tmuxSession]: cell.index
      }
    }));
    setCellActiveSessions((current) => ({
      ...current,
      [group.id]: {
        ...(current[group.id] ?? {}),
        [cell.id]: session.spec.tmuxSession
      }
    }));
    setSelectedTmux(session.spec.tmuxSession);
  }

  /** Boot one missing session straight from its cell. */
  async function bootSession(session: DeskSessionView): Promise<void> {
    setBusy(true);
    try {
      const next = await restartProjectSession({ tmuxSession: session.spec.tmuxSession });
      setSnapshot(next);
      pushToast(`Booted ${session.spec.name}`, 'ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Boot every missing session of one group (the header Up boots all groups). */
  async function bootGroupMissing(group: DeskGroupView): Promise<void> {
    const missing = group.sessions.filter((session) => session.state === 'missing');
    if (missing.length === 0) {
      return;
    }
    setBusy(true);
    try {
      let next: DeskSnapshot | null = null;
      for (const session of missing) {
        next = await restartProjectSession({ tmuxSession: session.spec.tmuxSession });
      }
      if (next) {
        setSnapshot(next);
      }
      pushToast(`Booted ${missing.length} session${missing.length === 1 ? '' : 's'} in ${group.label}`, 'ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Layout badge dropdown: rewrite the group's layout through the edit endpoint. */
  async function changeGroupLayout(group: DeskGroupView, kind: LayoutKind): Promise<void> {
    setBusy(true);
    try {
      const next = await editProjectGroup({
        projectId: group.projectId,
        currentGroupId: group.groupId,
        groupId: group.groupId,
        groupLabel: group.label,
        projectCwd: group.projectCwd,
        // custom and linear keep the current cell count; fixed grids derive it.
        layout: kind === 'custom' || kind === 'linear' ? { kind, cells: group.layout.cellCount } : { kind }
      });
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Persist drag-resized terminal split sizes per group, debounced per group id
  // (resize streams fire per frame). Mirrors the sidebar width persister: one
  // config write per gesture. Deliberately does NOT patch the in-memory snapshot
  // — that would change the group's object identity and remount every terminal.
  // The live library keeps the sizes in-session; the manifest restores them on
  // the next load via Panel defaultSize.
  const groupSizesTimerRef = useRef(new Map<string, number>());
  function persistGroupLayoutSizes(group: DeskGroupView, sizes: { rows?: number[]; cols?: number[][] }): void {
    const timers = groupSizesTimerRef.current;
    const existing = timers.get(group.id);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      timers.delete(group.id);
      void saveGroupLayoutSizes({
        projectId: group.projectId,
        groupId: group.groupId,
        projectCwd: group.projectCwd,
        sizes
      }).catch(() => undefined);
    }, 600);
    timers.set(group.id, timer);
  }

  // Drag-reorder persistence: rewrite explicit `order` for the dragged list and
  // adopt the returned snapshot. The server sorts and writes the manifest
  // atomically, so the new order survives a reload.
  async function reorderProjectsList(orderedProjectIds: string[]): Promise<void> {
    try {
      setSnapshot(await reorderProjects({ orderedProjectIds }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function reorderGroupsList(projectId: string, orderedGroupIds: string[]): Promise<void> {
    try {
      setSnapshot(await reorderGroups({ projectId, orderedGroupIds }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function reorderSessionsList(
    projectId: string,
    groupId: string,
    projectCwd: string,
    orderedSessionNames: string[]
  ): Promise<void> {
    try {
      setSnapshot(await reorderSessions({ projectId, groupId, projectCwd, orderedSessionNames }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Identity-stable handler bundles for the memoized children. App re-renders
  // every pulse tick for the header's live metrics; without stable callbacks
  // the memo walls below would never hold. Keys mirror the prop names so the
  // bundles spread directly into the JSX.
  const sidebarHandlers = useStableCallbacks({
    onAddProject: openAddProject,
    onExpandAll: expandAllTree,
    onCollapseAll: collapseAllTree,
    onToggleProject: toggleProject,
    onToggleGroup: toggleGroup,
    onAddGroup: openAddGroup,
    onAddSession: openAddSession,
    onProjectInfo: (project: DeskProjectView) => openProjectModal('projectInfo', project),
    onProjectEdit: (project: DeskProjectView) => openProjectModal('editProject', project),
    onProjectDelete: (project: DeskProjectView) => openProjectModal('deleteProject', project),
    onGroupInfo: (group: DeskGroupView) => openGroupModal('groupInfo', group),
    onGroupEdit: (group: DeskGroupView) => openGroupModal('editGroup', group),
    onGroupDelete: (group: DeskGroupView) => openGroupModal('deleteGroup', group),
    onSessionInfo: (session: DeskSessionView, group: DeskGroupView) => openSessionModal('sessionInfo', session, group),
    onSessionEdit: (session: DeskSessionView, group: DeskGroupView) => openSessionModal('editSession', session, group),
    onSessionDelete: (session: DeskSessionView, group: DeskGroupView) => openSessionModal('deleteSession', session, group),
    onSessionRestart: (session: DeskSessionView, group: DeskGroupView) => openSessionModal('restartSession', session, group),
    onSessionRepair: upMissing,
    onGroupBoot: bootGroupMissing,
    onDragSession: setDraggedSidebarSession,
    onDropSession: moveSidebarSession,
    onDropSessionToProject: (project: DeskProjectView, tmuxSession?: string) => {
      const targetGroup = getProjectDropGroup(project);
      if (!targetGroup) {
        setError(`project ${project.label} has no groups`);
        setDraggedSidebarSession(null);
        return;
      }
      void moveSidebarSession(targetGroup, tmuxSession);
    },
    onReorderProjects: reorderProjectsList,
    onReorderGroups: reorderGroupsList,
    onReorderSessions: reorderSessionsList,
    onSelectProject: selectProject,
    onSelectGroup: selectGroup,
    onSelectSession: (session: DeskSessionView, group: DeskGroupView) => {
      touchSession(session.spec.tmuxSession);
      setActiveProjectId(group.projectId);
      setActiveGroupId(group.id);
      setSelectedTmux(session.spec.tmuxSession);
      if (isNarrowViewport() && !agentSidebarCollapsed) {
        // drawer behavior: picking a session reveals it
        collapseAgentSidebar();
        // A cross-group pick remounts the whole multiplexer, which can cancel
        // a mid-flight collapse and even desync the library (isCollapsed()
        // true while the panel renders wide). Judge by the DOM and force a
        // full resync if the drawer is still visible. The overlay drawer
        // keeps its width when closed (it slides off-screen), so judge by
        // position.
        window.setTimeout(() => {
          const inner = document.querySelector('.agentTreePanelInner');
          const right = inner ? inner.getBoundingClientRect().right : 0;
          if (isNarrowViewport() && right > 1) {
            agentSidebarPanelRef.current?.expand();
            collapseAgentSidebar();
          }
        }, 420);
      }
    }
  });
  const muxHandlers = useStableCallbacks({
    onTouchSession: touchSession,
    onAddCell: addLayoutCell,
    onRemoveCell: removeLayoutCell,
    onSelectSession: selectCellSession,
    onDropSession: assignDraggedSession,
    onAssignSession: assignSessionToCell,
    onBootSession: bootSession,
    onChangeLayout: changeGroupLayout,
    onPersistLayoutSizes: persistGroupLayoutSizes,
    onTerminalSelectionMenu: (text: string, x: number, y: number) => setTerminalMenu({ text, x, y }),
    onCreateNoteFromText: (text: string) => {
      setTerminalMenu(null);
      setSubsystem('notes');
      noteCreatorRef.current?.(text);
    }
  });
  const headerHandlers = useStableCallbacks({
    onToggleMuted: () => handleMutedChange(!muted),
    onToggleNotifications: () => setNotifOpen((value) => !value),
    onOpenSettings: () => setModal('settings'),
    onKillAll: () => setModal('killAll'),
    onRefresh: refresh,
    onUp: upMissing,
    onOpenConfig: () => {
      const path = snapshot?.configPath;
      if (!path) {
        return;
      }
      setSubsystem('editor');
      if (editorFileOpenerRef.current) {
        editorFileOpenerRef.current(path);
      } else {
        pendingEditorOpenRef.current = path;
      }
    }
  });
  const railHandlers = useStableCallbacks({
    onSelect: setSubsystem,
    onToggleAgentsSidebar: toggleAgentSidebar,
    onToggleEditorSidebar: editorSidebar.toggle,
    onToggleGitSidebar: gitSidebar.toggle,
    onToggleNotesSidebar: notesSidebar.toggle,
    onToggleProjectsSidebar: projectsSidebar.toggle,
    onToggleChannelsSidebar: channelsSidebar.toggle
  });
  const drawerHandlers = useStableCallbacks({
    onResize: setNotifWidth,
    onResizeEnd: (width: number) => localStorage.setItem('desk.notifWidth', String(width)),
    onClose: () => setNotifOpen(false),
    onOpenEvent: openAgentEvent,
    onMarkAllRead: markAllEventsRead,
    onClearAll: clearAgentEvents
  });

  return (
    <DeskThemeContext.Provider value={builtTheme}>
    <BleepsProvider<DeskBleepName> {...bleepsSettings}>
      <AnimatorGeneralProvider
        disabled={reduced}
        duration={{ enter: DESK_DURATIONS.enter, exit: DESK_DURATIONS.exit, stagger: DESK_DURATIONS.stagger }}
      >
        <Animator active={booted} combine manager="stagger" duration={{ stagger: 0.12 }}>
          <main className="deskShell" style={themeVars}>
            <BackdropField />
            <AttentionAnnouncer attention={attention} />
            <Animated as="section" className="terminalFrame" animated={['fade']}>
              <FrameLines />
              <Animator combine manager="stagger" duration={{ stagger: 0.04 }}>
                <Animated animated={['flicker']}>
                  <WorkspaceHeader
                    snapshot={snapshot}
                    systemSnapshot={systemSnapshot}
                    systemError={systemError}
                    telemetryHistory={telemetryHistoryRef.current}
                    busy={busy}
                    muted={muted}
                    unreadEvents={unreadEvents}
                    {...headerHandlers}
                  />
                </Animated>
              </Animator>

              <div className="deskContent">
                <AppRail
                  subsystem={subsystem}
                  agentsSidebarCollapsed={agentSidebarCollapsed}
                  editorSidebarCollapsed={editorSidebar.collapsed}
                  gitSidebarCollapsed={gitSidebar.collapsed}
                  notesSidebarCollapsed={notesSidebar.collapsed}
                  projectsSidebarCollapsed={projectsSidebar.collapsed}
                  channelsSidebarCollapsed={channelsSidebar.collapsed}
                  channelsUnread={channelsUnread}
                  {...railHandlers}
                />
                <div className="editorMount" style={{ display: subsystem === 'agents' ? 'flex' : 'none' }}>
                  <Group
                    orientation="horizontal"
                    className={`subsystemPanels ${agentSidebarCollapsed ? 'agentSidebarCollapsed' : ''} ${sidebarAnimating ? 'sidebarAnimating' : ''}`}
                    id="desk-agents-sidebar"
                  >
                    <Panel
                      id="agents-sidebar-tree"
                      panelRef={agentSidebarPanelRef}
                      defaultSize={`${agentSidebarWidthRef.current}px`}
                      minSize={AGENT_SIDEBAR_MIN_SIZE}
                      maxSize={AGENT_SIDEBAR_MAX_SIZE}
                      collapsedSize="0px"
                      collapsible
                      groupResizeBehavior="preserve-pixel-size"
                      onResize={handleAgentSidebarResize}
                      className="agentTreePanel"
                    >
                      <aside className="agentTreePanelInner">
                        <AgentsSidebar
                          projects={snapshot?.view.projects ?? []}
                          attention={attention}
                          activeProjectId={activeProject?.id}
                          activeGroupId={activeGroup?.id}
                          activeTmux={selectedTmux}
                          collapsedProjects={collapsedProjects}
                          collapsedGroups={collapsedGroups}
                          {...sidebarHandlers}
                        />
                      </aside>
                    </Panel>
                    <Separator className="panelResizeHandle" disabled={agentSidebarCollapsed} onPointerDown={() => setSidebarHandleDragActive(true)} />
                    <Panel id="agents-surface" minSize={surfaceMinSize(narrowViewport)} className="subsystemSurface">
                      {narrowViewport && !agentSidebarCollapsed ? (
                        <button
                          type="button"
                          className="drawerScrim"
                          aria-label="Close sidebar"
                          onClick={() => collapseAgentSidebar()}
                        />
                      ) : null}
                      <main className="subsystemSurfaceInner">
                        {!activeGroup ? <EmptySubsystem /> : null}
                        {mountedMuxGroups.map((mountedGroup) => (
                          <MountedMux
                            key={mountedGroup.id}
                            group={mountedGroup}
                            visible={subsystem === 'agents' && Boolean(activeGroup) && mountedGroup.id === activeGroup?.id}
                            assignments={cellAssignments[mountedGroup.id] ?? EMPTY_CELL_MAP}
                            activeByCell={cellActiveSessions[mountedGroup.id] ?? EMPTY_ACTIVE_MAP}
                            selectedTmux={selectedTmux}
                            attention={attention}
                            busy={busy}
                            onDragSession={setDraggedTmux}
                            terminalRevisions={terminalRevisions}
                            handlers={muxHandlers}
                          />
                        ))}
                      </main>
                    </Panel>
                  </Group>
                </div>
                <div className="editorMount" style={{ display: subsystem === 'editor' ? 'flex' : 'none' }}>
                  <EditorSubsystem
                    active={subsystem === 'editor'}
                    rootShortcuts={(snapshot?.view.projects ?? []).map((project) => project.cwd)}
                    autosave={{ mode: autosaveMode, delayMs: autosaveDelayMs }}
                    createLspBinding={createLspBinding}
                    onError={setError}
                    onSidebarCollapsedChange={editorSidebar.onCollapsedChange}
                    registerSidebarToggle={editorSidebar.registerToggle}
                    registerFileOpener={(open) => {
                      editorFileOpenerRef.current = open;
                      const pending = pendingEditorOpenRef.current;
                      if (pending) {
                        pendingEditorOpenRef.current = null;
                        open(pending);
                      }
                    }}
                    registerFileReveal={(reveal) => {
                      editorRevealRef.current = reveal;
                      const pending = pendingEditorRevealRef.current;
                      if (pending) {
                        pendingEditorRevealRef.current = null;
                        reveal(pending);
                      }
                    }}
                    onRevealInGit={(target) => {
                      setSubsystem('git');
                      if (gitNavigatorRef.current) {
                        gitNavigatorRef.current(target);
                      } else {
                        pendingGitNavRef.current = target;
                      }
                    }}
                    serverSidebarWidth={sidebarWidths?.editor}
                  />
                </div>
                <div className="editorMount" style={{ display: subsystem === 'git' ? 'flex' : 'none' }}>
                  <GitSubsystem
                    active={subsystem === 'git'}
                    onError={setError}
                    onOpenFile={(path) => {
                      setSubsystem('editor');
                      if (editorFileOpenerRef.current) {
                        editorFileOpenerRef.current(path);
                      } else {
                        pendingEditorOpenRef.current = path;
                      }
                    }}
                    onRevealInExplorer={(path) => {
                      setSubsystem('editor');
                      if (editorRevealRef.current) {
                        editorRevealRef.current(path);
                      } else {
                        pendingEditorRevealRef.current = path;
                      }
                    }}
                    onSidebarCollapsedChange={gitSidebar.onCollapsedChange}
                    registerSidebarToggle={gitSidebar.registerToggle}
                    registerNavigator={(navigate) => {
                      gitNavigatorRef.current = navigate;
                      const pending = pendingGitNavRef.current;
                      if (pending) {
                        pendingGitNavRef.current = null;
                        navigate(pending);
                      }
                    }}
                    serverSidebarWidth={sidebarWidths?.git}
                  />
                </div>
                <div className="editorMount" style={{ display: subsystem === 'notes' ? 'flex' : 'none' }}>
                  <EditorSubsystem
                    variant="notes"
                    active={subsystem === 'notes'}
                    rootShortcuts={[]}
                    autosave={{ mode: autosaveMode, delayMs: autosaveDelayMs }}
                    createLspBinding={createLspBinding}
                    onError={setError}
                    onSidebarCollapsedChange={notesSidebar.onCollapsedChange}
                    registerSidebarToggle={notesSidebar.registerToggle}
                    registerNoteCreator={(create) => {
                      noteCreatorRef.current = create;
                    }}
                    serverSidebarWidth={sidebarWidths?.notes}
                  />
                </div>
                <div className="editorMount" style={{ display: subsystem === 'projects' ? 'flex' : 'none' }}>
                  <ProjectsSubsystem
                    active={subsystem === 'projects'}
                    onError={setError}
                    onInfo={(message) => pushToast(message, 'ok')}
                    onSidebarCollapsedChange={projectsSidebar.onCollapsedChange}
                    registerSidebarToggle={projectsSidebar.registerToggle}
                    serverSidebarWidth={sidebarWidths?.projects}
                  />
                </div>
                <div
                  className={`editorMount channelsKeepAliveMount ${subsystem === 'channels' ? 'active' : ''}`}
                  aria-hidden={subsystem !== 'channels'}
                >
                  <ChannelsSubsystem
                    active={subsystem === 'channels'}
                    snapshot={snapshot}
                    onError={setError}
                    onInfo={(message) => pushToast(message, 'ok')}
                    onRevealAgent={revealAgentSession}
                    onUnreadChange={setChannelsUnread}
                    registerNavigator={(navigate) => {
                      channelsNavigatorRef.current = navigate;
                    }}
                    onOpenFile={(path) => {
                      setSubsystem('editor');
                      if (editorFileOpenerRef.current) {
                        editorFileOpenerRef.current(path);
                      } else {
                        pendingEditorOpenRef.current = path;
                      }
                    }}
                    onSidebarCollapsedChange={channelsSidebar.onCollapsedChange}
                    registerSidebarToggle={channelsSidebar.registerToggle}
                    serverSidebarWidth={sidebarWidths?.channels}
                  />
                </div>
              </div>

              <StatusBar scope={subsystem} globals={statusGlobals} />

              <NotificationDrawer
                open={notifOpen}
                width={notifWidth}
                events={agentEvents}
                snapshot={snapshot}
                {...drawerHandlers}
              />

              {renderModal()}
              {agentPaletteOpen ? (
                <AgentsPalette
                  projects={snapshot?.view.projects ?? []}
                  attention={attention}
                  onClose={() => setAgentPaletteOpen(false)}
                  onPick={(tmuxSession) => {
                    setAgentPaletteOpen(false);
                    revealAgentSession(tmuxSession);
                  }}
                />
              ) : null}
              {terminalMenu ? (
                <TerminalSelectionMenu
                  menu={terminalMenu}
                  onCopy={(text) => {
                    void navigator.clipboard?.writeText(text).catch(() => undefined);
                    setTerminalMenu(null);
                  }}
                  onCreateNote={muxHandlers.onCreateNoteFromText}
                />
              ) : null}
              <ToastStack toasts={toasts} onDismiss={dismissToast} />
            </Animated>
          </main>
        </Animator>
      </AnimatorGeneralProvider>
    </BleepsProvider>
    </DeskThemeContext.Provider>
  );

  function renderModal(): ReactNode {
    if (!modal) {
      return null;
    }
    interface ModalFrame {
      title: string;
      icon: ReactNode;
      help?: string | ReactNode;
      tone?: 'danger';
      wide?: boolean;
      alarm?: boolean;
      body: ReactNode;
    }
    const frame: ModalFrame | null = ((): ModalFrame | null => {
      switch (modal) {
        case 'addProject':
          return {
            title: 'Add project',
            icon: <FolderPlus size={13} />,
            help: 'Enter a project name and working directory where agents will operate. Projects organize agent groups and coordinate work across multiple tasks and agents.',
            body: <ProjectFormView form={projectForm} busy={busy} onSubmit={submitProject} onFormChange={setProjectForm} />
          };
        case 'addGroup':
          return {
            title: 'Add group',
            icon: <LayoutGrid size={13} />,
            help: (
              <>
                <div>Each project holds groups — one cell grid per group, where each cell is an agent chat or a terminal. Pick the layout in the form:</div>
                <div style={{ marginTop: '8px' }}>
                  <strong>2x2</strong> for a four-agent working set — the default choice
                </div>
                <div style={{ marginTop: '4px' }}>
                  <strong>linear</strong> with 3 cells for a review lane you want side by side
                </div>
                <div style={{ marginTop: '4px' }}>
                  <strong>custom</strong> with up to 16 cells when the fixed grids do not fit
                </div>
                <div style={{ marginTop: '8px' }}>
                  Layouts are not fixed after creation: the badge in the multiplexer header switches kinds in place, the + and − controls add and remove cells, and dragging the separators between cells persists your exact split proportions per group.
                </div>
                <div style={{ marginTop: '8px' }}>
                  <a href="https://docs.desk.cloud/guide-create-agent-fleet/" target="_blank" rel="noopener noreferrer" style={{ color: '#4dd9ff', textDecoration: 'underline', cursor: 'pointer' }}>
                    See Multi-agent layouts for the full tour →
                  </a>
                </div>
              </>
            ),
            body: <GroupFormView form={groupForm} busy={busy} onSubmit={submitGroup} onFormChange={setGroupForm} />
          };
        case 'addSession':
          return {
            title: 'Add session',
            icon: <Plus size={13} />,
            help: (
              <>
                <div>Terminals are tmux sessions where agents execute commands and interact with your codebase. Each session is an independent environment with its own state. Create sessions to run multiple agents in parallel or organize work by task. Sessions persist their state across reloads and can be restarted or repaired if they encounter issues.</div>
                <div style={{ marginTop: '8px' }}>
                  <a href="https://docs.desk.cloud/guide-create-agent-fleet/#3-add-agent-sessions" target="_blank" rel="noopener noreferrer" style={{ color: '#4dd9ff', textDecoration: 'underline', cursor: 'pointer' }}>
                    Learn more →
                  </a>
                </div>
              </>
            ),
            body: (
              <SessionFormView
                form={sessionForm}
                projects={snapshot?.view.projects ?? []}
                busy={busy}
                onSubmit={submitSession}
                onFormChange={setSessionForm}
              />
            )
          };
        case 'projectInfo':
          return {
            title: modalTitle(modal),
            icon: <Folder size={13} />,
            body: <ProjectInfo project={modalProject} />
          };
        case 'editProject':
          return {
            title: modalTitle(modal),
            icon: <Folder size={13} />,
            body: <ProjectFormView form={projectForm} busy={busy} onSubmit={submitProjectEdit} onFormChange={setProjectForm} />
          };
        case 'deleteProject':
          return {
            title: modalTitle(modal),
            icon: <Trash2 size={13} />,
            body: (
              <ConfirmAction
                label={`Delete ${modalProject?.label ?? 'project'}`}
                detail="This kills the project's tmux sessions and removes the project from config. For legacy mixed groups, only sessions under this project CWD are removed."
                busy={busy}
                onConfirm={confirmDeleteProject}
              />
            )
          };
        case 'groupInfo':
          return {
            title: modalTitle(modal),
            icon: <Boxes size={13} />,
            body: <GroupInfo group={modalGroup} />
          };
        case 'editGroup':
          return {
            title: modalTitle(modal),
            icon: <Boxes size={13} />,
            body: <GroupFormView form={groupForm} busy={busy} onSubmit={submitGroupEdit} onFormChange={setGroupForm} />
          };
        case 'deleteGroup':
          return {
            title: modalTitle(modal),
            icon: <Trash2 size={13} />,
            body: (
              <ConfirmAction
                label={`Delete ${modalGroup?.label ?? 'group'}`}
                detail="This kills the group's tmux sessions and removes the group from config. For legacy mixed groups, only sessions under this project CWD are removed."
                busy={busy}
                onConfirm={confirmDeleteGroup}
              />
            )
          };
        case 'sessionInfo':
          return {
            title: modalTitle(modal),
            icon: <TerminalSquare size={13} />,
            body: <SessionInfo session={modalSession} />
          };
        case 'editSession':
          return {
            title: modalTitle(modal),
            icon: <TerminalSquare size={13} />,
            body: (
              <SessionFormView
                form={sessionForm}
                projects={snapshot?.view.projects ?? []}
                busy={busy}
                onSubmit={submitSessionEdit}
                onFormChange={setSessionForm}
              />
            )
          };
        case 'killAll':
          return {
            title: 'Emergency Kill',
            icon: <Skull size={13} />,
            tone: 'danger',
            alarm: true,
            body: <KillConfirm busy={busy} onCancel={() => setModal(null)} onConfirm={confirmKillAll} />
          };
        case 'settings':
          return {
            title: 'Settings',
            icon: <SettingsIcon size={13} />,
            wide: true,
            body: (
              <SettingsView
                themeName={themeName}
                onThemeChange={handleThemeNameChange}
                autosaveMode={autosaveMode}
                autosaveDelayMs={autosaveDelayMs}
                onAutosaveModeChange={handleAutosaveModeChange}
                onAutosaveDelayChange={handleAutosaveDelayChange}
                muted={muted}
                onMutedChange={handleMutedChange}
                lspEnabled={lspEnabled}
                lspDetectedLanguages={detectedLanguages}
                lspDisabledLanguages={lspDisabledLanguages}
                lspDetectionTruncated={lspDetectionTruncated}
                lspDetectionState={lspDetectionState}
                lspSaving={lspSaving}
                lspSaveError={lspSaveError}
                lspHasActiveRoot={activeEditorRoot !== null}
                onLspEnabledChange={handleLspEnabledChange}
                onLspLanguageToggle={handleLspLanguageToggle}
                onLspRefresh={handleLspRefresh}
              />
            )
          };
        case 'deleteSession':
          return {
            title: modalTitle(modal),
            icon: <Trash2 size={13} />,
            body: (
              <ConfirmAction
                label={`Delete ${modalSession?.spec.name ?? 'session'}`}
                detail="This kills the tmux session process and removes the session from config."
                busy={busy}
                onConfirm={confirmDeleteSession}
              />
            )
          };
        case 'restartSession':
          return {
            title: modalTitle(modal),
            icon: <RotateCw size={13} />,
            body: (
              <ConfirmAction
                label={`Restart ${modalSession?.spec.name ?? 'session'}`}
                detail="This kills the running tmux session and starts it fresh. Whatever the agent is doing right now is interrupted; unsent context is lost."
                busy={busy}
                confirmLabel="Restart session"
                confirmIcon={<RotateCw size={12} />}
                onConfirm={() => {
                  if (modalSession && modalGroup) {
                    void restartExistingSession(modalSession, modalGroup);
                  }
                }}
              />
            )
          };
        case 'switchUiMode':
          return {
            title: modalTitle(modal),
            icon: <RotateCw size={13} />,
            body: (
              <ConfirmAction
                label={
                  uiModeSwitchDiscard
                    ? `Start fresh in ${sessionForm.uiMode} mode`
                    : `Switch ${modalSession?.spec.name ?? 'session'} to ${sessionForm.uiMode} UI`
                }
                detail={
                  uiModeSwitchDiscard
                    ? 'No resume id has been captured for this session yet, so the switch cannot rejoin the conversation. Confirming starts a FRESH conversation in the new mode; the current one stays only in the agent-native history.'
                    : 'This respawns the session in the selected UI mode: the running tmux session is killed and relaunched resuming the same conversation by its captured id. In-flight work is interrupted.'
                }
                busy={busy}
                confirmLabel={uiModeSwitchDiscard ? 'Switch UI mode (start fresh)' : 'Switch UI mode'}
                confirmIcon={<RotateCw size={12} />}
                onConfirm={() => {
                  void confirmUiModeSwitch();
                }}
              />
            )
          };
        default:
          return null;
      }
    })();
    if (!frame) {
      return null;
    }
    const { body, ...rest } = frame;
    return (
      <Modal {...rest} onClose={() => setModal(null)}>
        {body}
      </Modal>
    );
  }
}

function AppRailImpl({
  subsystem,
  agentsSidebarCollapsed,
  editorSidebarCollapsed,
  gitSidebarCollapsed,
  notesSidebarCollapsed,
  onSelect,
  onToggleAgentsSidebar,
  onToggleEditorSidebar,
  onToggleGitSidebar,
  onToggleNotesSidebar,
  projectsSidebarCollapsed,
  onToggleProjectsSidebar,
  channelsSidebarCollapsed,
  channelsUnread,
  onToggleChannelsSidebar
}: {
  subsystem: Subsystem;
  agentsSidebarCollapsed: boolean;
  editorSidebarCollapsed: boolean;
  gitSidebarCollapsed: boolean;
  notesSidebarCollapsed: boolean;
  projectsSidebarCollapsed: boolean;
  channelsSidebarCollapsed: boolean;
  channelsUnread: number;
  onSelect: (subsystem: Subsystem) => void;
  onToggleAgentsSidebar: () => void;
  onToggleEditorSidebar: () => void;
  onToggleGitSidebar: () => void;
  onToggleNotesSidebar: () => void;
  onToggleProjectsSidebar: () => void;
  onToggleChannelsSidebar: () => void;
}): JSX.Element {
  return (
    <nav className="appRail" aria-label="Subsystems">
      <Animator combine manager="stagger" duration={{ stagger: 0.06 }}>
        <SubsystemButton
          icon={<SquareTerminal size={24} />}
          label="Agents"
          active={subsystem === 'agents'}
          compact={agentsSidebarCollapsed}
          onClick={() => (subsystem === 'agents' ? onToggleAgentsSidebar() : onSelect('agents'))}
          onDoubleClick={onToggleAgentsSidebar}
        />
        <SubsystemButton
          icon={<MessagesSquare size={24} />}
          label="Channels"
          active={subsystem === 'channels'}
          compact={channelsSidebarCollapsed}
          badge={channelsUnread}
          onClick={() => (subsystem === 'channels' ? onToggleChannelsSidebar() : onSelect('channels'))}
          onDoubleClick={onToggleChannelsSidebar}
        />
        <SubsystemButton
          icon={<FolderTree size={24} />}
          label="Editor"
          active={subsystem === 'editor'}
          compact={editorSidebarCollapsed}
          onClick={() => (subsystem === 'editor' ? onToggleEditorSidebar() : onSelect('editor'))}
          onDoubleClick={onToggleEditorSidebar}
        />
        <SubsystemButton
          icon={<GitBranch size={24} />}
          label="Git"
          active={subsystem === 'git'}
          compact={gitSidebarCollapsed}
          onClick={() => (subsystem === 'git' ? onToggleGitSidebar() : onSelect('git'))}
          onDoubleClick={onToggleGitSidebar}
        />
        <SubsystemButton
          icon={<SquareKanban size={24} />}
          label="Projects"
          active={subsystem === 'projects'}
          compact={projectsSidebarCollapsed}
          onClick={() => (subsystem === 'projects' ? onToggleProjectsSidebar() : onSelect('projects'))}
          onDoubleClick={onToggleProjectsSidebar}
        />
        <SubsystemButton
          icon={<NotebookPen size={24} />}
          label="Notes"
          active={subsystem === 'notes'}
          compact={notesSidebarCollapsed}
          onClick={() => (subsystem === 'notes' ? onToggleNotesSidebar() : onSelect('notes'))}
          onDoubleClick={onToggleNotesSidebar}
        />
      </Animator>
      <RailDocsButton />
    </nav>
  );
}

const AppRail = memo(AppRailImpl);

function RailDocsButton(): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  return (
    <a
      className="subsystemButton railDocsButton"
      href="https://docs.desk.cloud"
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Docs"
      title="Docs"
      onMouseEnter={() => bleeps.hover?.play()}
      onClick={() => bleeps.click?.play()}
    >
      <span className="subsystemButtonBar" aria-hidden="true" />
      <span className="subsystemButtonIcon">
        <BookOpen size={24} />
      </span>
    </a>
  );
}

function TerminalSelectionMenu({
  menu,
  onCopy,
  onCreateNote
}: {
  menu: { x: number; y: number; text: string };
  onCopy: (text: string) => void;
  onCreateNote: (text: string) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const menuRef = useClampedMenu(menu);
  const item = (icon: ReactNode, label: string, action: () => void): JSX.Element => (
    <Animator key={label}>
      <Animated
        as="button"
        type="button"
        className="treeMenuItem"
        animated={['fade', ['x', -6, 0]]}
        onMouseEnter={() => bleeps.hover?.play()}
        onClick={() => {
          bleeps.click?.play();
          action();
        }}
      >
        {icon}
        {label}
      </Animated>
    </Animator>
  );
  return (
    <div
      ref={menuRef}
      className="treeContextMenu"
      style={{ left: menu.x, top: menu.y, clipPath: CLIP_OCTAGON_TINY }}
      onClick={(event) => event.stopPropagation()}
    >
      <Animator combine manager="stagger" duration={{ stagger: 0.015 }}>
        {item(<Copy size={12} />, 'Copy', () => onCopy(menu.text))}
        {item(<StickyNote size={12} />, 'Create note', () => onCreateNote(menu.text))}
      </Animator>
    </div>
  );
}

function KillConfirm({
  busy,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  return (
    <div className="thinForm modalForm killConfirm">
      <div className="confirmCopy">
        <strong>Terminate ALL agents?</strong>
        <span>
          This kills every Codex and Claude CLI process and its tmux session — including agents not managed by Desk.
          Sessions with a stored resume id can be restarted; in-progress turns are lost.
        </span>
      </div>
      <div className="killConfirmActions">
        <button
          type="button"
          className="thinButton"
          disabled={busy}
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
            onCancel();
          }}
        >
          Cancel
        </button>
        <CommandButton icon={<Skull size={12} />} label="Confirm kill" disabled={busy} onClick={() => void onConfirm()} />
      </div>
    </div>
  );
}

function ThemeSettings({
  current,
  onSelect
}: {
  current: DeskThemeName;
  onSelect: (name: DeskThemeName) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  return (
    <div className="thinForm modalForm">
      <span className="settingsSectionLabel">Color theme</span>
      <div className="themeGrid">
        {DESK_THEME_NAMES.map((name) => {
          const entry = DESK_THEMES[name];
          return (
            <button
              key={name}
              type="button"
              className={`themeCard ${current === name ? 'selected' : ''}`}
              style={{ clipPath: CLIP_OCTAGON_TINY }}
              onMouseEnter={() => bleeps.hover?.play()}
              onClick={() => {
                bleeps.click?.play();
                onSelect(name);
              }}
            >
              <span className="themeChips">
                {entry.preview.map((color, index) => (
                  <i key={index} style={{ background: color }} />
                ))}
              </span>
              <span className="themeCardLabel">{entry.label}</span>
              <small>{entry.mode}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type SettingsSection = 'theme' | 'editor' | 'sound' | 'lsp';

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'theme', label: 'Theme', icon: <Palette size={13} /> },
  { id: 'editor', label: 'Editor', icon: <FileCode size={13} /> },
  { id: 'sound', label: 'Sound', icon: <Volume2 size={13} /> },
  { id: 'lsp', label: 'Language servers', icon: <Braces size={13} /> }
];

function SettingsView({
  themeName,
  onThemeChange,
  autosaveMode,
  autosaveDelayMs,
  onAutosaveModeChange,
  onAutosaveDelayChange,
  muted,
  onMutedChange,
  lspEnabled,
  lspDetectedLanguages,
  lspDisabledLanguages,
  lspDetectionTruncated,
  lspDetectionState,
  lspSaving,
  lspSaveError,
  lspHasActiveRoot,
  onLspEnabledChange,
  onLspLanguageToggle,
  onLspRefresh
}: {
  themeName: DeskThemeName;
  onThemeChange: (name: DeskThemeName) => void;
  autosaveMode: DeskAutosaveMode;
  autosaveDelayMs: number;
  onAutosaveModeChange: (mode: DeskAutosaveMode) => void;
  onAutosaveDelayChange: (delayMs: number) => void;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  lspEnabled: boolean;
  lspDetectedLanguages: string[];
  lspDisabledLanguages: string[];
  lspDetectionTruncated: boolean;
  lspDetectionState: 'idle' | 'loading' | 'error';
  lspSaving: boolean;
  lspSaveError: boolean;
  lspHasActiveRoot: boolean;
  onLspEnabledChange: (enabled: boolean) => void;
  onLspLanguageToggle: (languageId: string, enabled: boolean) => void;
  onLspRefresh: () => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [section, setSection] = useState<SettingsSection>('theme');
  return (
    <div className="settingsLayout">
      <nav className="settingsTabs" aria-label="Settings sections">
        <Animator combine manager="stagger" duration={{ stagger: 0.04 }}>
          {SETTINGS_SECTIONS.map((entry) => (
            <Animator key={entry.id}>
              <Animated
                as="button"
                type="button"
                animated={['fade', ['x', -8, 0]]}
                className={`settingsTab ${section === entry.id ? 'selected' : ''}`}
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={() => {
                  if (section !== entry.id) {
                    bleeps.click?.play();
                    setSection(entry.id);
                  }
                }}
              >
                {entry.icon}
                <span>{entry.label}</span>
              </Animated>
            </Animator>
          ))}
        </Animator>
      </nav>
      {/* plain Animator: a `combine` parent with no child Animators computes a
          zero duration and Arwes rejects the transition */}
      <Animator key={section} duration={{ enter: 0.2 }}>
        <Animated className="settingsContent" animated={['fade', ['y', 8, 0]]}>
          {section === 'theme' ? <ThemeSettings current={themeName} onSelect={onThemeChange} /> : null}
          {section === 'editor' ? (
            <AutosaveSettings
              mode={autosaveMode}
              delayMs={autosaveDelayMs}
              onModeChange={onAutosaveModeChange}
              onDelayChange={onAutosaveDelayChange}
            />
          ) : null}
          {section === 'sound' ? <SoundSettings muted={muted} onMutedChange={onMutedChange} /> : null}
          {section === 'lsp' ? (
            <LspSettings
              enabled={lspEnabled}
              detectedLanguages={lspDetectedLanguages}
              disabledLanguages={lspDisabledLanguages}
              truncated={lspDetectionTruncated}
              detectionState={lspDetectionState}
              saving={lspSaving}
              saveError={lspSaveError}
              hasActiveRoot={lspHasActiveRoot}
              onEnabledChange={onLspEnabledChange}
              onLanguageToggle={onLspLanguageToggle}
              onRefresh={onLspRefresh}
            />
          ) : null}
        </Animated>
      </Animator>
    </div>
  );
}

function LspSettings({
  enabled,
  detectedLanguages,
  disabledLanguages,
  truncated,
  detectionState,
  saving,
  saveError,
  hasActiveRoot,
  onEnabledChange,
  onLanguageToggle,
  onRefresh
}: {
  enabled: boolean;
  detectedLanguages: string[];
  disabledLanguages: string[];
  truncated: boolean;
  detectionState: 'idle' | 'loading' | 'error';
  saving: boolean;
  saveError: boolean;
  hasActiveRoot: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onLanguageToggle: (languageId: string, enabled: boolean) => void;
  onRefresh: () => void;
}): JSX.Element {
  const disabledSet = new Set(disabledLanguages);
  const chipStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 3,
    border: '1px solid var(--desk-line)',
    color: 'var(--desk-text)',
    fontSize: 10,
    lineHeight: 1.6
  };
  return (
    <div className="thinForm modalForm">
      <span className="settingsSectionLabel">Language servers</span>
      <div className="autosaveRow">
        <DeskSelect
          value={enabled ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Auto-activate from workspace' },
            { value: 'off', label: 'Off' }
          ]}
          onChange={(value) => {
            // Functionally "disabled while saving": ignore changes mid-save to avoid overlapping POSTs.
            if (!saving) {
              onEnabledChange(value === 'on');
            }
          }}
        />
        <button
          type="button"
          onClick={onRefresh}
          disabled={!enabled || !hasActiveRoot || detectionState === 'loading'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            background: 'transparent',
            border: '1px solid var(--desk-line)',
            borderRadius: 3,
            color: 'var(--desk-text)',
            cursor: !enabled || !hasActiveRoot || detectionState === 'loading' ? 'default' : 'pointer',
            opacity: !enabled || !hasActiveRoot || detectionState === 'loading' ? 0.5 : 1
          }}
        >
          <RefreshCw size={13} />
          <span>Refresh</span>
        </button>
      </div>
      <small className="settingsHint">
        When on, Desk detects the languages present in the active editor root and activates every
        configured language server for them automatically. Languages without a configured server are
        skipped. The on/off switch and any per-language servers you turn off are saved to desk.yml; the
        detected language list itself is discovered at runtime.
      </small>
      {saveError ? <small className="settingsHint">Could not save. Try again.</small> : null}
      {enabled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="settingsSectionLabel">Detected languages</span>
          <small className="settingsHint">Click a language to turn its server off; click again to re-enable.</small>
          {detectionState === 'loading' ? (
            <small className="settingsHint">Scanning workspace...</small>
          ) : detectionState === 'error' ? (
            <small className="settingsHint">
              {hasActiveRoot ? 'Detection failed for this workspace root.' : 'Open a workspace root to detect languages.'}
            </small>
          ) : detectedLanguages.length === 0 ? (
            <small className="settingsHint">
              {hasActiveRoot
                ? 'No configured language servers match the file types in this root.'
                : 'Open a workspace root to detect languages.'}
            </small>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Detected languages">
              {detectedLanguages.map((language) => {
                const active = !disabledSet.has(language);
                return (
                  <button
                    type="button"
                    key={language}
                    role="switch"
                    aria-checked={active}
                    aria-label={`${language} language server`}
                    disabled={saving}
                    onClick={() => {
                      if (!saving) {
                        onLanguageToggle(language, !active);
                      }
                    }}
                    style={{
                      ...chipStyle,
                      cursor: saving ? 'default' : 'pointer',
                      opacity: active ? 1 : 0.45,
                      textDecoration: active ? 'none' : 'line-through',
                      background: active ? 'var(--desk-bg-active, transparent)' : 'transparent'
                    }}
                  >
                    {language}
                  </button>
                );
              })}
            </div>
          )}
          {truncated ? (
            <small className="settingsHint">Workspace is large; detection stopped early and may be incomplete.</small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SoundSettings({
  muted,
  onMutedChange
}: {
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
}): JSX.Element {
  return (
    <div className="thinForm modalForm">
      <span className="settingsSectionLabel">Interface sound</span>
      <div className="autosaveRow">
        <DeskSelect
          value={muted ? 'muted' : 'on'}
          options={[
            { value: 'on', label: 'Bleeps on' },
            { value: 'muted', label: 'Muted' }
          ]}
          onChange={(value) => onMutedChange(value === 'muted')}
        />
      </div>
      <small className="settingsHint">
        Same switch as the toolbar speaker toggle; persisted to desk.yml. Sounds stay quiet until the first
        interaction either way (browser autoplay policy).
      </small>
    </div>
  );
}

const AUTOSAVE_MODE_OPTIONS = [
  { value: 'off', label: 'Off — save with Ctrl+S' },
  { value: 'after-delay', label: 'After delay' },
  { value: 'on-focus-change', label: 'On focus change' }
];

const AUTOSAVE_DELAY_OPTIONS = [500, 1000, 2000, 5000, 10000].map((ms) => ({
  value: String(ms),
  label: ms < 1000 ? `${ms} ms` : `${ms / 1000} s`
}));

function AutosaveSettings({
  mode,
  delayMs,
  onModeChange,
  onDelayChange
}: {
  mode: DeskAutosaveMode;
  delayMs: number;
  onModeChange: (mode: DeskAutosaveMode) => void;
  onDelayChange: (delayMs: number) => void;
}): JSX.Element {
  return (
    <div className="thinForm modalForm">
      <span className="settingsSectionLabel">Editor autosave</span>
      <div className="autosaveRow">
        <DeskSelect
          value={mode}
          options={AUTOSAVE_MODE_OPTIONS}
          onChange={(value) => onModeChange(value as DeskAutosaveMode)}
        />
        {mode === 'after-delay' ? (
          <DeskSelect
            value={String(delayMs)}
            options={AUTOSAVE_DELAY_OPTIONS}
            onChange={(value) => onDelayChange(Number(value))}
          />
        ) : null}
      </div>
      <small className="settingsHint">
        Autosave never overwrites a file changed on disk — conflicts surface the Reload / Keep-mine banner instead.
      </small>
    </div>
  );
}

const EVENT_KIND_META: Record<AgentEvent['kind'], { label: string; tone: string }> = {
  'turn-complete': { label: 'TURN COMPLETE', tone: 'ok' },
  'approval-requested': { label: 'APPROVAL NEEDED', tone: 'error' },
  'input-requested': { label: 'INPUT NEEDED', tone: 'warn' },
  bell: { label: 'AWAITING INPUT', tone: 'warn' },
  channel: { label: '@HUMAN PING', tone: 'warn' }
};

const TOAST_TONE_META: Record<ToastTone, { label: string; icon: ReactNode }> = {
  error: { label: 'ERROR', icon: <Wrench size={13} /> },
  ok: { label: 'DONE', icon: <Zap size={13} /> },
  info: { label: 'INFO', icon: <Info size={13} /> }
};

const TOAST_TTL_MS = 6500;

function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div className="toastStack" aria-live="assertive">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [active, setActive] = useState(false);
  const meta = TOAST_TONE_META[toast.tone];
  const closedRef = useRef(false);
  const close = useCallback((): void => {
    if (closedRef.current) {
      return;
    }
    closedRef.current = true;
    setActive(false);
    window.setTimeout(() => onDismiss(toast.id), 280);
  }, [onDismiss, toast.id]);
  useEffect(() => {
    setActive(true);
    const ttl = window.setTimeout(close, TOAST_TTL_MS);
    return () => window.clearTimeout(ttl);
  }, [close]);
  return (
    <Animator root active={active} duration={{ enter: 0.3, exit: 0.22 }} unmountOnExited>
      <BleepsOnAnimator<DeskBleepName> transitions={{ entering: toast.tone === 'error' ? 'error' : 'open' }} />
      <Animated
        className={`deskToast ${toast.tone}`}
        animated={['flicker', ['x', 32, 0]]}
        style={{ clipPath: CLIP_OCTAGON_TINY }}
        role="status"
      >
        <span className="deskToastIcon">{meta.icon}</span>
        <div className="deskToastBody">
          <i className="deskToastKind">{meta.label}</i>
          <span className="deskToastMessage">{toast.message}</span>
        </div>
        <button
          type="button"
          className="deskToastClose"
          aria-label="Dismiss"
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
            close();
          }}
        >
          <X size={12} />
        </button>
      </Animated>
    </Animator>
  );
}

function NotificationDrawerImpl({
  open,
  width,
  events,
  snapshot,
  onResize,
  onResizeEnd,
  onClose,
  onOpenEvent,
  onMarkAllRead,
  onClearAll
}: {
  open: boolean;
  width: number;
  events: AgentEvent[];
  snapshot: DeskSnapshot | null;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onClose: () => void;
  onOpenEvent: (event: AgentEvent) => void;
  onMarkAllRead: () => void;
  onClearAll: () => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const dragRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | undefined>(undefined);

  const finishResize = (): void => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = undefined;
    onResizeEnd(drag.currentWidth);
  };

  const sessionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const project of snapshot?.view.projects ?? []) {
      for (const group of project.groups) {
        for (const session of group.sessions) {
          labels.set(session.spec.tmuxSession, `${project.label} / ${session.spec.name}`);
        }
      }
    }
    return labels;
  }, [snapshot]);

  // Kind filter: 'all' | 'unread' | a specific event kind.
  const [filter, setFilter] = useState<'all' | 'unread' | AgentEvent['kind']>('all');
  const visibleEvents = useMemo(() => {
    if (filter === 'all') {
      return events;
    }
    if (filter === 'unread') {
      return events.filter((event) => !event.read);
    }
    return events.filter((event) => event.kind === filter);
  }, [events, filter]);
  const unreadCount = events.filter((event) => !event.read).length;
  const filterChips: Array<{ key: typeof filter; label: string; count: number }> = [
    { key: 'all', label: 'all', count: events.length },
    { key: 'unread', label: 'unread', count: unreadCount },
    { key: 'turn-complete', label: 'turns', count: events.filter((e) => e.kind === 'turn-complete').length },
    { key: 'approval-requested', label: 'approvals', count: events.filter((e) => e.kind === 'approval-requested').length },
    { key: 'input-requested', label: 'inputs', count: events.filter((e) => e.kind === 'input-requested').length },
    { key: 'channel', label: 'channels', count: events.filter((e) => e.kind === 'channel').length }
  ];

  return (
    // `root`: detached from the app animator tree — children of an entered parent
    // auto-enter, which would force the drawer visible regardless of `active`.
    <Animator root active={open} manager="stagger" duration={{ enter: 0.35, exit: 0.2, stagger: 0.02, limit: 10 }} unmountOnExited>
      <Animated className="notifDrawer" style={{ width }} animated={['fade', ['x', 40, 0]]}>
        <div
          className="notifResizeHandle"
          onPointerDown={(event) => {
            event.preventDefault();
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
            dragRef.current = { startX: event.clientX, startWidth: width, currentWidth: width };
          }}
          onPointerMove={(event) => {
            if (!dragRef.current) {
              return;
            }
            const next = dragRef.current.startWidth + (dragRef.current.startX - event.clientX);
            const nextWidth = Math.min(560, Math.max(260, Math.round(next)));
            dragRef.current.currentWidth = nextWidth;
            onResize(nextWidth);
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
        />
        <div className="notifHeader">
          <div className="railTitle">
            <Bell size={13} />
            <TextReveal as="span" manager="decipher">Events</TextReveal>
            <small>{unreadCount} unread</small>
          </div>
          <div className="railActions">
            <IconButton icon={<CheckCheck size={12} />} label="Mark all read" onClick={onMarkAllRead} />
            <IconButton icon={<Trash2 size={12} />} label="Clear all events" onClick={onClearAll} />
            <IconButton icon={<X size={12} />} label="Close events" onClick={onClose} />
          </div>
        </div>
        <div className="notifFilters">
          {filterChips
            .filter((chip) => chip.key === 'all' || chip.count > 0)
            .map((chip) => (
              <button
                key={chip.key}
                type="button"
                className={`notifFilterChip ${filter === chip.key ? 'active' : ''}`}
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={() => {
                  bleeps.click?.play();
                  setFilter((current) => (current === chip.key ? 'all' : chip.key));
                }}
              >
                {chip.label}
                <small>{chip.count}</small>
              </button>
            ))}
        </div>
        <div className="notifList">
          {visibleEvents.length === 0 ? (
            <div className="notifEmpty">
              <TextReveal as="span" manager="sequence">
                {events.length === 0 ? 'No agent events yet.' : 'Nothing matches this filter.'}
              </TextReveal>
            </div>
          ) : (
            visibleEvents.map((event) => {
              const meta = EVENT_KIND_META[event.kind];
              return (
                <Animator key={event.id}>
                  <Animated
                    as="button"
                    className={`notifCard ${meta.tone} ${event.read ? 'read' : 'unread'}`}
                    style={{ clipPath: CLIP_OCTAGON_TINY }}
                    animated={['flicker', ['x', 14, 0]]}
                    onMouseEnter={() => bleeps.hover?.play()}
                    onClick={() => {
                      bleeps.click?.play();
                      onOpenEvent(event);
                    }}
                    title={event.tmuxSession}
                  >
                    <span className="notifCardTop">
                      {/* Always mounted: an unmounting lamp shifted every sibling 14px on read. */}
                      <span className="notifCardLamp" aria-label={event.read ? undefined : 'unread'} aria-hidden={event.read} />
                      <i className="notifCardKind">{meta.label}</i>
                      <small title={new Date(event.at).toLocaleString()}>{shortTimeAgo(event.at)}</small>
                    </span>
                    <strong>{sessionLabels.get(event.tmuxSession) ?? event.tmuxSession}</strong>
                    {event.message ? <span className="notifCardMessage">{event.message}</span> : null}
                  </Animated>
                </Animator>
              );
            })
          )}
        </div>
      </Animated>
    </Animator>
  );
}

const NotificationDrawer = memo(NotificationDrawerImpl);

function AttentionAnnouncer({ attention }: { attention: Record<string, { attention: true; since: string }> }): null {
  const bleeps = useBleeps<DeskBleepName>();
  const knownRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set(Object.keys(attention));
    let hasNew = false;
    for (const key of next) {
      if (!knownRef.current.has(key)) {
        hasNew = true;
      }
    }
    knownRef.current = next;
    if (hasNew) {
      bleeps.attention?.play();
    }
  }, [attention, bleeps]);
  return null;
}

/** Stable empty maps so keep-alive mounts without assignments memo cleanly. */
const EMPTY_CELL_MAP: Record<string, number> = {};
const EMPTY_ACTIVE_MAP: Record<string, string> = {};

interface MuxHandlers {
  onTouchSession: (tmuxSession: string) => void;
  onAddCell: (group: DeskGroupView) => void;
  onRemoveCell: (group: DeskGroupView, cell: PanelCell) => void;
  onSelectSession: (group: DeskGroupView, cell: PanelCell, session: DeskSessionView) => void;
  onDropSession: (group: DeskGroupView, cell: PanelCell) => void;
  onAssignSession: (group: DeskGroupView, cell: PanelCell, session: DeskSessionView) => void;
  onBootSession: (session: DeskSessionView) => void;
  onChangeLayout: (group: DeskGroupView, kind: LayoutKind) => void;
  onPersistLayoutSizes: (group: DeskGroupView, sizes: { rows?: number[]; cols?: number[][] }) => void;
  onTerminalSelectionMenu: (text: string, x: number, y: number) => void;
  onCreateNoteFromText: (text: string) => void;
}

/**
 * One keep-alive multiplexer mount. Hidden mounts keep their terminals,
 * sockets and shared PTY subscriptions alive; TerminalSurface's 0-size guard
 * stops hidden fits/resizes and yields WebGL contexts to visible cells.
 */
interface MountedMuxProps {
  group: DeskGroupView;
  visible: boolean;
  assignments: Record<string, number>;
  activeByCell: Record<string, string>;
  selectedTmux?: string;
  attention: Record<string, { attention: true; since: string }>;
  busy: boolean;
  onDragSession: (tmuxSession: string | null) => void;
  terminalRevisions: Record<string, number>;
  handlers: MuxHandlers;
}

// Keep-alive can hold many groups mounted-hidden. Those hidden groups have
// nothing on screen, so they must NOT re-render when global volatile props
// churn — selection (selectedTmux), the 2s attention pulse, busy, or terminal
// revisions. Without this, every selection change and every pulse tick
// re-rendered ALL warm groups, not just the visible one. A hidden-staying-hidden
// group re-renders only when its OWN structure changes (group identity / cell
// assignments / active session map). The visible group and any visibility
// transition fall through to a normal shallow compare, so they still update.
function mountedMuxPropsEqual(prev: MountedMuxProps, next: MountedMuxProps): boolean {
  if (!prev.visible && !next.visible) {
    return (
      prev.group === next.group &&
      prev.assignments === next.assignments &&
      prev.activeByCell === next.activeByCell &&
      prev.onDragSession === next.onDragSession &&
      prev.handlers === next.handlers
    );
  }
  return (
    prev.group === next.group &&
    prev.visible === next.visible &&
    prev.assignments === next.assignments &&
    prev.activeByCell === next.activeByCell &&
    prev.selectedTmux === next.selectedTmux &&
    prev.attention === next.attention &&
    prev.busy === next.busy &&
    prev.onDragSession === next.onDragSession &&
    prev.terminalRevisions === next.terminalRevisions &&
    prev.handlers === next.handlers
  );
}

const MountedMux = memo(function MountedMuxImpl({
  group,
  visible,
  assignments,
  activeByCell,
  selectedTmux,
  attention,
  busy,
  onDragSession,
  terminalRevisions,
  handlers
}: MountedMuxProps): JSX.Element {
  const cells = useMemo(
    () => buildPanelCells(group, assignments, activeByCell, selectedTmux),
    [activeByCell, assignments, group, selectedTmux]
  );
  return (
    <div className="muxMount" style={{ display: visible ? 'flex' : 'none' }} aria-hidden={!visible}>
      <Animator combine manager="stagger" duration={{ stagger: 0.04, limit: 8 }}>
        <AgentMultiplexer
          group={group}
          visible={visible}
          cells={cells}
          selectedTmux={selectedTmux}
          attention={attention}
          busy={busy}
          onDragSession={onDragSession}
          terminalRevisions={terminalRevisions}
          {...handlers}
        />
      </Animator>
    </div>
  );
}, mountedMuxPropsEqual);

/** Recently selected sessions ring — palette ranking, newest first. */
const AGENT_RECENTS_KEY = 'desk.agentRecents';

function readAgentRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(AGENT_RECENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function recordAgentRecent(tmuxSession: string): void {
  const next = [tmuxSession, ...readAgentRecents().filter((value) => value !== tmuxSession)].slice(0, 12);
  localStorage.setItem(AGENT_RECENTS_KEY, JSON.stringify(next));
}

interface AgentPaletteEntry {
  session: DeskSessionView;
  group: DeskGroupView;
  project: DeskProjectView;
}

/**
 * Agents quick-switcher (Ctrl+K): fuzzy list of every session with state dot
 * and project/group context. Empty query ranks attention first, then the
 * recents ring, then tree order — the session screaming for input is one
 * Enter away.
 */
function AgentsPalette({
  projects,
  attention,
  onClose,
  onPick
}: {
  projects: DeskProjectView[];
  attention: Record<string, { attention: true; since: string }>;
  onClose: () => void;
  onPick: (tmuxSession: string) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Terminals re-grab focus aggressively; assert twice like the editor palette.
    const focus = (): void => inputRef.current?.focus();
    requestAnimationFrame(focus);
    const timer = window.setTimeout(focus, 160);
    return () => window.clearTimeout(timer);
  }, []);
  const results = useMemo(() => {
    const all: AgentPaletteEntry[] = projects.flatMap((project) =>
      project.groups.flatMap((group) => group.sessions.map((session) => ({ session, group, project })))
    );
    const text = query.trim().toLowerCase();
    if (text === '') {
      const recents = readAgentRecents();
      const recentRank = (tmuxSession: string): number => {
        const at = recents.indexOf(tmuxSession);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      };
      return [...all]
        .sort((a, b) => {
          const aAttn = attention[a.session.spec.tmuxSession] ? 0 : 1;
          const bAttn = attention[b.session.spec.tmuxSession] ? 0 : 1;
          if (aAttn !== bAttn) {
            return aAttn - bAttn;
          }
          return recentRank(a.session.spec.tmuxSession) - recentRank(b.session.spec.tmuxSession);
        })
        .slice(0, 40);
    }
    const score = (entry: AgentPaletteEntry): number => {
      const name = entry.session.spec.name.toLowerCase();
      const haystacks = [
        name,
        entry.group.label.toLowerCase(),
        entry.project.label.toLowerCase(),
        entry.session.spec.tmuxSession.toLowerCase()
      ];
      for (let field = 0; field < haystacks.length; field += 1) {
        const at = haystacks[field].indexOf(text);
        if (at !== -1) {
          return field * 1000 + at;
        }
      }
      return -1;
    };
    return all
      .map((entry) => ({ entry, rank: score(entry) }))
      .filter((scored) => scored.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((scored) => scored.entry)
      .slice(0, 40);
  }, [attention, projects, query]);
  const boundedIndex = Math.min(index, Math.max(0, results.length - 1));
  return (
    <Modal title="Switch session" icon={<TerminalSquare size={13} />} onClose={onClose}>
      <div className="quickOpen">
        <input
          ref={inputRef}
          className="treeInlineInput quickOpenInput"
          autoFocus
          placeholder="session, group or project… (↑↓ to move, Enter to jump)"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              const target = results[boundedIndex];
              if (target) {
                onPick(target.session.spec.tmuxSession);
              }
            }
          }}
        />
        <div className="quickOpenResults">
          {results.length === 0 ? (
            <span className="fileHistoryEmpty">No matching sessions.</span>
          ) : (
            results.map((entry, rowIndex) => (
              <button
                key={entry.session.spec.tmuxSession}
                type="button"
                className={`quickOpenRow ${rowIndex === boundedIndex ? 'selected' : ''}`}
                title={entry.session.spec.tmuxSession}
                onMouseEnter={() => setIndex(rowIndex)}
                onClick={() => {
                  bleeps.click?.play();
                  onPick(entry.session.spec.tmuxSession);
                }}
              >
                <StatusDot
                  state={entry.session.state}
                  attention={Boolean(attention[entry.session.spec.tmuxSession])}
                />
                <span className="quickOpenName">{entry.session.spec.name}</span>
                <small className="quickOpenDir">{entry.project.label} / {entry.group.label}</small>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

function EmptySubsystem(): JSX.Element {
  return (
    <Animator>
      <div className="emptyWorkspace">
        <TextReveal as="span" manager="sequence">No agent groups configured. Add a project to begin.</TextReveal>
      </div>
    </Animator>
  );
}

function ProjectFormView({
  form,
  busy,
  onSubmit,
  onFormChange
}: {
  form: ProjectForm;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFormChange: (form: ProjectForm) => void;
}): JSX.Element {
  return (
    <form className="thinForm modalForm" onSubmit={onSubmit}>
      <TextInput label="Project id" value={form.projectId} placeholder="workspace" onChange={(projectId) => onFormChange({ ...form, projectId })} />
      <TextInput label="Label" value={form.projectLabel} placeholder="Workspace" onChange={(projectLabel) => onFormChange({ ...form, projectLabel })} />
      <TextInput label="CWD" value={form.cwd} placeholder="~/projects/workspace" onChange={(cwd) => onFormChange({ ...form, cwd })} />
      <CommandButton icon={<Plus size={12} />} label="Store project" disabled={busy} submit />
    </form>
  );
}

function GroupFormView({
  form,
  busy,
  onSubmit,
  onFormChange
}: {
  form: GroupForm;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFormChange: (form: GroupForm) => void;
}): JSX.Element {
  return (
    <form className="thinForm modalForm" onSubmit={onSubmit}>
      <TextInput label="Project id" value={form.projectId} placeholder="project" onChange={(projectId) => onFormChange({ ...form, projectId })} />
      <TextInput label="Group id" value={form.groupId} placeholder="main" onChange={(groupId) => onFormChange({ ...form, groupId })} />
      <TextInput label="Label" value={form.groupLabel} placeholder="Main" onChange={(groupLabel) => onFormChange({ ...form, groupLabel })} />
      <label>
        <span>Layout</span>
        <DeskSelect
          value={form.layoutKind}
          options={[
            { value: '1x1', label: '1x1' },
            { value: '2x2', label: '2x2' },
            { value: '3x3', label: '3x3' },
            { value: '4x4', label: '4x4' },
            { value: 'linear', label: 'Linear (1×N)' },
            { value: 'custom', label: 'Custom' }
          ]}
          onChange={(layoutKind) => onFormChange({ ...form, layoutKind: layoutKind as LayoutKind })}
        />
      </label>
      {form.layoutKind === 'custom' || form.layoutKind === 'linear' ? (
        <label>
          <span>Cells</span>
          <input
            type="number"
            min={1}
            max={16}
            value={form.customCells}
            onChange={(event) => onFormChange({ ...form, customCells: Number(event.target.value) })}
          />
        </label>
      ) : null}
      <CommandButton icon={<Plus size={12} />} label="Store group" disabled={busy} submit />
    </form>
  );
}

function SessionFormView({
  form,
  projects,
  busy,
  onSubmit,
  onFormChange
}: {
  form: SessionForm;
  projects: DeskProjectView[];
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFormChange: (form: SessionForm) => void;
}): JSX.Element {
  const selectedProject = projects.find((project) => project.id === form.projectId) ?? projects[0];
  const groups = selectedProject?.groups ?? [];
  return (
    <form className="thinForm modalForm" onSubmit={onSubmit}>
      <label>
        <span>Project</span>
        <DeskSelect
          value={form.projectId}
          placeholder="Select project"
          options={projects.map((project) => ({ value: project.id, label: project.label }))}
          onChange={(projectId) => {
            const project = projects.find((candidate) => candidate.id === projectId);
            const group = project?.groups[0];
            onFormChange({ ...form, projectId, groupId: group?.groupId ?? '', cwd: project?.cwd ?? '' });
          }}
        />
      </label>
      <label>
        <span>Group</span>
        <DeskSelect
          value={form.groupId}
          placeholder="Select group"
          options={groups.map((group) => ({ value: group.groupId, label: group.label }))}
          onChange={(groupId) => onFormChange({ ...form, groupId })}
        />
      </label>
      <TextInput label="Session" value={form.name} placeholder="agent" onChange={(name) => onFormChange({ ...form, name })} />
      <TextInput label="CWD" value={form.cwd} placeholder={selectedProject?.cwd ?? 'project cwd'} onChange={(cwd) => onFormChange({ ...form, cwd })} />
      <label>
        <span>Agent</span>
        <DeskSelect
          value={form.agent}
          options={SESSION_AGENT_OPTIONS}
          onChange={(agent) =>
            onFormChange({
              ...form,
              agent,
              bypassPermissions: supportsBypassPermissions(agent) ? form.bypassPermissions : false,
              uiMode: supportsNativeUi(agent, form.command.trim() !== '') ? form.uiMode : 'terminal'
            })
          }
        />
      </label>
      {supportsNativeUi(form.agent, form.command.trim() !== '') ? (
        <label>
          <span>UI mode</span>
          <DeskSelect
            value={form.uiMode}
            options={[
              { value: 'terminal', label: 'terminal' },
              { value: 'native', label: 'native' }
            ]}
            onChange={(uiMode) => onFormChange({ ...form, uiMode: uiMode === 'native' ? 'native' : 'terminal' })}
          />
        </label>
      ) : null}
      {supportsNativeUi(form.agent, form.command.trim() !== '') ? (
        <TextInput
          label="Model"
          value={form.model}
          placeholder="provider default"
          onChange={(model) => onFormChange({ ...form, model })}
        />
      ) : null}
      {supportsBypassPermissions(form.agent) ? (
        <label className="checkLine">
          <input
            type="checkbox"
            checked={form.bypassPermissions}
            onChange={(event) => onFormChange({ ...form, bypassPermissions: event.target.checked })}
          />
          <span>Bypass permissions</span>
        </label>
      ) : null}
      <TextInput label="Resume id" value={form.resume} placeholder="codex resume id" onChange={(resume) => onFormChange({ ...form, resume })} />
      <TextInput
        label="Command"
        value={form.command}
        placeholder="optional explicit command"
        onChange={(command) =>
          onFormChange({
            ...form,
            command,
            uiMode: supportsNativeUi(form.agent, command.trim() !== '') ? form.uiMode : 'terminal'
          })
        }
      />
      <CommandButton icon={<Plus size={12} />} label="Store session" disabled={busy} submit />
    </form>
  );
}

function TextInput({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ProjectInfo({ project }: { project?: DeskProjectView }): JSX.Element {
  return (
    <dl className="thinDetails modalDetails">
      <dt>Name</dt>
      <dd>{project?.label ?? '-'}</dd>
      <dt>CWD</dt>
      <dd>{project?.cwd ?? '-'}</dd>
      <dt>Groups</dt>
      <dd>{project?.groups.length ?? 0}</dd>
    </dl>
  );
}

function GroupInfo({ group }: { group?: DeskGroupView }): JSX.Element {
  return (
    <dl className="thinDetails modalDetails">
      <dt>Name</dt>
      <dd>{group?.label ?? '-'}</dd>
      <dt>Project</dt>
      <dd>{group?.projectLabel ?? '-'}</dd>
      <dt>Layout</dt>
      <dd>{group ? `${group.layout.kind} / ${group.layout.cellCount}` : '-'}</dd>
      <dt>Sessions</dt>
      <dd>{group?.sessions.length ?? 0}</dd>
    </dl>
  );
}

function SessionInfo({ session }: { session?: DeskSessionView }): JSX.Element {
  return (
    <dl className="thinDetails modalDetails">
      <dt>Name</dt>
      <dd>{session?.spec.name ?? '-'}</dd>
      <dt>State</dt>
      <dd>{session?.state ?? '-'}</dd>
      <dt>CWD</dt>
      <dd>{session?.spec.cwd ?? '-'}</dd>
      <dt>TMUX</dt>
      <dd>{session?.spec.tmuxSession ?? '-'}</dd>
      <dt>Command</dt>
      <dd>{session?.spec.command ?? '-'}</dd>
    </dl>
  );
}

function ConfirmAction({
  label,
  detail,
  busy,
  onConfirm,
  confirmLabel,
  confirmIcon
}: {
  label: string;
  detail: string;
  busy: boolean;
  onConfirm: () => void;
  /** Confirm-button branding; defaults keep the historical destructive styling. */
  confirmLabel?: string;
  confirmIcon?: ReactNode;
}): JSX.Element {
  return (
    <div className="thinForm modalForm">
      <div className="confirmCopy">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <CommandButton
        icon={confirmIcon ?? <Trash2 size={12} />}
        label={confirmLabel ?? 'Confirm delete'}
        disabled={busy}
        onClick={onConfirm}
      />
    </div>
  );
}

function SubsystemButton({
  icon,
  label,
  active,
  compact,
  badge,
  onClick,
  onDoubleClick
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  compact?: boolean;
  /** unread indicator count (hidden when 0/undefined) */
  badge?: number;
  onClick: () => void;
  onDoubleClick?: () => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  return (
    <Animator>
      <Animated
        as="button"
        className={`subsystemButton ${active ? 'selected' : ''} ${compact ? 'compact' : ''}`}
        animated={['flicker', ['x', -8, 0]]}
        type="button"
        aria-label={label}
        title={onDoubleClick ? `${label} - double click to toggle sidebar` : label}
        onMouseEnter={() => bleeps.hover?.play()}
        onClick={() => {
          // Chirp only on a real subsystem switch — double-clicking the active
          // icon to toggle the sidebar should sound like one slide, not stacked clicks.
          if (!active) {
            bleeps.click?.play();
          }
          onClick();
        }}
        onDoubleClick={() => {
          bleeps.slide?.play();
          onDoubleClick?.();
        }}
      >
        <span className="subsystemButtonBar" aria-hidden="true" />
        <span className="subsystemButtonIcon">{icon}</span>
        {badge && badge > 0 ? <span className="subsystemButtonBadge">{badge > 99 ? '99+' : badge}</span> : null}
      </Animated>
    </Animator>
  );
}

function buildPanelCells(
  group: DeskGroupView,
  assignments: Record<string, number>,
  activeByCell: Record<string, string>,
  selectedTmux?: string
): PanelCell[] {
  const cells = Array.from({ length: group.layout.cellCount }, (_, index) => ({
    id: `${group.id}:cell-${index + 1}`,
    label: String(index + 1),
    index,
    sessions: [] as DeskSessionView[],
    activeSession: undefined as DeskSessionView | undefined
  }));

  for (const [index, session] of group.sessions.entries()) {
    const assignedIndex = clamp(assignments[session.spec.tmuxSession] ?? index % cells.length, 0, cells.length - 1);
    cells[assignedIndex]!.sessions.push(session);
  }

  for (const cell of cells) {
    cell.activeSession =
      cell.sessions.find((session) => session.spec.tmuxSession === selectedTmux) ??
      cell.sessions.find((session) => session.spec.tmuxSession === activeByCell[cell.id]) ??
      cell.sessions[0];
  }

  return cells;
}

function buildLayoutPayload(form: GroupForm): { kind: LayoutKind; cells?: number } {
  return {
    kind: form.layoutKind,
    cells:
      form.layoutKind === 'custom' || form.layoutKind === 'linear'
        ? clamp(Math.trunc(form.customCells), 1, 16)
        : undefined
  };
}

function modalTitle(mode: Exclude<ModalMode, null>): string {
  return mode
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (value) => value.toUpperCase());
}

function readJsonStorage<T extends object>(key: string): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
