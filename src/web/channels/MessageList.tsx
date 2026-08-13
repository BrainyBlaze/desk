import { Suspense, lazy, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useBleeps } from '@arwes/react';
import { AtSign, Check, CheckCheck, ChevronDown, Eye, Forward, Link2, MessageSquareReply, Pencil, Quote, Star, ThumbsUp, Trash2 } from 'lucide-react';
import { Pill } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import type { ChannelMessage, ReactionKind } from './channelsClient.js';
import type { FeedEvent, PendingTarget } from './feedPosition.js';
import {
  authorHue,
  authorInitials,
  buildMessageListRows,
  decorateMentions,
  linkifyPaths,
  messageClock,
  messageTargets,
  type MessageListRow,
  unreadIdsAfter
} from './channelsModel.js';

/** distance (px) from the bottom under which we treat the feed as "at bottom" */
const AT_BOTTOM_PX = 24;
/** how far above the day-separator the first unread is parked when anchoring */
const ANCHOR_TOP_GAP = 44;
/** dwell before a fully-visible unread block (no scrolling possible) is acked */
const FULLY_VISIBLE_DWELL_MS = 1400;
/** distance (px) from an edge at which the next lazy-load page is prefetched */
const NEAR_EDGE_PX = 300;
const CURSOR_GEN = -1;
/** viewport-hold loop: stable frames to finish, hard frame cap */
const HOLD_STABLE_FRAMES = 4;
const HOLD_MAX_FRAMES = 30;

const ChannelMarkdown = lazy(() => import('./ChannelMarkdown.js'));

/** The four frozen ReactionKind values in display order, each with its icon.
    Present kinds always show; absent ones reveal on row hover for one-click adding. */
const REACTION_KINDS: ReadonlyArray<{ kind: ReactionKind; icon: JSX.Element; label: string }> = [
  { kind: 'ack', icon: <Check size={11} />, label: 'Acknowledge' },
  { kind: 'seen', icon: <Eye size={11} />, label: 'Seen' },
  { kind: 'done', icon: <CheckCheck size={11} />, label: 'Done' },
  { kind: 'thumbs-up', icon: <ThumbsUp size={11} />, label: 'Thumbs up' }
];
const NO_REACTIONS: ReactionKind[] = [];

export interface MessageRef {
  message: ChannelMessage;
  threadParentId?: string;
}

export interface MessageScrollAnchor {
  scrollTop: number;
  messageId?: string;
  offset?: number;
  height?: number;
}

export interface MessageMenuTarget extends MessageRef {
  x: number;
  y: number;
}

/**
 * Per-row callback surface, handed to every MessageRow as a single stable ref.
 * Passing a ref (not the functions) keeps React.memo intact across the parent's
 * scroll/poll re-renders — a row only re-renders when its data props change —
 * while `.current` is read at event time, so handlers are never stale. Without
 * this, advancing the read pointer on scroll re-parsed every markdown body just
 * to toggle one .chanUnread class.
 */
interface RowApi {
  bleeps: ReturnType<typeof useBleeps<DeskBleepName>>;
  onOpenThread?: (parentId: string) => void;
  onMenu: (target: MessageMenuTarget) => void;
  onMention?: (target: MessageRef) => void;
  onShare?: (target: MessageRef) => void;
  onEdit?: (target: MessageRef) => void;
  onDelete?: (target: MessageRef) => void;
  onOpenFile: (path: string, reveal?: { line: number; column: number }) => void;
  onMentionNavigate?: (handle: string) => void;
  onToggleFeatured?: (target: MessageRef) => void;
  onDeepLink?: (target: MessageRef) => void;
  onQuoteReply?: (target: MessageRef) => void;
  onReact?: (target: MessageRef, kind: ReactionKind) => void;
}

/** One message row — memoized so unaffected rows skip re-render (and markdown
    re-parse) when the feed re-renders for scroll/poll reasons. */
