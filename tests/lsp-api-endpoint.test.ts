import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLspCapabilityTokenRegistry } from '../src/server/lsp/capabilityTokenRegistry';
import { createFoldingRangeService } from '../src/server/lsp/foldingRangeService';
import { createLspHttpEndpoint } from '../src/server/lsp/lspHttpEndpoint';
import { createLspRequestApi, type LspRequestApi } from '../src/server/lsp/requestApi';
import { createSelectionRangeService } from '../src/server/lsp/selectionRangeService';
import { createSemanticTokensService } from '../src/server/lsp/semanticTokensService';

let root: string;
let otherRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desk-lsp-api-root-'));
  otherRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-api-other-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
});

describe('LSP HTTP endpoint authorization', () => {
  it('rejects absent, wrong, query, or body tokens before request planning', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const body = hoverBody(fileUri(root, 'sample.ts'));

    await expect(endpoint.handleRequest({ headers: {}, body })).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      endpoint.handleRequest({ headers: { authorization: 'Bearer wrong' }, body })
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(endpoint.handleRequest({ headers: {}, url: `/api/lsp?token=${token}`, body })).resolves.toMatchObject({
      statusCode: 401
    });
    await expect(endpoint.handleRequest({ headers: {}, body: { ...body, token } })).resolves.toMatchObject({
      statusCode: 401
    });
    expect(requestApi.handleRequest).not.toHaveBeenCalled();
  });

  it('rejects missing, malformed, non-file, and out-of-root text document URIs before request planning', async () => {
    const { endpoint, requestApi, token } = createEndpoint();

    await expect(authorized(endpoint, token, hoverBody(undefined))).resolves.toMatchObject({ statusCode: 400 });
    await expect(authorized(endpoint, token, hoverBody('not a url'))).resolves.toMatchObject({ statusCode: 400 });
    await expect(authorized(endpoint, token, hoverBody('https://example.test/sample.ts'))).resolves.toMatchObject({
      statusCode: 400
    });
    await expect(authorized(endpoint, token, hoverBody(fileUri(otherRoot, 'sample.ts')))).resolves.toMatchObject({
      statusCode: 403
    });
    await expect(authorized(endpoint, token, hoverBody(pathToFileURL(join(root, '../escape.ts')).href))).resolves.toMatchObject({
      statusCode: 403
    });
    expect(requestApi.handleRequest).not.toHaveBeenCalled();
  });

  it('injects the token-bound workspace root and ignores a malicious body workspaceRoot', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const realRoot = await realpath(root);
    const body = {
      ...hoverBody(fileUri(root, 'sample.ts')),
      workspaceRoot: otherRoot
    };

    await expect(authorized(endpoint, token, body)).resolves.toEqual({
      statusCode: 200,
      body: { ok: true, result: { contents: 'hover ok' } }
    });
    expect(requestApi.handleRequest).toHaveBeenCalledTimes(1);
    expect(requestApi.handleRequest).toHaveBeenCalledWith({
      ...body,
      workspaceRoot: realRoot
    });
  });

  it('scrubs secrets, token, and bound root from success and error response bodies', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const realRoot = await realpath(root);
    requestApi.handleRequest = vi.fn(async () => ({
      ok: true,
      result: {
        message: `token=${token} root=${realRoot}`,
        serverCommands: { typescript: { command: 'node', args: ['server.js'], env: { SECRET: 'secret' } } },
        env: { SECRET: 'secret' },
        command: 'node',
        args: ['server.js'],
        initializationOptions: { secretInit: 'init-secret' }
      }
    }));

    const success = await authorized(endpoint, token, hoverBody(fileUri(root, 'sample.ts')));
    expect(JSON.stringify(success.body)).not.toContain(token);
    expect(JSON.stringify(success.body)).not.toContain(realRoot);
    expect(JSON.stringify(success.body)).not.toContain('serverCommands');
    expect(JSON.stringify(success.body)).not.toContain('SECRET');
    expect(JSON.stringify(success.body)).not.toContain('init-secret');
    expect(JSON.stringify(success.body)).not.toContain('server.js');

    requestApi.handleRequest = vi.fn(async () => ({
      ok: false,
      error: {
        code: 'invalid_request',
        message: `failed ${token} ${realRoot}`,
        serverCommands: { typescript: { command: 'node' } },
        env: { SECRET: 'secret' },
        command: 'node',
        args: ['server.js'],
        initializationOptions: { secretInit: 'init-secret' }
      }
    }));
    const failure = await authorized(endpoint, token, hoverBody(fileUri(root, 'sample.ts')));
    expect(JSON.stringify(failure.body)).not.toContain(token);
    expect(JSON.stringify(failure.body)).not.toContain(realRoot);
    expect(JSON.stringify(failure.body)).not.toContain('serverCommands');
    expect(JSON.stringify(failure.body)).not.toContain('SECRET');
    expect(JSON.stringify(failure.body)).not.toContain('init-secret');
    expect(JSON.stringify(failure.body)).not.toContain('server.js');
  });

  it('preserves location uri and targetUri values while removing token and sensitive keys', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const realRoot = await realpath(root);
    const inRootUri = fileUri(root, 'definition.ts');
    const outOfRootTargetUri = fileUri(otherRoot, 'types.ts');
    requestApi.handleRequest = vi.fn(async () => ({
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
                workspaceRoot: realRoot,
                token
              },
              {
                targetUri: outOfRootTargetUri,
                targetRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 8 } },
                message: `root=${realRoot} token=${token}`,
                env: { SECRET: 'secret' },
                command: 'secret-langserver'
              }
            ]
          }
        ]
      }
    }));

    const response = await authorized(endpoint, token, declarationBody(fileUri(root, 'sample.ts')));
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    expect(serialized).toContain(inRootUri);
    expect(serialized).toContain(outOfRootTargetUri);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(`root=${realRoot}`);
    expect(serialized).not.toContain('workspaceRoot');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('secret-langserver');
  });

  it('strips command/arguments/data and preserves WorkspaceEdit URIs for code actions', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const realRoot = await realpath(root);
    const inRootUri = fileUri(root, 'fix.ts');
    const renamedUri = fileUri(root, 'fix-renamed.ts');
    requestApi.handleRequest = vi.fn(async () => ({
      ok: true,
      result: {
        results: [
          {
            serverConfigId: 'tsserver',
            isPrimary: true,
            result: [
              {
                title: 'Fix it',
                kind: 'quickfix',
                isPreferred: true,
                diagnostics: [],
                detail: `in ${realRoot} token ${token}`,
                edit: {
                  changes: { [inRootUri]: [{ range: {}, newText: 'x' }] },
                  documentChanges: [
                    { textDocument: { uri: inRootUri, version: 1 }, edits: [] },
                    { kind: 'rename', oldUri: inRootUri, newUri: renamedUri }
                  ]
                },
                command: { title: 'Run', command: 'do.thing', arguments: ['EXEC_ARG_STRIP'] },
                data: { secret: 'CADATA_STRIP' }
              }
            ]
          }
        ]
      }
    }));

    const response = await authorized(endpoint, token, codeActionBody(fileUri(root, 'sample.ts')));
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    // WorkspaceEdit URIs preserved: changes map key + documentChanges textDocument.uri + resource-op oldUri/newUri
    expect(serialized).toContain(inRootUri);
    expect(serialized).toContain(renamedUri);
    // executable/opaque payloads stripped
    expect(serialized).not.toContain('do.thing');
    expect(serialized).not.toContain('EXEC_ARG_STRIP');
    expect(serialized).not.toContain('CADATA_STRIP');
    // token scrubbed everywhere; non-uri root scrubbed; inert fields kept
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(`in ${realRoot} token`);
    expect(serialized).toContain('Fix it');
  });

  it('scrubs a token embedded in a WorkspaceEdit changes-map key while preserving the workspace root', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const leakUri = fileUri(root, `leak-${token}.ts`);
    const sanitizedLeakKey = leakUri.split(token).join('[redacted]');
    requestApi.handleRequest = vi.fn(async () => ({
      ok: true,
      result: {
        results: [
          {
            serverConfigId: 'tsserver',
            isPrimary: true,
            result: [
              {
                title: 'Fix it',
                kind: 'quickfix',
                edit: {
                  changes: { [leakUri]: [{ range: {}, newText: 'x' }] }
                }
              }
            ]
          }
        ]
      }
    }));

    const response = await authorized(endpoint, token, codeActionBody(fileUri(root, 'sample.ts')));
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    // token must not survive inside the changes-map key
    expect(serialized).not.toContain(token);
    // the legitimate workspace-root URI key is preserved (only the token portion redacted)
    expect(serialized).toContain(sanitizedLeakKey);
  });

  it('continues scrubbing the bound root from non-location success response strings', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const realRoot = await realpath(root);
    requestApi.handleRequest = vi.fn(async () => ({
      ok: true,
      result: {
        uri: fileUri(root, 'hover-result.ts'),
        contents: `hover from ${realRoot}`
      }
    }));

    const response = await authorized(endpoint, token, hoverBody(fileUri(root, 'sample.ts')));
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    expect(serialized).not.toContain(realRoot);
  });

  it('returns sanitized folding ranges without leaking dirty server payload keys or values', async () => {
    const tokenLeak = 'tok_SECRET_ENDPOINT_FOLDING';
    const { endpoint, token } = createEndpointWithDisplayServices({
      foldingResult: [
        {
          startLine: 0,
          startCharacter: 1,
          endLine: 3,
          endCharacter: 8,
          kind: `custom-${tokenLeak}`,
          collapsedText: tokenLeak,
          [`key-${tokenLeak}`]: tokenLeak,
          uri: fileUri(root, `${tokenLeak}.ts`),
          data: { tokenLeak },
          command: tokenLeak,
          arguments: [tokenLeak],
          env: { SECRET: tokenLeak },
          serverCommands: { typescript: { command: tokenLeak } }
        }
      ],
      selectionResult: []
    });
    const realRoot = await realpath(root);

    const response = await authorized(endpoint, token, foldingRangeBody(fileUri(root, 'folding.ts')));
    const serialized = JSON.stringify(response.body);

    expect(response).toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: {
          results: [
            {
              serverConfigId: 'tsserver',
              isPrimary: true,
              result: [{ startLine: 0, startCharacter: 1, endLine: 3, endCharacter: 8 }]
            }
          ]
        }
      }
    });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(tokenLeak);
    expect(serialized).not.toContain(realRoot);
    expect(serialized).not.toContain('collapsedText');
    expect(serialized).not.toContain('serverCommands');
  });

  it('returns sanitized selection ranges without leaking dirty server payload keys or values', async () => {
    const tokenLeak = 'tok_SECRET_ENDPOINT_SELECTION';
    const dirty: any = {
      range: lspRange(0, 1, 0, 4),
      [`key-${tokenLeak}`]: tokenLeak,
      uri: fileUri(root, `${tokenLeak}.ts`),
      data: { tokenLeak },
      command: tokenLeak,
      arguments: [tokenLeak],
      env: { SECRET: tokenLeak },
      serverCommands: { typescript: { command: tokenLeak } },
      parent: {
        range: lspRange(0, 0, 0, 8),
        [`parent-${tokenLeak}`]: tokenLeak
      }
    };
    dirty.parent.parent = dirty;
    const { endpoint, token } = createEndpointWithDisplayServices({
      foldingResult: [],
      selectionResult: [dirty]
    });
    const realRoot = await realpath(root);

    const response = await authorized(endpoint, token, selectionRangeBody(fileUri(root, 'selection.ts')));
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      result: {
        results: [
          {
            serverConfigId: 'tsserver',
            isPrimary: true,
            result: [{ range: lspRange(0, 1, 0, 4), parent: { range: lspRange(0, 0, 0, 8) } }]
          }
        ]
      }
    });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(tokenLeak);
    expect(serialized).not.toContain(realRoot);
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('arguments');
  });

  it('returns a static 500 when requestApi throws without leaking the raw error message', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const realRoot = await realpath(root);
    const fakeCommand = join(otherRoot, 'secret-langserver');
    requestApi.handleRequest = vi.fn(async () => {
      throw new Error(`spawn ${fakeCommand} ENOENT from ${realRoot} with ${token}`);
    });

    const response = await authorized(endpoint, token, hoverBody(fileUri(root, 'sample.ts')));

    expect(response).toEqual({
      statusCode: 500,
      body: { ok: false, error: { code: 'internal_error', message: 'LSP request failed' } }
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(realRoot);
    expect(serialized).not.toContain(fakeCommand);
    expect(serialized).not.toContain('ENOENT');
  });

  it('returns a static 400 for malformed JSON bodies without throwing raw SyntaxError text', async () => {
    const { endpoint, requestApi, token } = createEndpoint();
    const response = createJsonResponseRecorder();

    await expect(
      endpoint.handleNodeRequest(
        createJsonRequest('{not-json', { authorization: `Bearer ${token}` }),
        response.res,
        new URL('http://desk.local/api/lsp')
      )
    ).resolves.toBe(true);

    expect(response.statusCode()).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: { code: 'invalid_json', message: 'Invalid JSON body' } });
    expect(response.raw()).not.toContain('SyntaxError');
    expect(response.raw()).not.toContain('Unexpected token');
    expect(requestApi.handleRequest).not.toHaveBeenCalled();
  });
});

