/** Client for /api/channels/* — the desk agent messaging subsystem. */

import type {
  ChannelMember,
  ChannelMessage,
  ChannelActivityEvent,
  LifecycleState,
  LifecycleStatus,
  PaneState,
  SubmitState,
  DeliveryBlockReason,
  QueuedItemMeta,
  BlockedItemMeta,
  SessionDiagnostic,
  SessionResumeInfo,
  ReactionKind,
  ViewFilter
} from '../../server/channelsProtocol.js';
import type { ReactionRef } from '../../server/channelsReactions.js';
import type { SavedView } from '../../server/channelsViews.js';
import type { DeliveryEvent, DeliveryEventKind } from '../../server/channelsEvents.js';

// Store-defined row types re-exported for the web subsystem (type-only — the
// server store modules are erased from the web bundle).
export type { ReactionRef, SavedView, DeliveryEvent, DeliveryEventKind };

// These contracts are DEFINED once in channelsProtocol.ts (the module the server
// engine also imports) and re-exported here, so the web subsystem keeps importing
// them from the client while a server-added union value tsc-forces the consumers
// (e.g. the EngineConsole label maps) to handle it. They used to be hand-mirrored
// in this file, which silently drifted from the server unions.
export type {
  ChannelMember,
  ChannelMessage,
  ChannelActivityEvent,
  LifecycleState,
  LifecycleStatus,
  PaneState,
  SubmitState,
  DeliveryBlockReason,
  QueuedItemMeta,
  BlockedItemMeta,
  SessionDiagnostic,
  SessionResumeInfo,
  ReactionKind,
  ViewFilter
};

export interface ChannelSummary {
  name: string;
  goal: string;
  members: ChannelMember[];
  messageCount: number;
  lastMessage?: { id: string; author: string; timestamp: string; preview: string };
}