const MessageRow = memo(function MessageRow({
  message,
  channel,
  handles,
  compact,
  canShare,
  threaded,
  threadParentId,
  isAnchor,
  grouped,
  unread,
  featured,
  threadFresh,
  cursor,
  reactions,
  api
}: {
  message: ChannelMessage;
  channel: string;
  handles: string[];
  compact: boolean;
  canShare: boolean;
  /** thread affordances apply (full feed, not the compact thread view) */
  threaded: boolean;
  threadParentId?: string;
  isAnchor: boolean;
  grouped: boolean;
  unread: boolean;
  featured: boolean;
  threadFresh: boolean;
  /** the keyboard-nav cursor is on this row — drives the cursor highlight */
  cursor: boolean;
  /** reaction kinds present on this message */
  reactions: ReactionKind[];
  api: MutableRefObject<RowApi>;
}): JSX.Element {
  const decorated = useMemo(() => linkifyPaths(decorateMentions(message.body, handles)), [message.body, handles]);
  const pingsHuman = messageTargets(message.body, 'human') && message.author !== 'human';
  const ref: MessageRef = { message, threadParentId: isAnchor ? undefined : threadParentId };

  const quickAction = (label: string, icon: JSX.Element, action: (() => void) | undefined): JSX.Element | null =>
    action ? (
      <button
        key={label}
        type="button"
        className="chanQuickAction"
        title={label}
        aria-label={label}
        onMouseEnter={() => api.current.bleeps.hover?.play()}
        onClick={(event) => {
          event.stopPropagation();
          api.current.bleeps.click?.play();
          action();
        }}
      >
        {icon}
      </button>
    ) : null;

  const actions = (
    <span className="chanQuickActions">
      {threaded ? quickAction('Reply in thread', <MessageSquareReply size={12} />, () => api.current.onOpenThread?.(message.id)) : null}
      {quickAction('Quote reply', <Quote size={12} />, api.current.onQuoteReply && (() => api.current.onQuoteReply!(ref)))}
      {quickAction(`Mention @${message.author}`, <AtSign size={12} />, api.current.onMention && (() => api.current.onMention!(ref)))}
      {quickAction('Copy message link', <Link2 size={12} />, api.current.onDeepLink && (() => api.current.onDeepLink!(ref)))}
      {canShare ? quickAction('Share to channel…', <Forward size={12} />, api.current.onShare && (() => api.current.onShare!(ref))) : null}
      {quickAction(
        featured ? 'Unstar message' : 'Star message',
        <Star size={12} fill={featured ? 'currentColor' : 'none'} />,
        api.current.onToggleFeatured && (() => api.current.onToggleFeatured!(ref))
      )}
      {quickAction('Edit message', <Pencil size={12} />, api.current.onEdit && (() => api.current.onEdit!(ref)))}
      {quickAction('Delete message', <Trash2 size={12} />, api.current.onDelete && (() => api.current.onDelete!(ref)))}
    </span>
  );

  const body = (
    <Suspense fallback={<pre className="chanBodyFallback">{message.body}</pre>}>
      <ChannelMarkdown
        body={decorated}
        channel={channel}
        onOpenFile={api.current.onOpenFile}
        onMentionClick={api.current.onMentionNavigate}
      />
    </Suspense>
  );

  const threadChip = message.threadFile ? (
    <button
      type="button"
      className={`chanThreadChip${threadFresh ? ' chanThreadChipFresh' : ''}`}
      onClick={() => api.current.onOpenThread?.(message.id)}
    >
      <MessageSquareReply size={11} />
      <span>
        {message.threadReplies ?? 0} {message.threadReplies === 1 ? 'reply' : 'replies'}
      </span>
      {threadFresh ? <span className="chanThreadChipDot" /> : null}
    </button>
  ) : null;

  // reactions: render all four frozen kinds; present ones stay visible, absent
  // ones reveal on row hover (CSS) so they can be added with one click. Each kind
  // toggles via onReact. The store coalesces per kind, so this is a boolean toggle.
  const reactionsStrip = api.current.onReact ? (
    <div className="chanReactions">
      {REACTION_KINDS.map(({ kind, icon, label }) => {
        const on = reactions.includes(kind);
        return (
          <button
            key={kind}
            type="button"
            className={`chanReaction ${on ? 'chanReactionOn' : 'chanReactionOff'}`}
            title={on ? `Remove ${label}` : label}
            aria-label={on ? `Remove reaction: ${label}` : `React: ${label}`}
            aria-pressed={on}
            onClick={(event) => {
              event.stopPropagation();
              api.current.bleeps.click?.play();
              api.current.onReact!(ref, kind);
            }}
          >
            {icon}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <article
      className={`chanMessage hue-${authorHue(message.author)} ${message.author === 'human' ? 'fromHuman' : ''} ${
        pingsHuman ? 'pingsHuman' : ''
      } ${grouped ? 'grouped' : ''} ${isAnchor ? 'threadAnchor' : ''} ${unread ? 'chanUnread' : ''} ${cursor ? 'chanCursor' : ''}`}
      data-msg-id={message.id}
      tabIndex={cursor ? 0 : -1}
      aria-current={cursor ? 'true' : undefined}
      onContextMenu={(event: React.MouseEvent) => {
        event.preventDefault();
        api.current.onMenu({ ...ref, x: event.clientX, y: event.clientY });
      }}
    >
      {grouped ? (
        <>
          <span className="chanGutterTime" title={message.timestamp}>
            {messageClock(message.timestamp)}
          </span>
          <div className="chanMessageRight">
            <div className="chanMessageHead slim">
              <span className="chanMsgId">{message.id}</span>
              {actions}
            </div>
            {body}
            {reactionsStrip}
            {threaded && (message.threadFile || pingsHuman) ? (
              <div className="chanMessageFoot">
                {threadChip}
                {pingsHuman ? <Pill tone="warn">@human</Pill> : null}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <span
            className={`chanAvatar hue-${authorHue(message.author)} ${message.author === 'human' ? 'human' : ''}`}
            aria-hidden="true"
          >
            {authorInitials(message.author)}
          </span>
          <div className="chanMessageRight">
            <div className="chanMessageHead">
              <span className="chanAuthor">@{message.author}</span>
              <span className="chanTime" title={message.timestamp}>
                {messageClock(message.timestamp)}
              </span>
              <span className="chanMsgId">{message.id}</span>
              {actions}
            </div>
            {body}
            {reactionsStrip}
            {threaded ? (
              <div className="chanMessageFoot">
                {threadChip}
                {pingsHuman ? <Pill tone="warn">@human</Pill> : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </article>
  );
});

/**
 * Scrollable message feed: octagon avatars with run-grouping (header once per
 * author run), sticky day separators, NEW divider at the first unread
 * message, latest-by-default anchoring, markdown bodies, thread affordances,
 * @human glow, and the hover action bar.
 */
export function MessageList({
  channel,
  messages,
  handles,
  threadParentId,
  anchorId,
  compact = false,
  canShare = false,
  newDividerId,
  unreadFromId,
  command,
  onFeedEvent,
  onLeaveAck,
  following = false,
  active = true,
  hasOlder = false,
  hasNewer = false,
  onLoadOlder,
  onLoadNewer,
  onJumpLatest,
  onScrollPosition,
  onOpenThread,
  onMenu,
  onMention,
  onShare,
  onEdit,
  onDelete,
  onOpenFile,
  onMentionNavigate,
  featuredIds,
  threadSeen,
  onToggleFeatured,
  onDeepLink,
  onQuoteReply,
  cursorId,
  onReact,
  reactionsById
}: {
  channel: string;
  messages: ChannelMessage[];
  handles: string[];
  /** set when this list renders a thread (affects action payloads) */
  threadParentId?: string;
  /** the thread's root message rendered inline: highlighted, and its action
      payloads stay root-targeted (it lives in root.md, not the thread file) */
  anchorId?: string;
  /** thread flavour: tighter rows, no thread affordances */
  compact?: boolean;
  canShare?: boolean;
  /** message id that starts the unread region and renders the NEW divider */
  newDividerId?: string | null;
  /** live read pointer: messages after this id get the unread highlight; it
      advances as the operator scrolls, so the glow clears from the top down */
  unreadFromId?: string | null;
  /** latest scrollTo command from the feed-position reducer; executed once per gen */
  command?: { target: PendingTarget; gen: number } | null;
  /** feed events out: USER_SCROLL / PROGRAMMATIC_DONE / SCROLLED_PAST / ACK_VISIBLE / REFLOW */
  onFeedEvent?: (event: FeedEvent) => void;
  /** persist the last settled read candidate when the operator leaves the channel */
  onLeaveAck?: (channel: string, messageId: string) => void;
  /** reducer viewport is follow-bottom: reflow re-pins and newer pages auto-load */
  following?: boolean;
  /** false while the subsystem is hidden; hidden layout changes must not mutate scroll/read state */
  active?: boolean;
  /** lazy load: older/newer pages exist beyond the loaded window */
  hasOlder?: boolean;
  hasNewer?: boolean;
  /** fetch + prepend the previous page when the operator scrolls near the top */
  onLoadOlder?: () => void | Promise<void>;
  /** fetch + append the next page when the operator scrolls near the bottom */
  onLoadNewer?: () => void | Promise<void>;
  /** jump to the channel tail — the reducer issues the scroll, the subsystem reloads newer pages */
  onJumpLatest?: () => void;
  onScrollPosition?: (channel: string, anchor: MessageScrollAnchor) => void;
  onOpenThread?: (parentId: string) => void;
  onMenu: (target: MessageMenuTarget) => void;
  onMention?: (target: MessageRef) => void;
  onShare?: (target: MessageRef) => void;
  onEdit?: (target: MessageRef) => void;
  onDelete?: (target: MessageRef) => void;
  onOpenFile: (path: string, reveal?: { line: number; column: number }) => void;
  /** navigate to the member behind a clicked mention chip */
  onMentionNavigate?: (handle: string) => void;
  /** ids featured in THIS file context (root vs thread) — drives the row star fill */
  featuredIds?: Set<string>;
  threadSeen?: Record<string, number>;
  onToggleFeatured?: (target: MessageRef) => void;
  /** copy a deep-link to the message; quote the message into the composer */
  onDeepLink?: (target: MessageRef) => void;
  onQuoteReply?: (target: MessageRef) => void;
  /** keyboard-nav cursor — the row with this id gets the cursor highlight */
  cursorId?: string | null;
  /** toggle a reaction kind on a message */
  onReact?: (target: MessageRef, kind: ReactionKind) => void;
  /** reaction kinds present per message id in THIS file context */
  reactionsById?: Map<string, ReactionKind[]>;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
    };
  }, []);
  const activeRef = useRef(active);
  activeRef.current = active;
  // The cursor id we last scrolled/focused, so a poll append (new `rows`) does
  // not re-yank the viewport or re-steal focus for an unchanged cursor.
  const cursorHandledRef = useRef<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const messagesRef = useRef<ChannelMessage[]>(messages);
  messagesRef.current = messages;
  const onFeedEventRef = useRef(onFeedEvent);
  onFeedEventRef.current = onFeedEvent;
  const onLeaveAckRef = useRef(onLeaveAck);
  onLeaveAckRef.current = onLeaveAck;
  const scrollRafRef = useRef<number | null>(null);
  const dwellRef = useRef<number | null>(null);
  // Lazy load: one page fetch in flight at a time.
  const loadPendingRef = useRef(false);
  const reflowingRef = useRef(false);
  const lastAnchorRef = useRef<MessageScrollAnchor | null>(null);
  const feedBoxRef = useRef<{ width: number; height: number } | null>(null);
  const expectationsRef = useRef<Map<number, { value: number; at: number }>>(new Map());
  const executedGenRef = useRef(0);
  const completionRef = useRef<{ gen: number; timer: number } | null>(null);
  const settledCandidateRef = useRef<string | null>(null);

  const rows = useMemo(() => buildMessageListRows(messages, { compact }), [messages, compact]);
  const rowsRef = useRef<MessageListRow[]>(rows);
  rowsRef.current = rows;
  const unreadIds = useMemo(() => unreadIdsAfter(messages, unreadFromId), [messages, unreadFromId]);

  const captureScrollAnchor = (): MessageScrollAnchor | null => {
    const node = scrollRef.current;
    if (!node) {
      return null;
    }
    const feedRect = node.getBoundingClientRect();
    if (node.clientHeight <= 0 || feedRect.height <= 0) {
      return null;
    }
    const firstVisible = [...node.querySelectorAll<HTMLElement>('[data-msg-id]')].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > feedRect.top && rect.top < feedRect.bottom;
    });
    if (!firstVisible) {
      return { scrollTop: node.scrollTop };
    }
    const rect = firstVisible.getBoundingClientRect();
    return {
      scrollTop: node.scrollTop,
      messageId: firstVisible.dataset.msgId,
      offset: rect.top - feedRect.top,
      height: rect.height
    };
  };

  const followingRef = useRef(following);
  followingRef.current = following;

  const rememberScrollPosition = (): void => {
    if (!activeRef.current) {
      return;
    }
    const anchor = captureScrollAnchor();
    if (anchor) {
      lastAnchorRef.current = anchor;
      onScrollPosition?.(channel, anchor);
    }
  };

  const rowElementById = (messageId: string | null | undefined): HTMLElement | null => {
    const node = scrollRef.current;
    if (!node || !messageId) {
      return null;
    }
    const escaped =
      typeof window.CSS?.escape === 'function' ? window.CSS.escape(messageId) : messageId.replace(/["\\]/g, '\\$&');
    return node.querySelector<HTMLElement>(`[data-msg-id="${escaped}"]`);
  };

  const rowScrollTop = (el: HTMLElement): number => {
    const node = scrollRef.current;
    if (!node) {
      return 0;
    }
    return el.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
  };

  const scrollToMessage = (messageId: string | null | undefined, align: 'start' | 'center' | 'end' | 'auto'): boolean => {
    const node = scrollRef.current;
    const el = rowElementById(messageId);
    if (!node || !el) {
      return false;
    }
    if (align === 'auto') {
      el.scrollIntoView({ block: 'nearest' });
      return true;
    }
    const top = rowScrollTop(el);
    const target =
      align === 'start' ? top : align === 'end' ? top - node.clientHeight + el.getBoundingClientRect().height : top - node.clientHeight / 2;
    node.scrollTop = Math.max(0, target);
    return true;
  };

  const certifyScroll = (scrollTop: number): number | null => {
    const now = performance.now();
    for (const [gen, echo] of expectationsRef.current) {
      if (now - echo.at > 400) {
        expectationsRef.current.delete(gen);
        continue;
      }
      if (Math.abs(scrollTop - echo.value) <= 2) {
        expectationsRef.current.delete(gen);
        return gen;
      }
    }
    return null;
  };


  const executeTarget = (target: PendingTarget, gen: number): boolean => {
    const node = scrollRef.current;
    if (!node) {
      return false;
    }
    let resolved = true;
    if (target.kind === 'bottom') {
      node.scrollTop = node.scrollHeight;
    } else if (target.kind === 'message') {
      resolved = scrollToMessage(target.messageId, target.align);
    } else {
      const gap = target.kind === 'first-unread' ? ANCHOR_TOP_GAP : target.offsetPx;
      const el = rowElementById(target.messageId);
      if (el) {
        node.scrollTop = Math.max(0, rowScrollTop(el) - gap);
      } else if (target.kind === 'restore') {
        node.scrollTop = Math.max(0, Math.min(node.scrollTop, node.scrollHeight - node.clientHeight));
      } else {
        resolved = false;
      }
    }
    expectationsRef.current.set(gen, { value: node.scrollTop, at: performance.now() });
    return resolved;
  };

  const readProgressFromDom = (mode?: 'scrolled-past'): string | null => {
    const node = scrollRef.current;
    if (!node) {
      return null;
    }
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (mode !== 'scrolled-past' && fromBottom <= AT_BOTTOM_PX) {
      return messagesRef.current[messagesRef.current.length - 1]?.id ?? null;
    }
    const feedRect = node.getBoundingClientRect();
    const limit = mode === 'scrolled-past' ? feedRect.top : feedRect.bottom - 4;
    let last: string | null = null;
    for (const el of node.querySelectorAll<HTMLElement>('[data-msg-id]')) {
      if (el.getBoundingClientRect().bottom <= limit) {
        last = el.dataset.msgId ?? last;
      } else {
        break;
      }
    }
    return last;
  };

  const scheduleDwellRef = useRef<() => void>(() => {});
  const scheduleDwell = (): void => {
    if (dwellRef.current) {
      window.clearTimeout(dwellRef.current);
    }
    dwellRef.current = window.setTimeout(() => {
      dwellRef.current = null;
      const node = scrollRef.current;
      if (!node) {
        return;
      }
      const readId = readProgressFromDom();
      if (readId) {
        settledCandidateRef.current = readId;
        onFeedEventRef.current?.({ type: 'ACK_VISIBLE', messageId: readId });
      }
    }, FULLY_VISIBLE_DWELL_MS);
  };
  scheduleDwellRef.current = scheduleDwell;

  useLayoutEffect(() => {
    if (!command || command.gen <= executedGenRef.current || rows.length === 0) {
      return;
    }
    expectationsRef.current.clear();
    if (!executeTarget(command.target, command.gen)) {
      expectationsRef.current.clear();
      return;
    }
    executedGenRef.current = command.gen;
    if (completionRef.current !== null) {
      window.clearTimeout(completionRef.current.timer);
    }
    const complete = (): void => {
      if (completionRef.current?.gen !== command.gen) {
        return;
      }
      window.clearTimeout(completionRef.current.timer);
      completionRef.current = null;
      const node = scrollRef.current;
      if (!node) {
        return;
      }
      const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      const anchor = captureScrollAnchor();
      onFeedEventRef.current?.({
        type: 'PROGRAMMATIC_DONE',
        gen: command.gen,
        atBottom: fromBottom <= 80,
        firstVisibleId: anchor?.messageId ?? null,
        offsetPx: anchor?.offset ?? 0
      });
      rememberScrollPosition();
      setShowJump(fromBottom > 360);
      scheduleDwell();
    };
    completionRef.current = {
      gen: command.gen,
      timer: window.setTimeout(() => {
        executeTarget(command.target, command.gen);
        complete();
      }, 300)
    };
    const first = window.requestAnimationFrame(() => {
      executeTarget(command.target, command.gen);
      window.requestAnimationFrame(complete);
    });
    return () => {
      window.cancelAnimationFrame(first);
    };
    // completion must not be cancelled by a rows-identity re-run — it lives in completionRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, rows]);

  const flowPrevRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    // day separator rows collapse across same-day prepends, so the atomic
    // head change is only visible on the first MESSAGE id
    const firstId = messages[0]?.id ?? null;
    const prevFirstId = flowPrevRef.current;
    flowPrevRef.current = firstId;
    if (prevFirstId === null || firstId === null || prevFirstId === firstId || followingRef.current) {
      return;
    }
    // Correct the anchor SYNCHRONOUSLY before paint so a fast fling's momentum
    // never sees the pre-compensation position; the hold loop then settles late
    // markdown-height changes on the newly revealed rows.
    const node = scrollRef.current;
    const anchor = lastAnchorRef.current;
    if (node && anchor?.messageId !== undefined && anchor.offset !== undefined) {
      const el = rowElementById(anchor.messageId);
      if (el) {
        const displacement = el.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(displacement) > 1) {
          node.scrollTop += displacement;
          expectationsRef.current.set(CURSOR_GEN, { value: node.scrollTop, at: performance.now() });
        }
      }
    }
    holdViewportRef.current();
  });

  const staticPinRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (onFeedEvent || rows.length === 0) {
      return;
    }
    const pinKey = compact ? `${channel}#${anchorId ?? ''}` : `${channel}#filtered`;
    if (staticPinRef.current === pinKey) {
      return;
    }
    staticPinRef.current = pinKey;
    const node = scrollRef.current;
    if (compact && anchorId) {
      if (scrollToMessage(anchorId, 'start') && node) {
        node.scrollTop = Math.max(0, node.scrollTop - ANCHOR_TOP_GAP);
      }
    } else if (node) {
      node.scrollTop = node.scrollHeight;
    }
    // pin once per target; scrollToMessage/rowsRef read live, not reactive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFeedEvent, compact, anchorId, channel, rows.length]);

  const holdRafRef = useRef<number | null>(null);
  const holdViewport = (): void => {
    if (holdRafRef.current !== null) {
      window.cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    const following = followingRef.current;
    const anchor = following ? null : lastAnchorRef.current;
    if (!following && (anchor === null || anchor.messageId === undefined || anchor.offset === undefined)) {
      return;
    }
    if (!reflowingRef.current) {
      onFeedEventRef.current?.({ type: 'REFLOW', active: true });
    }
    reflowingRef.current = true;
    let frames = 0;
    let stable = 0;
    const correct = (): boolean => {
      const node = scrollRef.current;
      if (!node) {
        return false;
      }
      if (anchor === null) {
        if (node.scrollHeight - node.scrollTop - node.clientHeight > 1) {
          node.scrollTop = node.scrollHeight;
          expectationsRef.current.set(CURSOR_GEN, { value: node.scrollTop, at: performance.now() });
          return true;
        }
        return false;
      }
      const el = rowElementById(anchor.messageId);
      if (!el) {
        return false;
      }
      const displacement = el.getBoundingClientRect().top - node.getBoundingClientRect().top - (anchor.offset ?? 0);
      if (Math.abs(displacement) > 1) {
        node.scrollTop = node.scrollTop + displacement;
        expectationsRef.current.set(CURSOR_GEN, { value: node.scrollTop, at: performance.now() });
        return true;
      }
      return false;
    };
    const finish = (): void => {
      holdRafRef.current = null;
      reflowingRef.current = false;
      onFeedEventRef.current?.({ type: 'REFLOW', active: false });
      rememberScrollPosition();
      scheduleDwellRef.current();
    };
    const step = (): void => {
      frames += 1;
      stable = correct() ? 0 : stable + 1;
      if (stable >= HOLD_STABLE_FRAMES || frames >= HOLD_MAX_FRAMES) {
        finish();
        return;
      }
      holdRafRef.current = window.requestAnimationFrame(step);
    };
    correct();
    holdRafRef.current = window.requestAnimationFrame(step);
  };
  const holdViewportRef = useRef(holdViewport);
  holdViewportRef.current = holdViewport;
  useEffect(() => {
    return () => {
      if (holdRafRef.current !== null) {
        window.cancelAnimationFrame(holdRafRef.current);
        holdRafRef.current = null;
      }
      reflowingRef.current = false;
    };
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) {
        return;
      }
      const prev = feedBoxRef.current;
      feedBoxRef.current = { width: box.width, height: box.height };
      if (!prev || box.width <= 0 || box.height <= 0) {
        return;
      }
      if (prev.width === box.width && prev.height === box.height) {
        return;
      }
      if (dwellRef.current) {
        window.clearTimeout(dwellRef.current);
        dwellRef.current = null;
      }
      holdViewportRef.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (hasNewer && followingRef.current && onLoadNewer && !loadPendingRef.current) {
      loadPendingRef.current = true;
      void Promise.resolve(onLoadNewer()).finally(() => {
        loadPendingRef.current = false;
      });
    }
    // followingRef/loadPendingRef read live; only the append signal is reactive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNewer, messages]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (dwellRef.current) {
        window.clearTimeout(dwellRef.current);
        dwellRef.current = null;
      }
      if (completionRef.current !== null) {
        window.clearTimeout(completionRef.current.timer);
        completionRef.current = null;
      }
      const candidate = settledCandidateRef.current;
      settledCandidateRef.current = null;
      if (candidate) {
        onLeaveAckRef.current?.(channel, candidate);
      }
    };
    // flushes to the channel being LEFT — the reducer has already moved on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  const handleScroll = (): void => {
    const scrollNode = scrollRef.current;
    if (scrollNode) {
      if (scrollIdleTimerRef.current === null) {
        scrollNode.classList.add('chanFeedScrolling');
      } else {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        scrollRef.current?.classList.remove('chanFeedScrolling');
      }, 140);
    }
    if (!activeRef.current) {
      return;
    }
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setShowJump(fromBottom > 360);
    // Always drain a matching echo so a self-write's expectation cannot linger
    // and falsely certify a later genuine scroll landing near it.
    const certifiedGen = certifyScroll(node.scrollTop);
    if (reflowingRef.current) {
      return;
    }
    const anchor = captureScrollAnchor();
    onFeedEventRef.current?.({
      type: 'USER_SCROLL',
      firstVisibleId: anchor?.messageId ?? null,
      offsetPx: anchor?.offset ?? 0,
      atBottom: fromBottom < 80,
      certifiedGen
    });
    if (certifiedGen === null && anchor) {
      lastAnchorRef.current = anchor;
      onScrollPosition?.(channel, anchor);
    }

    if (certifiedGen === null && hasOlder && onLoadOlder && !loadPendingRef.current && node.scrollTop < NEAR_EDGE_PX) {
      loadPendingRef.current = true;
      void Promise.resolve(onLoadOlder()).finally(() => {
        loadPendingRef.current = false;
      });
    }
    if (certifiedGen === null && hasNewer && onLoadNewer && !loadPendingRef.current && fromBottom < NEAR_EDGE_PX) {
      loadPendingRef.current = true;
      void Promise.resolve(onLoadNewer()).finally(() => {
        loadPendingRef.current = false;
      });
    }

    if (scrollRafRef.current) {
      return;
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (reflowingRef.current) {
        return;
      }
      const inner = scrollRef.current;
      if (!inner) {
        return;
      }
      const settled = readProgressFromDom();
      if (settled) {
        settledCandidateRef.current = settled;
      }
      const atBottom = inner.scrollHeight - inner.scrollTop - inner.clientHeight <= AT_BOTTOM_PX;
      const readId = atBottom && settled ? settled : readProgressFromDom('scrolled-past');
      if (readId) {
        onFeedEventRef.current?.({ type: 'SCROLLED_PAST', messageId: readId, certifiedGen });
      }
    });
    scheduleDwell();
  };

  // Stable callback surface for the rows: a ref so MessageRow's React.memo holds
  // across re-renders, refreshed each render so the handlers stay current.
  const apiRef = useRef<RowApi>({ bleeps, onMenu, onOpenFile });
  apiRef.current = { bleeps, onOpenThread, onMenu, onMention, onShare, onEdit, onDelete, onOpenFile, onMentionNavigate, onToggleFeatured, onDeepLink, onQuoteReply, onReact };
  const threaded = !compact && Boolean(onOpenThread);

  useLayoutEffect(() => {
    if (!cursorId) {
      cursorHandledRef.current = null;
      return;
    }
    // Act only when the cursor actually MOVES (j/k, a deep link, a jump). `rows`
    // is in the deps so the cursor is scrolled into view when the list first
    // renders it, but every 2.5s poll append also mints a new `rows` identity —
    // re-running here on every tick used to yank the viewport back to the cursor
    // and steal focus from the composer mid-typing. Guard on a genuine change.
    if (cursorHandledRef.current === cursorId) {
      return;
    }
    if (!rowElementById(cursorId)) {
      return;
    }
    cursorHandledRef.current = cursorId;
    const focusCursor = (): void => {
      const node = scrollRef.current;
      if (!node) {
        return;
      }
      // Never pull focus out of a form control while agents chat.
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable)
      ) {
        return;
      }
      const escaped =
        typeof window.CSS?.escape === 'function' ? window.CSS.escape(cursorId) : cursorId.replace(/["\\]/g, '\\$&');
      const row = node.querySelector<HTMLElement>(`[data-msg-id="${escaped}"]`);
      row?.focus({ preventScroll: true });
    };
    let second: number | undefined;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(focusCursor);
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second !== undefined) {
        window.cancelAnimationFrame(second);
      }
    };
    // scrollToMessage is stable for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorId, rows]);

  // Lists with no reducer (thread pane, filtered view) bring the cursor into
  // view themselves. A one-shot rAF loses the race twice — an unrelated
  // re-render cancels it, and late markdown heights drift the row after it — so
  // re-assert until the row's position holds. Restarts only on a genuine cursor
  // change; a mid-flight re-render must not abort it.
  const cursorScrollRafRef = useRef<number | null>(null);
  const cursorScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (onFeedEvent) {
      return;
    }
    if (!cursorId) {
      cursorScrolledRef.current = null;
      return;
    }
    if (cursorScrolledRef.current === cursorId || !rowElementById(cursorId)) {
      return;
    }
    cursorScrolledRef.current = cursorId;
    if (cursorScrollRafRef.current !== null) {
      window.cancelAnimationFrame(cursorScrollRafRef.current);
    }
    let frames = 0;
    let lastTop = Number.NaN;
    let stable = 0;
    const settle = (): void => {
      cursorScrollRafRef.current = null;
      const el = rowElementById(cursorId);
      if (!el) {
        return;
      }
      scrollToMessage(cursorId, 'center');
      const top = Math.round(el.getBoundingClientRect().top);
      stable = Math.abs(top - lastTop) <= 1 ? stable + 1 : 0;
      lastTop = top;
      frames += 1;
      if (stable >= 3 || frames >= 20) {
        return;
      }
      cursorScrollRafRef.current = window.requestAnimationFrame(settle);
    };
    settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorId, rows, onFeedEvent]);

  useEffect(
    () => () => {
      if (cursorScrollRafRef.current !== null) {
        window.cancelAnimationFrame(cursorScrollRafRef.current);
      }
    },
    []
  );

  const renderVirtualRow = (row: MessageListRow): JSX.Element => {
    if (row.kind === 'day') {
      return (
        <div className="chanDaySeparator">
          <span className="chanDayLine" />
          <span className="chanDayLabel">{row.dayLabel}</span>
          <span className="chanDayLine" />
        </div>
      );
    }
    const message = row.message;
    const isAnchor = anchorId !== undefined && message.id === anchorId;
    const dividerHere = newDividerId != null && message.id === newDividerId;
    return (
      <>
        {dividerHere ? (
          <div className="chanNewDivider chanNewDividerOverlay" aria-label="New messages">
            <span className="chanDayLine" />
            <span className="chanNewLabel">NEW</span>
          </div>
        ) : null}
        <MessageRow
            message={message}
          channel={channel}
          handles={handles}
          compact={compact}
          canShare={canShare}
          threaded={threaded}
          threadParentId={threadParentId}
          isAnchor={isAnchor}
          grouped={!compact && row.grouped}
          unread={unreadIds.has(message.id)}
          featured={featuredIds?.has(message.id) ?? false}
          threadFresh={
            threaded && Boolean(message.threadFile) && (message.threadReplies ?? 0) > (threadSeen?.[message.id] ?? 0)
          }
          cursor={cursorId != null && cursorId === message.id}
          reactions={reactionsById?.get(message.id) ?? NO_REACTIONS}
          api={apiRef}
        />
      </>
    );
  };

  return (
    <div className="chanFeedWrap">
      <div
        ref={scrollRef}
        className={`chanFeed ${compact ? 'compact' : ''}`}
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <div className="chanFeedEmpty">No messages yet — say something below.</div>
        ) : (
          <div className="chanFlowInner">
            {rows.map((row) => (
              <div key={row.key} className="chanFlowRow">
                {renderVirtualRow(row)}
              </div>
            ))}
          </div>
        )}
      </div>
      {showJump ? (
        <button
          type="button"
          className="chanJumpLatest"
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
            setShowJump(false);
            onJumpLatest?.();
          }}
        >
          <ChevronDown size={12} />
          <span>latest</span>
        </button>
      ) : null}
    </div>
  );
}
