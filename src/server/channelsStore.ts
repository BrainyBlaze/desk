import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import {
  formatChannelPreamble,
  formatMemberManifest,
  formatMessageBlock,
  formatThreadPreamble,
  generateMessageId,
  isValidChannelName,
  messageTimestamp,
  parseConversation,
  parseMemberManifest,
  type ChannelMember,
  type ChannelMessage
} from './channelsProtocol.js';
import { writeFileAtomic, writeFileAtomicCreate } from './fsOps.js';

/**
 * Channels store — the filesystem side of the messaging protocol.
 *
 * Layout (protocol-compatible with the `channels` workspace convention):
 *   ~/.config/desk/channels/<channel>/root.md
 *   ~/.config/desk/channels/<channel>/thread-<msg-id>.md
 *   ~/.config/desk/channels/<channel>/_members/<name>.md
 *   ~/.config/desk/channels/<channel>/_files/<uploads>
 *
 * Writes from this process are serialised per channel (promise chain), so no
 * file lock is needed for desk's own appends. External writers (agents using
 * the protocol CLI directly) are picked up by the watcher's seen-set scan.
 */

export function resolveChannelsHome(homeDir = homedir()): string {
  return join(homeDir, '.config', 'desk', 'channels');
}

export function ensureChannelsHome(home = resolveChannelsHome()): string {
  mkdirSync(home, { recursive: true });
  sweepOrphanTemps(home);
  return home;
}

/**
 * Pattern for hidden temp files/dirs created by the atomic-write helpers
 * (writeFileAtomic + writeFileAtomicCreate in fsOps, createChannel's temp dir,
 * saveChannelFile's per-upload temp). A hard crash between temp creation and
 * the rename/link claim leaves these behind; they are hidden (dot-prefixed),
 * invisible to listChannels, but consume disk. ensureChannelsHome sweeps the
 * top-level dir on every boot; per-channel _files sweeps run via
 * sweepChannelOrphanTemps when the channel is first listed.
 */
const ORPHAN_TEMP_PATTERN = /^\.+[^/]+\.desk-tmp-/;

/**
 * Removes leftover `.<name>.desk-tmp-*` entries from a prior crashed write.
 * Safe to run any time — only matches the desk-tmp pattern, never real entries.
 */
export function sweepOrphanTemps(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!ORPHAN_TEMP_PATTERN.test(entry)) {
      continue;
    }
    try {
      rmSync(join(dir, entry), { recursive: true, force: true });
    } catch {
      // best-effort — another process may be mid-write to this temp; leave it
    }
  }
}

/** Per-channel sweep: clears orphan temps from `<channel>/_files/`. */
export function sweepChannelOrphanTemps(home: string, channel: string): void {
  sweepOrphanTemps(join(channelDir(home, channel), '_files'));
}

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
  /** absolute index of the first loaded message (0 when the full channel loaded) */
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
  /** absolute index of the first sliced message in the full conversation —
   *  lets the client compute an absolute read-count from a windowed position */
  startIndex: number;
}

export interface ChannelSearchOptions {
  query: string;
  channel?: string;
  author?: string;
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

/**
 * Selects which slice of a channel to load. `before`/`after` page from a cursor
 * message id; otherwise the initial window anchors on the first message after
 * `since` (the reader's seen pointer) — or the newest `limit` when caught up.
 */
export interface MessageSliceOpts {
  since?: string | null;
  before?: string;
  after?: string;
  around?: string;
  limit: number;
  /** messages of read context to include above the first unread (initial load) */
  contextAbove?: number;
}

/**
 * Pure windowing over an oldest→newest message list. Message-id cursors are used
 * (not indices) so edits/deletes elsewhere can't shift a page. An unknown cursor
 * degrades to a safe newest-window / empty-page rather than throwing.
 */
export function sliceMessages(all: ChannelMessage[], opts: MessageSliceOpts): MessageWindow {
  const total = all.length;
  const limit = Math.max(1, opts.limit);

  if (opts.before !== undefined) {
    const index = all.findIndex((message) => message.id === opts.before);
    if (index <= 0) {
      return { messages: [], hasOlder: false, hasNewer: true, total, startIndex: 0 };
    }
    const start = Math.max(0, index - limit);
    return { messages: all.slice(start, index), hasOlder: start > 0, hasNewer: true, total, startIndex: start };
  }

  if (opts.after !== undefined) {
    const index = all.findIndex((message) => message.id === opts.after);
    if (index === -1 || index >= total - 1) {
      return { messages: [], hasOlder: true, hasNewer: false, total, startIndex: total };
    }
    const end = Math.min(total, index + 1 + limit);
    return { messages: all.slice(index + 1, end), hasOlder: true, hasNewer: end < total, total, startIndex: index + 1 };
  }

  if (opts.around !== undefined) {
    const index = all.findIndex((message) => message.id === opts.around);
    if (index === -1) {
      return { messages: [], hasOlder: false, hasNewer: false, total, startIndex: 0 };
    }
    const before = Math.floor((limit - 1) / 2);
    const end = Math.min(total, index + (limit - before));
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasOlder: start > 0, hasNewer: end < total, total, startIndex: start };
  }

