import type {
  ChannelActivityEvent,
  ChannelMessage,
  ChannelSearchOptions,
  FeaturedMessageRef,
  LifecycleState,
  ReactionKind,
  ReactionRef,
  ViewFilter
} from './channelsClient.js';

/** Pure view-model helpers for the channels subsystem (unit-tested). */

/**
 * Diff key for a session's delivery-lifecycle row in the /state poll. It MUST
 * cover EVERY LifecycleState field the main UI surfaces, so a lifecycle-only
 * transition (e.g. idle -> blocked / submit-stuck with unchanged
 * busy/queued/awaitingApproval) changes the signature and is NOT skipped by the
 * refresh diff-and-bail — otherwise lifecycle's lifecycle truth would render stale.
 */
export function lifecycleStateSignature(entry: LifecycleState): string {
  return [
    entry.tmuxSession,
    entry.status,
    entry.busy ? 1 : 0,
    entry.queued,
    entry.awaitingApproval ? 1 : 0,
    entry.submitState ?? '',
    entry.pausedByOperator ? 1 : 0,
    entry.pauseReason ?? '',
    entry.pausedAt ?? '',
    entry.deliveryBlocked ? 1 : 0,
    entry.blockedReason ?? '',
    entry.blockedItemCount,
    entry.droppedQueueItems,
    entry.lastDeliveryAt ?? '',
    entry.lastReleaseAt ?? ''
  ].join(':');
}

/**
 * Subsequence fuzzy match (case-insensitive) for the command palette: every
 * character of `query` must appear in `text` in order. An empty/blank query
 * matches everything. Pure + unit-tested so the palette filter has no buried,
 * untested matching logic.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1;
    }
  }
  return qi === q.length;
}

export interface InboxItem {
  id: string;
  kind: 'submit-stuck' | 'blocked' | 'awaiting-approval' | 'paused' | 'dropped' | 'needs-reply' | 'mention';
  tmuxSession?: string;
  channel?: string;
  messageId?: string;
  label: string;
  detail?: string;
}

/**
 * operator inbox aggregator (pure, unit-tested). Surfaces needs-attention
 * items from the cheap /state sources only: delivery-lifecycle (submit-stuck /
 * blocked / awaiting-approval / dropped, from lifecycleStates) + @human mentions
 * (from the activity feed). No probe, no new fetch — the caller passes data it
 * already polls. threads-needing-reply: an @human mention is escalated to
 * 'needs-reply' when no @human message follows it in that channel (derived from
 * the same activity feed — a later human 'message' event means it was answered).
 */
export function buildInboxItems(delivery: LifecycleState[], activity: ChannelActivityEvent[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const entry of delivery) {
    if (entry.status === 'submit-stuck') {
      items.push({
        id: `stuck:${entry.tmuxSession}`,
        kind: 'submit-stuck',
        tmuxSession: entry.tmuxSession,
        label: `${entry.tmuxSession}: delivery stuck`,
        detail: entry.blockedItemCount > 0 ? `${entry.blockedItemCount} stuck item(s)` : undefined
      });
    } else if (entry.status === 'blocked') {
      items.push({
        id: `blocked:${entry.tmuxSession}`,
        kind: 'blocked',
        tmuxSession: entry.tmuxSession,
        label: `${entry.tmuxSession}: blocked`,
        detail: entry.blockedReason
      });
    } else if (entry.status === 'awaiting-approval') {
      items.push({
        id: `approval:${entry.tmuxSession}`,
        kind: 'awaiting-approval',
        tmuxSession: entry.tmuxSession,
        label: `${entry.tmuxSession}: awaiting approval / input`
      });
    } else if (entry.status === 'paused') {
      items.push({
        id: `paused:${entry.tmuxSession}`,
        kind: 'paused',
        tmuxSession: entry.tmuxSession,
        label: `${entry.tmuxSession}: delivery paused`,
        detail: entry.pauseReason
      });
    }
    if (entry.droppedQueueItems > 0) {
      items.push({
        id: `dropped:${entry.tmuxSession}`,
        kind: 'dropped',
        tmuxSession: entry.tmuxSession,
        label: `${entry.tmuxSession}: ${entry.droppedQueueItems} dropped`,
        detail: 'queue overflow shed oldest'
      });
    }
  }
  // a mention is answered once @human posts a later message in that channel.
  // Track @human's latest message seq per channel to escalate the unanswered ones.
  const lastHumanSeq = new Map<string, number>();
  for (const event of activity) {
    if (event.kind === 'message' && event.author === 'human') {
      lastHumanSeq.set(event.channel, Math.max(lastHumanSeq.get(event.channel) ?? 0, event.seq));
    }
  }
  for (const event of activity) {
    if (event.kind === 'human-mention') {
      const answered = (lastHumanSeq.get(event.channel) ?? 0) > event.seq;
      items.push({
        id: `${answered ? 'mention' : 'needs-reply'}:${event.channel}:${event.messageId}`,
        kind: answered ? 'mention' : 'needs-reply',
        channel: event.channel,
        messageId: event.messageId,
        label: answered ? `@human mentioned in #${event.channel}` : `reply needed in #${event.channel}`,
        detail: event.preview
      });
    }
  }
  return items;
}

