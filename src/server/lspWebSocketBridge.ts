import type { IncomingMessage, Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export interface LspVirtualSessionFactoryOptions {
  workspaceRoot: string;
  uri?: string;
  languageId?: string;
  publishStatus?: (status: LspLifecycleStatusEvent) => void;
}

export type LspLifecycleStatusState = 'warming' | 'ready' | 'degraded' | 'restarting' | 'stopped';

export interface LspRestartStatus {
  state: 'restarting' | 'stopped';
  attempt: number;
  maxAttempts: number;
}

export interface LspLifecycleStatusEvent {
  state: LspLifecycleStatusState;
  serverConfigId: string;
  workspaceRoot: string;
  languageId?: string;
  warm?: boolean;
  reason?: string;
  restart?: LspRestartStatus;
}

export interface LspVirtualSessionExit {
  code: number | null;
  signal: string | null;
  restart?: LspRestartStatus;
}

export interface LspVirtualSession {
  capabilities: Record<string, unknown>;
  sendClientMessage(message: unknown): void;
  onServerMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exit: LspVirtualSessionExit) => void): void;
  dispose(): void;
}

export interface LspWebSocketBridgeOptions {
  createSession(options: LspVirtualSessionFactoryOptions): LspVirtualSession | Promise<LspVirtualSession>;
}

interface ActiveConnection {
  ws: WebSocket;
  session: LspVirtualSession;
}

interface LspReadyTelemetry {
  ready: {
    createSessionMs: number;
    acceptToReadyMs: number;
  };
}

const WORKSPACE_ROOT_CLOSE_CODE = 1008;
const SESSION_START_CLOSE_CODE = 1011;
const BRIDGE_DISPOSE_CLOSE_CODE = 1001;

export function installLspWebSocketBridge(httpServer: Server, options: LspWebSocketBridgeOptions): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const activeConnections = new Map<WebSocket, ActiveConnection>();
  const pendingSockets = new Set<WebSocket>();
  let disposed = false;

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (disposed || socket.destroyed) {
      return; // disposed, or already rejected by the central upgrade guard
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname !== '/ws/lsp') {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws, request) => {
    void handleConnection(ws, request, options, activeConnections, pendingSockets, () => disposed);
  });

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    httpServer.off('upgrade', onUpgrade);
    for (const ws of [...pendingSockets]) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(BRIDGE_DISPOSE_CLOSE_CODE, 'lsp bridge disposed');
      }
    }
    for (const { ws, session } of [...activeConnections.values()]) {
      activeConnections.delete(ws);
      session.dispose();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(BRIDGE_DISPOSE_CLOSE_CODE, 'lsp bridge disposed');
      }
    }
    wss.close();
  };
}

export function createUnavailableLspSession(): LspVirtualSession {
  throw new Error('LSP session factory is not configured');
}

async function handleConnection(
  ws: WebSocket,
  request: IncomingMessage,
  options: LspWebSocketBridgeOptions,
  activeConnections: Map<WebSocket, ActiveConnection>,
  pendingSockets: Set<WebSocket>,
  isBridgeDisposed: () => boolean
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://desk.local');
  const workspaceRoot = url.searchParams.get('workspaceRoot') ?? '';
  if (workspaceRoot.trim() === '') {
    ws.close(WORKSPACE_ROOT_CLOSE_CODE, 'workspaceRoot required');
    return;
  }
  const telemetryEnabled = url.searchParams.get('lspTelemetry') === '1';
  const acceptedAt = performance.now();

  let socketClosed = false;
  ws.on('close', () => {
    socketClosed = true;
    pendingSockets.delete(ws);
    disposeConnection(ws, activeConnections);
  });

  let session: LspVirtualSession;
  pendingSockets.add(ws);
  const createSessionStartedAt = performance.now();
  const pendingStatus: LspLifecycleStatusEvent[] = [];
  let statusPassthrough = false;
  const publishStatus = (status: LspLifecycleStatusEvent): void => {
    if (!statusPassthrough) {
      pendingStatus.push(status);
      return;
    }
    sendJson(ws, { type: 'status', ...status });
  };
  try {
    session = await options.createSession({
      workspaceRoot,
      uri: optionalSearchParam(url, 'uri'),
      languageId: optionalSearchParam(url, 'languageId'),
      publishStatus
    });
  } catch {
    pendingSockets.delete(ws);
    if (!isBridgeDisposed() && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(SESSION_START_CLOSE_CODE, 'lsp session start failed');
    }
    return;
  }
  const createSessionFinishedAt = performance.now();
  pendingSockets.delete(ws);

  if (isBridgeDisposed() || socketClosed || ws.readyState !== WebSocket.OPEN) {
    session.dispose();
    return;
  }

  activeConnections.set(ws, { ws, session });

  ws.on('message', (data) => {
    const parsed = parseClientFrame(String(data));
    if (parsed === undefined) {
      return;
    }
    session.sendClientMessage(parsed);
  });

  session.onServerMessage((message) => {
    sendJson(ws, message);
  });

  session.onExit((exit) => {
    sendJson(ws, { type: 'exit', code: exit.code, signal: exit.signal, ...(exit.restart ? { restart: exit.restart } : {}) });
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000);
    }
  });

  sendJson(
    ws,
    createReadyEnvelope(
      session.capabilities,
      telemetryEnabled
        ? {
            ready: {
              createSessionMs: elapsedMs(createSessionStartedAt, createSessionFinishedAt),
              acceptToReadyMs: elapsedMs(acceptedAt, performance.now())
            }
          }
        : undefined
      )
  );
  statusPassthrough = true;
  if (pendingStatus.length > 0) {
    setImmediate(() => {
      for (const status of pendingStatus.splice(0)) {
        publishStatus(status);
      }
    });
  }
}

function createReadyEnvelope(capabilities: Record<string, unknown>, telemetry?: LspReadyTelemetry): Record<string, unknown> {
  const envelope: Record<string, unknown> = { type: 'ready', capabilities };
  if (telemetry) {
    envelope.telemetry = telemetry;
  }
  return envelope;
}

function elapsedMs(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 1000) / 1000);
}

function optionalSearchParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function parseClientFrame(raw: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed !== null && typeof parsed === 'object') {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(value));
}

function disposeConnection(ws: WebSocket, activeConnections: Map<WebSocket, ActiveConnection>): void {
  const connection = activeConnections.get(ws);
  if (!connection) {
    return;
  }
  activeConnections.delete(ws);
  connection.session.dispose();
}
