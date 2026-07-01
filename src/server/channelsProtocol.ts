import { randomBytes } from 'node:crypto';

/**
 * Channels protocol — pure parsing/formatting for the markdown-based
 * inter-agent messaging format (compatible with the `channels` workspace
 * convention: `.channels/<channel>/root.md`, `thread-<msg-id>.md`,
 * `_members/<name>.md`).
 *
 * A message block looks like:
 *
 *   ---
 *
 *   ### msg-20260611-153012-a3f9
 *   **@agent** · 2026-06-11 15:30:12
 *   **thread**: [thread-msg-…](thread-msg-….md) (2 replies)   ← optional
 *
 *   body…
 *
 *   <!-- END_TURN -->
 *
 *   ---
 *
 * END_TURN marks the block as finalised — only finalised blocks are
 * dispatched to other members.
 */

export const END_TURN = '<!-- END_TURN -->';

export interface ChannelMessage {
  id: string;
  author: string;
  timestamp: string;
  body: string;
  hasEndTurn: boolean;
  /** thread file referenced from this message (root messages only) */
  threadFile?: string;
  threadReplies?: number;
}

/**
 * Lightweight reaction/acknowledgement a member can attach to a message.
 * A FIXED enum, NOT an open string, so the UI label/icon map is
 * exhaustiveness-guarded (Theme C) and a new kind cannot land half-wired.
 * Persisted by channelsReactions.ts (single global reactions.json), consumed by
 * the MessageList reaction action + render.
 */
export type ReactionKind = 'ack' | 'seen' | 'done' | 'thumbs-up';

/**
 * Structured feed-filter spec for saved views. Every field is grounded in a
 * real ChannelMessage attribute so there are no toy/un-backed filters: `text`
 * matches body+author, `author` matches the author handle, `mentionsMe` keeps
 * messages addressed to the viewer (or @channel), `hasThread` keeps root
 * messages that opened a thread. Frozen here as the single source so
 * channelsViews.ts (storage) persists it verbatim and the UI matcher reads the
 * same shape — no duplication, no churn.
 */
export interface ViewFilter {
  text?: string;
  author?: string;
  mentionsMe?: boolean;
  hasThread?: boolean;
}

export interface ChannelMember {
  name: string;
  /** member kind: claude-code | codex-cli | human | bash */
  type: string;
  status: string;
  joined: string;
  /** desk extension: tmux session backing this member */
  tmuxSession?: string;
}

/**
 * Channels engine diagnostics — the contracts shared by the server engine and
 * the web ops console. DEFINED HERE (single source): channelsEngine.ts imports
 * + re-exports them for the server, channelsClient.ts imports + re-exports them
 * for the web. They used to be hand-mirrored in the client, which drifted from
 * the server union; a new state now lands in one place and tsc-forces every
 * consumer (e.g. the EngineConsole label maps) to handle it.
 */

/**
 * The single per-session status the main UI renders — one model, replacing the
 * old busy/idle bit. Derived from CACHED MemberRuntime fields + the effective
 * delivery block (NO live pane probe), so it is safe on the hot /state poll.
 */
export type LifecycleStatus = 'working' | 'submit-stuck' | 'blocked' | 'awaiting-approval' | 'paused' | 'idle';

/**
 * Per-session delivery lifecycle for the hot /state poll. Supersedes the old
 * MemberDeliveryState (busy/queued only): keeps those fields for back-compat and
 * adds the unified `status` plus the cached lifecycle truth (submitState,
 * effective block, durable stuck count) so the main UI shows working / stuck /
 * blocked DISTINCT from idle without touching the live-probe /engine surface.
 */
export interface LifecycleState {
  tmuxSession: string;
  busy: boolean;
  awaitingApproval: boolean;
  queued: number;
  lastDeliveryAt?: string;
  lastReleaseAt?: string;
  status: LifecycleStatus;
  submitState?: SubmitState;
  pausedByOperator?: boolean;
  pauseReason?: string;
  pausedAt?: string;
  deliveryBlocked?: boolean;
  blockedReason?: DeliveryBlockReason;
  blockedItemCount: number;
  droppedQueueItems: number;
}