/**
 * featured-membership test. Identity is channel+file+id (NOT bare id): a
 * message id is only unique within a file, so a root message and a thread reply
 * can share an id — matching all three keeps the star from targeting the wrong
 * message. Drives the row star's filled/empty state and add-vs-remove.
 */
export function isFeatured(items: FeaturedMessageRef[], channel: string, file: string, id: string): boolean {
  return items.some((item) => item.channel === channel && item.file === file && item.id === id);
}

/** Newest-first ordering for the Featured view (by savedAt, lexicographic on the
 *  ISO timestamp). Pure + copy — does not mutate the input. */
export function sortFeatured<T extends { savedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

/**
 * the reaction kinds present on a specific message. Identity is channel+file+id
 * (the same rule as isFeatured), so a root message and a same-id thread reply never
 * share reactions. The store coalesces per kind, so each kind appears at most once.
 */
export function reactionsForMessage(items: ReactionRef[], channel: string, file: string, id: string): ReactionKind[] {
  return items
    .filter((item) => item.channel === channel && item.file === file && item.id === id)
    .map((item) => item.kind);
}

/**
 * saved-views matcher: does a message pass a ViewFilter? Every clause is AND-ed
 * and grounded in a real ChannelMessage field (text over body+author, exact author,
 * mentions-me via messageTargets, hasThread via threadFile) — an empty filter
 * matches everything. Pure + tested so saved views and the feed share one rule.
 */
export function messageMatchesFilter(
  message: { body: string; author: string; threadFile?: string },
  filter: ViewFilter,
  viewerHandle: string
): boolean {
  if (filter.text && filter.text.trim() !== '') {
    const needle = filter.text.trim().toLowerCase();
    if (!message.body.toLowerCase().includes(needle) && !message.author.toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (filter.author && filter.author.trim() !== '' && message.author.toLowerCase() !== filter.author.trim().toLowerCase()) {
    return false;
  }
  if (filter.mentionsMe && !messageTargets(message.body, viewerHandle)) {
    return false;
  }
  if (filter.hasThread && !message.threadFile) {
    return false;
  }
  return true;
}

export interface DigestEntry {
  channel: string;
  unread: number;
}

/**
 * while-away digest: per-channel unread counts for a returning operator.
 * unread = messageCount - the absolute count last read (seenCounts, from the
 * seenMap), floored at 0; channels with nothing new are dropped; most-unread
 * first. Pure + tested — the digest view renders this plus the activity-derived
 * needs-reply items it self-fetches.
 */
export function buildAwayDigest(
  channels: { name: string; messageCount: number }[],
  seenCounts: Record<string, number>
): DigestEntry[] {
  return channels
    .map((channel) => ({ channel: channel.name, unread: Math.max(0, channel.messageCount - (seenCounts[channel.name] ?? 0)) }))
    .filter((entry) => entry.unread > 0)
    .sort((a, b) => b.unread - a.unread);
}

export interface SearchForm {
  query: string;
  channel?: string;
  author?: string;
  mentionsMe?: boolean;
  hasThread?: boolean;
}

/**
 * search-form -> ChannelSearchOptions for the cross-channel /api/channels/search
 * call. Pure + tested: trims query/author, omits empty filters (so the server
 * does not receive blank params), and only sets the boolean filters when true.
 */
export function toSearchOptions(form: SearchForm): ChannelSearchOptions {
  const options: ChannelSearchOptions = { query: form.query.trim() };
  if (form.channel) {
    options.channel = form.channel;
  }
  if (form.author && form.author.trim() !== '') {
    options.author = form.author.trim();
  }
  if (form.mentionsMe) {
    options.mentionsMe = true;
  }
  if (form.hasThread) {
    options.hasThread = true;
  }
  return options;
}

/** Stable 0..5 hue bucket per author (reuses the git graph lane palette). */
export function authorHue(author: string): number {
  let hash = 0;
  for (let index = 0; index < author.length; index += 1) {
    hash = (hash * 31 + author.charCodeAt(index)) >>> 0;
  }
  return hash % 6;
}

/**
 * Rewrites @mentions into `mention://` links so the markdown renderer can
 * draw them as chips. Only known handles (+ @channel/@human) are decorated,
 * and code spans/fences are left untouched.
 */
export function decorateMentions(body: string, handles: string[]): string {
  const known = new Set([...handles, 'channel', 'human']);
  // Split on code regions; transform only the non-code segments.
  const segments = body.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment; // code segment captured by the splitter
      }
      return segment.replace(/(^|[^A-Za-z0-9_`[])@([A-Za-z][A-Za-z0-9_-]*)/g, (full, prefix: string, handle: string) => {
        if (!known.has(handle)) {
          return full;
        }
        return `${prefix}[@${handle}](mention://${handle})`;
      });
    })
    .join('');
}

/**
 * Safety net for file links: auto-converts a bare absolute path (`/…` or `~/…`,
 * with a file extension, optionally `:line`) into a markdown link so it's
 * clickable even when an agent didn't format one. The `:line` suffix stays in
 * the visible label but is dropped from the link target (the editor opens the
 * file, not `file.ts:42`). Skips code spans/fences and existing markdown links,
 * so it never double-wraps an explicit link or touches code samples.
 */
export function linkifyPaths(body: string): string {
  const segments = body.split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\))/g);
  const PATH = /(^|[\s(])(~?\/[\w@./+-]*\.[A-Za-z0-9]+)(:\d+(?::\d+)?)?/g;
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment; // code span/fence or an existing markdown link — leave it
      }
      return segment.replace(PATH, (_full, prefix: string, path: string, line = '') => `${prefix}[${path}${line}](${path})`);
    })
    .join('');
}

