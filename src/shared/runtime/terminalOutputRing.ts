interface RingChunk {
  offset: bigint;
  bytes: Uint8Array;
}

/** A bounded, contiguous suffix of the authoritative terminal byte stream. */
export class TerminalOutputRing {
  readonly maxBytes: number;
  private chunks: RingChunk[] = [];
  private totalBytes = 0;
  private endOffset: bigint | undefined;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('terminal output ring maxBytes must be a positive integer');
    }
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  append(offset: bigint, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.endOffset !== undefined && offset !== this.endOffset) this.clear();

    const end = offset + BigInt(bytes.length);
    let retainedOffset = offset;
    let retained = bytes.slice();
    if (retained.length > this.maxBytes) {
      const dropped = retained.length - this.maxBytes;
      retainedOffset += BigInt(dropped);
      retained = retained.slice(dropped);
    }

    this.chunks.push({ offset: retainedOffset, bytes: retained });
    this.totalBytes += retained.length;
    this.endOffset = end;
    this.trimOldest();
  }

  read(from: bigint, to: bigint): Uint8Array | undefined {
    if (from > to) return undefined;
    if (from === to) return new Uint8Array();
    const length = to - from;
    if (length > BigInt(this.maxBytes)) return undefined;

    const output = new Uint8Array(Number(length));
    let cursor = from;
    let written = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.offset + BigInt(chunk.bytes.length);
      if (chunkEnd <= cursor) continue;
      if (chunk.offset > cursor) return undefined;

      const sourceStart = Number(cursor - chunk.offset);
      const available = Math.min(chunk.bytes.length - sourceStart, output.length - written);
      output.set(chunk.bytes.subarray(sourceStart, sourceStart + available), written);
      cursor += BigInt(available);
      written += available;
      if (cursor === to) return output;
    }
    return undefined;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.endOffset = undefined;
  }

  private trimOldest(): void {
    let overflow = this.totalBytes - this.maxBytes;
    while (overflow > 0) {
      const first = this.chunks[0];
      if (first === undefined) break;
      if (first.bytes.length <= overflow) {
        this.chunks.shift();
        this.totalBytes -= first.bytes.length;
        overflow -= first.bytes.length;
        continue;
      }
      first.offset += BigInt(overflow);
      first.bytes = first.bytes.slice(overflow);
      this.totalBytes -= overflow;
      overflow = 0;
    }
  }
}
