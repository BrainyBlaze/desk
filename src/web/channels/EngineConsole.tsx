import { useCallback, useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { ActionModal } from './ActionModal.js';
import {
  channelsEngineAction,
  channelsEngineDiagnostics,
  type DeliveryBlockReason,
  type EngineActionName,
  type EngineDiagnostics,
  type PaneState,
  type SessionDiagnostic,
  type SubmitState
} from './channelsClient.js';

/**
 * Channels engine ops console — a drawer toggled from the channels header that
 * surfaces live per-session delivery diagnostics (why each queue is held) and
 * the recovery levers: mark-idle, drop, force-deliver (gate-bypassing), drain
 * all ready sessions, and an in-process engine rebuild. The pane probe is the
 * point: it turns "queued: 20" into "held because the agent is mid-turn" vs
 * "held because capture came back empty".
 */

const PANE_LABEL: Record<PaneState, string> = {
  ready: 'ready',
  busy: 'working',
  'not-ready': 'not ready',
  booting: 'booting',
  'empty-capture': 'empty capture',
  offline: 'offline',
  unobservable: 'no capture'
};

/** ok = deliverable, muted = legitimately occupied, warn = needs attention. */
const PANE_TONE: Record<PaneState, 'ok' | 'muted' | 'warn'> = {
  ready: 'ok',
  busy: 'muted',
  'not-ready': 'warn',
  booting: 'muted',
  'empty-capture': 'warn',
  offline: 'warn',
  unobservable: 'warn'
};

const BLOCK_REASON_LABEL: Record<DeliveryBlockReason, string> = {
  approval: 'approval',
  'input-requested': 'input requested',
  offline: 'offline',
  booting: 'booting',
  busy: 'working',
  'not-ready': 'not ready',
  'trust-menu': 'trust menu',
  'selection-menu': 'selection menu',
  'unknown-menu': 'menu',
  'empty-capture': 'empty capture',
  'capture-failed': 'capture failed',
  unobservable: 'no capture',
  'send-failed': 'send failed',
  'submit-stuck-paste': 'paste stuck',
  'submit-stuck-submit': 'submit stuck'
};

const SUBMIT_STATE_LABEL: Record<SubmitState, string> = {
  delivering: 'delivering',
  submitted: 'submitted',
  'delivery-ack-timeout': 'ack timeout',
  'submit-stuck-paste': 'paste stuck',
  'submit-stuck-submit': 'submit stuck',
  'submit-stuck-unobservable': 'unobservable'
};

function ago(iso?: string): string {
  if (!iso) {
    return '—';
  }
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  return `${Math.round(m / 60)}h ago`;
}

interface ConfirmState {
  label: string;
  run: () => Promise<void> | void;
}

export function EngineConsole({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [diag, setDiag] = useState<EngineDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // True when the last poll/refresh failed: the cached `diag` is now stale, so
  // the live pills (pump live / N queued) must render as unknown rather than
  // keep asserting minutes-old values next to the error banner.
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDiag(await channelsEngineDiagnostics());
      setError(null);
      setStale(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStale(true);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const act = useCallback(
    async (action: EngineActionName, opts?: { tmuxSession?: string; seq?: number }) => {
      setBusyAction(true);
      try {
        const res = await channelsEngineAction(action, opts ?? {});
        setDiag((prev) =>
          prev
            ? { ...prev, sessions: res.sessions, totalQueued: res.sessions.reduce((sum, s) => sum + s.queued, 0) }
            : prev
        );
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyAction(false);
        void refresh();
      }
    },
    [refresh]
  );

  if (!open) {
    return null;
  }

  const sessions = (diag?.sessions ?? []).slice().sort((a, b) => b.queued - a.queued);
  // A stale snapshot (last poll failed) must not drive the live pills — render
  // them as unknown so they never assert minutes-old health beside the error.
  const live = stale ? null : diag;

  return (
    <ActionModal open={open} title="Engine console" icon={<Gauge size={13} />} onClose={onClose} wide>
      <div className="chanEngineDrawer chanEngineDrawerModal">
        <div className="chanEngineHead">
          <div className="chanEngineHealth">
            <span className={`chanEnginePill ${!live ? 'muted' : live.pumpAlive ? 'ok' : 'warn'}`}>
              {!live ? 'pump —' : live.pumpAlive ? 'pump live' : 'pump down'}
            </span>
            {live?.passive ? <span className="chanEnginePill warn">passive</span> : null}
            <span className="chanEnginePill muted">{live ? `${live.totalQueued} queued` : '— queued'}</span>
          </div>
        </div>

        <div className="chanEngineToolbar">
          <button className="chanEngineBtn" onClick={() => void refresh()} disabled={busyAction}>
            Refresh
          </button>
          <button className="chanEngineBtn" onClick={() => void act('drain-ready-all')} disabled={busyAction}>
            Drain ready
          </button>
          <button
            className="chanEngineBtn danger"
            disabled={busyAction}
            onClick={() =>
              setConfirm({
                label: 'Rebuild the engine in-process? Queues are preserved (re-read from disk) and the pump restarts. Use this to recover a wedged engine without restarting desk serve.',
                run: () => act('rebuild-engine')
              })
            }
          >
            Rebuild engine
          </button>
        </div>

        {diag?.home ? (
          <div className="chanEngineHome" title={diag.home}>
            {diag.home}
          </div>
        ) : null}
        {error ? <div className="chanEngineError">{error}</div> : null}

        <div className="chanEngineSessions">
          {sessions.map((s) => (
            <SessionRow
              key={s.tmuxSession}
              session={s}
              expanded={expanded.has(s.tmuxSession)}
              busy={busyAction}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.tmuxSession)) {
                    next.delete(s.tmuxSession);
                  } else {
                    next.add(s.tmuxSession);
                  }
                  return next;
                })
              }
              onMarkIdle={() => void act('mark-idle', { tmuxSession: s.tmuxSession })}
              onDropQueue={() => void act('drop-queue', { tmuxSession: s.tmuxSession })}
              onDropMessage={(seq) => void act('drop-message', { tmuxSession: s.tmuxSession, seq })}
              onForce={() =>
                setConfirm({
                  label: `Force-deliver to ${s.tmuxSession} now? This bypasses the busy/ready gate and can land inside a working agent's turn.`,
                  run: () => act('force-deliver', { tmuxSession: s.tmuxSession })
                })
              }
              onForceItem={(seq) =>
                setConfirm({
                  label: `Force-deliver stuck message ${seq} to ${s.tmuxSession} now? This reverts the stuck item to queued and delivers it, bypassing the busy/ready gate.`,
                  run: () => act('force-deliver', { tmuxSession: s.tmuxSession, seq })
                })
              }
              onPause={() => void act('pause-session', { tmuxSession: s.tmuxSession })}
              onResume={() => void act('resume-session', { tmuxSession: s.tmuxSession })}
            />
          ))}
          {diag && sessions.length === 0 ? <div className="chanEngineEmpty">No tracked sessions.</div> : null}
          {!diag && !error ? <div className="chanEngineEmpty">Loading…</div> : null}
        </div>

        {confirm ? (
          <div className="chanEngineConfirm">
            <p>{confirm.label}</p>
            <div className="chanEngineConfirmBtns">
              <button className="chanEngineBtn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="chanEngineBtn danger"
                onClick={async () => {
                  const run = confirm.run;
                  setConfirm(null);
                  await run();
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </ActionModal>
  );
}

function SessionRow({
  session,
  expanded,
  busy,
  onToggle,
  onMarkIdle,
  onDropQueue,
  onDropMessage,
  onForce,
  onForceItem,
  onPause,
  onResume
}: {
  session: SessionDiagnostic;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onMarkIdle: () => void;
  onDropQueue: () => void;
  onDropMessage: (seq: number) => void;
  onForce: () => void;
  onForceItem: (seq: number) => void;
  onPause: () => void;
  onResume: () => void;
}): JSX.Element {
  const flags = [
    session.awaitingApproval ? 'approval' : null,
    session.busy ? 'busy-flag' : null,
    session.draining ? 'draining' : null
  ].filter(Boolean);
  const blockedLabel =
    session.deliveryBlocked && session.blockedReason
      ? `blocked: ${BLOCK_REASON_LABEL[session.blockedReason]}`
      : null;
  const submitTone = session.submitState?.startsWith('submit-stuck') ? 'warn' : 'muted';
  const droppedQueueItems = session.droppedQueueItems ?? 0;
  const blockedItems = session.blockedItems ?? [];
  const hasExpandable = session.queued > 0 || blockedItems.length > 0;
  // Deliver/Drop stay live when there are durable stuck items even with an empty
  // runtime queue — the operator acts on .stuck-* via the per-seq backend path.
  const idleActionsDisabled = busy || (session.queued === 0 && blockedItems.length === 0);
  return (
    <div className="chanEngineSession">
      <div className="chanEngineSessionTop">
        <button
          className="chanEngineExpand"
          onClick={onToggle}
          disabled={!hasExpandable}
          aria-label={expanded ? 'Collapse queue' : 'Expand queue'}
        >
          {hasExpandable ? (expanded ? '▾' : '▸') : '·'}
        </button>
        {blockedLabel ? (
          <span className="chanEnginePill warn" title={blockedTitle(session)}>
            {blockedLabel}
          </span>
        ) : null}
        <span className={`chanEnginePane ${PANE_TONE[session.paneState]}`}>{PANE_LABEL[session.paneState]}</span>
        {session.submitState ? (
          <span className={`chanEnginePill ${submitTone}`}>{SUBMIT_STATE_LABEL[session.submitState]}</span>
        ) : null}
        <span className="chanEngineSessionName" title={session.tmuxSession}>
          {session.tmuxSession}
        </span>
        <span className="chanEngineQueued">{session.queued}</span>
        {droppedQueueItems > 0 ? (
          <span className="chanEnginePill warn">{droppedQueueItems} dropped</span>
        ) : null}
        {session.pausedByOperator ? (
          <span
            className="chanEnginePill warn"
            title={session.pauseReason ? `paused by operator: ${session.pauseReason}` : 'paused by operator'}
          >
            paused
          </span>
        ) : null}
        <span className="chanEngineMeta">deliv {ago(session.lastDeliveryAt)}</span>
        {flags.length > 0 ? <span className="chanEngineFlags">{flags.join(' · ')}</span> : null}
      </div>
      <div className="chanEngineSessionActions">
        <button className="chanEngineBtn" onClick={onForce} disabled={idleActionsDisabled}>
          Deliver now
        </button>
        <button className="chanEngineBtn" onClick={onMarkIdle} disabled={busy}>
          Mark idle
        </button>
        <button className="chanEngineBtn" onClick={onDropQueue} disabled={idleActionsDisabled}>
          Drop queue
        </button>
        {session.pausedByOperator ? (
          <button className="chanEngineBtn" onClick={onResume} disabled={busy}>
            Resume delivery
          </button>
        ) : (
          <button className="chanEngineBtn" onClick={onPause} disabled={busy}>
            Pause delivery
          </button>
        )}
      </div>
      {session.agent || session.sessionName || session.resume || session.hasResume !== undefined ? (
        <div className="chanEngineResume" title="agent resume health">
          {session.agent ? <span className="chanEngineMeta">{session.agent}</span> : null}
          {session.sessionName ? <span className="chanEngineMeta">{session.sessionName}</span> : null}
          {session.cwd ? (
            <span className="chanEngineMeta chanEngineCwd" title={session.cwd}>
              {session.cwd}
            </span>
          ) : null}
          {session.resume ? (
            <span className="chanEnginePill muted" title={`resume id: ${session.resume}`}>
              resume {session.hasResume ? '✓' : '?'}
            </span>
          ) : session.hasResume === false ? (
            <span className="chanEnginePill muted">no resume</span>
          ) : null}
          {session.bypassPermissions ? (
            <span className="chanEnginePill warn" title="launched with permission bypass">
              bypass perms
            </span>
          ) : null}
        </div>
      ) : null}
      {expanded && session.items.length > 0 ? (
        <>
          {session.deliveryBlocked ? (
            <div className="chanEngineMeta">
              held {session.blockedCycles ?? 0} cycles · since {ago(session.blockedSince)} · head{' '}
              {session.blockedHeadSeq ?? '—'}
            </div>
          ) : null}
          <ul className="chanEngineItems">
            {session.items.map((item) => (
              <li key={item.seq} className="chanEngineItem">
                <span className="chanEngineItemAuthor">@{item.author}</span>
                <span className="chanEngineItemPreview" title={item.preview}>
                  {item.preview || `(${item.kind})`}
                </span>
                <span className="chanEngineItemAge">{ago(item.queuedAt)}</span>
                <button
                  className="chanEngineItemDrop"
                  onClick={() => onDropMessage(item.seq)}
                  disabled={busy}
                  aria-label="Drop this message"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {expanded && blockedItems.length > 0 ? (
        <ul className="chanEngineItems chanEngineBlockedItems">
          {blockedItems.map((item) => (
            <li key={`blocked-${item.seq}`} className="chanEngineItem">
              <span className="chanEnginePill warn">{item.kind}</span>
              <span className="chanEngineItemAuthor">@{item.author}</span>
              <span className="chanEngineItemPreview" title={item.preview}>
                {item.preview || `(stuck ${item.kind})`}
              </span>
              <span className="chanEngineItemAge">{ago(item.queuedAt)}</span>
              <button
                className="chanEngineBtn"
                onClick={() => onForceItem(item.seq)}
                disabled={busy}
                aria-label="Force-deliver this stuck message"
              >
                Deliver
              </button>
              <button
                className="chanEngineItemDrop"
                onClick={() => onDropMessage(item.seq)}
                disabled={busy}
                aria-label="Drop this stuck message"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function blockedTitle(session: SessionDiagnostic): string {
  const parts = [
    session.blockedReason ? `reason: ${BLOCK_REASON_LABEL[session.blockedReason]}` : null,
    session.blockedCycles !== undefined ? `cycles: ${session.blockedCycles}` : null,
    session.blockedSince ? `since: ${session.blockedSince}` : null,
    session.blockedHeadSeq !== undefined ? `head seq: ${session.blockedHeadSeq}` : null
  ].filter(Boolean);
  return parts.join(' · ');
}