  // Initial window: anchor on the first unread (after `since`), else the newest.
  let start = Math.max(0, total - limit);
  if (opts.since) {
    const seenIndex = all.findIndex((message) => message.id === opts.since);
    if (seenIndex !== -1 && seenIndex < total - 1) {
      const firstUnread = seenIndex + 1;
      start = Math.max(0, firstUnread - (opts.contextAbove ?? 0));
    }
  }
  const end = Math.min(total, start + limit);
  return { messages: all.slice(start, end), hasOlder: start > 0, hasNewer: end < total, total, startIndex: start };
}

const CONVERSATION_FILE = /^(root|thread-msg-[A-Za-z0-9-]+)\.md$/;
/** Hard cap on a single message body — protocol files must stay readable. */
export const MAX_MESSAGE_BYTES = 16 * 1024;

function requireBody(body: string | undefined): string {
  if (!body || body.trim().length === 0) {
    throw new Error('message body cannot be empty');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error(`message body exceeds ${MAX_MESSAGE_BYTES / 1024} KiB — upload a file and link it instead`);
  }
  return body;
}

function channelDir(home: string, channel: string): string {
  if (!isValidChannelName(channel)) {
    throw new Error(`invalid channel name: ${channel}`);
  }
  return join(home, channel);
}

export function channelGoal(preamble: string): string {
  for (const line of preamble.split('\n')) {
    if (line.startsWith('> ')) {
      return line.slice(2).trim();
    }
  }
  return '';
}

