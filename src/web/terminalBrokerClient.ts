/**
 * Browser-singleton terminal broker connection. One WebSocket per tab carries
 * every terminal surface's traffic, replacing the old
 * one-socket-per-cell model. Surfaces subscribe by a stable surfaceId; the
 * broker streams live `output` per session only while at least one surface for
 * that session is visible, and sends a self-contained `snapshot` to a surface
 * when it becomes visible. Hidden surfaces receive nothing, so a warm but
 * hidden cell costs no parse/render — that is what lets keep-alive cover all
 * groups without N background ANSI parsers.
 *
 * The client routes a session-level `output` frame to every CURRENTLY-VISIBLE
 * surface of that session, and a targeted `snapshot` frame to its one surface.
 */
import type {
  TerminalBrokerClientFrame,
  TerminalBrokerServerFrame
} from '../core/terminalBrokerProtocol.js';
import { subscribeBridgeRetry } from './terminalHeartbeat.js';

/** Minimal WebSocket surface so tests can inject a fake transport. */
export interface BrokerSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', handler: (event: any) => void): void;
}
export type BrokerSocketFactory = (url: string) => BrokerSocket;

export interface SurfaceHandlers {
  /** live output for this session; only invoked while this surface is visible */
  onOutput: (data: string) => void;
  /** self-contained current-screen snapshot on reveal; do terminal.reset() then write */
  onSnapshot: (data: string) => void;
  onExit?: (exitCode: number | null) => void;
  onError?: (message: string) => void;
  /** broker connection up/down — drives the per-cell reconnect UI */
  onConnectionChange?: (up: boolean) => void;
}

interface Surface {
  session: string;
  surfaceId: string;
  visible: boolean;
  handlers: SurfaceHandlers;
  /** Latest requested size that has not yet been sent (socket was connecting or
   * mid-reconnect). Flushed once the connection is (re)established so an initial
   * visible resize issued before the socket opened is never lost. */
  pendingResize?: { cols: number; rows: number };
}

const OPEN = 1;
const RECONNECT_MAX = 5;

export class TerminalBrokerClient {
  private socket: BrokerSocket | undefined;
  private readonly surfaces = new Map<string, Surface>(); // surfaceId -> surface
  private readonly bySession = new Map<string, Set<string>>(); // session -> surfaceIds
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private selfHealArmed = false;

  constructor(private readonly makeSocket: BrokerSocketFactory = defaultFactory, private readonly url?: string) {}

  subscribe(surfaceId: string, session: string, visible: boolean, handlers: SurfaceHandlers): void {
    const surface: Surface = { session, surfaceId, visible, handlers };
    this.surfaces.set(surfaceId, surface);
    let set = this.bySession.get(session);
    if (!set) {
      set = new Set();
      this.bySession.set(session, set);
    }
    set.add(surfaceId);
    this.ensureConnection();
    if (this.connected) {
      this.sendFrame({ type: 'subscribe', session, surfaceId, visible });
    }
    // When the socket opens later, resubscribeAll replays this with current state.
  }

  unsubscribe(surfaceId: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    this.surfaces.delete(surfaceId);
    const set = this.bySession.get(surface.session);
    if (set) {
      set.delete(surfaceId);
      if (set.size === 0) {
        this.bySession.delete(surface.session);
      }
    }
    if (this.connected) {
      this.sendFrame({ type: 'unsubscribe', session: surface.session, surfaceId });
    }
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
    if (this.connected) {
      this.sendFrame({ type: 'visibility', session: surface.session, surfaceId, visible });
      if (visible) {
        // A surface revealed before its pending resize landed flushes it now.
        this.flushResize(surface);
      }
    }
  }

