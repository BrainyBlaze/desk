// Web-server → daemon WS proxy (cutover, separate-process wiring). The daemon
// (with @xterm/headless + the atch master links) runs as its OWN process; the
// web server must NOT embed it (that regressed serve startup timing). Instead the
// web server proxies each browser /ws/terminal connection to the daemon's WS,
// forwarding the binary browser-protocol frames verbatim in both directions.
// Pure byte-forwarding: no protocol parsing, no emulator, nothing heavy pulled
// into the web-server process.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

interface UpgradeServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off?(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface TerminalDaemonProxyOptions {
  /** WS path proxied (default /ws/terminal). */
  path?: string;
  /** The daemon process WS base, e.g. ws://127.0.0.1:5178 (path is appended). */
  daemonBaseUrl: string;
  maxPayloadBytes?: number;
}

const DEFAULT_PATH = '/ws/terminal';
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Proxy browser terminal WS connections through to the separate daemon process. */
export function installTerminalDaemonProxy(httpServer: UpgradeServer, options: TerminalDaemonProxyOptions): () => void {
  const path = options.path ?? DEFAULT_PATH;
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES });
  const daemonUrl = `${options.daemonBaseUrl.replace(/\/$/, '')}${path}`;

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (socket.destroyed) {
      return;
    }
    const url = new URL(request.url ?? '/', 'http://desk.local');
    if (url.pathname !== path) {
      return;
    }
    wss.handleUpgrade(request, socket, head, (browser) => {
      browser.binaryType = 'nodebuffer';
      // Open the upstream leg to the daemon and forward both ways verbatim.
      const upstream = new WebSocket(daemonUrl);
      upstream.binaryType = 'nodebuffer';
      const pending: RawData[] = [];
      let upstreamOpen = false;

      upstream.on('open', () => {
        upstreamOpen = true;
        for (const buffered of pending.splice(0)) {
          upstream.send(buffered);
        }
      });
      browser.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          return; // the binary protocol is binary-only
        }
        if (upstreamOpen) {
          upstream.send(data);
        } else {
          pending.push(data);
        }
      });
      upstream.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary && browser.readyState === browser.OPEN) {
          browser.send(data);
        }
      });

      const closeBoth = (): void => {
        try {
          browser.close();
        } catch {
          /* already closed */
        }
        try {
          upstream.close();
        } catch {
          /* already closed */
        }
      };
      browser.on('close', closeBoth);
      browser.on('error', closeBoth);
      upstream.on('close', closeBoth);
      upstream.on('error', closeBoth);
    });
  };
  httpServer.on('upgrade', onUpgrade);

  return () => {
    httpServer.off?.('upgrade', onUpgrade);
    wss.close();
  };
}