export function listChannelMembers(home: string, channel: string): ChannelMember[] {
  const membersDir = join(channelDir(home, channel), '_members');
  if (!existsSync(membersDir)) {
    return [];
  }
  const members: ChannelMember[] = [];
  for (const entry of readdirSync(membersDir)) {
    if (!entry.endsWith('.md')) {
      continue;
    }
    try {
      const parsed = parseMemberManifest(readFileSync(join(membersDir, entry), 'utf8'));
      if (parsed) {
        members.push(parsed);
      }
    } catch {
      // unreadable manifest — skip
    }
  }
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Channel-summary cache keyed by root.md + _members mtimes. The UI polls the
 * state endpoint every few seconds per client; without this, every poll
 * re-parses every conversation in full.
 */
const summaryCache = new Map<string, { rootMtimeMs: number; membersMtimeMs: number; summary: ChannelSummary }>();

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

export function listChannels(home = resolveChannelsHome()): ChannelSummary[] {
  if (!existsSync(home)) {
    return [];
  }
  const summaries: ChannelSummary[] = [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) {
      continue;
    }
    const rootFile = join(home, entry.name, 'root.md');
    if (!existsSync(rootFile)) {
      continue;
    }
    const cacheKey = `${home}/${entry.name}`;
    const rootMtimeMs = mtimeOf(rootFile);
    // Dir mtime moves on member add/remove; manifests are never edited in place.
    const membersMtimeMs = mtimeOf(join(home, entry.name, '_members'));
    const cached = summaryCache.get(cacheKey);
    if (cached && cached.rootMtimeMs === rootMtimeMs && cached.membersMtimeMs === membersMtimeMs) {
      summaries.push(cached.summary);
      continue;
    }
    try {
      const { preamble, messages } = parseConversation(readFileSync(rootFile, 'utf8'));
      const last = messages[messages.length - 1];
      const summary: ChannelSummary = {
        name: entry.name,
        goal: channelGoal(preamble),
        members: listChannelMembers(home, entry.name),
        messageCount: messages.length,
        lastMessage: last
          ? {
              id: last.id,
              author: last.author,
              timestamp: last.timestamp,
              preview: last.body.replace(/\s+/g, ' ').slice(0, 120)
            }
          : undefined
      };
      summaryCache.set(cacheKey, { rootMtimeMs, membersMtimeMs, summary });
      summaries.push(summary);
    } catch {
      // unreadable channel — skip
    }
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export function createChannel(home: string, name: string, goal: string): void {
  if (!isValidChannelName(name)) {
    throw new Error('channel name must be lowercase alphanumeric with hyphens');
  }
  ensureChannelsHome(home);
  withHomeLockSync(home, () => {
    const dir = join(home, name);
    if (existsSync(dir)) {
      throw new Error(`channel '${name}' already exists`);
    }
    const tempDir = join(home, `.${name}.desk-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(join(tempDir, '_members'), { recursive: true });
      mkdirSync(join(tempDir, '_files'), { recursive: true });
      writeFileAtomic(join(tempDir, 'root.md'), formatChannelPreamble(name, goal));
      writeFileAtomic(
        join(tempDir, '_members', 'human.md'),
        formatMemberManifest({ name: 'human', type: 'human', joined: messageTimestamp() })
      );
      renameSync(tempDir, dir);
    } catch (err) {
      rmSync(tempDir, { recursive: true, force: true });
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' || (err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        throw new Error(`channel '${name}' already exists`);
      }
      throw err;
    }
  });
}

export function destroyChannel(home: string, name: string): void {
  // Serialize against createChannel (home lock) so a concurrent create+destroy
  // for the same name resolves deterministically — the caller of the LOSING
  // side sees a clean 'channel exists' / 'no-op' outcome rather than a
  // mid-rename/rmSync race that leaves inconsistent caller-side state.
  // The rmSync itself is atomic; the lock is for cross-caller consistency.
  withHomeLockSync(home, () => {
    rmSync(channelDir(home, name), { recursive: true, force: true });
  });
}

export function addMember(
  home: string,
  channel: string,
  member: { name: string; type: string; tmuxSession?: string; agentLabel?: string }
): ChannelMember {
  return withChannelLockSync(home, channel, () => addMemberUnlocked(home, channel, member));
}

export function addMemberWithUniqueHandle(
  home: string,
  channel: string,
  base: string,
  member: { type: string; tmuxSession?: string; agentLabel?: string }
): ChannelMember {
  return withChannelLockSync(home, channel, () => {
    const name = uniqueMemberHandleLocked(home, channel, base);
    return addMemberUnlocked(home, channel, { ...member, name });
  });
}

export function removeMember(home: string, channel: string, name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`invalid member name: ${name}`);
  }
  rmSync(join(channelDir(home, channel), '_members', `${name}.md`), { force: true });
}

export function updateMemberRole(
  home: string,
  channel: string,
  name: string,
  role?: string,
  functions?: string
): ChannelMember | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`invalid member name: ${name}`);
  }
  const members = listChannelMembers(home, channel);
  const member = members.find((m) => m.name === name);
  if (!member) {
    return undefined;
  }
  const manifestPath = join(channelDir(home, channel), '_members', `${name}.md`);
  const updated: ChannelMember = { ...member, role, functions };
  writeFileAtomic(
    manifestPath,
    formatMemberManifest({
      name: member.name,
      type: member.type,
      joined: member.joined,
      tmuxSession: member.tmuxSession,
      role,
      functions
    })
  );
  return updated;
}

function addMemberUnlocked(
  home: string,
  channel: string,
  member: { name: string; type: string; tmuxSession?: string; agentLabel?: string }
): ChannelMember {
  const membersDir = join(channelDir(home, channel), '_members');
  if (!existsSync(membersDir)) {
    throw new Error(`channel '${channel}' not found`);
  }
  const manifestPath = join(membersDir, `${member.name}.md`);
  if (existsSync(manifestPath)) {
    throw new Error(`@${member.name} is already a member of #${channel}`);
  }
  const joined = messageTimestamp();
  writeFileAtomic(
    manifestPath,
    formatMemberManifest({
      name: member.name,
      type: member.type,
      joined,
      tmuxSession: member.tmuxSession,
      agentLabel: member.agentLabel
    })
  );
  return { name: member.name, type: member.type, status: 'active', joined, tmuxSession: member.tmuxSession };
}

function uniqueMemberHandleLocked(home: string, channel: string, base: string): string {
  const taken = new Set(listChannelMembers(home, channel).map((member) => member.name));
  if (!taken.has(base)) {
    return base;
  }
  for (let counter = 2; counter < 100; counter += 1) {
    const candidate = `${base}-${counter}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`cannot derive a unique member handle from '${base}'`);
}

/**
 * Channel metadata + a window of messages. With no `opts` it returns every
 * message (used by the summary/onboarding paths); with `opts` it returns the
 * windowed slice plus boundary flags for lazy loading.
 */
export function readChannelDetail(home: string, channel: string, opts?: MessageSliceOpts): ChannelDetail {
  const dir = channelDir(home, channel);
  const rootFile = join(dir, 'root.md');
  if (!existsSync(rootFile)) {
    throw new Error(`channel '${channel}' not found`);
  }
  const { preamble, messages } = parseConversation(readFileSync(rootFile, 'utf8'));
  const window = opts
    ? sliceMessages(messages, opts)
    : { messages, hasOlder: false, hasNewer: false, total: messages.length, startIndex: 0 };
  return {
    name: channel,
    goal: channelGoal(preamble),
    members: listChannelMembers(home, channel),
    messages: window.messages,
    files: listChannelFiles(home, channel),
    hasOlder: window.hasOlder,
    hasNewer: window.hasNewer,
    total: window.total,
    startIndex: window.startIndex,
    firstMessageAt: messages[0]?.timestamp,
    lastMessageAt: messages[messages.length - 1]?.timestamp
  };
}

/**
 * Lightweight paging read: just the windowed messages (no members/files re-scan),
 * for scroll-up/scroll-down fetches against an already-open channel.
 */
export function readChannelMessages(home: string, channel: string, opts: MessageSliceOpts): MessageWindow {
  const rootFile = join(channelDir(home, channel), 'root.md');
  if (!existsSync(rootFile)) {
    throw new Error(`channel '${channel}' not found`);
  }
  return sliceMessages(parseConversation(readFileSync(rootFile, 'utf8')).messages, opts);
}

export function readThread(home: string, channel: string, parentId: string): ChannelMessage[] {
  const file = threadFilePath(home, channel, parentId);
  if (!existsSync(file)) {
    return [];
  }
  return parseConversation(readFileSync(file, 'utf8')).messages;
}

export function readChannelMessage(home: string, channel: string, messageId: string): ChannelMessage {
  if (!/^msg-[A-Za-z0-9-]+$/.test(messageId)) {
    throw new Error(`invalid message id: ${messageId}`);
  }
  const dir = channelDir(home, channel);
  const rootFile = join(dir, 'root.md');
  if (!existsSync(rootFile)) {
    throw new Error(`channel '${channel}' not found`);
  }
  const root = parseConversation(readFileSync(rootFile, 'utf8')).messages.find((message) => message.id === messageId);
  if (root) {
    return root;
  }
  for (const entry of readdirSync(dir).sort()) {
    if (!/^thread-msg-[A-Za-z0-9-]+\.md$/.test(entry)) {
      continue;
    }
    const found = parseConversation(readFileSync(join(dir, entry), 'utf8')).messages.find((message) => message.id === messageId);
    if (found) {
      return found;
    }
  }
  throw new Error(`message '${messageId}' not found in #${channel}`);
}

function threadParentFromConversationFile(file: string): string | undefined {
  const match = /^thread-(msg-[A-Za-z0-9-]+)\.md$/.exec(file);
  return match?.[1];
}

function messageSnippet(body: string, query: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return flat.slice(0, 180);
  }
  const index = flat.toLowerCase().indexOf(needle);
  if (index === -1) {
    return flat.slice(0, 180);
  }
  const start = Math.max(0, index - 60);
  return flat.slice(start, start + 180);
}

function mentionsHandle(body: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)@${escaped}(\\b|$)`).test(body);
}

function searchCandidateMatches(
  message: ChannelMessage,
  file: string,
  query: string,
  opts: Pick<ChannelSearchOptions, 'author' | 'mentions' | 'hasThread' | 'dateFrom' | 'dateTo'>
): boolean {
  if (opts.author && message.author !== opts.author) {
    return false;
  }
  if (opts.mentions && !mentionsHandle(message.body, opts.mentions)) {
    return false;
  }
  const hasThread = file !== 'root.md' || Boolean(message.threadFile) || (message.threadReplies ?? 0) > 0;
  if (opts.hasThread && !hasThread) {
    return false;
  }
  if (opts.dateFrom && message.timestamp < opts.dateFrom) {
    return false;
  }
  if (opts.dateTo && message.timestamp > opts.dateTo) {
    return false;
  }
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return `${message.id} ${message.author} ${message.body}`.toLowerCase().includes(needle);
}

export function searchChannelMessages(home: string, opts: ChannelSearchOptions): ChannelSearchResult[] {
  const query = opts.query ?? '';
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const channels = opts.channel ? [opts.channel] : listChannels(home).map((channel) => channel.name);
  const results: ChannelSearchResult[] = [];

  for (const channel of channels) {
    const dir = channelDir(home, channel);
    if (!existsSync(dir)) {
      continue;
    }
    for (const file of readdirSync(dir).filter((entry) => CONVERSATION_FILE.test(entry))) {
      const threadParent = threadParentFromConversationFile(file);
      let messages: ChannelMessage[];
      try {
        messages = parseConversation(readFileSync(join(dir, file), 'utf8')).messages;
      } catch {
        continue;
      }
      for (const message of messages) {
        if (!searchCandidateMatches(message, file, query, opts)) {
          continue;
        }
        results.push({
          channel,
          file,
          messageId: message.id,
          threadParent,
          author: message.author,
          timestamp: message.timestamp,
          snippet: messageSnippet(message.body, query)
        });
      }
    }
  }

  return results
    .sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) ||
        a.channel.localeCompare(b.channel) ||
        a.file.localeCompare(b.file) ||
        a.messageId.localeCompare(b.messageId)
    )
    .slice(0, limit);
}

function threadFilePath(home: string, channel: string, parentId: string): string {
  if (!/^msg-[A-Za-z0-9-]+$/.test(parentId)) {
    throw new Error(`invalid message id: ${parentId}`);
  }
  return join(channelDir(home, channel), `thread-${parentId}.md`);
}

export function listChannelFiles(home: string, channel: string): ChannelFileEntry[] {
  const dir = join(channelDir(home, channel), '_files');
  if (!existsSync(dir)) {
    return [];
  }
  // Lazy per-channel orphan-temp sweep: cheap (readdir + pattern filter), removes
  // any .desk-tmp-* files left by a crashed saveChannelFile since the last list.
  sweepOrphanTemps(dir);
  const files: ChannelFileEntry[] = [];
  for (const entry of readdirSync(dir)) {
    try {
      const info = statSync(join(dir, entry));
      if (info.isFile()) {
        files.push({ name: entry, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    } catch {
      // raced unlink — skip
    }
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function channelFilePath(home: string, channel: string, fileName: string): string {
  const clean = basename(fileName);
  if (clean !== fileName || clean.startsWith('.') || clean.length === 0) {
    throw new Error(`invalid file name: ${fileName}`);
  }
  return join(channelDir(home, channel), '_files', clean);
}

export function saveChannelFile(home: string, channel: string, fileName: string, bytes: Buffer): string {
  return withChannelLockSync(home, channel, () => {
    const dir = join(channelDir(home, channel), '_files');
    mkdirSync(dir, { recursive: true });
    const clean = basename(fileName).replace(/[^\w.@-]+/g, '_').replace(/^\.+/, '') || 'file';
    for (let counter = 0; counter < 1000; counter += 1) {
      const dot = clean.lastIndexOf('.');
      const target =
        counter === 0 ? clean : dot > 0 ? `${clean.slice(0, dot)}-${counter}${clean.slice(dot)}` : `${clean}-${counter}`;
      const result = writeFileAtomicCreate(join(dir, target), bytes);
      if (result.ok) {
        return target;
      }
    }
    throw new Error(
      `could not allocate a unique file name for ${fileName} after 1000 attempts; the channel lock serializes uploads so this is unreachable under normal load — check for orphaned same-name entries under _files/`
    );
  });
}

/** Rewrites the `> goal` line of the channel preamble. */
export function editChannelGoal(home: string, channel: string, goal: string): void {
  withChannelLockSync(home, channel, () => {
    const rootFile = join(channelDir(home, channel), 'root.md');
    if (!existsSync(rootFile)) {
      throw new Error(`channel '${channel}' not found`);
    }
    const lines = readFileSync(rootFile, 'utf8').split('\n');
    const clean = `> ${goal.replace(/\n/g, ' ').trim()}`;
    const goalIndex = lines.findIndex((line) => line.startsWith('> '));
    if (goalIndex !== -1) {
      lines[goalIndex] = clean;
    } else {
      // Channel created without a goal: insert after the title line.
      lines.splice(1, 0, '', clean);
    }
    writeFileAtomic(rootFile, lines.join('\n'));
  });
}

/** Per-channel append serialisation: appends from this process never interleave. */
const appendChains = new Map<string, Promise<unknown>>();

function serialized<T>(channel: string, action: () => T | Promise<T>): Promise<T> {
  const previous = appendChains.get(channel) ?? Promise.resolve();
  const next = previous.then(action, action);
  appendChains.set(channel, next.catch(() => undefined));
  return next;
}

/**
 * Cross-process advisory lock for channel write paths. The serialized() chain
 * above only orders writes from THIS process; external writers (the channels
 * CLI offline fallback, a second desk server) bypass it. Without a cross-
 * process lock, two callers race on the read-modify-write operations
 * (updateParentThreadLink, editMessage, deleteMessage, editChannelGoal) and
 * on the thread-file preamble create (`existsSync` then `writeFileSync`) —
 * losing data silently. The flock-style wrapper below acquires a per-channel
 * `.write.lock` file atomically via O_EXCL, recovers stale locks left by
 * dead holders, and releases on completion.
 */
const CHANNEL_LOCKFILE = '.write.lock';
const CHANNEL_LOCK_RETRY_MS = 25;
const CHANNEL_LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this is presumed stale even if its holder pid looks alive
 *  — defends against pid-reuse where the dead holder's pid was reassigned to
 *  an unrelated running process. */
const CHANNEL_LOCK_STALE_MS = 30_000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withChannelLock<T>(home: string, channel: string, action: () => T | Promise<T>): Promise<T> {
  const lockPath = join(channelDir(home, channel), CHANNEL_LOCKFILE);
  const start = Date.now();
  let fd: number | undefined;
  while (fd === undefined && Date.now() - start < CHANNEL_LOCK_TIMEOUT_MS) {
    try {
      fd = openSync(lockPath, 'wx'); // O_EXCL | O_CREAT | O_WRONLY | O_TRUNC — atomic acquire
      writeSync(fd, `${process.pid}\n`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // channel directory does not exist — surface as a friendly protocol error
        // (matches the existing "channel '...' not found" contract callers expect).
        throw new Error(`channel '${channel}' not found`);
      }
      if (code !== 'EEXIST') {
        throw err;
      }
      if (tryStealStaleLock(lockPath)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, CHANNEL_LOCK_RETRY_MS));
    }
  }
  if (fd === undefined) {
    throw new Error(`could not acquire channel lock ${lockPath} within ${CHANNEL_LOCK_TIMEOUT_MS}ms`);
  }
  try {
    return await action();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — a concurrent stale-recovery path unlinked it; that is fine
      // because we have already released via closeSync.
    }
  }
}

/**
 * Sync variant for callers that preserve a sync contract (editChannelGoal).
 * Same stale-recovery semantics as withChannelLock. Backs off via Atomics.wait
 * (blocks the worker thread for the backoff window only); the uncontended path
 * acquires in one openSync call with no wait.
 */
function withChannelLockSync<T>(home: string, channel: string, action: () => T): T {
  const lockPath = join(channelDir(home, channel), CHANNEL_LOCKFILE);
  return withLockPathSync(lockPath, `channel '${channel}' not found`, action);
}

function withHomeLockSync<T>(home: string, action: () => T): T {
  mkdirSync(home, { recursive: true });
  return withLockPathSync(join(home, CHANNEL_LOCKFILE), `channels home '${home}' not found`, action);
}

function withLockPathSync<T>(lockPath: string, notFoundMessage: string, action: () => T): T {
  const start = Date.now();
  while (Date.now() - start < CHANNEL_LOCK_TIMEOUT_MS) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(notFoundMessage);
      }
      if (code !== 'EEXIST') {
        throw err;
      }
      if (tryStealStaleLock(lockPath)) {
        continue;
      }
      syncBackoff(CHANNEL_LOCK_RETRY_MS);
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return action();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone (concurrent stale-recovery unlink); release-via-close is sufficient
      }
    }
  }
  throw new Error(`could not acquire channel lock ${lockPath} within ${CHANNEL_LOCK_TIMEOUT_MS}ms`);
}

/**
 * Removes an existing lock only when the exact lockfile snapshot we classified
 * as stale is still present. Without the second read, a contender can observe a
 * disappearing old lock and accidentally unlink a fresh holder's lock.
 */
function tryStealStaleLock(lockPath: string): boolean {
  let first: { content: string; mtimeMs: number };
  try {
    first = { content: readFileSync(lockPath, 'utf8'), mtimeMs: statSync(lockPath).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    return false;
  }
  const holderPid = Number(first.content.trim());
  const holderDead = Number.isInteger(holderPid) && holderPid > 0 && holderPid !== process.pid && !isPidAlive(holderPid);
  const staleByAge = Date.now() - first.mtimeMs > CHANNEL_LOCK_STALE_MS;
  if (!holderDead && !staleByAge) {
    return false;
  }
  try {
    const current = { content: readFileSync(lockPath, 'utf8'), mtimeMs: statSync(lockPath).mtimeMs };
    if (current.content !== first.content || current.mtimeMs !== first.mtimeMs) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/** Bounded synchronous backoff via Atomics.wait (blocks only the calling thread). */
function syncBackoff(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

export interface AppendMessageOptions {
  author: string;
  body: string;
  /** when set, the message goes to thread-<parentId>.md */
  threadParentId?: string;
}

export interface AppendedMessage {
  message: ChannelMessage;
  /** conversation file name the block landed in (root.md or thread-…) */
  file: string;
}

function appendBlockAtomic(filePath: string, block: string): void {
  const attempts = 25;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stats = statSync(filePath);
    const current = readFileSync(filePath, 'utf8');
    const result = writeFileAtomic(filePath, `${current}\n${block}`, stats.mtimeMs);
    if (result.ok) {
      return;
    }
    if (!result.conflict) {
      throw new Error(`failed to append ${filePath}`);
    }
    syncBackoff(Math.min(CHANNEL_LOCK_RETRY_MS, 5 + attempt));
  }
  throw new Error(`could not append ${filePath}: concurrent writers did not settle`);
}

export async function appendMessage(home: string, channel: string, options: AppendMessageOptions): Promise<AppendedMessage> {
  return serialized(channel, () =>
    withChannelLock(home, channel, () => {
      const dir = channelDir(home, channel);
      const rootFile = join(dir, 'root.md');
      if (!existsSync(rootFile)) {
        throw new Error(`channel '${channel}' not found`);
      }
      requireBody(options.body);

      const id = generateMessageId();
      const timestamp = messageTimestamp();
      const block = formatMessageBlock({ id, author: options.author, timestamp, body: options.body });

      let fileName = 'root.md';
      if (options.threadParentId) {
        const threadFile = threadFilePath(home, channel, options.threadParentId);
        fileName = basename(threadFile);
        if (!existsSync(threadFile)) {
          const root = parseConversation(readFileSync(rootFile, 'utf8'));
          const parent = root.messages.find((message) => message.id === options.threadParentId);
          if (!parent) {
            throw new Error(`message '${options.threadParentId}' not found in #${channel}`);
          }
          writeFileAtomic(threadFile, `${formatThreadPreamble(parent, channel)}\n${block}`);
        } else {
          appendBlockAtomic(threadFile, block);
        }
        updateParentThreadLink(home, channel, options.threadParentId);
      } else {
        appendBlockAtomic(rootFile, block);
      }

      const message: ChannelMessage = { id, author: options.author, timestamp, body: options.body.trim(), hasEndTurn: true };
      return { message, file: fileName };
    })
  );
}