  sendInput(surfaceId: string, data: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !surface.visible || !this.connected) {
      return; // server only accepts input from a visible, subscribed surface
    }
    this.sendFrame({ type: 'input', session: surface.session, surfaceId, data });
  }

  sendResize(surfaceId: string, cols: number, rows: number): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !surface.visible) {
      return; // server only accepts resize from a visible, subscribed surface
    }
    // Always record the latest size; flushResize sends it now if the socket is
    // open, or defers it to (re)connect/reveal otherwise. This is what stops an
    // initial resize issued during CONNECTING from being silently dropped.
    surface.pendingResize = { cols, rows };
    this.flushResize(surface);
  }

  private flushResize(surface: Surface): void {
    if (!this.connected || !surface.visible || !surface.pendingResize) {
      return;
    }
    const { cols, rows } = surface.pendingResize;
    surface.pendingResize = undefined;
    this.sendFrame({ type: 'resize', session: surface.session, surfaceId: surface.surfaceId, cols, rows });
  }

  /** Manual retry from the per-cell Reconnect button. */
  forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already gone
      }
      this.socket = undefined;
    }
    this.connected = false;
    if (this.surfaces.size > 0) {
      this.ensureConnection();
    }
  }

  /**
   * Re-arm the one shared connection when the environment suggests the bridge is
   * back: tab return, network online, or a pulse that just recovered. Armed once
   * (browser-only, lazily so module import in tests never touches window). One
   * reconnect for the whole tab, not one per cell — and only when actually down.
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
    // Resolve the URL lazily (browser-only) so constructing the module
    // singleton in a non-DOM context (tests) never touches `window`.
    const socket = this.makeSocket(this.url ?? defaultUrl());
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempts = 0;
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
      this.socket = undefined;
      this.connecting = false;
      this.connected = false;
      this.notifyConnection(false);
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // 'close' follows and drives reconnect; nothing extra to do here.
    });
  }

  private scheduleReconnect(): void {
    if (this.surfaces.size === 0 || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempts >= RECONNECT_MAX) {
      return; // give up until a forceReconnect; surfaces show the Reconnect button
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(8000, 1000 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnection();
    }, delay);
  }

  private resubscribeAll(): void {
    for (const surface of this.surfaces.values()) {
      this.sendFrame({ type: 'subscribe', session: surface.session, surfaceId: surface.surfaceId, visible: surface.visible });
      // Re-send any resize that was requested while disconnected, after the
      // subscribe (so the server already has the surface marked visible).
      this.flushResize(surface);
    }
  }

  private handleServerData(raw: unknown): void {
    let frame: TerminalBrokerServerFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as TerminalBrokerServerFrame;
    } catch {
      return; // ignore malformed server frame
    }
    switch (frame.type) {
      case 'ready':
        return;
      case 'output': {
        const ids = this.bySession.get(frame.session);
        if (!ids) {
          return;
        }
        for (const id of ids) {
          const surface = this.surfaces.get(id);
          if (surface?.visible) {
            surface.handlers.onOutput(frame.data);
          }
        }
        return;
      }
      case 'snapshot': {
        this.surfaces.get(frame.surfaceId)?.handlers.onSnapshot(frame.data);
        return;
      }
      case 'exit': {
        const ids = this.bySession.get(frame.session);
        if (ids) {
          for (const id of ids) {
            this.surfaces.get(id)?.handlers.onExit?.(frame.exitCode);
          }
        }
        return;
      }
      case 'error': {
        const ids = frame.session ? this.bySession.get(frame.session) : undefined;
        const targets = ids ? [...ids] : [...this.surfaces.keys()];
        for (const id of targets) {
          this.surfaces.get(id)?.handlers.onError?.(frame.message);
        }
        return;
      }
    }
  }

  private notifyConnection(up: boolean): void {
    for (const surface of this.surfaces.values()) {
      surface.handlers.onConnectionChange?.(up);
    }
  }

  private sendFrame(frame: TerminalBrokerClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // send failed mid-teardown; the close handler will reconnect
    }
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
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
  return `${protocol}//${window.location.host}/ws/terminal-broker`;
}

function defaultFactory(url: string): BrokerSocket {
  return new WebSocket(url) as unknown as BrokerSocket;
}

/** Shared browser singleton — every TerminalSurface uses this one connection. */
export const terminalBroker = new TerminalBrokerClient();
