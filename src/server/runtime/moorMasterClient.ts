// Daemon-side MOOR controller client — a one-shot connection/handshake state
// machine over the frozen moor wire v3 (spec/moor-wire-schema.md).
//
// Frozen contract this file enforces:
// - §3 identity exchange: supervised HELLO at the ledger-allocated generation
//   scope; the holder's HELLO_ACK proves identity+generation and adopts the
//   incarnation. Scope 0 (discovery) is never emitted here.
// - §6 attach order, exact: TERMINAL_STATE (exactly once, before ATTACH_ACK) →
//   ATTACH_ACK → optional LEASE_RESULT → GAP/OUTPUT replay baseline → live.
//   A missing, second, or post-ACK preamble is refused (conformance §17).
// - Deadline table: identity exchange and adoption must complete within 2 s or
//   the connection closes.
// - §1.2 canonical session identity is an INPUT, distinct from the transport
//   endpoint: tag 01 = lexically resolved absolute POSIX socket path bytes;
//   tag 02 = Windows volume serial + FILE_ID_INFO.FileId (25 bytes). This
//   constructor validates the POSIX derivation and requires explicit injection
//   where derivation would be a guess (Windows, noncanonical paths).
// - Unified close: any teardown (local close, holder close, wire violation,
//   deadline) rejects pending work and makes every later write throw.

import { connect, type Socket } from 'node:net';
import { MoorCodec } from '../../shared/moorWire/codec.js';
import { MoorWireError } from '../../shared/moorWire/schema.js';
import {
  decodeMoorHolderMessage,
  encodeMoorSupervisedRequest,
  type MoorControllerRequest,
  type MoorHolderMessage,
  type MoorStatus
} from '../../shared/moorWire/messages.js';

export interface MoorAttachOptions {
  columns: number;
  rows: number;
  requestLease: boolean;
  nonVt?: boolean;
}

type Holder<T extends MoorHolderMessage['type']> = Extract<MoorHolderMessage, { type: T }>;

export interface MoorMasterClientHandlers {
  onHelloAck?: (ack: Holder<'hello-ack'>) => void;
  onAttachAck?: (status: MoorStatus) => void;
  onStatusReply?: (status: MoorStatus) => void;
  onTerminalState?: (bytes: Uint8Array) => void;
  onOutput?: (output: Holder<'output'>) => void;
  onGap?: (gap: Holder<'gap'>) => void;
  onInputReceipt?: (receipt: Holder<'input-receipt'>) => void;
  onTerminateResult?: (result: Holder<'terminate-result'>) => void;
  onLeaseResult?: (result: Holder<'lease-result'>) => void;
  onLogClearResult?: (result: Holder<'log-clear-result'>) => void;
  onQuery?: (query: Holder<'query'>) => void;
  onHolderError?: (code: number, diagnostic: Uint8Array) => void;
  onHeartbeat?: (monotonicMs: bigint, flags: number) => void;
  onWakeup?: () => void;
  /** §10: 15 s without HEARTBEAT — verified-live evidence is invalidated. */
  onLivenessLost?: () => void;
  /** A HEARTBEAT arrived after liveness had been lost. */
  onLivenessRestored?: () => void;
  /** A wire/protocol violation on this connection — the client is closed. */
  onProtocolError?: (error: MoorWireError) => void;
  onClose?: () => void;
  /** Raw incoming bytes, before reassembly — for diagnostics/tracing. */
  onRaw?: (chunk: Uint8Array) => void;
}

export interface MoorMasterClientOptions {
  /**
   * Canonical session identity (§1.2), injected from the authoritative
   * adoption path. When omitted, the transport path is validated as a
   * lexically resolved absolute POSIX path and used as the tag-01 identity;
   * anything else (Windows, relative, unresolved) must be injected.
   */
  identity?: Uint8Array;
  /** Identity-exchange + adoption deadline (spec table: 2 s). */
  attachDeadlineMs?: number;
  /**
   * Automatically acknowledge the consumption watermark after each delivered
   * batch (§6.1 OUTPUT_ACK = highest record consumed). Off by default: the
   * seam that consumes records owns consumption unless it delegates here.
   */
  autoAckOutput?: boolean;
  /**
   * §6.1 reconnect: the highest record sequence a previous connection already
   * delivered, bound to the 16-byte holder incarnation it was captured under
   * (mandatory for any nonzero sequence — sequences reset per incarnation, so
   * a bare number proves nothing). A cursor from another incarnation is void
   * (everything is new); a same-incarnation cursor above the current
   * high-water is a contradiction that fails the attach closed. Records at or
   * below a valid cursor are validated for continuity but not delivered again.
   */
  resumeCursor?: { sequence: bigint; incarnation?: Uint8Array };
  /** §10 liveness window (default 15 000 ms without HEARTBEAT). */
  livenessWindowMs?: number;
}

export class MoorIdentityError extends Error {
  readonly code = 'IDENTITY_MISMATCH';
  constructor(message: string) {
    super(`IDENTITY_MISMATCH: ${message}`);
    this.name = 'MoorIdentityError';
  }
}

function assertResolvedPosixPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new MoorIdentityError('POSIX session identity requires an absolute path');
  }
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === '.' || segment === '..' || (segment === '' && index !== segments.length - 1)) {
      throw new MoorIdentityError('POSIX session identity requires a lexically resolved path');
    }
  }
}