/**
 * Inserts (or refreshes) the `**thread**: …` link line under the parent
 * message header in root.md so threads stay discoverable in the protocol.
 */
function updateParentThreadLink(home: string, channel: string, parentId: string): void {
  const rootFile = join(channelDir(home, channel), 'root.md');
  const threadName = `thread-${parentId}`;
  const threadFile = threadFilePath(home, channel, parentId);
  const replies = existsSync(threadFile) ? parseConversation(readFileSync(threadFile, 'utf8')).messages.length : 0;
  const linkLine = `**thread**: [${threadName}](${threadName}.md) (${replies} replies)`;

  const lines = readFileSync(rootFile, 'utf8').split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === `### ${parentId}`);
  if (headerIndex === -1 || headerIndex + 1 >= lines.length) {
    return;
  }
  const linkIndex = headerIndex + 2;
  if (lines[linkIndex]?.startsWith('**thread**:')) {
    lines[linkIndex] = linkLine;
  } else {
    lines.splice(linkIndex, 0, linkLine);
  }
  writeFileAtomic(rootFile, lines.join('\n'));
}

function conversationFilePath(home: string, channel: string, fileName: string): string {
  if (!CONVERSATION_FILE.test(fileName)) {
    throw new Error(`invalid conversation file: ${fileName}`);
  }
  return join(channelDir(home, channel), fileName);
}

