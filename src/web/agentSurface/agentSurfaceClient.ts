/**
 * Browser-singleton agent-surface broker connection. One WebSocket per tab carries
 * every native UI surface's traffic, mirroring the terminalBrokerClient shape.
 *
 * Surfaces subscribe by a stable surfaceId; the broker streams live `event` per
 * session only while at least one surface for that session is visible, and sends a
 * self-contained `snapshot` (committed-event ring + current FSM state + lastSeq) on
 * subscribe/reconnect. Hidden surfaces receive committed events but not deltas — a
 * warm but hidden cell costs no parse/render of streaming tokens.
 */
import type {
  AgentUiClientFrame,
  AgentUiServerFrame,
  AgentSurfaceEvent,
  AgentSurfaceState
} from '../../core/agentSurfaceProtocol.js';

/** Minimal WebSocket surface so tests can inject a fake transport. */
export interface AgentSurfaceSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', handler: (event: { data?: unknown }) => void): void;
}

export type AgentSurfaceSocketFactory = (url: string) => AgentSurfaceSocket;

export interface SurfaceHandlers {
  onSnapshot(data: { state: AgentSurfaceState; lastSeq: number; events: AgentSurfaceEvent[] }): void;
  onEvent(event: AgentSurfaceEvent): void;
  onError?(code: string, message: string): void;
  onExit?(reason: 'killed' | 'crashed' | 'mode-switched'): void;
  onConnectionChange?(up: boolean): void;
}

interface Surface {
  session: string;
  surfaceId: string;
  visible: boolean;
  handlers: SurfaceHandlers;
}

const OPEN = 1;
// Unbounded backoff with a 30s cap — mirrors the host runner's post-hello policy
// (claude Phase 4 G1 arbitration: symmetry with the server-restart persistence story
// we proved live on the host side). The Retry button in NativeAgentSurface is the
// operator escape hatch; we never silently give up.
const RECONNECT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
const RECONNECT_INITIAL_BACKOFF_MS = 250;
const RECONNECT_MAX_BACKOFF_MS = 30_000;

/** Resolve the WS base URL lazily so importing this module in a non-DOM context (tests)
 *  does not crash on `location` being undefined. terminalBrokerClient uses the same trick. */
function defaultBaseUrl(): string {
  if (typeof location !== 'undefined') {
    return `ws://${location.host}`;
  }
  return 'ws://127.0.0.1:5173';
}

export class AgentSurfaceClient {
  private socket: AgentSurfaceSocket | undefined;
  private readonly surfaces = new Map<string, Surface>(); // surfaceId -> surface
  private readonly bySession = new Map<string, Set<string>>(); // session -> surfaceIds
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;

