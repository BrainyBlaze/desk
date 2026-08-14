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
  onSubscriberFailure?: (channelId: number) => void;
  /**
   * Typed master-bound operations. The runtime states WHAT the child must
   * receive; the session manager's installed link owns the wire encoding
   * (moor supervised frames), so no wire type leaks into the runtime.
   */
  sendMasterInput: (bytes: Uint8Array, binary: boolean, surfaceId: number) => boolean | void;
  sendMasterResize: (rows: number, cols: number, surfaceId: number) => void;
  onExit?: (exit: { code: number; signal: number }) => void;
}

interface Subscriber {
  surfaceId: string;
  rows: number;
  cols: number;
  visible: boolean;
  ready: boolean;
  activation?: Promise<void>;
}

interface OutputDelivery {
  offset: bigint;
  bytes: Uint8Array;
  promise: Promise<void>;
}

interface TerminalStateDelivery {
  bytes: Uint8Array;
  promise: Promise<void>;
}

interface PendingExit {
  code: number;
  signal: number;
  outputEnd: bigint;
  promise: Promise<void>;
  resolve: () => void;
}

export class SessionRuntime {
  private readonly d: SessionRuntimeDeps;
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly txns = new Map<string, DeliveryTxn>();
  private nextChannelId = 1;
  /** Byte high-water of output emitted (snapshot baseline offset, §7.4). */
  private outputOffset = 0n;
  /** Session-scoped Moor delivery frontier; survives individual client attempts. */
  private outputDelivery: OutputDelivery | undefined;
  /** All emulator work shares one session frontier, including attach preambles. */
  private authoritativeWork: Promise<void> | undefined;
  private terminalStateDelivery: TerminalStateDelivery | undefined;
  private exitFenced = false;
  private exitDelivery: Promise<void> | undefined;
  private pendingExit: PendingExit | undefined;
  private disposed = false;
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
  applyTerminalState(preamble: Uint8Array): void | Promise<void> {
    if (this.disposed) return;
    const pendingPreamble = this.terminalStateDelivery;
    if (pendingPreamble !== undefined) {
      if (!this.sameBytes(pendingPreamble.bytes, preamble)) {
        return pendingPreamble.promise.then(() => this.applyTerminalState(preamble));
      }
      return pendingPreamble.promise;
    }
    const pendingWork = this.authoritativeWork;
    if (pendingWork !== undefined) {
      return pendingWork.then(() => this.applyTerminalState(preamble));
    }
    this.d.emulator.write(preamble);
    const draining = this.d.emulator.flush?.();
    if (draining === undefined) return;
    const delivery = Promise.resolve(draining);
    this.terminalStateDelivery = { bytes: preamble.slice(), promise: delivery };
    this.trackAuthoritativeWork(delivery);
    void delivery.then(() => {
      if (this.terminalStateDelivery?.promise === delivery) {
        this.terminalStateDelivery = undefined;
      }
    }, () => undefined);
    return delivery;
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
  emitExit(code: number, outputEnd: bigint, signal = 0): void | Promise<void> {
    if (this.disposed || this.exitFenced) return this.exitDelivery;
    const pending = this.pendingExit;
    if (pending !== undefined) {
      if (
        pending.code !== code ||
        pending.signal !== signal ||
        pending.outputEnd !== outputEnd
      ) {
        throw new Error('conflicting Moor session exit boundary');
      }
      return pending.promise;
    }
    if (outputEnd < this.outputOffset) {
      throw new Error(
        `Moor session exit boundary ${outputEnd} precedes delivered output ${this.outputOffset}`
      );
    }
    let resolve!: () => void;
    const delivery = new Promise<void>((done) => {
      resolve = done;
    });
    this.pendingExit = { code, signal, outputEnd, promise: delivery, resolve };
    this.exitDelivery = delivery;
    this.completeExitIfReady();
    return delivery;
  }

  /**
   * Moor-native child output (§6.1 OUTPUT): absolute byte offset + raw bytes.
   * Feeds the authoritative emulator and fans out to every subscribed surface.
   */
  onMoorOutput(bytes: Uint8Array, offset: bigint): void | Promise<void> {
    if (this.disposed) return;
    if (this.exitFenced) throw new Error('Moor output after session exit');
    const end = offset + BigInt(bytes.length);
    if (this.pendingExit !== undefined && end > this.pendingExit.outputEnd) {
      throw new Error(
        `Moor output ending at ${end} crosses session exit boundary ${this.pendingExit.outputEnd}`
      );
    }
    if (end <= this.outputOffset) return;

    const pending = this.outputDelivery;
    if (pending !== undefined) {
      if (pending.offset === offset) {
        if (!this.sameBytes(pending.bytes, bytes)) {
          throw new Error(`conflicting Moor output at offset ${offset}`);
        }
        return pending.promise;
      }
      return pending.promise.then(() => this.onMoorOutput(bytes, offset));
    }

    this.d.emulator.write(bytes);
    const deliver = (): void => {
      if (this.disposed) return;
      this.outputOffset = end;
      for (const [channelId, subscriber] of this.subscribers) {
        if (!subscriber.ready) continue;
        this.sendSubscriber(channelId, {
          type: BpFrameType.OUTPUT,
          channelId,
          generation: this.d.generation,
          revision: this.revision,
          offset,
          bytes
        });
      }
      for (const [channelId, subscriber] of this.subscribers) {
        if (!subscriber.ready) this.scheduleSubscriberActivation(channelId, subscriber);
      }
      this.completeExitIfReady();
    };
    const draining = this.d.emulator.flush?.();
    if (draining === undefined) {
      deliver();
      return;
    }
    const delivery = draining.then(deliver);
    this.outputDelivery = { offset, bytes, promise: delivery };
    this.trackAuthoritativeWork(delivery);
    void delivery.then(() => {
      if (this.outputDelivery?.promise === delivery) this.outputDelivery = undefined;
    }, () => undefined);
    return delivery;
  }

  // ---- browser → daemon (§7.4/§7.6) -----------------------------------------
  /**
   * Subscribe a surface: assign a channelId, ACK it, and emit the baseline
   * SNAPSHOT at the current output offset (§7.4). Returns whether the runtime
   * admitted the subscriber.
   */
  subscribe(surfaceId: string, rows: number, cols: number, assignedChannelId?: number): boolean {
    // The daemon allocates a GLOBALLY-unique channelId (so frames that carry only
    // channelId route unambiguously); fall back to a local counter when called
    // directly (e.g. unit tests).
    const channelId = assignedChannelId ?? this.nextChannelId++;
    if (this.disposed || this.pendingExit !== undefined || this.exitFenced) return false;
    const subscriber: Subscriber = { surfaceId, rows, cols, visible: true, ready: false };
    this.subscribers.set(channelId, subscriber);
    if (!this.sendSubscriber(channelId, {
      type: BpFrameType.SUBSCRIBE_ACK,
      channelId,
      generation: this.d.generation,
      revision: this.revision
    })) return false;
    this.scheduleSubscriberActivation(channelId, subscriber);
    return this.subscribers.get(channelId) === subscriber;
  }

  private scheduleSubscriberActivation(channelId: number, subscriber: Subscriber): void {
    if (
      this.subscribers.get(channelId) !== subscriber ||
      subscriber.ready ||
      subscriber.activation !== undefined
    ) {
      return;
    }
    const frontier = this.authoritativeWork;
    if (frontier === undefined) {
      this.activateSubscriber(channelId, subscriber);
      return;
    }
    const activation = frontier.then(
      () => {
        if (subscriber.activation !== activation) return;
        subscriber.activation = undefined;
        this.scheduleSubscriberActivation(channelId, subscriber);
      },
      () => {
        if (subscriber.activation !== activation) return;
        subscriber.activation = undefined;
        if (this.subscribers.get(channelId) === subscriber) this.failSubscriber(channelId);
      }
    );
    subscriber.activation = activation;
  }

  private activateSubscriber(channelId: number, subscriber: Subscriber): void {
    if (this.subscribers.get(channelId) !== subscriber) return;
    let text: string;
    try {
      text = this.d.emulator.serialize();
    } catch {
      this.failSubscriber(channelId);
      return;
    }
    subscriber.ready = true;
    this.sendSubscriber(channelId, {
      type: BpFrameType.SNAPSHOT,
      channelId,
      generation: this.d.generation,
      revision: this.revision,
      offset: this.outputOffset,
      text
    });
  }

  private sendSubscriber(channelId: number, frame: BpFrame): boolean {
    try {
      this.d.sendBrowser(channelId, frame);
      return true;
    } catch {
      this.failSubscriber(channelId);
      return false;
    }
  }

  private failSubscriber(channelId: number): void {
    this.subscribers.delete(channelId);
    try {
      this.d.onSubscriberFailure?.(channelId);
    } catch {
      // Browser-local cleanup must not poison authoritative output consumption.
    }
  }

  private sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  private trackAuthoritativeWork(work: Promise<void>): void {
    this.authoritativeWork = work;
    void work.then(() => {
      if (this.authoritativeWork === work) {
        this.authoritativeWork = undefined;
        this.completeExitIfReady();
      }
    }, () => undefined);
  }

  private completeExitIfReady(): void {
    const pending = this.pendingExit;
    if (
      pending === undefined ||
      this.disposed ||
      this.authoritativeWork !== undefined ||
      this.outputOffset !== pending.outputEnd
    ) {
      return;
    }
    this.finishPendingExit(pending);
  }

  private finishPendingExit(pending: PendingExit): void {
    this.exitFenced = true;
    this.pendingExit = undefined;
    for (const [channelId, subscriber] of this.subscribers) {
      if (!subscriber.ready) this.activateSubscriber(channelId, subscriber);
    }
    for (const channelId of this.subscribers.keys()) {
      this.sendSubscriber(channelId, {
        type: BpFrameType.EXIT,
        channelId,
        code: pending.code,
        signal: pending.signal
      });
    }
    pending.resolve();
  }

  pendingAuthoritativeWork(): Promise<void> | undefined {
    return this.authoritativeWork;
  }

  hasPendingExitBoundary(): boolean {
    return this.pendingExit !== undefined;
  }

  truncatePendingExit(): { outputOffset: bigint; outputEnd: bigint } | undefined {
    const pending = this.pendingExit;
    if (pending === undefined || this.disposed || this.authoritativeWork !== undefined) {
      return undefined;
    }
    const truncated = { outputOffset: this.outputOffset, outputEnd: pending.outputEnd };
    this.finishPendingExit(pending);
    return truncated;
  }

  unsubscribe(channelId: number): void {
    this.subscribers.delete(channelId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.txns.clear();
    this.outputDelivery = undefined;
    this.authoritativeWork = undefined;
    this.terminalStateDelivery = undefined;
    this.pendingExit?.resolve();
    this.pendingExit = undefined;
    this.d.emulator.dispose();
  }

  /** Forward browser input to the master (§7.6, two channels). */
  onBrowserInput(channelId: number, binary: boolean, bytes: Uint8Array): boolean {
    if (
      this.disposed ||
      this.pendingExit !== undefined ||
      this.exitFenced ||
      !this.subscribers.has(channelId)
    ) {
      return false;
    }
    return this.d.sendMasterInput(bytes, binary, channelId) !== false;
  }

  /**
   * Control-plane input injection (channels delivery, not a browser surface):
   * an INPUT frame under the reserved surface id 0 — browser channelIds are
   * allocated from 1, so 0 can never collide with a subscriber. With `paste`,
   * mirrors legacy paste semantics: wrap in bracketed-paste codes ONLY when the
   * app enabled the mode (DECSET 2004), so multi-line text does not submit per
   * newline in a TUI, while a plain shell never sees stray escape codes.
   */
  injectInput(bytes: Uint8Array, paste = false): boolean {
    if (this.disposed || this.pendingExit !== undefined || this.exitFenced) return false;
    let data = bytes;
    if (paste && this.d.emulator.bracketedPaste?.() === true) {
      const open = new TextEncoder().encode('\x1b[200~');
      const close = new TextEncoder().encode('\x1b[201~');
      data = new Uint8Array(open.length + bytes.length + close.length);
      data.set(open, 0);
      data.set(bytes, open.length);
      data.set(close, open.length + bytes.length);
    }
    return this.d.sendMasterInput(data, false, 0) !== false;
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
  onBrowserResize(channelId: number, rows: number, cols: number): boolean {
    if (this.disposed || this.pendingExit !== undefined || this.exitFenced) return false;
    const sub = this.subscribers.get(channelId);
    if (sub === undefined) return false;
    sub.rows = rows;
    sub.cols = cols;
    this.d.emulator.resize(rows, cols);
    // Geometry is controller-owned: bump the revision locally (the moor holder
    // never echoes geometry back; the legacy echo path may still overwrite
    // this with its own counter until it is removed with the old runtime).
    this.revision += 1;
    this.d.sendMasterResize(rows, cols, channelId);
    return true;
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
