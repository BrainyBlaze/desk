import type { DeskSnapshot, SystemSnapshot } from './types.js';
import type { DeskLspUiSettings } from '../core/lspSettings.js';
import type { AgentProfile, ProfileProvider } from '../core/types.js';
import type {
  DeskEventClearResponse,
  DeskEventFeedResponse,
  DeskEventReadRequest,
  DeskEventReadResponse,
  SessionStateSnapshot
} from '../shared/controlPlane/index.js';
import { readJson } from './httpJson.js';

interface LayoutPayload {
  kind: string;
  cells?: number;
}

interface SessionPayload {
  name: string;
  cwd?: string;
  agent?: string;
  profileId?: string;
  resume?: string;
  clearResume?: boolean;
  bypassPermissions?: boolean;
  command?: string;
  uiMode?: 'terminal' | 'native';
}

export async function fetchDeskSnapshot(): Promise<DeskSnapshot> {
  return readJson(fetch('/api/desk'));
}

export async function fetchSystemSnapshot(): Promise<SystemSnapshot> {
  return readJson(fetch('/api/system'));
}

export interface AgentProfilesResponse {
  profile?: AgentProfile;
  profiles: AgentProfile[];
  ok?: true;
}

export class AgentProfileApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly sessions?: string[]
  ) {
    super(message);
    this.name = 'AgentProfileApiError';
  }
}

function readAgentProfilesResponse(request: Promise<Response>): Promise<AgentProfilesResponse> {
  return readJson(request, ({ status, body }) => {
    const message = typeof body?.error === 'string' ? body.error : `request failed (${status})`;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    const sessions = Array.isArray(body?.sessions)
      ? body.sessions.filter((session): session is string => typeof session === 'string')
      : undefined;
    return new AgentProfileApiError(message, code, sessions);
  });
}

export async function fetchAgentProfiles(): Promise<AgentProfile[]> {
  const response = await readAgentProfilesResponse(fetch('/api/profiles'));
  return response.profiles;
}

