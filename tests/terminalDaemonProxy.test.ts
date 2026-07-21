// Web-server → daemon WS proxy. Proves binary frames forward both ways between a
// browser client and the (separate-process) daemon, with no protocol parsing or
// emulator in the proxy path.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { installTerminalDaemonProxy } from '../src/server/terminalDaemonProxy.js';

describe('terminal daemon WS proxy (separate-process wiring)', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    return (server.address() as AddressInfo).port;
  };

  it('forwards binary frames browser → proxy → daemon → back', async () => {
    // Fake daemon: echoes each binary frame back with a 0xAA prefix.
    const daemonHttp = createServer();
    const daemonWss = new WebSocketServer({ server: daemonHttp, path: '/ws/terminal' });
    daemonWss.on('connection', (ws) => {
      ws.on('message', (data: RawData) => ws.send(Buffer.concat([Buffer.from([0xaa]), data as Buffer])));
    });
    const daemonPort = await listen(daemonHttp);
    cleanups.push(() => daemonWss.close());

    // Web server with only the proxy (no daemon, no xterm).
    const webHttp = createServer();
    const dispose = installTerminalDaemonProxy(webHttp, { daemonBaseUrl: `ws://127.0.0.1:${daemonPort}` });
    cleanups.push(dispose);
    const webPort = await listen(webHttp);

    const client = new WebSocket(`ws://127.0.0.1:${webPort}/ws/terminal`);
    client.binaryType = 'nodebuffer';
    const got = new Promise<Buffer>((resolve) => client.on('message', (d: RawData) => resolve(d as Buffer)));
    await new Promise<void>((r) => client.on('open', () => r()));
    client.send(Buffer.from([0x01, 0x02]));

    expect([...(await got)]).toEqual([0xaa, 0x01, 0x02]); // round-tripped through the proxy
    client.close();
  });
});