/** Tag-01 identity: lexically resolved absolute POSIX socket-path bytes (§1.2). */
export function posixMoorIdentity(path: string): Uint8Array {
  assertResolvedPosixPath(path);
  const bytes = Buffer.from(path);
  const identity = new Uint8Array(1 + bytes.length);
  identity[0] = 1;
  identity.set(bytes, 1);
  return identity;
}

/** Tag-02 identity: Windows volume serial + FILE_ID_INFO.FileId (§1.2, 25 bytes). */
export function windowsMoorIdentity(volumeSerial: bigint, fileId: Uint8Array): Uint8Array {
  if (fileId.length !== 16) {
    throw new MoorIdentityError('Windows session identity requires the exact 16-byte FileId');
  }
  const identity = new Uint8Array(25);
  identity[0] = 2;
  new DataView(identity.buffer).setBigUint64(1, volumeSerial, true);
  identity.set(fileId, 9);
  return identity;
}

function validateIdentity(identity: Uint8Array): Uint8Array {
  // An injected tag-01 identity carries the SAME lexical contract as a derived
  // one (§1.2: absolute bytes after `.`/`..` resolution) — tag/length checks
  // alone would accept a noncanonical path the holder will refuse.
  if (identity[0] === 1 && identity.length >= 2) {
    assertResolvedPosixPath(Buffer.from(identity.subarray(1)).toString());
  } else if (identity[0] !== 2 || identity.length !== 25) {
    throw new MoorIdentityError(
      'canonical session identity must be tag 01 (absolute POSIX path) or tag 02 (25 bytes)'
    );
  }
  return identity.slice(); // defensive copy: the caller must not mutate it later
}

const DEFAULT_ATTACH_DEADLINE_MS = 2_000;
const DEFAULT_LIVENESS_WINDOW_MS = 15_000;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Connection phases, strictly forward:
 * created → connecting → connected → hello-sent → adopted → preamble →
 * (lease-pending when the attach requested a fresh viewer lease) → attached,
 * with `closed` reachable (terminally) from every phase. `lease-pending`
 * models the §6 prefix position where ONLY the requested LEASE_RESULT may
 * follow ATTACH_ACK — no replay or live output may overtake it.
 */
type Phase =
  | 'created'
  | 'connecting'
  | 'connected'
  | 'hello-sent'
  | 'adopted'
  | 'preamble'
  | 'lease-pending'
  | 'attached'
  | 'closed';

