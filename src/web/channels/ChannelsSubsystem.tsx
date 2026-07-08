import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import {
  Activity,
  AtSign,
  Bot,
  ChevronDown,
  ChevronRight,
  Coffee,
  Download,
  FileText,
  Forward,
  Gauge,
  Hash,
  HelpCircle,
  History,
  Inbox,
  ListFilter,
  MessageSquareReply,
  Star,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  X
} from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
import { publishStatus, type StatusSegment } from '../statusSegments.js';
import { CLIP_OCTAGON_TINY, Cmd, DeskPanel, DeskSelect, IconButton, Modal, Pill, TextReveal } from '../arwes/primitives.js';
import {
  AGENT_SIDEBAR_MAX_SIZE,
  AGENT_SIDEBAR_MIN_SIZE,
  CHANNELS_SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_PREFIX,
  clampSidebarWidth,
  createSidebarWidthPersister,
  isAgentSidebarCollapseSize,
  defaultSidebarCollapsed,
  isNarrowViewport,
  surfaceMinSize,
  useNarrowViewport,
  readStoredSidebarCollapsed,
  readStoredSidebarWidth
} from '../sidebarPanel.js';
import { saveSettings } from '../api.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { LIST_REVEAL, LIST_ROW_DURATION } from '../arwes/motion.js';
import type { DeskSnapshot, DeskSessionView } from '../types.js';
import { useClampedMenu } from '../menuPosition.js';
import { shortTimeAgo } from '../git/gitStatusMeta.js';
import {
  channelFileUrl,
  channelsAllMessages,
  channelsCreate,
  channelsDestroy,
  channelsDetail,
  channelsEdit,
  channelsFeatured,
  channelsFeaturedAdd,
  channelsFeaturedRemove,
  channelsMemberAdd,
  channelsMemberRemove,
  channelsMessageDelete,
  channelsMessageEdit,
  channelsMessages,
  channelsPost,
  channelsExportUrl,
  channelsQueueClear,
  channelsReactionAdd,
  channelsReactionRemove,
  channelsReactions,
  channelsShare,
  channelsState,
  channelsThread,
  type ChannelDetail,
  type ChannelMember,
  type ChannelMessage,
  type ChannelSummary,
  type FeaturedMessageItem,
  type LifecycleState,
  type ReactionKind,
  type ReactionRef,
  type ViewFilter
} from './channelsClient.js';
import {
  addableAgentAgentOptions,
  addableAgentProjectOptions,
  adjacentMessageId,
  authorHue,
  authorInitials,
  buildMessageLink,
  buildQuoteReply,
  channelSidebarCollapsedSectionsToPreserve,
  channelSidebarExpandedSize,
  channelSidebarListSize,
  channelSidebarNextCollapsedSections,
  channelInitialLoadSince,
  channelReadPointer,
  channelSidebarResizeHandleEnabled,
  channelSidebarSections,
  channelShouldReanchorCachedDetail,
  channelUnreadCount,
  filterAddableAgentCandidates,
  filterMessages,
  firstUnreadId,
  formatBytes,
  isFeatured,
  latestMessageId,
  lifecycleStateSignature,
  messageMatchesFilter,
  nextMentionId,
  normalizeChannelSeenEntry,
  parseMessageLink,
  reactionsForMessage,
  restoreScrollChannelForSelection,
  shouldSwitchChannelForNavigation
} from './channelsModel.js';
import type { AddableAgentRuntimeState, ChannelSidebarSectionId } from './channelsModel.js';
import { Composer } from './Composer.js';
import { EngineConsole } from './EngineConsole.js';
import { CommandPalette, type PaletteCommand } from './CommandPalette.js';
import { InboxView } from './InboxView.js';
import { FeaturedView } from './FeaturedView.js';
import { SearchView } from './SearchView.js';
import { LiveFeedView } from './LiveFeedView.js';
import { SavedViewsView } from './SavedViewsView.js';
import { TimelineView } from './TimelineView.js';
import { DigestView } from './DigestView.js';
import { MessageList, type MessageMenuTarget, type MessageRef, type MessageScrollAnchor } from './MessageList.js';

const CHANNEL_STORAGE_KEY = 'desk.channelsChannel';
const SEEN_STORAGE_KEY = 'desk.channelsSeen';
const STATE_POLL_MS = 2500;
/** background cadence: keep unread badges + sounds alive while another subsystem is open */
const STATE_POLL_BG_MS = 6000;

interface SeenEntry {
  id: string;
  count: number;
}

function readSeenMap(): Record<string, SeenEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}') as Record<string, SeenEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

interface SidebarMenuTarget {
  kind: 'channel' | 'member';
  channel?: ChannelSummary;
  member?: ChannelMember;
  x: number;
  y: number;
}

