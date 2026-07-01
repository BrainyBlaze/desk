import { readFileSync } from 'node:fs';

export interface StubBridgeStdioServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface StubBridgeStdioServerOptions {
  logFile: string;
  label?: string;
  delayInitializeMs?: number;
  exitBeforeInitialize?: boolean;
  ignoreSigterm?: boolean;
  pidFile?: string;
  publishDiagnostics?: boolean;
}

export function createStubBridgeStdioServerCommand(options: StubBridgeStdioServerOptions): StubBridgeStdioServerCommand {
  return {
    command: process.execPath,
    args: ['--input-type=module', '--eval', FAKE_BRIDGE_STDIO_SERVER_SOURCE],
    env: {
      FAKE_LSP_LOG_FILE: options.logFile,
      FAKE_LSP_LABEL: options.label ?? 'typescript',
      ...(options.delayInitializeMs !== undefined ? { FAKE_LSP_DELAY_INITIALIZE_MS: String(options.delayInitializeMs) } : {}),
      ...(options.exitBeforeInitialize ? { FAKE_LSP_EXIT_BEFORE_INITIALIZE: '1' } : {}),
      ...(options.ignoreSigterm ? { FAKE_LSP_IGNORE_SIGTERM: '1' } : {}),
      ...(options.pidFile ? { FAKE_LSP_PID_FILE: options.pidFile } : {}),
      ...(options.publishDiagnostics ? { FAKE_LSP_PUBLISH_DIAGNOSTICS: '1' } : {})
    }
  };
}

