import { drainNativeAttentionEvents } from './runtime/nativeSessionControl.js';

/**
 * Agent-attention tracking.
 *
 * Agent CLIs (Codex, Claude Code) emit terminal notifications when a turn
 * completes and they start waiting for user input — a BEL or an OSC 9
 * sequence, exactly what makes a regular terminal play a sound. The daemon's
 * authoritative emulator observes those events per session and buffers them
 * in a bounded ring; the poller here drains that ring. Typed agent events
 * (/api/agent-event hooks) are the second capture path.
 */

export interface AttentionEntry {
  attention: true;
  since: string;
}

export type AttentionSnapshot = Record<string, AttentionEntry>;

export type AgentEventKind = 'turn-complete' | 'approval-requested' | 'input-requested' | 'bell' | 'channel';

export interface AgentEvent {
  id: string;
  /** The session's durable identity (sessionId). */
  sessionId: string;
  kind: AgentEventKind;
  message?: string;
  at: string;
  read: boolean;
  /** channel events: navigation anchor (channel + message, thread parent when threaded) */
  channel?: string;
  messageId?: string;
  thread?: string;
}

const MAX_EVENTS = 200;
/** A precision event arriving shortly after a generic bell for the same session upgrades it. */
const EVENT_UPGRADE_WINDOW_MS = 5000;

export class AttentionTracker {
  private readonly entries = new Map<string, AttentionEntry>();
  private readonly clearedAt = new Map<string, number>();
  private readonly events: AgentEvent[] = [];
  private eventSeq = 0;

  /** Returns true when the session was not already in the attention state. */
  raise(sessionId: string): boolean {
    if (this.entries.has(sessionId)) {
      return false;
    }
    this.entries.set(sessionId, { attention: true, since: new Date().toISOString() });
    return true;
  }

  clear(sessionId: string, epochSeconds = Math.floor(Date.now() / 1000)): void {
    this.entries.delete(sessionId);
    this.clearedAt.set(sessionId, epochSeconds);
    // Touching a terminal acknowledges its pending notifications.
    for (const event of this.events) {
      if (event.sessionId === sessionId) {
        event.read = true;
      }
    }
  }

  /** Epoch seconds of the last user touch for a session (0 if never). */
  lastClearedAt(sessionId: string): number {
    return this.clearedAt.get(sessionId) ?? 0;
  }

