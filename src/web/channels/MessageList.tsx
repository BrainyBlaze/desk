import { Suspense, lazy, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBleeps } from '@arwes/react';
import { AtSign, Check, CheckCheck, ChevronDown, Eye, Forward, Link2, MessageSquareReply, Pencil, Quote, Star, ThumbsUp, Trash2 } from 'lucide-react';
import { Pill } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import type { ChannelMessage, ReactionKind } from './channelsClient.js';
import {
  authorHue,
  authorInitials,
  buildMessageListRows,
  decorateMentions,
  findMessageRowIndex,
  linkifyPaths,
  messageClock,
  messageTargets,
  readProgressFromVirtualRows,
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
  onOpenFile: (path: string) => void;
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
    <button type="button" className="chanThreadChip" onClick={() => api.current.onOpenThread?.(message.id)}>
      <MessageSquareReply size={11} />
      <span>
        {message.threadReplies ?? 0} {message.threadReplies === 1 ? 'reply' : 'replies'}
      </span>
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
  anchorKey,
  restoreScrollAnchor,
  active = true,
  hasOlder = false,
  hasNewer = false,
  onLoadOlder,
  onLoadNewer,
  onJumpLatest,
  onReadProgress,
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
  /** changes when a fresh channel/thread visit should apply its initial anchor */
  anchorKey?: string;
  /** false while the subsystem is hidden; hidden layout changes must not mutate scroll/read state */
  active?: boolean;
  /** saved per-channel viewport anchor to restore when switching back to a memoized chat */
  restoreScrollAnchor?: MessageScrollAnchor | null;
  /** lazy load: older/newer pages exist beyond the loaded window */
  hasOlder?: boolean;
  hasNewer?: boolean;
  /** fetch + prepend the previous page when the operator scrolls near the top */
  onLoadOlder?: () => void | Promise<void>;
  /** fetch + append the next page when the operator scrolls near the bottom */
  onLoadNewer?: () => void | Promise<void>;
  /** reload the newest window (used by the latest pill when newer pages exist) */
  onJumpLatest?: () => void;
  /** report the last message the operator has read past (forward-only upstream) */
  onReadProgress?: (lastReadId: string) => void;
  onScrollPosition?: (channel: string, anchor: MessageScrollAnchor) => void;
  onOpenThread?: (parentId: string) => void;
  onMenu: (target: MessageMenuTarget) => void;
  onMention?: (target: MessageRef) => void;
  onShare?: (target: MessageRef) => void;
  onEdit?: (target: MessageRef) => void;
  onDelete?: (target: MessageRef) => void;
  onOpenFile: (path: string) => void;
  /** navigate to the member behind a clicked mention chip */
  onMentionNavigate?: (handle: string) => void;
  /** ids featured in THIS file context (root vs thread) — drives the row star fill */
  featuredIds?: Set<string>;
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
  const activeRef = useRef(active);
  activeRef.current = active;
  const stickToBottomRef = useRef(true);
  const lastIdRef = useRef<string | null>(null);
  // The cursor id we last scrolled/focused, so a poll append (new `rows`) does
  // not re-yank the viewport or re-steal focus for an unchanged cursor.
  const cursorHandledRef = useRef<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  // Anchor/read bookkeeping. Refs (not state) so the scroll handler can read
  // the latest values without re-subscribing and without re-rendering.
  const messagesRef = useRef<ChannelMessage[]>(messages);
  messagesRef.current = messages;
  const anchoredKeyRef = useRef<string | null>(null);
  const reportedReadRef = useRef<string | null>(null);
  const onReadProgressRef = useRef(onReadProgress);
  onReadProgressRef.current = onReadProgress;
  const scrollRafRef = useRef<number | null>(null);
  const dwellRef = useRef<number | null>(null);
  // True while we are scripting the scroll (anchor jump / stick-to-bottom): the
  // scroll handler must not treat our own scroll as the operator reading.
  const programmaticScrollRef = useRef(false);
  const anchorCleanupRef = useRef<(() => void) | null>(null);
  // Lazy load: one page fetch in flight at a time.
  const loadPendingRef = useRef(false);

  const rows = useMemo(() => buildMessageListRows(messages, { newDividerId, compact }), [messages, newDividerId, compact]);
  const rowsRef = useRef<MessageListRow[]>(rows);
  rowsRef.current = rows;
  const unreadIds = useMemo(() => unreadIdsAfter(messages, unreadFromId), [messages, unreadFromId]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.kind === 'day') {
        return 34;
      }
      if (row?.kind === 'new-divider') {
        return 28;
      }
      return compact ? 76 : 104;
    },
    overscan: 10
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

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
      offset: rect.top - feedRect.top
    };
  };

  const rememberScrollPosition = (): void => {
    if (!activeRef.current) {
      return;
    }
    const anchor = captureScrollAnchor();
    if (anchor) {
      onScrollPosition?.(channel, anchor);
    }
  };

  const scrollToBottom = (): void => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    if (rowsRef.current.length > 0) {
      virtualizer.scrollToIndex(rowsRef.current.length - 1, { align: 'end' });
    }
    node.scrollTop = node.scrollHeight;
  };

  const scrollToMessage = (messageId: string | null | undefined, align: 'start' | 'center' | 'end' | 'auto'): boolean => {
    const index = findMessageRowIndex(rowsRef.current, messageId);
    if (index === -1) {
      return false;
    }
    virtualizer.scrollToIndex(index, { align });
    return true;
  };

  // Fully-visible messages are acked after a short dwell so the NEW marker
  // clears when the operator has actually viewed them, not only after they
  // scroll off the top.
  const scheduleVisibleAck = (): void => {
    if (dwellRef.current) {
      window.clearTimeout(dwellRef.current);
      dwellRef.current = null;
    }
    if (!onReadProgressRef.current) {
      return;
    }
    dwellRef.current = window.setTimeout(() => {
      dwellRef.current = null;
      const node = scrollRef.current;
      const report = onReadProgressRef.current;
      if (!node || !report) {
        return;
      }
      const readId = readProgressFromVirtualRows(rowsRef.current, virtualizer.getVirtualItems(), {
        scrollOffset: node.scrollTop,
        viewportHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        bottomPx: AT_BOTTOM_PX
      });
      if (readId && readId !== reportedReadRef.current) {
        reportedReadRef.current = readId;
        report(readId);
      }
    }, FULLY_VISIBLE_DWELL_MS);
  };

  // Fresh visit: restore the memoized viewport, jump to an explicit source
  // message (including first unread on initial load), or default to chat
  // behavior: pin to latest.
  useLayoutEffect(() => {
    const key = anchorKey ?? 'static';
    if (anchoredKeyRef.current === key) {
      return;
    }
    if (rows.length === 0) {
      return; // wait for the channel's messages to land, then anchor
    }
    anchoredKeyRef.current = key;
    reportedReadRef.current = null;
    lastIdRef.current = messages[messages.length - 1]?.id ?? null;
    anchorCleanupRef.current?.();
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    if (restoreScrollAnchor) {
      programmaticScrollRef.current = true;
      const applyRestore = (): void => {
        const inner = scrollRef.current;
        if (!inner) {
          return;
        }
        if (Number.isFinite(restoreScrollAnchor.scrollTop)) {
          inner.scrollTop = Math.max(0, Math.min(restoreScrollAnchor.scrollTop, inner.scrollHeight - inner.clientHeight));
        } else if (restoreScrollAnchor.messageId && scrollToMessage(restoreScrollAnchor.messageId, 'start')) {
          if (restoreScrollAnchor.offset !== undefined) {
            inner.scrollTop = Math.max(0, inner.scrollTop - restoreScrollAnchor.offset);
          }
        }
        const fromBottom = inner.scrollHeight - inner.scrollTop - inner.clientHeight;
        stickToBottomRef.current = fromBottom < 80;
        setShowJump(fromBottom > 360);
        rememberScrollPosition();
      };
      applyRestore();
      const first = window.requestAnimationFrame(() => {
        applyRestore();
        const second = window.requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
          anchorCleanupRef.current = null;
          scheduleVisibleAck();
        });
        anchorCleanupRef.current = () => {
          window.cancelAnimationFrame(second);
          programmaticScrollRef.current = false;
        };
      });
      anchorCleanupRef.current = () => {
        window.cancelAnimationFrame(first);
        programmaticScrollRef.current = false;
      };
      return;
    }
    const targetId = anchorId ?? null;
    if (!targetId) {
      stickToBottomRef.current = true;
      scrollToBottom();
      setShowJump(false);
      rememberScrollPosition();
      scheduleVisibleAck();
      return;
    }
    stickToBottomRef.current = false;
    programmaticScrollRef.current = true;
    const applyAnchor = (): void => {
      scrollToMessage(targetId, 'start');
      const inner = scrollRef.current;
      if (inner) {
        inner.scrollTop = Math.max(0, inner.scrollTop - ANCHOR_TOP_GAP);
        setShowJump(inner.scrollHeight - inner.scrollTop - inner.clientHeight > 360);
        rememberScrollPosition();
      }
    };
    applyAnchor();
    const first = window.requestAnimationFrame(() => {
      applyAnchor();
      const second = window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        anchorCleanupRef.current = null;
        scheduleVisibleAck(); // layout settled — ack what is actually visible
      });
      anchorCleanupRef.current = () => {
        window.cancelAnimationFrame(second);
        programmaticScrollRef.current = false;
      };
    });
    anchorCleanupRef.current = () => {
      window.cancelAnimationFrame(first);
      programmaticScrollRef.current = false;
    };
    // Intentionally do not depend on newDividerId: it is live read-marker UI
    // state and changes as messages are viewed. Re-anchoring on that change is
    // the "reload/jump on every switch/read" failure mode. anchorKey is the
    // explicit signal for a fresh visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, anchorId, rows.length]);

  useEffect(() => {
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (lastId !== lastIdRef.current) {
      lastIdRef.current = lastId;
      if (stickToBottomRef.current) {
        scrollToBottom();
      }
    }
  }, [messages]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }
    scrollToBottom();
    setShowJump(false);
    // scrollToBottom is intentionally render-local; totalSize is the measured
    // virtual-list height and changes when markdown/images settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalSize, rows.length]);

  useEffect(
    () => () => {
      if (scrollRafRef.current) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (dwellRef.current) {
        window.clearTimeout(dwellRef.current);
      }
      anchorCleanupRef.current?.();
    },
    []
  );

  // Advance the read pointer as the operator scrolls: every message whose
  // bottom edge has passed the viewport top is "read", and reaching the bottom
  // acks the rest. Coalesced to one DOM scan per frame; forward-only upstream.
  const handleScroll = (): void => {
    if (!activeRef.current) {
      return;
    }
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    rememberScrollPosition();
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = fromBottom < 80;
    setShowJump(fromBottom > 360);

    // Lazy load older when nearing the top, preserving the first visible message
    // by row key instead of raw scrollHeight deltas. That keeps prepend stable
    // under dynamic markdown height measurement.
    if (hasOlder && onLoadOlder && !loadPendingRef.current && !programmaticScrollRef.current && node.scrollTop < NEAR_EDGE_PX) {
      loadPendingRef.current = true;
      programmaticScrollRef.current = true; // suppress the read-scan during the shift
      const visible = virtualizer.getVirtualItems();
      const firstMessage = visible.find((item) => rowsRef.current[item.index]?.kind === 'message');
      const anchorKey = firstMessage ? rowsRef.current[firstMessage.index]?.key : undefined;
      const anchorOffset = firstMessage ? firstMessage.start - node.scrollTop : 0;
      void Promise.resolve(onLoadOlder()).then(() => {
        window.requestAnimationFrame(() => {
          const n = scrollRef.current;
          if (n && anchorKey) {
            const index = rowsRef.current.findIndex((row) => row.key === anchorKey);
            if (index !== -1) {
              virtualizer.scrollToIndex(index, { align: 'start' });
              window.requestAnimationFrame(() => {
                const inner = scrollRef.current;
                if (inner) {
                  inner.scrollTop = Math.max(0, inner.scrollTop + anchorOffset);
                }
              });
            }
          }
          loadPendingRef.current = false;
          window.requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
          });
        });
      });
    }
    // Lazy load newer when nearing the bottom (deep-history view): append, no shift.
    if (hasNewer && onLoadNewer && !loadPendingRef.current && !programmaticScrollRef.current && fromBottom < NEAR_EDGE_PX) {
      loadPendingRef.current = true;
      void Promise.resolve(onLoadNewer()).then(() => {
        loadPendingRef.current = false;
      });
    }

    // Our own anchor jump fires scroll events — never let them ack messages the
    // operator has not actually scrolled past.
    if (programmaticScrollRef.current || !onReadProgressRef.current || scrollRafRef.current) {
      return;
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const inner = scrollRef.current;
      const report = onReadProgressRef.current;
      if (!inner || !report) {
        return;
      }
      const readId = readProgressFromVirtualRows(rowsRef.current, virtualizer.getVirtualItems(), {
        scrollOffset: inner.scrollTop,
        viewportHeight: inner.clientHeight,
        scrollHeight: inner.scrollHeight,
        bottomPx: AT_BOTTOM_PX,
        programmatic: programmaticScrollRef.current
      });
      if (readId && readId !== reportedReadRef.current) {
        reportedReadRef.current = readId;
        report(readId);
      }
    });
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
    if (!scrollToMessage(cursorId, 'auto')) {
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
    if (row.kind === 'new-divider') {
      return (
        <div className="chanNewDivider" aria-label="New messages">
          <span className="chanDayLine" />
          <span className="chanNewLabel">NEW</span>
        </div>
      );
    }
    const message = row.message;
    const isAnchor = anchorId !== undefined && message.id === anchorId;
    return (
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
        cursor={cursorId != null && cursorId === message.id}
        reactions={reactionsById?.get(message.id) ?? NO_REACTIONS}
        api={apiRef}
      />
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
          <div style={{ height: `${totalSize}px`, position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) {
                return null;
              }
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {renderVirtualRow(row)}
                </div>
              );
            })}
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
            stickToBottomRef.current = true;
            setShowJump(false);
            // If newer pages aren't loaded, reload the newest window first; the
            // stick-to-bottom effect then lands on the true last message.
            if (onJumpLatest) {
              onJumpLatest();
            }
            scrollToBottom();
          }}
        >
          <ChevronDown size={12} />
          <span>latest</span>
        </button>
      ) : null}
    </div>
  );
}
