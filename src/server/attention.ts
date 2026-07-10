import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Agent-attention tracking.
 *
 * Agent CLIs (Codex, Claude Code) emit terminal notifications when a turn
 * completes and they start waiting for user input — a BEL or an OSC 9
 * sequence, exactly what makes a regular terminal play a sound. Desk captures
 * those signals two ways:
 *  - attached sessions: the PTY bridge sniffs the output stream;
 *  - unattached sessions: tmux latches `window_bell_flag` (monitor-bell is on
 *    by default), polled in one `list-windows -a` call for all sessions.
 */

export interface AttentionEntry {
  attention: true;
  since: string;
}

export type AttentionSnapshot = Record<string, AttentionEntry>;

export type AgentEventKind = 'turn-complete' | 'approval-requested' | 'input-requested' | 'bell' | 'channel';

export interface AgentEvent {
  id: string;
  tmuxSession: string;
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
  raise(tmuxSession: string): boolean {
    if (this.entries.has(tmuxSession)) {
      return false;
    }
    this.entries.set(tmuxSession, { attention: true, since: new Date().toISOString() });
    return true;
  }

  clear(tmuxSession: string, epochSeconds = Math.floor(Date.now() / 1000)): void {
    this.entries.delete(tmuxSession);
    this.clearedAt.set(tmuxSession, epochSeconds);
    // Touching a terminal acknowledges its pending notifications.
    for (const event of this.events) {
      if (event.tmuxSession === tmuxSession) {
        event.read = true;
      }
    }
  }

  /** Epoch seconds of the last user touch for a session (0 if never). */
  lastClearedAt(tmuxSession: string): number {
    return this.clearedAt.get(tmuxSession) ?? 0;
  }

