import { describe, expect, it } from 'vitest';
import {
  adjacentMessageId,
  addableAgentAgentOptions,
  addableAgentProjectOptions,
  applyMention,
  authorHue,
  authorInitials,
  buildAwayDigest,
  buildInboxItems,
  buildMessageListRows,
  buildMessageLink,
  buildQuoteReply,
  channelSidebarCollapsedSectionsToPreserve,
  channelSidebarExpandedSize,
  channelSidebarListSize,
  channelSidebarNextCollapsedSections,
  channelSidebarResizeHandleEnabled,
  channelSidebarSections,
  composerInputHeightFromTopResize,
  channelInitialLoadSince,
  channelReadPointer,
  channelShouldReanchorCachedDetail,
  channelUnreadCount,
  dayLabel,
  decorateMentions,
  findMessageRowIndex,
  filterAddableAgentCandidates,
  filterMessages,
  firstUnreadId,
  formatBytes,
  fuzzyMatch,
  groupMessagesByDay,
  groupsWithPrevious,
  isFeatured,
  latestMessageId,
  lifecycleStateSignature,
  linkifyPaths,
  mentionQueryAt,
  messageClock,
  messageMatchesFilter,
  messageTargets,
  normalizeChannelSeenEntry,
  nextMentionId,
  parseMessageLink,
  parseMessageTime,
  readProgressFromVirtualRows,
  reactionsForMessage,
  restoreScrollChannelForSelection,
  shouldSwitchChannelForNavigation,
  sortFeatured,
  toSearchOptions,
  unreadCount,
  unreadIdsAfter
} from '../src/web/channels/channelsModel.js';
import type { ChannelActivityEvent, ChannelMessage, FeaturedMessageRef, LifecycleState, ReactionRef } from '../src/web/channels/channelsClient.js';

const msg = (id: string, timestamp: string, body = 'x', author = 'claude'): ChannelMessage => ({
  id,
  author,
  timestamp,
  body,
  hasEndTurn: true
});

describe('message navigation channel switching', () => {
  it('uses the live selected channel instead of a captured render value', () => {
    expect(shouldSwitchChannelForNavigation('desk', 'channel-alpha')).toBe(true);
    expect(shouldSwitchChannelForNavigation('channel-alpha', 'channel-alpha')).toBe(false);
  });

  it('suppresses cached scroll restore when selecting a channel for a message jump', () => {
    expect(restoreScrollChannelForSelection('desk', { restoreScroll: true })).toBe('desk');
    expect(restoreScrollChannelForSelection('desk', { restoreScroll: false })).toBeNull();
  });
});

describe('addable agent filtering', () => {
  const candidates = [
    {
      name: 'desk-main',
      tmuxSession: 'agentdesk-desk-main',
      cwd: '/workspace/projects/desk',
      agent: 'codex',
      projectId: 'desk',
      projectLabel: 'Desk',
      groupLabel: 'Main',
      state: 'running' as const
    },
    {
      name: 'sample-audit',
      tmuxSession: 'agentdesk-sample-audit',
      cwd: '/workspace/projects/sample',
      agent: 'claude',
      projectId: 'sample',
      projectLabel: 'Sample',
      groupLabel: 'Audit',
      state: 'missing' as const
    },
    {
      name: 'language-tools',
      tmuxSession: 'agentdesk-language-tools',
      cwd: '/workspace/projects/desk',
      agent: 'codex',
      projectId: 'desk',
      projectLabel: 'Desk',
      groupLabel: 'LSP',
      state: 'running' as const
    }
  ];

  it('searches addable agents across identity and location fields', () => {
    expect(filterAddableAgentCandidates(candidates, { query: 'lsp' }).map((candidate) => candidate.name)).toEqual([
      'language-tools'
    ]);
    expect(filterAddableAgentCandidates(candidates, { query: 'sample audit' }).map((candidate) => candidate.name)).toEqual([
      'sample-audit'
    ]);
    expect(filterAddableAgentCandidates(candidates, { query: 'agentdesk-desk-main' }).map((candidate) => candidate.name)).toEqual([
      'desk-main'
    ]);
  });

  it('filters addable agents by project, agent type, and runtime state', () => {
    expect(filterAddableAgentCandidates(candidates, { project: 'desk' }).map((candidate) => candidate.name)).toEqual([
      'desk-main',
      'language-tools'
    ]);
    expect(filterAddableAgentCandidates(candidates, { project: 'desk', agent: 'codex', state: 'running' }).map((candidate) => candidate.name)).toEqual([
      'desk-main',
      'language-tools'
    ]);
    expect(filterAddableAgentCandidates(candidates, { project: 'desk', agent: 'claude' })).toEqual([]);
  });

  it('builds stable filter options from addable agents', () => {
    expect(addableAgentProjectOptions(candidates)).toEqual([
      { value: 'desk', label: 'Desk', count: 2 },
      { value: 'sample', label: 'Sample', count: 1 }
    ]);
    expect(addableAgentAgentOptions(candidates)).toEqual([
      { value: 'claude', label: 'claude', count: 1 },
      { value: 'codex', label: 'codex', count: 2 }
    ]);
  });
});

