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
 *  - There is no client "request snapshot" frame. Both a resync (gap → dirty)
 *    and a reveal (hidden → visible) reduce to "get a fresh baseline", which the
 *    server's existing subscribe path already emits. So visibility rides the
 *    subscribe/unsubscribe lifecycle — hidden = unsubscribed (no channel, no
 *    output: the zero-cost keep-alive win), revealed/dirty = (re)subscribed —
 *    and the frozen protocol needs no snapshot verb.
 */
import {
  BP_CONN_CHANNEL,
  BpFrameType,
  BpInputFlag,
  decodeBpFrame,
  encodeBpFrame,
  SubscriptionResync,
  type BpFrame
} from '../shared/browserProtocol/index.js';
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
  onExit?: (code: number, signal: number) => void;
  /** Protocol-level error for this surface (a BpError code). */
  onError?: (code: number) => void;
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
}

const OPEN = 1;
const RECONNECT_MAX = 5;
// If no frame of any type arrives within this window the socket is treated as
// dead (a half-open TCP still reports OPEN). The server beacons periodically, so
// two missed beacons = dead. Mirrors the string-JSON broker's watchdog.
const HEARTBEAT_TIMEOUT_MS = 30_000;

const TEXT_ENCODER = new TextEncoder();

export class BinaryTerminalBrokerClient {
  private socket: BinaryBrokerSocket | undefined;
  private readonly surfaces = new Map<string, BinarySurface>(); // surfaceId -> surface
  private readonly channelToSurface = new Map<number, string>(); // channelId -> surfaceId
  /** Surfaces whose SUBSCRIBE is outstanding, in send order (FIFO ack pairing). */
  private readonly pendingAcks: string[] = [];
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
    if (!this.connected) {
      return; // resubscribeAll on reconnect honors the current visibility
    }
    if (visible) {
      // Reveal: (re)subscribe to get a fresh snapshot + resume live output.
      if (surface.channelId === undefined && !surface.awaitingAck) {
        this.sendSubscribe(surface);
      }
    } else {
      // Hide: drop the channel so the server stops streaming to this cell.
      this.closeChannel(surface);
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
    if (!surface || !surface.visible || !this.connected || surface.channelId === undefined) {
      return; // no live, visible channel to carry it
    }
    this.sendFrame({ type: BpFrameType.INPUT, channelId: surface.channelId, binary, bytes });
  }

  sendResize(surfaceId: string, cols: number, rows: number): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !surface.visible) {
      return; // server accepts resize only from a visible surface
    }
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
    this.pendingAcks.push(surface.surfaceId);
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
        return this.onExit(frame.channelId, frame.code, frame.signal);
      case BpFrameType.HEARTBEAT:
        return; // liveness only; lastFrameAt already bumped
      case BpFrameType.ERROR:
        return this.onError(frame.channelId, frame.code);
      default:
        return; // QUERY_REQUEST etc. not handled by this client yet
    }
  }

  private onSubscribeAck(channelId: number): void {
    const surfaceId = this.pendingAcks.shift();
    if (surfaceId === undefined) {
      return; // stray ack with no outstanding subscribe
    }
    const surface = this.surfaces.get(surfaceId);
    // The surface was unsubscribed (or hidden) while its ACK was in flight: we
    // now own a channel with no live consumer — release it server-side.
    if (!surface || !surface.visible) {
      if (this.connected) {
        this.sendFrame({ type: BpFrameType.UNSUBSCRIBE, channelId });
      }
      return;
    }
    surface.channelId = channelId;
    surface.awaitingAck = false;
    surface.resync = new SubscriptionResync();
    this.channelToSurface.set(channelId, surfaceId);
    // A resize requested before the channel opened flushes now.
    this.flushResize(surface);
  }

  private onSnapshot(channelId: number, frame: Extract<BpFrame, { type: BpFrameType.SNAPSHOT }>): void {
    const surface = this.channelToSurface.get(channelId) && this.surfaces.get(this.channelToSurface.get(channelId)!);
    if (!surface || !surface.resync) {
      return;
    }
    const action = surface.resync.onSnapshot({ generation: frame.generation, revision: frame.revision, offset: frame.offset, length: 0 });
    if (action === 'apply') {
      surface.handlers.onSnapshot(frame.text);
    }
  }

  private onOutput(channelId: number, frame: Extract<BpFrame, { type: BpFrameType.OUTPUT }>): void {
    const surface = this.surfaceOf(channelId);
    if (!surface || !surface.resync) {
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
    if (!surface || !surface.resync) {
      return;
    }
    if (surface.resync.onGap() === 'dirty') {
      this.triggerResync(surface);
    }
  }

  private onExit(channelId: number, code: number, signal: number): void {
    this.surfaceOf(channelId)?.handlers.onExit?.(code, signal);
  }

  private onError(channelId: number, code: number): void {
    // A connection-channel ERROR right after a SUBSCRIBE is that subscribe
    // failing (e.g. ghost session): pair it FIFO so the queue stays aligned.
    if (channelId === BP_CONN_CHANNEL) {
      const surfaceId = this.pendingAcks.shift();
      if (surfaceId !== undefined) {
        const surface = this.surfaces.get(surfaceId);
        if (surface) {
          surface.awaitingAck = false;
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
    const surfaceId = this.channelToSurface.get(channelId);
    return surfaceId === undefined ? undefined : this.surfaces.get(surfaceId);
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
