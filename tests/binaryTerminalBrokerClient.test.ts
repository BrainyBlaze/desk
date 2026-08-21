// Browser binary terminal broker (spec §7.4/§7.6/§7.7). Drives a fake binary
// WebSocket and asserts the client's on-wire frames + handler callbacks across
// subscribe/ack, FIFO ack pairing, output apply + resync, visibility lifecycle,
// reconnect, input/resize, and error routing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoorExitOutcome } from '../src/shared/controlPlane/contract.js';
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
  exit: MoorExitOutcome[];
  error: number[];
  clientError: string[];
  connection: boolean[];
}

function handlers(cap: Captured): BinarySurfaceHandlers {
  return {
    onOutput: (b) => cap.output.push(b),
    onExit: (outcome) => cap.exit.push(outcome),
    onError: (code) => cap.error.push(code),
    onClientError: (message) => cap.clientError.push(message),
    onConnectionChange: (up) => cap.connection.push(up)
  };
}
const blank = (): Captured => ({ output: [], exit: [], error: [], clientError: [], connection: [] });

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

  const ack = (channelId: number, generation = 1, revision = 0, offset = 0n) => ({
    type: BpFrameType.SUBSCRIBE_ACK as const,
    channelId,
    generation,
    revision,
    offset
  });
  const output = (channelId: number, offset: bigint, bytes: Uint8Array, generation = 1, revision = 0) =>
    ({ type: BpFrameType.OUTPUT as const, channelId, generation, revision, offset, bytes });

  it('releases an ACK that arrives after the surface became hidden', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(1);

    client.setVisibility('s1', false);
    socket.deliver(ack(7)); // ACK lands for the now-hidden surface
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE)).toEqual([
      expect.objectContaining({ channelId: 7 })
    ]);

    client.setVisibility('s1', true);

    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(2);
  });

  it('uses the ACK frontier as a live baseline without waiting for a snapshot', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    const subs = socket.ofType(BpFrameType.SUBSCRIBE);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ sessionId: 'sess-1', surfaceId: 's1', rows: 40, cols: 120 });
    expect(cap.connection).toEqual([false, true]); // mount-time down, then up on open

    socket.deliver(ack(7, 1, 0, 100n));
    socket.deliver(output(7, 100n, Uint8Array.of(1, 2, 3)));
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
    // ACK is that channel's live baseline.
    socket.deliver(ack(10)); // -> sa
    socket.deliver(ack(11)); // -> sb
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
    socket.deliver(output(20, 0n, Uint8Array.of(66)));
    expect(a.error).toEqual([BpError.BAD_CHANNEL]);
    expect(a.output).toHaveLength(0); // sa never got a channel
    expect([...b.output[0]]).toEqual([66]); // sb correctly aligned
  });

  it('sends INPUT only from a visible, ACKed channel; buffers it before the ACK', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendInput('s1', 'x'); // no channel yet → buffered, not dropped
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
    socket.deliver(ack(5));
    client.sendInput('s1', 'hi');
    client.sendBinary('s1', Uint8Array.of(0x1b, 0x5b, 0x41));
    const inputs = socket.ofType(BpFrameType.INPUT);
    // The buffered pre-ACK keystroke flushes first, in order, ahead of the two
    // sent after the channel opened.
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({ channelId: 5, binary: false });
    expect(new TextDecoder().decode(inputs[0].bytes)).toBe('x');
    expect(inputs[1]).toMatchObject({ channelId: 5, binary: false });
    expect(new TextDecoder().decode(inputs[1].bytes)).toBe('hi');
    expect(inputs[2]).toMatchObject({ channelId: 5, binary: true });
    expect([...inputs[2].bytes]).toEqual([0x1b, 0x5b, 0x41]);
  });

  it('buffers every keystroke typed during the reveal/focus race and flushes it in order on ACK (desk#46)', () => {
    // Regression for desk#46: a user who clicks into a session terminal and
    // types immediately — before the SUBSCRIBE round-trip completes and
    // channelId is assigned — must never have those keystrokes silently
    // vanish. `printf ...` arriving at the shell as `pintf ...` is exactly
    // this: characters typed in the pre-ACK window were dropped in
    // sendInputBytes because surface.channelId was still undefined.
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, false, handlers(cap));
    socket.fireOpen();
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(0);
    client.setVisibility('s1', true); // TerminalSurface reveal/focus path
    // Type "printf" one keystroke at a time, exactly as xterm's onData fires
    // per character, all before the ACK for the SUBSCRIBE lands.
    for (const ch of 'printf') {
      client.sendInput('s1', ch);
    }
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0); // nothing sent yet — still buffered
    socket.deliver(ack(42));
    const inputs = socket.ofType(BpFrameType.INPUT);
    const received = inputs.map((f) => new TextDecoder().decode(f.bytes)).join('');
    expect(received).toBe('printf'); // every keystroke arrived, in order, none dropped
    for (const frame of inputs) {
      expect(frame.channelId).toBe(42);
    }
  });

  it('rejects the whole pre-channel input window after a single oversized chunk', () => {
    // Bound #1 (bytes): a paste larger than the whole budget must never be
    // queued at all — buffering it "just this once" would defeat the cap.
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    const huge = 'a'.repeat(70 * 1024); // > the 64 KiB budget, on its own
    client.sendInput('s1', huge);
    expect(cap.error).toEqual([BpError.PAYLOAD_TOO_LARGE]); // visible, not silent
    client.sendInput('s1', 'tail'); // still pre-ACK: must not become a partial replacement command
    socket.deliver(ack(11));
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
    client.sendInput('s1', 'retry'); // the ACK opens a fresh input window
    const inputs = socket.ofType(BpFrameType.INPUT);
    expect(inputs).toHaveLength(1);
    expect(new TextDecoder().decode(inputs[0].bytes)).toBe('retry');
  });

  it('rejects the whole pre-channel input window once cumulative input exceeds the byte budget', () => {
    // Bound #1 (bytes), accumulated across several chunks — e.g. repeated
    // pastes while a subscribe or reconnect is stuck.
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    const chunk = 'x'.repeat(20 * 1024); // 20 KiB
    client.sendInput('s1', chunk); // 20 KiB buffered
    client.sendInput('s1', chunk); // 40 KiB buffered
    client.sendInput('s1', chunk); // 60 KiB buffered — still under the 64 KiB cap
    expect(cap.error).toEqual([]);
    client.sendInput('s1', chunk); // would push to 80 KiB → overflow
    expect(cap.error).toEqual([BpError.PAYLOAD_TOO_LARGE]);
    expect(cap.clientError).toEqual([]);
    client.sendInput('s1', 'tail'); // do not emit a suffix after dropping the prefix
    socket.deliver(ack(12));
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
  });

  it('expires and visibly rejects the whole pre-channel input window at the age deadline', () => {
    // Bound #2 (age): a subscribe/reconnect stuck for longer than 10s must not
    // let ancient keystrokes silently ride in on whatever channel eventually opens.
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendInput('s1', 'a'); // buffered at t=0
    vi.advanceTimersByTime(10_001); // older than the 10s budget
    expect(cap.error).toEqual([]);
    expect(cap.clientError).toEqual(['terminal input queue expired after 10 seconds before the channel opened']);
    client.sendInput('s1', 'b'); // reject the suffix until a channel opens
    socket.deliver(ack(13));
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
  });

  it('rejects aged pending input when the ACK itself arrives after the age budget', () => {
    // The age fence must apply at consumption as well as append time. A user
    // may type once and then receive no further input event before a very late
    // ACK; without this check the ancient key flushes merely because nothing
    // else arrived to trigger bufferPendingInput's append-time fence.
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendInput('s1', 'ancient');
    vi.advanceTimersByTime(10_001);

    socket.deliver(ack(14));

    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
    expect(cap.error).toEqual([]);
    expect(cap.clientError).toEqual(['terminal input queue expired after 10 seconds before the channel opened']);
  });

  it('survives a transport drop even for input already buffered before the drop, then flushes on the new channel (bounded continuity)', () => {
    // Deliberate decision: forgetChannels() (transport 'close') does NOT clear
    // pendingInput — a short reconnect blip must not eat what the user typed
    // mid-reconnect, unlike an explicit hide/unsubscribe/resync (closeChannel),
    // which does drop it. This must hold even for input that was ALREADY
    // buffered (awaiting an ACK that never arrives) at the moment the socket
    // drops — that is exactly what forgetChannels touches. Continuity is safe
    // only because it is bounded by the same byte/age caps exercised above.
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen(); // SUBSCRIBE sent, no ACK yet — no channel
    client.sendInput('s1', 'p'); // typed before the ACK ever lands — buffered
    socket.fireClose(); // transport drops before that ACK arrives (forgetChannels runs)
    client.sendInput('s1', 'm'); // more typed while still down
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0); // nothing sent on the dead socket
    const first = socket;
    socket = new FakeSocket();
    vi.advanceTimersByTime(2000); // backoff fires, builds the new socket
    socket.fireOpen();
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(1); // fresh re-subscribe
    socket.deliver(ack(2)); // new channel opens
    const inputs = socket.ofType(BpFrameType.INPUT);
    expect(inputs).toHaveLength(2);
    // 'p' (buffered before the drop) survives forgetChannels and flushes
    // ahead of 'm' (buffered during the reconnect) — order preserved, nothing lost.
    expect(inputs.map((f) => new TextDecoder().decode(f.bytes)).join('')).toBe('pm');
    expect(inputs.every((f) => f.channelId === 2)).toBe(true);
    expect(first.ofType(BpFrameType.INPUT)).toHaveLength(0); // never replayed onto the dead socket
    expect(cap.error).toEqual([]); // well within both bounds — no overflow
  });

  it('buffers input typed after forceReconnect invalidates the old channel but before the replacement opens', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(7));
    const first = socket;

    const replacement = new FakeSocket();
    replacement.readyState = 0; // CONNECTING: real WebSocket cannot send yet
    socket = replacement;
    client.forceReconnect();
    client.sendInput('s1', 'during-reconnect');
    expect(first.ofType(BpFrameType.INPUT)).toHaveLength(0);
    expect(replacement.ofType(BpFrameType.INPUT)).toHaveLength(0);

    replacement.readyState = 1;
    replacement.fireOpen();
    expect(replacement.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(1);
    replacement.deliver(ack(8));

    const inputs = replacement.ofType(BpFrameType.INPUT);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].channelId).toBe(8);
    expect(new TextDecoder().decode(inputs[0].bytes)).toBe('during-reconnect');
  });

  it("buffers input while the assigned channel's socket is CLOSING and preserves order through resubscribe", () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(7));
    const first = socket;

    first.readyState = 2; // CLOSING, before the close callback invalidates channel 7
    client.sendInput('s1', 'a');
    expect(first.ofType(BpFrameType.INPUT)).toHaveLength(0);

    first.fireClose();
    client.sendInput('s1', 'b');
    socket = new FakeSocket();
    vi.advanceTimersByTime(2000);
    socket.fireOpen();
    socket.deliver(ack(8));

    const inputs = socket.ofType(BpFrameType.INPUT);
    expect(inputs.map((frame) => new TextDecoder().decode(frame.bytes)).join('')).toBe('ab');
    expect(inputs.every((frame) => frame.channelId === 8)).toBe(true);
  });

  it("expires buffered input while a socket is CLOSING even before its old channel is forgotten", () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(7));

    socket.readyState = 2;
    client.sendInput('s1', 'stale');
    vi.advanceTimersByTime(10_001);

    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
    expect(cap.clientError).toEqual(['terminal input queue expired after 10 seconds before the channel opened']);
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

  it('suppresses a pre-ACK resize identical to the SUBSCRIBE geometry', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendResize('s1', 120, 40);
    expect(socket.ofType(BpFrameType.RESIZE)).toHaveLength(0);

    socket.deliver(ack(9));

    expect(socket.ofType(BpFrameType.RESIZE)).toHaveLength(0);
  });

  it('carries a fit reported while hidden in SUBSCRIBE without a redundant RESIZE', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, false, handlers(cap));
    socket.fireOpen();

    client.sendResize('s1', 100, 30);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(0);
    expect(socket.ofType(BpFrameType.RESIZE)).toHaveLength(0);

    client.setVisibility('s1', true);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)[0]).toMatchObject({ cols: 100, rows: 30 });
    socket.deliver(ack(10));
    expect(socket.ofType(BpFrameType.RESIZE)).toHaveLength(0);
  });

  it('reasserts the last geometry in SUBSCRIBE after reconnect without a redundant RESIZE', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendResize('s1', 100, 30);
    socket.deliver(ack(1));

    socket.fireClose();
    socket = new FakeSocket();
    vi.advanceTimersByTime(2000);
    socket.fireOpen();
    expect(socket.ofType(BpFrameType.SUBSCRIBE)[0]).toMatchObject({ cols: 100, rows: 30 });
    socket.deliver(ack(2));

    expect(socket.ofType(BpFrameType.RESIZE)).toHaveLength(0);
  });

  it('re-subscribes for a fresh baseline when an output gap makes it dirty', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(3));
    socket.deliver(output(3, 0n, Uint8Array.of(1))); // expected → applied, expected now 1
    socket.deliver(output(3, 5n, Uint8Array.of(2))); // GAP (5 > 1) → dirty
    expect(cap.output).toHaveLength(1); // the gapped delta is NOT applied
    // dirty → UNSUBSCRIBE(3) + a fresh SUBSCRIBE for the surface.
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE).map((f) => f.channelId)).toEqual([3]);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(2);
    // New channel re-baselines and resumes.
    socket.deliver(ack(4, 1, 0, 6n));
    socket.deliver(output(4, 6n, Uint8Array.of(9)));
    expect([...cap.output[1]]).toEqual([9]);
  });

  it('discards a stale-generation output without dirtying the channel', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(2, /*gen*/ 5));
    socket.deliver(output(2, 0n, Uint8Array.of(1), /*gen*/ 4)); // older gen → discard
    expect(cap.output).toHaveLength(0);
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE)).toHaveLength(0); // not dirtied
  });

  it('detaches on hide and re-subscribes live on reveal without replay', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(1));
    client.setVisibility('s1', false);
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE)).toEqual([
      expect.objectContaining({ channelId: 1 })
    ]);
    // A late frame for the detached channel is ignored.
    socket.deliver(output(1, 0n, Uint8Array.of(7)));
    expect(cap.output).toHaveLength(0);
    client.sendResize('s1', 101, 31);
    client.setVisibility('s1', true);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(2);
    socket.deliver(ack(2, 1, 0, 1n));
    expect(socket.ofType(BpFrameType.SUBSCRIBE).at(-1)).toMatchObject({ cols: 101, rows: 31 });
    expect(socket.ofType(BpFrameType.RESIZE)).toEqual([]);
    socket.deliver(output(2, 1n, Uint8Array.of(8)));
    expect(cap.output.map((bytes) => [...bytes])).toEqual([[8]]);
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
    socket.deliver(output(9, 0n, Uint8Array.of(75)));
    expect([...keep.output[0]]).toEqual([75]);
  });

  it('does not replay pre-ACK input after hide detaches and reveal resubscribes', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendInput('s1', 'stale');
    client.setVisibility('s1', false);
    socket.deliver(ack(8));

    client.setVisibility('s1', true);

    expect(socket.ofType(BpFrameType.UNSUBSCRIBE)).toEqual([
      expect.objectContaining({ channelId: 8 })
    ]);
    expect(socket.ofType(BpFrameType.SUBSCRIBE)).toHaveLength(2);
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
  });

  it('never binds an old ACK to a replacement surface that reuses the same surfaceId', () => {
    const oldSurface = blank();
    const replacement = blank();
    const keep = blank();
    client.subscribe('s1', 'sess-old', 40, 120, true, handlers(oldSurface));
    client.subscribe('keep', 'sess-keep', 40, 120, true, handlers(keep));
    socket.fireOpen();
    client.sendInput('s1', 'old');

    // React effect cleanup unsubscribes before the same mounted component
    // subscribes its replacement session with the same stable surfaceId.
    client.unsubscribe('s1');
    client.subscribe('s1', 'sess-new', 40, 120, true, handlers(replacement));
    client.sendInput('s1', 'new');

    socket.deliver(ack(10)); // belongs to sess-old and must be released
    expect(socket.ofType(BpFrameType.UNSUBSCRIBE).map((frame) => frame.channelId)).toEqual([10]);
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);

    socket.deliver(ack(11)); // keep
    socket.deliver(ack(12)); // sess-new
    const inputs = socket.ofType(BpFrameType.INPUT);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].channelId).toBe(12);
    expect(new TextDecoder().decode(inputs[0].bytes)).toBe('new');
  });

  it('discards pending input when the subscription is definitively rejected', () => {
    const cap = blank();
    client.subscribe('s1', 'ghost', 40, 120, true, handlers(cap));
    socket.fireOpen();
    client.sendInput('s1', 'stale');
    socket.deliver({ type: BpFrameType.ERROR, channelId: BP_CONN_CHANNEL, code: BpError.BAD_CHANNEL });
    expect(cap.error).toEqual([BpError.BAD_CHANNEL]);

    const first = socket;
    socket = new FakeSocket();
    client.forceReconnect();
    socket.fireOpen();
    socket.deliver(ack(20));

    expect(first.ofType(BpFrameType.INPUT)).toHaveLength(0);
    expect(socket.ofType(BpFrameType.INPUT)).toHaveLength(0);
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
    socket.deliver(output(2, 0n, Uint8Array.of(2)));
    expect([...cap.output[0]]).toEqual([2]);
  });

  it('routes EXIT to the owning surface with the tagged outcome intact', () => {
    const cap = blank();
    client.subscribe('s1', 'sess-1', 40, 120, true, handlers(cap));
    socket.fireOpen();
    socket.deliver(ack(1));
    socket.deliver({ type: BpFrameType.EXIT, channelId: 1, outcome: { kind: 'signalled', signal: 9, method: 'forced' } });
    expect(cap.exit).toEqual([{ kind: 'signalled', signal: 9, method: 'forced' }]);
    socket.deliver({ type: BpFrameType.EXIT, channelId: 1, outcome: { kind: 'unknown' } });
    expect(cap.exit).toEqual([{ kind: 'signalled', signal: 9, method: 'forced' }, { kind: 'unknown' }]);
  });
});
