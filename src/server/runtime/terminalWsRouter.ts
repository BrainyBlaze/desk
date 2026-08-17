// Web-server ↔ daemon terminal WS router (spec §7.4). The web server's per-tab
// terminal WebSocket carries the binary browser protocol; this router relays it
// to the daemon session pipe (SessionManager) and back. It owns the WS-scoped
// channel ownership the daemon-level channelId map cannot: the daemon knows
// channelId→sessionId, the router knows channelId→WS, so INPUT is accepted ONLY
// from the connection that subscribed the channel (§7.4). channelIds are the
// daemon's global-monotonic allocations, so they route unambiguously even when
// one WS subscribes to multiple sessions.
//
// Transport-agnostic: a WsConn is any object with send(bytes); the web server
// adapts its real WebSocket to it. The SessionManager (daemon pipe) is injected.

import { GenerationLedger } from '../../shared/controlPlane/generationLedger.js';
import { WorkerSupervisor } from '../../shared/runtime/workerSupervisor.js';
import { type EmulatorFactory } from '../../shared/runtime/emulatorPort.js';
import { SessionManager, type SessionManagerDeps } from './sessionManager.js';
import { BP_CONN_CHANNEL, BpError, BpFrameType, decodeBpFrame, encodeBpFrame, type BpFrame } from '../../shared/browserProtocol/index.js';

/** A browser terminal connection — any object the web server can send bytes to. */
export interface WsConn {
  send(data: Uint8Array): void;
}

export interface TerminalWsRouterDeps {
  ledger: GenerationLedger;
  supervisor: WorkerSupervisor;
  emulatorFactory: EmulatorFactory;
  now: () => number;
  sessionGeometry?: SessionManagerDeps['sessionGeometry'];
  workingLeaseMs?: SessionManagerDeps['workingLeaseMs'];
  openToolLeaseMs?: SessionManagerDeps['openToolLeaseMs'];
  initialAgentHealth?: SessionManagerDeps['initialAgentHealth'];
  createAgentStateIntakeStore?: SessionManagerDeps['createAgentStateIntakeStore'];
  onStateTransition?: SessionManagerDeps['onStateTransition'];
  /** Production recovery cannot declare a late Moor adoption healthy before observation. */
  onLateMoorAdoption: NonNullable<SessionManagerDeps['onLateMoorAdoption']>;
}

export class TerminalWsRouter {
  private readonly manager: SessionManager;
  private readonly channelToWs = new Map<number, WsConn>();
  private readonly wsChannels = new Map<WsConn, Set<number>>();
  /** The WS whose SUBSCRIBE is in flight, so the synchronous ACK/SNAPSHOT reach it. */
  private pendingWs: WsConn | null = null;

  constructor(deps: TerminalWsRouterDeps) {
    this.manager = new SessionManager({
      ledger: deps.ledger,
      supervisor: deps.supervisor,
      emulatorFactory: deps.emulatorFactory,
      now: deps.now,
      onLateMoorAdoption: deps.onLateMoorAdoption,
      sendBrowser: (_sessionId, channelId, frame) => this.routeToWs(channelId, frame),
      onSubscriberFailure: (channelId) => {
        const ws = this.channelToWs.get(channelId);
        this.channelToWs.delete(channelId);
        if (ws !== undefined) this.wsChannels.get(ws)?.delete(channelId);
      },
      ...(deps.sessionGeometry !== undefined ? { sessionGeometry: deps.sessionGeometry } : {}),
      ...(deps.workingLeaseMs !== undefined ? { workingLeaseMs: deps.workingLeaseMs } : {}),
      ...(deps.openToolLeaseMs !== undefined
        ? { openToolLeaseMs: deps.openToolLeaseMs }
        : {}),
      ...(deps.initialAgentHealth !== undefined
        ? { initialAgentHealth: deps.initialAgentHealth }
        : {}),
      ...(deps.createAgentStateIntakeStore !== undefined
        ? { createAgentStateIntakeStore: deps.createAgentStateIntakeStore }
        : {}),
      ...(deps.onStateTransition !== undefined ? { onStateTransition: deps.onStateTransition } : {})
    });
  }

  /** The daemon session pipe — the web server drives lifecycle (spawnAndAttach/retire) through this. */
  get sessions(): SessionManager {
    return this.manager;
  }