export interface ChannelFileEntry {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface ChannelDetail {
  name: string;
  goal: string;
  members: ChannelMember[];
  messages: ChannelMessage[];
  files: ChannelFileEntry[];
  /** more messages exist before the first loaded one (scroll up to fetch) */
  hasOlder: boolean;
  /** more messages exist after the last loaded one (scroll down / jump-to-latest) */
  hasNewer: boolean;
  /** total messages in the channel, regardless of the loaded window */
  total: number;
  /** absolute index of the first loaded message (for absolute read-counts) */
  startIndex: number;
  /** protocol timestamp of the channel's first message (channel age) */
  firstMessageAt?: string;
  /** protocol timestamp of the channel's most recent message (last activity) */
  lastMessageAt?: string;
}

/** A contiguous slice of a channel's messages plus its boundary flags. */
export interface MessageWindow {
  messages: ChannelMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  total: number;
  startIndex: number;
}

export interface FeaturedMessageRef {
  channel: string;
  file: string;
  id: string;
  savedAt: string;
  note?: string;
  tag?: string;
}

export interface FeaturedMessageItem extends FeaturedMessageRef {
  threadParent?: string;
  author?: string;
  timestamp?: string;
  snippet?: string;
  missing: boolean;
}

export interface ChannelSearchOptions {
  query: string;
  channel?: string;
  author?: string;
  mentionsMe?: boolean;
  mentions?: string;
  hasThread?: boolean;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface ChannelSearchResult {
  channel: string;
  file: string;
  messageId: string;
  threadParent?: string;
  author: string;
  timestamp: string;
  snippet: string;
}

export interface ChannelsState {
  home: string;
  channels: ChannelSummary[];
  delivery: LifecycleState[];
  activity: ChannelActivityEvent[];
  activitySeq: number;
  /** another live desk process owns dispatch for this channels home */
  passive?: boolean;
  /** pid of the owning desk process (when passive) — for the recovery hint */
  passiveOwner?: number;
}

export async function channelsState(since = 0): Promise<ChannelsState> {
  return readJson(fetch(`/api/channels/state?since=${since}`));
}

export async function channelsDetail(name: string, since?: string | null): Promise<ChannelDetail> {
  const sinceArg = since ? `&since=${encodeURIComponent(since)}` : '';
  return readJson(fetch(`/api/channels/channel?name=${encodeURIComponent(name)}${sinceArg}`));
}

/** Pages the message window: older messages before a cursor, or newer after it. */
export async function channelsMessages(
  name: string,
  cursor: { before: string } | { after: string } | { around: string }
): Promise<MessageWindow> {
  const key = 'before' in cursor ? 'before' : 'after' in cursor ? 'after' : 'around';
  const id = 'before' in cursor ? cursor.before : 'after' in cursor ? cursor.after : cursor.around;
  return readJson(fetch(`/api/channels/messages?name=${encodeURIComponent(name)}&${key}=${encodeURIComponent(id)}`));
}

/** Loads the entire channel (used when the filter box is active — search must
 *  see every message, not just the loaded window). */
export async function channelsAllMessages(name: string): Promise<MessageWindow> {
  return readJson(fetch(`/api/channels/messages?name=${encodeURIComponent(name)}&all=1`));
}

export async function channelsSearch(options: ChannelSearchOptions): Promise<{ items: ChannelSearchResult[] }> {
  const params = new URLSearchParams();
  params.set('q', options.query);
  if (options.channel) {
    params.set('channel', options.channel);
  }
  if (options.author) {
    params.set('author', options.author);
  }
  if (options.mentionsMe) {
    params.set('mentionsMe', '1');
  }
  if (options.mentions) {
    params.set('mentions', options.mentions);
  }
  if (options.hasThread) {
    params.set('hasThread', '1');
  }
  if (options.dateFrom) {
    params.set('dateFrom', options.dateFrom);
  }
  if (options.dateTo) {
    params.set('dateTo', options.dateTo);
  }
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  return readJson(fetch(`/api/channels/search?${params.toString()}`));
}

export async function channelsThread(name: string, parent: string): Promise<{ messages: ChannelMessage[] }> {
  return readJson(fetch(`/api/channels/thread?name=${encodeURIComponent(name)}&parent=${encodeURIComponent(parent)}`));
}

export async function channelsFeatured(): Promise<{ items: FeaturedMessageItem[] }> {
  return readJson(fetch('/api/channels/featured'));
}

export async function channelsFeaturedAdd(payload: {
  channel: string;
  file: string;
  id: string;
  note?: string;
  tag?: string;
}): Promise<{ items: FeaturedMessageItem[] }> {
  return post('/api/channels/featured', { action: 'add', ...payload });
}

export async function channelsFeaturedRemove(payload: {
  channel: string;
  file: string;
  id: string;
}): Promise<{ items: FeaturedMessageItem[] }> {
  return post('/api/channels/featured', { action: 'remove', ...payload });
}

export async function channelsReactions(): Promise<{ items: ReactionRef[] }> {
  return readJson(fetch('/api/channels/reactions'));
}

export async function channelsReactionAdd(payload: {
  channel: string;
  file: string;
  id: string;
  kind: ReactionKind;
  author?: string;
}): Promise<{ items: ReactionRef[] }> {
  return post('/api/channels/reactions', { action: 'add', ...payload });
}

export async function channelsReactionRemove(payload: {
  channel: string;
  file: string;
  id: string;
  kind: ReactionKind;
}): Promise<{ items: ReactionRef[] }> {
  return post('/api/channels/reactions', { action: 'remove', ...payload });
}

export async function channelsViews(): Promise<{ items: SavedView[] }> {
  return readJson(fetch('/api/channels/views'));
}

export async function channelsViewAdd(payload: { name: string; filter: ViewFilter }): Promise<{ items: SavedView[] }> {
  return post('/api/channels/views', { action: 'add', ...payload });
}

export async function channelsViewRemove(payload: { name: string }): Promise<{ items: SavedView[] }> {
  return post('/api/channels/views', { action: 'remove', ...payload });
}

export async function channelsEvents(
  filter: { channel?: string; tmuxSession?: string; kind?: DeliveryEventKind; sinceSeq?: number; limit?: number } = {}
): Promise<{ items: DeliveryEvent[]; latestSeq: number }> {
  const params = new URLSearchParams();
  if (filter.channel) {
    params.set('channel', filter.channel);
  }
  if (filter.tmuxSession) {
    params.set('tmuxSession', filter.tmuxSession);
  }
  if (filter.kind) {
    params.set('kind', filter.kind);
  }
  if (filter.sinceSeq !== undefined) {
    params.set('sinceSeq', String(filter.sinceSeq));
  }
  if (filter.limit !== undefined) {
    params.set('limit', String(filter.limit));
  }
  const query = params.toString();
  return readJson(fetch(`/api/channels/events${query ? `?${query}` : ''}`));
}

/** the GET URL that streams a channel (or thread) as a downloadable markdown transcript. */
export function channelsExportUrl(channel: string, thread?: string): string {
  const params = new URLSearchParams({ channel });
  if (thread) {
    params.set('thread', thread);
  }
  return `/api/channels/export?${params.toString()}`;
}

export async function channelsCreate(name: string, goal: string): Promise<void> {
  await post('/api/channels/create', { name, goal });
}

export async function channelsDestroy(name: string): Promise<void> {
  await post('/api/channels/destroy', { name });
}

export async function channelsEdit(name: string, goal: string): Promise<void> {
  await post('/api/channels/edit', { name, goal });
}

export async function channelsMessageEdit(payload: { channel: string; id: string; body: string; thread?: string }): Promise<void> {
  await post('/api/channels/message-edit', payload);
}

export async function channelsMessageDelete(payload: { channel: string; id: string; thread?: string }): Promise<void> {
  await post('/api/channels/message-delete', payload);
}

export async function channelsMemberAdd(channel: string, tmuxSession: string): Promise<{ member: ChannelMember }> {
  return post('/api/channels/member-add', { channel, tmuxSession });
}

export async function channelsMemberRemove(channel: string, name: string): Promise<void> {
  await post('/api/channels/member-remove', { channel, name });
}

export async function channelsMemberRole(channel: string, member: string, role?: string, functions?: string): Promise<void> {
  await post('/api/channels/member-role', { channel, member, role, functions });
}

export async function channelsMemberRoleClear(channel: string, member: string): Promise<void> {
  await post('/api/channels/member-role', { channel, member, role: undefined, functions: undefined });
}

export async function channelsQueueClear(tmuxSession: string): Promise<void> {
  await post('/api/channels/queue-clear', { tmuxSession });
}

export async function channelsPost(payload: {
  channel: string;
  body: string;
  thread?: string;
}): Promise<{ id: string; file: string }> {
  return post('/api/channels/post', payload);
}

export async function channelsShare(payload: {
  fromChannel: string;
  messageId: string;
  toChannel: string;
  thread?: string;
  comment?: string;
}): Promise<{ id: string }> {
  return post('/api/channels/share', payload);
}

// --- Engine ops console -----------------------------------------------------

export interface EngineDiagnostics {
  home: string;
  passive: boolean;
  pumpAlive: boolean;
  totalQueued: number;
  sessions: SessionDiagnostic[];
  activity: ChannelActivityEvent[];
}

export type EngineActionName =
  | 'mark-idle'
  | 'pause-session'
  | 'resume-session'
  | 'drop-queue'
  | 'drop-message'
  | 'force-deliver'
  | 'drain-ready-all'
  | 'rebuild-engine';

export async function channelsEngineDiagnostics(): Promise<EngineDiagnostics> {
  return readJson(fetch('/api/channels/engine'));
}

export async function channelsEngineAction(
  action: EngineActionName,
  opts: { tmuxSession?: string; seq?: number; reason?: string } = {}
): Promise<{ ok: boolean; sessions: SessionDiagnostic[] }> {
  return post('/api/channels/engine/action', { action, ...opts });
}

export async function channelsUpload(channel: string, name: string, dataBase64: string): Promise<{ file: string; markdown: string }> {
  return post('/api/channels/upload', { channel, name, dataBase64 });
}

export function channelFileUrl(channel: string, name: string): string {
  return `/api/channels/file?channel=${encodeURIComponent(channel)}&name=${encodeURIComponent(name)}`;
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  return readJson(
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  );
}

async function readJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload && payload.error
        ? String(payload.error)
        : `request failed ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