export async function createAgentProfile(payload: {
  provider: ProfileProvider;
  label: string;
}): Promise<AgentProfilesResponse> {
  return readAgentProfilesResponse(
    fetch('/api/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function updateAgentProfile(payload: {
  id: string;
  label: string;
}): Promise<AgentProfilesResponse> {
  return readAgentProfilesResponse(
    fetch('/api/profiles/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function deleteAgentProfile(id: string): Promise<AgentProfilesResponse> {
  return readAgentProfilesResponse(
    fetch('/api/profiles/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id })
    })
  );
}

/**
 * The authority's canonical state for this read.
 *
 * `revision` is the authority-wide read revision; an individual snapshot's own
 * `revision` may be lower (that session simply has not changed since). Every
 * surface in the tab renders from ONE of these reads, which is what makes it
 * impossible for the sidebar and the channels footer to disagree.
 */
export interface AgentStatesPayload {
  revision: number;
  snapshots: SessionStateSnapshot[];
}

export interface DeskPulse {
  system: SystemSnapshot;
  /**
   * Absent when the authority is unreachable. A partial pulse is deliberate:
   * telemetry must keep flowing when state cannot be read, and an absent key
   * renders as `unknown` — which is true — instead of an invented empty state.
   */
  agentStates?: AgentStatesPayload;
  /** every live durable session ID — patches run-states without a snapshot fetch */
  running?: string[];
}

/** One merged request per poll tick: system metrics + canonical state + liveness. */
export async function fetchPulse(): Promise<DeskPulse> {
  return readJson(fetch('/api/pulse'));
}

export async function fetchAgentStates(): Promise<AgentStatesPayload> {
  return readJson(fetch('/api/agent-states'));
}

export type DeskAutosaveMode = 'off' | 'after-delay' | 'on-focus-change';

export interface DeskEditorUiSettings {
  root?: string;
  openFiles?: string[];
  /** null clears the persisted value (server deletes the key) */
  activeFile?: string | null;
  autosave?: DeskAutosaveMode;
  autosaveDelayMs?: number;
}

export interface DeskUiSettings {
  theme?: string;
  muted?: boolean;
  editor?: DeskEditorUiSettings;
  /** sidebar widths in px, keyed by subsystem (agents/editor/git/notes/…) */
  sidebars?: Record<string, number>;
}

/**
 * The /api/settings GET returns a redacted, client-safe `lsp` block. Keep it on this FETCH-ONLY
 * type so it is never part of the saveSettings(payload: DeskUiSettings) input.
 */
export type DeskFetchedUiSettings = DeskUiSettings & { lsp?: DeskLspUiSettings };

export async function fetchSettings(): Promise<DeskFetchedUiSettings> {
  return readJson(fetch('/api/settings'));
}

export async function saveSettings(payload: DeskUiSettings): Promise<void> {
  await readJson(
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

/**
 * Browser-safe LSP save patch. Persists ONLY the master enabled toggle plus the per-language
 * denylist (disabledLanguages). The active `languages` list is runtime-derived from active-root
 * detection (never auto-written), serverCommands/env/baseUrl/limits are server-only.
 */
export interface DeskLspSettingsSavePayload {
  enabled: boolean;
  /** Language ids the user has turned OFF. Omitted from the POST body when undefined. */
  disabledLanguages?: string[];
}

/**
 * Dedicated LSP save: POSTs only { lsp: { enabled, disabledLanguages? } } and RETURNS the
 * server-normalized, redacted settings so the caller drives runtime state from the single source
 * of truth. Kept separate from saveSettings (which stays void) so the LSP save path never widens
 * the generic settings payload type.
 */
export async function saveLspSettings(payload: DeskLspSettingsSavePayload): Promise<DeskFetchedUiSettings> {
  const lsp: { enabled: boolean; disabledLanguages?: string[] } = { enabled: payload.enabled };
  if (payload.disabledLanguages !== undefined) {
    lsp.disabledLanguages = payload.disabledLanguages;
  }
  return readJson(
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lsp })
    })
  );
}

/** Read-only active-root language detection result. Language ids only -- never paths/commands/env. */
export interface DeskDetectedLanguages {
  languages: string[];
  truncated: boolean;
}

/**
 * Fetch the languages auto-detected under the active editor root. The server validates/realpaths
 * the candidate root against the authoritative settings.editor.root; invalid roots throw.
 */
export async function fetchDetectedLanguages(
  root: string,
  options: { refresh?: boolean } = {}
): Promise<DeskDetectedLanguages> {
  const params = new URLSearchParams({ root });
  if (options.refresh) {
    params.set('refresh', '1');
  }
  return readJson(fetch(`/api/lsp/detected-languages?${params.toString()}`));
}

/**
 * The unified event feed. One journal carries both agent transitions and
 * channel notifications, so the drawer has a single ordering and a single
 * unread count instead of two feeds racing each other.
 *
 * Acknowledgement is journal-only: `read` and `clear` change what the operator
 * has looked at, never what an agent is doing and never a session lamp.
 */
export async function fetchEvents(limit = 200): Promise<DeskEventFeedResponse> {
  return readJson(fetch(`/api/events?limit=${limit}`));
}