  constructor(
    private readonly makeSocket: AgentSurfaceSocketFactory = defaultFactory,
    private readonly baseUrl: string = defaultBaseUrl()
  ) {}

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
  }

  setVisibility(surfaceId: string, visible: boolean): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    if (surface.visible === visible) {
      return;
    }
    surface.visible = visible;
    if (this.connected) {
      this.sendFrame({ type: 'visibility', session: surface.session, surfaceId, visible });
    }
  }

  unsubscribe(surfaceId: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return;
    }
    this.surfaces.delete(surfaceId);
    const set = this.bySession.get(surface.session);
    set?.delete(surfaceId);
    if (set && set.size === 0) {
      this.bySession.delete(surface.session);
    }
    if (this.connected) {
      this.sendFrame({ type: 'unsubscribe', session: surface.session, surfaceId });
    }
    if (this.surfaces.size === 0) {
      this.closeSocket();
    }
  }

  send(surfaceId: string, session: string, text: string): void {
    if (!this.connected) {
      throw new Error('agent-surface broker not connected');
    }
    this.sendFrame({ type: 'send', session, surfaceId, text });
  }

  respondPermission(surfaceId: string, session: string, requestId: string, optionId: string, note?: string): void {
    if (!this.connected) {
      throw new Error('agent-surface broker not connected');
    }
    this.sendFrame({ type: 'respond-permission', session, surfaceId, requestId, optionId, note });
  }

  interrupt(surfaceId: string, session: string): void {
    if (!this.connected) {
      throw new Error('agent-surface broker not connected');
    }
    this.sendFrame({ type: 'interrupt', session, surfaceId });
  }

  forceReconnect(): void {
    this.closeSocket();
    this.reconnectAttempts = 0;
    this.ensureConnection();
  }

  /** Snapshot for tests. */
  get isConnected(): boolean {
    return this.connected;
  }

  private ensureConnection(): void {
    if (this.socket || this.connecting) {
      return;
    }
    this.connecting = true;
    const socket = this.makeSocket(`${this.baseUrl}/ws/agent-ui`);
    this.socket = socket;
    // Capture socket locally; every handler checks `this.socket !== socket` so a stale
    // socket that fires open/message/close AFTER forceReconnect or closeSocket replaced
    // it cannot corrupt the current connection state (codex Phase 4 G1 fix, mirroring
    // terminalBrokerClient's pattern at line ~205).
    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.resubscribeAll();
      for (const surface of this.surfaces.values()) {
        surface.handlers.onConnectionChange?.(true);
      }
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) {
        return;
      }
      if (!event.data) return;
      let frame: AgentUiServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as AgentUiServerFrame;
      } catch {
        console.error('agent-surface: dropping malformed broker frame', String(event.data).slice(0, 200));
        return;
      }
      this.handleServerFrame(frame);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connecting = false;
      this.connected = false;
      this.socket = undefined;
      for (const surface of this.surfaces.values()) {
        surface.handlers.onConnectionChange?.(false);
      }
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // 'close' follows and drives reconnect; nothing extra to do here.
    });
  }

  private scheduleReconnect(): void {
    if (this.surfaces.size === 0) {
      return;
    }
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      return;
    }
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      RECONNECT_MAX_BACKOFF_MS,
      RECONNECT_INITIAL_BACKOFF_MS * 2 ** Math.min(this.reconnectAttempts - 1, 20)
    );
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.socket = undefined;
      this.ensureConnection();
    }, backoff);
  }

  private closeSocket(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // best-effort
      }
      this.socket = undefined;
    }
    this.connected = false;
    this.connecting = false;
  }

  private resubscribeAll(): void {
    for (const surface of this.surfaces.values()) {
      this.sendFrame({ type: 'subscribe', session: surface.session, surfaceId: surface.surfaceId, visible: surface.visible });
    }
  }

  private sendFrame(frame: AgentUiClientFrame): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // best-effort
    }
  }

  private handleServerFrame(frame: AgentUiServerFrame): void {
    switch (frame.type) {
      case 'ready':
        return;
      case 'snapshot': {
        const set = this.bySession.get(frame.session);
        if (!set) return;
        for (const surfaceId of set) {
          const surface = this.surfaces.get(surfaceId);
          surface?.handlers.onSnapshot({ state: frame.state, lastSeq: frame.lastSeq, events: frame.events });
        }
        return;
      }
      case 'event': {
        const set = this.bySession.get(frame.session);
        if (!set) return;
        for (const surfaceId of set) {
          const surface = this.surfaces.get(surfaceId);
          surface?.handlers.onEvent(frame.event);
        }
        return;
      }
      case 'error': {
        if (frame.session) {
          const set = this.bySession.get(frame.session);
          if (set) {
            for (const surfaceId of set) {
              const surface = this.surfaces.get(surfaceId);
              surface?.handlers.onError?.(frame.code, frame.message);
            }
          }
        } else {
          for (const surface of this.surfaces.values()) {
            surface.handlers.onError?.(frame.code, frame.message);
          }
        }
        return;
      }
      case 'exit': {
        const set = this.bySession.get(frame.session);
        if (!set) return;
        for (const surfaceId of set) {
          const surface = this.surfaces.get(surfaceId);
          surface?.handlers.onExit?.(frame.reason);
        }
        return;
      }
    }
  }
}

function defaultFactory(url: string): AgentSurfaceSocket {
  return new WebSocket(url) as unknown as AgentSurfaceSocket;
}

/** Shared browser singleton — every NativeAgentSurface uses this one connection. */
export const agentSurfaceClient = new AgentSurfaceClient();
