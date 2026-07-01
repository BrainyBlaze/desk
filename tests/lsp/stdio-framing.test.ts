import { describe, expect, it } from 'vitest';
import { LspStdioMessageParser, encodeLspMessage } from '../../src/server/lsp/stdioFraming';

describe('stdio Content-Length framing', () => {
  it('round-trips a JSON-RPC message split across chunks', () => {
    const received: unknown[] = [];
    const parser = new LspStdioMessageParser((message) => {
      received.push(message);
    });
    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'textDocument/hover',
      params: { label: '\u03bb' }
    };

    const framed = encodeLspMessage(message);
    const headerEnd = framed.indexOf('\r\n\r\n');
    expect(framed.toString('ascii', 0, headerEnd)).toBe(
      `Content-Length: ${Buffer.byteLength(JSON.stringify(message), 'utf8')}`
    );

    parser.push(framed.subarray(0, 9));
    parser.push(framed.subarray(9));

    expect(received).toEqual([message]);
  });
});