/**
 * Re-renders a conversation file from parsed state (used by edit/delete).
 * The preamble is kept verbatim minus its trailing block separator so the
 * rebuild stays stable across repeated rewrites.
 */
function rebuildConversation(preamble: string, messages: ChannelMessage[]): string {
  const preambleLines = preamble.split('\n');
  while (preambleLines.length > 0) {
    const last = preambleLines[preambleLines.length - 1].trim();
    if (last === '' || last === '---') {
      preambleLines.pop();
    } else {
      break;
    }
  }
  const blocks = messages.map((message) => {
    const block = formatMessageBlock({
      id: message.id,
      author: message.author,
      timestamp: message.timestamp,
      body: message.body
    });
    if (!message.threadFile) {
      return block;
    }
    const lines = block.split('\n');
    const threadName = message.threadFile.replace(/\.md$/, '');
    lines.splice(4, 0, `**thread**: [${threadName}](${message.threadFile}) (${message.threadReplies ?? 0} replies)`);
    return lines.join('\n');
  });
  return `${preambleLines.join('\n')}\n\n${blocks.join('\n')}`;
}

/** Replaces a message body in place (same id/author/timestamp, re-finalised). */
export async function editMessage(
  home: string,
  channel: string,
  fileName: string,
  messageId: string,
  body: string
): Promise<ChannelMessage> {
  return serialized(channel, () =>
    withChannelLock(home, channel, () => {
      requireBody(body);
      const filePath = conversationFilePath(home, channel, fileName);
      if (!existsSync(filePath)) {
        throw new Error(`conversation '${fileName}' not found in #${channel}`);
      }
      const parsed = parseConversation(readFileSync(filePath, 'utf8'));
      const target = parsed.messages.find((message) => message.id === messageId);
      if (!target) {
        throw new Error(`message '${messageId}' not found in #${channel}/${fileName}`);
      }
      target.body = body.replace(/\r\n/g, '\n').trim();
      target.hasEndTurn = true;
      writeFileAtomic(filePath, rebuildConversation(parsed.preamble, parsed.messages));
      return target;
    })
  );
}

