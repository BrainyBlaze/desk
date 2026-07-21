// Daemon-side master client (spec §7.1 data plane, §4 wire). The transport that
// connects a session's atch master socket to a SessionRuntime: does the v3
// HELLO/ATTACH handshake, reassembles incoming frames into RECORD envelopes, and
// sends INPUT/RESIZE/COMMAND back. Node net + the shipped v3 codec — testable
// against a fake v3 master today; the real atch binary (once its master speaks
// v3 over the socket, @codex's lane) drops in behind the same socket path.

import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { FrameReassembler, encodeFrame, type RawFrame, WireError } from '../../shared/atchWire/codec.js';
import { Cap, FrameType, Role } from '../../shared/atchWire/frames.js';
import { decodeBody, decodeRecord, encodeBody, type Body, type RecordEnvelope } from '../../shared/atchWire/messages.js';

export interface MasterClientHandlers {
  onRecord?: (rec: RecordEnvelope) => void;
  onAttachAck?: (ack: Body) => void;
  onError?: (code: number, detail: string) => void;
  onClose?: () => void;
  /** A decode/protocol failure on the incoming stream. */
  onProtocolError?: (err: WireError) => void;
}

export interface AttachOptions {
  role: Role;
  sessionId: string;
  rows: number;
  cols: number;
  prevGeneration?: number;
  lastSeenOffset?: bigint;
  lastSeenRecordSeq?: bigint;
}

const CLIENT_CAPS = Cap.RECORD | Cap.COMMAND | Cap.CHECKPOINT | Cap.SIGNAL | Cap.STATE_UPDATE | Cap.REDRAW;

export class MasterClient {
  private sock: Socket | null = null;
  private readonly ra = new FrameReassembler();
  private readonly h: MasterClientHandlers;
  private seq = 0n;
  /** Session generation, learned from ATTACH_ACK. Post-attach frames (INPUT/
   *  RESIZE/COMMAND) MUST carry it — the master fences frames whose generation
   *  != its own (spawn-assigned) generation. 0 until ATTACH_ACK (HELLO/ATTACH
   *  are pre-attach and generation-agnostic). */
  private generation = 0;
  private readonly incarnation = randomBytes(16);

  constructor(private readonly sockPath: string, handlers: MasterClientHandlers = {}) {
    this.h = handlers;
  }

  /** Connect the socket (resolves once TCP/unix connect completes). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.sockPath);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.removeListener('error', reject);
        this.sock = sock;
        sock.on('data', (chunk: Buffer) => this.onData(chunk));
        sock.on('error', () => this.close());
        sock.on('close', () => this.h.onClose?.());
        resolve();
      });
    });
  }

  /** Send HELLO then ATTACH — the v3 handshake (§4). */
  handshake(opts: AttachOptions): void {
    this.sendBody(FrameType.HELLO, { client_version: 3, peer_role: opts.role, capabilities: CLIENT_CAPS, incarnation: this.incarnation });
    this.sendBody(FrameType.ATTACH, {
      role: opts.role,
      prev_generation: opts.prevGeneration ?? 0,
      last_seen_offset: opts.lastSeenOffset ?? 0n,
      last_seen_record_seq: opts.lastSeenRecordSeq ?? 0n,
      desired_rows: opts.rows,
      desired_cols: opts.cols,
      sessionId: opts.sessionId
    });
  }

  /** Forward browser input to the master (§7.6 — flags bit0 = binary channel). */
  sendInput(bytes: Uint8Array, binary: boolean, surfaceId: number): void {
    this.sendBody(FrameType.INPUT, { flags: binary ? 1 : 0, surface_id: surfaceId, bytes });
  }

  /** Resize the master's PTY (only the lease owner should call this, §7.5). */
  sendResize(rows: number, cols: number, leaseEpoch: number, surfaceId: number, generation: number): void {
    this.sendBody(FrameType.RESIZE, { lease_epoch: leaseEpoch, surface_id: surfaceId, generation, rows, cols });
  }

  /** Send an already-built raw frame (e.g. a COMMAND from the delivery engine). */
  send(frame: RawFrame): void {
    this.sock?.write(encodeFrame(frame));
  }

  close(): void {
    if (this.sock !== null) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  // ---- internals ------------------------------------------------------------
  private sendBody(type: FrameType, body: Body): void {
    const payload = encodeBody(type, body);
    this.send({ type, flags: 0, generation: this.generation, sequence: this.seq++, aux: 0n, payload });
  }

  private onData(chunk: Buffer): void {
    let frames: RawFrame[];
    try {
      frames = this.ra.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (e) {
      if (e instanceof WireError) this.h.onProtocolError?.(e);
      this.close();
      return;
    }
    for (const f of frames) this.route(f);
  }

  private route(f: RawFrame): void {
    switch (f.type) {
      case FrameType.RECORD:
        try {
          this.h.onRecord?.(decodeRecord(f.payload));
        } catch (e) {
          if (e instanceof WireError) this.h.onProtocolError?.(e);
        }
        return;
      case FrameType.ATTACH_ACK: {
        const ack = decodeBody(FrameType.ATTACH_ACK, f.payload);
        // Adopt the session generation so post-attach frames pass the master's fence.
        this.generation = (ack as { generation: number }).generation;
        this.h.onAttachAck?.(ack);
        return;
      }
      case FrameType.ERROR: {
        const body = decodeBody(FrameType.ERROR, f.payload) as { code: number; detail: string };
        this.h.onError?.(body.code, body.detail);
        return;
      }
      case FrameType.HELLO:
      case FrameType.OUTPUT_ACK:
      case FrameType.HEARTBEAT:
        return; // negotiation / ack / keepalive — no runtime action needed here
      default:
        return; // lease/checkpoint/etc. handled by dedicated paths as wired
    }
  }
}
