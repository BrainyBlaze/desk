import { Fragment, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import type {
  AgentSurfaceEvent,
  AgentSurfaceState
} from '../../core/agentSurfaceProtocol.js';
import {
  agentSurfaceClient,
  type SurfaceHandlers
} from './agentSurfaceClient.js';
import {
  applyEvent as applyEventToModel,
  initialRowModel,
  rowsFromSnapshot,
  type AgentRow,
  type PendingPermission,
  type RowModel
} from './rowsModel.js';

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
 * Reused channels primitives: Composer pattern from channels/Composer.tsx is mirrored
 * rather than imported (channels Composer carries channelsUpload coupling + channels-
 * specific mention handling; agentSurface/Composer.tsx will land with the uploadFn +
 * onSend SendResult contract per F2 in a follow-up).
 */

const SURFACE_ID = `native-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Per-session composer drafts, module-level so they survive the keep-alive
 * unmount when the user switches tabs within a cell (UX item 2: switching
 * sessions used to destroy whatever was typed).
 */
const composerDrafts = new Map<string, string>();

/**
 * Per-session last-seen row counts (UX item 8): frozen while a surface is
 * unfocused/unmounted, advanced while the user is actually looking. On refocus,
 * rows beyond the frozen count sit below a "new since last view" separator.
 */
const lastSeenRowCounts = new Map<string, number>();

export function NativeAgentSurface({ session, revision, focused = false }: NativeAgentSurfaceProps): JSX.Element {
  const surfaceId = useMemo(() => `${SURFACE_ID}-${session}-${revision}`, [session, revision]);
  const [model, setModel] = useState<RowModel>(initialRowModel);
  const [pendingAssistant, setPendingAssistant] = useState<Map<string, string>>(new Map());
  const [pipelineLive, setPipelineLive] = useState(false);
  const [agentModel, setAgentModel] = useState<string | undefined>(undefined);
  const [input, setInputState] = useState(() => composerDrafts.get(session) ?? '');
  const setInput = (value: string): void => {
    composerDrafts.set(session, value);
    setInputState(value);
  };
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(focused);
  visibleRef.current = focused;

  // Subscribe to the broker.
  useEffect(() => {
    let disposed = false;
    setModel(initialRowModel());
    setPendingAssistant(new Map());
    setErrorMsg(null);
    setPipelineLive(false);

    const handlers: SurfaceHandlers = {
      onSnapshot: ({ state, events }) => {
        if (disposed) return;
        setModel(rowsFromSnapshot(events, state));
      },
      onEvent: (event) => {
        if (disposed) return;
        setPipelineLive(true);
        if (event.kind === 'session-info' && event.model) {
          setAgentModel(event.model);
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
        setErrorMsg(message);
      },
      onConnectionChange: (up) => {
        if (disposed) return;
        setPipelineLive(up);
      },
      onExit: () => {
        if (disposed) return;
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

  // UX item 8: "new since last view" separator. The marker index is fixed at
  // refocus/remount time (rows beyond the stored last-seen count are new);
  // while focused the stored count tracks the transcript so the next away-and-
  // back shows only what actually arrived in between.
  const [unreadMarkerIndex, setUnreadMarkerIndex] = useState<number | null>(null);
  useEffect(() => {
    if (focused) {
      const lastSeen = lastSeenRowCounts.get(session) ?? 0;
      setUnreadMarkerIndex(model.rows.length > lastSeen && lastSeen > 0 ? lastSeen : null);
    }
    // Falling out of focus freezes the stored count at whatever was last seen.
  }, [focused, session]);
  useEffect(() => {
    if (focused) {
      lastSeenRowCounts.set(session, model.rows.length);
    }
  }, [focused, session, model.rows.length]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
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
      el.scrollTop = el.scrollHeight;
      followingRef.current = true;
      if (unseenCount !== 0) setUnseenCount(0);
      return;
    }
    // Reading history: keep the view still, count what arrived below.
    if (model.rows.length > prevCount) {
      setUnseenCount((n) => n + (model.rows.length - prevCount));
    }
  }, [model.rows, pendingAssistant, model.pendingPermission]);

  const canSend = pipelineLive && model.status === 'idle' && input.trim().length > 0;
  const sendLabel = !pipelineLive
    ? 'Connecting...'
    : model.status === 'starting'
      ? 'Starting...'
      : model.status === 'idle'
        ? 'Send'
        : 'Wait...';

  const handleSend = (): void => {
    if (!canSend) return;
    const text = input.trim();
    try {
      agentSurfaceClient.send(surfaceId, session, text);
      setInput('');
      setErrorMsg(null);
    } catch (err) {
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

  return (
    <div className="nativeAgentSurface">
      <div className="nativeAgentHeader">
        <span className={`nativeAgentStatus state-${model.status}`}>{model.status}</span>
        {agentModel ? <span className="nativeAgentModelBadge">{agentModel}</span> : null}
        {/* Stop moved to the composer action slot (UX item 5); header keeps status only. */}
      </div>
      <div className="nativeAgentFeed" ref={scrollRef} onScroll={handleFeedScroll}>
        {model.rows.map((row, index) => (
          <Fragment key={row.id}>
            {unreadMarkerIndex !== null && index === unreadMarkerIndex ? (
              <div className="nativeAgentRow unreadMarker" aria-label="new since last view">
                new since last view
              </div>
            ) : null}
            <AgentRowView row={row} />
          </Fragment>
        ))}
        {pendingAssistantEntries.map(({ turnId, text }) => (
          <div key={`pending-${turnId}`} className="nativeAgentRow assistant pending">
            <span className="nativeAgentAuthor">assistant</span>
            <AgentMarkdown body={text} />
          </div>
        ))}
        {(model.status === 'processing' || model.status === 'tool-executing') && pendingAssistantEntries.length === 0 ? (
          // UX item 1: between send and the first streamed token the transcript
          // used to sit dead-still — slow providers read as broken. A quiet
          // animated row says the agent is working.
          <div className="nativeAgentRow working" aria-live="polite">
            <span className="nativeAgentWorkingDots" aria-label="agent is working">
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
      <div className="nativeAgentComposer">
        <textarea
          className="nativeAgentInput"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) {
                handleSend();
              }
            }
          }}
          placeholder="Send a message…"
          rows={2}
        />
        {model.status === 'processing' || model.status === 'tool-executing' ? (
          // UX item 5: while a turn runs, the composer's action slot IS the Stop
          // control — the user's cursor and attention live here, not the header.
          <button type="button" className="nativeAgentSend nativeAgentSendStop" onClick={handleInterrupt}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="nativeAgentSend"
            onClick={handleSend}
            disabled={!canSend}
          >
            {sendLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export interface NativeAgentSurfaceProps {
  /** Tmux session name (broker key). */
  session: string;
  /** Bumped by the parent when restart/switch happens so we resubscribe fresh. */
  revision: number;
  /** This cell holds the global selection — drives broker visibility. */
  focused?: boolean;
}

function AgentRowView({ row }: { row: AgentRow }): JSX.Element {
  if (row.collapse) {
    return <CollapsiblePayloadRow row={row} />;
  }
  switch (row.kind) {
    case 'user-message':
      return (
        <div className="nativeAgentRow user">
          <span className="nativeAgentAuthor">you</span>
          <span className="nativeAgentText">{row.text}</span>
        </div>
      );
    case 'assistant-message':
      return (
        <div className="nativeAgentRow assistant">
          <span className="nativeAgentAuthor">assistant</span>
          <AgentMarkdown body={row.text} />
        </div>
      );
    case 'tool':
      return <ToolCallBlock row={row} />;
    case 'turn-complete':
      return <div className="nativeAgentRow turnComplete">— turn complete —</div>;
    case 'system':
      return <div className="nativeAgentRow system">{row.text}</div>;
    default:
      return <div className="nativeAgentRow unknown">{row.text}</div>;
  }
}

function CollapsiblePayloadRow({ row }: { row: AgentRow }): JSX.Element {
  const [open, setOpen] = useState(!row.collapse?.defaultCollapsed);
  const author = row.kind === 'user-message' ? 'you' : row.kind;
  const reasonLabel = row.collapse?.reason === 'channel-onboarding' ? 'channel context' : 'long payload';
  return (
    <div className={`nativeAgentRow ${row.kind === 'user-message' ? 'user' : 'system'} collapsible`}>
      <button
        type="button"
        className="nativeAgentPayloadHeader"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nativeAgentAuthor">{author}</span>
        <span className="nativeAgentPayloadReason">{reasonLabel}</span>
        <span className="nativeAgentPayloadPreview">{row.collapse?.preview}</span>
        <span className={`nativeAgentPayloadChevron ${open ? 'open' : ''}`} aria-hidden="true">›</span>
      </button>
      {open ? <span className="nativeAgentText">{row.text}</span> : null}
    </div>
  );
}

function AgentMarkdown({ body }: { body: string }): JSX.Element {
  return (
    <Suspense fallback={<span className="nativeAgentText">{body}</span>}>
      <ChannelMarkdown body={body} channel="" onOpenFile={() => undefined} />
    </Suspense>
  );
}

function ToolCallBlock({ row }: { row: AgentRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  const statusClass = row.toolStatus ?? 'running';
  const hasInput = Boolean(row.toolDetail?.trim());
  const hasOutput = Boolean(row.toolResult?.trim());
  const hasBody = hasInput || hasOutput;
  return (
    <div className={`nativeAgentRow tool status-${statusClass}`}>
      <span className="nativeAgentToolDot" aria-hidden="true" />
      <div className="nativeAgentToolContent">
        <button
          type="button"
          className="nativeAgentToolHeader"
          aria-expanded={open}
          onClick={() => hasBody && setOpen((value) => !value)}
          disabled={!hasBody}
        >
          <span className="nativeAgentToolName">{row.toolName ?? row.toolUseId ?? 'tool'}</span>
          {row.text ? <span className="nativeAgentToolSummary">{row.text}</span> : null}
          <span className="nativeAgentToolStatus">{statusClass}</span>
          {hasBody ? <span className={`nativeAgentToolChevron ${open ? 'open' : ''}`} aria-hidden="true">›</span> : null}
        </button>
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
