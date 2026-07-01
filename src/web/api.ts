import type { DeskSnapshot, SystemSnapshot } from './types.js';
import type { DeskLspUiSettings } from '../core/lspSettings.js';

interface LayoutPayload {
  kind: string;
  cells?: number;
}

interface SessionPayload {
  name: string;
  cwd?: string;
  agent?: string;
  resume?: string;
  bypassPermissions?: boolean;
  command?: string;
}

export async function fetchDeskSnapshot(): Promise<DeskSnapshot> {
  return readJson(fetch('/api/desk'));
}

export async function fetchSystemSnapshot(): Promise<SystemSnapshot> {
  return readJson(fetch('/api/system'));
}

export type AgentEventKind = 'turn-complete' | 'approval-requested' | 'input-requested' | 'bell' | 'channel';

export interface AgentEvent {
  id: string;
  tmuxSession: string;
  kind: AgentEventKind;
  message?: string;
  at: string;
  read: boolean;
  /** channel events: navigation anchor */
  channel?: string;
  messageId?: string;
  thread?: string;
}

export interface AttentionSnapshot {
  sessions: Record<string, { attention: true; since: string }>;
  events: AgentEvent[];
  unread: number;
}

export interface DeskPulse {
  system: SystemSnapshot;
  attention: AttentionSnapshot;
  /** every live tmux session name — patches run-states without a snapshot fetch */
  running: string[];
}

/** One merged request per poll tick: system metrics + attention + liveness. */
export async function fetchPulse(): Promise<DeskPulse> {
  return readJson(fetch('/api/pulse'));
}

export async function fetchAttention(): Promise<AttentionSnapshot> {
  return readJson(fetch('/api/attention'));
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

export async function clearAllEvents(): Promise<void> {
  await readJson(
    fetch('/api/attention-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true })
    })
  );
}

export async function markEventsRead(payload: { ids?: string[]; all?: boolean }): Promise<void> {
  await readJson(
    fetch('/api/attention-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function clearAttention(session: string): Promise<void> {
  await readJson(
    fetch('/api/attention-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session })
    })
  );
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
  return readJson(
    fetch('/api/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function addGroup(payload: { groupId: string; groupLabel?: string }): Promise<DeskSnapshot> {
  return readJson(
    fetch('/api/add-group', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function addProject(payload: { projectId: string; projectLabel?: string; cwd: string }): Promise<DeskSnapshot> {
  return readJson(
    fetch('/api/add-project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function addProjectGroup(payload: {
  projectId: string;
  groupId: string;
  groupLabel?: string;
  layout?: LayoutPayload;
}): Promise<DeskSnapshot> {
  return readJson(
    fetch('/api/add-project-group', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function addProjectSession(payload: {
  projectId: string;
  groupId: string;
  session: SessionPayload;
}): Promise<DeskSnapshot> {
  return readJson(
    fetch('/api/add-project-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
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
  tmuxSession?: string;
}): Promise<DeskSnapshot> {
  return postSnapshot('/api/delete-project-session', payload);
}

export async function restartProjectSession(payload: { tmuxSession: string }): Promise<DeskSnapshot> {
  return postSnapshot('/api/restart-project-session', payload);
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

export async function resizeTerminal(payload: { session: string; cols: number; rows: number }): Promise<void> {
  await readJson(
    fetch('/api/terminal-resize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

/** Server-side stabilize: tmux repaints the window at its true size (deduped per session). */
export async function repaintTerminal(payload: { session: string }): Promise<void> {
  await readJson(
    fetch('/api/terminal-repaint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function scrollTerminal(payload: { session: string; lines: number; exitCopyMode?: boolean }): Promise<void> {
  await readJson(
    fetch('/api/terminal-scroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export async function captureTerminal(payload: { session: string; rows: number; offset: number }): Promise<{ lines: string[] }> {
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

async function readJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload && payload.error
        ? payload.error
        : `request failed ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