  pushEvent(
    tmuxSession: string,
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
        .find((event) => event.tmuxSession === tmuxSession && event.kind === 'bell' && !event.read);
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
      tmuxSession,
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
        touched.add(event.tmuxSession);
      }
    }
    // Read state and the sidebar attention dot are one acknowledgment: a
    // session whose events are all read must not keep a lit lamp.
    const epoch = Math.floor(Date.now() / 1000);
    for (const session of touched) {
      const hasUnread = this.events.some((event) => event.tmuxSession === session && !event.read);
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

/**
 * Extracts terminal notifications from a PTY output chunk:
 * OSC 9 sequences carry a message (codex `tui.notification_method = osc9`);
 * a bare BEL is a generic notification. BELs that merely terminate other OSC
 * sequences (e.g. OSC 0 title updates) do not count.
 */
export function extractTerminalNotifications(chunk: string): Array<{ kind: AgentEventKind; message?: string }> {
  // Hot path: this runs on every PTY output chunk of every attached session. Plain
  // output has neither a BEL nor an OSC-9 intro, so an indexOf pre-check skips the
  // full-chunk regex .replace below (33x faster per chunk on plain output, and no
  // per-chunk allocation). A notification is only possible if one of those bytes is
  // present; everything past this guard is unchanged.
  if (chunk.indexOf('\x07') === -1 && chunk.indexOf('\x1b]9') === -1) {
    return [];
  }
  const found: Array<{ kind: AgentEventKind; message?: string }> = [];
  const oscNine = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  while ((match = oscNine.exec(chunk)) !== null) {
    const message = match[1]?.trim();
    const kind: AgentEventKind = /approv|permission/i.test(message ?? '')
      ? 'approval-requested'
      : /\b(needs input|input requested|question(?:\.asked)?|answer required)\b/i.test(message ?? '')
        ? 'input-requested'
        : 'turn-complete';
    found.push({ kind, message: message || undefined });
  }
  const withoutOsc = chunk.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  if (withoutOsc.includes('\x07')) {
    found.push({ kind: 'bell' });
  }
  return found;
}

/** Back-compat boolean wrapper around extractTerminalNotifications. */
export function containsTerminalNotification(chunk: string): boolean {
  return extractTerminalNotifications(chunk).length > 0;
}

/**
 * True when websocket data from the browser terminal represents a deliberate
 * user action (typing, enter, arrows, paste) rather than the terminal's own
 * automatic replies to queries (device attributes, cursor position reports,
 * mode reports, OSC color replies, DCS responses, focus events). Auto-replies
 * happen on attach and must NOT count as "the user touched this session".
 */
export function isLikelyUserInput(data: string): boolean {
  if (!data) {
    return false;
  }
  const residual = data
    .replace(/\x1b\[\?[0-9;]*c/g, '') // DA1 response
    .replace(/\x1b\[>[0-9;]*c/g, '') // DA2 response
    .replace(/\x1b\[\??[0-9;]*R/g, '') // CPR / DECXCPR
    .replace(/\x1b\[[0-9]*n/g, '') // DSR status report
    .replace(/\x1b\[\?[0-9;]*\$y/g, '') // DECRPM mode report
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC replies
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '') // DCS replies
    .replace(/\x1b\[[IO]/g, ''); // focus in/out events
  return residual.length > 0;
}

export interface TmuxWindowFlags {
  bellFlag: number;
  activity: number;
}

/**
 * Sessions that should raise attention this poll:
 * - bell flag rose 0 -> 1 since the previous poll, or
 * - bell flag is latched (tmux keeps it set while no client views the window)
 *   AND new pane output happened after the user's last touch — i.e. the agent
 *   ran another turn and rang again while latched.
 */
export function detectBellEdges(
  previous: Map<string, number>,
  current: Map<string, TmuxWindowFlags>,
  lastClearedAt: (session: string) => number = () => 0
): string[] {
  const raised: string[] = [];
  for (const [session, flags] of current) {
    if (flags.bellFlag !== 1) {
      continue;
    }
    const rose = (previous.get(session) ?? 0) === 0;
    const cleared = lastClearedAt(session);
    if (rose || (cleared > 0 && flags.activity > cleared)) {
      raised.push(session);
    }
  }
  return raised;
}

/** Parses `tmux list-windows` flag output into the session→flags map. */
export function parseBellFlagsOutput(stdout: string): Map<string, TmuxWindowFlags> {
  const flags = new Map<string, TmuxWindowFlags>();
  for (const line of stdout.split('\n')) {
    const [name, flag, activity] = line.split('\t');
    if (name) {
      flags.set(name, { bellFlag: flag === '1' ? 1 : 0, activity: Number(activity) || 0 });
    }
  }
  return flags;
}

const BELL_FLAG_ARGS = ['list-windows', '-a', '-F', '#{session_name}\t#{window_bell_flag}\t#{window_activity}'];

/** Polls tmux bell flags + activity for every session in one call (sync). */
export function pollTmuxBellFlags(): Map<string, TmuxWindowFlags> {
  const result = spawnSync('tmux', BELL_FLAG_ARGS, { encoding: 'utf8' });
  return result.status === 0 ? parseBellFlagsOutput(result.stdout) : new Map();
}

/** Async poll — runs off the event loop so the 2s poller never blocks streams. */
export async function pollTmuxBellFlagsAsync(): Promise<Map<string, TmuxWindowFlags>> {
  try {
    const { stdout } = await execFileAsync('tmux', BELL_FLAG_ARGS, { encoding: 'utf8' });
    return parseBellFlagsOutput(stdout);
  } catch {
    return new Map();
  }
}

export const attentionTracker = new AttentionTracker();

let raiseListener: ((tmuxSession: string) => void) | null = null;

/** Invoked on every newly raised attention (a turn completed / approval rang). */
export function setRaiseListener(listener: ((tmuxSession: string) => void) | null): void {
  raiseListener = listener;
}

export function notifyRaise(tmuxSession: string): void {
  raiseListener?.(tmuxSession);
}

/**
 * Kind-aware agent signal fanout. Unlike the raise listener (which only fires
 * on newly raised attention), signal listeners see EVERY turn signal from both
 * capture paths — the tmux bell poller and the typed /api/agent-event hook —
 * including repeats while attention is already raised. The channels engine
 * uses this as its "input released" trigger.
 */
export type AgentSignalListener = (tmuxSession: string, kind: AgentEventKind) => void;

const signalListeners = new Set<AgentSignalListener>();

export function addAgentSignalListener(listener: AgentSignalListener): () => void {
  signalListeners.add(listener);
  return () => signalListeners.delete(listener);
}

export function notifyAgentSignal(tmuxSession: string, kind: AgentEventKind): void {
  for (const listener of signalListeners) {
    try {
      listener(tmuxSession, kind);
    } catch {
      // a faulty listener must not break attention tracking
    }
  }
}

let pollTimer: NodeJS.Timeout | undefined;
let previousFlags = new Map<string, number>();
let pollInFlight = false;

/** Starts the background bell-flag poller (idempotent). */
export function startAttentionPolling(intervalMs = 2000): void {
  if (pollTimer) {
    return;
  }
  const tick = async (): Promise<void> => {
    if (pollInFlight) {
      return; // a slow tmux must not stack overlapping polls
    }
    pollInFlight = true;
    try {
      const flags = await pollTmuxBellFlagsAsync();
      for (const session of detectBellEdges(previousFlags, flags, (name) => attentionTracker.lastClearedAt(name))) {
        if (attentionTracker.raise(session)) {
          attentionTracker.pushEvent(session, 'bell');
        }
        notifyRaise(session);
        notifyAgentSignal(session, 'bell');
      }
      previousFlags = new Map([...flags].map(([name, value]) => [name, value.bellFlag]));
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
  previousFlags = new Map();
}