export class MoorMasterClient {
  private sock: Socket | null = null;
  private readonly codec = new MoorCodec();
  private readonly identity: Uint8Array;
  private readonly h: MoorMasterClientHandlers;
  private readonly attachDeadlineMs: number;
  private readonly livenessWindowMs: number;
  private readonly autoAck: boolean;
  /** Reconnect cursor as requested (before incarnation/high-water validation). */
  private readonly resumeSequence: bigint;
  private readonly resumeIncarnation: Uint8Array | undefined;
  /** The cursor actually in force after HELLO_ACK incarnation reconciliation. */
  private effectiveResume = 0n;
  /** True once a LEASE_KEEPALIVE was actually emitted for the current grant. */
  private keepaliveEmitted = false;
  private phase: Phase = 'created';
  private incarnation: Uint8Array | undefined;
  private status: MoorStatus | undefined;
  private preambleBytes: Uint8Array | undefined;
  private nextRequestId = 1n;
  private deadline: NodeJS.Timeout | undefined;
  /** Granted viewer lease (§7.4): epoch + token, kept alive on the 3 s cadence. */
  private lease: { epoch: number; token: Uint8Array } | undefined;
  private keepalive: NodeJS.Timeout | undefined;
  /** §7.3 one-input-in-flight: the exact request the next receipt must match — retained bytes make the safe identical retry possible. */
  private pendingInput: { requestId: bigint; epoch: number; bytes: Uint8Array } | undefined;
  /** §6.1 output continuity: next record sequence and byte offset. */
  private expectedSequence = 1n;
  private expectedOffset = 0n;
  /** Highest OUTPUT record received on this connection ("highest record sent" bounds OUTPUT_ACK). */
  private highestReceived = 0n;
  /** The cumulative consumption watermark already acknowledged to the holder. */
  private lastAcked = 0n;
  /** The frozen baseline's discarded-prefix GAP, expected exactly once (§6.1). */
  private baselineGap: { last: bigint } | undefined;
  /** §10: verified-live evidence; invalidated after 15 s without HEARTBEAT. */
  private live = false;
  private livenessTimer: NodeJS.Timeout | undefined;
  private pendingAttach:
    | { options: MoorAttachOptions; resolve: (status: MoorStatus) => void; reject: (error: Error) => void }
    | undefined;
  private pendingAuthenticate:
    | { resolve: () => void; reject: (error: Error) => void }
    | undefined;
  private pendingTerminate:
    | {
        resolve: (result: Extract<MoorHolderMessage, { type: 'terminate-result' }>) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private pendingRelease:
    | {
        /** The exact epoch this release submitted — the released result must echo it. */
        epoch: number;
        resolve: (outcome: 'released' | 'refused') => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private pendingLogClear:
    | {
        /** The submitted observed frontier — the result's prior must echo it. */
        observed: bigint;
        resolve: (result: Extract<MoorHolderMessage, { type: 'log-clear-result' }>) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(
    private readonly sockPath: string,
    private readonly generation: number,
    handlers: MoorMasterClientHandlers = {},
    options: MoorMasterClientOptions = {}
  ) {
    if (!Number.isInteger(generation) || generation < 2 || generation > 0xffff_ffff) {
      throw new MoorWireError(
        'GENERATION_MISMATCH',
        'supervised controller requires a ledger-allocated generation of 2 or greater'
      );
    }
    this.identity =
      options.identity !== undefined
        ? validateIdentity(options.identity)
        : process.platform === 'win32'
          ? (() => {
              throw new MoorIdentityError(
                'Windows requires an injected tag-02 identity from the verified marker'
              );
            })()
          : posixMoorIdentity(sockPath);
    this.attachDeadlineMs = options.attachDeadlineMs ?? DEFAULT_ATTACH_DEADLINE_MS;
    this.livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
    this.autoAck = options.autoAckOutput ?? false;
    const resume = options.resumeCursor?.sequence ?? 0n;
    if (resume < 0n || resume > U64_MAX) {
      throw new Error('moor controller resume cursor is out of range');
    }
    const resumeIncarnation = options.resumeCursor?.incarnation;
    // §6.1: record sequences are per holder incarnation, so a bare sequence
    // proves nothing — a restarted holder that already produced that many
    // records would have genuinely new output silently suppressed. Every
    // nonzero cursor must carry the 16-byte incarnation it came from.
    if (resume > 0n && resumeIncarnation === undefined) {
      throw new Error(
        'moor controller resume cursor requires the 16-byte holder incarnation it was captured under'
      );
    }
    if (resumeIncarnation !== undefined && resumeIncarnation.length !== 16) {
      throw new Error('moor controller resume cursor incarnation must be exactly 16 bytes');
    }
    this.resumeSequence = resume;
    this.resumeIncarnation = resumeIncarnation?.slice();
    this.h = handlers;
  }

  /** Guarded one-shot connect: valid only from the created phase. */
  connect(): Promise<void> {
    if (this.phase !== 'created') {
      return Promise.reject(new Error(`moor controller cannot connect from phase ${this.phase}`));
    }
    this.phase = 'connecting';
    return new Promise((resolve, reject) => {
      const sock = connect(this.sockPath);
      sock.once('error', (error) => {
        if (this.phase === 'connecting') {
          this.phase = 'closed';
          reject(error);
        }
      });
      sock.once('connect', () => {
        this.sock = sock;
        this.phase = 'connected';
        sock.on('data', (chunk: Buffer) => this.onData(chunk));
        sock.on('error', () => this.teardown(new Error('moor holder connection errored')));
        sock.on('close', () => {
          this.teardown(new Error('moor holder closed the connection'));
          this.h.onClose?.();
        });
        resolve();
      });
    });
  }

  /**
   * One-shot supervised handshake. HELLO goes out at the generation scope; the
   * HELLO_ACK adopts identity, then ATTACH; the exact §6 prefix
   * (TERMINAL_STATE → ATTACH_ACK) resolves the promise. One absolute deadline
   * covers the whole identity exchange and adoption.
   */
  attach(options: MoorAttachOptions): Promise<MoorStatus> {
    if (this.phase !== 'connected') {
      return Promise.reject(new Error(`moor controller cannot attach from phase ${this.phase}`));
    }
    return new Promise<MoorStatus>((resolve, reject) => {
      this.pendingAttach = { options, resolve, reject };
      this.phase = 'hello-sent';
      this.deadline = setTimeout(() => {
        this.teardown(
          new Error('DEADLINE_EXCEEDED: identity exchange and adoption did not complete within the deadline')
        );
      }, this.attachDeadlineMs);
      this.request({ type: 'hello', identity: this.identity });
    });
  }

  /**
   * §10 bounded identity-probe primitive: HELLO → HELLO_ACK ONLY. The decoder
   * fences the canonical identity and generation scope, so a resolution IS a
   * completed authenticated exchange — without attaching: no viewer
   * registration, no replay, no lease interaction. The same absolute adoption
   * deadline bounds it. The caller closes the connection afterwards.
   */
  authenticate(): Promise<void> {
    if (this.phase !== 'connected') {
      return Promise.reject(
        new Error(`moor controller cannot authenticate from phase ${this.phase}`)
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingAuthenticate = { resolve, reject };
      this.phase = 'hello-sent';
      this.deadline = setTimeout(() => {
        this.teardown(
          new Error('DEADLINE_EXCEEDED: identity exchange did not complete within the deadline')
        );
      }, this.attachDeadlineMs);
      this.request({ type: 'hello', identity: this.identity });
    });
  }

  /** Lease epoch adopted from the newest holder status (0 while unleased). */
  get leaseEpoch(): number {
    return this.status?.leaseEpoch ?? 0;
  }

  /** The §6 preamble bytes, once received (empty run is legal). */
  get terminalStatePreamble(): Uint8Array | undefined {
    return this.preambleBytes;
  }

  sendInput(bytes: Uint8Array): void {
    this.requireAttached();
    this.requireLease();
    if (this.pendingInput !== undefined) {
      throw new Error('moor controller input is already in flight until its receipt');
    }
    // §7.3: request ids never wrap. U64_MAX may be the final new request of
    // this lease epoch; anything further is exhausted until a fresh epoch.
    if (this.nextRequestId > U64_MAX) {
      throw new Error(
        'RESOURCE_EXHAUSTED: request ids for this lease epoch are exhausted until a new lease is granted'
      );
    }
    const requestId = this.nextRequestId++;
    const epoch = this.lease!.epoch;
    this.pendingInput = { requestId, epoch, bytes: bytes.slice() };
    try {
      this.request({ type: 'input', epoch, requestId, bytes });
    } catch (error) {
      // Transactional: a local encode/write rejection must leave the request
      // id and the one-in-flight slot exactly as they were.
      this.pendingInput = undefined;
      this.nextRequestId = requestId;
      throw error;
    }
    this.scheduleKeepalive(); // lease-owned traffic resets the idle cadence
  }

  /**
   * §7.3 lost-receipt recovery: re-send the pending input with the IDENTICAL
   * id, epoch, and bytes. The holder compares the complete payload at its
   * high-water mark and returns the cached receipt without re-evaluating or
   * writing — this is what makes an input retry safe. False when nothing is
   * pending.
   */
  retryPendingInput(): boolean {
    this.requireAttached();
    const pending = this.pendingInput;
    if (pending === undefined) return false;
    this.request({
      type: 'input',
      epoch: pending.epoch,
      requestId: pending.requestId,
      bytes: pending.bytes
    });
    this.scheduleKeepalive();
    return true;
  }

  sendResize(columns: number, rows: number): void {
    this.requireAttached();
    this.requireLease();
    this.request({ type: 'resize', epoch: this.lease!.epoch, columns, rows });
    this.scheduleKeepalive(); // lease-owned traffic resets the idle cadence
  }

  ackOutput(sequence: bigint): void {
    this.requireAttached();
    // §6.1: zero means no record consumed; anything above the highest record
    // the holder actually sent on this connection is a BAD_SEQUENCE there —
    // refuse it here instead of emitting a doomed frame.
    if (sequence < 0n || sequence > this.highestReceived) {
      throw new Error(
        `moor controller cannot ack ${sequence} above the highest delivered record ${this.highestReceived}`
      );
    }
    // The ack is a cumulative consumption watermark: re-acking at or below
    // the already-acknowledged mark carries no information — skip the frame.
    if (sequence <= this.lastAcked) return;
    this.lastAcked = sequence;
    this.request({ type: 'output-ack', sequence });
  }

  /** §10: false once 15 s pass without a HEARTBEAT while attached. */
  get verifiedLive(): boolean {
    return this.live;
  }

  requestStatus(): void {
    this.requireAttached();
    this.request({ type: 'status' });
  }

  /**
   * §9 destructive request: TERMINATE names the expected canonical identity,
   * generation, AND holder incarnation — the holder refuses atomically on any
   * mismatch, so a successor can never be killed by a stale request. Resolves
   * with the holder's TERMINATE_RESULT (outcome algebra of OB-33). The spec
   * bounds the whole operation at 10 s; expiry rejects and the caller treats
   * it as INDETERMINATE — nothing may be assumed.
   */
  terminate(opts: { force?: boolean } = {}): Promise<Holder<'terminate-result'>> {
    this.requireAttached();
    if (this.pendingTerminate !== undefined) {
      return Promise.reject(new Error('a moor terminate request is already in flight'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTerminate = undefined;
        reject(new Error('TERMINATE deadline expired: the outcome is indeterminate'));
      }, 10_000);
      timer.unref?.();
      this.pendingTerminate = { resolve, reject, timer };
      this.request({
        type: 'terminate',
        identity: this.identity,
        generation: this.generation,
        incarnation: this.incarnation!,
        force: opts.force ?? false
      });
    });
  }

  /**
   * §7.4 graceful lease release: the exact current {epoch, token} tuple.
   * 'released' invalidates the local grant; 'refused' reports a not-held /
   * mismatch WITHOUT mutation on the holder. The idle keepalive stops the
   * moment the release goes out — a keepalive racing a released lease would
   * draw ERROR(LEASE_NOT_HELD) and close the connection.
   */
  releaseLease(): Promise<'released' | 'refused'> {
    this.requireAttached();
    const lease = this.lease;
    if (lease === undefined) {
      return Promise.reject(new Error('moor controller holds no lease to release'));
    }
    if (this.pendingRelease !== undefined) {
      return Promise.reject(new Error('a moor lease release is already in flight'));
    }
    if (this.keepalive !== undefined) {
      clearTimeout(this.keepalive);
      this.keepalive = undefined;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRelease = undefined;
        reject(new Error('LEASE_RELEASE deadline expired'));
      }, 2_000);
      timer.unref?.();
      this.pendingRelease = { epoch: lease.epoch, resolve, reject, timer };
      this.request({ type: 'lease-release', epoch: lease.epoch, token: lease.token });
    });
  }

  /**
   * §10.2.13 log clear, fenced on the adopted incarnation and the SELECTED
   * log commit index this client observed in the newest status — the holder
   * refuses a clear racing a log it has advanced past.
   */
  clearLog(): Promise<Holder<'log-clear-result'>> {
    this.requireAttached();
    const status = this.status;
    if (status === undefined) {
      return Promise.reject(new Error('moor controller has no adopted status to clear against'));
    }
    if (this.pendingLogClear !== undefined) {
      return Promise.reject(new Error('a moor log clear is already in flight'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLogClear = undefined;
        reject(new Error('LOG_CLEAR deadline expired'));
      }, 5_000);
      timer.unref?.();
      this.pendingLogClear = { observed: status.log.index, resolve, reject, timer };
      this.request({
        type: 'log-clear',
        incarnation: this.incarnation!,
        observed: status.log.index
      });
    });
  }

  /**
   * §8 query arbitration: the lease-owning VT viewer's reply. Echoes the
   * holder's correlation and the CURRENT lease epoch; the payload must be one
   * of the closed canonical reply forms. Lease-owned traffic — it refreshes
   * the responsiveness deadline like INPUT/RESIZE.
   */
  sendQueryReply(correlation: bigint, queryClass: number, bytes: Uint8Array): void {
    this.requireAttached();
    this.requireLease();
    this.request({
      type: 'query-reply',
      correlation,
      epoch: this.lease!.epoch,
      class: queryClass,
      bytes
    });
    this.scheduleKeepalive(); // lease-owned traffic resets the idle cadence
  }

  close(): void {
    this.teardown(new Error('moor controller closed before attach completed'));
  }

  // ---- internals ------------------------------------------------------------

  private request(request: MoorControllerRequest): void {
    if (this.sock === null) throw new Error('moor controller is not connected');
    this.sock.write(encodeMoorSupervisedRequest(this.codec, this.generation, request));
  }

  private requireAttached(): void {
    if (this.phase !== 'attached' || this.sock === null) {
      throw new Error('moor controller is not attached');
    }
  }

  /** §7.5: input and resize belong to the viewer lease owner only. */
  private requireLease(): void {
    if (this.lease === undefined) {
      throw new Error('moor controller does not hold the viewer lease');
    }
  }

  /**
   * Idle keepalive cadence (spec deadline table: 3 s while otherwise idle).
   * Only lease-owned traffic — INPUT, RESIZE, and the keepalive itself —
   * resets it; unrelated frames (acks, status) must never postpone the
   * lease-liveness proof.
   */
  private scheduleKeepalive(): void {
    if (this.lease === undefined || this.phase === 'closed') return;
    if (this.keepalive !== undefined) clearTimeout(this.keepalive);
    this.keepalive = setTimeout(() => {
      if (this.lease === undefined || this.sock === null) return;
      this.request({ type: 'lease-keepalive', epoch: this.lease.epoch, token: this.lease.token });
      this.keepaliveEmitted = true; // a later LEASE_NOT_HELD now refuses THIS keepalive
      this.scheduleKeepalive();
    }, 3_000);
    this.keepalive.unref?.();
  }

  /**
   * §10: arm/reset the 15 s heartbeat monitor. Losing it never proves the
   * holder is gone — it only invalidates verified-live evidence; the bounded
   * identity probe is the consumer's decision, so no teardown happens here.
   */
  private armLiveness(): void {
    if (this.phase === 'closed') return;
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      if (this.live) {
        this.live = false;
        this.h.onLivenessLost?.();
      }
    }, this.livenessWindowMs);
    this.livenessTimer.unref?.();
  }

  /** The single close transition: idempotent, rejects pending work. */
  private teardown(reason: Error): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.live = false;
    if (this.deadline !== undefined) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
    if (this.livenessTimer !== undefined) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    if (this.keepalive !== undefined) {
      clearTimeout(this.keepalive);
      this.keepalive = undefined;
    }
    this.lease = undefined;
    this.pendingInput = undefined;
    const sock = this.sock;
    this.sock = null;
    sock?.destroy();
    const pending = this.pendingAttach;
    this.pendingAttach = undefined;
    pending?.reject(reason);
    const authenticating = this.pendingAuthenticate;
    this.pendingAuthenticate = undefined;
    authenticating?.reject(reason);
    for (const slot of [this.pendingTerminate, this.pendingRelease, this.pendingLogClear]) {
      if (slot === undefined) continue;
      clearTimeout(slot.timer);
      slot.reject(reason);
    }
    this.pendingTerminate = undefined;
    this.pendingRelease = undefined;
    this.pendingLogClear = undefined;
  }

  private onData(chunk: Buffer): void {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.h.onRaw?.(bytes);
    let messages;
    try {
      messages = this.codec.feed(Date.now(), bytes);
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const message of messages) {
      // A prior message in this chunk may have closed the client; stop routing.
      if (this.phase === 'closed') return;
      this.route(message);
    }
    // Opt-in §6.1 consumption policy: one coalesced watermark ack per
    // delivered batch, only when the watermark actually advanced.
    if (this.autoAck && this.phase === 'attached' && this.highestReceived > this.lastAcked) {
      this.lastAcked = this.highestReceived;
      this.request({ type: 'output-ack', sequence: this.lastAcked });
    }
  }

  private route(message: { scope: number; kind: number; payload: Uint8Array }): void {
    // EVERY decode failure takes the same fail-closed path: report + close THIS
    // client. A malformed frame from one bad holder must never throw across the
    // socket 'data' callback and take down the multi-session daemon.
    let decoded: MoorHolderMessage;
    try {
      decoded = decodeMoorHolderMessage(message, {
        identity: this.identity,
        generation: this.generation,
        ...(this.incarnation === undefined ? {} : { incarnation: this.incarnation })
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    try {
      this.routeDecoded(decoded);
    } catch (error) {
      this.fail(error);
    }
  }

  private routeDecoded(decoded: MoorHolderMessage): void {
    switch (decoded.type) {
      case 'hello-ack': {
        this.requirePhase(decoded.type, this.phase === 'hello-sent');
        this.incarnation = decoded.incarnation;
        // §6.1: record sequences reset per holder incarnation. A cursor bound
        // to a DIFFERENT incarnation is void — everything is new. An unbound
        // (or same-incarnation) cursor stays in force and is checked against
        // the ACK high-water below.
        this.effectiveResume =
          this.resumeIncarnation !== undefined &&
          !bytesEqual(this.resumeIncarnation, decoded.incarnation)
            ? 0n
            : this.resumeSequence;
        this.phase = 'adopted';
        this.h.onHelloAck?.(decoded);
        const authenticating = this.pendingAuthenticate;
        if (authenticating !== undefined) {
          // Probe-scope exchange: adoption IS the outcome — no ATTACH follows.
          this.pendingAuthenticate = undefined;
          if (this.deadline !== undefined) {
            clearTimeout(this.deadline);
            this.deadline = undefined;
          }
          authenticating.resolve();
          return;
        }
        const pending = this.pendingAttach;
        if (pending === undefined) {
          throw new MoorWireError('BAD_SEQUENCE', 'HELLO_ACK without a pending attach or authenticate');
        }
        this.request({
          type: 'attach',
          columns: pending.options.columns,
          rows: pending.options.rows,
          requestLease: pending.options.requestLease,
          nonVt: pending.options.nonVt ?? false
        });
        return;
      }
      case 'terminal-state': {
        // §6: exactly once per attaching connection, before ATTACH_ACK.
        this.requirePhase(decoded.type, this.phase === 'adopted');
        this.preambleBytes = decoded.bytes;
        this.phase = 'preamble';
        this.h.onTerminalState?.(decoded.bytes);
        return;
      }
      case 'attach-ack': {
        // §6 order is exact: an ACK without the preceding preamble is refused,
        // and this viewer attach is fully attached before the ACK is queued —
        // an ACK that does not reflect viewer presence is a contract breach.
        this.requirePhase(decoded.type, this.phase === 'preamble');
        if (!decoded.status.viewers) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            'ATTACH_ACK does not reflect this fully attached viewer'
          );
        }
        // §6.1: the cursor claims records this incarnation already produced;
        // one above the ACK high-water is a contradiction (wrong incarnation
        // or corrupt cursor) and must fail closed, never silently suppress
        // the records the holder is about to send.
        if (this.effectiveResume > decoded.status.replay.last) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            `resume cursor ${this.effectiveResume} exceeds this incarnation's high-water ${decoded.status.replay.last}`
          );
        }
        this.status = decoded.status;
        // §6.1 output continuity: the replay baseline starts at record 1 and
        // the retained start offset. A discarded prefix must arrive as exactly
        // one GAP{1, first-1} before any replay output; empty history emits
        // neither and live records begin at sequence 1.
        this.expectedSequence = 1n;
        this.expectedOffset = decoded.status.replay.start;
        this.baselineGap =
          decoded.status.replay.first > 1n
            ? { last: decoded.status.replay.first - 1n }
            : undefined;
        // A requested fresh viewer lease occupies the next prefix slot; until
        // its LEASE_RESULT arrives the attach is incomplete: the deadline keeps
        // running, the promise stays pending, and no replay/live frame may
        // overtake the slot.
        if (this.pendingAttach?.options.requestLease === true) {
          this.phase = 'lease-pending';
          this.h.onAttachAck?.(decoded.status);
          return;
        }
        this.phase = 'attached';
        this.live = true; // the authenticated exchange is verified-live evidence
        this.armLiveness();
        if (this.deadline !== undefined) {
          clearTimeout(this.deadline);
          this.deadline = undefined;
        }
        const pending = this.pendingAttach;
        this.pendingAttach = undefined;
        this.h.onAttachAck?.(decoded.status);
        pending?.resolve(decoded.status);
        return;
      }
      case 'lease-result': {
        // Standalone slot first: §7.4 — LEASE_RELEASE always receives a
        // LEASE_RESULT. Released (02) invalidates the local grant; refused
        // (03) reports not-held/mismatch WITHOUT holder mutation. Any other
        // outcome cannot answer a release.
        if (this.phase === 'attached' && this.pendingRelease !== undefined) {
          const release = this.pendingRelease;
          this.pendingRelease = undefined;
          clearTimeout(release.timer);
          // The slot is already consumed: every violation below REJECTS the
          // caller explicitly, then throws so the fail-closed path also
          // closes this client — a swallowed mismatch must neither resolve
          // nor hang the release.
          const violate = (message: string): never => {
            const error = new MoorWireError('BAD_SEQUENCE', message);
            release.reject(error);
            throw error;
          };
          if (decoded.role !== 0) {
            // This client only ever holds a VIEWER lease — any other role
            // cannot answer its release.
            violate(`LEASE_RESULT role ${decoded.role} cannot answer a viewer release`);
          }
          if (decoded.outcome === 2) {
            // Released reports ITS nonzero epoch — the exact tuple this
            // release submitted. An unrelated epoch's released result must
            // never clear this grant.
            if (decoded.epoch !== release.epoch) {
              violate(
                `LEASE_RESULT released epoch ${decoded.epoch} does not echo the submitted ${release.epoch}`
              );
            }
            this.lease = undefined;
            this.pendingInput = undefined;
            release.resolve('released');
            return;
          }
          if (decoded.outcome === 3) {
            // Refusal legitimately reports the CURRENT allocated epoch (which
            // may differ from the submitted tuple) and mutates nothing.
            release.resolve('refused');
            return;
          }
          violate(`LEASE_RESULT outcome ${decoded.outcome} cannot answer a release`);
        }
        // Attach slot: legal only at its reserved §6 prefix position, and it
        // must agree with the ACK that preceded it. The attach shorthand
        // requested a FRESH viewer lease, so the only outcomes that can
        // answer it are granted (00) or refused (03; busy is refused with
        // reason 01) — resumed (01) and released (02) belong to standalone
        // lease traffic. The holder decided the lease at attach time
        // (ownsLease ⇔ granted), every outcome reports the ACK's current
        // epoch, and this client only ever attaches as a viewer.
        this.requirePhase(decoded.type, this.phase === 'lease-pending');
        const status = this.status!;
        const granted = decoded.outcome === 0;
        if (
          (decoded.outcome !== 0 && decoded.outcome !== 3) ||
          decoded.role !== 0 ||
          granted !== status.ownsLease ||
          decoded.epoch !== status.leaseEpoch
        ) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            'LEASE_RESULT does not match the attach status'
          );
        }
        this.phase = 'attached';
        this.live = true; // the authenticated exchange is verified-live evidence
        this.armLiveness();
        if (this.deadline !== undefined) {
          clearTimeout(this.deadline);
          this.deadline = undefined;
        }
        // Granted: adopt epoch + token and keep the lease alive on the 3 s
        // idle cadence. §7.3: a new lease epoch resets the high-water mark,
        // so its first request id is 1. Refused leaves an attached observer.
        if (granted) {
          this.lease = { epoch: decoded.epoch, token: decoded.token.slice() };
          this.nextRequestId = 1n;
          this.keepaliveEmitted = false; // no keepalive has been sent for this grant yet
          this.scheduleKeepalive();
        }
        const pending = this.pendingAttach;
        this.pendingAttach = undefined;
        this.h.onLeaseResult?.(decoded);
        pending?.resolve(status);
        return;
      }
      case 'status-reply':
        this.requirePhase(decoded.type, this.phase === 'attached');
        this.status = decoded.status;
        // §7.5: lease ownership is holder truth. A status reporting that this
        // connection no longer owns the lease — or owns it under a DIFFERENT
        // epoch than the local grant — invalidates the stale local grant:
        // later input/resize must fail locally instead of forging stale lease
        // frames, the keepalive stops, and the in-flight input slot is
        // released (§7.3: "acknowledged or the lease is lost").
        if (
          this.lease !== undefined &&
          (!decoded.status.ownsLease || decoded.status.leaseEpoch !== this.lease.epoch)
        ) {
          this.lease = undefined;
          this.pendingInput = undefined;
          if (this.keepalive !== undefined) {
            clearTimeout(this.keepalive);
            this.keepalive = undefined;
          }
        }
        this.h.onStatusReply?.(decoded.status);
        return;
      case 'output': {
        // §6.1: record sequences increase by exactly one; byte offsets are
        // contiguous. A skipped record without an explicit GAP is a breach,
        // and no output may precede the pending discarded-prefix GAP.
        this.requirePhase(decoded.type, this.phase === 'attached');
        if (this.baselineGap !== undefined) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            'OUTPUT before the discarded-prefix GAP of the frozen baseline'
          );
        }
        if (decoded.sequence !== this.expectedSequence) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            `OUTPUT sequence ${decoded.sequence} does not continue ${this.expectedSequence}`
          );
        }
        if (decoded.offset !== this.expectedOffset) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            `OUTPUT offset ${decoded.offset} does not continue ${this.expectedOffset}`
          );
        }
        const end = decoded.offset + BigInt(decoded.bytes.length);
        // §6.1: the ACK's retained byte range is half-open [start, end) — the
        // final frozen replay record must land exactly on replay.end.
        const replay = this.status!.replay;
        if (replay.first !== 0n && decoded.sequence === replay.last && end !== replay.end) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            `replay boundary record ends at ${end}, the ACK promised ${replay.end}`
          );
        }
        this.expectedSequence += 1n;
        this.expectedOffset = end;
        this.highestReceived = decoded.sequence;
        // §6.1 reconnect: a controller with an existing cursor discards
        // duplicate record sequences instead of re-delivering them.
        if (decoded.sequence > this.effectiveResume) this.h.onOutput?.(decoded);
        return;
      }
      case 'gap': {
        // §6.1 freezes GAP to one position: the attach baseline's discarded
        // prefix, exactly GAP{1, first_retained-1}. Records stream in order on
        // a live connection, so any other GAP is a protocol breach. After the
        // baseline gap the next record is first_retained at the retained start
        // offset, which the ACK already established.
        this.requirePhase(decoded.type, this.phase === 'attached');
        const baseline = this.baselineGap;
        if (baseline === undefined) {
          throw new MoorWireError('BAD_SEQUENCE', 'GAP outside the frozen attach baseline');
        }
        if (decoded.first !== 1n || decoded.last !== baseline.last) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            `GAP {${decoded.first},${decoded.last}} is not the baseline {1,${baseline.last}}`
          );
        }
        this.baselineGap = undefined;
        this.expectedSequence = decoded.last + 1n;
        // A gap wholly at or below the reconnect cursor names records the
        // previous connection already consumed — nothing to report.
        if (decoded.last > this.effectiveResume) this.h.onGap?.(decoded);
        return;
      }
      case 'input-receipt': {
        // §7.2/§7.3: the receipt must match the pending tuple across epoch,
        // request id, generation, and incarnation, and its byte count must
        // describe the sent input — a written receipt means the COMPLETE
        // write finished; a refusal can never claim more than was sent.
        this.requirePhase(decoded.type, this.phase === 'attached');
        const pending = this.pendingInput;
        if (
          pending === undefined ||
          decoded.requestId !== pending.requestId ||
          decoded.epoch !== pending.epoch ||
          decoded.generation !== this.generation ||
          this.incarnation === undefined ||
          !bytesEqual(decoded.incarnation, this.incarnation)
        ) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            'INPUT_RECEIPT does not match the pending input request'
          );
        }
        const sent = BigInt(pending.bytes.length);
        if (decoded.status === 0 ? decoded.written !== sent : decoded.written > sent) {
          throw new MoorWireError(
            'BAD_SEQUENCE',
            `INPUT_RECEIPT byte count ${decoded.written} does not describe the ${sent}-byte request`
          );
        }
        this.pendingInput = undefined;
        this.h.onInputReceipt?.(decoded);
        return;
      }
      case 'terminate-result': {
        this.requirePhase(decoded.type, this.phase === 'attached');
        const terminate = this.pendingTerminate;
        if (terminate !== undefined) {
          this.pendingTerminate = undefined;
          clearTimeout(terminate.timer);
          terminate.resolve(decoded);
        }
        this.h.onTerminateResult?.(decoded);
        return;
      }
      case 'log-clear-result': {
        this.requirePhase(decoded.type, this.phase === 'attached');
        const logClear = this.pendingLogClear;
        if (logClear !== undefined) {
          this.pendingLogClear = undefined;
          clearTimeout(logClear.timer);
          // The result must ECHO the submitted observed frontier as its
          // prior — a result for a different frontier answers a different
          // request and must never resolve this one. Reject the caller
          // explicitly, then throw so the fail-closed path closes the client.
          if (decoded.prior !== logClear.observed) {
            const error = new MoorWireError(
              'BAD_SEQUENCE',
              `LOG_CLEAR_RESULT prior ${decoded.prior} does not echo the submitted observed ${logClear.observed}`
            );
            logClear.reject(error);
            throw error;
          }
          logClear.resolve(decoded);
        }
        this.h.onLogClearResult?.(decoded);
        return;
      }
      case 'query':
        this.requirePhase(decoded.type, this.phase === 'attached');
        this.h.onQuery?.(decoded);
        return;
      case 'error': {
        // Holder refusals are legal in every post-HELLO phase. While the
        // attach prefix is still pending, a holder ERROR IS the refusal —
        // fail the attach now instead of waiting out the deadline. While
        // attached, LEASE_NOT_HELD (15) is holder truth that our lease is
        // gone: drop it exactly like a status ownership loss (§7.5).
        this.h.onHolderError?.(decoded.code, decoded.diagnostic);
        if (this.pendingAttach !== undefined) {
          this.teardown(
            new Error(`moor holder refused the attach with error code ${decoded.code}`)
          );
          return;
        }
        if (decoded.code === 15 && this.lease !== undefined) {
          // §7.5: an invalid keepalive response closes exactly this
          // connection — once a keepalive for the current grant was actually
          // emitted, LEASE_NOT_HELD is its refusal. Before any keepalive it
          // refuses a single lease-owned frame: drop the grant, stay attached.
          if (this.keepaliveEmitted) {
            this.teardown(new Error('moor holder refused an emitted lease keepalive'));
            return;
          }
          this.lease = undefined;
          this.pendingInput = undefined;
          if (this.keepalive !== undefined) {
            clearTimeout(this.keepalive);
            this.keepalive = undefined;
          }
        }
        return;
      }
      case 'heartbeat':
        // §10: heartbeats run while a controller is attached — never earlier.
        // Each one refreshes the 15 s verified-live window.
        this.requirePhase(decoded.type, this.phase === 'lease-pending' || this.phase === 'attached');
        if (!this.live) {
          this.live = true;
          this.h.onLivenessRestored?.();
        }
        this.armLiveness();
        this.h.onHeartbeat?.(decoded.monotonicMs, decoded.flags);
        return;
      case 'wakeup':
        // §10.2.11 (OB-30): WAKEUP is an UNSOLICITED, coalescible notice that
        // the durable event stream advanced. It is not part of the §6 attach
        // order and the holder owes it no position there: the child can write
        // — and the store can commit — at any instant after the connection is
        // adopted, including while ATTACH is still in flight. Restricting it
        // to the post-ACK phases made a legal frame fatal: manual QA on a
        // clean install could not attach ANY session whose child produced
        // output during the handshake (every `bash` with a real TERM), and
        // the daemon reported nothing but `attach-failed`.
        //
        // Before adoption the rule still holds: nothing may precede identity.
        this.requirePhase(
          decoded.type,
          this.phase === 'adopted' ||
            this.phase === 'preamble' ||
            this.phase === 'lease-pending' ||
            this.phase === 'attached'
        );
        this.h.onWakeup?.();
        return;
    }
  }

  private requirePhase(kind: string, valid: boolean): void {
    if (!valid) {
      throw new MoorWireError('BAD_SEQUENCE', `${kind} is not legal in connection phase ${this.phase}`);
    }
  }

  private fail(error: unknown): void {
    if (error instanceof MoorWireError) {
      this.h.onProtocolError?.(error);
      this.teardown(error);
      return;
    }
    this.teardown(error instanceof Error ? error : new Error(String(error)));
    throw error; // a non-wire bug must still surface
  }
}
