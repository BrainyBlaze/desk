import { spawnSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn as spawnPty, type IPty } from './ptyBackend.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { findSession, listTmuxSessionsCached, loadDeskCached } from '../core/runner.js';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from '../core/terminalSizing.js';
import type { SessionSpec } from '../core/types.js';
import { attentionTracker, extractTerminalNotifications, isLikelyUserInput, notifyRaise } from './attention.js';

export interface TerminalAttachCommand {
  file: string;
  args: string[];
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

type TmuxResizeExecutor = (
  file: string,
  args: string[],
  options: { encoding: 'utf8' }
) => { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer };

export type TmuxResizeResult =
  | { ok: true; cols: number; rows: number }
  | {
      ok: true;
      skipped: true;
      reason: 'below-minimum';
      minCols: number;
      minRows: number;
      lastGood?: TerminalSize;
    }
  | { ok: false; error: string };

export interface TinyTmuxWindowRepairResult {
  checked: number;
  repaired: Array<{ tmuxSession: string; from: TerminalSize; to: TerminalSize }>;
  failed: Array<{ tmuxSession: string; error: string }>;
}

/**
 * One PTY per tmux session, fanned out to every websocket viewing it. Two
 * cells (or a desktop tab plus a phone) showing the same session used to
 * spawn two `tmux attach` processes; now they share one. Input from any
 * socket fans in; output broadcasts to all. The PTY dies with its last
 * subscriber.
 */
interface SharedTerminal {
  pty: IPty;
  sockets: Set<WebSocket>;
}

const sharedTerminals = new Map<string, SharedTerminal>();
const lastGoodTerminalSizes = new Map<string, TerminalSize>();
/**
 * Per-socket send buffer cap. A throttled or backgrounded tab (or a slow link)
 * during a firehose would otherwise let ws queue output unbounded server-side. Past
 * this many buffered bytes we drop the chunk for that socket — terminal output is
 * self-correcting, so the next live frame (and the stabilize repaint) resyncs its
 * screen once it catches up. Other sockets on the same shared PTY are unaffected.
 */
const SOCKET_BACKPRESSURE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The two `tmux set-option -g` calls (mouse off + allow-passthrough for OSC 9) are
 * global and idempotent, but two spawnSync per attach showed up in the round-2
 * profile. They only need to be (re)applied once the tmux server is up. We run
 * them when the shared-terminal map transitions from empty to non-empty: that
 * covers the first attach and re-covers a tmux server restart (which kills every
 * attach, draining the map), without paying on every cell.
 */
let globalTmuxOptionsApplied = false;
function ensureGlobalTmuxOptions(): void {
  if (globalTmuxOptionsApplied && sharedTerminals.size > 0) {
    return;
  }
  spawnSync('tmux', ['set-option', '-g', 'mouse', 'off'], { encoding: 'utf8' });
  spawnSync('tmux', ['set-option', '-g', 'allow-passthrough', 'on'], { encoding: 'utf8' });
  globalTmuxOptionsApplied = true;
}
const copyModeSessions = new Set<string>();
/** last repaint per session — several clients stabilizing at once repaint tmux once */
const lastRepaintAt = new Map<string, number>();
const REPAINT_DEDUPE_MS = 500;
const mousePrivateModes = new Set(['9', '1000', '1002', '1003', '1004', '1005', '1006', '1015']);
const cursorBlinkPrivateMode = '12';
const cursorVisiblePrivateMode = '25';
const steadyCursorStyles = new Map([
  ['2', '1'],
  ['4', '3'],
  ['6', '5']
]);

export function createTerminalAttachCommand(session: SessionSpec): TerminalAttachCommand {
  return {
    file: 'tmux',
    args: ['attach-session', '-f', 'ignore-size', '-t', session.tmuxSession]
  };
}

export function resizeAttachedTerminals(tmuxSession: string, cols: number, rows: number): void {
  const shared = sharedTerminals.get(tmuxSession);
  if (!shared) {
    return;
  }
  shared.pty.resize(cols, rows);
}

export function getLastGoodTerminalSize(tmuxSession: string): TerminalSize | undefined {
  return lastGoodTerminalSizes.get(tmuxSession);
}

export function resetTerminalResizeStateForTests(): void {
  lastGoodTerminalSizes.clear();
}

export function resizeTmuxWindow(
  tmuxSession: string,
  cols: number,
  rows: number,
  exec: TmuxResizeExecutor = spawnSync
): TmuxResizeResult {
  const lastGood = lastGoodTerminalSizes.get(tmuxSession);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) {
    return {
      ok: true,
      skipped: true,
      reason: 'below-minimum',
      minCols: MIN_TERMINAL_COLS,
      minRows: MIN_TERMINAL_ROWS,
      ...(lastGood ? { lastGood } : {})
    };
  }
  const result = exec('tmux', ['resize-window', '-t', tmuxSession, '-x', String(cols), '-y', String(rows)], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr ?? '').trim() || `tmux resize failed for ${tmuxSession}` };
  }
  const size = { cols, rows };
  lastGoodTerminalSizes.set(tmuxSession, size);
  return { ok: true, ...size };
}