/** True when the message addresses this handle directly (or @channel). */
export function messageTargets(body: string, handle: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_\`])@(${escapeRegExp(handle)}|channel)(?![A-Za-z0-9_-])`);
  return pattern.test(body);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parses the protocol timestamp ("2026-06-11 15:30:12", local time). */
export function parseMessageTime(timestamp: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(timestamp);
  if (!match) {
    return null;
  }
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
}

export interface MessageGroup {
  dayLabel: string;
  messages: ChannelMessage[];
}

export type MessageListRow =
  | { kind: 'day'; key: string; dayLabel: string; groupIndex: number }
  | { kind: 'new-divider'; key: string; messageId: string; groupIndex: number; messageIndex: number }
  | { kind: 'message'; key: string; message: ChannelMessage; groupIndex: number; messageIndex: number; grouped: boolean };

export interface MessageVirtualItem {
  index: number;
  start: number;
  end: number;
}

export interface ReadProgressVirtualMetrics {
  scrollOffset: number;
  viewportHeight: number;
  scrollHeight: number;
  bottomPx: number;
  programmatic?: boolean;
}

/** Groups messages by calendar day for separators. */
export function groupMessagesByDay(messages: ChannelMessage[], now = new Date()): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentKey = '';
  for (const message of messages) {
    const time = parseMessageTime(message.timestamp);
    const key = time ? `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}` : 'unknown';
    if (key !== currentKey || groups.length === 0) {
      currentKey = key;
      groups.push({ dayLabel: time ? dayLabel(time, now) : '—', messages: [message] });
    } else {
      groups[groups.length - 1].messages.push(message);
    }
  }
  return groups;
}

/** Flat row model for the virtualized MessageList. Keeps the rendered order
 * testable without relying on DOM scans or nested map structure. */