  private routeToWs(channelId: number, frame: BpFrame): void {
    const ws = this.channelToWs.get(channelId) ?? this.pendingWs;
    ws?.send(encodeBpFrame(frame));
  }

  private channelsOf(ws: WsConn): Set<number> {
    let s = this.wsChannels.get(ws);
    if (s === undefined) {
      s = new Set<number>();
      this.wsChannels.set(ws, s);
    }
    return s;
  }

  /** Handle one binary frame from a browser WS. */
  onWsFrame(ws: WsConn, bytes: Uint8Array): void {
    let frame: BpFrame;
    try {
      frame = decodeBpFrame(bytes);
    } catch {
      return; // malformed frame — ignore (a hostile/old client)
    }
    switch (frame.type) {
      case BpFrameType.SUBSCRIBE: {
        this.pendingWs = ws; // the ACK + SNAPSHOT emit synchronously during subscribe
        const channelId = this.manager.subscribe(frame.sessionId, frame.surfaceId, frame.rows, frame.cols);
        this.pendingWs = null;
        if (channelId === undefined) {
          ws.send(encodeBpFrame({ type: BpFrameType.ERROR, channelId: BP_CONN_CHANNEL, code: BpError.BAD_CHANNEL }));
          return;
        }
        this.channelToWs.set(channelId, ws);
        this.channelsOf(ws).add(channelId);
        return;
      }
      case BpFrameType.INPUT: {
        if (!this.owns(ws, frame.channelId)) {
          ws.send(encodeBpFrame({ type: BpFrameType.ERROR, channelId: frame.channelId, code: BpError.BAD_CHANNEL }));
          return;
        }
        const errorCode = this.manager.dispatchBrowserInputByChannel(
          frame.channelId,
          frame.binary,
          frame.bytes
        );
        if (errorCode !== undefined) {
          ws.send(
            encodeBpFrame({
              type: BpFrameType.ERROR,
              channelId: frame.channelId,
              code: errorCode
            })
          );
        }
        return;
      }
      case BpFrameType.UNSUBSCRIBE: {
        if (this.owns(ws, frame.channelId)) this.dropChannel(ws, frame.channelId);
        return;
      }
      case BpFrameType.RESIZE: {
        if (this.ownOrReject(ws, frame.channelId)) this.manager.onBrowserResizeByChannel(frame.channelId, frame.rows, frame.cols);
        return;
      }
      case BpFrameType.VISIBILITY: {
        if (this.ownOrReject(ws, frame.channelId)) this.manager.onBrowserVisibilityByChannel(frame.channelId, frame.visible);
        return;
      }
      case BpFrameType.QUERY_REPLY: {
        if (this.ownOrReject(ws, frame.channelId)) this.manager.onBrowserQueryReplyByChannel(frame.channelId, frame.queryOffset, frame.leaseEpoch, frame.bytes);
        return;
      }
      default:
        // server→client frame types (or unknown) — a client must not send these.
        return;
    }
  }

  /** Ownership gate for a channel-scoped frame: true if owned, else reject + false. */
  private ownOrReject(ws: WsConn, channelId: number): boolean {
    if (this.owns(ws, channelId)) return true;
    ws.send(encodeBpFrame({ type: BpFrameType.ERROR, channelId, code: BpError.BAD_CHANNEL }));
    return false;
  }

  /**
   * Clean up all of a WS's channels when it closes (§7.4 lifecycle) — in BULK
   * (desk#68): the whole connection's channel set leaves before any resize
   * handoff election runs, so a dying sibling channel of this same connection
   * can never be transiently promoted and command the child through a surface
   * that is already gone.
   */
  onWsClose(ws: WsConn): void {
    const channels = [...this.channelsOf(ws)];
    this.manager.unsubscribeChannels(channels);
    for (const ch of channels) this.channelToWs.delete(ch);
    this.wsChannels.delete(ws);
  }

  private owns(ws: WsConn, channelId: number): boolean {
    return this.channelToWs.get(channelId) === ws;
  }

  private dropChannel(ws: WsConn, channelId: number): void {
    this.manager.unsubscribeChannel(channelId);
    this.channelToWs.delete(channelId);
    this.channelsOf(ws).delete(channelId);
  }
}