export function repairTinyTmuxWindows(
  sessions: Array<Pick<SessionSpec, 'tmuxSession'>>,
  exec: TmuxResizeExecutor = spawnSync
): TinyTmuxWindowRepairResult {
  const result: TinyTmuxWindowRepairResult = { checked: 0, repaired: [], failed: [] };
  for (const session of sessions) {
    result.checked++;
    const size = exec('tmux', ['display-message', '-p', '-t', session.tmuxSession, '#{window_width}\t#{window_height}'], {
      encoding: 'utf8'
    });
    if (size.status !== 0) {
      result.failed.push({
        tmuxSession: session.tmuxSession,
        error: String(size.stderr ?? '').trim() || `tmux display-message failed for ${session.tmuxSession}`
      });
      continue;
    }
    const [cols, rows] = String(size.stdout ?? '')
      .trim()
      .split('\t')
      .map(Number);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      result.failed.push({ tmuxSession: session.tmuxSession, error: `invalid tmux size for ${session.tmuxSession}` });
      continue;
    }
    if (cols >= MIN_TERMINAL_COLS && rows >= MIN_TERMINAL_ROWS) {
      continue;
    }
    const lastGood = lastGoodTerminalSizes.get(session.tmuxSession);
    const target = lastGood ?? { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS };
    const repair = resizeTmuxWindow(session.tmuxSession, target.cols, target.rows, exec);
    if (!repair.ok) {
      result.failed.push({ tmuxSession: session.tmuxSession, error: repair.error });
      continue;
    }
    if ('skipped' in repair) {
      result.failed.push({ tmuxSession: session.tmuxSession, error: `repair target below minimum for ${session.tmuxSession}` });
      continue;
    }
    result.repaired.push({
      tmuxSession: session.tmuxSession,
      from: { cols, rows },
      to: { cols: repair.cols, rows: repair.rows }
    });
  }
  return result;
}

/**
 * Forces tmux to repaint a window at its true size by wiggling the height
 * one row down and back — the server-side, deduped version of the historical
 * client-side "wiggle the sidebar" repair. The xterm never resizes, so
 * nothing flashes client-side.
 */
export function repaintTmuxWindow(
  tmuxSession: string,
  now = Date.now()
): { ok: boolean; skipped?: boolean; error?: string } {
  const last = lastRepaintAt.get(tmuxSession) ?? 0;
  if (now - last < REPAINT_DEDUPE_MS) {
    return { ok: true, skipped: true };
  }
  lastRepaintAt.set(tmuxSession, now);
  const size = spawnSync('tmux', ['display-message', '-p', '-t', tmuxSession, '#{window_width}\t#{window_height}'], {
    encoding: 'utf8'
  });
  if (size.status !== 0) {
    return { ok: false, error: size.stderr.trim() || `tmux display-message failed for ${tmuxSession}` };
  }
  const [width, height] = size.stdout.trim().split('\t').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height < 3) {
    return { ok: true, skipped: true };
  }
  const down = spawnSync(
    'tmux',
    ['resize-window', '-t', tmuxSession, '-x', String(width), '-y', String(height - 1)],
    { encoding: 'utf8' }
  );
  if (down.status !== 0) {
    return { ok: false, error: down.stderr.trim() || `tmux resize-window failed for ${tmuxSession}` };
  }
  const up = spawnSync(
    'tmux',
    ['resize-window', '-t', tmuxSession, '-x', String(width), '-y', String(height)],
    { encoding: 'utf8' }
  );
  if (up.status !== 0) {
    return { ok: false, error: up.stderr.trim() || `tmux resize-window failed for ${tmuxSession}` };
  }
  return { ok: true };
}