export function buildMessageListRows(
  messages: ChannelMessage[],
  options: { newDividerId?: string | null; now?: Date; compact?: boolean } = {}
): MessageListRow[] {
  const rows: MessageListRow[] = [];
  const groups = groupMessagesByDay(messages, options.now);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;
    rows.push({ kind: 'day', key: `day:${group.dayLabel}:${groupIndex}`, dayLabel: group.dayLabel, groupIndex });
    for (let messageIndex = 0; messageIndex < group.messages.length; messageIndex += 1) {
      const message = group.messages[messageIndex]!;
      if (options.newDividerId === message.id) {
        rows.push({ kind: 'new-divider', key: `new:${message.id}`, messageId: message.id, groupIndex, messageIndex });
      }
      rows.push({
        kind: 'message',
        key: `msg:${message.id}`,
        message,
        groupIndex,
        messageIndex,
        grouped: !options.compact && groupsWithPrevious(group.messages[messageIndex - 1], message)
      });
    }
  }
  return rows;
}

export function findMessageRowIndex(rows: MessageListRow[], messageId: string | null | undefined): number {
  if (!messageId) {
    return -1;
  }
  return rows.findIndex((row) => row.kind === 'message' && row.message.id === messageId);
}

function lastMessageIdFromRows(rows: MessageListRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === 'message') {
      return row.message.id;
    }
  }
  return null;
}

/** Read-progress derivation for virtualized rows. It replaces the old
 * querySelectorAll('[data-msg-id]') scan with virtual item geometry. */
export function readProgressFromVirtualRows(
  rows: MessageListRow[],
  virtualItems: MessageVirtualItem[],
  metrics: ReadProgressVirtualMetrics
): string | null {
  if (metrics.programmatic) {
    return null;
  }
  const fromBottom = metrics.scrollHeight - metrics.scrollOffset - metrics.viewportHeight;
  if (fromBottom <= metrics.bottomPx) {
    return lastMessageIdFromRows(rows);
  }
  let readId: string | null = null;
  const viewBottom = metrics.scrollOffset + metrics.viewportHeight - 4;
  for (const item of [...virtualItems].sort((a, b) => a.index - b.index)) {
    if (item.end > viewBottom) {
      break;
    }
    const row = rows[item.index];
    if (row?.kind === 'message') {
      readId = row.message.id;
    }
  }
  return readId;
}

export function dayLabel(time: Date, now = new Date()): string {
  const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.round((startOfDay(now) - startOfDay(time)) / dayMs);
  if (diff === 0) {
    return 'Today';
  }
  if (diff === 1) {
    return 'Yesterday';
  }
  return time.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function messageClock(timestamp: string): string {
  return timestamp.slice(11, 16) || timestamp;
}

/** Unread count for a channel from its summary + the viewer's seen entry.
 * Mirrors the sidebar badge math: no seen entry => everything is unread; the
 * pointer sitting on the last message => zero; otherwise total minus the count
 * already read. Pure so the switch-in re-anchor gate and the badge share it. */
export function channelUnreadCount(
  messageCount: number,
  lastMessageId: string | null | undefined,
  seen: { id: string; count: number } | undefined
): number {
  if (!seen) {
    return messageCount;
  }
  if (lastMessageId && seen.id === lastMessageId) {
    return 0;
  }
  return Math.max(0, messageCount - seen.count);
}

export interface ChannelSeenEntry {
  id: string;
  count: number;
}

/**
 * Keep the two persisted read-pointer fields coherent. Sidebar badges use the
 * absolute count, while the feed divider/highlight uses the message id. If the
 * count already says the channel is fully read, normalize the id to the current
 * last message so a stale id cannot keep the feed visually unread forever.
 */
export function normalizeChannelSeenEntry(
  channel: { messageCount: number; lastMessage?: { id: string } | null },
  seen: ChannelSeenEntry | undefined
): ChannelSeenEntry | undefined {
  if (!seen) {
    return undefined;
  }
  const lastMessageId = channel.lastMessage?.id ?? null;
  if (lastMessageId && channelUnreadCount(channel.messageCount, lastMessageId, seen) === 0) {
    return { id: lastMessageId, count: channel.messageCount };
  }
  return seen;
}

export function channelReadPointer(
  channel: { messageCount: number; lastMessage?: { id: string } | null },
  seen: ChannelSeenEntry | undefined
): string | null {
  return normalizeChannelSeenEntry(channel, seen)?.id ?? null;
}

export function channelInitialLoadSince(
  channel: { messageCount: number; lastMessage?: { id: string } | null },
  seen: ChannelSeenEntry | undefined
): string | null {
  if (channelUnreadCount(channel.messageCount, channel.lastMessage?.id ?? null, seen) === 0) {
    return null;
  }
  return channelReadPointer(channel, seen);
}

export function channelShouldReanchorCachedDetail(
  channel: { messageCount: number; lastMessage?: { id: string } | null },
  seen: ChannelSeenEntry | undefined
): boolean {
  return Boolean(seen && channelInitialLoadSince(channel, seen));
}

/** Count of messages after the last-seen id (id order == document order). */
export function unreadCount(messages: { id: string }[], lastSeenId: string | null): number {
  if (!lastSeenId) {
    return messages.length;
  }
  const index = messages.findIndex((message) => message.id === lastSeenId);
  return index === -1 ? messages.length : messages.length - index - 1;
}

/** Filter messages by a free-text query (body + author, case-insensitive). */
export function filterMessages<T extends { body: string; author: string }>(messages: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return messages;
  }
  return messages.filter(
    (message) => message.body.toLowerCase().includes(needle) || message.author.toLowerCase().includes(needle)
  );
}