export interface SessionResumeInfo {
  sessionName?: string;
  agent?: string;
  cwd?: string;
  resume?: string;
  hasResume: boolean;
  bypassPermissions?: boolean;
}

export interface ChannelActivityEvent {
  seq: number;
  kind: 'message' | 'queued' | 'delivery' | 'human-mention';
  channel: string;
  file: string;
  messageId: string;
  author: string;
  /** queue/delivery events: the member/session that should receive or received the prompt */
  target?: string;
  preview: string;
  at: string;
}

/**
 * Live deliverability of an agent's tmux pane, as the ops console reports it.
 * `empty-capture` is surfaced first-class so the concurrency truncation bug
 * (capture read on `exit` returning '') is visible if it ever regresses.
 */
export type PaneState = 'ready' | 'busy' | 'not-ready' | 'booting' | 'empty-capture' | 'offline' | 'unobservable';

/**
 * Lifecycle of a single delivery's submit, as the verify cycle observes it.
 * `delivering` is set the instant the paste is pushed; the verify cycle resolves
 * it to `submitted` (positive evidence the prompt was accepted — the agent went
 * working, OR after a ready-gated delivery a structural approval/input menu
 * appeared) or to one of three stuck classifications after N cycles:
 *  - `submit-stuck-paste`        — pane never changed from pre-paste; the paste
 *    never landed in the input box.
 *  - `submit-stuck-submit`       — the prompt is in the box (pane changed) but
 *    the submit Enter was eaten, so it never ran.
 *  - `submit-stuck-unobservable` — no positive observation across N cycles
 *    (capture null/failed throughout); submission unconfirmed, so at-least-once
 *    replay (the message-id embedded in the prompt makes the replay safe).
 *  - `delivery-ack-timeout` — notification-only delivery exhausted its ACK
 *    budget without a UserPromptSubmit/delivery-ack event. This is degraded
 *    hook/liveness evidence, not a durable stuck-submit class.
 * The on-disk ack-file durability layer keys its `.delivering/.delivered/
 * .stuck-*` renames on these transitions.
 */
export type SubmitState =
  | 'delivering'
  | 'submitted'
  | 'delivery-ack-timeout'
  | 'submit-stuck-paste'
  | 'submit-stuck-submit'
  | 'submit-stuck-unobservable';

/** Why a session's queue is currently held (ops-console diagnostic). */
export type DeliveryBlockReason =
  | 'approval'
  | 'input-requested'
  | 'offline'
  | 'booting'
  | 'busy'
  | 'not-ready'
  | 'trust-menu'
  | 'selection-menu'
  | 'unknown-menu'
  | 'empty-capture'
  | 'capture-failed'
  | 'unobservable'
  | 'send-failed'
  | 'submit-stuck-paste'
  | 'submit-stuck-submit';

/** A queued prompt as exposed to the ops console (no full prompt body). */
export interface QueuedItemMeta {
  seq: number;
  channel: string;
  messageId: string;
  author: string;
  queuedAt: string;
  kind: 'message' | 'prompt';
  preview: string;
}

/**
 * A durable stuck delivery (.stuck-paste / .stuck-submit / .stuck-unobservable)
 * as exposed to the ops console — the no-body diagnostic of a stuck queue item
 * (mirrors QueuedItemMeta-vs-QueuedPrompt). The full prompt body never enters
 * the diagnostic payload; the operator force-delivers or drops by seq.
 */
export interface BlockedItemMeta {
  seq: number;
  kind: 'paste' | 'submit' | 'unobservable';
  channel: string;
  messageId: string;
  author: string;
  queuedAt: string;
  preview: string;
}