export function captureTmuxPane(
  tmuxSession: string,
  rows: number,
  offset: number
): { ok: true; lines: string[] } | { ok: false; error: string } {
  const boundedRows = Math.min(2000, Math.max(1, rows));
  const boundedOffset = Math.min(5000, Math.max(0, offset));
  // No -E bound: include the visible screen so client scrollback is continuous with the live view.
  // -e keeps escape sequences (colors/attributes); no -J so lines stay wrapped at the
  // pane's exact width — the client replays them into an xterm viewer of the same cols.
  const result = spawnSync('tmux', ['capture-pane', '-p', '-e', '-t', tmuxSession, '-S', '-5000'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() || `tmux capture-pane failed for ${tmuxSession}` };
  }
  const lines = stripTerminalMouseModeControls(result.stdout).replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return { ok: true, lines: sliceCapturedPaneLines(lines, boundedRows, boundedOffset) };
}

export function sliceCapturedPaneLines(lines: string[], rows: number, offset: number): string[] {
  const boundedRows = Math.min(2000, Math.max(1, rows));
  const boundedOffset = Math.max(0, offset);
  const end = Math.max(boundedRows, lines.length - boundedOffset);
  return lines.slice(Math.max(0, end - boundedRows), end);
}

export function scrollTmuxPane(
  tmuxSession: string,
  lines: number,
  options: { exitCopyMode?: boolean } = {}
): { ok: boolean; error?: string } {
  const amount = Math.min(200, Math.max(1, Math.abs(lines)));
  if (lines < 0) {
    const copyMode = spawnSync('tmux', ['copy-mode', '-t', tmuxSession, '-e'], { encoding: 'utf8' });
    if (copyMode.status !== 0) {
      return { ok: false, error: copyMode.stderr.trim() || `tmux copy-mode failed for ${tmuxSession}` };
    }
    const result = sendCopyModeCommand(tmuxSession, 'scroll-up', amount);
    if (result.ok) {
      copyModeSessions.add(tmuxSession);
    }
    return result;
  }
  if (lines > 0) {
    const result = sendCopyModeCommand(tmuxSession, 'scroll-down', amount, true);
    if (options.exitCopyMode) {
      return exitTmuxCopyMode(tmuxSession);
    }
    return result;
  }
  if (options.exitCopyMode) {
    return exitTmuxCopyMode(tmuxSession);
  }
  return { ok: true };
}

export function installTerminalBridge(httpServer: UpgradeServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    if (socket.destroyed) {
      return; // already rejected by the central upgrade guard
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname !== '/ws/terminal') {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url ?? '/', 'http://desk.local');
    const query = url.searchParams.get('session');

    if (!query) {
      ws.close(1008, 'session query parameter is required');
      return;
    }

    let shared: SharedTerminal;
    let tmuxSession: string;
    try {
      const session = findSession(loadDeskCached().sessions, query);
      // Attach-only, deliberately: starting here would silently resurrect a
      // session that died (or was killed) while its cell was attached — the
      // client's reconnect backoff would revive it within a second and the
      // UI could never show the death. The pulse flips the cell to MISSING
      // within one tick; booting is an explicit action (boot button, Repair,
      // Up), never a side effect of attaching. The cached list is fine here:
      // it is 1s-fresh and boot/kill invalidate it, and a stale "running" only
      // costs one failed attach the client retries.
      if (!listTmuxSessionsCached().has(session.tmuxSession)) {
        throw new Error(`tmux session ${session.tmuxSession} is not running`);
      }
      tmuxSession = session.tmuxSession;
      shared = acquireSharedTerminal(session);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
      ws.close(1011);
      return;
    }

    subscribeSocket(ws, tmuxSession, shared);
  });
}

