import { AGENT_IDS, isAgentId, type AgentId, type AgentProfileProviderId } from '../shared/agentRegistry.js';

export type DeskAgent = AgentId | string;

/** The agents desk knows how to launch. `DeskAgent` widens to `string` for
 *  forward-compat at the type level, so this is the runtime source of truth —
 *  used by manifest validation and the CLI add-boundary so a typo can't be
 *  written to the config (which would brick every later command on load). */
export const SUPPORTED_AGENTS = AGENT_IDS;

export function isSupportedAgent(value: string | undefined): boolean {
  return isAgentId(value);
}

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
}

export interface DeskManifest {
  settings?: DeskSettings;
  /** Agent profiles: isolated provider credential directories, one per account. */
  profiles?: AgentProfile[];
  groups: DeskGroup[];
  projects?: DeskProject[];
}

/** Providers that support an isolated credential directory today. */
export type ProfileProvider = AgentProfileProviderId;

/**
 * One named provider account. `id` is immutable and keys the credential
 * directory; `label` is operator-facing and may change freely. Desk stores no
 * credentials — only this pointer; the provider CLI writes its own files.
 */
export interface AgentProfile {
  id: string;
  provider: ProfileProvider;
  label: string;
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
  /** Durable session identity (§10), globally unique per user. */
  sessionId: string;
  order?: number;
  uiMode?: DeskSessionUiMode;
  /** Runtime model override (provider/model string, driver-interpreted). NOT part of session identity. */
  model?: string;
  /**
   * Optional agent profile (isolated provider credential directory). Absent =
   * the ambient account, exactly as before profiles existed.
   */
  profileId?: string;
}

/** Create/edit payload. The config boundary allocates or preserves sessionId. */
export type DeskSessionDraft = Omit<DeskSession, 'sessionId'> & { sessionId?: string };

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
  /** Durable lifecycle identity and moor socket key (§10). */
  sessionId: string;
  /** Selected agent profile, or absent for the ambient account. */
  profileId?: string;
  command: string;
  uiMode: DeskSessionUiMode;
  model?: string;
}

export interface AgentMcpLaunchConfig {
  envFilePath: string;
  claudeConfigPath?: string;
}

export interface BuildSessionOptions {
  homeDir: string;
  agentMcp?: (session: DeskSession, cwd: string) => AgentMcpLaunchConfig | undefined;
}

/**
 * `skip` is the honest third outcome: the authority could not be reached, so
 * the session's liveness is unknown and neither starting nor preserving it can
 * be justified (moor#8 criterion 1 — ambiguity stays ambiguous).
 */
export type SessionPlanActionType = 'start' | 'preserve' | 'skip';

export interface SessionPlanAction {
  type: SessionPlanActionType;
  session: SessionSpec;
}
