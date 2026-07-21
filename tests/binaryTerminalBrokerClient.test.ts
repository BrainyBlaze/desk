// Browser binary terminal broker (spec §7.4/§7.6/§7.7). Drives a fake binary
// WebSocket and asserts the client's on-wire frames + handler callbacks across
// subscribe/ack, FIFO ack pairing, output apply + resync, visibility lifecycle,
// reconnect, input/resize, and error routing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BP_CONN_CHANNEL,
  BpError,
  BpFrameType,
  decodeBpFrame,
  encodeBpFrame,
  type BpFrame
} from '../src/shared/browserProtocol/index.js';
import { BinaryTerminalBrokerClient, type BinaryBrokerSocket, type BinarySurfaceHandlers } from '../src/web/binaryTerminalBrokerClient.js';

class FakeSocket implements BinaryBrokerSocket {
  readyState = 1; // OPEN — the client only sends once it sees the 'open' event
  binaryType = '';
  sent: BpFrame[] = [];
  private handlers = new Map<string, (event: any) => void>();
  send(data: Uint8Array): void {
    this.sent.push(decodeBpFrame(data));
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, handler: (event: any) => void): void {
    this.handlers.set(type, handler);
  }
  fireOpen(): void {
    this.handlers.get('open')?.({});
  }
  fireClose(): void {
    this.readyState = 3;
    this.handlers.get('close')?.({});
  }
  deliver(frame: BpFrame): void {
    // WS binaryType 'arraybuffer' delivers an ArrayBuffer.
    const bytes = encodeBpFrame(frame);
    this.handlers.get('message')?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  /** Frames of a given type the client has sent so far. */
  ofType<T extends BpFrameType>(type: T): Extract<BpFrame, { type: T }>[] {
    return this.sent.filter((f) => f.type === type) as Extract<BpFrame, { type: T }>[];
  }
}

interface Captured {
  output: Uint8Array[];
  snapshot: string[];
  exit: { code: number; signal: number }[];
  error: number[];
  connection: boolean[];
}

function handlers(cap: Captured): BinarySurfaceHandlers {
  return {
    onOutput: (b) => cap.output.push(b),
    onSnapshot: (t) => cap.snapshot.push(t),
    onExit: (code, signal) => cap.exit.push({ code, signal }),
    onError: (code) => cap.error.push(code),
    onConnectionChange: (up) => cap.connection.push(up)
  };
}
const blank = (): Captured => ({ output: [], snapshot: [], exit: [], error: [], connection: [] });

describe('binary terminal broker client (§7.4)', () => {
  let socket: FakeSocket;
  let client: BinaryTerminalBrokerClient;
  beforeEach(() => {
    vi.useFakeTimers(); // neutralize the heartbeat/reconnect timers
    socket = new FakeSocket();
    client = new BinaryTerminalBrokerClient(() => socket, 'ws://test');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ack = (channelId: number, generation = 1, revision = 0) => ({ type: BpFrameType.SUBSCRIBE_ACK as const, channelId, generation, revision });
  const snapshot = (channelId: number, offset: bigint, text: string, generation = 1, revision = 0) =>
    ({ type: BpFrameType.SNAPSHOT as const, channelId, generation, revision, offset, text });
  const output = (channelId: number, offset: bigint, bytes: Uint8Array, generation = 1, revision = 0) =>
    ({ type: BpFrameType.OUTPUT as const, channelId, generation, revision, offset, bytes });

  it('subscribes on open, then applies its ACK snapshot and live output', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    const subs = socket.ofType(BpFrameType.SUBSCRIBE);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ sessionId: 'sess-1', surfaceId: 's1', rows: 40, cols: 120 });
    expect(cap.connection).toEqual([false, true]); // mount-time down, then up on open

    socket.deliver(ack(7));
    socket.deliver(snapshot(7, 100n, 'SCREEN'));
    socket.deliver(output(7, 100n, Uint8Array.of(1, 2, 3)));
    expect(cap.snapshot).toEqual(['SCREEN']);
    expect(cap.output).toHaveLength(1);
    expect([...cap.output[0]]).toEqual([1, 2, 3]);
  });

  it('pairs ACKs to outstanding SUBSCRIBEs in FIFO order', () => {
    const a = blank();
    const b = blank();
    client.subscribe('sa', 'sess-a', 40, 120, true, handlers(a));
    client.subscribe('sb', 'sess-b', 40, 120, true, handlers(b));
    socket.fireOpen();
    // Two SUBSCRIBEs went out in order sa, sb → ACKs bind in that order. Each
    // channel needs its baseline snapshot before deltas apply.
    socket.deliver(ack(10)); // -> sa
    socket.deliver(ack(11)); // -> sb
    socket.deliver(snapshot(10, 0n, 'A'));
    socket.deliver(snapshot(11, 0n, 'B'));
    socket.deliver(output(10, 0n, Uint8Array.of(65)));
    socket.deliver(output(11, 0n, Uint8Array.of(66)));
    expect([...a.output[0]]).toEqual([65]);
    expect([...b.output[0]]).toEqual([66]);
  });

  it('a subscribe-failure ERROR shifts the FIFO queue so later ACKs stay aligned', () => {
    const a = blank();
    const b = blank();
    client.subscribe('sa', 'ghost', 40, 120, true, handlers(a));
    client.subscribe('sb', 'sess-b', 40, 120, true, handlers(b));
    socket.fireOpen();
    // sa fails (ghost session) → conn-channel ERROR; sb then gets the next ACK.
    socket.deliver({ type: BpFrameType.ERROR, channelId: BP_CONN_CHANNEL, code: BpError.BAD_CHANNEL });
    socket.deliver(ack(20)); // must bind to sb, NOT sa
    socket.deliver(snapshot(20, 0n, 'B'));
    socket.deliver(output(20, 0n, Uint8Array.of(66)));
    expect(a.error).toEqual([BpError.BAD_CHANNEL]);
    expect(a.output).toHaveLength(0); // sa never got a channel
    expect([...b.output[0]]).toEqual([66]); // sb correctly aligned
  });

  it('sends INPUT only from a visible, ACKed channel; drops it before the ACK', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendInput('s1', 'x'); // no channel yet → dropped
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
    socket.deliver(ack(5));
    client.sendInput('s1', 'hi');
    client.sendBinary('s1', Uint8Array.of(0x1b, 0x5b, 0x41));
    const inputs = socket.ofType(BpFrameType.INPUT);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ channelId: 5, binary: false });
    expect(new TextDecoder().decode(inputs[0].bytes)).toBe('hi');
    expect(inputs[1]).toMatchObject({ channelId: 5, binary: true });
    expect([...inputs[1].bytes]).toEqual([0x1b, 0x5b, 0x41]);
  });

  it('buffers a pre-ACK resize and flushes it once the channel opens', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendResize('s1', 100, 30); // before ACK → deferred
    expect(socket.ofType(BpFrameType.RESIZE)).toHaveLength(0);
    socket.deliver(ack(9));
    const resizes = socket.ofType(BpFrameType.RESIZE);
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ channelId: 9, cols: 100, rows: 30 });
  });

  it('re-subscribes for a fresh baseline when an output gap makes it dirty', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(3));
    socket.deliver(snapshot(3, 0n, 'BASE'));
    socket.deliver(output(3, 0n, Uint8Array.of(1))); // expected → applied, expected now 1
    socket.deliver(output(3, 5n, Uint8Array.of(2))); // GAP (5 > 1) → dirty
    expect(cap.output).toHaveLength(1); // the gapped delta is NOT applied
    // dirty → UNSUBSCRIBE(3) + a fresh SUBSCRIBE for the surface.
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE).map((f) => f.channelId)).toEqual([3]);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(2);
    // New channel re-baselines and resumes.
    socket.deliver(ack(4));
    socket.deliver(snapshot(4, 6n, 'REBASE'));
    socket.deliver(output(4, 6n, Uint8Array.of(9)));
    expect(cap.snapshot).toEqual(['BASE', 'REBASE']);
    expect([...cap.output[1]]).toEqual([9]);
  });

  it('discards a stale-generation output without dirtying the channel', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(2, /*gen*/ 5));
    socket.deliver(snapshot(2, 0n, 'BASE', /*gen*/ 5));
    socket.deliver(output(2, 0n, Uint8Array.of(1), /*gen*/ 4)); // older gen → discard
    expect(cap.output).toHaveLength(0);
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE)).toHaveLength(0); // not dirtied
  });

  it('hides via UNSUBSCRIBE and reveals via a fresh SUBSCRIBE', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(1));
    client.setVisibility('s1', false);
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE).map((f) => f.channelId)).toEqual([1]);
    // Output to the dropped channel is ignored.
    socket.deliver(output(1, 0n, Uint8Array.of(7)));
    expect(cap.output).toHaveLength(0);
    // Reveal → a new SUBSCRIBE (2nd overall).
    client.setVisibility('s1', true);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(2);
  });

  it('unsubscribing while an ACK is in flight releases the orphan channel', () => {
    const cap = blank();
    const keep = blank();
    // A second surface keeps the connection alive so unsubscribing s1 does not
    // tear down the whole socket before its in-flight ACK arrives.
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    client.subscribe('keep', 'sess-2', 40, 120, true, handlers(keep));
    socket.fireOpen();
    client.unsubscribe('s1'); // ACK for s1 still coming (pendingAcks = [s1, keep])
    socket.deliver(ack(8)); // -> s1, which no longer exists → release the orphan
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE).map((f) => f.channelId)).toEqual([8]);
    socket.deliver(output(8, 0n, Uint8Array.of(1)));
    expect(cap.output).toHaveLength(0);
    // The next ACK still binds correctly to the surviving surface.
    socket.deliver(ack(9)); // -> keep
    socket.deliver(snapshot(9, 0n, 'K'));
    socket.deliver(output(9, 0n, Uint8Array.of(75)));
    expect([...keep.output[0]]).toEqual([75]);
  });

  it('on reconnect forgets stale channels and re-subscribes visible surfaces', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(1));
    expect(cap.connection).toEqual([false, true]);
    socket.fireClose();
    expect(cap.connection).toEqual([false, true, false]);
    // The injected factory closes over `socket`, so pointing it at a fresh
    // instance makes the reconnect (fake backoff timer) build that new socket.
    const first = socket;
    socket = new FakeSocket();
    vi.advanceTimersByTime(2000);
    socket.fireOpen();
    // A stale-channel output on the OLD socket must not apply.
    first.deliver(output(1, 0n, Uint8Array.of(1)));
    expect(cap.output).toHaveLength(0);
    // The new socket re-subscribed the visible surface.
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(1);
    socket.deliver(ack(2));
    socket.deliver(snapshot(2, 0n, 'REBASE'));
    socket.deliver(output(2, 0n, Uint8Array.of(2)));
    expect([...cap.output[0]]).toEqual([2]);
  });

  it('routes EXIT to the owning surface', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(1));
    socket.deliver({ type: BpFrameType.EXIT, channelId: 1, code: 137, signal: 9 });
    expect(cap.exit).toEqual([{ code: 137, signal: 9 }]);
  });
});