function acquireSharedTerminal(session: SessionSpec): SharedTerminal {
  const existing = sharedTerminals.get(session.tmuxSession);
  if (existing) {
    return existing;
  }
  const command = createTerminalAttachCommand(session);
  ensureGlobalTmuxOptions();
  const pty = spawnPty(command.file, command.args, {
    cols: 120,
    rows: 40,
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    },
    name: 'xterm-256color'
  });
  const shared: SharedTerminal = { pty, sockets: new Set() };
  sharedTerminals.set(session.tmuxSession, shared);
  const tmuxSession = session.tmuxSession;

  pty.onData((chunk) => {
    const notifications = extractTerminalNotifications(chunk);
    if (notifications.length > 0) {
      // Agent TUI rang its turn-complete/approval notification.
      attentionTracker.raise(tmuxSession);
      notifyRaise(tmuxSession);
      for (const notification of notifications) {
        attentionTracker.pushEvent(tmuxSession, notification.kind, notification.message);
      }
    }
    const payload = stripTerminalMouseModeControls(chunk);
    for (const socket of shared.sockets) {
      if (socket.readyState !== socket.OPEN) {
        continue;
      }
      // Drop for a socket that's fallen far behind rather than buffer unbounded.
      if (socket.bufferedAmount > SOCKET_BACKPRESSURE_MAX_BYTES) {
        continue;
      }
      socket.send(payload);
    }
  });
  pty.onExit(({ exitCode }) => {
    if (sharedTerminals.get(tmuxSession) === shared) {
      sharedTerminals.delete(tmuxSession);
    }
    for (const socket of shared.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(`\r\n[desk terminal exited: ${exitCode}]\r\n`);
        socket.close();
      }
    }
    shared.sockets.clear();
  });
  return shared;
}

function subscribeSocket(ws: WebSocket, tmuxSession: string, shared: SharedTerminal): void {
  shared.sockets.add(ws);
  // A subscriber joining an already-attached PTY gets the current screen via
  // the client's own stabilize() repaint shortly after connect — the redraw
  // broadcasts to everyone, which is visually idempotent for existing viewers.
  ws.on('message', (message) => {
    if (copyModeSessions.has(tmuxSession)) {
      exitTmuxCopyMode(tmuxSession);
    }
    const data = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
    // Deliberate user input touches the session; terminal auto-replies do not.
    if (isLikelyUserInput(data)) {
      attentionTracker.clear(tmuxSession);
    }
    shared.pty.write(data);
  });
  ws.on('close', () => {
    shared.sockets.delete(ws);
    if (shared.sockets.size === 0 && sharedTerminals.get(tmuxSession) === shared) {
      sharedTerminals.delete(tmuxSession);
      shared.pty.kill();
    }
  });
}

export function stripTerminalMouseModeControls(data: string): string {
  // Hot path: runs on every broadcast chunk. The mouse-mode (`\x1b[?…h/l`) and
  // cursor-style (`… q`) escapes appear on TUI startup/attach, essentially never in
  // streaming output, so an indexOf pre-check returns the chunk untouched (no regex,
  // no allocation) in the common case. When a marker is present the regex runs
  // exactly as before.
  if (data.indexOf('\x1b[?') === -1 && data.indexOf(' q') === -1) {
    return data;
  }
  return data
    .replace(/\x1b\[\?([0-9;]+)([hl])/g, (sequence, params: string, mode: string) => {
      const values = params.split(';');
      const remaining = values.filter(
        (param) =>
          !mousePrivateModes.has(param) &&
          param !== cursorBlinkPrivateMode &&
          !(mode === 'l' && param === cursorVisiblePrivateMode)
      );
      if (remaining.length === 0) {
        return '';
      }
      if (remaining.length === values.length) {
        return sequence as string;
      }
      return `\x1b[?${remaining.join(';')}${mode}`;
    })
    .replace(/\x1b\[([0-9]*) q/g, (sequence, style: string) => {
      const replacement = steadyCursorStyles.get(style);
      return replacement ? `\x1b[${replacement} q` : (sequence as string);
    });
}

export function exitTmuxCopyMode(tmuxSession: string): { ok: boolean } {
  copyModeSessions.delete(tmuxSession);
  spawnSync('tmux', ['send-keys', '-t', tmuxSession, '-X', 'cancel'], { encoding: 'utf8' });
  return { ok: true };
}

function sendCopyModeCommand(
  tmuxSession: string,
  command: 'scroll-up' | 'scroll-down',
  amount: number,
  ignoreFailure = false
): { ok: boolean; error?: string } {
  const result = spawnSync('tmux', ['send-keys', '-t', tmuxSession, '-X', '-N', String(amount), command], {
    encoding: 'utf8'
  });
  if (result.status !== 0 && !ignoreFailure) {
    return { ok: false, error: result.stderr.trim() || `tmux ${command} failed for ${tmuxSession}` };
  }
  return { ok: true };
}

interface UpgradeServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  ): unknown;
}