function createEndpoint() {
  const registry = createLspCapabilityTokenRegistry();
  const { token } = registry.mint(root);
  const requestApi: LspRequestApi = {
    handleRequest: vi.fn(async () => ({ ok: true, result: { contents: 'hover ok' } }))
  };
  const endpoint = createLspHttpEndpoint({ tokenRegistry: registry, requestApi });
  return { endpoint, requestApi, token };
}

function createEndpointWithDisplayServices({
  foldingResult,
  selectionResult
}: {
  foldingResult: unknown;
  selectionResult: unknown;
}) {
  const registry = createLspCapabilityTokenRegistry();
  const { token } = registry.mint(root);
  const requestPlanner = {
    planLspRequest: vi.fn(() => ({
      targets: [{ serverConfigId: 'tsserver', workspaceRoot: root, isPrimary: true }]
    }))
  };
  const manager = {
    sendRequest: vi.fn(async (_target: unknown, method: string) =>
      method === 'textDocument/foldingRange' ? foldingResult : selectionResult
    )
  };
  const requestApi = createLspRequestApi({
    getSettings: vi.fn(() => ({ enabled: true })),
    hoverService: { hover: vi.fn() },
    formattingService: { formatDocument: vi.fn() },
    documentSymbolService: { documentSymbols: vi.fn() },
    completionService: { complete: vi.fn() },
    signatureHelpService: { signatureHelp: vi.fn() },
    renameService: { prepareRename: vi.fn(), rename: vi.fn() },
    documentHighlightService: { documentHighlights: vi.fn() },
    locationService: {
      definition: vi.fn(),
      references: vi.fn(),
      typeDefinition: vi.fn(),
      implementation: vi.fn(),
      declaration: vi.fn()
    },
    diagnosticsService: { diagnostics: vi.fn() },
    codeActionService: { codeActions: vi.fn() },
    foldingRangeService: createFoldingRangeService({ requestPlanner, manager }),
    selectionRangeService: createSelectionRangeService({ requestPlanner, manager }),
    semanticTokensService: createSemanticTokensService({ requestPlanner, manager })
  });
  const endpoint = createLspHttpEndpoint({ tokenRegistry: registry, requestApi });
  return { endpoint, token, manager, requestPlanner };
}