/**
 * Removes a message block. Deleting a root message also removes its thread
 * file; deleting a thread reply refreshes the parent's reply count.
 */
export async function deleteMessage(home: string, channel: string, fileName: string, messageId: string): Promise<void> {
  return serialized(channel, () =>
    withChannelLock(home, channel, () => {
      const filePath = conversationFilePath(home, channel, fileName);
      if (!existsSync(filePath)) {
        throw new Error(`conversation '${fileName}' not found in #${channel}`);
      }
      const parsed = parseConversation(readFileSync(filePath, 'utf8'));
      const target = parsed.messages.find((message) => message.id === messageId);
      if (!target) {
        throw new Error(`message '${messageId}' not found in #${channel}/${fileName}`);
      }
      const remaining = parsed.messages.filter((message) => message.id !== messageId);
      writeFileAtomic(filePath, rebuildConversation(parsed.preamble, remaining));
      if (fileName === 'root.md' && target.threadFile) {
        rmSync(join(channelDir(home, channel), basename(target.threadFile)), { force: true });
      }
      if (fileName.startsWith('thread-')) {
        updateParentThreadLink(home, channel, fileName.slice('thread-'.length, -'.md'.length));
      }
    })
  );
}

export interface IncomingChannelMessage {
  channel: string;
  file: string;
  message: ChannelMessage;
}

