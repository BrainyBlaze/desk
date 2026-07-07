import { Fragment, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Copy, CornerDownLeft, Paperclip, Square, StickyNote, X } from 'lucide-react';
import type {
  AgentSurfaceEvent,
  AgentSurfaceState
} from '../../core/agentSurfaceProtocol.js';
import {
  agentSurfaceClient,
  type SurfaceHandlers
} from './agentSurfaceClient.js';
import { resolveNativeFocusAnchorIndex } from './scrollAnchor.js';
import {
  applyEvent as applyEventToModel,
  buildAgentFeedItems,
  initialRowModel,
  rowsFromSnapshot,
  type AgentFeedItem,
  type AgentRow,
  type PendingPermission,
  type RowModel
} from './rowsModel.js';
import { channelsUpload } from '../channels/channelsClient.js';
import { composerInputHeightFromTopResize } from '../channels/channelsModel.js';
import {
  appendComposerFileLinks,
  composerPlainEnterShouldSend,
  composerResizeKeyDelta,
  dragComposerResize,
  finishComposerResize,
  handleComposerFileDragOver,
  handleComposerFileDrop,
  handleComposerFilePaste,
  runComposerFileUpload,
  startComposerResize
} from '../composerInput.js';

// Reuse the channels markdown renderer (spec §9: ChannelMarkdown). Lazy-loaded +
// memoized for code-splitting, same pattern as MessageList. AgentMarkdown wrapper
// defined below near the component tree.
const ChannelMarkdown = lazy(() => import('../channels/ChannelMarkdown.js'));

/**
 * Native UI surface — chat-style view of one agent session.
 *
 * MVP scope (this commit): snapshot + events rendered as chronological rows; basic
 * composer with Enter-to-send / Shift-Enter newline; status badge; visibility-driven
 * subscription. Tool rows render as compact disclosure blocks with input/output detail,
 * and permissions render as allow/deny cards.
 *
 * Reused channels primitives: file insertion, paste/drop guards, resize-key
 * handling, and Enter-to-send live in composerInput.ts; this surface keeps the
 * native-only slash palette and stop action local.
 */

const SURFACE_ID = `native-${Math.random().toString(36).slice(2, 10)}`;
type MessageMenuHandler = (text: string, x: number, y: number) => void;
type CreateNoteHandler = (text: string) => void;
type CopyState = 'idle' | 'copied' | 'failed';
const COPY_TIMEOUT_MS = 800;
const NATIVE_AGENT_FILE_CHANNEL = 'agent-files';
const NATIVE_AGENT_INPUT_MIN_HEIGHT = 32;
const NATIVE_AGENT_INPUT_MAX_HEIGHT = 240;
const NATIVE_AGENT_KEY_RESIZE_STEP = 12;

/**
 * Per-session composer drafts, module-level so they survive the keep-alive
 * unmount when the user switches tabs within a cell (UX item 2: switching
 * sessions used to destroy whatever was typed).
 */
const composerDrafts = new Map<string, string>();

/**
 * Both per-session Maps below live for the tab's lifetime and are keyed by
 * tmux session name — without a cap they grow one entry per session ever
 * visited. 200 sessions of drafts/counts is far beyond any real wall; evict
 * the least-recently-touched entry past that.
 */
const SESSION_MEMO_CAP = 200;
function touchSessionMemo<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > SESSION_MEMO_CAP) {
    map.delete(map.keys().next().value as string);
  }
}

/**
 * Per-session last-seen row counts (UX item 8): frozen while a surface is
 * unfocused/unmounted, advanced while the user is actually looking. On refocus,
 * rows beyond the frozen count sit below a "new since last view" separator.
 */
const lastSeenRowCounts = new Map<string, number>();

