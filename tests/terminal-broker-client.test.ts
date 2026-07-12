import { describe, expect, it } from 'vitest';
import { TerminalBrokerClient, type BrokerSocket } from '../src/web/terminalBrokerClient.js';
import type { TerminalBrokerServerFrame } from '../src/core/terminalBrokerProtocol.js';

class FakeSocket implements BrokerSocket {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  /** When true, close() defers the 'close' event (models a real browser
   * WebSocket, whose close is async — the event fires a task later, after the
   * caller may have replaced this.socket). Flush with fireDeferredClose(). */
  deferredClose = false;
  private pendingClose = false;
  private handlers: Record<string, ((e: any) => void)[]> = {};
  addEventListener(type: string, handler: (e: any) => void): void {
    (this.handlers[type] ??= []).push(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.deferredClose) {
      this.readyState = 2; // CLOSING
      this.pendingClose = true;
      return;
    }
    this.fire('close', {});
  }
  fireDeferredClose(): void {
    if (!this.pendingClose) return;
    this.pendingClose = false;
    this.readyState = 3; // CLOSED
    this.fire('close', {});
  }
  open(): void {
    this.readyState = 1; // OPEN
    this.fire('open', {});
  }
  emit(frame: TerminalBrokerServerFrame): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }
  private fire(type: string, event: any): void {
    for (const h of this.handlers[type] ?? []) h(event);
  }
  parsedSent(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeClient(): { client: TerminalBrokerClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const client = new TerminalBrokerClient((_url) => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }, 'ws://test/ws/terminal-broker');
  return { client, sockets };
}