async function authorized(endpoint: ReturnType<typeof createLspHttpEndpoint>, token: string, body: unknown) {
  return endpoint.handleRequest({
    headers: { authorization: `Bearer ${token}` },
    body
  });
}

function hoverBody(uri: string | undefined) {
  return {
    method: 'textDocument/hover',
    languageId: 'typescript',
    params: {
      textDocument: uri === undefined ? {} : { uri },
      position: { line: 0, character: 0 }
    }
  };
}

function definitionBody(uri: string) {
  return {
    method: 'textDocument/definition',
    languageId: 'typescript',
    params: {
      textDocument: { uri },
      position: { line: 0, character: 0 }
    }
  };
}

function declarationBody(uri: string) {
  return {
    method: 'textDocument/declaration',
    languageId: 'typescript',
    params: {
      textDocument: { uri },
      position: { line: 0, character: 0 }
    }
  };
}

function foldingRangeBody(uri: string) {
  return {
    method: 'textDocument/foldingRange',
    languageId: 'typescript',
    params: {
      textDocument: { uri }
    }
  };
}

function selectionRangeBody(uri: string) {
  return {
    method: 'textDocument/selectionRange',
    languageId: 'typescript',
    params: {
      textDocument: { uri },
      positions: [{ line: 0, character: 1 }]
    }
  };
}

function codeActionBody(uri: string) {
  return {
    method: 'textDocument/codeAction',
    languageId: 'typescript',
    params: {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      context: { diagnostics: [] }
    }
  };
}

function fileUri(parent: string, name: string): string {
  const path = join(parent, name);
  writeFileSync(path, 'const value = 1;\n');
  return pathToFileURL(path).href;
}

function lspRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}

function createJsonRequest(body: string, headers: Record<string, string>) {
  const req = new PassThrough() as PassThrough & {
    method?: string;
    url?: string;
    headers: Record<string, string>;
  };
  req.method = 'POST';
  req.url = '/api/lsp';
  req.headers = headers;
  process.nextTick(() => req.end(body));
  return req as any;
}

function createJsonResponseRecorder() {
  let statusCode = 0;
  let body = '';
  return {
    res: {
      get statusCode() {
        return statusCode;
      },
      set statusCode(next: number) {
        statusCode = next;
      },
      setHeader() {},
      end(chunk: unknown) {
        body += typeof chunk === 'string' ? chunk : String(chunk ?? '');
      }
    } as any,
    statusCode: () => statusCode,
    raw: () => body,
    json: () => JSON.parse(body) as unknown
  };
}
