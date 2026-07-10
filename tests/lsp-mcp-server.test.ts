import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as deskLspMcp from '../src/server/lsp/deskLspMcp';

type McpToolCaller = (input: unknown, options: deskLspMcp.DeskLspMcpOptions) => Promise<any>;

const callLspHover = deskLspMcp.callLspHover;

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('desk-lsp-mcp lsp_hover', () => {
  it('advertises the complete Desk LSP tool registry through MCP', async () => {
    const server = deskLspMcp.createDeskLspMcpServer();
    const client = new Client({ name: 'desk-lsp-mcp-registry-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'lsp_hover',
        'lsp_format',
        'lsp_document_symbols',
        'lsp_folding_ranges',
        'lsp_selection_ranges',
        'lsp_semantic_tokens',
        'lsp_completion',
        'lsp_signature_help',
        'lsp_prepare_rename',
        'lsp_rename',
        'lsp_document_highlights',
        'lsp_definition',
        'lsp_references',
        'lsp_type_definition',
        'lsp_implementation',
        'lsp_declaration',
        'lsp_code_actions',
        'lsp_diagnostics'
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('forwards hover to /api/lsp with bearer auth and no workspaceRoot body field', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, result: { contents: 'hover ok' } });
    });

    const result = await callLspHover(
      {
        uri: 'file:///workspace/main.ts',
        position: { line: 1, character: 2 },
        languageId: 'typescript',
        workspaceRoot: '/malicious'
      },
      {
        env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: 'secret-token' },
        fetch
      }
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ contents: 'hover ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('http://127.0.0.1:5173/api/lsp');
    expect(calls[0].url).not.toContain('secret-token');
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'content-type': 'application/json'
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      method: 'textDocument/hover',
      languageId: 'typescript',
      params: {
        textDocument: { uri: 'file:///workspace/main.ts' },
        position: { line: 1, character: 2 }
      }
    });
    expect(String(calls[0].init.body)).not.toContain('workspaceRoot');
    expect(String(calls[0].init.body)).not.toContain('secret-token');
  });

  it('fails closed when required env is missing without calling the endpoint', async () => {
    const fetch = vi.fn();

    const result = await callLspHover(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
      { env: { DESK_API: 'http://127.0.0.1:5173' }, fetch }
    );

    expect(result.isError).toBe(true);
    expect(result).toEqual(toolErrorResult('LSP hover request failed', 'missing-token'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads authoritative DESK_LSP_ENV_FILE values instead of inherited env', async () => {
    const envFile = makeManagedEnvFile({
      DESK_API: 'http://127.0.0.1:6123',
      DESK_LSP_TOKEN: 'file-token',
      DESK_LSP_WORKSPACE_ROOT: '/workspace'
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, result: { contents: 'hover ok' } });
    });

    const result = await callLspHover(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
      {
        env: {
          DESK_LSP_ENV_FILE: envFile,
          DESK_API: 'https://attacker.example',
          DESK_LSP_TOKEN: 'attacker-token',
          DESK_LSP_WORKSPACE_ROOT: '/attacker'
        },
        fetch
      }
    );

    expect(result.isError).toBeUndefined();
    expect(calls[0].url).toBe('http://127.0.0.1:6123/api/lsp');
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer file-token' });
  });

  it('rejects invalid DESK_LSP_ENV_FILE inputs without leaking paths', async () => {
    const envFile = makeManagedEnvFile({
      DESK_API: 'http://127.0.0.1:6123',
      DESK_LSP_TOKEN: 'file-token',
      DESK_LSP_WORKSPACE_ROOT: '/workspace'
    });
    chmodSync(envFile, 0o644);
    const fetch = vi.fn();

    const result = await callLspHover(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
      { env: { DESK_LSP_ENV_FILE: envFile }, fetch }
    );

    expect(result).toEqual(toolErrorResult('LSP hover request failed', 'missing-env'));
    expect(JSON.stringify(result)).not.toContain(envFile);
    expect(JSON.stringify(result)).not.toContain('file-token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed for missing, malformed, symlink, and outside-runtime env files', async () => {
    const valid = makeManagedEnvFile({
      DESK_API: 'http://127.0.0.1:6123',
      DESK_LSP_TOKEN: 'file-token',
      DESK_LSP_WORKSPACE_ROOT: '/workspace'
    });
    const malformed = makeManagedEnvFile({
      DESK_API: 'http://127.0.0.1:6123',
      DESK_LSP_TOKEN: 'file-token',
      DESK_LSP_WORKSPACE_ROOT: '/workspace'
    });
    writeFileSync(malformed, '{nope', { mode: 0o600 });
    const outsideRoot = join(tmpdir(), `desk-lsp-outside-${process.pid}-${Date.now()}.json`);
    writeFileSync(outsideRoot, JSON.stringify({ DESK_API: 'x', DESK_LSP_TOKEN: 'x', DESK_LSP_WORKSPACE_ROOT: 'x' }), {
      mode: 0o600
    });
    tempRoots.push(outsideRoot);
    const shallowRoot = join(tmpdir(), 'desk-lsp-managed-agents', `shallow-${process.pid}-${Date.now()}`);
    mkdirSync(shallowRoot, { recursive: true, mode: 0o700 });
    chmodSync(shallowRoot, 0o700);
    const shallowEnvFile = join(shallowRoot, 'env.json');
    writeFileSync(shallowEnvFile, JSON.stringify({ DESK_API: 'x', DESK_LSP_TOKEN: 'x', DESK_LSP_WORKSPACE_ROOT: 'x' }), {
      mode: 0o600
    });
    chmodSync(shallowEnvFile, 0o600);
    tempRoots.push(shallowRoot);
    const symlink = `${valid}.link`;
    symlinkSync(valid, symlink);
    tempRoots.push(symlink);

    for (const envFile of ['/tmp/missing-desk-lsp-env.json', malformed, outsideRoot, shallowEnvFile, symlink]) {
      const fetch = vi.fn();
      const result = await callLspHover(
        { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
        { env: { DESK_LSP_ENV_FILE: envFile }, fetch }
      );
      expect(result).toEqual(toolErrorResult('LSP hover request failed', 'missing-env'));
      expect(JSON.stringify(result)).not.toContain(envFile);
      expect(JSON.stringify(result)).not.toContain('file-token');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('scrubs token, command, env, root, and raw network details from tool output and errors', async () => {
    const token = 'secret-token';
    const root = '/workspace';
    const fakeCommand = '/opt/secret-langserver';
    const fetch = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED token=${token} root=${root} command=${fakeCommand} env=SECRET`);
    });

    const failure = await callLspHover(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
      { env: { DESK_API: 'http://127.0.0.1:5173', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );

    expect(failure).toEqual(toolErrorResult('LSP hover request failed', 'fetch-failed'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failure)).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(root);
    expect(JSON.stringify(failure)).not.toContain(fakeCommand);
    expect(JSON.stringify(failure)).not.toContain('ECONNREFUSED');

    fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        result: {
          contents: `token=${token} root=${root}`,
          serverCommands: { typescript: { command: fakeCommand, env: { SECRET: 'value' } } },
          env: { SECRET: 'value' },
          command: fakeCommand,
          args: ['--secret']
        }
      })
    );

    const success = await callLspHover(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
      { env: { DESK_API: 'http://127.0.0.1:5173', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );
    const serialized = JSON.stringify(success);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(fakeCommand);
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('SECRET');
  });

  it('returns distinct safe error codes without leaking failure details', async () => {
    const token = 'safe-error-secret-token';
    const root = '/workspace';
    const input = { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } };
    const baseEnv = {
      DESK_API: 'http://127.0.0.1:5173',
      DESK_LSP_TOKEN: token,
      DESK_LSP_WORKSPACE_ROOT: root
    };

    const cases: Array<{
      code: deskLspMcp.LspToolErrorCode;
      input?: unknown;
      env: deskLspMcp.DeskLspMcpEnvironment;
      fetch?: typeof fetch;
    }> = [
      { code: 'missing-env', env: {} },
      { code: 'missing-token', env: { DESK_API: baseEnv.DESK_API } },
      { code: 'invalid-input', input: { uri: 'file:///workspace/main.ts' }, env: baseEnv },
      {
        code: 'bad-api-url',
        env: { ...baseEnv, DESK_API: 'file:///tmp/desk' },
        fetch: vi.fn() as typeof fetch
      },
      {
        code: 'http-failed',
        env: baseEnv,
        fetch: vi.fn(async () => jsonResponse(503, { ok: false, error: `server ${token}` })) as typeof fetch
      },
      {
        code: 'bad-json',
        env: baseEnv,
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(`invalid json ${token}`);
          }
        })) as typeof fetch
      },
      {
        code: 'bad-response',
        env: baseEnv,
        fetch: vi.fn(async () => jsonResponse(200, { ok: false, error: `backend ${token}` })) as typeof fetch
      },
      {
        code: 'fetch-failed',
        env: baseEnv,
        fetch: vi.fn(async () => {
          throw new Error(`connect ECONNREFUSED token=${token} root=${root}`);
        }) as typeof fetch
      }
    ];

    for (const entry of cases) {
      const result = await callLspHover(entry.input ?? input, {
        env: entry.env,
        fetch: entry.fetch ?? (vi.fn() as typeof fetch)
      });
      expect(result.isError, entry.code).toBe(true);
      expect(JSON.parse(result.content[0].text), entry.code).toEqual({
        code: entry.code,
        message: 'LSP hover request failed'
      });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    }
  });

  it('reports a safe fetch-unavailable code when no transport exists', async () => {
    vi.stubGlobal('fetch', undefined);

    const result = await callLspHover(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 0 } },
      { env: { DESK_API: 'http://127.0.0.1:5173', DESK_LSP_TOKEN: 'secret-token' } }
    );

    expect(result).toEqual(toolErrorResult('LSP hover request failed', 'fetch-unavailable'));
  });
});

describe('desk-lsp-mcp requestApi tools', () => {
  it('maps every requestApi-served tool to /api/lsp with bearer auth and no secret body fields', async () => {
    const cases = [
      {
        caller: 'callLspFormat',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          options: { tabSize: 2, insertSpaces: true },
          workspaceRoot: '/malicious'
        },
        body: {
          method: 'textDocument/formatting',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            options: { tabSize: 2, insertSpaces: true }
          }
        }
      },
      {
        caller: 'callLspDocumentSymbols',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 99, character: 99 },
          token: 'body-token'
        },
        body: {
          method: 'textDocument/documentSymbol',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' }
          }
        }
      },
      {
        caller: 'callLspFoldingRanges',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          workspaceRoot: '/malicious',
          token: 'body-token',
          serverCommands: { typescript: { command: '/secret' } }
        },
        body: {
          method: 'textDocument/foldingRange',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' }
          }
        }
      },
      {
        caller: 'callLspSelectionRanges',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          positions: [
            { line: 1, character: 2 },
            { line: 3, character: 4 }
          ],
          workspaceRoot: '/malicious',
          token: 'body-token',
          env: { SECRET: 'secret' }
        },
        body: {
          method: 'textDocument/selectionRange',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            positions: [
              { line: 1, character: 2 },
              { line: 3, character: 4 }
            ]
          }
        }
      },
      {
        caller: 'callLspCompletion',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 3, character: 4 },
          context: { triggerKind: 2, triggerCharacter: '.' },
          serverCommands: { typescript: { command: '/secret' } }
        },
        body: {
          method: 'textDocument/completion',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 3, character: 4 },
            context: { triggerKind: 2, triggerCharacter: '.' }
          }
        }
      },
      {
        caller: 'callLspSignatureHelp',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 5, character: 6 },
          context: { triggerKind: 3, triggerCharacter: ',', isRetrigger: true }
        },
        body: {
          method: 'textDocument/signatureHelp',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 5, character: 6 },
            context: { triggerKind: 3, triggerCharacter: ',', isRetrigger: true }
          }
        }
      },
      {
        caller: 'callLspPrepareRename',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 7, character: 8 }
        },
        body: {
          method: 'textDocument/prepareRename',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 7, character: 8 }
          }
        }
      },
      {
        caller: 'callLspRename',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 9, character: 10 },
          newName: 'renamedValue'
        },
        body: {
          method: 'textDocument/rename',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 9, character: 10 },
            newName: 'renamedValue'
          }
        }
      },
      {
        caller: 'callLspDocumentHighlights',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 11, character: 12 }
        },
        body: {
          method: 'textDocument/documentHighlight',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 11, character: 12 }
          }
        }
      },
      {
        caller: 'callLspDefinition',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 13, character: 14 },
          workspaceRoot: '/malicious'
        },
        body: {
          method: 'textDocument/definition',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 13, character: 14 }
          }
        }
      },
      {
        caller: 'callLspDeclaration',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 14, character: 15 },
          workspaceRoot: '/malicious'
        },
        body: {
          method: 'textDocument/declaration',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 14, character: 15 }
          }
        }
      },
      {
        caller: 'callLspReferences',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 15, character: 16 },
          includeDeclaration: true,
          token: 'body-token'
        },
        body: {
          method: 'textDocument/references',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 15, character: 16 },
            context: { includeDeclaration: true }
          }
        }
      },
      {
        caller: 'callLspTypeDefinition',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 17, character: 18 }
        },
        body: {
          method: 'textDocument/typeDefinition',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 17, character: 18 }
          }
        }
      },
      {
        caller: 'callLspImplementation',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          position: { line: 19, character: 20 },
          serverCommands: { typescript: { command: '/secret' } }
        },
        body: {
          method: 'textDocument/implementation',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            position: { line: 19, character: 20 }
          }
        }
      },
      {
        caller: 'callLspDiagnostics',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          workspaceRoot: '/malicious',
          token: 'body-token',
          serverCommands: { typescript: { command: '/secret' } }
        },
        body: {
          method: 'desk/lspDiagnostics',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' }
          }
        }
      },
      {
        caller: 'callLspDiagnostics',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          refresh: true,
          workspaceRoot: '/malicious',
          token: 'body-token'
        },
        body: {
          method: 'desk/lspDiagnostics',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' },
            refresh: true
          }
        }
      },
      {
        caller: 'callLspSemanticTokens',
        input: {
          uri: 'file:///workspace/main.ts',
          languageId: 'typescript',
          workspaceRoot: '/malicious',
          token: 'body-token',
          serverCommands: { typescript: { command: '/secret' } }
        },
        body: {
          method: 'textDocument/semanticTokens/full',
          languageId: 'typescript',
          params: {
            textDocument: { uri: 'file:///workspace/main.ts' }
          }
        }
      }
    ];

    for (const entry of cases) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, { ok: true, result: { tool: entry.caller } });
      });
      const caller = getCaller(entry.caller);

      const result = await caller(entry.input, {
        env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: 'secret-token' },
        fetch
      });

      expect(result.isError, entry.caller).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(
        entry.caller === 'callLspFoldingRanges' ||
          entry.caller === 'callLspSelectionRanges' ||
          entry.caller === 'callLspSemanticTokens'
          ? { results: [] }
          : { tool: entry.caller }
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].init.headers).toMatchObject({
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      });
      expect(JSON.parse(String(calls[0].init.body))).toEqual(entry.body);
      const bodyText = String(calls[0].init.body);
      expect(bodyText).not.toContain('workspaceRoot');
      expect(bodyText).not.toContain('secret-token');
      expect(bodyText).not.toContain('serverCommands');
      expect(bodyText).not.toContain('command');
      expect(bodyText).not.toContain('args');
      expect(bodyText).not.toContain('env');
      expect(bodyText).not.toContain('initializationOptions');
    }
  });

  it('defaults lsp_references includeDeclaration to false', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, result: { tool: 'references' } });
    });

    const result = await getCaller('callLspReferences')(
      { uri: 'file:///workspace/main.ts', position: { line: 1, character: 2 } },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: 'secret-token' }, fetch }
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      method: 'textDocument/references',
      params: {
        textDocument: { uri: 'file:///workspace/main.ts' },
        position: { line: 1, character: 2 },
        context: { includeDeclaration: false }
      }
    });
  });

  it('preserves in-root and out-of-root location URIs while removing tokens and sensitive keys', async () => {
    const token = 'mcp-location-secret';
    const root = '/workspace';
    const inRootUri = 'file:///workspace/src/target.ts';
    const outOfRootUri = 'file:///usr/lib/typescript/lib/lib.dom.d.ts';
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          results: [
            {
              serverConfigId: 'tsserver',
              isPrimary: true,
              result: [
                {
                  uri: inRootUri,
                  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
                  workspaceRoot: root,
                  token
                },
                {
                  targetUri: outOfRootUri,
                  targetRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 8 } },
                  env: { SECRET: 'value' }
                }
              ]
            }
          ]
        }
      })
    );

    const result = await getCaller('callLspDeclaration')(
      { uri: 'file:///workspace/main.ts', position: { line: 0, character: 1 } },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );

    const serialized = JSON.stringify(result);
    expect(serialized).toContain(inRootUri);
    expect(serialized).toContain(outOfRootUri);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('workspaceRoot');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('env');
  });

  it('preserves legitimate long result content while removing exact secrets and sensitive keys', async () => {
    const token = 'mcp-token-secret';
    const root = '/workspace';
    const longIdentifier = 'CompletionItemWithLegitimateIdentifier0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          completion: longIdentifier,
          symbols: [{ name: longIdentifier }],
          signature: { label: longIdentifier },
          documentation: `token=${token} root=${root}`,
          serverCommands: { typescript: { command: '/opt/secret-langserver' } },
          env: { SECRET: 'value' },
          initializationOptions: { SECRET: 'value' }
        }
      })
    );

    const result = await getCaller('callLspCompletion')(
      {
        uri: 'file:///workspace/main.ts',
        position: { line: 0, character: 1 },
        context: { triggerKind: 1 }
      },
      {
        env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root },
        fetch
      }
    );

    const serialized = JSON.stringify(result);
    expect(serialized).toContain(longIdentifier);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('initializationOptions');
  });

  it('maps new tool failures to static sanitized errors', async () => {
    const token = 'secret-token';
    const root = '/workspace';
    const fakeCommand = '/opt/secret-langserver';
    const fetch = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED token=${token} root=${root} command=${fakeCommand} env=SECRET`);
    });

    const result = await getCaller('callLspDeclaration')(
      {
        uri: 'file:///workspace/main.ts',
        position: { line: 0, character: 1 }
      },
      { env: { DESK_API: 'http://127.0.0.1:5173', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );

    expect(result).toEqual(toolErrorResult('LSP declaration request failed', 'fetch-failed'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(fakeCommand);
    expect(serialized).not.toContain('ECONNREFUSED');
  });

  it('redacts exact token and root strings from diagnostics while preserving minimal diagnostic content', async () => {
    const token = 'secret-token';
    const root = '/workspace';
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          diagnostics: [
            {
              range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
              message: `normal diagnostic in ${root} token ${token}`,
              severity: 1,
              source: 'typescript',
              code: 'ts-100',
              tags: [1],
              serverCommands: { typescript: { command: '/opt/secret-langserver' } },
              env: { SECRET: 'value' }
            }
          ]
        }
      })
    );

    const result = await getCaller('callLspDiagnostics')(
      { uri: 'file:///workspace/main.ts', languageId: 'typescript' },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({
      diagnostics: [
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          message: 'normal diagnostic in [redacted] token [redacted]',
          severity: 1,
          source: 'typescript',
          code: 'ts-100',
          tags: [1]
        }
      ]
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('/opt/secret-langserver');
  });

  it('sanitizes folding and selection range output with fresh allowlisted objects', async () => {
    const token = 'display-token-secret';
    const root = '/workspace';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            results: [
              {
                serverConfigId: 'tsserver',
                isPrimary: true,
                result: [
                  {
                    startLine: 0,
                    startCharacter: 1,
                    endLine: 4,
                    endCharacter: 8,
                    kind: `custom-${token}`,
                    collapsedText: token,
                    [`key-${token}`]: token,
                    uri: `file:///workspace/${token}.ts`,
                    data: { token },
                    command: token,
                    arguments: [token],
                    env: { SECRET: 'value' },
                    serverCommands: { typescript: { command: token } }
                  }
                ]
              }
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            results: [
              {
                serverConfigId: 'tsserver',
                isPrimary: true,
                result: [
                  {
                    range: testRange(0, 1, 0, 4),
                    [`key-${token}`]: token,
                    uri: `file:///workspace/${token}.ts`,
                    data: { token },
                    command: token,
                    arguments: [token],
                    env: { SECRET: 'value' },
                    serverCommands: { typescript: { command: token } },
                    parent: {
                      range: testRange(0, 0, 0, 8),
                      [`parent-${token}`]: token
                    }
                  }
                ]
              }
            ]
          }
        })
      );

    const folding = await getCaller('callLspFoldingRanges')(
      { uri: 'file:///workspace/main.ts', languageId: 'typescript' },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );
    const selection = await getCaller('callLspSelectionRanges')(
      { uri: 'file:///workspace/main.ts', languageId: 'typescript', positions: [{ line: 0, character: 1 }] },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: token, DESK_LSP_WORKSPACE_ROOT: root }, fetch }
    );

    expect(JSON.parse(folding.content[0].text)).toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [{ startLine: 0, startCharacter: 1, endLine: 4, endCharacter: 8 }]
        }
      ]
    });
    expect(JSON.parse(selection.content[0].text)).toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [{ range: testRange(0, 1, 0, 4), parent: { range: testRange(0, 0, 0, 8) } }]
        }
      ]
    });
    const serialized = JSON.stringify({ folding, selection });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('collapsedText');
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('arguments');
    expect(serialized).not.toContain('SECRET');
  });
});

