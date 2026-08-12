import { crc32c } from './crc32c.js';
import {
  MOOR_HEADER_SIZE,
  MOOR_FIXED_PAYLOAD_LENGTHS,
  MOOR_MAGIC,
  MOOR_MAX_FRAME_PAYLOAD,
  MOOR_MAX_MESSAGE_PAYLOAD,
  MOOR_VERSION,
  MoorWireError,
  assertMoorPayloadLength,
  assertMoorScope
} from './schema.js';

export interface MoorMessage {
  readonly scope: number;
  readonly kind: number;
  readonly payload: Uint8Array;
}

interface ReassemblyRun {
  readonly scope: number;
  readonly kind: number;
  readonly fragments: Uint8Array[];
  length: number;
}

export class MoorCodec {
  private nextOutboundSequence = 1;
  private nextInboundSequence = 1;
  private inboundBuffer = new Uint8Array();
  private reassembly: ReassemblyRun | undefined;
  private inboundDeadline: number | undefined;
  private inboundFailure: MoorWireError | undefined;

  encode(scope: number, kind: number, payload: Uint8Array): Uint8Array {
    assertMoorScope(scope, kind);
    assertMoorPayloadLength(kind, payload.length);

    const frameCount = Math.ceil(Math.max(payload.length, 1) / MOOR_MAX_FRAME_PAYLOAD);
    const availableSequences = 0xffffffff - this.nextOutboundSequence;
    if (
      this.nextOutboundSequence === 0 ||
      this.nextOutboundSequence === 0xffffffff ||
      frameCount > availableSequences
    ) {
      throw new MoorWireError('RESOURCE_EXHAUSTED', 'outbound frame sequence exhausted');
    }

    const encoded = new Uint8Array(payload.length + frameCount * MOOR_HEADER_SIZE);
    let outputOffset = 0;
    for (let part = 0; part < frameCount; part += 1) {
      const payloadStart = part * MOOR_MAX_FRAME_PAYLOAD;
      const payloadEnd = Math.min(payload.length, payloadStart + MOOR_MAX_FRAME_PAYLOAD);
      const framePayload = payload.subarray(payloadStart, payloadEnd);
      const header = encoded.subarray(outputOffset, outputOffset + MOOR_HEADER_SIZE);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

      header.set(MOOR_MAGIC, 0);
      view.setUint8(4, MOOR_VERSION);
      view.setUint8(5, kind);
      view.setUint8(6, part + 1 < frameCount ? 1 : 0);
      view.setUint8(7, 0);
      view.setUint32(8, scope, true);
      view.setUint32(12, this.nextOutboundSequence, true);
      view.setUint32(16, framePayload.length, true);
      view.setUint32(20, crc32c(header.subarray(0, 20)), true);

      encoded.set(framePayload, outputOffset + MOOR_HEADER_SIZE);
      outputOffset += MOOR_HEADER_SIZE + framePayload.length;
      this.nextOutboundSequence += 1;
    }
    return encoded;
  }

  feed(nowMs: number, bytes: Uint8Array): MoorMessage[] {
    this.assertInboundOpen();
    try {
      this.expireOpen(nowMs);
      this.appendInbound(bytes);
      const messages: MoorMessage[] = [];

      while (this.inboundBuffer.length >= MOOR_HEADER_SIZE) {
        const header = this.decodeHeader(this.inboundBuffer.subarray(0, MOOR_HEADER_SIZE));
        const frameLength = MOOR_HEADER_SIZE + header.length;
        if (this.inboundBuffer.length < frameLength) break;

        const payload = this.inboundBuffer.slice(MOOR_HEADER_SIZE, frameLength);
        this.inboundBuffer =
          frameLength === this.inboundBuffer.length
            ? new Uint8Array()
            : this.inboundBuffer.slice(frameLength);
        this.nextInboundSequence += 1;

        const run = this.appendFragment(header.scope, header.kind, payload);
        if (header.more === 1) {
          this.reassembly = run;
          continue;
        }

        this.reassembly = undefined;
        this.inboundDeadline = undefined;
        messages.push({
          scope: run.scope,
          kind: run.kind,
          payload: joinFragments(run.fragments, run.length)
        });
      }

      if (this.inboundBuffer.length !== 0 || this.reassembly !== undefined) {
        this.inboundDeadline ??= nowMs + 5_000;
      }
      return messages;
    } catch (error) {
      throw this.failInbound(error);
    }
  }

