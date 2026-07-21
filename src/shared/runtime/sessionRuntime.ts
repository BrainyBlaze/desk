// SessionRuntime (spec §7.1) — the daemon's per-session data-plane + control-plane
// orchestrator. Composes the five pure layers: the atch wire codec (master I/O),
// the emulator port (authoritative screen), the browser protocol (loss-aware WS),
// the control plane (source-tagged lifecycle), and the delivery-phase engine.
//
// Pure over injected ports/callbacks — no sockets/processes here — so the whole
// vertical (master frame → screen → browser frame; typed hook → state →
// submit-confirmed) is unit-testable end-to-end. The daemon instantiates one per
// session with real adapters (a socket to the master, a WS to each surface, an
// @xterm/headless emulator, fsync'd control/delivery stores).
//
// Scope: the primary flows (output/resize/exit, subscribe/snapshot, input,
// hook-driven state + delivery confirmation). Lease handoff (§7.9), checkpoint
// restore (§8.1), GAP-driven resync (§7.4), and native surfaces (§6.9) are
// documented extension points wired the same way.

import { ByteReader, type RawFrame } from '../atchWire/codec.js';
import { EventType, FrameType, RecordType } from '../atchWire/frames.js';
import { type RecordEnvelope, encodeBody } from '../atchWire/messages.js';
import { BpFrameType, type BpFrame } from '../browserProtocol/index.js';
import {
  InMemoryIntakeStore,
  type ControlState,
  type IntakeResult,
  type SessionModel,
  type Source,
  applySessionEvent,
  createSessionModel,
  intake,
  refreshSessionState
} from '../controlPlane/index.js';
import { InMemoryCmdCache, type DeliveryTxn, applyDelivery } from '../delivery/index.js';
import { type EmulatorPort } from './emulatorPort.js';

/** A typed hook / native command-result the daemon's HTTP intake forwards (§3.6). */
export interface HookInput {
  source: Source;
  /** The producer-carried spawn generation (§6.3), for the fence. */
  carriedGeneration: number;
  invocationId: string;
  state: ControlState;
  /** The embedded delivery correlation marker (§6.10), when this is a submit hook. */
  txnId?: string;
}

export interface SessionRuntimeDeps {
  sessionId: string;
  generation: number;
  emulator: EmulatorPort;
  /** Control-plane intake store; its ledger is set to `generation` for this session. */
  intakeStore: InMemoryIntakeStore;
  cmdCache: InMemoryCmdCache;
  now: () => number;
  /** Deliver a frame to one browser channel (surface WS). */
  sendBrowser: (channelId: number, frame: BpFrame) => void;
  /** Send a frame to the atch master (INPUT/COMMAND/etc.). */
  sendMaster: (frame: RawFrame) => void;
}

interface Subscriber {
  surfaceId: string;
  rows: number;
  cols: number;
  visible: boolean;
}

export class SessionRuntime {
  private readonly d: SessionRuntimeDeps;
  private readonly model: SessionModel;
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly txns = new Map<string, DeliveryTxn>();
  private nextChannelId = 1;
  /** Byte high-water of output emitted (snapshot baseline offset, §7.4). */
  private outputOffset = 0n;
  /** Geometry revision; bumps on resize so stale-revision frames are discardable. */
  private revision = 0;

  constructor(deps: SessionRuntimeDeps) {
    this.d = deps;
    this.d.intakeStore.setGeneration(deps.sessionId, deps.generation);
    this.model = createSessionModel(deps.sessionId, deps.generation, deps.now());
  }

  // ---- master → daemon (data plane, §7.1) -----------------------------------
  /** Route one decoded RECORD envelope from the master. */
  onMasterRecord(rec: RecordEnvelope): void {
    switch (rec.record_type) {
      case RecordType.OUTPUT:
        return this.onOutput(rec);
      case RecordType.RESIZE:
        return this.onResize(rec);
      case RecordType.EVENT:
        return this.onEvent(rec);
      default:
        return; // CHECKPOINT_MARK / TRUNCATION handled by the recovery path (§8)
    }
  }

