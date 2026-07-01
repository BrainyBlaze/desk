interface RingChunk {
  data: string;
  bytes: number;
}

export class TerminalOutputRing {
  readonly maxBytes: number;
  private chunks: RingChunk[] = [];
  private totalBytes = 0;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('terminal output ring maxBytes must be a positive integer');
    }
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  append(chunk: string): void {
    if (chunk === '') {
      return;
    }
    const bounded = this.trimToCap(chunk);
    const bytes = Buffer.byteLength(bounded);
    this.chunks.push({ data: bounded, bytes });
    this.totalBytes += bytes;
    this.trimOldest();
  }

  snapshot(): string {
    return this.chunks.map((chunk) => chunk.data).join('');
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }

  private trimToCap(chunk: string): string {
    let data = chunk;
    while (Buffer.byteLength(data) > this.maxBytes) {
      data = data.slice(1);
    }
    return data;
  }

  private trimOldest(): void {
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks.shift();
      if (first) {
        this.totalBytes -= first.bytes;
      }
    }
  }
}