export async function markEventsRead(payload: DeskEventReadRequest): Promise<DeskEventReadResponse> {
  return readJson(
    fetch('/api/events/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function clearAllEvents(): Promise<DeskEventClearResponse> {
  return readJson(fetch('/api/events', { method: 'DELETE' }));
}


export async function killAllAgents(): Promise<{ killedSessions: string[]; killedPids: number[]; errors: string[] }> {
  return readJson(
    fetch('/api/kill-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  );
}

export async function upDesk(dryRun: boolean): Promise<void> {
  await readJson(
    fetch('/api/up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun })
    })
  );
}

export async function addSession(payload: {
  groupId: string;
  groupLabel?: string;
  session: SessionPayload;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/add', payload);
}

export async function addGroup(payload: { groupId: string; groupLabel?: string }): Promise<DeskSnapshot> {
  return postSnapshot('/api/add-group', payload);
}

export async function addProject(payload: { projectId: string; projectLabel?: string; cwd: string }): Promise<DeskSnapshot> {
  return postSnapshot('/api/add-project', payload);
}

export async function addProjectGroup(payload: {
  projectId: string;
  groupId: string;
  groupLabel?: string;
  layout?: LayoutPayload;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/add-project-group', payload);
}

export async function addProjectSession(payload: {
  projectId: string;
  groupId: string;
  session: SessionPayload;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/add-project-session', payload);
}

export async function editProject(payload: {
  projectId: string;
  projectLabel?: string;
  cwd: string;
  currentCwd?: string;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/edit-project', payload);
}

export async function deleteProject(payload: { projectId: string; cwd?: string }): Promise<DeskSnapshot> {
  return postSnapshot('/api/delete-project', payload);
}

export async function editProjectGroup(payload: {
  projectId: string;
  currentGroupId?: string;
  groupId: string;
  groupLabel?: string;
  projectCwd?: string;
  layout?: LayoutPayload;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/edit-project-group', payload);
}

export async function deleteProjectGroup(payload: {
  projectId: string;
  groupId: string;
  projectCwd?: string;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/delete-project-group', payload);
}

export async function editProjectSession(payload: {
  projectId: string;
  groupId: string;
  currentName: string;
  projectCwd?: string;
  session: SessionPayload;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/edit-project-session', payload);
}

export async function deleteProjectSession(payload: {
  projectId: string;
  groupId: string;
  sessionName: string;
  projectCwd?: string;
  sessionId?: string;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/delete-project-session', payload);
}

export async function restartProjectSession(payload: { sessionId: string }): Promise<DeskSnapshot> {
  return postSnapshot('/api/restart-project-session', payload);
}

/** Error carrying the server's typed code (e.g. resume-not-captured, switch-in-progress). */
export class ApiCodeError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export async function setSessionUiMode(payload: {
  sessionId: string;
  uiMode: 'terminal' | 'native';
  confirmDiscard?: boolean;
}): Promise<DeskSnapshot> {
  return readJson<DeskSnapshot>(
    fetch('/api/set-session-ui-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
    ({ status, body }) => {
      const code = typeof body?.code === 'string' ? body.code : undefined;
      const error = typeof body?.error === 'string' ? body.error : undefined;
      return new ApiCodeError(error ?? `request failed (${status})`, code);
    }
  );
}

export async function moveProjectSession(payload: {
  sourceProjectId: string;
  sourceGroupId: string;
  sourceSessionName: string;
  sourceProjectCwd?: string;
  targetProjectId: string;
  targetGroupId: string;
  targetProjectCwd?: string;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/move-project-session', payload);
}

export async function reorderProjects(payload: { orderedProjectIds: string[] }): Promise<DeskSnapshot> {
  return postSnapshot('/api/reorder-projects', payload);
}

export async function reorderGroups(payload: { projectId: string; orderedGroupIds: string[] }): Promise<DeskSnapshot> {
  return postSnapshot('/api/reorder-groups', payload);
}

export async function reorderSessions(payload: {
  projectId: string;
  groupId: string;
  projectCwd?: string;
  orderedSessionNames: string[];
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/reorder-sessions', payload);
}

export async function saveGroupLayoutSizes(payload: {
  projectId: string;
  groupId: string;
  projectCwd?: string;
  sizes: { rows?: number[]; cols?: number[][] };
}): Promise<void> {
  await readJson(
    fetch('/api/group-layout-sizes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function captureTerminal(payload: {
  sessionId: string;
  rows: number;
  offset: number;
}): Promise<{ lines: string[]; totalAvailable?: number }> {
  return readJson(
    fetch('/api/terminal-capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

function postSnapshot(path: string, payload: unknown): Promise<DeskSnapshot> {
  return readJson(
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

// readJson now lives in ./httpJson.ts (text-first, ok-checked, error-mappable).
