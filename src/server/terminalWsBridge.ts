// Binary terminal WS bridge (spec §7.4). Mounts a TerminalWsRouter on a real
// WebSocket upgrade, the server peer of binaryTerminalBrokerClient. It mirrors
// installTerminalBroker (the string-JSON path) but carries the binary browser
// protocol: each WS message IS one frame, relayed verbatim to the router, and
// the router's server→client frames are sent back as binary messages.
//
// Additive and non-breaking: this listens on its own path (/ws/terminal) and
// does not touch the tmux /ws/terminal-broker route. Session provisioning
// (spawn+attach the atch master) is the daemon lifecycle's job, driven by the
// desk start/stop flow — this bridge only carries surface traffic for sessions
// the daemon already owns.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { TerminalWsRouter, type WsConn } from './runtime/terminalWsRouter.js';
import { BpFrameType, encodeBpFrame } from '../shared/browserProtocol/index.js';

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off?(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface TerminalWsBridgeOptions {
  /** WS path to accept (default /ws/terminal). */
  path?: string;
  maxPayloadBytes?: number;
  /** Liveness beacon period; the client's half-open watchdog needs periodic frames. */
  heartbeatMs?: number;
}

const DEFAULT_PATH = '/ws/terminal';
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;

export function installTerminalWsBridge(
  httpServer: UpgradeServer,
  router: TerminalWsRouter,
  options: TerminalWsBridgeOptions = {}
): () => void {
  const path = options.path ?? DEFAULT_PATH;
  const maxPayload = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 'terminal ws bridge maxPayloadBytes');
  const heartbeatMs = positiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, 'terminal ws bridge heartbeatMs');
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  // One stable WsConn per socket — the router keys channel ownership by WsConn
  // identity, so the adapter must be reused for every frame AND the close.
  const conns = new Map<WebSocket, WsConn>();
  const heartbeat = encodeBpFrame({ type: BpFrameType.HEARTBEAT });
  const heartbeatTimer = setInterval(() => {
    for (const ws of conns.keys()) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(heartbeat);
        } catch {
          /* dropped; close handler cleans up */
        }
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (socket.destroyed) {
      return; // already rejected upstream
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname !== path) {
      return; // not ours — another upgrade listener may claim it
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    ws.binaryType = 'nodebuffer';
    const conn: WsConn = {
      send: (bytes) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(bytes);
        }
      }
    };
    conns.set(ws, conn);
    ws.on('message', (data: unknown, isBinary: boolean) => {
      // The binary protocol is binary-only; a text frame is a malformed/hostile
      // client. Ignore it rather than feed a decode error.
      if (!isBinary) {
        return;
      }
      const bytes = toBytes(data);
      if (bytes) {
        router.onWsFrame(conn, bytes);
      }
    });
    const drop = (): void => {
      if (conns.delete(ws)) {
        router.onWsClose(conn);
      }
    };
    ws.on('close', drop);
    ws.on('error', drop);
  });

  return () => {
    clearInterval(heartbeatTimer);
    httpServer.off?.('upgrade', onUpgrade);
    for (const ws of conns.keys()) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    conns.clear();
    wss.close();
  };
}

/** Normalize a `ws` message payload (Buffer / Buffer[] / ArrayBuffer) to bytes. */
function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return data; // Buffer is a Uint8Array — ByteReader consumes it directly
  }
  if (Array.isArray(data)) {
    return data.length === 1 ? toBytes(data[0]) : Buffer.concat(data as Buffer[]);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}