export function readStubBridgeLog(logFile: string): unknown[] {
  try {
    const source = readFileSync(logFile, 'utf8').trim();
    if (source === '') {
      return [];
    }
    return source.split('\n').map((line) => JSON.parse(line) as unknown);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

const FAKE_BRIDGE_STDIO_SERVER_SOURCE = `
import { appendFileSync, writeFileSync } from 'node:fs';

let buffer = Buffer.alloc(0);
const logFile = process.env.FAKE_LSP_LOG_FILE;
const label = process.env.FAKE_LSP_LABEL ?? 'typescript';
const delayInitializeMs = Number(process.env.FAKE_LSP_DELAY_INITIALIZE_MS ?? '0');
const pidFile = process.env.FAKE_LSP_PID_FILE;

function log(value) {
  if (logFile) {
    appendFileSync(logFile, JSON.stringify(value) + '\\n', 'utf8');
  }
}

if (pidFile) {
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

if (process.env.FAKE_LSP_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {
    log({ method: 'process/sigterm' });
  });
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(\`Content-Length: \${body.byteLength}\\r\\n\\r\\n\`, 'ascii'), body]);
}

function send(message) {
  process.stdout.write(encode(message));
}

function respondInitialize(message) {
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      capabilities: {
        hoverProvider: true,
        completionProvider: { triggerCharacters: ['.'] },
        foldingRangeProvider: true,
        semanticTokensProvider: {
          legend: { tokenTypes: ['variable', 'function'], tokenModifiers: ['declaration'] },
          full: { delta: false },
          range: true,
          command: 'FAKE_DISPLAY_SECRET',
          serverCommands: { [label]: { command: 'FAKE_DISPLAY_SECRET' } }
        },
        selectionRangeProvider: true,
        renameProvider: { prepareProvider: true },
        definitionProvider: true,
	        referencesProvider: true,
	        typeDefinitionProvider: true,
	        implementationProvider: true,
	        declarationProvider: true,
	        label
      }
    }
  });
}

function handle(message) {
  log({ method: message.method, message });

  if (message.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    if (process.env.FAKE_LSP_EXIT_BEFORE_INITIALIZE === '1') {
      process.exit(17);
      return;
    }
    if (delayInitializeMs > 0) {
      setTimeout(() => respondInitialize(message), delayInitializeMs);
      return;
    }
    respondInitialize(message);
    return;
  }

  if (message.method === 'textDocument/hover' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    if (message.params?.hold === true) {
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        contents: \`\${label} hover \${message.params?.position?.line}:\${message.params?.position?.character}\`
      }
    });
    return;
  }

  if (message.method === 'textDocument/didOpen' && process.env.FAKE_LSP_PUBLISH_DIAGNOSTICS === '1') {
    const uri = message.params?.textDocument?.uri ?? 'file:///unknown';
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        version: message.params?.textDocument?.version,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: \`\${label} diagnostic\`,
            severity: 1,
            source: label,
            code: \`\${label}-diagnostic\`,
            tags: [1],
            relatedInformation: [
              {
                location: {
                  uri,
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
                },
                message: 'omitted related info'
              }
            ],
            codeDescription: { href: 'https://example.test/diagnostic' },
            data: { secret: 'omitted data' }
          }
        ]
      }
    });
    return;
  }

  if (message.method === 'textDocument/didClose' && process.env.FAKE_LSP_PUBLISH_DIAGNOSTICS === '1') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: message.params?.textDocument?.uri ?? 'file:///unknown',
        diagnostics: []
      }
    });
    return;
  }

  if (message.method === 'textDocument/completion' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isIncomplete: false,
        items: [
          {
            label: 'CompletionItemWithLegitimateIdentifier0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            kind: 6,
            detail: \`\${label} completion\`,
            sortText: '0001',
            filterText: 'CompletionItemWithLegitimateIdentifier0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
          }
        ]
      }
    });
    return;
  }

  if (message.method === 'textDocument/rename' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        changes: {
          [message.params?.textDocument?.uri ?? 'file:///unknown']: [
            {
              range: {
                start: message.params?.position ?? { line: 0, character: 0 },
                end: {
                  line: message.params?.position?.line ?? 0,
                  character: (message.params?.position?.character ?? 0) + 5
                }
              },
              newText: message.params?.newName ?? 'renamed'
            }
          ]
        }
      }
    });
    return;
  }

  if (
    [
      'textDocument/definition',
	      'textDocument/references',
	      'textDocument/typeDefinition',
	      'textDocument/implementation',
	      'textDocument/declaration'
	    ].includes(message.method) &&
    Object.prototype.hasOwnProperty.call(message, 'id')
  ) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          uri: message.params?.textDocument?.uri ?? 'file:///unknown',
          range: {
            start: message.params?.position ?? { line: 0, character: 0 },
            end: {
              line: message.params?.position?.line ?? 0,
              character: (message.params?.position?.character ?? 0) + 5
            }
          }
        }
      ]
    });
    return;
  }

  if (message.method === 'textDocument/codeAction' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    const uri = (message.params && message.params.textDocument && message.params.textDocument.uri) || 'file:///unknown';
    const range = (message.params && message.params.range) || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          title: 'Fix it',
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: [],
          edit: {
            changes: { [uri]: [{ range: range, newText: 'fixed' }] },
            documentChanges: [
              { textDocument: { uri: uri, version: 1 }, edits: [{ range: range, newText: 'fixed' }] },
              { kind: 'rename', oldUri: uri, newUri: uri + '.renamed' }
            ]
          },
          command: { title: 'Run', command: 'do.thing', arguments: ['EXEC_ARG_STRIP'] },
          data: { secret: 'CODEACTION_DATA_STRIP' }
        }
      ]
    });
    return;
  }

  if (message.method === 'textDocument/foldingRange' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          startLine: 0,
          startCharacter: 0,
          endLine: 4,
          endCharacter: 1,
          kind: 'region',
          collapsedText: 'FAKE_DISPLAY_SECRET',
          ['key-FAKE_DISPLAY_SECRET']: 'leak',
          uri: message.params?.textDocument?.uri ?? 'file:///unknown',
          data: { secret: 'FAKE_DISPLAY_SECRET' },
          command: 'FAKE_DISPLAY_SECRET',
          arguments: ['FAKE_DISPLAY_SECRET'],
          env: { SECRET: 'FAKE_DISPLAY_SECRET' },
          serverCommands: { [label]: { command: 'FAKE_DISPLAY_SECRET' } }
        },
        {
          startLine: 6,
          endLine: 8,
          kind: 'custom-FAKE_DISPLAY_SECRET',
          collapsedText: 'FAKE_DISPLAY_SECRET'
        }
      ]
    });
    return;
  }

  if (message.method === 'textDocument/selectionRange' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          range: {
            start: { line: 1, character: 11 },
            end: { line: 1, character: 16 }
          },
          ['key-FAKE_DISPLAY_SECRET']: 'leak',
          uri: message.params?.textDocument?.uri ?? 'file:///unknown',
          data: { secret: 'FAKE_DISPLAY_SECRET' },
          command: 'FAKE_DISPLAY_SECRET',
          arguments: ['FAKE_DISPLAY_SECRET'],
          env: { SECRET: 'FAKE_DISPLAY_SECRET' },
          serverCommands: { [label]: { command: 'FAKE_DISPLAY_SECRET' } },
          parent: {
            range: {
              start: { line: 1, character: 2 },
              end: { line: 3, character: 3 }
            },
            ['parent-FAKE_DISPLAY_SECRET']: 'leak',
            data: 'FAKE_DISPLAY_SECRET'
          }
        }
      ]
    });
    return;
  }

  if (message.method === 'textDocument/semanticTokens/full' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        resultId: 'result-id-secret-FAKE_DISPLAY_SECRET',
        data: [0, 0, 5, 1, 0],
        ['key-FAKE_DISPLAY_SECRET']: 'leak',
        uri: message.params?.textDocument?.uri ?? 'file:///unknown',
        command: 'FAKE_DISPLAY_SECRET',
        arguments: ['FAKE_DISPLAY_SECRET'],
        env: { SECRET: 'FAKE_DISPLAY_SECRET' },
        serverCommands: { [label]: { command: 'FAKE_DISPLAY_SECRET' } }
      }
    });
    return;
  }

  if (message.method === 'shutdown' && Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }

  if (message.method === 'test/exit') {
    process.exit(Number(message.params?.code ?? 0));
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
