/**
 * Browser-singleton terminal client over the BINARY browser protocol (spec
 * §7.4/§7.6/§7.7). One WebSocket per tab carries every visible terminal
 * surface's traffic. This is the browser peer of the server-side
 * terminalWsRouter: it speaks the same channelId-keyed
 * frames and runs one loss-aware resync FSM per channel, so a dropped output
 * delta, a recreated session (generation bump), or a geometry change (revision
 * bump) drives the surface back to a clean snapshot instead of a corrupted
 * screen rendered from partial deltas.
 *
 * Two protocol facts shape the client and are worth stating up front:
 *
 *  - SUBSCRIBE_ACK is compact: it carries only {channelId, generation,
 *    revision}, NOT the surfaceId that requested it. A single ordered WS
 *    delivers the server's synchronous ACKs in the same order as our
 *    SUBSCRIBEs, so we pair each ACK (or a subscribe-failure ERROR on the
 *    connection channel) to the head of a FIFO `pendingAcks` queue. A failed
 *    subscribe must shift that queue too, or every later ACK misbinds.
 *
 *  - There is no client "request snapshot" frame. A gap still re-subscribes,
 *    while visibility uses the protocol's VISIBILITY frame on the existing
 *    channel. The server gates hidden output and emits a fresh same-channel
 *    snapshot on reveal, so view changes never churn subscription ownership.
 */
import {
  BP_CONN_CHANNEL,
  BpError,
  BpFrameType,
  BpInputFlag,
  decodeBpFrame,
  encodeBpFrame,
  SubscriptionResync,
  type BpFrame
} from '../shared/browserProtocol/index.js';
import type { MoorExitOutcome } from '../shared/controlPlane/contract.js';
import { subscribeBridgeRetry } from './terminalHeartbeat.js';

/** Minimal binary-WebSocket surface so tests can inject a fake transport. */
export interface BinaryBrokerSocket {
  readyState: number;
  /** Set to 'arraybuffer' so incoming messages arrive as ArrayBuffer, not Blob. */
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', handler: (event: any) => void): void;
}
export type BinaryBrokerSocketFactory = (url: string) => BinaryBrokerSocket;

export interface BinarySurfaceHandlers {
  /** Live output bytes for this surface; write straight to xterm (accepts Uint8Array). */
  onOutput: (bytes: Uint8Array) => void;
  /** Baseline snapshot (SerializeAddon restorable string); do terminal.reset() then write. */
  onSnapshot: (text: string) => void;
  /** The session ended; `outcome` is the holder's tagged ending as the EXIT frame carried it (`unknown` included). */
  onExit?: (outcome: MoorExitOutcome) => void;
  /** Protocol-level error for this surface (a BpError code). */
  onError?: (code: number) => void;
  /** Client-side failure that has no browser-protocol error code. */
  onClientError: (message: string) => void;
  /** broker connection up/down — drives the per-cell reconnect UI */
  onConnectionChange?: (up: boolean) => void;
}

interface BinarySurface {
  sessionId: string;
  surfaceId: string;
  rows: number;
  cols: number;
  visible: boolean;
  handlers: BinarySurfaceHandlers;
  /** Assigned on SUBSCRIBE_ACK; undefined while unsubscribed or awaiting the ack. */
  channelId?: number;
  /** One resync FSM per live channel; recreated on each fresh subscribe. */
  resync?: SubscriptionResync;
  /** A SUBSCRIBE was sent and its ACK has not yet arrived (FIFO-paired). */
  awaitingAck: boolean;
  /** Latest size not yet sent (socket connecting / channel not yet open). */
  pendingResize?: { cols: number; rows: number };
  /**
   * Keystrokes/paste bytes typed while there is no open channel — socket still
   * connecting, SUBSCRIBE_ACK still in flight, or a transport drop mid-reconnect
   * (forgetChannels deliberately leaves this alone: a short reconnect blip
   * must not eat what the user typed during it). Queued in order and flushed
   * whole once a channel opens. Bounded by MAX_PENDING_INPUT_BYTES /
   * MAX_PENDING_INPUT_AGE_MS — see bufferPendingInput (desk#46).
   */
  pendingInput?: { bytes: Uint8Array; binary: boolean }[];
  /** Total payload bytes in pendingInput; maintained incrementally. */
  pendingInputBytes?: number;
  /** Wall-clock time the oldest entry in pendingInput was queued. */
  pendingInputSince?: number;
  /** Clears and visibly rejects a queue that never reaches an open channel. */
  pendingInputTimer?: ReturnType<typeof setTimeout>;
  /** Once a pending window is rejected, suppress its tail until an ACK opens a fresh window. */
  pendingInputRejected?: boolean;
}