export interface MentionQuery {
  /** caret offset where the @ token starts */
  start: number;
  /** the partial handle typed so far (without @) */
  partial: string;
}

/**
 * Detects an in-progress @mention at the caret for the autocomplete popover.
 * Active while the token under the caret looks like `@partial-handle`.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s([{])@([A-Za-z0-9_-]*)$/.exec(before);
  if (!match) {
    return null;
  }
  return { start: caret - match[2].length - 1, partial: match[2] };
}

/** Applies a chosen handle to the composer text at the active mention query. */
export function applyMention(text: string, caret: number, query: MentionQuery, handle: string): { text: string; caret: number } {
  const next = `${text.slice(0, query.start)}@${handle} ${text.slice(caret)}`;
  return { text: next, caret: query.start + handle.length + 2 };
}

/** Two-letter avatar initials from a member handle ("workspace-main" → "SM"). */
export function authorInitials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  const word = parts[0] ?? '?';
  return word.slice(0, 2).toUpperCase();
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Slack-style run grouping: a message collapses under the previous one when
 * the author matches and they are close in time (header rendered once per run).
 */
export function groupsWithPrevious(
  previous: { author: string; timestamp: string } | undefined,
  current: { author: string; timestamp: string }
): boolean {
  if (!previous || previous.author !== current.author) {
    return false;
  }
  const a = parseMessageTime(previous.timestamp);
  const b = parseMessageTime(current.timestamp);
  if (!a || !b) {
    return false;
  }
  return b.getTime() - a.getTime() >= 0 && b.getTime() - a.getTime() < GROUP_WINDOW_MS;
}

/** Id of the first message after the last-seen one (the NEW divider anchor). */
export function firstUnreadId(messages: { id: string }[], lastSeenId: string | null | undefined): string | null {
  if (!lastSeenId) {
    return null; // never opened: everything is technically new — no divider noise
  }
  const index = messages.findIndex((message) => message.id === lastSeenId);
  if (index === -1 || index === messages.length - 1) {
    return null;
  }
  return messages[index + 1].id;
}

/**
 * Set of message ids strictly after the read pointer — the still-unread block
 * that the feed highlights. Mirrors firstUnreadId's "no noise before the first
 * read" rule: an unknown/empty pointer yields an empty set (no wall of glow on
 * a never-opened channel). The set shrinks from the top as the pointer advances
 * while the operator scrolls.
 */
export function unreadIdsAfter(messages: { id: string }[], readPointerId: string | null | undefined): Set<string> {
  if (!readPointerId) {
    return new Set();
  }
  const index = messages.findIndex((message) => message.id === readPointerId);
  if (index === -1) {
    return new Set();
  }
  const ids = new Set<string>();
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    ids.add(messages[cursor].id);
  }
  return ids;
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** jump-to-latest: id of the last message in the loaded window, null if empty. */
export function latestMessageId(messages: { id: string }[]): string | null {
  return messages.length === 0 ? null : messages[messages.length - 1].id;
}