export function NativeAgentSurface({
  session,
  revision,
  focused = false,
  onMessageMenu,
  onCreateNote
}: NativeAgentSurfaceProps): JSX.Element {
  const surfaceId = useMemo(() => `${SURFACE_ID}-${session}-${revision}`, [session, revision]);
  const [model, setModel] = useState<RowModel>(initialRowModel);
  const [pendingAssistant, setPendingAssistant] = useState<Map<string, string>>(new Map());
  const [pipelineLive, setPipelineLive] = useState(false);
  const [agentModel, setAgentModel] = useState<string | undefined>(undefined);
  const [agentCommands, setAgentCommands] = useState<Array<{ name: string; description?: string }>>([]);
  const [slashPaletteOpen, setSlashPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [input, setInputState] = useState(() => composerDrafts.get(session) ?? '');
  const setInput = (value: string | ((current: string) => string)): void => {
    setInputState((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      touchSessionMemo(composerDrafts, session, next);
      return next;
    });
  };
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [manualInputHeight, setManualInputHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const slashPointerHandledRef = useRef(false);
  const focusAnchorPendingRef = useRef(false);

  // Subscribe to the broker.
  useEffect(() => {
    let disposed = false;
    setModel(initialRowModel());
    setPendingAssistant(new Map());
    setErrorMsg(null);
    setAgentCommands([]);
    setAgentModel(undefined);
    setSlashPaletteOpen(false);
    setPipelineLive(false);
    setAwaitingResponse(false);

    const handlers: SurfaceHandlers = {
      onSnapshot: ({ state, events }) => {
        if (disposed) return;
        setAwaitingResponse(false);
        setPipelineLive(true);
        setModel(rowsFromSnapshot(events, state));
        // session-info lives in the ring: a fresh page load must recover the
        // model badge and the command palette from the snapshot, not only from
        // live re-emits (found live: palette empty after reload).
        for (const event of events) {
          if (event.kind === 'session-info') {
            if (event.model) setAgentModel(event.model);
            if (Array.isArray(event.commands)) setAgentCommands(event.commands);
          }
        }
      },
      onEvent: (event) => {
        if (disposed) return;
        setPipelineLive(true);
        if (event.kind !== 'session-info') {
          setAwaitingResponse(false);
        }
        if (event.kind === 'session-info' && event.model) {
          setAgentModel(event.model);
        }
        if (event.kind === 'session-info' && Array.isArray(event.commands)) {
          setAgentCommands(event.commands);
        }
        if (event.kind === 'assistant-delta') {
          setPendingAssistant((prev) => {
            const next = new Map(prev);
            next.set(event.turnId, (next.get(event.turnId) ?? '') + event.text);
            return next;
          });
          return;
        }
        if (event.kind === 'assistant-message') {
          setPendingAssistant((prev) => {
            if (!prev.has(event.turnId)) return prev;
            const next = new Map(prev);
            next.delete(event.turnId);
            return next;
          });
        }
        setModel((prev) => {
          const next: RowModel = { rows: [...prev.rows], status: prev.status, pendingPermission: prev.pendingPermission };
          applyEventToModel(next, event);
          return next;
        });
      },
      onError: (_code, message) => {
        if (disposed) return;
        setAwaitingResponse(false);
        setErrorMsg(message);
      },
      onConnectionChange: (up) => {
        if (disposed) return;
        if (!up) setAwaitingResponse(false);
        setPipelineLive(up);
      },
      onExit: () => {
        if (disposed) return;
        setAwaitingResponse(false);
        setModel((prev) => ({ ...prev, status: 'exited' }));
      }
    };

    // All mounted cells in a group are physically visible (the keep-alive system only
    // unmounts whole non-warm groups). Broker visibility must track physical visibility,
    // not focus — otherwise non-focused native cells in a layout grid get no snapshot
    // and appear empty. Focus is a UI affordance (status badge highlight, etc.) only.
    agentSurfaceClient.subscribe(surfaceId, session, true, handlers);
    return () => {
      disposed = true;
      agentSurfaceClient.unsubscribe(surfaceId);
    };
  }, [session, surfaceId, revision]);

  // Broker visibility stays true for mounted surfaces — the cell is physically on-screen.
  // (The keep-alive unmount handles true-hidden cells by destroying the component entirely.)

  // Scroll UX: land on the LATEST message when a session opens/reloads, follow
  // live output while the user is at the bottom, and NEVER yank the view while
  // they read history — new rows raise a jump pill instead.
  const followingRef = useRef(true);
  const prevRowCountRef = useRef(0);
  const [unseenCount, setUnseenCount] = useState(0);
  const [expandedTurnIds, setExpandedTurnIds] = useState<Set<string>>(() => new Set());

  // UX item 8: "new since last view" separator. The marker index is fixed at
  // refocus/remount time (rows beyond the stored last-seen count are new);
  // while focused the stored count tracks the transcript so the next away-and-
  // back shows only what actually arrived in between.
  const [unreadMarkerIndex, setUnreadMarkerIndex] = useState<number | null>(null);
  useEffect(() => {
    if (focused) {
      focusAnchorPendingRef.current = true;
      const lastSeen = lastSeenRowCounts.get(session) ?? 0;
      setUnreadMarkerIndex(model.rows.length > lastSeen && lastSeen > 0 ? lastSeen : null);
    }
    // Falling out of focus freezes the stored count at whatever was last seen.
  }, [focused, session]);

  const feedItems = useMemo(
    () => buildAgentFeedItems(model.rows, { expandedTurnIds }),
    [model.rows, expandedTurnIds]
  );
  const virtualizer = useVirtualizer({
    count: feedItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 8
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalVirtualSize = virtualizer.getTotalSize();

  const scrollToLatest = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    if (feedItems.length > 0) {
      virtualizer.scrollToIndex(feedItems.length - 1, { align: 'end' });
    }
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (current) current.scrollTop = current.scrollHeight;
    });
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    scrollToLatest();
    followingRef.current = true;
    setUnseenCount(0);
  };

  const handleFeedScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followingRef.current = nearBottom;
    if (nearBottom && unseenCount !== 0) {
      setUnseenCount(0);
    }
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevCount = prevRowCountRef.current;
    prevRowCountRef.current = model.rows.length;
    // Snapshot replace (open/reload/backfill): the whole transcript arrives at
    // once while scrollTop is still 0 — land on the latest message.
    const snapshotReplace = prevCount === 0 && model.rows.length > 0;
    if (snapshotReplace || followingRef.current) {
      scrollToLatest();
      followingRef.current = true;
      if (unseenCount !== 0) setUnseenCount(0);
      return;
    }
    // Reading history: keep the view still, count what arrived below.
    if (model.rows.length > prevCount) {
      setUnseenCount((n) => n + (model.rows.length - prevCount));
    }
  }, [model.rows, pendingAssistant, model.pendingPermission]);

  useEffect(() => {
    if (!focused || !focusAnchorPendingRef.current || feedItems.length === 0) {
      return;
    }
    const lastSeen = lastSeenRowCounts.get(session) ?? 0;
    const rowCount = model.rows.length;
    const targetIndex = resolveNativeFocusAnchorIndex(feedItems, { lastSeenRowCount: lastSeen, rowCount });
    if (targetIndex === null) {
      return;
    }
    setUnreadMarkerIndex(rowCount > lastSeen && lastSeen > 0 ? lastSeen : null);
    virtualizer.scrollToIndex(targetIndex, { align: 'end' });
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (current && targetIndex === feedItems.length - 1) {
        current.scrollTop = current.scrollHeight;
      }
    });
    const unseen = lastSeen > 0 ? Math.max(0, rowCount - lastSeen) : 0;
    followingRef.current = unseen === 0;
    setUnseenCount(unseen);
    focusAnchorPendingRef.current = false;
  }, [feedItems, focused, model.rows.length, session, virtualizer]);

  useEffect(() => {
    if (focused && model.rows.length > 0 && !focusAnchorPendingRef.current) {
      touchSessionMemo(lastSeenRowCounts, session, model.rows.length);
    }
  }, [focused, session, model.rows.length]);

  const canSend = pipelineLive && model.status === 'idle' && input.trim().length > 0;
  const sendLabel = !pipelineLive
    ? 'Connecting...'
    : model.status === 'starting'
      ? 'Starting...'
      : model.status === 'idle'
        ? 'Send'
        : 'Wait...';
  const filteredAgentCommands = useMemo(
    () =>
      input.startsWith('/') && !input.includes(' ')
        ? agentCommands
            .filter((command) => command.name.toLowerCase().startsWith(input.slice(1).toLowerCase()))
            .slice(0, 8)
        : [],
    [agentCommands, input]
  );
  const slashPaletteVisible = slashPaletteOpen && input.startsWith('/') && !input.includes(' ');

  const inputHeightBounds = (): { minHeight: number; maxHeight: number } => ({
    minHeight: NATIVE_AGENT_INPUT_MIN_HEIGHT,
    maxHeight: Math.min(NATIVE_AGENT_INPUT_MAX_HEIGHT, Math.max(NATIVE_AGENT_INPUT_MIN_HEIGHT, window.innerHeight * 0.45))
  });

  const currentInputHeight = (): number =>
    inputRef.current?.getBoundingClientRect().height ?? manualInputHeight ?? NATIVE_AGENT_INPUT_MIN_HEIGHT;

  const setClampedManualInputHeight = (height: number): void => {
    setManualInputHeight(composerInputHeightFromTopResize(height, 0, 0, inputHeightBounds()));
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    startComposerResize(event, resizeRef, currentInputHeight());
  };

  const dragResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    dragComposerResize(event, resizeRef, (resize, clientY) => {
      setManualInputHeight(composerInputHeightFromTopResize(resize.startHeight, resize.startY, clientY, inputHeightBounds()));
    });
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    finishComposerResize(event, resizeRef);
  };

  const resizeFromKeyboard = (delta: number): void => {
    setClampedManualInputHeight(currentInputHeight() + delta);
  };

  const pickSlashCommand = (name: string): void => {
    setInput(`/${name} `);
    setSlashPaletteOpen(false);
    setPaletteIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openSlashCommands = (): void => {
    setSlashPaletteOpen(true);
    setPaletteIndex(0);
    setInput((current) => {
      if (current.startsWith('/') && !current.includes(' ')) return current;
      return '/';
    });
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const toggleSlashCommands = (): void => {
    if (slashPaletteVisible) {
      setSlashPaletteOpen(false);
      setPaletteIndex(0);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    openSlashCommands();
  };

  const uploadNativeFiles = async (files: FileList | File[]): Promise<void> => {
    await runComposerFileUpload(files, {
      channel: NATIVE_AGENT_FILE_CHANNEL,
      upload: channelsUpload,
      setUploading,
      appendLinks: (links) => setInput((current) => appendComposerFileLinks(current, links)),
      onSuccess: () => setErrorMsg(null),
      onError: setErrorMsg,
      focus: () => inputRef.current?.focus()
    });
  };

  const handleSend = (): void => {
    if (!canSend) return;
    const text = input.trim();
    try {
      agentSurfaceClient.send(surfaceId, session, text);
      setInput('');
      setErrorMsg(null);
      setAwaitingResponse(true);
    } catch (err) {
      setAwaitingResponse(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInterrupt = (): void => {
    try {
      agentSurfaceClient.interrupt(surfaceId, session);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePermission = (optionId: string, note?: string): void => {
    if (!model.pendingPermission) return;
    try {
      agentSurfaceClient.respondPermission(surfaceId, session, model.pendingPermission.requestId, optionId, note);
      setModel((prev) => ({ ...prev, pendingPermission: null }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleForceReconnect = (): void => {
    agentSurfaceClient.forceReconnect();
  };

  const pendingAssistantEntries = useMemo(
    () => [...pendingAssistant.entries()].map(([turnId, text]) => ({ turnId, text })),
    [pendingAssistant]
  );
  // Deliberately NOT gated on pendingAssistantEntries: a tool call that runs
  // after a partial assistant message would otherwise leave the transcript
  // dead-still for the whole tool duration.
  const showAgentThinking =
    awaitingResponse || model.status === 'processing' || model.status === 'tool-executing';

  return (
    <div className="nativeAgentSurface">
      <div className="nativeAgentHeader">
        <span className={`nativeAgentStatus state-${model.status}`}>{model.status}</span>
        {agentModel ? <span className="nativeAgentModelBadge">{agentModel}</span> : null}
        {/* Stop moved to the composer action slot (UX item 5); header keeps status only. */}
      </div>
      <div className="nativeAgentFeed" ref={scrollRef} onScroll={handleFeedScroll}>
        <div className="nativeAgentVirtualSpacer" style={{ height: totalVirtualSize }}>
          {virtualItems.map((virtualRow) => {
            const item = feedItems[virtualRow.index];
            if (!item) return null;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="nativeAgentVirtualItem"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {shouldShowUnreadMarkerBeforeItem(feedItems, virtualRow.index, unreadMarkerIndex) ? (
                  <div className="nativeAgentRow unreadMarker" aria-label="new since last view">
                    new since last view
                  </div>
                ) : null}
                <AgentFeedItemView
                  item={item}
                  onExpandTurn={(turnId) => setExpandedTurnIds((prev) => new Set(prev).add(turnId))}
                  onMessageMenu={onMessageMenu}
                  onCreateNote={onCreateNote}
                />
              </div>
            );
          })}
        </div>
        {pendingAssistantEntries.map(({ turnId, text }) => (
          <div key={`pending-${turnId}`} className="nativeAgentRow assistant pending">
            <span className="nativeAgentAuthor">assistant</span>
            <AgentMarkdown body={text} />
          </div>
        ))}
        {showAgentThinking ? (
          // UX item 1: between send and the first streamed token the transcript
          // used to sit dead-still; slow providers read as broken. A quiet
          // animated row says the agent is working.
          <div className="nativeAgentRow working" aria-live="polite">
            <span className="nativeAgentWorkingDots" aria-label="agent is thinking">
              <span>·</span>
              <span>·</span>
              <span>·</span>
            </span>
          </div>
        ) : null}
        {errorMsg ? <div className="nativeAgentError">{errorMsg}</div> : null}
        {!pipelineLive && model.status !== 'starting' ? (
          <div className="nativeAgentBridgeDown">
            broker connection lost; reconnecting…
            <button type="button" className="nativeAgentRetryButton" onClick={handleForceReconnect}>
              Retry now
            </button>
          </div>
        ) : null}
      </div>
      {unseenCount > 0 ? (
        <button type="button" className="nativeAgentJumpPill" onClick={jumpToLatest}>
          {unseenCount} new message{unseenCount === 1 ? '' : 's'} ↓
        </button>
      ) : null}
      {model.pendingPermission ? (
        <div className="nativeAgentPermissionDock" aria-live="polite">
          <PermissionCard permission={model.pendingPermission} onRespond={handlePermission} />
        </div>
      ) : null}
      <div
        className={`nativeAgentComposer ${dragOver ? 'dragOver' : ''}`}
        onDragOver={(event) => {
          handleComposerFileDragOver(event, setDragOver);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          handleComposerFileDrop(event, setDragOver, uploadNativeFiles);
        }}
      >
        {slashPaletteVisible ? (
          // UX item 9: slash palette — explicitly opened from the embedded slash
          // control, then live-filtered from the agent's session-info commands.
          <div className="nativeAgentPalette">
            {filteredAgentCommands.length > 0 ? (
              filteredAgentCommands.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  className={`nativeAgentPaletteItem${i === paletteIndex ? ' selected' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pickSlashCommand(c.name);
                  }}
                >
                  <span className="nativeAgentPaletteName">/{c.name}</span>
                  {c.description ? <span className="nativeAgentPaletteDesc">{c.description}</span> : null}
                </button>
              ))
            ) : (
              <div className="nativeAgentPaletteEmpty">No commands available</div>
            )}
          </div>
        ) : null}
        <button
          type="button"
          className="nativeAgentComposerResizeHandle"
          aria-label="Resize native agent input"
          title="Drag to resize native agent input"
          onPointerDown={startResize}
          onPointerMove={dragResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => {
            const delta = composerResizeKeyDelta(event.key, NATIVE_AGENT_KEY_RESIZE_STEP);
            if (delta !== null) {
              event.preventDefault();
              resizeFromKeyboard(delta);
            }
          }}
        />
        <div className="nativeAgentComposerInputWrap">
          <textarea
            ref={inputRef}
            className="nativeAgentInput"
            value={input}
            style={manualInputHeight ? { height: `${manualInputHeight}px` } : undefined}
            onChange={(e) => {
              setInput(e.target.value);
              const commandMode = e.target.value.startsWith('/') && !e.target.value.includes(' ');
              setSlashPaletteOpen(commandMode);
              if (!commandMode) {
                setPaletteIndex(0);
              }
            }}
            onPaste={(event) => {
              handleComposerFilePaste(event, uploadNativeFiles);
            }}
            onKeyDown={(e) => {
              if (slashPaletteVisible) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPaletteIndex((i) => (i + 1) % Math.max(filteredAgentCommands.length, 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPaletteIndex((i) => (i - 1 + Math.max(filteredAgentCommands.length, 1)) % Math.max(filteredAgentCommands.length, 1));
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const pick = filteredAgentCommands[Math.min(paletteIndex, filteredAgentCommands.length - 1)];
                  if (pick) {
                    pickSlashCommand(pick.name);
                  }
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashPaletteOpen(false);
                  setPaletteIndex(0);
                  if (input === '/') {
                    setInput('');
                  }
                  return;
                }
              }
              if (composerPlainEnterShouldSend(e.key, e.shiftKey)) {
                e.preventDefault();
                if (canSend) {
                  handleSend();
                }
              }
            }}
            placeholder="Send a message…"
            rows={2}
          />
          <div className="nativeAgentComposerRightActions">
            <button
              type="button"
              className="nativeAgentComposerIconButton nativeAgentSlashButton"
              aria-label="Open slash commands"
              title="Open slash commands"
              onPointerDown={(event) => {
                event.preventDefault();
                slashPointerHandledRef.current = true;
                toggleSlashCommands();
              }}
              onClick={() => {
                if (slashPointerHandledRef.current) {
                  slashPointerHandledRef.current = false;
                  return;
                }
                toggleSlashCommands();
              }}
            >
              <span className="nativeAgentSlashGlyph" aria-hidden="true">/</span>
            </button>
            <button
              type="button"
              className="nativeAgentComposerIconButton nativeAgentFileButton"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <Paperclip size={14} strokeWidth={2.1} aria-hidden="true" />
            </button>
            <input
              ref={fileInputRef}
              className="nativeAgentFileInput"
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) {
                  void uploadNativeFiles(event.target.files);
                  event.target.value = '';
                }
              }}
            />
            {model.status === 'processing' || model.status === 'tool-executing' ? (
              // UX item 5: while a turn runs, the composer's action slot IS the Stop
              // control — the user's cursor and attention live here, not the header.
              <button
                type="button"
                className="nativeAgentComposerIconButton nativeAgentSend nativeAgentSendStop"
                aria-label="Stop agent"
                title="Stop agent"
                onClick={handleInterrupt}
              >
                <Square className="nativeAgentStopGlyph" size={14} fill="currentColor" strokeWidth={2.1} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="nativeAgentComposerIconButton nativeAgentSend"
                aria-label="Send message"
                title={sendLabel}
                onClick={handleSend}
                disabled={!canSend || uploading}
              >
                <CornerDownLeft size={14} strokeWidth={2.1} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {uploading ? <div className="nativeAgentComposerStatus">uploading…</div> : null}
      </div>
    </div>
  );
}

function AgentFeedItemView({
  item,
  onExpandTurn,
  onMessageMenu,
  onCreateNote
}: {
  item: AgentFeedItem;
  onExpandTurn: (turnId: string) => void;
  onMessageMenu?: MessageMenuHandler;
  onCreateNote?: CreateNoteHandler;
}): JSX.Element {
  if (item.kind === 'row') {
    return <AgentRowView row={item.row} onMessageMenu={onMessageMenu} onCreateNote={onCreateNote} />;
  }
  return <TurnSummaryRow item={item} onExpand={() => onExpandTurn(item.turnId)} />;
}

function TurnSummaryRow({ item, onExpand }: { item: Extract<AgentFeedItem, { kind: 'turn-summary' }>; onExpand: () => void }): JSX.Element {
  return (
    <button type="button" className="nativeAgentRow nativeAgentTurnSummary" onClick={onExpand}>
      <span className="nativeAgentTurnSummaryTitle">Collapsed turn</span>
      <span className="nativeAgentTurnSummaryPreview">{item.preview}</span>
      <span className="nativeAgentTurnSummaryMeta">
        {item.rowCount} rows · {item.toolCount} tool{item.toolCount === 1 ? '' : 's'} · {item.assistantCount} repl{item.assistantCount === 1 ? 'y' : 'ies'}
      </span>
    </button>
  );
}

function shouldShowUnreadMarkerBeforeItem(
  items: AgentFeedItem[],
  index: number,
  unreadMarkerIndex: number | null
): boolean {
  if (unreadMarkerIndex === null) return false;
  const item = items[index];
  if (!item || item.lastRowIndex < unreadMarkerIndex) return false;
  const previous = items[index - 1];
  return !previous || previous.lastRowIndex < unreadMarkerIndex;
}

export interface NativeAgentSurfaceProps {
  /** Tmux session name (broker key). */
  session: string;
  /** Bumped by the parent when restart/switch happens so we resubscribe fresh. */
  revision: number;
  /** This cell holds the global selection — drives broker visibility. */
  focused?: boolean;
  /** Opens the shared Copy/Create note context menu for message-like rows. */
  onMessageMenu?: (text: string, x: number, y: number) => void;
  /** Creates a note directly from a message-like row. */
  onCreateNote?: (text: string) => void;
}

function AgentRowView({
  row,
  onMessageMenu,
  onCreateNote
}: {
  row: AgentRow;
  onMessageMenu?: MessageMenuHandler;
  onCreateNote?: CreateNoteHandler;
}): JSX.Element {
  const openMessageMenu = (event: ReactMouseEvent, text: string): void => {
    if (!onMessageMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onMessageMenu(text, event.clientX, event.clientY);
  };
  if (row.collapse) {
    return <CollapsiblePayloadRow row={row} onMessageMenu={onMessageMenu} />;
  }
  switch (row.kind) {
    case 'user-message':
      return (
        <div className="nativeAgentRow user" onContextMenu={(event) => openMessageMenu(event, row.text)}>
          <div className="nativeAgentMessageHeader">
            <RowMeta row={row} fallbackAuthor="you" />
            <RowActions text={row.text} onCreateNote={onCreateNote} />
          </div>
          <AgentMarkdown body={row.text} />
        </div>
      );
    case 'assistant-message':
      return (
        <div className="nativeAgentRow assistant" onContextMenu={(event) => openMessageMenu(event, row.text)}>
          <div className="nativeAgentMessageHeader">
            <RowMeta row={row} fallbackAuthor="assistant" />
            <RowActions text={row.text} onCreateNote={onCreateNote} />
          </div>
          <AgentMarkdown body={row.text} />
        </div>
      );
    case 'tool':
      return (
        <>
          <ToolCallBlock row={row} onMessageMenu={onMessageMenu} onCreateNote={onCreateNote} />
          {row.children && row.children.length > 0 ? (
            // Item 11: child-agent transcript nested under the spawning tool call.
            <div className="nativeAgentChildren">
              {row.children.map((child) => (
                <AgentRowView key={child.id} row={child} onMessageMenu={onMessageMenu} onCreateNote={onCreateNote} />
              ))}
            </div>
          ) : null}
        </>
      );
    case 'turn-complete':
      return <div className="nativeAgentRow turnComplete">— turn complete —</div>;
    case 'system':
      return <div className="nativeAgentRow system">{row.text}</div>;
    default:
      return <div className="nativeAgentRow unknown">{row.text}</div>;
  }
}

function CollapsiblePayloadRow({ row, onMessageMenu }: { row: AgentRow; onMessageMenu?: MessageMenuHandler }): JSX.Element {
  const [open, setOpen] = useState(!row.collapse?.defaultCollapsed);
  const author = row.kind === 'user-message' ? 'you' : row.kind;
  const reasonLabel = row.collapse?.reason === 'channel-onboarding' ? 'channel context' : 'long payload';
  const openMessageMenu = (event: ReactMouseEvent): void => {
    if (!onMessageMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onMessageMenu(row.text, event.clientX, event.clientY);
  };
  return (
    <div
      className={`nativeAgentRow ${row.kind === 'user-message' ? 'user' : 'system'} collapsible`}
      onContextMenu={openMessageMenu}
    >
      <button
        type="button"
        className="nativeAgentPayloadHeader"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nativeAgentPayloadMetaLine">
          <RowMeta row={row} fallbackAuthor={author} />
        </span>
        <span className="nativeAgentPayloadPreviewLine">
          <span className="nativeAgentPayloadReason">{reasonLabel}</span>
          <span className="nativeAgentPayloadPreview">{row.collapse?.preview}</span>
        </span>
        <span className={`nativeAgentPayloadChevron ${open ? 'open' : ''}`} aria-hidden="true">›</span>
      </button>
      {open ? <span className="nativeAgentText">{row.text}</span> : null}
    </div>
  );
}

function AgentMarkdown({ body }: { body: string }): JSX.Element {
  return (
    <Suspense fallback={<span className="nativeAgentText">{body}</span>}>
      <ChannelMarkdown body={body} channel={NATIVE_AGENT_FILE_CHANNEL} onOpenFile={() => undefined} />
    </Suspense>
  );
}

function ToolCallBlock({
  row,
  onMessageMenu,
  onCreateNote
}: {
  row: AgentRow;
  onMessageMenu?: MessageMenuHandler;
  onCreateNote?: CreateNoteHandler;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const statusClass = row.toolStatus ?? 'running';
  const tone = row.toolState?.tone ?? statusClass;
  const statusLabel = row.toolState?.label ?? statusClass;
  const durationLabel = formatDurationMs(row.toolState?.durationMs);
  const hasInput = Boolean(row.toolDetail?.trim());
  const hasOutput = Boolean(row.toolResult?.trim());
  const hasBody = hasInput || hasOutput;
  const copyText = row.toolResult ?? row.toolDetail ?? row.text;
  const openMessageMenu = (event: ReactMouseEvent): void => {
    if (!onMessageMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onMessageMenu(copyText, event.clientX, event.clientY);
  };
  return (
    <div className={`nativeAgentRow tool status-${statusClass}`} onContextMenu={openMessageMenu}>
      <span className="nativeAgentToolDot" aria-hidden="true" />
      <div className="nativeAgentToolContent">
        <div className="nativeAgentToolHeaderLine">
          <button
            type="button"
            className="nativeAgentToolHeader"
            aria-expanded={open}
            onClick={() => hasBody && setOpen((value) => !value)}
            disabled={!hasBody}
          >
            <span className="nativeAgentToolName">{row.toolName ?? row.toolUseId ?? 'tool'}</span>
            {row.text ? <span className="nativeAgentToolSummary">{row.text}</span> : null}
            <span className={`nativeAgentToolBadge tone-${tone}`} title={statusLabel}>
              {row.toolState?.active ? (
                <span className="nativeAgentToolSpinner" aria-label="tool is running" />
              ) : (
                <ToolStatusGlyph status={statusLabel} />
              )}
              {durationLabel ? <span className="nativeAgentToolElapsed">{durationLabel}</span> : null}
            </span>
            {hasBody ? <span className={`nativeAgentToolChevron ${open ? 'open' : ''}`} aria-hidden="true">›</span> : null}
          </button>
          <RowActions text={copyText} onCreateNote={onCreateNote} />
        </div>
        {open && hasBody ? (
          <div className="nativeAgentToolBody">
            {hasInput ? (
              <div className="nativeAgentToolBox">
                <span className="nativeAgentToolBoxLabel">in</span>
                <pre>{row.toolDetail}</pre>
              </div>
            ) : null}
            {hasOutput ? (
              <div className="nativeAgentToolBox">
                <span className="nativeAgentToolBoxLabel">out</span>
                <pre>{row.toolResult}</pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolStatusGlyph({ status }: { status: string }): JSX.Element {
  const normalized = status.toLowerCase();
  if (normalized === 'done' || normalized === 'ok' || normalized === 'success') {
    return <Check className="nativeAgentToolGlyph" size={12} aria-label="tool done" />;
  }
  if (normalized === 'failed' || normalized === 'error') {
    return <X className="nativeAgentToolGlyph" size={12} aria-label="tool failed" />;
  }
  if (normalized === 'denied') {
    return <X className="nativeAgentToolGlyph" size={12} aria-label="tool denied" />;
  }
  return <span className="nativeAgentToolGlyph" aria-label={status} />;
}

function RowMeta({ row, fallbackAuthor }: { row: AgentRow; fallbackAuthor: string }): JSX.Element {
  return (
    <span className="nativeAgentRowMeta">
      <span className="nativeAgentAuthor">{row.authorLabel ?? fallbackAuthor}</span>
      {row.createdAt ? (
        <time className="nativeAgentTimestamp" dateTime={row.createdAt} title={formatFullTimestamp(row.createdAt)}>
          {formatShortTimestamp(row.createdAt)}
        </time>
      ) : null}
    </span>
  );
}

function RowActions({ text, onCreateNote }: { text: string; onCreateNote?: CreateNoteHandler }): JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);
  const showCopyState = (state: CopyState): void => {
    setCopyState(state);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1300);
  };
  const handleCopy = async (): Promise<void> => {
    const copied = await copyRowText(text);
    showCopyState(copied ? 'copied' : 'failed');
  };
  const copyClassName =
    copyState === 'copied'
      ? 'nativeAgentRowAction copied'
      : copyState === 'failed'
        ? 'nativeAgentRowAction failed'
        : 'nativeAgentRowAction';
  const copyActionLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy';
  return (
    <span className="nativeAgentRowActions">
      <button
        type="button"
        className={copyClassName}
        onClick={() => void handleCopy()}
        aria-label={copyActionLabel}
        title={copyActionLabel}
        aria-live="polite"
      >
        <Copy size={14} aria-hidden="true" />
      </button>
      {onCreateNote ? (
        <button
          type="button"
          className="nativeAgentRowAction note"
          onClick={() => onCreateNote(text)}
          aria-label="Create note"
          title="Create note"
        >
          <StickyNote size={14} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

async function copyRowText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    const copied = await copyRowTextWithTimeout(navigator.clipboard, text);
    if (copied) return true;
  }
  return fallbackCopyRowText(text);
}

async function copyRowTextWithTimeout(clipboard: Clipboard, text: string): Promise<boolean> {
  try {
    return await Promise.race([
      clipboard.writeText(text).then(() => true),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), COPY_TIMEOUT_MS))
    ]);
  } catch {
    return false;
  }
}

function fallbackCopyRowText(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function formatShortTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatFullTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

function formatDurationMs(durationMs?: number): string | null {
  if (durationMs === undefined) return null;
  if (durationMs < 1000) return null;
  if (durationMs < 10000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function PermissionCard({
  permission,
  onRespond
}: {
  permission: PendingPermission;
  onRespond: (optionId: string, note?: string) => void;
}): JSX.Element {
  const [customText, setCustomText] = useState('');
  const hasCustom = permission.options.some((o) => o.treatment === 'custom');

  const handleCustom = (): void => {
    const opt = permission.options.find((o) => o.treatment === 'custom');
    if (opt) {
      onRespond(opt.id, customText.trim() || undefined);
    }
  };

  return (
    <div className={`nativeAgentPermission variant-${permission.variant}`}>
      <div className="nativeAgentPermissionTitle">{permission.title}</div>
      {permission.detail ? (
        <div className="nativeAgentPermissionDetail">{permission.detail}</div>
      ) : null}
      {permission.diff ? (
        <div className="nativeAgentPermissionDiff">
          <div className="nativeAgentPermissionDiffPath">{permission.diff.path}</div>
          {permission.diff.before ? (
            <pre className="nativeAgentPermissionDiffBefore">{permission.diff.before}</pre>
          ) : null}
          {permission.diff.after ? (
            <pre className="nativeAgentPermissionDiffAfter">{permission.diff.after}</pre>
          ) : null}
        </div>
      ) : null}
      <div className="nativeAgentPermissionOptions">
        {permission.options
          .filter((opt) => opt.treatment !== 'custom')
          .map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`nativeAgentPermissionOption treatment-${opt.treatment}`}
              onClick={() => onRespond(opt.id)}
            >
              {opt.label}
            </button>
          ))}
      </div>
      {hasCustom ? (
        <div className="nativeAgentPermissionCustom">
          <input
            type="text"
            className="nativeAgentPermissionCustomInput"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Type a custom answer…"
          />
          <button
            type="button"
            className="nativeAgentPermissionOption treatment-custom"
            onClick={handleCustom}
            disabled={!customText.trim()}
          >
            Submit
          </button>
        </div>
      ) : null}
    </div>
  );
}
