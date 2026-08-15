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
import type { MoorExitOutcome } from '../controlPlane/contract.js';
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
}

/**
 * A geometry Desk SELECTED and COMMANDED for a session, and the channel whose
 * ownership authorised it (desk#68). It is what the daemon resized its own
 * emulator to and sent to the master — not proof of the child's pty: with no
 * master link the send goes nowhere, and only the moor holder knows the pair
 * the native resize actually produced. Callers that persist or replay geometry
 * must still use THIS, never the rows/cols a surface asked for: an observer's
 * request is recorded against that surface and goes no further.
 */
export interface CommandedGeometry {
  rows: number;
  cols: number;
  /** The owning channel — the surfaceId the master resize was sent under. */
  surfaceId: number;
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
  outcome: MoorExitOutcome;
  outputEnd: bigint;
  promise: Promise<void>;
  resolve: () => void;
}

/** Two endings are the same claim only if every field of the tag agrees. */
function sameExitOutcome(a: MoorExitOutcome, b: MoorExitOutcome): boolean {
  switch (a.kind) {
    case 'exited':
      return b.kind === 'exited' && b.code === a.code;
    case 'signalled':
      return b.kind === 'signalled' && b.signal === a.signal;
    case 'terminated':
      return b.kind === 'terminated' && b.code === a.code && b.method === a.method;
    case 'unknown':
      return b.kind === 'unknown';
  }
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
  /**
   * desk#68 — the channel that owns this session's SIZE. Exactly one at a time;
   * every other subscriber is an observer whose resizes are recorded but never
   * commanded, so two surfaces of one session can no longer fight over the pty.
   * undefined only while no subscriber is visible.
   *
   * SEAM (§7.5): the spec's controller lease says the same owner drives INPUT
   * *and* RESIZE, and `LeaseState` models that. This owner enforces RESIZE ONLY.
   * INPUT from any subscriber still reaches the child (see onBrowserInput), and
   * `LeaseState` — conn-keyed, claimed by no browser path today — is not
   * consulted here. Half of §7.5, deliberately, and not to be read as more.
   */
  private resizeOwner: number | undefined;
  /** The rows×cols this runtime last COMMANDED (see CommandedGeometry). */
  private commanded: { rows: number; cols: number } | undefined;

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
   * The ending travels as the tagged outcome moor reported — `unknown` stays
   * `unknown` all the way to the frame; nothing here invents a code for it.
   */
  emitExit(outcome: MoorExitOutcome, outputEnd: bigint): void | Promise<void> {
    if (this.disposed || this.exitFenced) return this.exitDelivery;
    const pending = this.pendingExit;
    if (pending !== undefined) {
      if (!sameExitOutcome(pending.outcome, outcome) || pending.outputEnd !== outputEnd) {
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
    this.pendingExit = { outcome, outputEnd, promise: delivery, resolve };
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
   * SNAPSHOT at the current output offset (§7.4). Returns the channelId and, if
   * this subscribe ACQUIRED ownership, the geometry that acquisition commanded.
   */
  subscribe(
    surfaceId: string,
    rows: number,
    cols: number,
    assignedChannelId?: number
  ): { channelId: number; commanded?: CommandedGeometry } | undefined {
    // The daemon allocates a GLOBALLY-unique channelId (so frames that carry only
    // channelId route unambiguously); fall back to a local counter when called
    // directly (e.g. unit tests).
    const channelId = assignedChannelId ?? this.nextChannelId++;
    if (this.disposed || this.pendingExit !== undefined || this.exitFenced) return undefined;
    const subscriber: Subscriber = { surfaceId, rows, cols, visible: true, ready: false };
    this.subscribers.set(channelId, subscriber);
    let commanded: CommandedGeometry | undefined;
    if (this.resizeOwner === undefined) {
      // First surface in takes resize ownership, and acquisition COMMANDS the
      // acquirer's geometry (desk#68). It must: the reveal path suppresses a
      // RESIZE whose size is unchanged (TerminalSurface's lastResizeRef dedupe),
      // so after hide-all this SUBSCRIBE is the only carrier of the new owner's
      // geometry the runtime will ever see — without commanding here the owner
      // renders one size while the child stays at the previous owner's forever.
      // The value is not invented: SUBSCRIBE carries the surface's current xterm
      // rows×cols (TerminalSurface.tsx subscribes with terminal.rows/cols) — the
      // fitted measurement on reveal; on a very first mount it is the terminal's
      // construction size, and the first fit corrects it via a normal owner
      // RESIZE because a CHANGED size passes the dedupe. A later subscriber
      // joins as an OBSERVER — it never becomes owner while the owner is still
      // visible, so the common two-surface transient (the outgoing cell still
      // mounted while the incoming one mounts) cannot move the pty.
      this.resizeOwner = channelId;
      commanded = this.commandOwnerSize(channelId, rows, cols);
    }
    // ACK + SNAPSHOT emit AFTER any acquisition command, so the ACK carries the
    // post-command revision. The snapshot is deferred behind authoritative
    // output, then serialized at the geometry the surface will actually render.
    if (!this.sendSubscriber(channelId, {
      type: BpFrameType.SUBSCRIBE_ACK,
      channelId,
      generation: this.d.generation,
      revision: this.revision
    })) return undefined;
    this.scheduleSubscriberActivation(channelId, subscriber);
    if (this.subscribers.get(channelId) !== subscriber) return undefined;
    return commanded === undefined ? { channelId } : { channelId, commanded };
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
    if (!this.subscribers.has(channelId)) return;
    try {
      this.d.onSubscriberFailure?.(channelId);
    } catch {
      // Browser-local cleanup must not poison authoritative output consumption.
    } finally {
      // DaemonCore normally performs the ownership handoff and journal update;
      // this remains a local safety net for direct SessionRuntime embeddings.
      if (this.subscribers.has(channelId)) this.unsubscribe(channelId);
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
        outcome: pending.outcome
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

  /** Drop a surface. Returns the geometry a resulting handoff commanded, if any. */
  unsubscribe(channelId: number): CommandedGeometry | undefined {
    // An owner that leaves hands off (desk#68) — otherwise the session keeps a
    // dead surface's geometry and no live surface can ever correct it.
    return this.unsubscribeMany([channelId]);
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

  /**
   * Drop a SET of surfaces — all channels of one closing browser connection —
   * and only then elect, at most once, from the true survivors (desk#68). The
   * whole set leaves before any election runs: removing the channels one at a
   * time would transiently promote a dying sibling and command the child
   * through a surface that is already gone. Returns the geometry the single
   * election commanded, if one ran and found a visible successor.
   */
  unsubscribeMany(channelIds: Iterable<number>): CommandedGeometry | undefined {
    let ownerRemoved = false;
    for (const channelId of channelIds) {
      if (this.subscribers.delete(channelId) && channelId === this.resizeOwner) {
        ownerRemoved = true;
      }
    }
    // Ownership is untouched unless the owner itself left: removing observers
    // never re-elects, and with no owner (all hidden) there is nothing to hand
    // off — the size stays where the last owner put it.
    if (!ownerRemoved) return undefined;
    return this.electOwner();
  }

  /**
   * Forward browser input to the master (§7.6, two channels).
   *
   * NOT gated on the resize owner (desk#68 seam): §7.5 puts INPUT and RESIZE
   * under one owner, but this change enforces the RESIZE half only. Any
   * subscriber may still type.
   */
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
   * Browser-initiated resize (§7.5). ONE subscriber owns the session's size at a
   * time; the others are observers whose reported geometry is remembered but
   * never commanded. Returns the size commanded, or undefined when this call
   * commanded nothing — callers that persist or replay geometry must use the
   * return value, never their own arguments (desk#68: two surfaces at different
   * sizes used to overwrite each other forever, and the loser's size was still
   * written to the durable geometry record).
   */
  acceptsBrowserResize(channelId: number): boolean {
    return (
      !this.disposed &&
      this.pendingExit === undefined &&
      !this.exitFenced &&
      this.subscribers.has(channelId)
    );
  }

  onBrowserResize(
    channelId: number,
    rows: number,
    cols: number
  ): CommandedGeometry | undefined {
    if (!this.acceptsBrowserResize(channelId)) return undefined;
    const sub = this.subscribers.get(channelId);
    if (sub === undefined) return undefined;
    // Remember every surface's own geometry even when it may not drive: it is
    // what gets commanded if this surface is later promoted.
    sub.rows = rows;
    sub.cols = cols;
    // An observer — including the PREVIOUS owner after a handoff — reports only.
    if (channelId !== this.resizeOwner) return undefined;
    return this.commandOwnerSize(channelId, rows, cols);
  }

  /**
   * Browser surface visibility (§3.3/§7.4) — drives worker residency + lease
   * candidacy. Returns the geometry a resulting handoff commanded, if any.
   */
  onBrowserVisibility(channelId: number, visible: boolean): CommandedGeometry | undefined {
    const sub = this.subscribers.get(channelId);
    if (sub === undefined) return undefined;
    sub.visible = visible;
    // A hidden owner is no longer driving anything a human can see: hand off to
    // a visible surface, or hold the size if there is none (desk#68).
    return this.handoffIfOwnerGone(channelId);
  }

  /** The channel that currently owns this session's size, if any (§7.5, desk#68). */
  get resizeOwnerChannel(): number | undefined {
    return this.resizeOwner;
  }

  /** The rows×cols this runtime last commanded, if it ever commanded one. */
  commandedSize(): { rows: number; cols: number } | undefined {
    return this.commanded === undefined ? undefined : { ...this.commanded };
  }

  /**
   * Command the owner's geometry: resize the authoritative emulator and tell the
   * master to resize the child. The one place either happens, so "who may
   * resize" is a single check. Whether the child's pty ends up at this size is
   * the holder's business — the send is best-effort and may have no link at all.
   */
  private commandOwnerSize(surfaceId: number, rows: number, cols: number): CommandedGeometry {
    this.commanded = { rows, cols };
    this.d.emulator.resize(rows, cols);
    // Geometry is controller-owned: the revision is bumped here and nowhere
    // else. The moor holder never echoes geometry back, so this counter is the
    // only authority on which frames are stale after a size change.
    this.revision += 1;
    this.d.sendMasterResize(rows, cols, surfaceId);
    return { rows, cols, surfaceId };
  }

  /**
   * desk#68 handoff. Called when a subscriber hides or leaves; a no-op unless
   * that subscriber was the owner and can no longer drive.
   *
   * The successor is the visible subscriber with the LOWEST channelId. channelIds
   * are allocated monotonically, so that is the longest-standing visible surface
   * — an explicit, stable rule rather than whatever the Map happens to yield
   * first. Its stored geometry is commanded EXACTLY ONCE here; the promoted
   * surface does not have to re-report to fix the pty, and the demoted one
   * cannot move it afterwards (its late resizes are observer reports).
   *
   * With no visible successor the session keeps its owner-less state and the
   * size is left ALONE — a child whose surfaces are all hidden is not resized
   * to nothing, and the first surface to come back takes ownership then.
   */
  private handoffIfOwnerGone(channelId: number): CommandedGeometry | undefined {
    if (this.resizeOwner !== undefined) {
      if (this.resizeOwner !== channelId) return undefined;
      if (this.subscribers.get(channelId)?.visible === true) return undefined;
    }
    return this.electOwner();
  }

  /**
   * The one election (desk#68): the visible subscriber with the lowest
   * channelId — channelIds are allocated monotonically, so that is the
   * longest-standing visible surface — becomes owner and its stored geometry
   * is commanded exactly once. With no visible candidate the session is
   * owner-less and the size is left alone.
   */
  private electOwner(): CommandedGeometry | undefined {
    this.resizeOwner = undefined;
    let successor: number | undefined;
    for (const [candidate, sub] of this.subscribers) {
      if (!sub.visible) continue;
      if (successor === undefined || candidate < successor) successor = candidate;
    }
    if (successor === undefined) return undefined;
    this.resizeOwner = successor;
    const sub = this.subscribers.get(successor)!;
    return this.commandOwnerSize(successor, sub.rows, sub.cols);
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