  expire(nowMs: number): void {
    this.assertInboundOpen();
    try {
      this.expireOpen(nowMs);
    } catch (error) {
      throw this.failInbound(error);
    }
  }

  get bufferedLength(): number {
    return this.inboundBuffer.length + (this.reassembly?.length ?? 0);
  }

  private appendInbound(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const combined = new Uint8Array(this.inboundBuffer.length + bytes.length);
    combined.set(this.inboundBuffer, 0);
    combined.set(bytes, this.inboundBuffer.length);
    this.inboundBuffer = combined;
  }

  private decodeHeader(header: Uint8Array): {
    scope: number;
    kind: number;
    more: number;
    length: number;
  } {
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    for (let index = 0; index < MOOR_MAGIC.length; index += 1) {
      if (header[index] !== MOOR_MAGIC[index]) {
        throw new MoorWireError('MALFORMED', 'invalid controller magic');
      }
    }
    if (view.getUint8(4) !== MOOR_VERSION) {
      throw new MoorWireError('UNKNOWN_VERSION', `unsupported controller version ${view.getUint8(4)}`);
    }

    const kind = view.getUint8(5);
    const more = view.getUint8(6);
    const reserved = view.getUint8(7);
    const scope = view.getUint32(8, true);
    assertMoorScope(scope, kind);
    if (more > 1 || reserved !== 0) {
      throw new MoorWireError('MALFORMED', 'invalid frame flags or reserved byte');
    }
    if (more === 1 && MOOR_FIXED_PAYLOAD_LENGTHS.has(kind)) {
      throw new MoorWireError('MALFORMED', `fixed-size kind ${kind} cannot be fragmented`);
    }

    const sequence = view.getUint32(12, true);
    if (
      sequence !== this.nextInboundSequence ||
      this.nextInboundSequence === 0 ||
      this.nextInboundSequence === 0xffffffff
    ) {
      const code =
        this.nextInboundSequence === 0xffffffff ? 'RESOURCE_EXHAUSTED' : 'BAD_SEQUENCE';
      throw new MoorWireError(code, `expected sequence ${this.nextInboundSequence}, received ${sequence}`);
    }

    const length = view.getUint32(16, true);
    if (length > MOOR_MAX_FRAME_PAYLOAD) {
      throw new MoorWireError('OVERSIZED_FRAME', `frame payload length ${length} exceeds ${MOOR_MAX_FRAME_PAYLOAD}`);
    }
    if (view.getUint32(20, true) !== crc32c(header.subarray(0, 20))) {
      throw new MoorWireError('MALFORMED', 'invalid frame header CRC-32C');
    }
    return { scope, kind, more, length };
  }

  private appendFragment(scope: number, kind: number, payload: Uint8Array): ReassemblyRun {
    const run = this.reassembly ?? { scope, kind, fragments: [], length: 0 };
    if (run.scope !== scope || run.kind !== kind) {
      throw new MoorWireError('REASSEMBLY_ABORTED', 'fragment kind or scope changed');
    }
    const length = run.length + payload.length;
    if (!Number.isSafeInteger(length) || length > MOOR_MAX_MESSAGE_PAYLOAD) {
      throw new MoorWireError('OVERSIZED_MESSAGE', 'reassembled message exceeds controller limit');
    }
    run.fragments.push(payload);
    run.length = length;
    return run;
  }

  private expireOpen(nowMs: number): void {
    if (this.inboundDeadline !== undefined && nowMs >= this.inboundDeadline) {
      throw new MoorWireError('REASSEMBLY_TIMEOUT', 'incomplete frame or message timed out');
    }
  }

  private assertInboundOpen(): void {
    if (this.inboundFailure !== undefined) throw this.inboundFailure;
  }

  private failInbound(error: unknown): MoorWireError {
    if (this.inboundFailure !== undefined) return this.inboundFailure;
    this.inboundBuffer = new Uint8Array();
    this.reassembly = undefined;
    this.inboundDeadline = undefined;
    this.inboundFailure =
      error instanceof MoorWireError
        ? error
        : new MoorWireError('MALFORMED', error instanceof Error ? error.message : String(error));
    return this.inboundFailure;
  }
}

function joinFragments(fragments: Uint8Array[], length: number): Uint8Array {
  if (fragments.length === 1) return fragments[0]!;
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const fragment of fragments) {
    payload.set(fragment, offset);
    offset += fragment.length;
  }
  return payload;
}
