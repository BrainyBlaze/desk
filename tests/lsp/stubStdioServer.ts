export interface StubStdioServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function createStubStdioServerCommand(options: {
  cwdFile: string;
  initializedFile: string;
  initializeFile?: string;
}): StubStdioServerCommand {
  return {
    command: process.execPath,
    args: ['--input-type=module', '--eval', FAKE_STDIO_SERVER_SOURCE],
    env: {
      FAKE_LSP_CWD_FILE: options.cwdFile,
      FAKE_LSP_INITIALIZED_FILE: options.initializedFile,
      ...(options.initializeFile ? { FAKE_LSP_INITIALIZE_FILE: options.initializeFile } : {})
    }
  };
}

const FAKE_STDIO_SERVER_SOURCE = `
import { writeFileSync } from 'node:fs';

let buffer = Buffer.alloc(0);

if (process.env.FAKE_LSP_CWD_FILE) {
  writeFileSync(process.env.FAKE_LSP_CWD_FILE, process.cwd(), 'utf8');
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(\`Content-Length: \${body.byteLength}\\r\\n\\r\\n\`, 'ascii'), body]);
}

function handle(message) {
  if (message.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    if (process.env.FAKE_LSP_INITIALIZE_FILE) {
      writeFileSync(process.env.FAKE_LSP_INITIALIZE_FILE, JSON.stringify(message.params), 'utf8');
    }
    process.stdout.write(encode({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          hoverProvider: true,
          definitionProvider: true
        }
      }
    }));
    return;
  }

  if (message.method === 'textDocument/hover' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    process.stdout.write(encode({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        contents: \`hover \${message.params.position.line}:\${message.params.position.character}\`
      }
    }));
    return;
  }

  if (message.method === 'initialized' && process.env.FAKE_LSP_INITIALIZED_FILE) {
    writeFileSync(process.env.FAKE_LSP_INITIALIZED_FILE, 'initialized', 'utf8');
  }
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.toString('ascii', 0, headerEnd);
    const match = /^Content-Length:\\s*(\\d+)$/im.exec(header);
    if (!match) {
      throw new Error('missing Content-Length');
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.toString('utf8', bodyStart, bodyEnd);
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.resume();
`;