describe('channel sidebar sections', () => {
  it('shows members only when a channel is selected and files only when files exist', () => {
    expect(channelSidebarSections({ hasDetail: false, fileCount: 4 })).toEqual({ members: false, files: false });
    expect(channelSidebarSections({ hasDetail: true, fileCount: 0 })).toEqual({ members: true, files: false });
    expect(channelSidebarSections({ hasDetail: true, fileCount: 2 })).toEqual({ members: true, files: true });
  });

  it('disables resize handles next to collapsed sidebar sections', () => {
    expect(channelSidebarResizeHandleEnabled(false, false)).toBe(true);
    expect(channelSidebarResizeHandleEnabled(true, false)).toBe(false);
    expect(channelSidebarResizeHandleEnabled(false, true)).toBe(false);
  });

  it('preserves already-collapsed siblings while another section toggles', () => {
    expect(channelSidebarCollapsedSectionsToPreserve({ members: true, files: false }, 'files')).toEqual(['members']);
    expect(channelSidebarCollapsedSectionsToPreserve({ members: true, files: true }, 'members')).toEqual(['files']);
    expect(channelSidebarCollapsedSectionsToPreserve({ members: false, files: false }, 'members')).toEqual([]);
  });

  it('predicts the next collapsed state after a section toggle', () => {
    expect(channelSidebarNextCollapsedSections({ members: true, files: false }, 'files')).toEqual({ members: true, files: true });
    expect(channelSidebarNextCollapsedSections({ members: true, files: true }, 'members')).toEqual({ members: false, files: true });
  });

  it('uses useful expansion sizes for collapsed detail panels', () => {
    expect(channelSidebarExpandedSize('members')).toBe('28%');
    expect(channelSidebarExpandedSize('files')).toBe('18%');
  });

  it('sets the channel list share from the detail collapsed state', () => {
    expect(channelSidebarListSize({ members: false, files: false })).toBe('54%');
    expect(channelSidebarListSize({ members: false, files: true })).toBe('72%');
    expect(channelSidebarListSize({ members: true, files: false })).toBe('82%');
    expect(channelSidebarListSize({ members: true, files: true })).toBe('100%');
  });
});

describe('composer input resize', () => {
  it('resizes from the top edge: dragging up grows and dragging down shrinks', () => {
    const bounds = { minHeight: 38, maxHeight: 260 };

    expect(composerInputHeightFromTopResize(80, 300, 250, bounds)).toBe(130);
    expect(composerInputHeightFromTopResize(80, 300, 330, bounds)).toBe(50);
  });

  it('clamps top-edge resize to composer height bounds', () => {
    const bounds = { minHeight: 38, maxHeight: 260 };

    expect(composerInputHeightFromTopResize(80, 300, -1000, bounds)).toBe(260);
    expect(composerInputHeightFromTopResize(80, 300, 1000, bounds)).toBe(38);
  });
});

describe('decorateMentions', () => {
  it('rewrites known handles into mention links, leaving code intact', () => {
    const out = decorateMentions('hi @codex and @nobody, see `@codex` and ```\n@codex\n```', ['codex']);
    expect(out).toContain('[@codex](mention://codex)');
    expect(out).toContain('@nobody');
    expect(out).not.toContain('[@nobody]');
    expect(out).toContain('`@codex`');
    expect(out).toContain('```\n@codex\n```');
  });

  it('decorates @channel and @human without a roster entry', () => {
    const out = decorateMentions('@channel meet @human', []);
    expect(out).toContain('[@channel](mention://channel)');
    expect(out).toContain('[@human](mention://human)');
  });

  it('messageTargets matches direct pings and @channel', () => {
    expect(messageTargets('ping @human now', 'human')).toBe(true);
    expect(messageTargets('hello @channel', 'human')).toBe(true);
    expect(messageTargets('about @humanoid', 'human')).toBe(false);
    expect(messageTargets('nothing here', 'human')).toBe(false);
  });
});