/**
 * jump-to-next-mention: the first message AFTER `afterId` whose body targets
 * `handle` (direct @ping or @channel — reuses messageTargets so detection is not
 * re-implemented). A null/unknown cursor searches from the top so the first jump
 * lands on the first mention; returns null when nothing matches past the cursor.
 */
export function nextMentionId(messages: { id: string; body: string }[], afterId: string | null, handle: string): string | null {
  const cursor = afterId ? messages.findIndex((message) => message.id === afterId) : -1;
  for (let index = cursor + 1; index < messages.length; index += 1) {
    if (messageTargets(messages[index].body, handle)) {
      return messages[index].id;
    }
  }
  return null;
}

/**
 * keyboard nav (j/k): the id one step from `currentId` in `direction`. With
 * no cursor, 'next' selects the first message and 'prev' the last (so the first
 * keypress enters the list). Returns null at the boundary (caller keeps the
 * current cursor — no wrap) and on an empty list.
 */
export function adjacentMessageId(
  messages: { id: string }[],
  currentId: string | null,
  direction: 'next' | 'prev'
): string | null {
  if (messages.length === 0) {
    return null;
  }
  if (!currentId) {
    return direction === 'next' ? messages[0].id : messages[messages.length - 1].id;
  }
  const index = messages.findIndex((message) => message.id === currentId);
  if (index === -1) {
    return direction === 'next' ? messages[0].id : messages[messages.length - 1].id;
  }
  const target = direction === 'next' ? index + 1 : index - 1;
  if (target < 0 || target >= messages.length) {
    return null;
  }
  return messages[target].id;
}

export function shouldSwitchChannelForNavigation(currentChannel: string | null | undefined, targetChannel: string): boolean {
  return currentChannel !== targetChannel;
}

export function restoreScrollChannelForSelection(
  channel: string,
  options: { restoreScroll?: boolean } = {}
): string | null {
  return options.restoreScroll === false ? null : channel;
}

export interface ChannelSidebarSectionsInput {
  hasDetail: boolean;
  fileCount: number;
}

export interface ChannelSidebarSections {
  members: boolean;
  files: boolean;
}

export type ChannelSidebarSectionId = keyof ChannelSidebarSections;

export function channelSidebarSections(input: ChannelSidebarSectionsInput): ChannelSidebarSections {
  return {
    members: input.hasDetail,
    files: input.hasDetail && input.fileCount > 0
  };
}

export function channelSidebarResizeHandleEnabled(beforeCollapsed: boolean, afterCollapsed: boolean): boolean {
  return !beforeCollapsed && !afterCollapsed;
}

export function channelSidebarCollapsedSectionsToPreserve(
  collapsed: ChannelSidebarSections,
  toggled: ChannelSidebarSectionId
): ChannelSidebarSectionId[] {
  return (Object.keys(collapsed) as ChannelSidebarSectionId[]).filter((section) => section !== toggled && collapsed[section]);
}

export function channelSidebarNextCollapsedSections(
  collapsed: ChannelSidebarSections,
  toggled: ChannelSidebarSectionId
): ChannelSidebarSections {
  return { ...collapsed, [toggled]: !collapsed[toggled] };
}

export function channelSidebarExpandedSize(section: ChannelSidebarSectionId): string {
  return section === 'members' ? '28%' : '18%';
}

export function channelSidebarListSize(collapsed: ChannelSidebarSections): string {
  if (collapsed.members && collapsed.files) {
    return '100%';
  }
  if (collapsed.members) {
    return '82%';
  }
  if (collapsed.files) {
    return '72%';
  }
  return '54%';
}

export interface ComposerInputHeightBounds {
  minHeight: number;
  maxHeight: number;
}

export function composerInputHeightFromTopResize(
  startHeight: number,
  startY: number,
  currentY: number,
  bounds: ComposerInputHeightBounds
): number {
  const next = startHeight + (startY - currentY);
  return Math.round(Math.min(bounds.maxHeight, Math.max(bounds.minHeight, next)));
}

export type AddableAgentRuntimeState = 'running' | 'missing';

export interface AddableAgentCandidate {
  name: string;
  tmuxSession: string;
  cwd: string;
  agent?: string;
  projectId?: string;
  projectLabel?: string;
  groupId?: string;
  groupLabel?: string;
  state?: AddableAgentRuntimeState;
}

