import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn as spawnPty } from './ptyBackend.js';
import { WebSocketServer } from 'ws';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../core/terminalSizing.js';
import { parseBrokerClientFrame, type TerminalBrokerClientFrame, type TerminalBrokerServerFrame } from '../core/terminalBrokerProtocol.js';
import { listTmuxSessionsCached, loadDeskCached } from '../core/runner.js';
import type { SessionSpec } from '../core/types.js';
import {
  captureTmuxPane,
  createTerminalAttachCommand,
  getLastGoodTerminalSize,
  resizeTmuxWindow,
  stripTerminalMouseModeControls
} from './terminalBridge.js';
import { ensureTmuxGlobalOptions, markTmuxGlobalOptionsStale } from './tmuxOptions.js';
import { TerminalOutputRing } from './terminalOutputRing.js';
import { attentionTracker, extractTerminalNotifications, notifyAgentSignal, notifyRaise } from './attention.js';
import { TerminalSequenceTokenizer } from '../shared/terminalSequenceTokenizer.js';

export interface BrokerPty {
  onData(handler: (chunk: string) => void): void;
  onExit(handler: (exit: { exitCode: number | null }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface BrokerTransport {
  readonly OPEN: number;
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
}

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface TerminalBrokerMetrics {
  activeClients: number;
  activePtys: number;
  warmIdlePtys: number;
  visibleSubscriptions: number;
  hiddenSubscriptions: number;
  droppedOutputFrames: number;
}

interface TerminalBrokerOptions {
  sessions: SessionSpec[] | (() => SessionSpec[]);
  runningSessions: () => Set<string>;
  spawnPty: (session: SessionSpec) => BrokerPty;
  captureSnapshot?: (session: SessionSpec, ringSnapshot: string) => string;
  resizeTerminal?: (session: SessionSpec, cols: number, rows: number) => { ok: true; skipped?: boolean } | { ok: false; error: string };
  ringBytes?: number;
  backpressureBytes?: number;
  idleTtlMs?: number;
  maxWarmPtys?: number;
  now?: () => number;
}

interface ClientState {
  transport: BrokerTransport;
  subscriptions: Map<string, ClientSubscription>;
}

interface ClientSubscription {
  tmuxSession: string;
  surfaceId: string;
  visible: boolean;
}

interface BrokerTerminal {
  session: SessionSpec;
  pty: BrokerPty;
  ring: TerminalOutputRing;
  clients: Map<BrokerTransport, Map<string, { visible: boolean }>>;
  attentionTokenizer: TerminalSequenceTokenizer;
  mouseModeTokenizer: TerminalSequenceTokenizer;
  idleSince?: number;
}

const DEFAULT_RING_BYTES = 1024 * 1024;
const DEFAULT_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_WARM_PTYS = 40;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

export class TerminalBroker {
  private readonly loadSessions: () => SessionSpec[];
  private readonly runningSessions: () => Set<string>;
  private readonly spawnPty: (session: SessionSpec) => BrokerPty;
  private readonly captureSnapshot: (session: SessionSpec, ringSnapshot: string) => string;
  private readonly resizeTerminal: (session: SessionSpec, cols: number, rows: number) => { ok: true; skipped?: boolean } | { ok: false; error: string };
  private readonly ringBytes: number;
  private readonly backpressureBytes: number;
  private readonly idleTtlMs: number;
  private readonly maxWarmPtys: number;
  private readonly now: () => number;
  private readonly clients = new Map<BrokerTransport, ClientState>();
  private readonly terminals = new Map<string, BrokerTerminal>();
  private droppedOutputFrames = 0;

  constructor(options: TerminalBrokerOptions) {
    this.loadSessions = Array.isArray(options.sessions) ? () => options.sessions as SessionSpec[] : options.sessions;
    this.runningSessions = options.runningSessions;
    this.spawnPty = options.spawnPty;
    this.captureSnapshot = options.captureSnapshot ?? defaultCaptureSnapshot;
    this.resizeTerminal = options.resizeTerminal ?? (() => ({ ok: true }));
    this.ringBytes = options.ringBytes ?? DEFAULT_RING_BYTES;
    this.backpressureBytes = options.backpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxWarmPtys = options.maxWarmPtys ?? DEFAULT_MAX_WARM_PTYS;
    this.now = options.now ?? Date.now;
  }

  addClient(transport: BrokerTransport): void {
    this.clients.set(transport, { transport, subscriptions: new Map() });
    this.sendFrame(transport, { type: 'ready', version: 1 });
  }

  heartbeat(): void {
    const frame: TerminalBrokerServerFrame = { type: 'heartbeat', at: Date.now() };
    for (const transport of this.clients.keys()) {
      this.sendFrame(transport, frame);
    }
  }

  removeClient(transport: BrokerTransport): void {
    const client = this.clients.get(transport);
    if (!client) {
      return;
    }
    for (const subscription of [...client.subscriptions.values()]) {
      this.unsubscribeResolved(client, subscription.tmuxSession, subscription.surfaceId);
    }
    this.clients.delete(transport);
  }

  handleFrame(transport: BrokerTransport, value: unknown): void {
    const client = this.clients.get(transport);
    if (!client) {
      return;
    }
    let frame: TerminalBrokerClientFrame;
    try {
      frame = parseBrokerClientFrame(value);
    } catch (error) {
      this.sendFrame(transport, { type: 'error', message: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      switch (frame.type) {
        case 'subscribe':
          this.subscribe(client, frame.session, frame.surfaceId, frame.visible);
          return;
        case 'visibility':
          this.setVisibility(client, frame.session, frame.surfaceId, frame.visible);
          return;
        case 'unsubscribe':
          this.unsubscribe(client, frame.session, frame.surfaceId);
          return;
        case 'input':
          this.input(client, frame.session, frame.surfaceId, frame.data);
          return;
        case 'resize':
          this.resize(client, frame.session, frame.surfaceId, frame.cols, frame.rows);
          return;
      }
    } catch (error) {
      this.sendFrame(transport, {
        type: 'error',
        session: frame.session,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  sweepIdle(): void {
    const now = this.now();
    for (const [tmuxSession, terminal] of [...this.terminals]) {
      if (terminal.clients.size === 0 && terminal.idleSince !== undefined && now - terminal.idleSince >= this.idleTtlMs) {
        this.killTerminal(tmuxSession);
      }
    }
  }

  metrics(): TerminalBrokerMetrics {
    let visibleSubscriptions = 0;
    let hiddenSubscriptions = 0;
    for (const terminal of this.terminals.values()) {
      for (const surfaces of terminal.clients.values()) {
        for (const subscription of surfaces.values()) {
          if (subscription.visible) {
            visibleSubscriptions++;
          } else {
            hiddenSubscriptions++;
          }
        }
      }
    }
    return {
      activeClients: this.clients.size,
      activePtys: this.terminals.size,
      warmIdlePtys: [...this.terminals.values()].filter((terminal) => terminal.clients.size === 0).length,
      visibleSubscriptions,
      hiddenSubscriptions,
      droppedOutputFrames: this.droppedOutputFrames
    };
  }

  dispose(): void {
    for (const tmuxSession of [...this.terminals.keys()]) {
      this.killTerminal(tmuxSession);
    }
    this.clients.clear();
  }

  private subscribe(client: ClientState, query: string, surfaceId: string, visible: boolean): void {
    const terminal = this.acquireTerminal(query);
    terminal.idleSince = undefined;
    const surfaces = terminal.clients.get(client.transport) ?? new Map<string, { visible: boolean }>();
    surfaces.set(surfaceId, { visible });
    terminal.clients.set(client.transport, surfaces);
    client.subscriptions.set(subscriptionKey(terminal.session.tmuxSession, surfaceId), {
      tmuxSession: terminal.session.tmuxSession,
      surfaceId,
      visible
    });
    if (visible) {
      this.sendSnapshot(client.transport, terminal, surfaceId);
    }
  }

  private setVisibility(client: ClientState, query: string, surfaceId: string, visible: boolean): void {
    const tmuxSession = this.resolveSession(query).tmuxSession;
    const terminal = this.terminals.get(tmuxSession);
    const key = subscriptionKey(tmuxSession, surfaceId);
    const subscription = client.subscriptions.get(key);
    const surfaces = terminal?.clients.get(client.transport);
    const surface = surfaces?.get(surfaceId);
    if (!terminal || !subscription || !surface) {
      throw new Error(`not subscribed to ${tmuxSession}`);
    }
    subscription.visible = visible;
    surface.visible = visible;
    if (visible) {
      this.sendSnapshot(client.transport, terminal, surfaceId);
    }
  }

  private unsubscribe(client: ClientState, query: string, surfaceId: string): void {
    const tmuxSession = this.resolveSession(query).tmuxSession;
    this.unsubscribeResolved(client, tmuxSession, surfaceId);
  }

  private unsubscribeResolved(client: ClientState, tmuxSession: string, surfaceId: string): void {
    const terminal = this.terminals.get(tmuxSession);
    client.subscriptions.delete(subscriptionKey(tmuxSession, surfaceId));
    if (!terminal) {
      return;
    }
    const surfaces = terminal.clients.get(client.transport);
    surfaces?.delete(surfaceId);
    if (surfaces && surfaces.size === 0) {
      terminal.clients.delete(client.transport);
    }
    if (terminal.clients.size === 0) {
      terminal.idleSince = this.now();
      this.enforceWarmLimit();
    }
  }

  private input(client: ClientState, query: string, surfaceId: string, data: string): void {
    const tmuxSession = this.resolveSession(query).tmuxSession;
    const subscription = client.subscriptions.get(subscriptionKey(tmuxSession, surfaceId));
    if (!subscription?.visible) {
      throw new Error(`not subscribed to ${tmuxSession}`);
    }
    const terminal = this.terminals.get(tmuxSession);
    if (!terminal) {
      throw new Error(`terminal ${tmuxSession} is not attached`);
    }
    terminal.pty.write(data);
  }

  private resize(client: ClientState, query: string, surfaceId: string, cols: number, rows: number): void {
    const tmuxSession = this.resolveSession(query).tmuxSession;
    const subscription = client.subscriptions.get(subscriptionKey(tmuxSession, surfaceId));
    if (!subscription?.visible) {
      throw new Error(`not subscribed to ${tmuxSession}`);
    }
    const terminal = this.terminals.get(tmuxSession);
    if (!terminal) {
      throw new Error(`terminal ${tmuxSession} is not attached`);
    }
    const result = this.resizeTerminal(terminal.session, cols, rows);
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (result.skipped) {
      return;
    }
    terminal.pty.resize(cols, rows);
  }

  private acquireTerminal(query: string): BrokerTerminal {
    const session = this.resolveSession(query);
    const existing = this.terminals.get(session.tmuxSession);
    if (existing) {
      return existing;
    }
    if (!this.runningSessions().has(session.tmuxSession)) {
      throw new Error(`tmux session ${session.tmuxSession} is not running`);
    }
    const pty = this.spawnPty(session);
    const terminal: BrokerTerminal = {
      session,
      pty,
      ring: new TerminalOutputRing(this.ringBytes),
      clients: new Map(),
      attentionTokenizer: new TerminalSequenceTokenizer(),
      mouseModeTokenizer: new TerminalSequenceTokenizer()
    };
    this.terminals.set(session.tmuxSession, terminal);
    pty.onData((chunk) => this.handlePtyData(terminal, chunk));
    pty.onExit(({ exitCode }) => this.handlePtyExit(session.tmuxSession, terminal, exitCode));
    return terminal;
  }

  private handlePtyData(terminal: BrokerTerminal, chunk: string): void {
    const notifications = extractTerminalNotifications(chunk, terminal.attentionTokenizer);
    if (notifications.length > 0) {
      attentionTracker.raise(terminal.session.tmuxSession);
      notifyRaise(terminal.session.tmuxSession);
      for (const notification of notifications) {
        attentionTracker.pushEvent(terminal.session.tmuxSession, notification.kind, notification.message);
        notifyAgentSignal(terminal.session.tmuxSession, notification.kind);
      }
    }
    const payload = stripTerminalMouseModeControls(chunk, terminal.mouseModeTokenizer);
    terminal.ring.append(payload);
    for (const [transport, surfaces] of terminal.clients) {
      if (![...surfaces.values()].some((subscription) => subscription.visible)) {
        continue;
      }
      this.sendOutput(transport, terminal.session.tmuxSession, payload);
    }
  }

  private handlePtyExit(tmuxSession: string, terminal: BrokerTerminal, exitCode: number | null): void {
    if (this.terminals.get(tmuxSession) !== terminal) {
      return;
    }
    this.terminals.delete(tmuxSession);
    if (this.terminals.size === 0) {
      markTmuxGlobalOptionsStale();
    }
    for (const transport of terminal.clients.keys()) {
      this.sendFrame(transport, { type: 'exit', session: tmuxSession, exitCode });
    }
  }

  private sendSnapshot(transport: BrokerTransport, terminal: BrokerTerminal, surfaceId: string): void {
    const data = this.captureSnapshot(terminal.session, terminal.ring.snapshot());
    if (data === '') {
      return;
    }
    this.sendFrame(transport, { type: 'snapshot', session: terminal.session.tmuxSession, surfaceId, data });
  }

  private sendOutput(transport: BrokerTransport, session: string, data: string): void {
    if (transport.bufferedAmount > this.backpressureBytes) {
      this.droppedOutputFrames++;
      return;
    }
    this.sendFrame(transport, { type: 'output', session, data });
  }

  private sendFrame(transport: BrokerTransport, frame: TerminalBrokerServerFrame): void {
    if (transport.readyState !== transport.OPEN) {
      return;
    }
    transport.send(JSON.stringify(frame));
  }

  private enforceWarmLimit(): void {
    const idle = [...this.terminals.entries()]
      .filter(([, terminal]) => terminal.clients.size === 0)
      .sort((a, b) => (a[1].idleSince ?? 0) - (b[1].idleSince ?? 0));
    while (idle.length > this.maxWarmPtys) {
      const next = idle.shift();
      if (next) {
        this.killTerminal(next[0]);
      }
    }
  }

  private killTerminal(tmuxSession: string): void {
    const terminal = this.terminals.get(tmuxSession);
    if (!terminal) {
      return;
    }
    this.terminals.delete(tmuxSession);
    if (this.terminals.size === 0) {
      markTmuxGlobalOptionsStale();
    }
    terminal.pty.kill();
  }

  private resolveSession(query: string): SessionSpec {
    const session = this.loadSessions().find((candidate) => candidate.tmuxSession === query || candidate.name === query);
    if (!session) {
      throw new Error(`unknown session ${query}`);
    }
    return session;
  }
}

export interface TerminalBrokerInstallOptions {
  maxPayloadBytes?: number;
}

export function installTerminalBroker(
  httpServer: UpgradeServer,
  broker: TerminalBroker,
  options: TerminalBrokerInstallOptions = {}
): () => void {
  const maxPayload = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 'terminal broker maxPayloadBytes');
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const sweepTimer = setInterval(() => broker.sweepIdle(), 30_000);
  const heartbeatTimer = setInterval(() => broker.heartbeat(), HEARTBEAT_MS);
  sweepTimer.unref?.();
  heartbeatTimer.unref?.();
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (socket.destroyed) {
      return; // already rejected by the central upgrade guard
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname !== '/ws/terminal-broker') {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
  httpServer.on('upgrade', onUpgrade);
  wss.on('connection', (ws) => {
    broker.addClient(ws);
    ws.on('message', (message) => {
      try {
        broker.handleFrame(ws, JSON.parse(String(message)));
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : String(error)
          } satisfies TerminalBrokerServerFrame)
        );
      }
    });
    ws.on('close', () => broker.removeClient(ws));
    ws.on('error', () => broker.removeClient(ws));
  });
  return () => {
    clearInterval(sweepTimer);
    clearInterval(heartbeatTimer);
    broker.dispose();
    wss.close();
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

export function createDefaultTerminalBroker(): TerminalBroker {
  return new TerminalBroker({
    sessions: () => loadDeskCached().sessions,
    runningSessions: () => listTmuxSessionsCached(),
    spawnPty: (session) => {
      ensureTmuxGlobalOptions();
      const command = createTerminalAttachCommand(session);
      const size = getLastGoodTerminalSize(session.tmuxSession) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS
      };
      return spawnPty(command.file, command.args, {
        cols: size.cols,
        rows: size.rows,
        cwd: session.cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        name: 'xterm-256color'
      });
    },
    captureSnapshot: (session, ringSnapshot) =>
      createTerminalBrokerSnapshot(session, ringSnapshot, (target) => {
        const rows = getLastGoodTerminalSize(target.tmuxSession)?.rows ?? DEFAULT_TERMINAL_ROWS;
        return captureTmuxPane(target.tmuxSession, rows, 0);
      }),
    resizeTerminal: (session, cols, rows) => {
      const result = resizeTmuxWindow(session.tmuxSession, cols, rows);
      return result.ok ? ('skipped' in result ? { ok: true, skipped: true } : { ok: true }) : result;
    }
  });
}

function subscriptionKey(tmuxSession: string, surfaceId: string): string {
  return `${tmuxSession}\x00${surfaceId}`;
}

function defaultCaptureSnapshot(_session: SessionSpec, ringSnapshot: string): string {
  return `\x1b[2J\x1b[3J\x1b[H${ringSnapshot}`;
}

export function createTerminalBrokerSnapshot(
  session: SessionSpec,
  ringSnapshot: string,
  capture: (session: SessionSpec) => { ok: true; lines: string[] } | { ok: false; error: string }
): string {
  const clear = '\x1b[2J\x1b[3J\x1b[H';
  const captured = capture(session);
  if (captured.ok) {
    return `${clear}${captured.lines.join('\r\n')}`;
  }
  return `${clear}${ringSnapshot}`;
}