describe('linkifyPaths', () => {
  it('auto-links a bare absolute path', () => {
    expect(linkifyPaths('see /workspace/x/foo.ts please')).toBe('see [/workspace/x/foo.ts](/workspace/x/foo.ts) please');
  });

  it('keeps a line suffix in the label but drops it from the target', () => {
    expect(linkifyPaths('fails at /a/b/foo.py:42')).toBe('fails at [/a/b/foo.py:42](/a/b/foo.py)');
  });

  it('links ~ paths and at the start of the string', () => {
    expect(linkifyPaths('~/proj/x.md')).toBe('[~/proj/x.md](~/proj/x.md)');
  });

  it('never touches code spans, fences, or existing markdown links', () => {
    expect(linkifyPaths('run `cat /a/b.ts` now')).toBe('run `cat /a/b.ts` now');
    expect(linkifyPaths('```\n/a/b.ts\n```')).toBe('```\n/a/b.ts\n```');
    expect(linkifyPaths('see [label](/a/b.ts)')).toBe('see [label](/a/b.ts)');
  });

  it('does not linkify URLs or extensionless/relative paths', () => {
    expect(linkifyPaths('visit https://site.com/a/b.ts')).toBe('visit https://site.com/a/b.ts');
    expect(linkifyPaths('the src/foo.ts file')).toBe('the src/foo.ts file'); // relative — not clickable
    expect(linkifyPaths('cd /usr/local/bin')).toBe('cd /usr/local/bin'); // no extension
  });
});

describe('time helpers', () => {
  it('parses protocol timestamps as local time', () => {
    const time = parseMessageTime('2026-06-11 15:30:12');
    expect(time?.getHours()).toBe(15);
    expect(parseMessageTime('garbage')).toBeNull();
    expect(messageClock('2026-06-11 15:30:12')).toBe('15:30');
  });

  it('labels days relative to now and groups messages', () => {
    const now = new Date(2026, 5, 11, 18, 0, 0);
    expect(dayLabel(new Date(2026, 5, 11, 9, 0), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 5, 10, 23, 0), now)).toBe('Yesterday');
    const groups = groupMessagesByDay(
      [msg('a', '2026-06-10 09:00:00'), msg('b', '2026-06-10 10:00:00'), msg('c', '2026-06-11 09:00:00')],
      now
    );
    expect(groups.map((group) => group.messages.length)).toEqual([2, 1]);
  });
});

describe('unread + filter', () => {
  it('counts messages after the last seen id', () => {
    const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(unreadCount(messages, null)).toBe(3);
    expect(unreadCount(messages, 'b')).toBe(1);
    expect(unreadCount(messages, 'c')).toBe(0);
    expect(unreadCount(messages, 'gone')).toBe(3);
  });

  it('filters by body and author, case-insensitive', () => {
    const messages = [msg('a', '2026-06-11 09:00:00', 'Reactor CORE design'), msg('b', '2026-06-11 09:01:00', 'other', 'codex')];
    expect(filterMessages(messages, 'core')).toHaveLength(1);
    expect(filterMessages(messages, 'CODEX')).toHaveLength(1);
    expect(filterMessages(messages, '  ')).toHaveLength(2);
  });

  it('channelUnreadCount tracks unread badges without driving navigation', () => {
    // never opened (no seen entry) -> everything is unread for the badge
    expect(channelUnreadCount(5, 'm5', undefined)).toBe(5);
    // caught up: pointer sits on the last message -> zero unread
    expect(channelUnreadCount(5, 'm5', { id: 'm5', count: 5 })).toBe(0);
    // new arrived while away: read 5 of 7 -> 2 unread
    expect(channelUnreadCount(7, 'm7', { id: 'm5', count: 5 })).toBe(2);
    // stale seen count never yields a negative unread
    expect(channelUnreadCount(3, 'm3', { id: 'm9', count: 9 })).toBe(0);
  });

  it('normalizes a fully-read count to the current last message id', () => {
    const channel = { messageCount: 3, lastMessage: { id: 'm3' } };
    expect(normalizeChannelSeenEntry(channel, { id: 'm1', count: 3 })).toEqual({ id: 'm3', count: 3 });
    expect(normalizeChannelSeenEntry(channel, { id: 'stale-high', count: 9 })).toEqual({ id: 'm3', count: 3 });
    expect(channelReadPointer(channel, { id: 'stale-high', count: 9 })).toBe('m3');
  });

  it('keeps the stored id when the channel still has unread messages', () => {
    const channel = { messageCount: 7, lastMessage: { id: 'm7' } };
    expect(normalizeChannelSeenEntry(channel, { id: 'm5', count: 5 })).toEqual({ id: 'm5', count: 5 });
    expect(channelReadPointer(channel, { id: 'm5', count: 5 })).toBe('m5');
    expect(channelReadPointer(channel, undefined)).toBeNull();
  });

  it('requests an initial window around the read pointer when unread messages exist', () => {
    const channel = { messageCount: 7, lastMessage: { id: 'm7' } };
    expect(channelInitialLoadSince(channel, { id: 'm5', count: 5 })).toBe('m5');
    expect(channelInitialLoadSince(channel, { id: 'm6', count: 6 })).toBe('m6');
    expect(channelInitialLoadSince(channel, { id: 'm7', count: 7 })).toBeNull();
    expect(channelInitialLoadSince(channel, { id: 'stale-high', count: 99 })).toBeNull();
    expect(channelInitialLoadSince(channel, undefined)).toBeNull();
  });

  it('reanchors cached detail only when newer unread messages arrived while away', () => {
    const channel = { messageCount: 7, lastMessage: { id: 'm7' } };

    expect(channelShouldReanchorCachedDetail(channel, { id: 'm5', count: 5 })).toBe(true);
    expect(channelShouldReanchorCachedDetail(channel, { id: 'm7', count: 7 })).toBe(false);
    expect(channelShouldReanchorCachedDetail(channel, { id: 'stale-high', count: 99 })).toBe(false);
    expect(channelShouldReanchorCachedDetail(channel, undefined)).toBe(false);
  });
});