export interface AddableAgentFilters {
  query?: string;
  project?: string;
  agent?: string;
  state?: 'all' | AddableAgentRuntimeState;
}

export interface AddableAgentFilterOption {
  value: string;
  label: string;
  count: number;
}

export function addableAgentProjectOptions(candidates: AddableAgentCandidate[]): AddableAgentFilterOption[] {
  return countedOptions(
    candidates,
    (candidate) => addableAgentProjectValue(candidate),
    (candidate) => candidate.projectLabel?.trim() || candidate.projectId?.trim() || 'Ungrouped'
  );
}

export function addableAgentAgentOptions(candidates: AddableAgentCandidate[]): AddableAgentFilterOption[] {
  return countedOptions(
    candidates,
    (candidate) => addableAgentAgentValue(candidate),
    (candidate) => candidate.agent?.trim() || 'custom'
  );
}

export function filterAddableAgentCandidates<T extends AddableAgentCandidate>(
  candidates: T[],
  filters: AddableAgentFilters = {}
): T[] {
  const queryTerms = filters.query
    ?.trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean) ?? [];
  const project = filters.project && filters.project !== 'all' ? filters.project : '';
  const agent = filters.agent && filters.agent !== 'all' ? filters.agent : '';
  const state = filters.state && filters.state !== 'all' ? filters.state : '';

  return candidates.filter((candidate) => {
    if (project && addableAgentProjectValue(candidate) !== project) {
      return false;
    }
    if (agent && addableAgentAgentValue(candidate) !== agent) {
      return false;
    }
    if (state && candidate.state !== state) {
      return false;
    }
    if (queryTerms.length === 0) {
      return true;
    }
    const haystack = [
      candidate.name,
      candidate.agent,
      candidate.tmuxSession,
      candidate.cwd,
      candidate.projectId,
      candidate.projectLabel,
      candidate.groupId,
      candidate.groupLabel,
      candidate.state
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return queryTerms.every((term) => haystack.includes(term));
  });
}

function addableAgentProjectValue(candidate: AddableAgentCandidate): string {
  return candidate.projectId?.trim() || candidate.projectLabel?.trim() || 'ungrouped';
}

function addableAgentAgentValue(candidate: AddableAgentCandidate): string {
  return candidate.agent?.trim() || 'custom';
}

function countedOptions<T>(
  items: T[],
  valueOf: (item: T) => string,
  labelOf: (item: T) => string
): AddableAgentFilterOption[] {
  const options = new Map<string, AddableAgentFilterOption>();
  for (const item of items) {
    const value = valueOf(item);
    const existing = options.get(value);
    if (existing) {
      existing.count += 1;
    } else {
      options.set(value, { value, label: labelOf(item), count: 1 });
    }
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/**
 * deep-link: a stable, copy-pasteable link to a message that the navTarget
 * path resolves (channel + message id, plus the thread-parent id when the
 * message lives in a thread). Components are URL-encoded so handles/ids with odd
 * characters round-trip through parseMessageLink.
 */
export function buildMessageLink(ref: { channel: string; messageId: string; thread?: string }): string {
  const base = `desk://channels/${encodeURIComponent(ref.channel)}/${encodeURIComponent(ref.messageId)}`;
  return ref.thread ? `${base}?thread=${encodeURIComponent(ref.thread)}` : base;
}

/** parse a desk message deep-link back into its nav target, or null if the text is not one. */
export function parseMessageLink(text: string): { channel: string; messageId: string; thread?: string } | null {
  const match = /^desk:\/\/channels\/([^/?]+)\/([^/?]+)(?:\?thread=([^&]+))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const result: { channel: string; messageId: string; thread?: string } = {
    channel: decodeURIComponent(match[1]),
    messageId: decodeURIComponent(match[2])
  };
  if (match[3]) {
    result.thread = decodeURIComponent(match[3]);
  }
  return result;
}

/**
 * quote-reply: a markdown blockquote of the message with an attribution
 * header and a trailing blank line, ready to prefill the composer above the
 * operator's reply. Every body line is prefixed so multi-line quotes render as
 * one block.
 */
export function buildQuoteReply(message: { author: string; body: string }): string {
  const quoted = message.body.split('\n').map((line) => `> ${line}`).join('\n');
  return `> @${message.author}:\n${quoted}\n\n`;
}