/** Per-session engine diagnostics for the ops console. */
export interface SessionDiagnostic {
  tmuxSession: string;
  paneState: PaneState;
  status: LifecycleStatus;
  busy: boolean;
  awaitingApproval: boolean;
  pausedByOperator?: boolean;
  pauseReason?: string;
  pausedAt?: string;
  draining: boolean;
  queued: number;
  lastDeliveryAt?: string;
  lastReleaseAt?: string;
  /** result of the last delivery's submit verification (undefined = none yet) */
  submitState?: SubmitState;
  deliveryBlocked?: boolean;
  blockedReason?: DeliveryBlockReason;
  blockedSince?: string;
  blockedCycles?: number;
  blockedHeadSeq?: number;
  droppedQueueItems?: number;
  /** durable stuck items (.stuck-*) surfaced for operator force-deliver / drop */
  blockedItems?: BlockedItemMeta[];
  items: QueuedItemMeta[];
  /** manifest-backed resume/session metadata for the resume inspector */
  sessionName?: string;
  agent?: string;
  cwd?: string;
  resume?: string;
  hasResume?: boolean;
  bypassPermissions?: boolean;
}

export function generateMessageId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `msg-${date}-${time}-${randomBytes(2).toString('hex')}`;
}

export function messageTimestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export interface FormatMessageOptions {
  id: string;
  author: string;
  timestamp: string;
  body: string;
}

/** Renders one protocol message block (always finalised with END_TURN). */
export function formatMessageBlock(options: FormatMessageOptions): string {
  const body = options.body.replace(/\r\n/g, '\n').replace(/\n*$/, '');
  return [
    '---',
    '',
    `### ${options.id}`,
    `**@${options.author}** · ${options.timestamp}`,
    '',
    body,
    '',
    END_TURN,
    '',
    '---',
    ''
  ].join('\n');
}

const MESSAGE_HEADER = /^### (msg-[A-Za-z0-9-]+)\s*$/;
const AUTHOR_LINE = /^\*\*@([^*]+)\*\*\s*·\s*(.+?)\s*$/;
const THREAD_LINE = /^\*\*thread\*\*:\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*\((\d+) replies?\))?\s*$/;

/**
 * Parses every message block out of a conversation file. Content before the
 * first message header is the channel preamble (title, goal, members table).
 */
export function parseConversation(source: string): { preamble: string; messages: ChannelMessage[] } {
  const lines = source.split('\n');
  const headerIndexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (MESSAGE_HEADER.test(lines[index])) {
      headerIndexes.push(index);
    }
  }
  const preambleEnd = headerIndexes.length > 0 ? headerIndexes[0] : lines.length;
  const preamble = lines.slice(0, preambleEnd).join('\n');

  const messages: ChannelMessage[] = [];
  for (let cursor = 0; cursor < headerIndexes.length; cursor += 1) {
    const start = headerIndexes[cursor];
    const end = cursor + 1 < headerIndexes.length ? headerIndexes[cursor + 1] : lines.length;
    const block = lines.slice(start, end);
    const id = MESSAGE_HEADER.exec(block[0])?.[1];
    if (!id) {
      continue;
    }
    let author = '';
    let timestamp = '';
    let threadFile: string | undefined;
    let threadReplies: number | undefined;
    let bodyStart = 1;
    for (let offset = 1; offset < Math.min(block.length, 4); offset += 1) {
      const authorMatch = AUTHOR_LINE.exec(block[offset]);
      if (authorMatch) {
        author = authorMatch[1];
        timestamp = authorMatch[2];
        bodyStart = offset + 1;
        continue;
      }
      const threadMatch = THREAD_LINE.exec(block[offset]);
      if (threadMatch) {
        threadFile = threadMatch[2];
        threadReplies = threadMatch[3] ? Number(threadMatch[3]) : 0;
        bodyStart = offset + 1;
      }
    }
    const bodyLines: string[] = [];
    let hasEndTurn = false;
    for (let offset = bodyStart; offset < block.length; offset += 1) {
      const line = block[offset];
      if (line.includes(END_TURN)) {
        hasEndTurn = true;
        break;
      }
      bodyLines.push(line);
    }
    // Trim trailing block separators and blank padding from the body.
    while (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1].trim() === '' || bodyLines[bodyLines.length - 1].trim() === '---')) {
      bodyLines.pop();
    }
    while (bodyLines.length > 0 && bodyLines[0].trim() === '') {
      bodyLines.shift();
    }
    messages.push({
      id,
      author,
      timestamp,
      body: bodyLines.join('\n'),
      hasEndTurn,
      threadFile,
      threadReplies
    });
  }
  return { preamble, messages };
}

