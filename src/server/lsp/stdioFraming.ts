export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

export class LspStdioMessageParser {
  private buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Buffer | string): void {
    const next = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = Buffer.concat([this.buffer, next]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const contentLength = readContentLength(this.buffer.toString('ascii', 0, headerEnd));
      const bodyStart = headerEnd + 4;
      const frameEnd = bodyStart + contentLength;
      if (this.buffer.length < frameEnd) {
        return;
      }

      const body = this.buffer.toString('utf8', bodyStart, frameEnd);
      this.buffer = this.buffer.subarray(frameEnd);
      this.onMessage(JSON.parse(body));
    }
  }
}

function readContentLength(header: string): number {
  for (const line of header.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)$/i.exec(line);
    if (match) {
      return Number(match[1]);
    }
  }
  throw new Error('LSP stdio frame missing Content-Length header');
}
