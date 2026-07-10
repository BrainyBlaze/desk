import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SessionSpec } from '../src/core/types';
import { installTerminalBroker, TerminalBroker, type BrokerPty } from '../src/server/terminalBroker';

class FakePty implements BrokerPty {
  private dataHandlers: Array<(chunk: string) => void> = [];
  onData(handler: (chunk: string) => void): void {
    this.dataHandlers.push(handler);
  }
  onExit(): void {
    // not needed in endpoint test
  }
  write(): void {
    // not needed in endpoint test
  }
  resize(): void {
    // not needed in endpoint test
  }
  kill(): void {
    // not needed in endpoint test
  }
  emit(chunk: string): void {
    for (const handler of this.dataHandlers) {
      handler(chunk);
    }
  }
}

const session: SessionSpec = {
  name: 'A',
  tmuxSession: 'agentdesk-a',
  cwd: '/tmp',
  command: 'bash',
  groupId: 'g',
  groupLabel: 'g'
};

describe('terminal broker endpoint', () => {
  let server: Server | undefined;
  let dispose: (() => void) | undefined;

  afterEach(async () => {
    dispose?.();
    dispose = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
  });

  it('upgrades /ws/terminal-broker and forwards broker frames', async () => {
    const pty = new FakePty();
    const broker = new TerminalBroker({
      sessions: [session],
      runningSessions: () => new Set([session.tmuxSession]),
      spawnPty: () => pty,
      captureSnapshot: () => '\x1b[2J\x1b[3J\x1b[Hscreen'
    });
    server = createServer();
    dispose = installTerminalBroker(server, broker);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal-broker`);
    const ready = await nextJsonMessage(ws);
    expect(ready).toEqual({ type: 'ready', version: 1 });

    ws.send(JSON.stringify({ type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true }));
    const snapshot = await nextJsonMessage(ws);
    expect(snapshot).toEqual({ type: 'snapshot', session: 'agentdesk-a', surfaceId: 'cell-a', data: '\x1b[2J\x1b[3J\x1b[Hscreen' });

    pty.emit('live');
    const output = await nextJsonMessage(ws);
    expect(output).toEqual({ type: 'output', session: 'agentdesk-a', data: 'live' });
    ws.close();
  });

  it('closes oversized raw frames before JSON parsing', async () => {
    const broker = new TerminalBroker({
      sessions: [session],
      runningSessions: () => new Set([session.tmuxSession]),
      spawnPty: () => new FakePty()
    });
    server = createServer();
    dispose = installTerminalBroker(server, broker, { maxPayloadBytes: 128 });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal-broker`);
    try {
      await nextJsonMessage(ws);
      const closed = waitForClose(ws);
      ws.send('x'.repeat(129));

      await expect(closed).resolves.toBe(1009);
    } finally {
      ws.terminate();
    }
  });
});

async function nextJsonMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), 1000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket close')), 1000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