  pushEvent(
    sessionId: string,
    kind: AgentEventKind,
    message?: string,
    meta?: { channel?: string; messageId?: string; thread?: string }
  ): AgentEvent {
    // Both channels can fire for one moment (TUI bell sniffed + precise event):
    // upgrade a fresh unread generic bell instead of duplicating the card.
    // Only turn signals upgrade — a channel message is a separate moment.
    if (kind === 'turn-complete' || kind === 'approval-requested' || kind === 'input-requested') {
      const recent = [...this.events]
        .reverse()
        .find((event) => event.sessionId === sessionId && event.kind === 'bell' && !event.read);
      if (recent && Date.now() - Date.parse(recent.at) <= EVENT_UPGRADE_WINDOW_MS) {
        recent.kind = kind;
        if (message) {
          recent.message = message;
        }
        return recent;
      }
    }
    const event: AgentEvent = {
      id: `evt-${++this.eventSeq}`,
      sessionId,
      kind,
      message,
      at: new Date().toISOString(),
      read: false,
      ...meta
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    return event;
  }

  clearEvents(): void {
    this.events.length = 0;
    // Clearing the log acknowledges everything — sidebar dots must agree.
    const epoch = Math.floor(Date.now() / 1000);
    for (const session of this.entries.keys()) {
      this.clearedAt.set(session, epoch);
    }
    this.entries.clear();
  }

  markEventsRead(options: { ids?: string[]; all?: boolean; kinds?: AgentEventKind[] }): void {
    const touched = new Set<string>();
    for (const event of this.events) {
      if (options.all || options.ids?.includes(event.id) || options.kinds?.includes(event.kind)) {
        event.read = true;
        touched.add(event.sessionId);
      }
    }
    // Read state and the sidebar attention dot are one acknowledgment: a
    // session whose events are all read must not keep a lit lamp.
    const epoch = Math.floor(Date.now() / 1000);
    for (const session of touched) {
      const hasUnread = this.events.some((event) => event.sessionId === session && !event.read);
      if (!hasUnread && this.entries.has(session)) {
        this.entries.delete(session);
        this.clearedAt.set(session, epoch);
      }
    }
  }

  listEvents(): AgentEvent[] {
    return [...this.events].reverse(); // newest first
  }

  unreadCount(): number {
    return this.events.reduce((count, event) => count + (event.read ? 0 : 1), 0);
  }

  snapshot(): AttentionSnapshot {
    return Object.fromEntries(this.entries);
  }

  /**
   * Drops attention for sessions that no longer exist in tmux — "needs input"
   * on a dead session is a contradiction (verified live: an externally killed
   * session kept its amber lamp). Their unread events are marked read too: an
   * unread badge cannot be acted on once the session is gone. Returns the
   * sessions that were dropped.
   */
  dropDead(running: ReadonlySet<string>): string[] {
    const dropped: string[] = [];
    for (const session of this.entries.keys()) {
      if (!running.has(session)) {
        dropped.push(session);
      }
    }
    for (const session of dropped) {
      this.clear(session);
    }
    return dropped;
  }
}

export const attentionTracker = new AttentionTracker();

let raiseListener: ((sessionId: string) => void) | null = null;

/** Invoked on every newly raised attention (a turn completed / approval rang). */
export function setRaiseListener(listener: ((sessionId: string) => void) | null): void {
  raiseListener = listener;
}

export function notifyRaise(sessionId: string): void {
  raiseListener?.(sessionId);
}

/**
 * Kind-aware agent signal fanout. Unlike the raise listener (which only fires
 * on newly raised attention), signal listeners see EVERY turn signal from both
 * capture paths — the tmux bell poller and the typed /api/agent-event hook —
 * including repeats while attention is already raised. The channels engine
 * uses this as its "input released" trigger.
 */
export type AgentSignalListener = (sessionId: string, kind: AgentEventKind) => void;

const signalListeners = new Set<AgentSignalListener>();

export function addAgentSignalListener(listener: AgentSignalListener): () => void {
  signalListeners.add(listener);
  return () => signalListeners.delete(listener);
}

export function notifyAgentSignal(sessionId: string, kind: AgentEventKind): void {
  for (const listener of signalListeners) {
    try {
      listener(sessionId, kind);
    } catch {
      // a faulty listener must not break attention tracking
    }
  }
}

let pollTimer: NodeJS.Timeout | undefined;
let pollInFlight = false;
/** Drain cursor into the daemon's attention ring (atch-native path). */
let nativeAttentionCursor = 0;

/**
 * Drain the daemon's buffered bell/OSC9 events and raise attention for each —
 * the atch-native replacement for tmux bell flags. The daemon, the tracker,
 * and both fanouts all key by sessionId — no mapping anywhere.
 */
async function drainNativeAttention(): Promise<void> {
  const { events, lastSeq } = await drainNativeAttentionEvents(nativeAttentionCursor);
  for (const event of events) {
    if (attentionTracker.raise(event.sessionId)) {
      attentionTracker.pushEvent(event.sessionId, 'bell', event.data);
    }
    notifyRaise(event.sessionId);
    notifyAgentSignal(event.sessionId, 'bell');
  }
  nativeAttentionCursor = lastSeq;
}

/** Starts the background attention drain (idempotent). */
export function startAttentionPolling(intervalMs = 2000): void {
  if (pollTimer) {
    return;
  }
  const tick = async (): Promise<void> => {
    if (pollInFlight) {
      return; // a slow daemon must not stack overlapping drains
    }
    pollInFlight = true;
    try {
      await drainNativeAttention();
    } finally {
      pollInFlight = false;
    }
  };
  pollTimer = setInterval(() => void tick(), intervalMs);
  pollTimer.unref?.();
}

export function stopAttentionPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  nativeAttentionCursor = 0;
}