const OPEN = 1;
const RECONNECT_MAX = 5;
// If no frame of any type arrives within this window the socket is treated as
// dead (a half-open TCP still reports OPEN). The server beacons periodically, so
// two missed beacons = dead. Mirrors the string-JSON broker's watchdog.
const HEARTBEAT_TIMEOUT_MS = 30_000;
// Bounds on pendingInput so a stalled channel/reconnect can't accumulate
// keystrokes forever: either budget blown drops the whole stale queue (never
// silently — see bufferPendingInput) rather than growing without limit or
// replaying ancient input into a channel that opens minutes later.
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const MAX_PENDING_INPUT_AGE_MS = 10_000;
const PENDING_INPUT_EXPIRED_MESSAGE =
  `terminal input queue expired after ${MAX_PENDING_INPUT_AGE_MS / 1000} seconds before the channel opened`;

const TEXT_ENCODER = new TextEncoder();

export class BinaryTerminalBrokerClient {
  private socket: BinaryBrokerSocket | undefined;
  private readonly surfaces = new Map<string, BinarySurface>(); // surfaceId -> surface
  private readonly channelToSurface = new Map<number, BinarySurface>(); // channelId -> exact surface incarnation
  /** Surfaces whose SUBSCRIBE is outstanding, in send order (FIFO ack pairing). */
  private readonly pendingAcks: BinarySurface[] = [];
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private selfHealArmed = false;
  private lastFrameAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly makeSocket: BinaryBrokerSocketFactory = defaultFactory, private readonly url?: string) {}

  subscribe(surfaceId: string, sessionId: string, rows: number, cols: number, visible: boolean, handlers: BinarySurfaceHandlers): void {
    const surface: BinarySurface = { sessionId, surfaceId, rows, cols, visible, handlers, awaitingAck: false };
    this.surfaces.set(surfaceId, surface);
    this.ensureConnection();
    if (this.connected && visible) {
      this.sendSubscribe(surface);
    }
    // A cell that mounts while the bridge is already down must learn it is
    // disconnected immediately (onConnectionChange otherwise only fires on
    // future transitions) so it shows the Reconnect overlay rather than
    // silently swallowing keystrokes.
    surface.handlers.onConnectionChange?.(this.connected);
  }

  unsubscribe(surfaceId: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    this.surfaces.delete(surfaceId);
    this.closeChannel(surface); // UNSUBSCRIBE the server-side channel if one is open
    if (this.surfaces.size === 0) {
      this.teardown();
    }
  }

  setVisibility(surfaceId: string, visible: boolean): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || surface.visible === visible) {
      return;
    }
    surface.visible = visible;
    if (!visible) {
      // Input queued before the hide belongs to a focus context that no longer
      // exists and must not replay when the same channel becomes visible again.
      this.clearPendingInput(surface);
    }
    if (!this.connected) {
      return; // resubscribeAll on reconnect honors the current visibility
    }
    if (visible) {
      if (surface.channelId !== undefined) {
        // The fitted size was measured while hidden. Send it while the server
        // still considers the channel hidden, then reveal so ownership election
        // and the fresh snapshot use that exact geometry.
        this.flushResize(surface);
        this.sendFrame({ type: BpFrameType.VISIBILITY, channelId: surface.channelId, visible: true });
      } else if (!surface.awaitingAck) {
        this.sendSubscribe(surface);
      }
    } else if (surface.channelId !== undefined) {
      this.sendFrame({ type: BpFrameType.VISIBILITY, channelId: surface.channelId, visible: false });
    }
  }

  /** UTF-8 keystrokes (xterm onData). Server accepts input only from a visible, live channel. */
  sendInput(surfaceId: string, data: string): void {
    this.sendInputBytes(surfaceId, TEXT_ENCODER.encode(data), false);
  }

  /** Raw bytes (xterm onBinary, §7.6 two-input). */
  sendBinary(surfaceId: string, bytes: Uint8Array): void {
    this.sendInputBytes(surfaceId, bytes, true);
  }

  private sendInputBytes(surfaceId: string, bytes: Uint8Array, binary: boolean): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !surface.visible) {
      return; // no visible surface to carry it
    }
    const socket = this.socket;
    if (surface.channelId === undefined || !socket || socket.readyState !== OPEN) {
      // The socket is still connecting/closing, the SUBSCRIBE_ACK for this
      // surface is still in flight, or a transport drop is mid-reconnect:
      // there is no open channel/transport pair that can carry this frame. A
      // user who focuses the terminal and starts typing immediately lands here
      // — buffer in order rather than dropping the keystroke; onSubscribeAck
      // flushes this queue the moment a channel opens (desk#46).
      this.bufferPendingInput(surface, bytes, binary);
      return;
    }
    this.sendFrame({ type: BpFrameType.INPUT, channelId: surface.channelId, binary, bytes });
  }

  /**
   * Queue input for a surface with no open channel, bounded so a stalled
   * SUBSCRIBE or a long reconnect can't accumulate forever. On overflow
   * (cumulative bytes over MAX_PENDING_INPUT_BYTES, or the oldest entry older
   * than MAX_PENDING_INPUT_AGE_MS) the whole stale queue is dropped and the
   * surface is told through the appropriate visible handler: protocol
   * PAYLOAD_TOO_LARGE for a byte overflow, or a local client error when the
   * queue expires. It never grows without bound or silently flushes ancient
   * keystrokes into whatever channel eventually opens. A single chunk that
   * alone exceeds the byte budget (an oversized paste) is dropped and never
   * buffered.
   */
  private bufferPendingInput(surface: BinarySurface, bytes: Uint8Array, binary: boolean): void {
    if (bytes.length === 0 || surface.pendingInputRejected) {
      return;
    }
    const now = Date.now();
    const pending = surface.pendingInput ?? [];
    const currentBytes = surface.pendingInputBytes ?? 0;
    const age = surface.pendingInputSince === undefined ? 0 : now - surface.pendingInputSince;
    const expired = pending.length > 0 && age >= MAX_PENDING_INPUT_AGE_MS;
    const oversizedChunk = bytes.length > MAX_PENDING_INPUT_BYTES;
    const byteOverflow = currentBytes + bytes.length > MAX_PENDING_INPUT_BYTES;
    if (oversizedChunk || expired || byteOverflow) {
      this.rejectPendingInput(surface, expired ? 'expired' : 'overflow');
      return;
    }
    if (!surface.pendingInput) {
      surface.pendingInputSince = now;
      surface.pendingInputTimer = setTimeout(() => {
        surface.pendingInputTimer = undefined;
        if (
          this.surfaces.get(surface.surfaceId) === surface &&
          surface.pendingInput?.length
        ) {
          this.rejectPendingInput(surface, 'expired');
        }
      }, MAX_PENDING_INPUT_AGE_MS);
    }
    (surface.pendingInput ??= []).push({ bytes, binary });
    surface.pendingInputBytes = currentBytes + bytes.length;
  }

  private rejectPendingInput(surface: BinarySurface, reason: 'overflow' | 'expired'): void {
    if (surface.pendingInputRejected) {
      return;
    }
    this.clearPendingInput(surface, false);
    surface.pendingInputRejected = true;
    if (reason === 'overflow') {
      surface.handlers.onError?.(BpError.PAYLOAD_TOO_LARGE);
    } else {
      surface.handlers.onClientError(PENDING_INPUT_EXPIRED_MESSAGE);
    }
  }

  private clearPendingInput(surface: BinarySurface, resetRejection = true): void {
    if (surface.pendingInputTimer) {
      clearTimeout(surface.pendingInputTimer);
      surface.pendingInputTimer = undefined;
    }
    surface.pendingInput = undefined;
    surface.pendingInputBytes = undefined;
    surface.pendingInputSince = undefined;
    if (resetRejection) {
      surface.pendingInputRejected = false;
    }
  }

  /** Flush input buffered while the channel was not yet open, in order. */
  private flushInput(surface: BinarySurface): void {
    const pending = surface.pendingInput;
    if (!pending || pending.length === 0 || surface.channelId === undefined) {
      return;
    }
    // The ACK is the consumption boundary, so enforce the age budget here too.
    // A lone key can otherwise sit past the limit with no later append to run
    // bufferPendingInput's age check, then be replayed merely because a very
    // late channel finally opened.
    if (
      surface.pendingInputSince !== undefined &&
      Date.now() - surface.pendingInputSince >= MAX_PENDING_INPUT_AGE_MS
    ) {
      this.clearPendingInput(surface);
      surface.handlers.onClientError(PENDING_INPUT_EXPIRED_MESSAGE);
      return;
    }
    this.clearPendingInput(surface);
    for (const { bytes, binary } of pending) {
      this.sendFrame({ type: BpFrameType.INPUT, channelId: surface.channelId, binary, bytes });
    }
  }

  sendResize(surfaceId: string, cols: number, rows: number): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    // A reveal measures the fitted terminal before it marks the broker surface
    // visible. Retain that measurement now; flushResize still prevents a hidden
    // surface from sending a resize to the server.
    surface.cols = cols;
    surface.rows = rows;
    // Record the latest size; flushResize sends it now if the channel is live,
    // else defers to ack/(re)connect so an initial resize during CONNECTING or
    // pre-ACK is never dropped.
    surface.pendingResize = { cols, rows };
    this.flushResize(surface);
  }

  private flushResize(surface: BinarySurface): void {
    if (!this.connected || !surface.visible || surface.channelId === undefined || !surface.pendingResize) {
      return;
    }
    const { cols, rows } = surface.pendingResize;
    surface.pendingResize = undefined;
    this.sendFrame({ type: BpFrameType.RESIZE, channelId: surface.channelId, rows, cols });
  }

  /** Manual retry from the per-cell Reconnect button. */
  forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already gone
      }
      this.socket = undefined;
    }
    this.connected = false;
    // Closing the transport invalidates every server-assigned channel
    // immediately. The old socket's eventual close callback is identity-fenced
    // and may never run, so clear the channel ids synchronously; pending input
    // deliberately survives forgetChannels and is flushed only after the new
    // SUBSCRIBE_ACK assigns a replacement channel.
    this.forgetChannels();
    // Clear `connecting` too: forceReconnect can fire while a socket is still
    // mid-CONNECTING (wake-from-sleep fans out online + visibilitychange +
    // pulse), and we just orphaned that socket above — its close handler bails
    // on the identity guard and never resets the flag, wedging every future
    // ensureConnection() on the early-return. Mirrors the string-JSON broker.
    this.connecting = false;
    if (this.surfaces.size > 0) {
      this.ensureConnection();
    }
  }

  /**
   * Re-arm the one shared connection when the environment suggests the bridge is
   * back: tab return, network online, or a recovered pulse. Armed once
   * (browser-only, lazily so module import in tests never touches window).
   */
  private armSelfHeal(): void {
    if (this.selfHealArmed) {
      return;
    }
    this.selfHealArmed = true;
    const heal = (): void => {
      if (!this.connected && this.surfaces.size > 0) {
        this.forceReconnect();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', heal);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          heal();
        }
      });
    }
    subscribeBridgeRetry(heal);
  }

  private ensureConnection(): void {
    this.armSelfHeal();
    if (this.socket || this.connecting || this.surfaces.size === 0) {
      return;
    }
    this.connecting = true;
    const socket = this.makeSocket(this.url ?? defaultUrl());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat(socket);
      this.resubscribeAll();
      this.notifyConnection(true);
    });
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleServerData(event.data);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.stopHeartbeat();
      this.socket = undefined;
      this.connecting = false;
      this.connected = false;
      this.forgetChannels(); // every channelId is dead until we resubscribe
      this.notifyConnection(false);
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // 'close' follows and drives reconnect; nothing extra here.
    });
  }

  /** Half-open watchdog: no frame within HEARTBEAT_TIMEOUT_MS ⇒ dead ⇒ reconnect. */
  private startHeartbeat(socket: BinaryBrokerSocket): void {
    this.lastFrameAt = Date.now();
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket === socket && this.connected && Date.now() - this.lastFrameAt >= HEARTBEAT_TIMEOUT_MS) {
        this.forceReconnect();
      }
    }, HEARTBEAT_TIMEOUT_MS / 2);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.surfaces.size === 0 || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempts >= RECONNECT_MAX) {
      return; // give up until forceReconnect; surfaces show the Reconnect button
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(8000, 1000 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnection();
    }, delay);
  }

  private resubscribeAll(): void {
    // A reconnect invalidated every channelId; drop stale mappings/pending acks
    // and re-subscribe each visible surface for a fresh channel + snapshot.
    this.forgetChannels();
    for (const surface of this.surfaces.values()) {
      if (surface.visible) {
        this.sendSubscribe(surface);
      }
    }
  }

  /** Send a SUBSCRIBE and enqueue the surface for FIFO ack pairing. */
  private sendSubscribe(surface: BinarySurface): void {
    surface.awaitingAck = true;
    this.pendingAcks.push(surface);
    this.sendFrame({
      type: BpFrameType.SUBSCRIBE,
      sessionId: surface.sessionId,
      surfaceId: surface.surfaceId,
      rows: surface.rows,
      cols: surface.cols
    });
  }

  /** UNSUBSCRIBE the surface's live channel (if any) and forget its channel state. */
  private closeChannel(surface: BinarySurface): void {
    if (surface.channelId !== undefined) {
      if (this.connected) {
        this.sendFrame({ type: BpFrameType.UNSUBSCRIBE, channelId: surface.channelId });
      }
      this.channelToSurface.delete(surface.channelId);
    }
    surface.channelId = undefined;
    surface.resync = undefined;
    // Input queued for the channel being closed belongs to that channel's
    // context (unsubscribe or resync) — never replay it into whatever
    // channel a future (re)subscribe opens.
    this.clearPendingInput(surface);
  }

  /** A gap / stale-baseline made this surface dirty: rebaseline via re-subscribe. */
  private triggerResync(surface: BinarySurface): void {
    this.closeChannel(surface);
    if (this.connected && surface.visible) {
      this.sendSubscribe(surface);
    }
  }

  private forgetChannels(): void {
    this.channelToSurface.clear();
    this.pendingAcks.length = 0;
    for (const surface of this.surfaces.values()) {
      surface.channelId = undefined;
      surface.resync = undefined;
      surface.awaitingAck = false;
      // The replacement socket may belong to a freshly restarted daemon whose
      // adopted emulator is back at its bootstrap geometry. Reassert the last
      // fitted browser size after the new SUBSCRIBE_ACK even when layout did
      // not change and TerminalSurface therefore emits no new resize.
      surface.pendingResize = { cols: surface.cols, rows: surface.rows };
      // Deliberately NOT clearing pendingInput here: this path runs when the
      // transport is reset (socket 'close' or forceReconnect), while the
      // surface itself remains live, visible, and bound to the same session.
      // A short reconnect blip must not eat what the user typed during it.
      // Continuity is bounded (bufferPendingInput's byte/age caps), so a
      // stalled reconnect still can't accumulate input forever; a deliberate
      // close (unsubscribe/resync) goes through closeChannel instead,
      // which does drop it — that context really is gone.
    }
  }

  private handleServerData(raw: unknown): void {
    // Any frame proves the socket is live — reset the half-open watchdog.
    this.lastFrameAt = Date.now();
    const bytes = toBytes(raw);
    if (!bytes) {
      return;
    }
    let frame: BpFrame;
    try {
      frame = decodeBpFrame(bytes);
    } catch {
      return; // malformed frame — ignore
    }
    switch (frame.type) {
      case BpFrameType.SUBSCRIBE_ACK:
        return this.onSubscribeAck(frame.channelId);
      case BpFrameType.SNAPSHOT:
        return this.onSnapshot(frame.channelId, frame);
      case BpFrameType.OUTPUT:
        return this.onOutput(frame.channelId, frame);
      case BpFrameType.GAP:
        return this.onGap(frame.channelId);
      case BpFrameType.EXIT:
        return this.onExit(frame.channelId, frame.outcome);
      case BpFrameType.HEARTBEAT:
        return; // liveness only; lastFrameAt already bumped
      case BpFrameType.ERROR:
        return this.onError(frame.channelId, frame.code);
      default:
        return; // QUERY_REQUEST etc. not handled by this client yet
    }
  }

  private onSubscribeAck(channelId: number): void {
    const surface = this.pendingAcks.shift();
    if (surface === undefined) {
      return; // stray ack with no outstanding subscribe
    }
    // The surface was actually removed or replaced while its ACK was in flight:
    // release the orphan. A merely hidden surface keeps this channel.
    if (this.surfaces.get(surface.surfaceId) !== surface) {
      if (this.connected) {
        this.sendFrame({ type: BpFrameType.UNSUBSCRIBE, channelId });
      }
      surface.awaitingAck = false;
      this.clearPendingInput(surface);
      return;
    }
    surface.channelId = channelId;
    surface.awaitingAck = false;
    surface.resync = new SubscriptionResync();
    this.channelToSurface.set(channelId, surface);
    if (!surface.visible) {
      this.clearPendingInput(surface);
      this.sendFrame({ type: BpFrameType.VISIBILITY, channelId, visible: false });
      return;
    }
    // A resize requested before the channel opened flushes now.
    this.flushResize(surface);
    // Keystrokes typed during the SUBSCRIBE round-trip flush now, in order.
    if (surface.pendingInputRejected) {
      this.clearPendingInput(surface);
    } else {
      this.flushInput(surface);
    }
  }

  private onSnapshot(channelId: number, frame: Extract<BpFrame, { type: BpFrameType.SNAPSHOT }>): void {
    const surface = this.surfaceOf(channelId);
    if (!surface || !surface.visible || !surface.resync) {
      return;
    }
    const action = surface.resync.onSnapshot({ generation: frame.generation, revision: frame.revision, offset: frame.offset, length: 0 });
    if (action === 'apply') {
      surface.handlers.onSnapshot(frame.text);
    }
  }

  private onOutput(channelId: number, frame: Extract<BpFrame, { type: BpFrameType.OUTPUT }>): void {
    const surface = this.surfaceOf(channelId);
    if (!surface || !surface.visible || !surface.resync) {
      return;
    }
    const action = surface.resync.onOutput({
      generation: frame.generation,
      revision: frame.revision,
      offset: frame.offset,
      length: frame.bytes.length
    });
    if (action === 'apply') {
      surface.handlers.onOutput(frame.bytes);
    } else if (action === 'dirty') {
      this.triggerResync(surface);
    }
  }

  private onGap(channelId: number): void {
    const surface = this.surfaceOf(channelId);
    if (!surface || !surface.visible || !surface.resync) {
      return;
    }
    if (surface.resync.onGap() === 'dirty') {
      this.triggerResync(surface);
    }
  }

  private onExit(channelId: number, outcome: MoorExitOutcome): void {
    this.surfaceOf(channelId)?.handlers.onExit?.(outcome);
  }

  private onError(channelId: number, code: number): void {
    // A connection-channel ERROR right after a SUBSCRIBE is that subscribe
    // failing (e.g. ghost session): pair it FIFO so the queue stays aligned.
    if (channelId === BP_CONN_CHANNEL) {
      const surface = this.pendingAcks.shift();
      if (surface !== undefined) {
        surface.awaitingAck = false;
        this.clearPendingInput(surface);
        if (this.surfaces.get(surface.surfaceId) === surface) {
          surface.handlers.onError?.(code);
        }
        return;
      }
      // No outstanding subscribe → a general connection error: tell everyone.
      for (const surface of this.surfaces.values()) {
        surface.handlers.onError?.(code);
      }
      return;
    }
    this.surfaceOf(channelId)?.handlers.onError?.(code);
  }

  private surfaceOf(channelId: number): BinarySurface | undefined {
    const surface = this.channelToSurface.get(channelId);
    return surface && this.surfaces.get(surface.surfaceId) === surface ? surface : undefined;
  }

  private notifyConnection(up: boolean): void {
    for (const surface of this.surfaces.values()) {
      surface.handlers.onConnectionChange?.(up);
    }
  }

  private sendFrame(frame: BpFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return;
    }
    try {
      socket.send(encodeBpFrame(frame));
    } catch {
      // send failed mid-teardown; the close handler reconnects
    }
  }

  private teardown(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.forgetChannels();
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }
}

function defaultUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/terminal`;
}

function defaultFactory(url: string): BinaryBrokerSocket {
  return new WebSocket(url) as unknown as BinaryBrokerSocket;
}

/** Normalize an incoming WS message payload to bytes (ArrayBuffer/typed array). */
function toBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return undefined; // string / Blob — this client requires binaryType 'arraybuffer'
}

/** Shared browser singleton — every TerminalSurface uses this one connection. */
export const binaryTerminalBroker = new BinaryTerminalBrokerClient();