describe('TerminalBrokerClient', () => {
  it('opens ONE connection for many surfaces and subscribes each', () => {
    const { client, sockets } = makeClient();
    const noop = { onOutput: () => {}, onSnapshot: () => {} };
    client.subscribe('s1', 'sessA', true, noop);
    client.subscribe('s2', 'sessB', false, noop);
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    const subs = sockets[0].parsedSent().filter((f) => f.type === 'subscribe');
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.surfaceId).sort()).toEqual(['s1', 's2']);
  });

  it('routes output only to VISIBLE surfaces of the session', () => {
    const { client, sockets } = makeClient();
    const a: string[] = [];
    const b: string[] = [];
    client.subscribe('vis', 'sess', true, { onOutput: (d) => a.push(d), onSnapshot: () => {} });
    client.subscribe('hid', 'sess', false, { onOutput: (d) => b.push(d), onSnapshot: () => {} });
    sockets[0].open();
    sockets[0].emit({ type: 'output', session: 'sess', data: 'hello' });
    expect(a).toEqual(['hello']);
    expect(b).toEqual([]); // hidden surface never parses
  });

  it('delivers a targeted snapshot to its surface and toggles visibility frames', () => {
    const { client, sockets } = makeClient();
    const snaps: string[] = [];
    const out: string[] = [];
    client.subscribe('s1', 'sess', false, { onOutput: (d) => out.push(d), onSnapshot: (d) => snaps.push(d) });
    sockets[0].open();
    client.setVisibility('s1', true);
    expect(sockets[0].parsedSent().some((f) => f.type === 'visibility' && f.visible === true && f.surfaceId === 's1')).toBe(true);
    sockets[0].emit({ type: 'snapshot', session: 'sess', surfaceId: 's1', data: 'SCREEN' });
    expect(snaps).toEqual(['SCREEN']);
    // now visible: live output flows
    sockets[0].emit({ type: 'output', session: 'sess', data: 'live' });
    expect(out).toEqual(['live']);
  });

  it('only sends input/resize from a visible subscribed surface', () => {
    const { client, sockets } = makeClient();
    client.subscribe('s1', 'sess', false, { onOutput: () => {}, onSnapshot: () => {} });
    sockets[0].open();
    client.sendInput('s1', 'x'); // hidden -> dropped
    client.sendResize('s1', 80, 24); // hidden -> dropped
    expect(sockets[0].parsedSent().some((f) => f.type === 'input' || f.type === 'resize')).toBe(false);
    client.setVisibility('s1', true);
    client.sendInput('s1', 'y');
    client.sendResize('s1', 80, 24);
    const sent = sockets[0].parsedSent();
    expect(sent.some((f) => f.type === 'input' && f.data === 'y')).toBe(true);
    expect(sent.some((f) => f.type === 'resize' && f.cols === 80 && f.rows === 24)).toBe(true);
  });

  it('resubscribes all surfaces with current visibility after reconnect', () => {
    const { client, sockets } = makeClient();
    client.subscribe('s1', 'sess', true, { onOutput: () => {}, onSnapshot: () => {} });
    sockets[0].open();
    client.setVisibility('s1', false);
    sockets[0].close(); // drop
    // a reconnect timer fires ensureConnection -> new socket; simulate by opening the next
    // (the client schedules setTimeout; emulate immediate reconnect)
    // Force an immediate reconnect instead of waiting for the backoff timer:
    client.forceReconnect();
    const latest = sockets[sockets.length - 1];
    latest.open();
    const sub = latest.parsedSent().find((f) => f.type === 'subscribe' && f.surfaceId === 's1');
    expect(sub).toBeTruthy();
    expect(sub.visible).toBe(false); // resubscribed with CURRENT visibility
  });

  it('flushes a resize requested while the socket is still CONNECTING', () => {
    const { client, sockets } = makeClient();
    client.subscribe('s1', 'sess', true, { onOutput: () => {}, onSnapshot: () => {} });
    // socket exists but has NOT opened yet (readyState CONNECTING)
    client.sendResize('s1', 100, 40);
    expect(sockets[0].parsedSent().some((f) => f.type === 'resize')).toBe(false); // dropped-now, queued
    sockets[0].open(); // resubscribe + flush pending resize
    const resize = sockets[0].parsedSent().find((f) => f.type === 'resize');
    expect(resize).toBeTruthy();
    expect(resize.cols).toBe(100);
    expect(resize.rows).toBe(40);
  });

  it('re-sends the last resize after a reconnect (not lost with the dropped socket)', () => {
    const { client, sockets } = makeClient();
    client.subscribe('s1', 'sess', true, { onOutput: () => {}, onSnapshot: () => {} });
    sockets[0].open();
    client.sendResize('s1', 90, 30);
    expect(sockets[0].parsedSent().some((f) => f.type === 'resize' && f.cols === 90)).toBe(true);
    sockets[0].close();
    client.forceReconnect();
    const latest = sockets[sockets.length - 1];
    latest.open();
    // pendingResize was cleared after the first send, so a clean reconnect with
    // no NEW resize must not duplicate it; the subscribe carries current state.
    expect(latest.parsedSent().some((f) => f.type === 'subscribe' && f.surfaceId === 's1')).toBe(true);
  });

  it('does not wedge when Reconnect fires while the socket is still CONNECTING (wake-from-sleep)', () => {
    const { client, sockets } = makeClient();
    client.subscribe('s1', 'sess', true, { onOutput: () => {}, onSnapshot: () => {} });
    expect(sockets).toHaveLength(1);
    // Socket 0 is CONNECTING (never opened) — the wake-from-sleep window where SYN
    // retries hold it open for seconds. Model the real browser: close() is async.
    sockets[0].deferredClose = true;
    // online + visibilitychange + pulse recovery all call forceReconnect here.
    client.forceReconnect();
    // A NEW connection attempt MUST be made. Before the fix, `connecting` stayed
    // true (the orphaned socket's async close bails on the stale-socket guard and
    // never resets it), so ensureConnection early-returned — permanently wedged,
    // and the Reconnect button became a no-op.
    expect(sockets).toHaveLength(2);
    // The orphaned socket's async close now arrives; it must not corrupt the new one.
    sockets[0].fireDeferredClose();
    sockets[1].open();
    const sub = sockets[1].parsedSent().find((f) => f.type === 'subscribe' && f.surfaceId === 's1');
    expect(sub).toBeTruthy();
    // Genuinely reconnected: live output flows again.
    const out: string[] = [];
    client.subscribe('s1', 'sess', true, { onOutput: (d) => out.push(d), onSnapshot: () => {} });
    sockets[1].emit({ type: 'output', session: 'sess', data: 'ok' });
    expect(out).toEqual(['ok']);
  });

  it('replays the current connection state to a late subscriber (down → overlay, not silent input loss)', () => {
    const { client, sockets } = makeClient();
    const conn: boolean[] = [];
    // Subscribe while socket 0 is still CONNECTING (connected === false).
    client.subscribe('s1', 'sess', true, {
      onOutput: () => {},
      onSnapshot: () => {},
      onConnectionChange: (up) => conn.push(up)
    });
    // The late subscriber must immediately learn it is disconnected — otherwise
    // the cell renders alive and silently swallows keystrokes.
    expect(conn[0]).toBe(false);
    sockets[0].open();
    expect(conn.at(-1)).toBe(true);
    // A new surface subscribing while connected reports true right away.
    const conn2: boolean[] = [];
    client.subscribe('s2', 'sess', true, {
      onOutput: () => {},
      onSnapshot: () => {},
      onConnectionChange: (up) => conn2.push(up)
    });
    expect(conn2).toEqual([true]);
  });

  it('tears down the socket when the last surface unsubscribes', () => {
    const { client, sockets } = makeClient();
    client.subscribe('s1', 'sess', true, { onOutput: () => {}, onSnapshot: () => {} });
    sockets[0].open();
    let closed = false;
    sockets[0].addEventListener('close', () => { closed = true; });
    client.unsubscribe('s1');
    expect(closed).toBe(true);
  });
});
