/**
 * Editor-side /ws/lsp WebSocket client implementing the LspTransport seam from connection.ts.
 *
 * It is a thin duplex over a WebSocket: it constructs the /ws/lsp URL, forwards every text frame to
 * LspConnection (which parses the { type:'ready' } / { type:'exit' } envelopes and raw JSON-RPC,
 * including $/cancelRequest), buffers sends until the socket opens, and surfaces the close code/reason
 * (e.g. 1008 missing workspaceRoot, 1011 startup failure) via closeInfo(). The WebSocket is injected
 * (default: the global WebSocket) so tests can drive it with a fake or the node `ws` client.
 *
 * Out of scope: registration lifecycle, EditorSubsystem wiring, config, builtinCoexistence,
 * diagnostics, and the real backend session -- all later, separately-gated slices.
 */

import type { LspTransport } from './connection.js';
import { isPerfEnabled } from './perfTelemetry.js';

/** WebSocket.OPEN; both the browser WebSocket and the node `ws` client use 1. */
const WEBSOCKET_OPEN = 1;

export interface WebSocketMessageEventLike {
  data: unknown;
}
export interface WebSocketCloseEventLike {
  code: number;
  reason: string;
}
/** The minimal WebSocket surface this transport needs; satisfied by browser WebSocket and node `ws`. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: WebSocketMessageEventLike) => void): void;
  addEventListener(type: 'close', listener: (event: WebSocketCloseEventLike) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export interface LspWebSocketTransportOptions {
  /** Required, non-empty; sent as the /ws/lsp workspaceRoot query param. */
  workspaceRoot: string;
  uri?: string;
  languageId?: string;
  /** e.g. 'ws://host:port'. Defaults to the current page origin (ws/wss). */
  baseUrl?: string;
  /** Inject the socket (default: global WebSocket). Tests pass a fake or the node `ws` client. */
  webSocketFactory?: (url: string) => WebSocketLike;
}

/** An LspTransport that also exposes the last close code/reason (for 1008/1011 distinction). */
export interface LspWebSocketTransport extends LspTransport {
  closeInfo(): { code: number; reason: string } | null;
}

function defaultBaseUrl(): string {
  const location = (globalThis as { location?: { protocol: string; host: string } }).location;
  if (location === undefined) {
    throw new Error('createLspWebSocketTransport: baseUrl is required outside a browser context');
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

export function createLspWebSocketTransport(options: LspWebSocketTransportOptions): LspWebSocketTransport {
  if (options.workspaceRoot === undefined || options.workspaceRoot.trim() === '') {
    throw new Error('createLspWebSocketTransport: workspaceRoot is required and must be non-empty');
  }

  const base = options.baseUrl ?? defaultBaseUrl();
  const params = new URLSearchParams();
  params.set('workspaceRoot', options.workspaceRoot);
  if (options.uri !== undefined) {
    params.set('uri', options.uri);
  }
  if (options.languageId !== undefined) {
    params.set('languageId', options.languageId);
  }
  // Opt-in only -- when DESK_LSP_PERF is set, ask the bridge to attach safe ready timing to
  // the ready envelope. Off by default, so normal connections are unchanged.
  if (isPerfEnabled()) {
    params.set('lspTelemetry', '1');
  }
  const url = `${base}/ws/lsp?${params.toString()}`;

  const factory = options.webSocketFactory ?? ((target: string) => new WebSocket(target) as unknown as WebSocketLike);
  const socket = factory(url);

  const messageListeners: Array<(data: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  const sendQueue: string[] = [];
  let isOpen = false;
  let isClosed = false;
  let lastClose: { code: number; reason: string } | null = null;

  // Fires onClose exactly once regardless of close() vs socket-close ordering, and suppresses any
  // buffered sends so a late open cannot leak them.
  const handleClose = (code: number, reason: string): void => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    lastClose = { code, reason };
    sendQueue.length = 0;
    for (const listener of closeListeners) {
      listener();
    }
  };

  socket.addEventListener('open', () => {
    isOpen = true;
    if (isClosed) {
      return;
    }
    for (const data of sendQueue) {
      socket.send(data);
    }
    sendQueue.length = 0;
  });
  socket.addEventListener('message', (event) => {
    if (isClosed) {
      return;
    }
    const data = typeof event.data === 'string' ? event.data : String(event.data);
    for (const listener of messageListeners) {
      listener(data);
    }
  });
  socket.addEventListener('close', (event) => {
    handleClose(event.code, event.reason ?? '');
  });
  socket.addEventListener('error', () => {
    // A socket error is always followed by a close event; closeInfo/onClose are handled there.
  });

  return {
    send(data: string): void {
      if (isClosed) {
        return;
      }
      if (isOpen && socket.readyState === WEBSOCKET_OPEN) {
        socket.send(data);
      } else {
        sendQueue.push(data);
      }
    },
    onMessage(listener: (data: string) => void): void {
      messageListeners.push(listener);
    },
    onClose(listener: () => void): void {
      closeListeners.push(listener);
    },
    close(): void {
      try {
        socket.close();
      } catch {
        // Closing an already-closed/closing socket can throw in some environments; ignore.
      }
    },
    closeInfo(): { code: number; reason: string } | null {
      return lastClose;
    }
  };
}
