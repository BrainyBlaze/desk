// SessionRuntime (spec §7.1) — the daemon's per-session data-plane and
// delivery-phase runtime. Agent state is owned only by DaemonCore's authority.
//
// Pure over injected ports/callbacks — no sockets/processes here — so the whole
// vertical (master frame → screen → browser frame; delivery acknowledgements →
// submit-confirmed) is unit-testable end-to-end. The daemon instantiates one per
// session with real adapters (a socket to the master, a WS to each surface, an
// @xterm/headless emulator, fsync'd control/delivery stores).
//
// Scope: the primary flows (output/resize/exit, subscribe/snapshot, input,
// delivery confirmation). Lease handoff (§7.9), checkpoint
// restore (§8.1), GAP-driven resync (§7.4), and native surfaces (§6.9) are
// documented extension points wired the same way.

import { BpFrameType, type BpFrame } from '../browserProtocol/index.js';
import { InMemoryCmdCache, type DeliveryTxn, applyDelivery } from '../delivery/index.js';
import { type EmulatorPort } from './emulatorPort.js';

export interface SessionRuntimeDeps {
  sessionId: string;
  generation: number;
  emulator: EmulatorPort;
  cmdCache: InMemoryCmdCache;
  now: () => number;
  /** Deliver a frame to one browser channel (surface WS). */
  sendBrowser: (channelId: number, frame: BpFrame) => void;
  /**
   * Typed master-bound operations. The runtime states WHAT the child must
   * receive; the session manager's installed link owns the wire encoding
   * (moor supervised frames), so no wire type leaks into the runtime.
   */
  sendMasterInput: (bytes: Uint8Array, binary: boolean, surfaceId: number) => void;
  sendMasterResize: (rows: number, cols: number, surfaceId: number) => void;
  onExit?: (exit: { code: number; signal: number }) => void;
}

interface Subscriber {
  surfaceId: string;
  rows: number;
  cols: number;
  visible: boolean;
}

export class SessionRuntime {
  private readonly d: SessionRuntimeDeps;
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly txns = new Map<string, DeliveryTxn>();
  private nextChannelId = 1;
  /** Byte high-water of output emitted (snapshot baseline offset, §7.4). */
  private outputOffset = 0n;
  /** Geometry revision; bumps on resize so stale-revision frames are discardable. */
  private revision = 0;

  constructor(deps: SessionRuntimeDeps) {
    this.d = deps;
  }

  // ---- master → daemon (data plane, §7.1) -----------------------------------
  /**
   * Restore connection-local terminal parser modes during ATTACH. These bytes are
   * not child PTY output: they do not advance outputOffset or fan out to browsers.
   */
  async applyTerminalState(preamble: Uint8Array): Promise<void> {
    this.d.emulator.write(preamble);
    await this.d.emulator.flush?.();
  }

  /** Authoritative-emulator cursor (0-based; the §8 CPR consumer maps to 1-based). */
  cursor(): { row: number; col: number } {
    return this.d.emulator.cursor();
  }

  /**
   * Fan a child-exit to every subscribed surface (cutover parity: the browser
   * receives an explicit EXIT push, not just an authority-snapshot change).
   * The moor event stream folds a signalled end into its exit code upstream,
   * so `signal` is 0 unless a caller can still distinguish one.
   */
  emitExit(code: number, signal = 0): void {
    for (const channelId of this.subscribers.keys()) {
      this.d.sendBrowser(channelId, { type: BpFrameType.EXIT, channelId, code, signal });
    }
  }

  /**
   * Moor-native child output (§6.1 OUTPUT): absolute byte offset + raw bytes.
   * Feeds the authoritative emulator and fans out to every subscribed surface.
   */
  onMoorOutput(bytes: Uint8Array, offset: bigint): void {
    this.d.emulator.write(bytes);
    this.outputOffset = offset + BigInt(bytes.length);
    for (const channelId of this.subscribers.keys()) {
      this.d.sendBrowser(channelId, {
        type: BpFrameType.OUTPUT,
        channelId,
        generation: this.d.generation,
        revision: this.revision,
        offset,
        bytes
      });
    }
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

  /** Forward browser input to the master (§7.6, two channels). */
  onBrowserInput(channelId: number, binary: boolean, bytes: Uint8Array): void {
    this.d.sendMasterInput(bytes, binary, channelId);
  }

  /**
   * Control-plane input injection (channels delivery, not a browser surface):
   * an INPUT frame under the reserved surface id 0 — browser channelIds are
   * allocated from 1, so 0 can never collide with a subscriber. With `paste`,
   * mirrors legacy paste semantics: wrap in bracketed-paste codes ONLY when the
   * app enabled the mode (DECSET 2004), so multi-line text does not submit per
   * newline in a TUI, while a plain shell never sees stray escape codes.
   */
  injectInput(bytes: Uint8Array, paste = false): void {
    let data = bytes;
    if (paste && this.d.emulator.bracketedPaste?.() === true) {
      const open = new TextEncoder().encode('\x1b[200~');
      const close = new TextEncoder().encode('\x1b[201~');
      data = new Uint8Array(open.length + bytes.length + close.length);
      data.set(open, 0);
      data.set(bytes, open.length);
      data.set(close, open.length + bytes.length);
    }
    this.d.sendMasterInput(data, false, 0);
  }

  /**
   * The last `rows` on-screen lines as plain text (the pane-capture equivalent
   * for channels submit-verify): the authoritative emulator's tail, never
   * escape sequences.
   */
  tailText(rows: number): string[] {
    return this.d.emulator.readTailText(rows);
  }

  /**
   * Ranged history (frozen-scrollback reads). Degrades honestly on an
   * emulator without history: offset 0 serves the live tail, anything deeper
   * is empty — the same shape a fully-scrolled-back reader sees.
   */
  historyText(rows: number, offset: number): { lines: string[]; totalAvailable: number } {
    if (this.d.emulator.readHistoryText) {
      return this.d.emulator.readHistoryText(rows, offset);
    }
    const lines = offset === 0 ? this.d.emulator.readTailText(rows) : [];
    return { lines, totalAvailable: this.d.emulator.readTailText(Number.MAX_SAFE_INTEGER).length };
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
    // Geometry is controller-owned: bump the revision locally (the moor holder
    // never echoes geometry back; the legacy echo path may still overwrite
    // this with its own counter until it is removed with the old runtime).
    this.revision += 1;
    this.d.sendMasterResize(rows, cols, channelId);
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

  // ---- delivery (§6.10) -----------------------------------------------------
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

  confirmDelivery(txnId: string): void {
    const txn = this.txns.get(txnId);
    if (txn !== undefined) {
      applyDelivery(txn, { kind: 'confirm', marked: true }, this.d.now());
    }
  }

  /** No semantic evidence in the window → hold as semantic-unknown (§6.10). */
  onSemanticWindowElapsed(txnId: string): void {
    const txn = this.txns.get(txnId);
    if (txn !== undefined) applyDelivery(txn, { kind: 'semantic-window-elapsed' }, this.d.now());
  }

  txnPhase(txnId: string): DeliveryTxn | undefined {
    return this.txns.get(txnId);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
