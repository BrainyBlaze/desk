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
 * Persisted by store/reactions.ts (single global reactions.json), consumed by
 * the MessageList reaction action + render.
 */
export type ReactionKind = 'ack' | 'seen' | 'done' | 'thumbs-up';

/**
 * Structured feed-filter spec for saved views. Every field is grounded in a
 * real ChannelMessage attribute so there are no toy/un-backed filters: `text`
 * matches body+author, `author` matches the author handle, `mentionsMe` keeps
 * messages addressed to the viewer (or @channel), `hasThread` keeps root
 * messages that opened a thread. Frozen here as the single source so
 * store/views.ts (storage) persists it verbatim and the UI matcher reads the
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
  /** desk extension: durable session identity backing this member */
  sessionId?: string;
  /** agent role in this channel */
  role?: string;
  /** agent functions/responsibilities in this channel */
  functions?: string;
  /** desk extension: supervisor sees ALL messages (not only mentions),
   *  maintains a channel summary, and pings @channel when idle. */
  supervisor?: boolean;
  /** minutes of channel silence before the supervisor is asked to check in
   *  (only meaningful when supervisor=true; defaults to 3 when omitted) */
  supervisorMaxIdleMinutes?: number;
  /**
   * The retired per-session identity this member's manifest still binds to
   * (the retired member field, written by Desk v0.3.1 or older, that the v0.3.2 migration
   * left in place because the session no longer existed). This version cannot
   * resolve it to a sessionId: the member is listed with the binding it has,
   * unresolved, and receives no deliveries — the same fact stated, not hidden.
   */
  preCutoverSession?: string;
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

const FRONTMATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
/**
 * The frontmatter field Desk v0.3.1 and older used to bind an agent member to
 * its session. Since the cutover the binding is `session: <sessionId>`; the
 * migration that rewrote the line is gone, and v0.3.2 left the line in place
 * whenever the session it named no longer existed. A manifest that still
 * carries it is therefore an agent bound to an identity this version cannot
 * resolve — on a correctly migrated store as much as on an unmigrated one, so
 * refusing the whole channel here would assert more than the parser knows and
 * name a remedy already applied. The parser keeps the binding under a named
 * field and gives the member no sessionId: it is exactly what it is, an agent
 * whose session cannot be found.
 */
const PRE_CUTOVER_MEMBER_FIELD = 'tmux';

/**
 * Parses a `_members/<name>.md` manifest (frontmatter subset). Returns
 * undefined for a file that is not a member manifest at all. A pre-cutover
 * binding on the retired member field is carried as `preCutoverSession`, never as a sessionId.
 */
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
  const supervisorRaw = fields.supervisor?.toLowerCase();
  const supervisor = supervisorRaw === 'true' || supervisorRaw === 'yes' || supervisorRaw === '1' ? true : undefined;
  const idleMinutesRaw = Number.parseInt(fields.supervisorMaxIdleMinutes ?? '', 10);
  const supervisorMaxIdleMinutes = Number.isFinite(idleMinutesRaw) && idleMinutesRaw > 0 ? idleMinutesRaw : undefined;
  return {
    name: fields.name,
    type: fields.type ?? 'human',
    status: fields.status ?? 'active',
    joined: fields.joined ?? '',
    sessionId: fields.session || undefined,
    preCutoverSession: fields[PRE_CUTOVER_MEMBER_FIELD] || undefined,
    role: fields.role || undefined,
    functions: fields.functions || undefined,
    supervisor,
    supervisorMaxIdleMinutes
  };
}

export interface MemberManifestOptions {
  name: string;
  type: string;
  joined: string;
  sessionId?: string;
  agentLabel?: string;
  role?: string;
  functions?: string;
  supervisor?: boolean;
  supervisorMaxIdleMinutes?: number;
}

export function formatMemberManifest(options: MemberManifestOptions): string {
  const lines = [
    '---',
    `name: ${options.name}`,
    `type: ${options.type}`,
    'status: active',
    `joined: ${options.joined}`
  ];
  if (options.sessionId) {
    lines.push(`session: ${options.sessionId}`);
  }
  if (options.role) {
    lines.push(`role: ${options.role}`);
  }
  if (options.functions) {
    lines.push(`functions: ${options.functions}`);
  }
  if (options.supervisor) {
    lines.push(`supervisor: true`);
  }
  if (options.supervisorMaxIdleMinutes && options.supervisorMaxIdleMinutes > 0) {
    lines.push(`supervisorMaxIdleMinutes: ${options.supervisorMaxIdleMinutes}`);
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