describe('mention autocomplete', () => {
  it('detects an in-progress mention at the caret', () => {
    expect(mentionQueryAt('hello @co', 9)).toEqual({ start: 6, partial: 'co' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, partial: '' });
    expect(mentionQueryAt('email me@example', 16)).toBeNull();
    expect(mentionQueryAt('done @codex ', 12)).toBeNull();
  });

  it('applies the chosen handle and moves the caret', () => {
    const applied = applyMention('hello @co tail', 9, { start: 6, partial: 'co' }, 'codex');
    expect(applied.text).toBe('hello @codex  tail');
    expect(applied.caret).toBe(13);
  });
});

describe('chat ui helpers', () => {
  it('derives two-letter avatar initials from handles', () => {
    expect(authorInitials('workspace-main')).toBe('WM');
    expect(authorInitials('claude')).toBe('CL');
    expect(authorInitials('x')).toBe('X');
  });

  it('groups consecutive same-author messages within five minutes', () => {
    const a = { author: 'claude', timestamp: '2026-06-11 12:00:00' };
    const b = { author: 'claude', timestamp: '2026-06-11 12:03:00' };
    const c = { author: 'claude', timestamp: '2026-06-11 12:09:00' };
    const d = { author: 'codex', timestamp: '2026-06-11 12:03:30' };
    expect(groupsWithPrevious(a, b)).toBe(true);
    expect(groupsWithPrevious(b, c)).toBe(false); // window exceeded
    expect(groupsWithPrevious(a, d)).toBe(false); // author changed
    expect(groupsWithPrevious(undefined, a)).toBe(false);
  });

  it('anchors the NEW divider at the first message after the last seen', () => {
    const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(firstUnreadId(messages, 'a')).toBe('b');
    expect(firstUnreadId(messages, 'c')).toBeNull(); // fully read
    expect(firstUnreadId(messages, null)).toBeNull(); // first visit: no divider noise
    expect(firstUnreadId(messages, 'gone')).toBeNull();
  });

  it('highlights the unread block after the read pointer, shrinking as it advances', () => {
    const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect([...unreadIdsAfter(messages, 'a')]).toEqual(['b', 'c', 'd']);
    expect([...unreadIdsAfter(messages, 'c')]).toEqual(['d']); // pointer advanced while scrolling
    expect(unreadIdsAfter(messages, 'd').size).toBe(0); // fully read
    expect(unreadIdsAfter(messages, null).size).toBe(0); // first visit: no glow noise
    expect(unreadIdsAfter(messages, 'gone').size).toBe(0); // pointer fell off the window
  });
});

describe('misc', () => {
  it('author hue is stable and bounded', () => {
    expect(authorHue('claude')).toBe(authorHue('claude'));
    expect(authorHue('codex')).toBeGreaterThanOrEqual(0);
    expect(authorHue('codex')).toBeLessThan(6);
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
  });
});