describe('desk-lsp-mcp lsp_code_actions', () => {
  const callLspCodeActions = deskLspMcp.callLspCodeActions;
  const ROOT = '/workspace';
  const URI = 'file:///workspace/main.ts';
  const caResult = {
    results: [
      {
        serverConfigId: 'tsserver',
        isPrimary: true,
        result: [
          {
            title: 'Fix import',
            kind: 'quickfix',
            isPreferred: true,
            diagnostics: [],
            edit: {
              changes: { [URI]: [{ range: {}, newText: 'x' }] },
              documentChanges: [
                { textDocument: { uri: URI, version: 1 }, edits: [] },
                { kind: 'rename', oldUri: URI, newUri: 'file:///workspace/renamed.ts' }
              ]
            },
            command: { title: 'Run', command: 'do.thing', arguments: ['EXEC_ARG_STRIP'] },
            data: { secret: 'CODEACTION_DATA_STRIP' }
          }
        ]
      }
    ]
  };

  it('forwards code-action with bearer header, body method/params only, and no workspaceRoot/token in body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, result: caResult });
    });
    const result = await callLspCodeActions(
      {
        uri: URI,
        languageId: 'typescript',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        context: { diagnostics: [], only: ['quickfix'], triggerKind: 1 },
        workspaceRoot: '/malicious'
      },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: 'secret-token', DESK_LSP_WORKSPACE_ROOT: ROOT }, fetch }
    );
    expect((result as any).isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.method).toBe('textDocument/codeAction');
    expect(body.params.textDocument.uri).toBe(URI);
    expect(body.params.range).toBeTruthy();
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['method', 'params']));
    expect('workspaceRoot' in body).toBe(false);
    expect(String(calls[0].init.body)).not.toContain('secret-token');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
  });

  it('strips command/arguments/data and preserves WorkspaceEdit URIs in tool output', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { ok: true, result: caResult }));
    const result = await callLspCodeActions(
      {
        uri: URI,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [] }
      },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: 'secret-token', DESK_LSP_WORKSPACE_ROOT: ROOT }, fetch }
    );
    const text = (result as any).content[0].text;
    // executable payloads stripped
    expect(text).not.toContain('do.thing');
    expect(text).not.toContain('EXEC_ARG_STRIP');
    expect(text).not.toContain('CODEACTION_DATA_STRIP');
    // inert fields + WorkspaceEdit URIs preserved (changes map key + documentChanges textDocument.uri + resource-op newUri)
    expect(text).toContain('Fix import');
    expect(text).toContain(URI);
    expect(text).toContain('file:///workspace/renamed.ts');
  });

  it('scrubs a token embedded in a WorkspaceEdit changes-map key while preserving the workspace root', async () => {
    const TOKEN = 'secret-token';
    const leakUri = `file:///workspace/leak-${TOKEN}.ts`;
    const sanitizedLeakKey = leakUri.split(TOKEN).join('[redacted]');
    const leakResult = {
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [{ title: 'Fix import', kind: 'quickfix', edit: { changes: { [leakUri]: [{ range: {}, newText: 'x' }] } } }]
        }
      ]
    };
    const fetch = vi.fn(async () => jsonResponse(200, { ok: true, result: leakResult }));
    const result = await callLspCodeActions(
      {
        uri: URI,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [] }
      },
      { env: { DESK_API: 'http://127.0.0.1:5173/', DESK_LSP_TOKEN: TOKEN, DESK_LSP_WORKSPACE_ROOT: ROOT }, fetch }
    );
    const text = (result as any).content[0].text;
    // token must not survive inside the changes-map key
    expect(text).not.toContain(TOKEN);
    // the legitimate workspace-root URI key is preserved (only the token portion redacted)
    expect(text).toContain(sanitizedLeakKey);
  });
});

function getCaller(name: string): McpToolCaller {
  const caller = (deskLspMcp as Record<string, unknown>)[name];
  expect(caller, `${name} export`).toBeTypeOf('function');
  return caller as McpToolCaller;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

function toolErrorResult(message: string, code: deskLspMcp.LspToolErrorCode) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }]
  };
}

function makeManagedEnvFile(values: Record<string, string>): string {
  const root = join(tmpdir(), 'desk-lsp-managed-agents', `test-${process.pid}-${Date.now()}-${Math.random()}`);
  const sessionDir = join(root, 'session');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(sessionDir, 0o700);
  const envFile = join(sessionDir, 'env.json');
  writeFileSync(envFile, JSON.stringify(values), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  tempRoots.push(root);
  return envFile;
}

function testRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}
