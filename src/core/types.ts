export type DeskAgent = 'codex' | 'claude' | 'bash' | 'opencode' | string;

/** UI surface for a session's cell. Absent on the manifest record = 'terminal'. */
export type DeskSessionUiMode = 'terminal' | 'native';

export type DeskLayoutKind = '1x1' | '2x2' | '3x3' | '4x4' | 'custom' | 'linear';

/** Persisted resizable-panel split sizes for a group's mosaic (percentages). */
export interface DeskLayoutSizes {
  /** row heights, top to bottom */
  rows?: number[];
  /** per-row column widths, left to right */
  cols?: number[][];
}

export interface DeskGroupLayout {
  kind?: DeskLayoutKind;
  cells?: number;
  /** persisted drag-resized split sizes; ignored if its shape no longer matches the cell grid */
  sizes?: DeskLayoutSizes;
}

export type DeskAutosaveMode = 'off' | 'after-delay' | 'on-focus-change';

export interface DeskEditorSettings {
  root?: string;
  openFiles?: string[];
  activeFile?: string;
  autosave?: DeskAutosaveMode;
  autosaveDelayMs?: number;
}

export interface DeskNotesSettings {
  openFiles?: string[];
  activeFile?: string;
}

export interface DeskLspServerCommandSettings {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  languageIds?: string[];
  extensions?: string[];
  initializationOptions?: Record<string, unknown>;
}

export interface DeskLspSettings {
  enabled?: boolean;
  languages?: string[];
  /** User denylist of detected language ids to keep off. Subtracts from runtime-detected languages. */
  disabledLanguages?: string[];
  baseUrl?: string;
  maxSessions?: number;
  startupTimeoutMs?: number;
  serverCommands?: Record<string, DeskLspServerCommandSettings>;
  agents?: {
    enabled?: boolean;
  };
}

export interface DeskSettings {
  theme?: string;
  muted?: boolean;
  editor?: DeskEditorSettings;
  notes?: DeskNotesSettings;
  lsp?: DeskLspSettings;
  /** sidebar widths in px, keyed by subsystem (agents/editor/git/notes/…) */
  sidebars?: Record<string, number>;
  /** desk-owned tmux session options applied at launch */
  tmux?: {
    /** 'off' drops tmux's status line in desk-launched sessions (the cell tab already names the session). YAML parses a bare off as false — both forms count. */
    statusLine?: 'on' | 'off' | boolean;
  };
}

export interface DeskManifest {
  settings?: DeskSettings;
  groups: DeskGroup[];
  projects?: DeskProject[];
}

export interface DeskProject {
  id: string;
  label?: string;
  cwd: string;
  /** sidebar sort order; lower first. Absent items fall back to manifest array order. */
  order?: number;
  groups: DeskGroup[];
}

export interface DeskGroup {
  id: string;
  label?: string;
  order?: number;
  layout?: DeskGroupLayout;
  sessions: DeskSession[];
}

export interface DeskSession {
  name: string;
  cwd?: string;
  agent?: DeskAgent;
  resume?: string;
  bypassPermissions?: boolean;
  command?: string;
  tmuxSession?: string;
  order?: number;
  uiMode?: DeskSessionUiMode;
}

export interface SessionSpec {
  groupId: string;
  groupLabel: string;
  projectId?: string;
  projectLabel?: string;
  projectCwd?: string;
  projectOrder?: number;
  groupOrder?: number;
  order?: number;
  groupLayout?: DeskGroupLayout;
  name: string;
  cwd: string;
  agent?: DeskAgent;
  resume?: string;
  bypassPermissions?: boolean;
  customCommand?: boolean;
  tmuxSession: string;
  command: string;
  uiMode: DeskSessionUiMode;
}

export interface AgentMcpLaunchConfig {
  envFilePath: string;
  claudeConfigPath?: string;
}

export interface BuildSessionOptions {
  homeDir: string;
  namespace?: string;
  agentMcp?: (session: DeskSession, cwd: string) => AgentMcpLaunchConfig | undefined;
}

export type TmuxPlanActionType = 'start' | 'preserve';

export interface TmuxPlanAction {
  type: TmuxPlanActionType;
  session: SessionSpec;
  argv: string[];
  opencodeLaunchResumeId?: string;
}