export function ChannelsSubsystem({
  active,
  snapshot,
  onError,
  onInfo,
  onOpenFile,
  onRevealAgent,
  onUnreadChange,
  registerNavigator,
  onSidebarCollapsedChange,
  registerSidebarToggle,
  serverSidebarWidth
}: {
  active: boolean;
  snapshot: DeskSnapshot | null;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  /** open a file (absolute path) in the editor subsystem */
  onOpenFile: (path: string) => void;
  /** jump to the agents subsystem with this tmux session selected */
  onRevealAgent?: (tmuxSession: string) => void;
  /** total unread messages across channels (drives the rail badge) */
  onUnreadChange?: (count: number) => void;
  /** registers a navigator: jump to a channel / message / thread (event cards) */
  registerNavigator?: (navigate: (channel: string, messageId?: string, thread?: string) => void) => void;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  registerSidebarToggle?: (toggle: () => void) => void;
  serverSidebarWidth?: number;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const narrowViewport = useNarrowViewport();
  const [booted, setBooted] = useState(false);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [delivery, setDelivery] = useState<LifecycleState[]>([]);
  const [enginePassive, setEnginePassive] = useState(false);
  const [enginePassiveOwner, setEnginePassiveOwner] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(CHANNEL_STORAGE_KEY));
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const [threadParent, setThreadParent] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<ChannelMessage[]>([]);
  const [query, setQuery] = useState('');
  // Full message list for the active filter only (search must see everything);
  // null = not loaded for the current channel. Reset on channel switch.
  const [allMessages, setAllMessages] = useState<ChannelMessage[] | null>(null);
  const [seenMap, setSeenMap] = useState<Record<string, SeenEntry>>(() => readSeenMap());
  const seenMapRef = useRef(seenMap);
  seenMapRef.current = seenMap;
  // Bumped when automatic channel display should re-apply its initial anchor.
  const [visitKey, setVisitKey] = useState(0);
  const [visitAnchorId, setVisitAnchorId] = useState<string | null>(null);
  const beginVisit = useCallback((anchorId: string | null = null): void => {
    setVisitAnchorId(anchorId);
    setVisitKey((key) => key + 1);
  }, []);
  const [restoreScrollChannel, setRestoreScrollChannel] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createGoal, setCreateGoal] = useState('');
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberQuery, setAddMemberQuery] = useState('');
  const [addMemberProject, setAddMemberProject] = useState('all');
  const [addMemberAgent, setAddMemberAgent] = useState('all');
  const [addMemberState, setAddMemberState] = useState<'all' | AddableAgentRuntimeState>('all');
  const [destroyTarget, setDestroyTarget] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<MessageMenuTarget | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<MessageRef | null>(null);
  const [shareChannel, setShareChannel] = useState('');
  const [shareComment, setShareComment] = useState('');
  const [editTarget, setEditTarget] = useState<MessageRef | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MessageRef | null>(null);
  const [engineOpen, setEngineOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [featuredOpen, setFeaturedOpen] = useState(false);
  const [featuredItems, setFeaturedItems] = useState<FeaturedMessageItem[]>([]);
  const [reactionItems, setReactionItems] = useState<ReactionRef[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [liveFeedOpen, setLiveFeedOpen] = useState(false);
  const [savedViewsOpen, setSavedViewsOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [channelsHelpOpen, setChannelsHelpOpen] = useState(false);
  // the active saved-view filter applied to the feed (null = none).
  const [activeView, setActiveView] = useState<{ name: string; filter: ViewFilter } | null>(null);
  const [goalEditOpen, setGoalEditOpen] = useState(false);
  const [goalText, setGoalText] = useState('');
  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | null>(null);
  // keyboard-nav cursor: the message id j/k currently sit on (null = no cursor yet).
  const [cursorId, setCursorId] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // live state + actions, read at keydown time so the listener (registered once,
  // gated on `active`) never goes stale and never re-subscribes per poll/render.
  const navStateRef = useRef<{
    messages: ChannelMessage[];
    cursorId: string | null;
    dividerId: string | null;
    threadParent: string | null;
    blocked: boolean;
    toggleFeatured: (target: MessageRef) => void;
    jumpTo: (id: string | null) => void;
    focusFilter: () => void;
  }>({
    messages: [],
    cursorId: null,
    dividerId: null,
    threadParent: null,
    blocked: false,
    toggleFeatured: () => {},
    jumpTo: () => {},
    focusFilter: () => {}
  });

  const selectedRef = useRef<string | null>(selected);
  selectedRef.current = selected;
  const threadRef = useRef<string | null>(threadParent);
  threadRef.current = threadParent;
  const detailRef = useRef<ChannelDetail | null>(null);
  detailRef.current = detail;
  // In-memory per-channel cache of the loaded window so switching to another
  // chat and back restores instantly — no blank, no server refetch (load
  // memoization). Kept current by the effect below; the 2.5s poll still appends
  // genuinely-new messages to the active channel.
  const detailCacheRef = useRef<Map<string, ChannelDetail>>(new Map());
  if (detail) {
    detailCacheRef.current.set(detail.name, detail);
  }
  const scrollAnchorByChannelRef = useRef<Map<string, MessageScrollAnchor>>(new Map());
  const activeReturnAnchorCheckRef = useRef(false);
  const lastSeenSoundRef = useRef<Map<string, string>>(new Map());
  // Poll diff-and-bail: the state poll fires every 2.5 s forever. Skipping the
  // setState when nothing changed keeps the whole subsystem (and the message
  // feed) from reconciling on every idle tick.
  const channelsSigRef = useRef<string>('');
  const deliverySigRef = useRef<string>('');
  const menuRef = useClampedMenu(menuTarget ? { x: menuTarget.x, y: menuTarget.y } : null);
  const sidebarMenuRef = useClampedMenu(sidebarMenu ? { x: sidebarMenu.x, y: sidebarMenu.y } : null);

  const report = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError]);

  useEffect(() => {
    if (!active) {
      activeReturnAnchorCheckRef.current = true;
    }
  }, [active]);

  // Close the context menus like every other desk menu: any click anywhere
  // (the menu's own items run first via their onClick) or Escape.
  useEffect(() => {
    if (!menuTarget && !sidebarMenu) {
      return;
    }
    const close = (): void => {
      setMenuTarget(null);
      setSidebarMenu(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuTarget, sidebarMenu]);

  // Cmd-K / Ctrl-K toggles the command palette, only while the channels
  // view is active so it does not hijack the shortcut from other subsystems.
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // Escape closes the thread panel — but only when no menu is up (those own
  // Escape above) and focus is not inside an input, where Escape means
  // "abandon what I'm typing", not "close the panel".
  useEffect(() => {
    if (!threadParent || menuTarget || sidebarMenu) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        return;
      }
      setThreadParent(null);
      setThreadMessages([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threadParent, menuTarget, sidebarMenu]);

  // keyboard-first nav (gated on `active`): j/k move the cursor, s stars,
  // t opens the thread, / focuses the filter, g-u jumps to the first unread.
  // Reads navStateRef at event time; skips while typing in a field or when any
  // overlay/modal owns the keyboard. One listener, no per-render re-subscribe.
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let pendingG = false;
    let gTimer: number | null = null;
    const clearG = (): void => {
      pendingG = false;
      if (gTimer !== null) {
        window.clearTimeout(gTimer);
        gTimer = null;
      }
    };
    const scrollTo = (id: string): void => {
      window.requestAnimationFrame(() => {
        const node = document.querySelector(`#desk-channels-sidebar-v1 [data-msg-id="${id}"]`);
        if (node instanceof HTMLElement) {
          node.scrollIntoView({ block: 'nearest' });
        }
      });
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return; // leave Cmd-K and friends alone
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return; // typing, not navigating
      }
      const state = navStateRef.current;
      if (state.blocked) {
        return; // an overlay/modal owns the keyboard
      }
      const key = event.key.toLowerCase();
      if (pendingG) {
        clearG();
        if (key === 'u') {
          event.preventDefault();
          state.jumpTo(state.dividerId);
        }
        return;
      }
      if (key === 'g') {
        pendingG = true;
        gTimer = window.setTimeout(clearG, 1200);
        return;
      }
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const next = adjacentMessageId(state.messages, state.cursorId, key === 'j' ? 'next' : 'prev');
        if (next) {
          setCursorId(next);
          scrollTo(next);
        }
        return;
      }
      if (key === '/') {
        event.preventDefault();
        state.focusFilter();
        return;
      }
      if (!state.cursorId) {
        return; // s / t need a cursor first
      }
      const current = state.messages.find((message) => message.id === state.cursorId);
      if (!current) {
        return;
      }
      if (key === 's') {
        event.preventDefault();
        state.toggleFeatured({ message: current, threadParentId: state.threadParent ?? undefined });
      } else if (key === 't') {
        event.preventDefault();
        openThread(current.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearG();
    };
  }, [active]);

  /* ---------- sidebar collapse (same mechanics as the other subsystems) ---------- */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    defaultSidebarCollapsed(localStorage.getItem(CHANNELS_SIDEBAR_STORAGE_KEY))
  );
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const restoringSidebarRef = useRef(false);
  const initialWidthRef = useRef(
    readStoredSidebarWidth(localStorage.getItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}channels`)) ?? 240
  );
  const sidebarWidthRef = useRef(initialWidthRef.current);
  const widthPersisterRef = useRef<((px: number) => void) | null>(null);
  if (widthPersisterRef.current === null) {
    widthPersisterRef.current = createSidebarWidthPersister('channels', (sidebars) => saveSettings({ sidebars }));
  }
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const sidebarAnimTimerRef = useRef<number | undefined>(undefined);
  const pendingSnapCollapseRef = useRef(false);
  const collapseSidebarRef = useRef<() => void>(() => undefined);
  const toggleSidebarRef = useRef<() => void>(() => undefined);
  const channelListPanelRef = useRef<PanelImperativeHandle | null>(null);
  const membersPanelRef = useRef<PanelImperativeHandle | null>(null);
  const filesPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const preservingCollapsedSectionsRef = useRef<Set<ChannelSidebarSectionId>>(new Set());

  const channelSidebarSectionRef = (which: ChannelSidebarSectionId): React.RefObject<PanelImperativeHandle | null> =>
    which === 'members' ? membersPanelRef : filesPanelRef;
  const channelSidebarSectionCollapsed = (which: ChannelSidebarSectionId): boolean =>
    which === 'members' ? membersCollapsed : filesCollapsed;
  const setChannelSidebarSectionCollapsed = (which: ChannelSidebarSectionId, value: boolean): void => {
    if (which === 'members') {
      setMembersCollapsed(value);
    } else {
      setFilesCollapsed(value);
    }
  };

  function preserveCollapsedSidebarSiblings(toggled: ChannelSidebarSectionId): void {
    const preserving = new Set(
      channelSidebarCollapsedSectionsToPreserve({ members: membersCollapsed, files: filesCollapsed }, toggled)
    );
    preservingCollapsedSectionsRef.current = preserving;
    window.requestAnimationFrame(() => {
      for (const section of preserving) {
        channelSidebarSectionRef(section).current?.collapse();
        setChannelSidebarSectionCollapsed(section, true);
      }
      window.setTimeout(() => {
        if (preservingCollapsedSectionsRef.current === preserving) {
          preservingCollapsedSectionsRef.current = new Set();
        }
      }, 120);
    });
  }

  function applyChannelSidebarSectionLayout(collapsed: { members: boolean; files: boolean }): void {
    const apply = (): void => {
      channelListPanelRef.current?.resize(channelSidebarListSize(collapsed));
      if (collapsed.members) {
        membersPanelRef.current?.collapse();
      } else {
        membersPanelRef.current?.expand();
        membersPanelRef.current?.resize(channelSidebarExpandedSize('members'));
      }
      if (collapsed.files) {
        filesPanelRef.current?.collapse();
      } else {
        filesPanelRef.current?.expand();
        filesPanelRef.current?.resize(channelSidebarExpandedSize('files'));
      }
    };
    window.requestAnimationFrame(() => {
      apply();
      window.setTimeout(apply, 80);
    });
  }

  function toggleChannelSidebarSection(which: ChannelSidebarSectionId): void {
    const ref = channelSidebarSectionRef(which);
    const collapsed = channelSidebarSectionCollapsed(which);
    const nextCollapsed = channelSidebarNextCollapsedSections({ members: membersCollapsed, files: filesCollapsed }, which);
    preserveCollapsedSidebarSiblings(which);
    if (collapsed) {
      ref.current?.expand();
      const size = ref.current?.getSize();
      if (size && size.asPercentage < 20) {
        ref.current?.resize(channelSidebarExpandedSize(which));
      }
    } else {
      ref.current?.collapse();
    }
    setChannelSidebarSectionCollapsed(which, !collapsed);
    applyChannelSidebarSectionLayout(nextCollapsed);
  }

  function handleChannelSidebarSectionResize(which: ChannelSidebarSectionId, size: PanelSize): void {
    if (!active) {
      return;
    }
    if (preservingCollapsedSectionsRef.current.has(which)) {
      setChannelSidebarSectionCollapsed(which, true);
      return;
    }
    setChannelSidebarSectionCollapsed(which, size.inPixels <= 30);
  }

  useEffect(() => {
    localStorage.setItem(CHANNELS_SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    onSidebarCollapsedChange?.(sidebarCollapsed);
  }, [sidebarCollapsed, onSidebarCollapsedChange]);

  useEffect(() => {
    if (!active) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (membersCollapsed) {
        membersPanelRef.current?.collapse();
      }
      if (filesCollapsed) {
        filesPanelRef.current?.collapse();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (serverSidebarWidth === undefined) {
      return;
    }
    const width = clampSidebarWidth(serverSidebarWidth);
    if (width === sidebarWidthRef.current) {
      return;
    }
    sidebarWidthRef.current = width;
    localStorage.setItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}channels`, String(width));
    if (!sidebarPanelRef.current?.isCollapsed()) {
      restoringSidebarRef.current = true;
      sidebarPanelRef.current?.resize(`${width}px`);
      window.setTimeout(() => {
        restoringSidebarRef.current = false;
      }, 120);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSidebarWidth]);

  useEffect(() => {
    const onPointerUp = (): void => {
      if (pendingSnapCollapseRef.current) {
        pendingSnapCollapseRef.current = false;
        collapseSidebarRef.current();
      }
    };
    document.addEventListener('pointerup', onPointerUp);
    return () => document.removeEventListener('pointerup', onPointerUp);
  }, []);

  useLayoutEffect(() => {
    // Re-assert collapse + width after the hidden-mount layout pass (see
    // GitSubsystem for the full rationale of the double-rAF + settle pass).
    if (!active) {
      restoringSidebarRef.current = false;
      return;
    }
    restoringSidebarRef.current = true;
    const assertLayout = (): void => {
      if (sidebarCollapsed) {
        sidebarPanelRef.current?.collapse();
        return;
      }
      if (sidebarPanelRef.current?.isCollapsed()) {
        sidebarPanelRef.current.expand();
      }
      sidebarPanelRef.current?.resize(`${sidebarWidthRef.current}px`);
    };
    let secondPass: number | undefined;
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        assertLayout();
        secondPass = window.setTimeout(() => {
          assertLayout();
          window.setTimeout(() => {
            restoringSidebarRef.current = false;
          }, 120);
        }, 80);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(secondPass);
    };
  }, [sidebarCollapsed, active]);

  useEffect(() => {
    registerSidebarToggle?.(() => toggleSidebarRef.current());
  }, [registerSidebarToggle]);

  function markSidebarAnimating(): void {
    document.getElementById('channels-sidebar-tree')?.parentElement?.classList.add('sidebarAnimating');
    setSidebarAnimating(true);
    window.clearTimeout(sidebarAnimTimerRef.current);
    sidebarAnimTimerRef.current = window.setTimeout(() => setSidebarAnimating(false), 340);
  }

  function collapseSidebar(): void {
    markSidebarAnimating();
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.collapse();
    setSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 360);
  }

  function snapCollapseSidebar(): void {
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.collapse();
    setSidebarCollapsed(true);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 120);
  }
  collapseSidebarRef.current = snapCollapseSidebar;

  function expandSidebar(): void {
    markSidebarAnimating();
    restoringSidebarRef.current = true;
    sidebarPanelRef.current?.expand();
    sidebarPanelRef.current?.resize(`${sidebarWidthRef.current}px`);
    setSidebarCollapsed(false);
    window.setTimeout(() => {
      restoringSidebarRef.current = false;
    }, 360);
  }

  function toggleSidebar(): void {
    if (sidebarCollapsed || sidebarPanelRef.current?.isCollapsed()) {
      expandSidebar();
      return;
    }
    collapseSidebar();
  }
  toggleSidebarRef.current = toggleSidebar;

  function handleSidebarResize(size: PanelSize): void {
    if (!active || restoringSidebarRef.current) {
      return;
    }
    if (isNarrowViewport()) {
      // Overlay drawer (phones): the library's split is virtual — its resize
      // events (mount echoes included) must not drive the drawer state.
      return;
    }
    if (size.inPixels <= 1) {
      pendingSnapCollapseRef.current = false;
      setSidebarCollapsed(true);
      return;
    }
    setSidebarCollapsed(false);
    pendingSnapCollapseRef.current = isAgentSidebarCollapseSize(size.inPixels);
    const width = clampSidebarWidth(size.inPixels);
    if (width !== sidebarWidthRef.current) {
      sidebarWidthRef.current = width;
      widthPersisterRef.current?.(width);
    }
  }

  /* ---------- data flow ---------- */

  // Initial windowed load: newest when fully read, otherwise the first unread
  // message with context around it. Cached channel switches use this path only
  // when unread messages arrived while away; no-new switches restore the
  // memoized window and viewport.
  const refreshDetail = useCallback(async (channel: string, options: { initialWindow?: boolean; summary?: ChannelSummary } = {}): Promise<void> => {
    try {
      const summary = options.summary ?? channelsRef.current.find((entry) => entry.name === channel);
      const since = options.initialWindow && summary ? channelInitialLoadSince(summary, seenMapRef.current[channel]) : null;
      if (options.initialWindow) {
        beginVisit(since);
        setRestoreScrollChannel(null);
      }
      const next = await channelsDetail(channel, since);
      if (selectedRef.current === channel) {
        setDetail(next);
        if (threadRef.current) {
          const stillExists = next.messages.some((message) => message.id === threadRef.current);
          if (!stillExists) {
            setThreadParent(null);
            setThreadMessages([]);
          }
        }
      }
    } catch (err) {
      report(err);
    }
  }, [beginVisit, report]);

  const loadingMoreRef = useRef(false);

  // Scroll-up: fetch the page of messages before the oldest loaded one and
  // PREPEND it (MessageList compensates scrollTop so the viewport stays put).
  const loadOlder = useCallback(async (): Promise<void> => {
    const loaded = detailRef.current;
    if (!loaded || !loaded.hasOlder || loadingMoreRef.current) {
      return;
    }
    const oldest = loaded.messages[0]?.id;
    if (!oldest) {
      return;
    }
    loadingMoreRef.current = true;
    try {
      const page = await channelsMessages(loaded.name, { before: oldest });
      setDetail((current) => {
        if (!current || current.name !== loaded.name) {
          return current;
        }
        const known = new Set(current.messages.map((message) => message.id));
        const fresh = page.messages.filter((message) => !known.has(message.id));
        return {
          ...current,
          messages: [...fresh, ...current.messages],
          hasOlder: page.hasOlder,
          startIndex: page.startIndex // window now begins at the older page's start
        };
      });
    } catch (err) {
      report(err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [report]);

  // Scroll-down (and the live poll): fetch messages after the newest loaded one
  // and APPEND them. Used both to page forward through a deep unread backlog and
  // to pick up live messages while the window already includes the newest.
  const loadNewer = useCallback(async (channel: string): Promise<void> => {
    const loaded = detailRef.current;
    if (!loaded || loaded.name !== channel || loadingMoreRef.current) {
      return;
    }
    const newest = loaded.messages[loaded.messages.length - 1]?.id;
    if (!newest) {
      return;
    }
    loadingMoreRef.current = true;
    try {
      const page = await channelsMessages(channel, { after: newest });
      setDetail((current) => {
        if (!current || current.name !== channel) {
          return current;
        }
        const known = new Set(current.messages.map((message) => message.id));
        const fresh = page.messages.filter((message) => !known.has(message.id));
        if (fresh.length === 0 && page.hasNewer === current.hasNewer) {
          return current;
        }
        return { ...current, messages: [...current.messages, ...fresh], hasNewer: page.hasNewer };
      });
    } catch (err) {
      report(err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [report]);

  const loadAroundMessage = useCallback(async (channel: string, messageId: string): Promise<boolean> => {
    try {
      const page = await channelsMessages(channel, { around: messageId });
      if (!page.messages.some((message) => message.id === messageId)) {
        return false;
      }
      setRestoreScrollChannel(null);
      scrollAnchorByChannelRef.current.delete(channel);
      setDetail((current) =>
        current && current.name === channel
          ? {
              ...current,
              messages: page.messages,
              hasOlder: page.hasOlder,
              hasNewer: page.hasNewer,
              total: page.total,
              startIndex: page.startIndex
            }
          : current
      );
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  }, [report]);

  // Metadata-only refresh (member join/leave, goal edit) that must NOT disturb
  // the loaded message window or the scroll position.
  const refreshMeta = useCallback(async (channel: string): Promise<void> => {
    try {
      const next = await channelsDetail(channel, seenMapRef.current[channel]?.id);
      setDetail((current) =>
        current && current.name === channel
          ? { ...current, goal: next.goal, members: next.members, files: next.files }
          : current
      );
    } catch (err) {
      report(err);
    }
  }, [report]);

  // "Jump to latest" when the newest end isn't loaded (deep-history view):
  // reload the newest window so the feed truly reaches the end. The list's
  // stick-to-bottom then lands on the last message.
  const jumpToLatest = useCallback((channel: string): void => {
    void channelsDetail(channel)
      .then((next) => setDetail((current) => (current && current.name === channel ? next : current)))
      .catch(report);
  }, [report]);

  const refreshThread = useCallback(async (channel: string, parent: string): Promise<void> => {
    try {
      const next = await channelsThread(channel, parent);
      if (selectedRef.current === channel && threadRef.current === parent) {
        setThreadMessages(next.messages);
      }
    } catch (err) {
      report(err);
    }
  }, [report]);

  const refreshState = useCallback(async (): Promise<void> => {
    try {
      const state = await channelsState();
      const channelsSig = state.channels
        .map((channel) => `${channel.name}:${channel.messageCount}:${channel.lastMessage?.id ?? ''}:${channel.members.length}:${channel.goal}`)
        .join('|');
      if (channelsSig !== channelsSigRef.current) {
        channelsSigRef.current = channelsSig;
        setChannels(state.channels);
      }
      const deliverySig = state.delivery.map(lifecycleStateSignature).join('|');
      if (deliverySig !== deliverySigRef.current) {
        deliverySigRef.current = deliverySig;
        setDelivery(state.delivery);
      }
      setEnginePassive(state.passive === true); // primitive — React bails if unchanged
      setEnginePassiveOwner(state.passiveOwner);

      // Channels can appear after boot (created elsewhere): keep a selection.
      if (!selectedRef.current && state.channels.length > 0) {
        const stored = localStorage.getItem(CHANNEL_STORAGE_KEY);
        const pick = state.channels.find((channel) => channel.name === stored) ?? state.channels[0];
        setSelected(pick.name);
        selectedRef.current = pick.name;
        void refreshDetail(pick.name, { initialWindow: true, summary: pick });
      }

      // Per-channel new-message detection for soft sounds.
      for (const channel of state.channels) {
        const lastId = channel.lastMessage?.id;
        if (!lastId) {
          continue;
        }
        const previous = lastSeenSoundRef.current.get(channel.name);
        lastSeenSoundRef.current.set(channel.name, lastId);
        if (previous !== undefined && previous !== lastId && channel.lastMessage?.author !== 'human') {
          bleeps.attention?.play();
        }
      }
      // Keep only the visible open channel live. Background subsystem polling
      // updates badges/state, but it must not replace the hidden feed window or
      // disturb the viewport the operator left behind.
      const selectedSummary = state.channels.find((channel) => channel.name === selectedRef.current);
      const loaded = detailRef.current;
      const checkActiveReturnAnchor = activeRef.current && activeReturnAnchorCheckRef.current;
      if (checkActiveReturnAnchor) {
        activeReturnAnchorCheckRef.current = false;
      }
      if (activeRef.current && selectedSummary && loaded && loaded.name === selectedSummary.name) {
        const newestLoaded = loaded.messages[loaded.messages.length - 1]?.id ?? null;
        const summaryLast = selectedSummary.lastMessage?.id ?? null;
        if (checkActiveReturnAnchor && channelShouldReanchorCachedDetail(selectedSummary, seenMapRef.current[selectedSummary.name])) {
          setRestoreScrollChannel(null);
          void refreshDetail(selectedSummary.name, { initialWindow: true, summary: selectedSummary });
        } else if (!loaded.hasNewer && newestLoaded !== summaryLast) {
          void loadNewer(selectedSummary.name);
          if (threadRef.current) {
            void refreshThread(selectedSummary.name, threadRef.current);
          }
        }
        // Member join/leave only touches metadata, never the message window.
        if (loaded.members.length !== selectedSummary.members.length) {
          void refreshMeta(selectedSummary.name);
        }
      }
      // Thread replies do not change root lastMessage — refresh the open
      // thread on every poll (thread files are small).
      if (activeRef.current && selectedRef.current && threadRef.current) {
        void refreshThread(selectedRef.current, threadRef.current);
      }
    } catch (err) {
      report(err);
    }
  }, [bleeps, loadNewer, refreshDetail, refreshMeta, refreshThread, report]);

  // Eager boot + select restore. Unlike the heavier subsystems, channels
  // boots on mount: messages arrive while the operator works elsewhere, and
  // unread badges / new-message sounds must not wait for the first visit.
  useEffect(() => {
    if (booted) {
      return;
    }
    setBooted(true);
    void (async () => {
      try {
        const state = await channelsState();
        setChannels(state.channels);
        setDelivery(state.delivery);
      setEnginePassive(state.passive === true);
      setEnginePassiveOwner(state.passiveOwner);
        for (const channel of state.channels) {
          if (channel.lastMessage) {
            lastSeenSoundRef.current.set(channel.name, channel.lastMessage.id);
          }
        }
        const stored = localStorage.getItem(CHANNEL_STORAGE_KEY);
        const pick = state.channels.find((channel) => channel.name === stored) ?? state.channels[0] ?? null;
        if (pick) {
          setSelected(pick.name);
          selectedRef.current = pick.name;
          void refreshDetail(pick.name, { initialWindow: true, summary: pick });
        }
      } catch (err) {
        report(err);
      }
    })();
  }, [booted, refreshDetail, report]);

  // Poll always; relaxed cadence in the background. A hidden tab (browser
  // minimised / different tab) skips the network entirely and catches up the
  // moment it becomes visible again — no point fetching what no one can see.
  useEffect(() => {
    if (!booted) {
      return;
    }
    const tick = (): void => {
      if (!document.hidden) {
        void refreshState();
      }
    };
    const timer = window.setInterval(tick, active ? STATE_POLL_MS : STATE_POLL_BG_MS);
    tick();
    const onVisible = (): void => {
      if (!document.hidden) {
        void refreshState();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, booted, refreshState]);

  // Opening the subsystem acknowledges channel notification cards: the feed
  // itself is now the read surface, so the drawer entries flip to read.
  useEffect(() => {
    if (!active) {
      return;
    }
    void fetch('/api/attention-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: ['channel'] })
    }).catch(() => undefined);
  }, [active, detail]);

  // Advance a channel's read pointer as the feed reports scroll progress.
  // Forward-only: a poll re-render, an upward scroll, or a stale report can
  // never un-read messages (the unread badge would flicker otherwise).
  const markChannelRead = useCallback((channel: string, lastReadId: string): void => {
    setSeenMap((current) => {
      const loaded = detailRef.current;
      if (!loaded || loaded.name !== channel) {
        return current;
      }
      const windowIndex = loaded.messages.findIndex((message) => message.id === lastReadId);
      if (windowIndex === -1) {
        return current;
      }
      // Absolute count = messages before the window + position within it, so the
      // sidebar's `messageCount - count` is correct even when only a window loaded.
      const count = (loaded.startIndex ?? 0) + windowIndex + 1;
      const entry = current[channel];
      if (entry && entry.count >= count) {
        return current; // forward-only: never move the read pointer backwards
      }
      const merged = { ...current, [channel]: { id: lastReadId, count } };
      localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(merged));
      return merged;
    });
  }, []);

  const rememberChannelScroll = useCallback((channel: string, anchor: MessageScrollAnchor): void => {
    scrollAnchorByChannelRef.current.set(channel, anchor);
  }, []);

  useEffect(() => {
    if (channels.length === 0) {
      return;
    }
    setSeenMap((current) => {
      let merged: Record<string, SeenEntry> | null = null;
      for (const channel of channels) {
        const currentEntry = current[channel.name];
        const normalized = normalizeChannelSeenEntry(channel, currentEntry);
        if (!currentEntry || !normalized) {
          continue;
        }
        if (currentEntry.id === normalized.id && currentEntry.count === normalized.count) {
          continue;
        }
        merged ??= { ...current };
        merged[channel.name] = normalized;
      }
      if (!merged) {
        return current;
      }
      localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(merged));
      return merged;
    });
  }, [channels]);

  // Fresh loads anchor to the read boundary when unread exists, otherwise to
  // latest. Cached switches restore the saved viewport only when nothing new
  // arrived while away.

  function selectChannel(name: string, summary?: ChannelSummary, options: { restoreScroll?: boolean } = {}): void {
    if (!shouldSwitchChannelForNavigation(selectedRef.current, name)) {
      return;
    }
    setSelected(name);
    if (isNarrowViewport()) {
      collapseSidebarRef.current(); // drawer behavior on phones
    }
    selectedRef.current = name;
    setThreadParent(null);
    setThreadMessages([]);
    setQuery('');
    setAllMessages(null);
    localStorage.setItem(CHANNEL_STORAGE_KEY, name);
    // Load memoization: if we have a channel window and no unread messages
    // arrived while it was hidden, restore it instantly with its saved viewport.
    // If unread exists, keep the UI stable until the seen-anchored window lands.
    const cached = detailCacheRef.current.get(name);
    if (cached) {
      const shouldReanchor = summary ? channelShouldReanchorCachedDetail(summary, seenMapRef.current[name]) : false;
      if (shouldReanchor) {
        setRestoreScrollChannel(null);
        void refreshDetail(name, { initialWindow: true, summary });
      } else {
        setVisitAnchorId(null);
        setRestoreScrollChannel(restoreScrollChannelForSelection(name, options));
        setDetail(cached);
      }
    } else {
      setRestoreScrollChannel(null);
      setDetail(null);
      void refreshDetail(name, { initialWindow: true, summary });
    }
  }

  /* ---------- event-card navigation (channel → message → thread) ---------- */
  const [navTarget, setNavTarget] = useState<{ channel: string; messageId?: string; thread?: string } | null>(null);

  const navigateToMessage = useCallback((channel: string, messageId?: string, thread?: string): void => {
    setQuery('');
    setActiveView(null);
    setAllMessages(null);
    setRestoreScrollChannel(null);
    if (messageId) {
      setCursorId(messageId);
    }
    setNavTarget({ channel, messageId, thread });
    if (selectedRef.current !== channel) {
      selectChannel(channel, undefined, { restoreScroll: false });
    }
    // selectChannel is component-scope stable (see registerNavigator effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    registerNavigator?.((channel, messageId, thread) => {
      navigateToMessage(channel, messageId, thread);
    });
    // selectChannel is stable in practice (component-scope function); the
    // registration only needs to happen once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerNavigator, navigateToMessage]);

  useEffect(() => {
    if (!navTarget || !detail || detail.name !== navTarget.channel) {
      return;
    }
    // Threaded target: open the thread first, then wait for its messages.
    if (navTarget.thread && threadParent !== navTarget.thread) {
      openThread(navTarget.thread);
      return;
    }
    if (navTarget.thread && threadMessages.length === 0) {
      return; // thread still loading; effect re-runs when messages land
    }
    const id = navTarget.messageId;
    if (!id) {
      setNavTarget(null);
      return;
    }
    if (navTarget.thread) {
      setCursorId(id);
      setNavTarget(null);
      return;
    }
    if (!detail.messages.some((message) => message.id === id)) {
      let cancelled = false;
      void loadAroundMessage(detail.name, id).then((loaded) => {
        if (!cancelled && !loaded) {
          setNavTarget((current) => (current?.channel === navTarget.channel && current.messageId === id ? null : current));
        }
      });
      return () => {
        cancelled = true;
      };
    }
    setCursorId(id);
    setNavTarget(null);
  }, [navTarget, detail, threadParent, threadMessages, loadAroundMessage]);

  function openThread(parentId: string): void {
    if (!selected) {
      return;
    }
    bleeps.open?.play();
    setThreadParent(parentId);
    threadRef.current = parentId;
    setThreadMessages([]);
    void refreshThread(selected, parentId);
  }

  /* ---------- actions ---------- */

  const handleCreate = (): void => {
    const name = createName.trim();
    if (name === '') {
      return;
    }
    void channelsCreate(name, createGoal.trim())
      .then(async () => {
        bleeps.deploy?.play();
        setCreateOpen(false);
        setCreateName('');
        setCreateGoal('');
        await refreshState();
        selectChannel(name);
        onInfo(`channel #${name} created`);
      })
      .catch(report);
  };

  const handleDestroy = (): void => {
    const name = destroyTarget;
    if (!name) {
      return;
    }
    void channelsDestroy(name)
      .then(async () => {
        setDestroyTarget(null);
        onInfo(`channel #${name} destroyed`);
        const state = await channelsState();
        setChannels(state.channels);
        if (selectedRef.current === name) {
          setSelected(null);
          selectedRef.current = null;
          setDetail(null);
          setThreadParent(null);
          const pick = state.channels[0];
          if (pick) {
            selectChannel(pick.name);
          }
        }
      })
      .catch(report);
  };

  const handleSend = useCallback(
    async (body: string, thread?: string): Promise<boolean> => {
      const channel = selectedRef.current;
      if (!channel) {
        return false;
      }
      try {
        await channelsPost({ channel, body, thread });
        await refreshDetail(channel);
        if (thread) {
          await refreshThread(channel, thread);
        }
        return true;
      } catch (err) {
        report(err);
        return false;
      }
    },
    [refreshDetail, refreshThread, report]
  );

  const handleAddMember = (session: DeskSessionView): void => {
    if (!selected) {
      return;
    }
    void channelsMemberAdd(selected, session.spec.tmuxSession)
      .then(async (result) => {
        bleeps.deploy?.play();
        onInfo(`@${result.member.name} joined #${selected}`);
        await refreshDetail(selected);
        await refreshState();
      })
      .catch(report);
  };

  const handleRemoveMember = (name: string): void => {
    if (!selected) {
      return;
    }
    void channelsMemberRemove(selected, name)
      .then(async () => {
        onInfo(`@${name} removed from #${selected}`);
        await refreshDetail(selected);
      })
      .catch(report);
  };

  const handleShare = (): void => {
    if (!shareTarget || !selected || shareChannel === '') {
      return;
    }
    void channelsShare({
      fromChannel: selected,
      messageId: shareTarget.message.id,
      toChannel: shareChannel,
      thread: shareTarget.threadParentId,
      comment: shareComment.trim() || undefined
    })
      .then(() => {
        bleeps.deploy?.play();
        onInfo(`shared to #${shareChannel}`);
        setShareTarget(null);
        setShareComment('');
      })
      .catch(report);
  };

  const openShare = (target: MessageRef): void => {
    const other = channels.find((channel) => channel.name !== selected);
    setShareChannel(other?.name ?? '');
    setShareTarget(target);
  };

  const openEdit = (target: MessageRef): void => {
    setEditText(target.message.body);
    setEditTarget(target);
  };

  const handleEditSave = (): void => {
    if (!editTarget || !selected || editText.trim() === '') {
      return;
    }
    void channelsMessageEdit({
      channel: selected,
      id: editTarget.message.id,
      body: editText,
      thread: editTarget.threadParentId
    })
      .then(async () => {
        bleeps.deploy?.play();
        setEditTarget(null);
        await refreshDetail(selected);
        if (editTarget.threadParentId) {
          await refreshThread(selected, editTarget.threadParentId);
        }
      })
      .catch(report);
  };

  const handleDeleteMessage = (): void => {
    if (!deleteTarget || !selected) {
      return;
    }
    void channelsMessageDelete({
      channel: selected,
      id: deleteTarget.message.id,
      thread: deleteTarget.threadParentId
    })
      .then(async () => {
        setDeleteTarget(null);
        onInfo('message deleted');
        // Deleting an open thread's parent closes the thread panel.
        if (!deleteTarget.threadParentId && threadRef.current === deleteTarget.message.id) {
          setThreadParent(null);
          setThreadMessages([]);
        }
        await refreshDetail(selected);
        if (deleteTarget.threadParentId) {
          await refreshThread(selected, deleteTarget.threadParentId);
        }
      })
      .catch(report);
  };

  const handleGoalSave = (): void => {
    if (!selected) {
      return;
    }
    void channelsEdit(selected, goalText.trim())
      .then(async () => {
        setGoalEditOpen(false);
        onInfo('channel updated');
        await refreshDetail(selected);
        await refreshState();
      })
      .catch(report);
  };

  const mentionAuthor = (target: MessageRef): void => {
    setComposerSeed({ text: `@${target.message.author} `, nonce: Date.now() });
  };

  // quote-reply: seed the composer with a markdown blockquote of the message,
  // reusing the same composerSeed channel mentionAuthor uses.
  const onQuoteReply = (target: MessageRef): void => {
    setComposerSeed({ text: buildQuoteReply(target.message), nonce: Date.now() });
  };

  // deep-link: copy a desk message link (channel + id + thread parent) the
  // navTarget path resolves, so it opens + flashes the message when pasted/jumped.
  const onDeepLink = (target: MessageRef): void => {
    const channel = selectedRef.current;
    if (!channel) {
      return;
    }
    const link = buildMessageLink({ channel, messageId: target.message.id, thread: target.threadParentId });
    void navigator.clipboard
      ?.writeText(link)
      .then(() => onInfo('message link copied'))
      .catch(() => onError('could not copy link'));
  };

  // download the current channel (or an open thread) as a clean markdown
  // transcript via glm's /api/channels/export (server sets the attachment name).
  const exportToMarkdown = (channel: string, thread?: string): void => {
    const anchor = document.createElement('a');
    anchor.href = channelsExportUrl(channel, thread);
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  /** Mention chip clicked: jump to the member's terminal in the agents view. */
  const navigateToMember = useCallback(
    (handle: string): void => {
      const member = detailRef.current?.members.find((candidate) => candidate.name === handle);
      if (member?.tmuxSession && onRevealAgent) {
        bleeps.click?.play();
        onRevealAgent(member.tmuxSession);
      } else {
        onInfo(`@${handle} has no running terminal`);
      }
    },
    [onRevealAgent, onInfo, bleeps]
  );

  /* ---------- derived ---------- */

  const sessionIndex = useMemo(() => {
    const map = new Map<string, { view: DeskSessionView; label: string }>();
    const collect = (sessions: DeskSessionView[], scope: string): void => {
      for (const session of sessions) {
        map.set(session.spec.tmuxSession, { view: session, label: `${scope} / ${session.spec.name}` });
      }
    };
    for (const project of snapshot?.view.projects ?? []) {
      for (const group of project.groups) {
        collect(group.sessions, `${project.label} / ${group.label}`);
      }
    }
    for (const group of snapshot?.view.groups ?? []) {
      collect(group.sessions, group.label);
    }
    return map;
  }, [snapshot]);

  const deliveryIndex = useMemo(() => {
    const map = new Map<string, LifecycleState>();
    for (const state of delivery) {
      map.set(state.tmuxSession, state);
    }
    return map;
  }, [delivery]);

  const handles = useMemo(() => (detail?.members ?? []).map((member) => member.name), [detail]);
  const agentMembers = useMemo(() => (detail?.members ?? []).filter((member) => member.type !== 'human'), [detail]);
  const selectedSummary = useMemo(
    () => (selected ? channels.find((channel) => channel.name === selected) : undefined),
    [channels, selected]
  );
  const readPointerId = selected
    ? selectedSummary
      ? channelReadPointer(selectedSummary, seenMap[selected])
      : seenMap[selected]?.id ?? null
    : null;
  const newDividerId = useMemo(() => firstUnreadId(detail?.messages ?? [], readPointerId), [detail, readPointerId]);
  const workingMembers = useMemo(
    () =>
      agentMembers
        .filter((member) => member.tmuxSession && deliveryIndex.get(member.tmuxSession)?.status === 'working')
        .map((member) => member.name),
    [agentMembers, deliveryIndex]
  );

  // jump-to: move the keyboard cursor + scroll/flash a message in the current
  // channel via the existing navTarget path. jumpToRef lets the keydown call it
  // without re-subscribing the listener.
  const jumpTo = useCallback((messageId: string | null): void => {
    const channel = selectedRef.current;
    if (!channel || !messageId) {
      return;
    }
    setCursorId(messageId);
    setNavTarget({ channel, messageId });
  }, []);
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;

  // deep-link round-trip: jump to a desk message link sitting on the clipboard
  // (cross-channel — selects the channel first, like registerNavigator does).
  const gotoClipboardLink = useCallback(async (): Promise<void> => {
    try {
      const text = await navigator.clipboard?.readText();
      const link = text ? parseMessageLink(text) : null;
      if (!link) {
        onInfo('clipboard has no desk message link');
        return;
      }
      navigateToMessage(link.channel, link.messageId, link.thread);
    } catch {
      onError('could not read clipboard');
    }
  }, [navigateToMessage, onInfo, onError]);

  // command-palette sources: channels (select), agents (jump to terminal),
  // and the toolbar actions — all over data already in hand, no persistence.
  // Built inline (cheap, fresh closures) so the run handlers never go stale.
  const paletteCommands: PaletteCommand[] = [
    ...channels.map((channel) => ({
      id: `channel:${channel.name}`,
      label: `#${channel.name}`,
      hint: channel.goal || undefined,
      group: 'Channel',
      run: () => selectChannel(channel.name)
    })),
    ...agentMembers
      .filter((member) => Boolean(member.tmuxSession) && Boolean(onRevealAgent))
      .map((member) => ({
        id: `agent:${member.name}`,
        label: `@${member.name}`,
        hint: 'open terminal',
        group: 'Agent',
        run: (): void => {
          if (member.tmuxSession && onRevealAgent) {
            onRevealAgent(member.tmuxSession);
          }
        }
      })),
    { id: 'action:engine', label: 'Engine console', hint: 'delivery diagnostics + recovery', group: 'Action', run: () => setEngineOpen(true) },
    { id: 'action:refresh', label: 'Refresh channels', group: 'Action', run: () => void refreshState() },
    { id: 'action:search', label: 'Search all channels', hint: 'cross-channel', group: 'Action', run: () => setSearchOpen(true) },
    { id: 'action:live-feed', label: 'Live delivery feed', hint: 'what is happening now', group: 'Action', run: () => setLiveFeedOpen(true) },
    { id: 'action:saved-views', label: 'Saved views', hint: 'filter the feed', group: 'Action', run: () => setSavedViewsOpen(true) },
    { id: 'action:timeline', label: 'Delivery timeline', hint: 'transitions over time', group: 'Action', run: () => setTimelineOpen(true) },
    { id: 'action:digest', label: 'While-away digest', hint: 'what you missed', group: 'Action', run: () => setDigestOpen(true) },
    {
      id: 'action:export',
      label: 'Export channel to markdown',
      group: 'Action',
      run: () => {
        if (selected) {
          exportToMarkdown(selected);
        }
      }
    },
    { id: 'action:clear-filter', label: 'Clear message filter', group: 'Action', run: () => setQuery('') },
    { id: 'action:jump-latest', label: 'Jump to latest message', group: 'Jump', run: () => jumpTo(latestMessageId(detail?.messages ?? [])) },
    { id: 'action:jump-unread', label: 'Jump to first unread', group: 'Jump', run: () => jumpTo(newDividerId) },
    {
      id: 'action:jump-mention',
      label: 'Jump to next @human mention',
      hint: 'from the cursor',
      group: 'Jump',
      run: () => jumpTo(nextMentionId(detail?.messages ?? [], cursorId, 'human'))
    },
    { id: 'action:goto-link', label: 'Go to copied message link', hint: 'clipboard', group: 'Jump', run: () => void gotoClipboardLink() }
  ];

  // inbox badge: cheap delivery-attention count from the lifecycle state
  // already in hand (mentions are surfaced inside the inbox panel, which
  // self-fetches the activity feed off the hot poll).
  const inboxAttentionCount = delivery.filter(
    (entry) =>
      entry.status === 'submit-stuck' ||
      entry.status === 'blocked' ||
      entry.status === 'awaiting-approval' ||
      entry.droppedQueueItems > 0
  ).length;

  // featured: the global featured list, loaded once on mount and refreshed on
  // every star toggle (the source of truth for the row star fill + the view).
  const refreshFeatured = useCallback(async () => {
    try {
      const result = await channelsFeatured();
      setFeaturedItems(result.items);
    } catch {
      // featured is non-critical chrome; the FeaturedView surfaces its own errors
    }
  }, []);

  useEffect(() => {
    void refreshFeatured();
  }, [refreshFeatured]);

  // The star carries a MessageRef; the file (identity's 3rd part) is derived from
  // the row's thread context — root.md, or the thread file when threaded.
  const onToggleFeatured = useCallback(
    async (target: MessageRef): Promise<void> => {
      const channel = selectedRef.current;
      if (!channel) {
        return;
      }
      const file = target.threadParentId ? `thread-msg-${target.threadParentId}.md` : 'root.md';
      const id = target.message.id;
      try {
        const result = isFeatured(featuredItems, channel, file, id)
          ? await channelsFeaturedRemove({ channel, file, id })
          : await channelsFeaturedAdd({ channel, file, id });
        setFeaturedItems(result.items);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    [featuredItems, onError]
  );

  // featured ids scoped to each file context, so a root star and a same-id thread
  // reply never light each other up (channel+file+id identity).
  const rootFeaturedIds = useMemo(
    () => new Set(featuredItems.filter((item) => item.channel === selected && item.file === 'root.md').map((item) => item.id)),
    [featuredItems, selected]
  );
  const threadFeaturedIds = useMemo(() => {
    if (!threadParent) {
      return undefined;
    }
    const ids = new Set(
      featuredItems
        .filter((item) => item.channel === selected && item.file === `thread-msg-${threadParent}.md`)
        .map((item) => item.id)
    );
    // the thread's anchor row lives in root.md — reflect ITS root featured state
    if (featuredItems.some((item) => item.channel === selected && item.file === 'root.md' && item.id === threadParent)) {
      ids.add(threadParent);
    }
    return ids;
  }, [featuredItems, selected, threadParent]);

  // reactions: the global reaction list, loaded once + refreshed per toggle
  // (source of truth for the per-row reaction chips).
  const refreshReactions = useCallback(async () => {
    try {
      const result = await channelsReactions();
      setReactionItems(result.items);
    } catch {
      // reactions are non-critical chrome; failures stay silent
    }
  }, []);

  useEffect(() => {
    void refreshReactions();
  }, [refreshReactions]);

  // Toggle a reaction kind on a message (channel+file+id identity, file from the
  // thread context like the star). The store coalesces per kind, so toggle = add
  // when absent / remove when present.
  const onReact = useCallback(
    async (target: MessageRef, kind: ReactionKind): Promise<void> => {
      const channel = selectedRef.current;
      if (!channel) {
        return;
      }
      const file = target.threadParentId ? `thread-msg-${target.threadParentId}.md` : 'root.md';
      const id = target.message.id;
      const present = reactionsForMessage(reactionItems, channel, file, id).includes(kind);
      try {
        const result = present
          ? await channelsReactionRemove({ channel, file, id, kind })
          : await channelsReactionAdd({ channel, file, id, kind, author: 'human' });
        setReactionItems(result.items);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    [reactionItems, onError]
  );

  // Reaction kinds per message id, scoped to each file context (root vs thread) —
  // same channel+file+id discipline as featuredIds so a root message and a same-id
  // thread reply never share reactions.
  const buildReactionMap = (file: string): Map<string, ReactionKind[]> => {
    const map = new Map<string, ReactionKind[]>();
    for (const item of reactionItems) {
      if (item.channel === selected && item.file === file) {
        const list = map.get(item.id);
        if (list) {
          list.push(item.kind);
        } else {
          map.set(item.id, [item.kind]);
        }
      }
    }
    return map;
  };
  const rootReactionsById = useMemo(
    () => buildReactionMap('root.md'),
    // buildReactionMap closes over reactionItems + selected
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reactionItems, selected]
  );
  const threadReactionsById = useMemo(() => {
    if (!threadParent) {
      return undefined;
    }
    const map = buildReactionMap(`thread-msg-${threadParent}.md`);
    // the thread anchor row lives in root.md — reflect ITS root reactions
    for (const item of reactionItems) {
      if (item.channel === selected && item.file === 'root.md' && item.id === threadParent) {
        const list = map.get(item.id);
        if (list) {
          list.push(item.kind);
        } else {
          map.set(item.id, [item.kind]);
        }
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactionItems, selected, threadParent]);

  // Filtering must search the WHOLE channel, not just the loaded window — so an
  // active filter triggers a one-time full load and searches that; an empty
  // filter renders the lazy-loaded window. (allMessages is reset per channel.)
  // A free-text query OR an active saved view both filter the whole channel,
  // so either triggers the one-time full load below.
  const filtering = query.trim() !== '' || activeView !== null;
  const visibleMessages = useMemo(() => {
    const base = (filtering ? allMessages ?? detail?.messages : detail?.messages) ?? [];
    const byQuery = filterMessages(base, query);
    // @human is the viewer for the saved-view mentions-me clause.
    return activeView ? byQuery.filter((message) => messageMatchesFilter(message, activeView.filter, 'human')) : byQuery;
  }, [filtering, allMessages, detail, query, activeView]);
  useEffect(() => {
    if (!filtering || !selected || allMessages !== null) {
      return;
    }
    let cancelled = false;
    void channelsAllMessages(selected)
      .then((full) => {
        if (!cancelled && selectedRef.current === selected) {
          setAllMessages(full.messages);
        }
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [filtering, selected, allMessages, report]);
  const threadParentMessage = threadParent ? detail?.messages.find((message) => message.id === threadParent) ?? null : null;

  // Feed the keydown listener the current data + actions (read at event time).
  // `blocked` is true whenever an overlay/modal owns the keyboard so j/k/s/t/g-u
  // never fight it; the input-focus check in the handler covers text entry.
  navStateRef.current = {
    messages: visibleMessages,
    cursorId,
    dividerId: newDividerId,
    threadParent,
    blocked:
      paletteOpen ||
      searchOpen ||
      engineOpen ||
      inboxOpen ||
      featuredOpen ||
      liveFeedOpen ||
      savedViewsOpen ||
      timelineOpen ||
      digestOpen ||
      goalEditOpen ||
      createOpen ||
      addMemberOpen ||
      Boolean(menuTarget) ||
      Boolean(sidebarMenu) ||
      Boolean(shareTarget) ||
      Boolean(editTarget) ||
      Boolean(deleteTarget) ||
      Boolean(destroyTarget),
    toggleFeatured: onToggleFeatured,
    jumpTo,
    focusFilter: () => filterInputRef.current?.focus()
  };
  const memberTmuxSessions = useMemo(
    () => new Set((detail?.members ?? []).map((member) => member.tmuxSession).filter(Boolean)),
    [detail]
  );
  const addableSessions = useMemo(
    () => [...sessionIndex.values()].filter((entry) => !memberTmuxSessions.has(entry.view.spec.tmuxSession)),
    [sessionIndex, memberTmuxSessions]
  );
  const addableAgentCandidates = useMemo(
    () =>
      addableSessions.map((entry) => {
        const { spec } = entry.view;
        return {
          entry,
          name: spec.name,
          tmuxSession: spec.tmuxSession,
          cwd: spec.cwd,
          agent: spec.agent,
          projectId: spec.projectId,
          projectLabel: spec.projectLabel,
          groupId: spec.groupId,
          groupLabel: spec.groupLabel,
          state: entry.view.state
        };
      }),
    [addableSessions]
  );
  const addMemberProjectOptions = useMemo(() => addableAgentProjectOptions(addableAgentCandidates), [addableAgentCandidates]);
  const addMemberAgentOptions = useMemo(() => addableAgentAgentOptions(addableAgentCandidates), [addableAgentCandidates]);
  const filteredAddableSessions = useMemo(
    () =>
      filterAddableAgentCandidates(addableAgentCandidates, {
        query: addMemberQuery,
        project: addMemberProject,
        agent: addMemberAgent,
        state: addMemberState
      }),
    [addableAgentCandidates, addMemberAgent, addMemberProject, addMemberQuery, addMemberState]
  );
  const addMemberFiltersActive =
    addMemberQuery.trim() !== '' || addMemberProject !== 'all' || addMemberAgent !== 'all' || addMemberState !== 'all';
  const resetAddMemberFilters = useCallback(() => {
    setAddMemberQuery('');
    setAddMemberProject('all');
    setAddMemberAgent('all');
    setAddMemberState('all');
  }, []);

  useEffect(() => {
    if (addMemberProject !== 'all' && !addMemberProjectOptions.some((option) => option.value === addMemberProject)) {
      setAddMemberProject('all');
    }
  }, [addMemberProject, addMemberProjectOptions]);

  useEffect(() => {
    if (addMemberAgent !== 'all' && !addMemberAgentOptions.some((option) => option.value === addMemberAgent)) {
      setAddMemberAgent('all');
    }
  }, [addMemberAgent, addMemberAgentOptions]);

  function unreadFor(channel: ChannelSummary): number {
    return channelUnreadCount(channel.messageCount, channel.lastMessage?.id, seenMap[channel.name]);
  }

  // Surface the cross-channel unread total (rail badge) on every change.
  const unreadTotal = useMemo(
    () => channels.reduce((sum, channel) => sum + unreadFor(channel), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, seenMap]
  );
  useEffect(() => {
    onUnreadChange?.(unreadTotal);
  }, [unreadTotal, onUnreadChange]);

  const queueTotal = useMemo(() => delivery.reduce((sum, state) => sum + state.queued, 0), [delivery]);

  // Bottom status bar context: active channel, membership, delivery engine.
  useEffect(() => {
    const segments: StatusSegment[] = [];
    if (selected && detail) {
      const agents = detail.members.filter((member) => member.type !== 'human').length;
      segments.push(
        { key: 'channel', icon: <Hash size={11} />, text: selected, hint: detail.goal || 'Channel' },
        {
          key: 'members',
          text: `${detail.members.length} members${agents > 0 ? ` (${agents} agents)` : ''}`,
          hint: detail.members.map((member) => member.name).join(', ')
        },
        { key: 'messages', text: `${detail.total} messages`, hint: 'Messages in this channel' }
      );
    } else {
      segments.push({ key: 'channel', icon: <Hash size={11} />, text: 'no channel selected', hint: 'Pick a channel in the sidebar' });
    }
    if (queueTotal > 0) {
      segments.push({
        key: 'queue',
        text: `${queueTotal} queued`,
        tone: 'warn',
        hint: 'Deliveries waiting for busy agents'
      });
    }
    if (enginePassive) {
      segments.push({
        key: 'engine',
        text: 'engine passive',
        tone: 'warn',
        hint: 'Another desk tab owns message delivery'
      });
    }
    publishStatus('channels', segments);
  }, [selected, detail, queueTotal, enginePassive]);

  /* ---------- render ---------- */

  const channelSidebarSectionState = channelSidebarSections({ hasDetail: Boolean(detail), fileCount: detail?.files.length ?? 0 });

  return (
    <Group
      orientation="horizontal"
      className={`subsystemPanels editorPanels ${sidebarCollapsed ? 'editorSidebarCollapsed' : ''} ${sidebarAnimating ? 'sidebarAnimating' : ''}`}
      id="desk-channels-sidebar-v1"
    >
      <Panel
        id="channels-sidebar-tree"
        panelRef={sidebarPanelRef}
        defaultSize={`${initialWidthRef.current}px`}
        minSize={AGENT_SIDEBAR_MIN_SIZE}
        maxSize={AGENT_SIDEBAR_MAX_SIZE}
        collapsedSize="0px"
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleSidebarResize}
        className="editorTreePanel"
      >
        <aside className="editorTreePanelInner editorSidebar chanSidebar">
          <div className="sidebarHeader">
            <div className="railTitle">
              <MessagesSquare size={12} />
              <TextReveal as="span" manager="decipher">Channels</TextReveal>
            </div>
            <div className="railActions">
              <IconButton icon={<Plus size={12} />} label="Create channel" onClick={() => setCreateOpen(true)} />
              <IconButton icon={<RefreshCw size={12} />} label="Refresh channels" onClick={() => void refreshState()} />
              <IconButton icon={<HelpCircle size={12} />} label="Help" onClick={() => setChannelsHelpOpen(true)} />
            </div>
          </div>

          <Group orientation="vertical" className="chanSidebarSections" id="desk-channels-sidebar-sections-v1">
            <Panel
              id="channels-list-section"
              panelRef={channelListPanelRef}
              defaultSize={channelSidebarSectionState.members ? '54%' : '100%'}
              minSize="90px"
              className="chanSidebarSectionPanel chanListPanel"
            >
              <div className="chanList">
                <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
                  {channels.map((channel) => {
                    const unread = unreadFor(channel);
                    return (
                      <Animator key={channel.name} duration={LIST_ROW_DURATION}>
                        <Animated
                          as="button"
                          type="button"
                          className={`chanRow ${channel.name === selected ? 'selected' : ''}`}
                          animated={['flicker']}
                          title={channel.goal || channel.name}
                          onMouseEnter={() => bleeps.hover?.play()}
                          onClick={() => {
                            bleeps.click?.play();
                            selectChannel(channel.name, channel);
                          }}
                          onContextMenu={(event: React.MouseEvent) => {
                            event.preventDefault();
                            setSidebarMenu({ kind: 'channel', channel, x: event.clientX, y: event.clientY });
                          }}
                        >
                          <span className="chanRowHead">
                            <Hash size={11} />
                            <span className="chanRowName">{channel.name}</span>
                            {unread > 0 ? <Pill tone="warn">{unread}</Pill> : null}
                          </span>
                          {channel.lastMessage ? (
                            <small className="chanRowPreview">
                              @{channel.lastMessage.author}: {channel.lastMessage.preview}
                            </small>
                          ) : (
                            <small className="chanRowPreview empty">no messages</small>
                          )}
                        </Animated>
                      </Animator>
                    );
                  })}
                </Animator>
                {channels.length === 0 ? (
                  <div className="gitEmptyNote">
                    <TextReveal as="span" manager="sequence">No channels yet — create one to put your agents in a room.</TextReveal>
                  </div>
                ) : null}
              </div>
            </Panel>

            {detail ? (
              <>
                <Separator className="panelResizeHandle" disabled={!channelSidebarResizeHandleEnabled(false, membersCollapsed)} />
                <Panel
                  id="channels-members-section"
                  panelRef={membersPanelRef}
                  defaultSize="28%"
                  minSize="86px"
                  collapsedSize="28px"
                  collapsible
                  onResize={(size) => handleChannelSidebarSectionResize('members', size)}
                  className="chanSidebarSectionPanel"
                >
                  <section className={`chanSidebarSection chanMembers ${membersCollapsed ? 'collapsed' : ''}`}>
                    <div className="chanSectionHeader">
                      <button
                        type="button"
                        className="chanSectionToggle"
                        aria-expanded={!membersCollapsed}
                        aria-controls="channels-members-body"
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          toggleChannelSidebarSection('members');
                        }}
                      >
                        {membersCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        <span className="settingsSectionLabel">Members</span>
                        <Pill tone="muted">{detail.members.length}</Pill>
                      </button>
                      {!membersCollapsed ? (
                        <IconButton
                          icon={<UserPlus size={12} />}
                          label="Add agent to channel"
                          onClick={() => {
                            resetAddMemberFilters();
                            setAddMemberOpen(true);
                          }}
                        />
                      ) : null}
                    </div>
                    {!membersCollapsed ? (
                      <div id="channels-members-body" className="chanSectionBody">
                        {detail.members.map((member) => {
                          const live = member.tmuxSession ? sessionIndex.get(member.tmuxSession) : undefined;
                          const queue = member.tmuxSession ? deliveryIndex.get(member.tmuxSession) : undefined;
                          const running = member.type === 'human' ? true : live?.view.state === 'running';
                          return (
                            <div
                              key={member.name}
                              className="chanMemberRow"
                              title={live ? `${live.label} — ${live.view.spec.cwd}` : member.type}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                setSidebarMenu({ kind: 'member', member, x: event.clientX, y: event.clientY });
                              }}
                            >
                              <span className={`chanMemberDot ${running ? 'running' : 'missing'}`} />
                              <span className="chanMemberName">@{member.name}</span>
                              <Pill tone="muted">
                                {member.type === 'claude-code' ? 'claude' : member.type === 'codex-cli' ? 'codex' : member.type}
                              </Pill>
                              {queue && queue.queued > 0 ? <Pill tone="warn" title="queued prompts">{queue.queued}</Pill> : null}
                              {queue?.status === 'awaiting-approval' ? (
                                <Pill tone="warn" title="agent is waiting on a human (approval / input)">approval</Pill>
                              ) : queue?.status === 'submit-stuck' ? (
                                <Pill tone="warn" title="a delivery is stuck — recover from the engine console">stuck</Pill>
                              ) : queue?.status === 'blocked' ? (
                                <Pill tone="warn" title="delivery blocked past the hold threshold">blocked</Pill>
                              ) : queue?.status === 'paused' ? (
                                <Pill tone="muted" title="delivery paused by operator — resume from the engine console">paused</Pill>
                              ) : queue?.status === 'working' ? (
                                <Pill title="turn in flight">working</Pill>
                              ) : null}
                              {member.type !== 'human' ? (
                                <span className="gitRowActions">
                                  <IconButton icon={<X size={11} />} label={`Remove @${member.name}`} onClick={() => handleRemoveMember(member.name)} />
                                </span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                </Panel>
              </>
            ) : null}

            {detail && channelSidebarSectionState.files ? (
              <>
                <Separator className="panelResizeHandle" disabled={!channelSidebarResizeHandleEnabled(membersCollapsed, filesCollapsed)} />
                <Panel
                  id="channels-files-section"
                  panelRef={filesPanelRef}
                  defaultSize="18%"
                  minSize="74px"
                  collapsedSize="28px"
                  collapsible
                  onResize={(size) => handleChannelSidebarSectionResize('files', size)}
                  className="chanSidebarSectionPanel"
                >
                  <section className={`chanSidebarSection chanFiles ${filesCollapsed ? 'collapsed' : ''}`}>
                    <div className="chanSectionHeader">
                      <button
                        type="button"
                        className="chanSectionToggle"
                        aria-expanded={!filesCollapsed}
                        aria-controls="channels-files-body"
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          toggleChannelSidebarSection('files');
                        }}
                      >
                        {filesCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        <span className="settingsSectionLabel">Files</span>
                        <Pill tone="muted">{detail.files.length}</Pill>
                      </button>
                    </div>
                    {!filesCollapsed ? (
                      <div id="channels-files-body" className="chanSectionBody">
                        {detail.files.slice(0, 8).map((file) => (
                          <a
                            key={file.name}
                            className="chanFileRow"
                            href={channelFileUrl(detail.name, file.name)}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={`${file.name} · ${formatBytes(file.size)}`}
                          >
                            <FileText size={11} />
                            <span className="chanFileName">{file.name}</span>
                            <small>{shortTimeAgo(file.modifiedAt)}</small>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </section>
                </Panel>
              </>
            ) : null}
          </Group>
        </aside>
      </Panel>
      <Separator className="panelResizeHandle" disabled={sidebarCollapsed} />
      <Panel minSize={surfaceMinSize(narrowViewport)} className="subsystemSurface">
        {narrowViewport && !sidebarCollapsed ? (
          <button type="button" className="drawerScrim" aria-label="Close sidebar" onClick={() => collapseSidebarRef.current()} />
        ) : null}
        <main className="editorStage chanStage">
          {detail ? (
            <>
              <div className="chanHeader">
                <span className="chanHeaderName">
                  <Hash size={13} />
                  <TextReveal as="span" manager="decipher">{detail.name}</TextReveal>
                </span>
                {detail.goal ? <span className="chanHeaderGoal" title={detail.goal}>{detail.goal}</span> : null}
                <IconButton
                  icon={<Pencil size={11} />}
                  label="Edit channel goal"
                  onClick={() => {
                    setGoalText(detail.goal);
                    setGoalEditOpen(true);
                  }}
                />
                <span className="chanHeaderAvatars" title={detail.members.map((member) => `@${member.name}`).join(', ')}>
                  {detail.members.slice(0, 5).map((member) => (
                    <span key={member.name} className={`chanAvatar mini hue-${authorHue(member.name)} ${member.type === 'human' ? 'human' : ''}`}>
                      {authorInitials(member.name)}
                    </span>
                  ))}
                  {detail.members.length > 5 ? <small className="chanAvatarOverflow">+{detail.members.length - 5}</small> : null}
                </span>
                <Pill tone="muted" title="agent members">
                  <Bot size={9} /> {agentMembers.length}
                </Pill>
                <Pill
                  tone="muted"
                  title={`${detail.total} message${detail.total === 1 ? '' : 's'}${
                    detail.firstMessageAt ? ` · since ${detail.firstMessageAt}` : ''
                  }${detail.lastMessageAt ? ` · last ${detail.lastMessageAt}` : ''}`}
                >
                  <MessagesSquare size={9} /> {detail.total}
                </Pill>
                {detail.lastMessageAt ? (
                  <small className="chanHeaderStat" title={`last message ${detail.lastMessageAt}`}>
                    active {shortTimeAgo(detail.lastMessageAt)} ago
                  </small>
                ) : null}
                {queueTotal > 0 ? <Pill tone="warn" title="prompts queued across agents">{queueTotal} queued</Pill> : null}
                {enginePassive ? (
                  <Pill
                    tone="warn"
                    title={`Another desk process${enginePassiveOwner ? ` (pid ${enginePassiveOwner})` : ''} owns message dispatch for this channels home — this tab only reads. Reclaim by closing that process, or rebuild the engine from the engine console.`}
                  >
                    passive
                  </Pill>
                ) : null}
                <span className="chanHeaderSearch">
                  <Search size={11} />
                  <input
                    ref={filterInputRef}
                    className="chanHeaderSearchInput"
                    placeholder="filter messages..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query !== '' ? (
                    <IconButton icon={<X size={11} />} label="Clear filter" onClick={() => setQuery('')} />
                  ) : null}
                </span>
                {activeView ? (
                  <span className="chanActiveView" title={`saved view: ${activeView.name}`}>
                    <ListFilter size={11} />
                    <span className="chanActiveViewName">{activeView.name}</span>
                    <IconButton icon={<X size={11} />} label="Clear saved view" onClick={() => setActiveView(null)} />
                  </span>
                ) : null}
                <span className="gitRowActions">
                  <IconButton icon={<Search size={12} />} label="Search all channels" onClick={() => setSearchOpen(true)} />
                  <IconButton icon={<Activity size={12} />} label="Live delivery feed" onClick={() => setLiveFeedOpen(true)} />
                  <IconButton icon={<ListFilter size={12} />} label="Saved views" onClick={() => setSavedViewsOpen(true)} />
                  <IconButton icon={<History size={12} />} label="Delivery timeline" onClick={() => setTimelineOpen(true)} />
                  <IconButton icon={<Coffee size={12} />} label="While-away digest" onClick={() => setDigestOpen(true)} />
                  <IconButton icon={<Download size={12} />} label="Export channel to markdown" onClick={() => exportToMarkdown(detail.name)} />
                  <IconButton icon={<Star size={12} />} label="Featured messages" onClick={() => setFeaturedOpen(true)} />
                  <span className="chanInboxToggle">
                    <IconButton
                      icon={<Inbox size={12} />}
                      label={`Operator inbox${inboxAttentionCount > 0 ? ` — ${inboxAttentionCount} need attention` : ''}`}
                      onClick={() => setInboxOpen(true)}
                    />
                    {inboxAttentionCount > 0 ? <span className="chanInboxBadge">{inboxAttentionCount}</span> : null}
                  </span>
                  <IconButton
                    icon={<Gauge size={12} />}
                    label="Engine console — delivery diagnostics & controls"
                    onClick={() => setEngineOpen(true)}
                  />
                  <IconButton icon={<Trash2 size={12} />} label="Destroy channel" onClick={() => setDestroyTarget(detail.name)} />
                </span>
              </div>

              <Group orientation="horizontal" className="chanBody" id="desk-channels-thread-v1">
                <Panel minSize="320px" className="chanFeedPanel">
                  <div className="chanFeedColumn">
                    <MessageList
                      channel={detail.name}
                      messages={visibleMessages}
                      handles={handles}
                      canShare={channels.length > 1}
                      anchorId={!filtering ? visitAnchorId ?? undefined : undefined}
                      newDividerId={newDividerId}
                      unreadFromId={readPointerId}
                      anchorKey={`${detail.name}#${visitKey}`}
                      active={active}
                      restoreScrollAnchor={
                        !filtering && restoreScrollChannel === detail.name ? scrollAnchorByChannelRef.current.get(detail.name) ?? null : null
                      }
                      onScrollPosition={rememberChannelScroll}
                      hasOlder={!filtering && detail.hasOlder}
                      hasNewer={!filtering && detail.hasNewer}
                      onLoadOlder={!filtering ? loadOlder : undefined}
                      onLoadNewer={!filtering ? () => loadNewer(detail.name) : undefined}
                      onJumpLatest={!filtering && detail.hasNewer ? () => jumpToLatest(detail.name) : undefined}
                      onReadProgress={active && query === '' ? (id) => markChannelRead(detail.name, id) : undefined}
                      onOpenThread={openThread}
                      onMenu={setMenuTarget}
                      onMention={mentionAuthor}
                      onShare={openShare}
                      onEdit={openEdit}
                      onDelete={setDeleteTarget}
                      onOpenFile={onOpenFile}
                      onMentionNavigate={navigateToMember}
                      featuredIds={rootFeaturedIds}
                      onToggleFeatured={onToggleFeatured}
                      onDeepLink={onDeepLink}
                      onQuoteReply={onQuoteReply}
                      cursorId={cursorId}
                      onReact={onReact}
                      reactionsById={rootReactionsById}
                    />
                    {workingMembers.length > 0 ? (
                      <div className="chanWorkingStrip" aria-live="polite">
                        <span className="chanWorkingDots" aria-hidden="true">✻</span>
                        {workingMembers.map((name) => `@${name}`).join(', ')} working…
                      </div>
                    ) : null}
                    <Composer
                      channel={detail.name}
                      handles={handles}
                      placeholder={`Message #${detail.name} — @name targets one agent, @channel everyone`}
                      seedText={composerSeed}
                      draftKey={`desk.chanDraft.${detail.name}`}
                      onSend={(body) => handleSend(body)}
                      onError={onError}
                    />
                  </div>
                </Panel>
                {threadParent ? (
                  <>
                    <Separator className="panelResizeHandle" />
                    <Panel defaultSize="380px" minSize="280px" maxSize="60%" className="chanThreadPanel">
                      <Animator root active duration={{ enter: 0.25 }}>
                        <Animated as="aside" className="chanThread" animated={['flicker', ['x', 24, 0]]}>
                          <div className="chanThreadHeader">
                            <span className="railTitle">
                              <MessageSquareReply size={12} />
                              <TextReveal as="span" manager="decipher">Thread</TextReveal>
                            </span>
                            <small className="chanThreadCount">
                              {threadMessages.length} {threadMessages.length === 1 ? 'reply' : 'replies'}
                            </small>
                            <small className="chanMsgId">{threadParent}</small>
                            <IconButton
                              icon={<X size={12} />}
                              label="Close thread"
                              onClick={() => {
                                setThreadParent(null);
                                setThreadMessages([]);
                              }}
                            />
                          </div>
                          {/* One scroller: anchor inline at the top (highlighted via
                              anchorId) followed by the replies. */}
                          <MessageList
                            channel={detail.name}
                            messages={threadParentMessage ? [threadParentMessage, ...threadMessages] : threadMessages}
                            handles={handles}
                            threadParentId={threadParent}
                            anchorId={threadParent ?? undefined}
                            anchorKey={`thread#${threadParent ?? ''}`}
                            active={active}
                            compact
                            canShare={channels.length > 1}
                            onMenu={setMenuTarget}
                            onMention={mentionAuthor}
                            onShare={openShare}
                            onEdit={openEdit}
                            onDelete={setDeleteTarget}
                            onOpenFile={onOpenFile}
                            onMentionNavigate={navigateToMember}
                            featuredIds={threadFeaturedIds}
                            onToggleFeatured={onToggleFeatured}
                            onDeepLink={onDeepLink}
                            onQuoteReply={onQuoteReply}
                            cursorId={cursorId}
                            onReact={onReact}
                            reactionsById={threadReactionsById}
                          />
                          <Composer
                            channel={detail.name}
                            handles={handles}
                            placeholder={`Reply in thread ${threadParent}`}
                            draftKey={`desk.chanDraft.${detail.name}.${threadParent}`}
                            onSend={(body) => handleSend(body, threadParent)}
                            onError={onError}
                          />
                        </Animated>
                      </Animator>
                    </Panel>
                  </>
                ) : null}
              </Group>
            </>
          ) : (
            <DeskPanel texture>
              <Animator combine manager="stagger" duration={{ enter: 0.4, stagger: 0.08 }}>
                <div className="chanEmptyHero">
                  <Animator>
                    <Animated animated={['flicker', ['y', 10, 0]]}>
                      <MessagesSquare size={44} className="chanEmptyIcon" />
                    </Animated>
                  </Animator>
                  <Animator>
                    <Animated as="h2" className="chanEmptyTitle" animated={['flicker']}>
                      <TextReveal as="span" manager="decipher">AGENT CHANNELS</TextReveal>
                    </Animated>
                  </Animator>
                  <Animator>
                    <Animated as="p" className="chanEmptyText" animated={['fade']}>
                      {channels.length === 0
                        ? 'Put your agents in a room. They receive messages as prompts, reply through the protocol, and collaborate — with you in the loop via @human.'
                        : 'Select a channel from the sidebar to read the conversation.'}
                    </Animated>
                  </Animator>
                  {channels.length === 0 ? (
                    <Animator>
                      <Animated animated={['flicker', ['y', 8, 0]]}>
                        <Cmd icon={<Plus size={13} />} label="Create your first channel" onClick={() => setCreateOpen(true)} />
                      </Animated>
                    </Animator>
                  ) : null}
                </div>
              </Animator>
            </DeskPanel>
          )}
        </main>
      </Panel>

      {/* ---------- context menu (closed by the window click/Escape effect) ---------- */}
      {menuTarget ? (
        <div ref={menuRef} className="treeContextMenu" style={{ left: menuTarget.x, top: menuTarget.y, clipPath: CLIP_OCTAGON_TINY }}>
          {!menuTarget.threadParentId ? (
            <button type="button" className="treeMenuItem" onClick={() => openThread(menuTarget.message.id)}>
              <MessageSquareReply size={11} /> Reply in thread
            </button>
          ) : null}
          <button type="button" className="treeMenuItem" onClick={() => mentionAuthor(menuTarget)}>
            <AtSign size={11} /> Mention @{menuTarget.message.author}
          </button>
          <button
            type="button"
            className="treeMenuItem"
            onClick={() => {
              void navigator.clipboard.writeText(menuTarget.message.body);
              onInfo('message copied');
            }}
          >
            <FileText size={11} /> Copy text
          </button>
          <button
            type="button"
            className="treeMenuItem"
            onClick={() => {
              void navigator.clipboard.writeText(menuTarget.message.id);
              onInfo('message id copied');
            }}
          >
            <Hash size={11} /> Copy message id
          </button>
          {channels.length > 1 ? (
            <button type="button" className="treeMenuItem" onClick={() => openShare(menuTarget)}>
              <Forward size={11} /> Share to channel…
            </button>
          ) : null}
          <button type="button" className="treeMenuItem" onClick={() => openEdit(menuTarget)}>
            <Pencil size={11} /> Edit message
          </button>
          <button type="button" className="treeMenuItem" onClick={() => setDeleteTarget(menuTarget)}>
            <Trash2 size={11} /> Delete message
          </button>
        </div>
      ) : null}

      {/* ---------- engine console ---------- */}
      <EngineConsole open={engineOpen} onClose={() => setEngineOpen(false)} />
      <CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      <InboxView
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        onNavigate={(channel, messageId) => {
          navigateToMessage(channel, messageId);
        }}
        onOpenEngine={() => setEngineOpen(true)}
      />
      <FeaturedView
        open={featuredOpen}
        onClose={() => setFeaturedOpen(false)}
        onNavigate={(channel, messageId, thread) => {
          navigateToMessage(channel, messageId, thread);
        }}
      />
      <SearchView
        open={searchOpen}
        channels={channels.map((entry) => entry.name)}
        onClose={() => setSearchOpen(false)}
        onNavigate={(channel, messageId, thread) => {
          navigateToMessage(channel, messageId, thread);
        }}
      />

      <LiveFeedView
        open={liveFeedOpen}
        onClose={() => setLiveFeedOpen(false)}
        onNavigate={(channel, messageId, thread) => {
          navigateToMessage(channel, messageId, thread);
        }}
      />

      <SavedViewsView
        open={savedViewsOpen}
        onClose={() => setSavedViewsOpen(false)}
        onApply={(filter, name) => setActiveView({ name, filter })}
      />

      <TimelineView
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
        onNavigate={(channel, messageId) => {
          navigateToMessage(channel, messageId);
        }}
      />

      <DigestView
        open={digestOpen}
        onClose={() => setDigestOpen(false)}
        channels={channels.map((entry) => ({ name: entry.name, messageCount: entry.messageCount }))}
        seenCounts={Object.fromEntries(Object.entries(seenMap).map(([name, entry]) => [name, entry.count]))}
        onSelectChannel={(channel) => selectChannel(channel)}
        onNavigate={(channel, messageId) => {
          navigateToMessage(channel, messageId);
        }}
      />

      {/* ---------- modals ---------- */}
      {createOpen ? (
        <Modal title="Create channel" icon={<Hash size={13} />} onClose={() => setCreateOpen(false)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">Channel name (lowercase, hyphens)</span>
            <input
              className="treeInlineInput"
              autoFocus
              placeholder="mission-control"
              value={createName}
              onChange={(event) => setCreateName(event.target.value.toLowerCase())}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleCreate();
                }
              }}
            />
            <span className="settingsSectionLabel">Goal</span>
            <input
              className="treeInlineInput"
              placeholder="What is this room for?"
              value={createGoal}
              onChange={(event) => setCreateGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleCreate();
                }
              }}
            />
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setCreateOpen(false)} />
              <Cmd
                icon={<Plus size={12} />}
                label="Create"
                disabled={!/^[a-z][a-z0-9-]*$/.test(createName.trim())}
                onClick={handleCreate}
              />
            </div>
          </div>
        </Modal>
      ) : null}

      {addMemberOpen && detail ? (
        <Modal
          title={`Add agent to #${detail.name}`}
          icon={<UserPlus size={13} />}
          onClose={() => {
            setAddMemberOpen(false);
            resetAddMemberFilters();
          }}
        >
          <div className="chanAddAgentModal">
            {addableSessions.length > 0 ? (
              <div className="chanAddFilters">
                <div className="chanAddSearch">
                  <Search size={12} />
                  <input
                    className="treeInlineInput"
                    value={addMemberQuery}
                    placeholder="search agents..."
                    aria-label="Search agents"
                    onChange={(event) => setAddMemberQuery(event.target.value)}
                  />
                </div>
                <div className="chanAddFilterGrid">
                  <DeskSelect
                    value={addMemberProject}
                    options={[
                      { value: 'all', label: `All projects (${addableSessions.length})` },
                      ...addMemberProjectOptions.map((option) => ({
                        value: option.value,
                        label: `${option.label} (${option.count})`
                      }))
                    ]}
                    onChange={setAddMemberProject}
                  />
                  <DeskSelect
                    value={addMemberAgent}
                    options={[
                      { value: 'all', label: `All agents (${addableSessions.length})` },
                      ...addMemberAgentOptions.map((option) => ({
                        value: option.value,
                        label: `${option.label} (${option.count})`
                      }))
                    ]}
                    onChange={setAddMemberAgent}
                  />
                  <DeskSelect
                    value={addMemberState}
                    options={[
                      { value: 'all', label: 'Any status' },
                      { value: 'running', label: 'Running' },
                      { value: 'missing', label: 'Missing' }
                    ]}
                    onChange={(value) => setAddMemberState(value as 'all' | AddableAgentRuntimeState)}
                  />
                  <IconButton
                    icon={<X size={12} />}
                    label="Clear filters"
                    disabled={!addMemberFiltersActive}
                    onClick={resetAddMemberFilters}
                  />
                </div>
                <span className="settingsSectionLabel">
                  {filteredAddableSessions.length} of {addableSessions.length} available agents
                </span>
              </div>
            ) : null}
            <div className="chanPickList">
              {addableSessions.length === 0 ? (
                <div className="gitEmptyNote">Every desk agent is already in this channel (or none are configured).</div>
              ) : filteredAddableSessions.length === 0 ? (
                <div className="gitEmptyNote">No available agents match the current filters.</div>
              ) : (
                filteredAddableSessions.map(({ entry }) => {
                  const spec = entry.view.spec;
                  return (
                    <button
                      key={spec.tmuxSession}
                      type="button"
                      className="chanPickRow rich"
                      title={spec.tmuxSession}
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        setAddMemberOpen(false);
                        resetAddMemberFilters();
                        handleAddMember(entry.view);
                      }}
                    >
                      <span className={`chanMemberDot ${entry.view.state === 'running' ? 'running' : 'missing'}`} />
                      <span className="chanPickMain">
                        <span className="chanPickTop">
                          <strong>{spec.name}</strong>
                          <Pill tone="muted">{spec.agent ?? 'custom'}</Pill>
                          {entry.view.state !== 'running' ? <Pill tone="warn">not running</Pill> : null}
                        </span>
                        <small className="chanPickDetail">
                          {[spec.projectLabel, spec.groupLabel].filter(Boolean).join(' / ') || 'ungrouped'}
                        </small>
                        <small className="chanPickDetail dim">{spec.cwd}</small>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </Modal>
      ) : null}

      {shareTarget ? (
        <Modal title="Share message" icon={<Forward size={13} />} onClose={() => setShareTarget(null)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">
              {shareTarget.message.id} by @{shareTarget.message.author} → channel
            </span>
            <DeskSelect
              value={shareChannel}
              options={channels
                .filter((channel) => channel.name !== selected)
                .map((channel) => ({ value: channel.name, label: `#${channel.name}` }))}
              onChange={setShareChannel}
            />
            <span className="settingsSectionLabel">Comment (optional)</span>
            <input
              className="treeInlineInput"
              placeholder="Why is this relevant…"
              value={shareComment}
              onChange={(event) => setShareComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleShare();
                }
              }}
            />
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setShareTarget(null)} />
              <Cmd icon={<Forward size={12} />} label="Share" disabled={shareChannel === ''} onClick={handleShare} />
            </div>
          </div>
        </Modal>
      ) : null}

      {editTarget ? (
        <Modal title="Edit message" icon={<Pencil size={13} />} onClose={() => setEditTarget(null)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">
              {editTarget.message.id} by @{editTarget.message.author}
            </span>
            <textarea
              className="treeInlineInput chanEditArea"
              autoFocus
              rows={Math.min(14, Math.max(4, editText.split('\n').length + 1))}
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  handleEditSave();
                }
              }}
            />
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setEditTarget(null)} />
              <Cmd icon={<Pencil size={12} />} label="Save (Ctrl+Enter)" disabled={editText.trim() === ''} onClick={handleEditSave} />
            </div>
          </div>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal title="Delete message" icon={<Trash2 size={13} />} onClose={() => setDeleteTarget(null)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">
              Delete {deleteTarget.message.id} by @{deleteTarget.message.author}?
              {!deleteTarget.threadParentId && deleteTarget.message.threadFile ? ' Its thread will be deleted too.' : ''}
            </span>
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setDeleteTarget(null)} />
              <Cmd icon={<Trash2 size={12} />} label="Delete" onClick={handleDeleteMessage} />
            </div>
          </div>
        </Modal>
      ) : null}

      {goalEditOpen && selected ? (
        <Modal title={`Edit #${selected}`} icon={<Pencil size={13} />} onClose={() => setGoalEditOpen(false)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">Goal</span>
            <input
              className="treeInlineInput"
              autoFocus
              placeholder="What is this room for?"
              value={goalText}
              onChange={(event) => setGoalText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleGoalSave();
                }
              }}
            />
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setGoalEditOpen(false)} />
              <Cmd icon={<Pencil size={12} />} label="Save" onClick={handleGoalSave} />
            </div>
          </div>
        </Modal>
      ) : null}

      {destroyTarget ? (
        <Modal title="Destroy channel" icon={<Trash2 size={13} />} onClose={() => setDestroyTarget(null)}>
          <div className="thinForm modalForm">
            <span className="settingsSectionLabel">
              Delete #{destroyTarget} with all messages, threads and uploads? This cannot be undone.
            </span>
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setDestroyTarget(null)} />
              <Cmd icon={<Trash2 size={12} />} label="Destroy" onClick={handleDestroy} />
            </div>
          </div>
        </Modal>
      ) : null}

      {channelsHelpOpen ? (
        <Modal title="Channels" icon={<MessagesSquare size={13} />} onClose={() => setChannelsHelpOpen(false)}>
          <div className="thinForm modalForm">
            <div style={{ lineHeight: 1.6, color: '#ccc', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
              {`Channels are Slack-like rooms where agents and the operator coordinate work. Every message is a markdown block in a plain file on disk, so the whole history survives restarts, works without a database, and stays readable by any tool.

Message actions:
• Reply in thread or quote reply
• Mention author (@name, @channel, @human)
• Copy message link
• Share to another channel
• Star — adds to your Featured list
• React with ack, seen, done, or thumbs-up
• Edit and delete

Composing:
• Enter sends, Shift+Enter for newline
• Targeting via mentions: @name delivers to that agent, @channel to all
• Attach files by drag-and-drop or paste (up to 25 MiB)
• Drafts persist per channel

Unread tracking:
• Returns to first unread message
• Read position persists across reloads
• Jump to latest pill when scrolled away

More info: https://docs.desk.cloud/channels/`}
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ---------- sidebar context menu (channel rows + member rows) ---------- */}
      {sidebarMenu ? (
        <div
          ref={sidebarMenuRef}
          className="treeContextMenu"
          style={{ left: sidebarMenu.x, top: sidebarMenu.y, clipPath: CLIP_OCTAGON_TINY }}
        >
          {sidebarMenu.kind === 'channel' && sidebarMenu.channel ? (
            <>
              <button type="button" className="treeMenuItem" onClick={() => selectChannel(sidebarMenu.channel!.name)}>
                <Hash size={11} /> Open #{sidebarMenu.channel.name}
              </button>
              <button
                type="button"
                className="treeMenuItem"
                onClick={() => {
                  selectChannel(sidebarMenu.channel!.name);
                  setGoalText(sidebarMenu.channel!.goal);
                  setGoalEditOpen(true);
                }}
              >
                <Pencil size={11} /> Edit goal…
              </button>
              <button
                type="button"
                className="treeMenuItem"
                onClick={() => {
                  void navigator.clipboard.writeText(sidebarMenu.channel!.name);
                  onInfo('channel name copied');
                }}
              >
                <FileText size={11} /> Copy name
              </button>
              <button type="button" className="treeMenuItem" onClick={() => setDestroyTarget(sidebarMenu.channel!.name)}>
                <Trash2 size={11} /> Destroy channel…
              </button>
            </>
          ) : null}
          {sidebarMenu.kind === 'member' && sidebarMenu.member ? (
            <>
              <button
                type="button"
                className="treeMenuItem"
                onClick={() => setComposerSeed({ text: `@${sidebarMenu.member!.name} `, nonce: Date.now() })}
              >
                <AtSign size={11} /> Mention @{sidebarMenu.member.name}
              </button>
              {sidebarMenu.member.tmuxSession && onRevealAgent ? (
                <button
                  type="button"
                  className="treeMenuItem"
                  onClick={() => onRevealAgent(sidebarMenu.member!.tmuxSession!)}
                >
                  <Bot size={11} /> Go to agent terminal
                </button>
              ) : null}
              <button
                type="button"
                className="treeMenuItem"
                onClick={() => {
                  void navigator.clipboard.writeText(`@${sidebarMenu.member!.name}`);
                  onInfo('handle copied');
                }}
              >
                <FileText size={11} /> Copy handle
              </button>
              {sidebarMenu.member.tmuxSession &&
              (deliveryIndex.get(sidebarMenu.member.tmuxSession)?.queued ?? 0) > 0 ? (
                <button
                  type="button"
                  className="treeMenuItem"
                  onClick={() => {
                    void channelsQueueClear(sidebarMenu.member!.tmuxSession!)
                      .then(() => {
                        onInfo(`queue cleared for @${sidebarMenu.member!.name}`);
                        void refreshState();
                      })
                      .catch(report);
                  }}
                >
                  <X size={11} /> Drop queued prompts
                </button>
              ) : null}
              {sidebarMenu.member.type !== 'human' ? (
                <button
                  type="button"
                  className="treeMenuItem"
                  onClick={() => handleRemoveMember(sidebarMenu.member!.name)}
                >
                  <Trash2 size={11} /> Remove from channel
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Group>
  );
}
