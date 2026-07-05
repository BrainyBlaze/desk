import { useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * Native UI surface — chat-style view of one agent session.
 *
 * MVP scope (this commit): snapshot + events rendered as chronological rows; basic
 * composer with Enter-to-send / Shift-Enter newline; status badge; visibility-driven
 * subscription. Tool and permission events render with a minimal functional shape
 * (tool summary line + permission card with allow/deny buttons) — proper styled
 * ToolCallBlock / PermissionCard components land in follow-up commits per spec §9.
 *
 * Reused channels primitives: Composer pattern from channels/Composer.tsx is mirrored
 * rather than imported (channels Composer carries channelsUpload coupling + channels-
 * specific mention handling; agentSurface/Composer.tsx will land with the uploadFn +
 * onSend SendResult contract per F2 in a follow-up).
 */

const SURFACE_ID = `native-${Math.random().toString(36).slice(2, 10)}`;

export function NativeAgentSurface({ session, revision, focused = false }: NativeAgentSurfaceProps): JSX.Element {
  const surfaceId = useMemo(() => `${SURFACE_ID}-${session}-${revision}`, [session, revision]);
  const [model, setModel] = useState<RowModel>(initialRowModel);
  const [pendingAssistant, setPendingAssistant] = useState<Map<string, string>>(new Map());
  const [bridgeDown, setBridgeDown] = useState(false);
  const [input, setInput] = useState('');
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

    const handlers: SurfaceHandlers = {
      onSnapshot: ({ state, events }) => {
        if (disposed) return;
        setModel(rowsFromSnapshot(events));
      },
      onEvent: (event) => {
        if (disposed) return;
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
        setBridgeDown(!up);
      },
      onExit: () => {
        if (disposed) return;
        setModel((prev) => ({ ...prev, status: 'exited' }));
      }
    };

    agentSurfaceClient.subscribe(surfaceId, session, focused, handlers);
    return () => {
      disposed = true;
      agentSurfaceClient.unsubscribe(surfaceId);
    };
  }, [session, surfaceId, focused, revision]);

  // Visibility follows focus changes.
  useEffect(() => {
    agentSurfaceClient.setVisibility(surfaceId, focused);
  }, [surfaceId, focused]);

  // Auto-scroll to bottom on new content (only when user is already near bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [model.rows, pendingAssistant, model.pendingPermission]);

  const handleSend = (): void => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    try {
      agentSurfaceClient.send(surfaceId, session, text);
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

  const handlePermission = (optionId: string): void => {
    if (!model.pendingPermission) return;
    try {
      agentSurfaceClient.respondPermission(surfaceId, session, model.pendingPermission.requestId, optionId);
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
        {model.status === 'processing' || model.status === 'tool-executing' ? (
          <button type="button" className="nativeAgentInterrupt" onClick={handleInterrupt}>
            Stop
          </button>
        ) : null}
      </div>
      <div className="nativeAgentFeed" ref={scrollRef}>
        {model.rows.map((row) => (
          <AgentRowView key={row.id} row={row} />
        ))}
        {pendingAssistantEntries.map(({ turnId, text }) => (
          <div key={`pending-${turnId}`} className="nativeAgentRow assistant pending">
            <span className="nativeAgentAuthor">assistant</span>
            <span className="nativeAgentText">{text}</span>
          </div>
        ))}
        {model.pendingPermission ? (
          <PermissionCard
            permission={model.pendingPermission}
            onRespond={(optionId, note) => {
              try {
                agentSurfaceClient.respondPermission(surfaceId, session, model.pendingPermission!.requestId, optionId, note);
                setModel((prev) => ({ ...prev, pendingPermission: null }));
              } catch (err) {
                setErrorMsg(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        ) : null}
        {errorMsg ? <div className="nativeAgentError">{errorMsg}</div> : null}
        {bridgeDown ? (
          <div className="nativeAgentBridgeDown">
            broker connection lost; reconnecting…
            <button type="button" className="nativeAgentRetryButton" onClick={handleForceReconnect}>
              Retry now
            </button>
          </div>
        ) : null}
      </div>
      <div className="nativeAgentComposer">
        <textarea
          className="nativeAgentInput"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Send a message…"
          rows={2}
        />
        <button type="button" className="nativeAgentSend" onClick={handleSend} disabled={!input.trim()}>
          Send
        </button>
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
          <span className="nativeAgentText">{row.text}</span>
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

function ToolCallBlock({ row }: { row: AgentRow }): JSX.Element {
  const icon = row.toolStatus === 'ok' ? '✓' : row.toolStatus === 'error' ? '✗' : row.toolStatus === 'denied' ? '⊘' : '⟳';
  const statusClass = row.toolStatus ?? 'running';
  return (
    <div className={`nativeAgentRow tool status-${statusClass}`}>
      <span className="nativeAgentToolIcon">{icon}</span>
      <span className="nativeAgentToolName">{row.toolUseId ?? 'tool'}</span>
      <span className="nativeAgentToolSummary">{row.text}</span>
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