  private onOutput(rec: RecordEnvelope): void {
    this.d.emulator.write(rec.body);
    this.outputOffset = rec.output_offset + BigInt(rec.body.length);
    for (const channelId of this.subscribers.keys()) {
      this.d.sendBrowser(channelId, {
        type: BpFrameType.OUTPUT,
        channelId,
        generation: this.d.generation,
        revision: this.revision,
        offset: rec.output_offset,
        bytes: rec.body
      });
    }
  }

  private onResize(rec: RecordEnvelope): void {
    const r = new ByteReader(rec.body);
    const rows = r.u16();
    const cols = r.u16();
    const geometryRev = r.u32();
    this.d.emulator.resize(rows, cols);
    this.revision = geometryRev;
    // Subscribers pick up the new geometry via their next snapshot (§7.4:
    // geometry-before-snapshot); a dedicated resize push is an easy extension.
  }

  private onEvent(rec: RecordEnvelope): void {
    const r = new ByteReader(rec.body);
    const eventType = r.u8();
    if (eventType === EventType.EXIT) {
      const code = r.u32() | 0; // signed i32
      const signal = r.u16();
      for (const channelId of this.subscribers.keys()) {
        this.d.sendBrowser(channelId, { type: BpFrameType.EXIT, channelId, code, signal });
      }
    }
    // START/SIGNAL/GAP/CONTROLLER/RECOVERY_LOST → control-plane / GAP frames
    // (same routing shape); attention (BEL/OSC9) arrives via emulator.onEvent.
  }

  // ---- browser → daemon (§7.4/§7.6) -----------------------------------------
  /**
   * Subscribe a surface: assign a channelId, ACK it, and emit the baseline
   * SNAPSHOT at the current output offset (§7.4). Returns the channelId.
   */
  subscribe(surfaceId: string, rows: number, cols: number, assignedChannelId?: number): number {
    // The daemon allocates a GLOBALLY-unique channelId (so frames that carry only
    // channelId route unambiguously); fall back to a local counter when called
    // directly (e.g. unit tests).
    const channelId = assignedChannelId ?? this.nextChannelId++;
    this.subscribers.set(channelId, { surfaceId, rows, cols, visible: true });
    this.d.sendBrowser(channelId, {
      type: BpFrameType.SUBSCRIBE_ACK,
      channelId,
      generation: this.d.generation,
      revision: this.revision
    });
    this.d.sendBrowser(channelId, {
      type: BpFrameType.SNAPSHOT,
      channelId,
      generation: this.d.generation,
      revision: this.revision,
      offset: this.outputOffset,
      text: this.d.emulator.serialize()
    });
    return channelId;
  }

  unsubscribe(channelId: number): void {
    this.subscribers.delete(channelId);
  }

  /** Forward browser input to the master as an INPUT frame (§7.6, two channels). */
  onBrowserInput(channelId: number, binary: boolean, bytes: Uint8Array): void {
    const payload = encodeBody(FrameType.INPUT, { flags: binary ? 1 : 0, surface_id: channelId, bytes });
    this.d.sendMaster({ type: FrameType.INPUT, flags: 0, generation: this.d.generation, sequence: 0n, aux: 0n, payload });
  }

  /**
   * Browser-initiated resize (§7.5): resize the authoritative emulator and tell
   * the master to resize the PTY. Lease enforcement (only the owning surface may
   * resize) is the §7.5 refinement layered above; here the frame carries the
   * session generation so the master's fence accepts it.
   */
  onBrowserResize(channelId: number, rows: number, cols: number): void {
    const sub = this.subscribers.get(channelId);
    if (sub !== undefined) {
      sub.rows = rows;
      sub.cols = cols;
    }
    this.d.emulator.resize(rows, cols);
    const payload = encodeBody(FrameType.RESIZE, { lease_epoch: 0, surface_id: channelId, generation: this.d.generation, rows, cols });
    this.d.sendMaster({ type: FrameType.RESIZE, flags: 0, generation: this.d.generation, sequence: 0n, aux: 0n, payload });
  }

