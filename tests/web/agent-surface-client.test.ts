import { describe, expect, it, vi } from 'vitest';
import { AgentSurfaceClient, type AgentSurfaceSocket } from '../../src/web/agentSurface/agentSurfaceClient';

/**
 * G1 regression coverage (codex Phase 4 review msg-20260705-220040):
 * forceReconnect / closeSocket races can leave stale socket handlers firing into the
 * current connection state. terminalBrokerClient guards every handler on socket identity
 * (`this.socket !== socket`); agentSurfaceClient now does the same.
 *
 * The repro: create socket A, forceReconnect creates socket B, then A fires `close` —
 * without the guard, A's close flips connected=false and schedules a reconnect that
 * creates socket C, leaving the operator with 3 sockets and a broken state machine.
 */
class FakeSocket implements AgentSurfaceSocket {
  readyState = 0;
  openHandlers: Array<() => void> = [];
  messageHandlers: Array<(event: { data?: unknown }) => void> = [];
  closeHandlers: Array<() => void> = [];
  errorHandlers: Array<() => void> = [];
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: 'open' | 'close' | 'error' | 'message', handler: (event: { data?: unknown }) => void): void {
    if (type === 'open') this.openHandlers.push(handler as () => void);
    else if (type === 'message') this.messageHandlers.push(handler);
    else if (type === 'close') this.closeHandlers.push(handler as () => void);
    else if (type === 'error') this.errorHandlers.push(handler as () => void);
  }

  fireOpen(): void { for (const h of this.openHandlers) h(); }
  fireMessage(data: unknown): void { for (const h of this.messageHandlers) h({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  fireClose(): void { for (const h of this.closeHandlers) h(); }
  fireError(): void { for (const h of this.errorHandlers) h(); }
}

function makeClient(): { client: AgentSurfaceClient; sockets: FakeSocket[]; factory: (url: string) => FakeSocket } {
  const sockets: FakeSocket[] = [];
  const factory = (_url: string): FakeSocket => {
    const sock = new FakeSocket();
    sockets.push(sock);
    return sock;
  };
  const client = new AgentSurfaceClient(factory as unknown as (url: string) => AgentSurfaceSocket, 'ws://test');
  return { client, sockets, factory };
}

const noopHandlers = {
  onSnapshot: () => undefined,
  onEvent: () => undefined
};

describe('AgentSurfaceClient socket-identity guard (G1 regression)', () => {
  it('forceReconnect replaces the socket; the OLD socket firing close does NOT corrupt the new connection', () => {
    const { client, sockets } = makeClient();
    client.subscribe('surf-1', 'sess-1', true, noopHandlers);
    const firstSocket = sockets[0]!;
    firstSocket.fireOpen();
    expect(client.isConnected).toBe(true);

    client.forceReconnect();
    // forceReconnect should have created a second socket
    expect(sockets).toHaveLength(2);
    const secondSocket = sockets[1]!;
    // First socket is now stale; second is current.
    secondSocket.fireOpen();
    expect(client.isConnected).toBe(true);

    // The race: stale first socket fires close. Without the identity guard this would
    // flip connected=false and schedule another reconnect (creating a 3rd socket).
    firstSocket.fireClose();
    expect(client.isConnected).toBe(true); // still connected via secondSocket
    expect(sockets).toHaveLength(2); // no 3rd socket created

    client.unsubscribe('surf-1');
  });

  it('stale socket firing message does NOT route to handlers after forceReconnect', () => {
    const { client, sockets } = makeClient();
    const events: unknown[] = [];
    client.subscribe('surf-1', 'sess-1', true, { ...noopHandlers, onEvent: (e) => events.push(e) });
    const firstSocket = sockets[0]!;
    firstSocket.fireOpen();
    client.forceReconnect();
    const secondSocket = sockets[1]!;
    secondSocket.fireOpen();

    // Stale first socket tries to deliver a frame — must be ignored.
    firstSocket.fireMessage({ type: 'event', session: 'sess-1', event: { kind: 'status', state: 'idle', seq: 1, ts: 'x' } });
    expect(events).toEqual([]);

    // Current socket delivers — routes normally.
    secondSocket.fireMessage({ type: 'event', session: 'sess-1', event: { kind: 'status', state: 'idle', seq: 1, ts: 'x' } });
    expect(events).toHaveLength(1);

    client.unsubscribe('surf-1');
  });

  it('scheduleReconnect is unbounded — keeps retrying past the previous 5-attempt cap', () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = makeClient();
      client.subscribe('surf-1', 'sess-1', true, noopHandlers);
      const firstSocket = sockets[0]!;
      firstSocket.fireClose();
      // Drive 20 reconnect cycles: advance timers to trigger the pending reconnect
      // (which creates a new socket), then fire close on the new socket to schedule the
      // next. The previous 5-attempt cap would have stopped after 6 total (initial + 5);
      // unbounded backoff keeps going.
      for (let i = 0; i < 20; i += 1) {
        vi.advanceTimersByTime(60_000); // well past any capped backoff
        const latest = sockets[sockets.length - 1]!;
        latest.fireClose();
      }
      expect(sockets.length).toBeGreaterThan(6);
      client.unsubscribe('surf-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-subscribe during reconnect backoff cancels the pending reconnect (no orphaned socket)', () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = makeClient();
      client.subscribe('surf-1', 'sess-1', true, noopHandlers);
      sockets[0]!.fireOpen();
      // Connection drops → a reconnect is armed with backoff.
      sockets[0]!.fireClose();
      expect(sockets).toHaveLength(1);

      // A surface (re)subscribes DURING the backoff window and a live socket opens.
      client.subscribe('surf-2', 'sess-2', true, noopHandlers);
      expect(sockets).toHaveLength(2);
      sockets[1]!.fireOpen();
      expect(client.isConnected).toBe(true);

      // The stale reconnect timer must have been cancelled by ensureConnection: advancing
      // past the backoff must NOT null the live socket or spin up a 3rd (orphaned) socket.
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
      expect(client.isConnected).toBe(true);

      client.unsubscribe('surf-1');
      client.unsubscribe('surf-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('send delivers the frame when the socket is OPEN', () => {
    const { client, sockets } = makeClient();
    client.subscribe('surf-1', 'sess-1', true, noopHandlers);
    const socket = sockets[0]!;
    socket.fireOpen();
    socket.readyState = 1; // OPEN
    expect(() => client.send('surf-1', 'sess-1', 'hello')).not.toThrow();
    expect(socket.sent.some((frame) => frame.includes('"type":"send"') && frame.includes('hello'))).toBe(true);
    client.unsubscribe('surf-1');
  });

  it('send throws instead of silently dropping when connected but the socket is not OPEN', () => {
    const { client, sockets } = makeClient();
    client.subscribe('surf-1', 'sess-1', true, noopHandlers);
    const socket = sockets[0]!;
    socket.fireOpen(); // connected = true
    socket.readyState = 2; // CLOSING: the reconnect gap
    const before = socket.sent.length;
    expect(() => client.send('surf-1', 'sess-1', 'hello')).toThrow(/not open|could not be delivered/i);
    expect(socket.sent.length).toBe(before); // nothing delivered
    client.unsubscribe('surf-1');
  });
});