describe('lifecycleStateSignature (lifecycle corrective — the refresh diff key must cover lifecycle fields)', () => {
  const base: LifecycleState = {
    tmuxSession: 'tmux-a',
    busy: false,
    awaitingApproval: false,
    queued: 1,
    status: 'idle',
    blockedItemCount: 0,
    droppedQueueItems: 0
  };

  it('CHANGES when only the lifecycle status changes (idle -> blocked, same busy/queued/awaitingApproval)', () => {
    // The bug: the old deliverySig keyed on busy/queued/awaitingApproval only, so
    // this transition was bailed and the UI showed stale status. lifecycleStateSignature must
    // include `status` (and the rest), so the signatures differ and setDelivery fires.
    const blocked: LifecycleState = { ...base, status: 'blocked', deliveryBlocked: true, blockedReason: 'not-ready' };
    expect(lifecycleStateSignature(base)).not.toBe(lifecycleStateSignature(blocked));
  });

  it('CHANGES on a submit-stuck transition with unchanged busy/queued', () => {
    const stuck: LifecycleState = { ...base, status: 'submit-stuck', submitState: 'submit-stuck-submit', blockedItemCount: 1 };
    expect(lifecycleStateSignature(base)).not.toBe(lifecycleStateSignature(stuck));
  });

  it('CHANGES when an pause field flips (pausedByOperator / pauseReason / pausedAt)', () => {
    // freeze: pausedByOperator/pauseReason/pausedAt are read-model fields the UI renders,
    // so each MUST be in the diff key — otherwise a pause edit (e.g. the operator rewording
    // the hold reason while already paused) is diff-bailed and the inbox/badge go stale, the
    // exact lifecycle staleness class this signature exists to prevent.
    const paused: LifecycleState = { ...base, status: 'paused', pausedByOperator: true, pausedAt: '2026-06-18T22:00:00.000Z' };
    expect(lifecycleStateSignature(base)).not.toBe(lifecycleStateSignature(paused));
    // status + pausedByOperator + pausedAt all identical; ONLY pauseReason differs — isolates that field.
    const reworded: LifecycleState = { ...paused, pauseReason: 'operator hold for review' };
    expect(lifecycleStateSignature(paused)).not.toBe(lifecycleStateSignature(reworded));
  });

  it('is STABLE when nothing the UI surfaces changed', () => {
    const working: LifecycleState = { ...base, busy: true, queued: 0, status: 'working' };
    expect(lifecycleStateSignature(working)).toBe(lifecycleStateSignature({ ...working }));
  });
});

describe('fuzzyMatch (command palette )', () => {
  it('matches a case-insensitive subsequence; empty query matches all', () => {
    expect(fuzzyMatch('cmd', 'command')).toBe(true);
    expect(fuzzyMatch('eng', 'Engine console')).toBe(true);
    expect(fuzzyMatch('ec', 'Engine Console')).toBe(true); // E...C subsequence
    expect(fuzzyMatch('', 'anything')).toBe(true);
    expect(fuzzyMatch('   ', 'anything')).toBe(true); // blank query
  });

  it('rejects out-of-order or absent characters', () => {
    expect(fuzzyMatch('dmc', 'command')).toBe(false); // d appears last, m/c not after it
    expect(fuzzyMatch('xyz', 'command')).toBe(false);
  });
});