/** Extracts unique @mention handles from a message body (lowercased as-is). */
export function extractMentions(body: string): string[] {
  // Strip fenced/inline code; mentions inside code samples are not mentions.
  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = new Set<string>();
  const pattern = /(^|[^A-Za-z0-9_`])@([A-Za-z][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutCode)) !== null) {
    found.add(match[2]);
  }
  return [...found];
}

export interface ResolveTargetOptions {
  /** Thread replies notify the parent-message author plus explicit agent mentions only. */
  isThread?: boolean;
  /** Author of the root message that owns the thread. */
  threadAuthor?: string;
}

/**
 * Resolves which members must be notified for a message, per protocol.
 *
 * Root messages:
 *  - no mentions -> every agent except the author
 *  - @channel broadcasts to every agent except the author
 *  - named agent mentions restrict delivery to those agents
 *  - mentions that do not name an agent deliver to no agents
 *
 * Thread replies:
 *  - no mentions -> the parent-message author only
 *  - named agent mentions -> parent-message author plus mentioned agents
 *  - @channel is ignored; it never broadcasts in threads
 *  - human/unknown-only mentions still notify the parent-message author
 *
 * Humans are excluded — UI notification handles @human separately.
 */
export function resolveTargets(author: string, body: string, members: ChannelMember[], options: ResolveTargetOptions = {}): ChannelMember[] {
  const agents = members.filter((member) => member.type !== 'human' && member.name !== author);
  const mentions = new Set(extractMentions(body).map((mention) => mention.toLowerCase()));
  const agentNames = new Set(members.filter((member) => member.type !== 'human').map((member) => member.name.toLowerCase()));
  if (options.isThread) {
    const targetNames = new Set<string>();
    if (options.threadAuthor) {
      targetNames.add(options.threadAuthor.toLowerCase());
    }
    for (const mention of mentions) {
      if (mention !== 'channel' && agentNames.has(mention)) {
        targetNames.add(mention);
      }
    }
    return agents.filter((member) => targetNames.has(member.name.toLowerCase()));
  }
  if (mentions.has('channel')) {
    return agents;
  }
  const mentionsKnownAgent = [...mentions].some((mention) => agentNames.has(mention));
  if (mentionsKnownAgent) {
    return agents.filter((member) => mentions.has(member.name.toLowerCase()));
  }
  if (mentions.size > 0) {
    return [];
  }
  return agents;
}

/** True when the body addresses the human operator. */
export function mentionsHuman(body: string): boolean {
  return extractMentions(body).includes('human');
}

const FRONTMATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;

/** Parses a `_members/<name>.md` manifest (frontmatter subset). */
export function parseMemberManifest(source: string): ChannelMember | undefined {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      break;
    }
    const match = FRONTMATTER_LINE.exec(lines[index]);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }
  if (!fields.name) {
    return undefined;
  }
  return {
    name: fields.name,
    type: fields.type ?? 'human',
    status: fields.status ?? 'active',
    joined: fields.joined ?? '',
    tmuxSession: fields.tmux || undefined
  };
}

export interface MemberManifestOptions {
  name: string;
  type: string;
  joined: string;
  tmuxSession?: string;
  agentLabel?: string;
}

export function formatMemberManifest(options: MemberManifestOptions): string {
  const lines = [
    '---',
    `name: ${options.name}`,
    `type: ${options.type}`,
    'status: active',
    `joined: ${options.joined}`
  ];
  if (options.tmuxSession) {
    lines.push(`tmux: ${options.tmuxSession}`);
  }
  lines.push('---', '', `# @${options.name}`, '', '## Identity', '', `- **Agent**: ${options.name}`, `- **Type**: ${options.type}`);
  if (options.agentLabel) {
    lines.push(`- **Desk session**: ${options.agentLabel}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatChannelPreamble(name: string, goal: string): string {
  return ['# ' + name, '', `> ${goal}`, '', '## Messages', ''].join('\n');
}

export function formatThreadPreamble(parent: ChannelMessage, channel: string): string {
  const quoted = parent.body
    .split('\n')
    .slice(0, 6)
    .map((line) => `> ${line}`)
    .join('\n');
  return [
    `# Thread: ${parent.id}`,
    '',
    `> Original message by **@${parent.author}** in [#${channel} root](root.md):`,
    quoted,
    '',
    '## Messages',
    ''
  ].join('\n');
}

/** Quote block used when sharing a message into another channel. */
export function formatSharedMessage(message: ChannelMessage, fromChannel: string, comment?: string): string {
  const quoted = message.body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const header = `**Shared from #${fromChannel}** (${message.id}, @${message.author} · ${message.timestamp}):`;
  return comment && comment.trim().length > 0 ? `${comment.trim()}\n\n${header}\n${quoted}` : `${header}\n${quoted}`;
}

const CHANNEL_NAME = /^[a-z][a-z0-9-]*$/;

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME.test(name) && name.length <= 64 && !name.startsWith('_');
}

/**
 * Derives a protocol member handle from a desk session. Handles must be
 * mention-safe; collisions across groups are disambiguated by the caller.
 */
export function memberHandleFromSession(sessionName: string): string {
  const slug = sessionName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
  return slug || 'agent';
}

/**
 * Member handle for a desk session, qualified by its project when the bare
 * session name is ambiguous across the desk (two projects both running a
 * same agent name must not both receive the same handle — mentions would misroute).
 */
/** Minimal identity of a configured desk agent, for handle-collision detection. */
export interface SessionHandleInfo {
  name: string;
  projectLabel?: string;
  groupLabel?: string;
}

/**
 * Picks the shortest unambiguous channel handle for a session. Escalates only as
 * far as needed: bare name → `project-name` → `project-group-name` (or
 * `group-name` when there's no project). Two agents of the same name in
 * different groups of one project both used to collapse to `project-name`; the
 * group qualifier disambiguates them. Existing members keep their stored handle —
 * this only runs when a new member is added.
 */
export function qualifiedMemberHandle(options: {
  sessionName: string;
  projectLabel?: string;
  groupLabel?: string;
  /** every configured desk agent (for collision detection) */
  roster: SessionHandleInfo[];
}): string {
  const base = memberHandleFromSession(options.sessionName);
  const sharingBase = options.roster.filter((entry) => memberHandleFromSession(entry.name) === base);
  if (sharingBase.length <= 1) {
    return base; // the bare name is already unique
  }
  const qualify = (...parts: (string | undefined)[]): string => memberHandleFromSession(parts.filter(Boolean).join('-'));
  if (options.projectLabel) {
    const sameProject = sharingBase.filter((entry) => (entry.projectLabel ?? '') === options.projectLabel);
    if (sameProject.length <= 1) {
      return qualify(options.projectLabel, options.sessionName) || base; // project is enough
    }
    // Same name AND same project — disambiguate by group.
    return qualify(options.projectLabel, options.groupLabel, options.sessionName) || base;
  }
  // No project to qualify with — fall back to the group.
  return qualify(options.groupLabel, options.sessionName) || base;
}