/**
 * Watches the channels home for finalised message blocks.
 *
 * A per-(channel/file) seen-set of message ids is pre-warmed at start so a
 * server restart never re-dispatches history; afterwards every change event
 * rescans the touched conversation file and reports unseen END_TURN blocks.
 * Desk's own appends are marked seen by the caller before the watcher fires,
 * so only external writes flow through here.
 */
export class ChannelsWatcher {
  private readonly seen = new Set<string>();
  private watcher: FSWatcher | undefined;
  private readonly pendingScans = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly home: string,
    private readonly onMessage: (incoming: IncomingChannelMessage) => void,
    private readonly sweepIntervalMs = 30_000
  ) {}

  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly sweepMtimes = new Map<string, number>();

  markSeen(channel: string, file: string, messageId: string): void {
    this.seen.add(`${channel}/${file}:${messageId}`);
  }

  hasSeen(channel: string, file: string, messageId: string): boolean {
    return this.seen.has(`${channel}/${file}:${messageId}`);
  }

  prewarm(): void {
    for (const summary of listChannels(this.home)) {
      const dir = join(this.home, summary.name);
      for (const entry of readdirSync(dir)) {
        if (!CONVERSATION_FILE.test(entry)) {
          continue;
        }
        try {
          const { messages } = parseConversation(readFileSync(join(dir, entry), 'utf8'));
          for (const message of messages) {
            this.markSeen(summary.name, entry, message.id);
          }
        } catch {
          // unreadable — it will rescan on the first change event
        }
      }
    }
  }

  start(): void {
    if (this.watcher) {
      return;
    }
    ensureChannelsHome(this.home);
    this.prewarm();
    // depth 1: home/<channel>/<file>. _members and _files changes are filtered
    // out by the conversation-file test below.
    this.watcher = watch(this.home, { depth: 1, ignoreInitial: true });
    this.watcher.on('error', () => undefined);
    this.watcher.on('all', (_event, eventPath) => {
      const fileName = basename(eventPath);
      if (!CONVERSATION_FILE.test(fileName)) {
        return;
      }
      const channel = basename(join(eventPath, '..'));
      if (channel.startsWith('_') || channel.startsWith('.')) {
        return;
      }
      this.scheduleScan(channel, fileName);
    });
    // Reconciliation sweep: inotify events are best-effort (WSL2 and network
    // filesystems drop them); a missed event would otherwise mean a message
    // that never dispatches. Cheap thanks to the per-file mtime guard.
    this.sweepTimer = setInterval(() => this.sweepNow(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Rescans every conversation file whose mtime moved since the last sweep. */
  sweepNow(): void {
    let channelNames: string[];
    try {
      channelNames = readdirSync(this.home, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      return;
    }
    for (const channel of channelNames) {
      let files: string[];
      try {
        files = readdirSync(join(this.home, channel)).filter((file) => CONVERSATION_FILE.test(file));
      } catch {
        continue;
      }
      for (const file of files) {
        const key = `${channel}/${file}`;
        const mtime = mtimeOf(join(this.home, channel, file));
        if (this.sweepMtimes.get(key) === mtime) {
          continue;
        }
        this.sweepMtimes.set(key, mtime);
        this.scanFile(channel, file);
      }
    }
  }

  /** Debounce per file: agents may land a block across several writes. */
  private scheduleScan(channel: string, fileName: string): void {
    const key = `${channel}/${fileName}`;
    const existing = this.pendingScans.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pendingScans.set(
      key,
      setTimeout(() => {
        this.pendingScans.delete(key);
        this.scanFile(channel, fileName);
      }, 150)
    );
  }

  scanFile(channel: string, fileName: string): void {
    const filePath = join(this.home, channel, fileName);
    if (!existsSync(filePath)) {
      return;
    }
    let messages: ChannelMessage[];
    try {
      messages = parseConversation(readFileSync(filePath, 'utf8')).messages;
    } catch {
      return;
    }
    for (const message of messages) {
      if (!message.hasEndTurn || this.hasSeen(channel, fileName, message.id)) {
        continue;
      }
      this.onMessage({ channel, file: fileName, message });
      this.markSeen(channel, fileName, message.id);
    }
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = undefined;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const timer of this.pendingScans.values()) {
      clearTimeout(timer);
    }
    this.pendingScans.clear();
  }
}