describe('buildInboxItems (operator inbox)', () => {
  const session = (tmuxSession: string, over: Partial<LifecycleState>): LifecycleState => ({
    tmuxSession,
    busy: false,
    awaitingApproval: false,
    queued: 0,
    status: 'idle',
    blockedItemCount: 0,
    droppedQueueItems: 0,
    ...over
  });
  const mention = (channel: string, messageId: string): ChannelActivityEvent => ({
    seq: 1,
    kind: 'human-mention',
    channel,
    file: 'root.md',
    messageId,
    author: 'codex',
    preview: 'hey @human',
    at: '2026-06-18T00:00:00.000Z'
  });

  it('surfaces stuck / blocked / awaiting-approval / dropped from lifecycle states; ignores working/idle', () => {
    const items = buildInboxItems(
      [
        session('tmux-a', { status: 'submit-stuck', blockedItemCount: 2 }),
        session('tmux-b', { status: 'blocked', blockedReason: 'not-ready' }),
        session('tmux-c', { status: 'awaiting-approval' }),
        session('tmux-d', { status: 'idle', droppedQueueItems: 3 }),
        session('tmux-e', { status: 'working' })
      ],
      []
    );
    expect(items.map((item) => item.kind)).toEqual(['submit-stuck', 'blocked', 'awaiting-approval', 'dropped']);
    expect(items.find((item) => item.kind === 'submit-stuck')?.detail).toContain('2');
  });

  it('escalates an UNANSWERED @human mention to needs-reply; ignores other activity kinds', () => {
    const items = buildInboxItems([], [mention('ops', 'msg-1'), { ...mention('ops', 'msg-2'), kind: 'delivery' }]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('needs-reply'); // no later @human message in #ops
    expect(items[0]!.channel).toBe('ops');
    expect(items[0]!.messageId).toBe('msg-1');
  });

  it('keeps an ANSWERED @human mention as a plain mention (— a later @human message followed)', () => {
    const humanReply: ChannelActivityEvent = {
      seq: 5,
      kind: 'message',
      channel: 'ops',
      file: 'root.md',
      messageId: 'msg-9',
      author: 'human',
      preview: 'on it',
      at: '2026-06-18T00:05:00.000Z'
    };
    // the mention is seq 1; the human reply is seq 5 in the same channel -> answered
    const items = buildInboxItems([], [mention('ops', 'msg-1'), humanReply]);
    const mentionItem = items.find((item) => item.messageId === 'msg-1');
    expect(mentionItem?.kind).toBe('mention');
    // an unanswered mention in a DIFFERENT channel stays needs-reply
    const mixed = buildInboxItems([], [mention('ops', 'msg-1'), humanReply, mention('design', 'msg-2')]);
    expect(mixed.find((item) => item.channel === 'design')?.kind).toBe('needs-reply');
  });

  it('surfaces an operator-paused session with its reason', () => {
    const items = buildInboxItems([session('tmux-a', { status: 'paused', pausedByOperator: true, pauseReason: 'holding for review' })], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('paused');
    expect(items[0]!.tmuxSession).toBe('tmux-a');
    expect(items[0]!.detail).toBe('holding for review');
  });

  it('returns nothing when all sessions are idle/working and there are no mentions', () => {
    expect(buildInboxItems([session('tmux-a', { status: 'working' })], [])).toEqual([]);
  });
});

describe('isFeatured + sortFeatured (featured)', () => {
  const ref = (channel: string, file: string, id: string, savedAt = '2026-06-18T00:00:00.000Z'): FeaturedMessageRef => ({
    channel,
    file,
    id,
    savedAt
  });

  it('matches on channel+file+id identity, NOT bare id', () => {
    const items = [ref('ops', 'root.md', 'msg-1')];
    expect(isFeatured(items, 'ops', 'root.md', 'msg-1')).toBe(true);
    expect(isFeatured(items, 'ops', 'thread-msg-x.md', 'msg-1')).toBe(false); // same id, different file
    expect(isFeatured(items, 'other', 'root.md', 'msg-1')).toBe(false); // same id+file, different channel
    expect(isFeatured(items, 'ops', 'root.md', 'msg-2')).toBe(false);
  });

  it('sorts newest-first by savedAt without mutating the input', () => {
    const items = [ref('a', 'root.md', '1', '2026-06-10T00:00:00.000Z'), ref('b', 'root.md', '2', '2026-06-18T00:00:00.000Z')];
    const sorted = sortFeatured(items);
    expect(sorted.map((item) => item.id)).toEqual(['2', '1']);
    expect(items.map((item) => item.id)).toEqual(['1', '2']); // original unchanged
  });
});

describe('toSearchOptions (search form mapping)', () => {
  it('trims query + author, omits empty filters, sets booleans only when true', () => {
    expect(toSearchOptions({ query: '  hello  ' })).toEqual({ query: 'hello' });
    expect(toSearchOptions({ query: 'x', channel: 'ops', author: '  codex ', mentionsMe: true, hasThread: true })).toEqual({
      query: 'x',
      channel: 'ops',
      author: 'codex',
      mentionsMe: true,
      hasThread: true
    });
    // empty/blank filters + false booleans are dropped — the server gets no blank params
    expect(toSearchOptions({ query: 'x', channel: '', author: '   ', mentionsMe: false, hasThread: false })).toEqual({ query: 'x' });
  });
});

describe('jump-to helpers (latestMessageId + nextMentionId)', () => {
  const list = [
    msg('a', '2026-06-18 10:00:00', 'hello'),
    msg('b', '2026-06-18 10:01:00', 'ping @human'),
    msg('c', '2026-06-18 10:02:00', 'see @channel'),
    msg('d', '2026-06-18 10:03:00', 'nothing here')
  ];

  it('latestMessageId returns the last id, null on empty', () => {
    expect(latestMessageId(list)).toBe('d');
    expect(latestMessageId([])).toBeNull();
  });

  it('nextMentionId finds the next message targeting the handle after the cursor', () => {
    expect(nextMentionId(list, null, 'human')).toBe('b'); // null cursor → first mention from the top
    expect(nextMentionId(list, 'b', 'human')).toBe('c'); // @channel also targets the viewer
    expect(nextMentionId(list, 'c', 'human')).toBeNull(); // nothing addresses the viewer after c
    expect(nextMentionId(list, 'unknown', 'human')).toBe('b'); // unknown cursor → search from the top
  });
});

describe('adjacentMessageId (j/k keyboard nav)', () => {
  const list = [msg('a', 't'), msg('b', 't'), msg('c', 't')];

  it('moves next/prev and returns null at the edges (caller keeps the cursor)', () => {
    expect(adjacentMessageId(list, 'a', 'next')).toBe('b');
    expect(adjacentMessageId(list, 'b', 'prev')).toBe('a');
    expect(adjacentMessageId(list, 'c', 'next')).toBeNull(); // already at the end
    expect(adjacentMessageId(list, 'a', 'prev')).toBeNull(); // already at the start
  });

  it('with no cursor, next picks the first and prev picks the last; empty list yields null', () => {
    expect(adjacentMessageId(list, null, 'next')).toBe('a');
    expect(adjacentMessageId(list, null, 'prev')).toBe('c');
    expect(adjacentMessageId([], null, 'next')).toBeNull();
  });
});

describe('buildAwayDigest (while-away digest)', () => {
  it('reports per-channel unread (messageCount - seen), drops read channels, most-unread first', () => {
    const channels = [
      { name: 'ops', messageCount: 10 },
      { name: 'design', messageCount: 5 },
      { name: 'quiet', messageCount: 3 }
    ];
    const digest = buildAwayDigest(channels, { ops: 4, quiet: 3 });
    expect(digest).toEqual([
      { channel: 'design', unread: 5 }, // never read → all 5 unread, biggest
      { channel: 'ops', unread: 6 }
    ].sort((a, b) => b.unread - a.unread));
    expect(digest.map((entry) => entry.channel)).toEqual(['ops', 'design']); // 6 before 5; quiet (3-3=0) dropped
  });

  it('floors unread at 0 when seen exceeds count (stale seen pointer)', () => {
    expect(buildAwayDigest([{ name: 'ops', messageCount: 2 }], { ops: 9 })).toEqual([]);
  });
});

describe('messageMatchesFilter (saved views)', () => {
  const m = (over: Partial<ChannelMessage>): ChannelMessage => ({
    id: 'x',
    author: 'codex',
    timestamp: '2026-06-18 10:00:00',
    body: 'hello world',
    hasEndTurn: true,
    ...over
  });

  it('an empty filter matches everything', () => {
    expect(messageMatchesFilter(m({}), {}, 'human')).toBe(true);
  });

  it('text matches body OR author, case-insensitive', () => {
    expect(messageMatchesFilter(m({ body: 'Reactor CORE' }), { text: 'core' }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({ author: 'glm' }), { text: 'GL' }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({ body: 'nope', author: 'codex' }), { text: 'core' }, 'human')).toBe(false);
  });

  it('author requires an exact (case-insensitive) match', () => {
    expect(messageMatchesFilter(m({ author: 'Codex' }), { author: 'codex' }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({ author: 'glm' }), { author: 'codex' }, 'human')).toBe(false);
  });

  it('mentionsMe keeps only messages addressing the viewer or @channel', () => {
    expect(messageMatchesFilter(m({ body: 'ping @human' }), { mentionsMe: true }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({ body: 'hi @channel' }), { mentionsMe: true }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({ body: 'nothing' }), { mentionsMe: true }, 'human')).toBe(false);
  });

  it('hasThread keeps only messages that opened a thread', () => {
    expect(messageMatchesFilter(m({ threadFile: 'thread-msg-x.md' }), { hasThread: true }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({}), { hasThread: true }, 'human')).toBe(false);
  });

  it('AND-s every clause', () => {
    const match = m({ author: 'codex', body: 'ping @human', threadFile: 't.md' });
    expect(messageMatchesFilter(match, { author: 'codex', mentionsMe: true, hasThread: true }, 'human')).toBe(true);
    expect(messageMatchesFilter(m({ author: 'codex', body: 'ping @human' }), { author: 'codex', mentionsMe: true, hasThread: true }, 'human')).toBe(false);
  });
});

describe('reactionsForMessage', () => {
  const r = (channel: string, file: string, id: string, kind: ReactionRef['kind']): ReactionRef => ({
    channel,
    file,
    id,
    kind,
    createdAt: '2026-06-18T00:00:00.000Z'
  });

  it('returns the kinds on the channel+file+id message only (identity, not bare id)', () => {
    const items = [
      r('ops', 'root.md', 'm1', 'ack'),
      r('ops', 'root.md', 'm1', 'seen'),
      r('ops', 'root.md', 'm2', 'done'),
      r('ops', 'thread-msg-x.md', 'm1', 'thumbs-up'), // same id, different file
      r('other', 'root.md', 'm1', 'done') // same id+file, different channel
    ];
    expect(reactionsForMessage(items, 'ops', 'root.md', 'm1')).toEqual(['ack', 'seen']);
    expect(reactionsForMessage(items, 'ops', 'root.md', 'm2')).toEqual(['done']);
    expect(reactionsForMessage(items, 'ops', 'root.md', 'nope')).toEqual([]);
  });
});

describe('deep-link + quote-reply', () => {
  it('buildMessageLink round-trips through parseMessageLink (root + thread)', () => {
    const root = buildMessageLink({ channel: 'ops', messageId: 'msg-1' });
    expect(root).toBe('desk://channels/ops/msg-1');
    expect(parseMessageLink(root)).toEqual({ channel: 'ops', messageId: 'msg-1' });
    const thread = buildMessageLink({ channel: 'ops', messageId: 'msg-2', thread: 'msg-1' });
    expect(thread).toBe('desk://channels/ops/msg-2?thread=msg-1');
    expect(parseMessageLink(thread)).toEqual({ channel: 'ops', messageId: 'msg-2', thread: 'msg-1' });
  });

  it('parseMessageLink rejects non-links (trims, returns null)', () => {
    expect(parseMessageLink('https://example.com')).toBeNull();
    expect(parseMessageLink('just text')).toBeNull();
    expect(parseMessageLink('')).toBeNull();
    expect(parseMessageLink('  desk://channels/ops/msg-1  ')).toEqual({ channel: 'ops', messageId: 'msg-1' });
  });

  it('buildQuoteReply produces a markdown blockquote with attribution + a trailing gap for the reply', () => {
    expect(buildQuoteReply({ author: 'codex', body: 'line1\nline2' })).toBe('> @codex:\n> line1\n> line2\n\n');
  });
});

describe('MessageList virtualization helpers (slice C)', () => {
  const messages = [
    msg('a', '2026-06-18 10:00:00', 'first', 'codex'),
    msg('b', '2026-06-18 10:02:00', 'second', 'codex'),
    msg('c', '2026-06-19 10:00:00', 'third', 'claude')
  ];

  it('buildMessageListRows flattens days, NEW divider, and messages in render order with stable keys', () => {
    const rows = buildMessageListRows(messages, { newDividerId: 'b', now: new Date(2026, 5, 19, 12, 0, 0) });

    expect(rows.map((row) => row.kind)).toEqual(['day', 'message', 'new-divider', 'message', 'day', 'message']);
    expect(rows.map((row) => row.key)).toEqual(['day:Yesterday:0', 'msg:a', 'new:b', 'msg:b', 'day:Today:1', 'msg:c']);
    expect(rows[1]).toMatchObject({ kind: 'message', grouped: false });
    expect(rows[3]).toMatchObject({ kind: 'message', grouped: true });
  });

  it('findMessageRowIndex targets message rows only', () => {
    const rows = buildMessageListRows(messages, { newDividerId: 'b', now: new Date(2026, 5, 19, 12, 0, 0) });

    expect(findMessageRowIndex(rows, 'b')).toBe(3);
    expect(findMessageRowIndex(rows, 'missing')).toBe(-1);
  });

  it('readProgressFromVirtualRows reports the last message when scrolled to bottom', () => {
    const rows = buildMessageListRows(messages, { now: new Date(2026, 5, 19, 12, 0, 0) });

    expect(
      readProgressFromVirtualRows(rows, [], {
        scrollOffset: 476,
        viewportHeight: 500,
        scrollHeight: 1000,
        bottomPx: 24
      })
    ).toBe('c');
  });

  it('readProgressFromVirtualRows ignores separators and reports the last fully visible message', () => {
    const rows = buildMessageListRows(messages, { newDividerId: 'b', now: new Date(2026, 5, 19, 12, 0, 0) });

    expect(
      readProgressFromVirtualRows(
        rows,
        [
          { index: 0, start: 0, end: 24 },
          { index: 1, start: 24, end: 104 },
          { index: 2, start: 104, end: 128 },
          { index: 3, start: 128, end: 208 }
        ],
        { scrollOffset: 128, viewportHeight: 400, scrollHeight: 1000, bottomPx: 24 }
      )
    ).toBe('b');
    expect(
      readProgressFromVirtualRows(
        rows,
        [
          { index: 0, start: 0, end: 24 },
          { index: 1, start: 24, end: 104 }
        ],
        { scrollOffset: 128, viewportHeight: 400, scrollHeight: 1000, bottomPx: 24, programmatic: true }
      )
    ).toBeNull();
  });
});