  /** Browser surface visibility (§3.3/§7.4) — drives worker residency + lease candidacy. */
  onBrowserVisibility(channelId: number, visible: boolean): void {
    const sub = this.subscribers.get(channelId);
    if (sub !== undefined) sub.visible = visible;
  }

  /**
   * A surface's reply to a query_request (§7.7, pixel/color/focus). The full
   * TERMINAL_REPLY routing lands with the query_request path; until the daemon
   * issues query_requests, an inbound QUERY_REPLY is uncorrelated and dropped
   * FAIL-CLOSED (never injected as input, never a fabricated reply).
   */
  onBrowserQueryReply(_channelId: number, _queryOffset: bigint, _leaseEpoch: number, _bytes: Uint8Array): void {
    // no outstanding query_request to correlate → drop (§7.7 fail-closed).
  }

  // ---- control plane + delivery (§6/§6.10) ----------------------------------
  /**
   * Ingest a typed hook / native command-result: fence + stamp via the control
   * plane, fold it into the session state, and — if it carries a delivery marker
   * — advance that txn to submit-confirmed (a MARKED, authoritative confirm).
   * Returns the intake result so the daemon can ACK the producer idempotently.
   */
  ingestHook(hook: HookInput): IntakeResult {
    const res = intake(
      {
        sessionId: this.d.sessionId,
        carriedGeneration: hook.carriedGeneration,
        source: hook.source,
        invocationId: hook.invocationId,
        state: hook.state,
        ts: this.d.now()
      },
      this.d.intakeStore
    );
    if (res.kind === 'rejected') return res; // fenced — stale generation
    applySessionEvent(this.model, res.event, this.d.now());
    if (hook.txnId !== undefined) {
      const txn = this.txns.get(hook.txnId);
      if (txn !== undefined) applyDelivery(txn, { kind: 'confirm', marked: true }, this.d.now());
    }
    return res;
  }

  /** Open a delivery txn (queued). bodyKey/submitKey are its CMD_CACHE step keys. */
  openTxn(txnId: string, bodyKey: string, submitKey: string): DeliveryTxn {
    const txn: DeliveryTxn = {
      txnId,
      sessionId: this.d.sessionId,
      generation: this.d.generation,
      bodyKey,
      submitKey,
      phase: 'queued',
      phaseSince: this.d.now()
    };
    this.txns.set(txnId, txn);
    this.d.cmdCache.prepare(this.d.sessionId, this.d.generation, bodyKey, txnId, 'body', this.d.now());
    return txn;
  }

  onBodyAck(txnId: string, result?: string): void {
    const txn = this.txns.get(txnId);
    if (txn === undefined) return;
    this.d.cmdCache.markAcked(this.d.sessionId, this.d.generation, txn.bodyKey, result);
    applyDelivery(txn, { kind: 'body-ack' }, this.d.now());
    this.d.cmdCache.prepare(this.d.sessionId, this.d.generation, txn.submitKey, txnId, 'submit', this.d.now());
  }

  onSubmitAck(txnId: string, result?: string): void {
    const txn = this.txns.get(txnId);
    if (txn === undefined) return;
    this.d.cmdCache.markAcked(this.d.sessionId, this.d.generation, txn.submitKey, result);
    applyDelivery(txn, { kind: 'submit-ack' }, this.d.now());
  }

  /** No semantic evidence in the window → hold as semantic-unknown (§6.10). */
  onSemanticWindowElapsed(txnId: string): void {
    const txn = this.txns.get(txnId);
    if (txn !== undefined) applyDelivery(txn, { kind: 'semantic-window-elapsed' }, this.d.now());
  }

  // ---- projections (§6.7) ---------------------------------------------------
  /** Re-resolve staleness and return the current control-plane state. */
  currentState(): { state: ControlState; source: Source; generation: number } {
    refreshSessionState(this.model, this.d.now());
    return { state: this.model.state, source: this.model.source, generation: this.model.generation };
  }

  txnPhase(txnId: string): DeliveryTxn | undefined {
    return this.txns.get(txnId);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
