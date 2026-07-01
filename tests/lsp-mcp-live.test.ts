import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLspCapabilityTokenRegistry } from '../src/server/lsp/capabilityTokenRegistry';
import { createLspHttpEndpoint } from '../src/server/lsp/lspHttpEndpoint';
import { LspManager } from '../src/server/lsp/manager';
import { createLspRequestApi } from '../src/server/lsp/requestApi';
import { planLspRequest } from '../src/server/lsp/requestPlanner';
import { normalizeLspSettings, type NormalizedLspSettings } from '../src/server/lsp/settings';
import { forceKillActiveStdioVirtualSessionChildren } from '../src/server/lsp/stdioVirtualSession';
import { createHoverService } from '../src/server/lsp/hoverService';
import { createFormattingService } from '../src/server/lsp/formattingService';
import { createFoldingRangeService } from '../src/server/lsp/foldingRangeService';
import { createDocumentSymbolService } from '../src/server/lsp/documentSymbolService';
import { createCompletionService } from '../src/server/lsp/completionService';
import { createSignatureHelpService } from '../src/server/lsp/signatureHelpService';
import { createRenameService } from '../src/server/lsp/renameService';
import { createDocumentHighlightService } from '../src/server/lsp/documentHighlightService';
import { createDiagnosticsService } from '../src/server/lsp/diagnosticsService';
import { createLocationService } from '../src/server/lsp/locationService';
import { createCodeActionService } from '../src/server/lsp/codeActionService';
import { createSelectionRangeService } from '../src/server/lsp/selectionRangeService';
import { createSemanticTokensService } from '../src/server/lsp/semanticTokensService';
import { createStubBridgeStdioServerCommand, readStubBridgeLog } from './lsp/stubBridgeStdioServer';

describe('desk-lsp-mcp live hover proof', () => {
  let root: string;
  let server: Server | undefined;
  let manager: LspManager | undefined;
  let registry: ReturnType<typeof createLspCapabilityTokenRegistry> | undefined;
  let mcpClient: Client | undefined;
  let mcpTransport: StdioClientTransport | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-lsp-mcp-live-'));
  });

  afterEach(async () => {
    await mcpClient?.close();
    await mcpTransport?.close();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await manager?.stopAll();
    registry?.dispose();
    forceKillActiveStdioVirtualSessionChildren();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves lsp_hover through stdio MCP, /api/lsp auth, manager, and real stdio LSP child', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    writeFileSync(sourceFile, 'const value = 1;\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });

    const result = await client.callTool({
      name: 'lsp_hover',
      arguments: {
        uri: pathToFileURL(sourceFile).href,
        languageId: 'typescript',
        position: { line: 0, character: 1 }
      }
    });

    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('typescript hover 0:1');
    await vi.waitFor(() =>
      expect(readStubBridgeLog(logFile).some((entry: any) => entry.method === 'textDocument/hover')).toBe(true)
    );
  });

  it('serves lsp_completion and lsp_rename as data through the live MCP path', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    const originalText = 'const value = alpha;\n';
    writeFileSync(sourceFile, originalText);
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });

    const completion = await client.callTool({
      name: 'lsp_completion',
      arguments: {
        uri: pathToFileURL(sourceFile).href,
        languageId: 'typescript',
        position: { line: 0, character: 14 },
        context: { triggerKind: 1 }
      }
    });
    const completionText = completion.content?.[0]?.type === 'text' ? completion.content[0].text : '';
    const completionPayload = JSON.parse(completionText);
    expect(JSON.stringify(completionPayload)).toContain(
      'CompletionItemWithLegitimateIdentifier0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    );

    const rename = await client.callTool({
      name: 'lsp_rename',
      arguments: {
        uri: pathToFileURL(sourceFile).href,
        languageId: 'typescript',
        position: { line: 0, character: 6 },
        newName: 'renamedValue'
      }
    });
    const renameText = rename.content?.[0]?.type === 'text' ? rename.content[0].text : '';
    const renamePayload = JSON.parse(renameText);
    expect(renamePayload.result.changes[pathToFileURL(sourceFile).href][0]).toMatchObject({
      newText: 'renamedValue',
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });
    expect(readFileSync(sourceFile, 'utf8')).toBe(originalText);

    await vi.waitFor(() => {
      const methods = readStubBridgeLog(logFile).map((entry: any) => entry.method);
      expect(methods).toContain('textDocument/completion');
      expect(methods).toContain('textDocument/rename');
    });
  });

  it('serves lsp_definition through the live MCP path', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    writeFileSync(sourceFile, 'const value = alpha;\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });

    const definition = await client.callTool({
      name: 'lsp_definition',
      arguments: {
        uri: pathToFileURL(sourceFile).href,
        languageId: 'typescript',
        position: { line: 0, character: 6 }
      }
    });

    const text = definition.content?.[0]?.type === 'text' ? definition.content[0].text : '';
    const payload = JSON.parse(text);
    expect(payload.results[0].result[0]).toMatchObject({
      uri: pathToFileURL(sourceFile).href,
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });

    await vi.waitFor(() => {
      const methods = readStubBridgeLog(logFile).map((entry: any) => entry.method);
      expect(methods).toContain('textDocument/definition');
    });
  });

  it('serves lsp_declaration through the live MCP path', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    writeFileSync(sourceFile, 'const value = alpha;\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });

    const declaration = await client.callTool({
      name: 'lsp_declaration',
      arguments: {
        uri: pathToFileURL(sourceFile).href,
        languageId: 'typescript',
        position: { line: 0, character: 6 }
      }
    });

    const text = declaration.content?.[0]?.type === 'text' ? declaration.content[0].text : '';
    const payload = JSON.parse(text);
    expect(payload.results[0].result[0]).toMatchObject({
      uri: pathToFileURL(sourceFile).href,
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });

    await vi.waitFor(() => {
      const methods = readStubBridgeLog(logFile).map((entry: any) => entry.method);
      expect(methods).toContain('textDocument/declaration');
    });
  });

  it('serves lsp_code_actions as sanitized data through the live MCP path with the source unchanged', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    const originalText = 'const value = 1;\n';
    writeFileSync(sourceFile, originalText);
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });

    const uri = pathToFileURL(sourceFile).href;
    const codeActions = await client.callTool({
      name: 'lsp_code_actions',
      arguments: {
        uri,
        languageId: 'typescript',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        context: { diagnostics: [] }
      }
    });

    const text = codeActions.content?.[0]?.type === 'text' ? codeActions.content[0].text : '';
    const action = JSON.parse(text).results[0].result[0];
    expect(action.title).toBe('Fix it');
    expect(action.edit.changes[uri]).toBeTruthy();
    expect(action.edit.documentChanges[0].textDocument.uri).toBe(uri);
    expect(action.edit.documentChanges[1].newUri).toBe(`${uri}.renamed`);
    expect('command' in action).toBe(false);
    expect('data' in action).toBe(false);
    expect(text).not.toContain('EXEC_ARG_STRIP');
    expect(text).not.toContain('CODEACTION_DATA_STRIP');
    expect(readFileSync(sourceFile, 'utf8')).toBe(originalText);

    await vi.waitFor(() => {
      const methods = readStubBridgeLog(logFile).map((entry: any) => entry.method);
      expect(methods).toContain('textDocument/codeAction');
    });
  });

  it('serves lsp_folding_ranges and lsp_selection_ranges as sanitized display data through the live MCP path', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    writeFileSync(sourceFile, 'function outer() {\\n  function inner() {\\n    return 1;\\n  }\\n}\\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });
    const uri = pathToFileURL(sourceFile).href;

    const folding = await client.callTool({
      name: 'lsp_folding_ranges',
      arguments: { uri, languageId: 'typescript' }
    });
    const selection = await client.callTool({
      name: 'lsp_selection_ranges',
      arguments: { uri, languageId: 'typescript', positions: [{ line: 1, character: 11 }] }
    });

    const foldingText = folding.content?.[0]?.type === 'text' ? folding.content[0].text : '';
    const selectionText = selection.content?.[0]?.type === 'text' ? selection.content[0].text : '';
    expect(JSON.parse(foldingText).results[0].result).toEqual([
      { startLine: 0, startCharacter: 0, endLine: 4, endCharacter: 1, kind: 'region' },
      { startLine: 6, endLine: 8 }
    ]);
    expect(JSON.parse(selectionText).results[0].result).toEqual([
      {
        range: { start: { line: 1, character: 11 }, end: { line: 1, character: 16 } },
        parent: { range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } } }
      }
    ]);
    const serialized = `${foldingText}\n${selectionText}`;
    expect(serialized).not.toContain('FAKE_DISPLAY_SECRET');
    expect(serialized).not.toContain('collapsedText');
    expect(serialized).not.toContain('serverCommands');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('arguments');

    await vi.waitFor(() => {
      const methods = readStubBridgeLog(logFile).map((entry: any) => entry.method);
      expect(methods).toContain('textDocument/foldingRange');
      expect(methods).toContain('textDocument/selectionRange');
    });
  });

  it('serves lsp_diagnostics from publishDiagnostics through the live MCP path', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    writeFileSync(sourceFile, 'const value = 1;\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript', publishDiagnostics: true });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });
    const uri = pathToFileURL(sourceFile).href;

    await client.callTool({
      name: 'lsp_hover',
      arguments: {
        uri,
        languageId: 'typescript',
        position: { line: 0, character: 1 }
      }
    });

    await vi.waitFor(() =>
      expect(readStubBridgeLog(logFile).some((entry: any) => entry.method === 'textDocument/didOpen')).toBe(true)
    );

    const diagnostics = await client.callTool({
      name: 'lsp_diagnostics',
      arguments: {
        uri,
        languageId: 'typescript'
      }
    });

    const text = diagnostics.content?.[0]?.type === 'text' ? diagnostics.content[0].text : '';
    const payload = JSON.parse(text);
    expect(payload).toEqual({
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: 'typescript diagnostic',
          severity: 1,
          source: 'typescript',
          code: 'typescript-diagnostic',
          tags: [1]
        }
      ]
    });
    expect(JSON.stringify(payload)).not.toContain('relatedInformation');
    expect(JSON.stringify(payload)).not.toContain('codeDescription');
    expect(JSON.stringify(payload)).not.toContain('omitted data');
  });

  it('advertises diagnostics and semantic-token tools and serves semantic tokens through the live MCP path', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    writeFileSync(sourceFile, 'const value = 1;\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });
    const client = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });
    const uri = pathToFileURL(sourceFile).href;

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['lsp_diagnostics', 'lsp_semantic_tokens'])
    );

    const semanticTokens = await client.callTool({
      name: 'lsp_semantic_tokens',
      arguments: {
        uri,
        languageId: 'typescript'
      }
    });

    const text = semanticTokens.content?.[0]?.type === 'text' ? semanticTokens.content[0].text : '';
    const payload = JSON.parse(text);
    expect(payload.results[0]).toEqual({
      serverConfigId: 'typescript',
      isPrimary: true,
      result: { data: [0, 0, 5, 1, 0] },
      legend: { tokenTypes: ['variable', 'function'], tokenModifiers: ['declaration'] },
      semanticTokensProvider: { full: { delta: false }, range: true }
    });
    expect(text).not.toContain('FAKE_DISPLAY_SECRET');
    expect(text).not.toContain('result-id-secret');
    expect(text).not.toContain('serverCommands');
    expect(text).not.toContain('command');

    await vi.waitFor(() => {
      const methods = readStubBridgeLog(logFile).map((entry: any) => entry.method);
      expect(methods).toContain('textDocument/semanticTokens/full');
    });
  });

  it('returns sanitized MCP errors for wrong token and out-of-root URIs', async () => {
    const logFile = join(root, 'fake-lsp.log');
    const sourceFile = join(root, 'main.ts');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'desk-lsp-mcp-outside-'));
    const outsideFile = join(outsideRoot, 'other.ts');
    writeFileSync(sourceFile, 'const value = 1;\n');
    writeFileSync(outsideFile, 'const value = 2;\n');
    const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript' });
    const harness = await startHarness({
      languages: ['typescript'],
      serverCommands: { typescript: { enabled: true, ...fake, languageIds: ['typescript'], extensions: ['.ts'] } }
    });

    const wrongTokenClient = await startMcpClient({ token: 'wrong-token', apiUrl: harness.apiUrl });
    const wrongToken = await wrongTokenClient.callTool({
      name: 'lsp_hover',
      arguments: { uri: pathToFileURL(sourceFile).href, position: { line: 0, character: 0 } }
    });
    expect(JSON.stringify(wrongToken)).not.toContain('wrong-token');
    expect(JSON.stringify(wrongToken)).not.toContain(root);
    expect(JSON.stringify(wrongToken)).toContain('LSP hover request failed');
    await wrongTokenClient.close();

    const validClient = await startMcpClient({ token: harness.token, apiUrl: harness.apiUrl });
    const outOfRoot = await validClient.callTool({
      name: 'lsp_hover',
      arguments: { uri: pathToFileURL(outsideFile).href, position: { line: 0, character: 0 } }
    });
    expect(JSON.stringify(outOfRoot)).not.toContain(harness.token);
    expect(JSON.stringify(outOfRoot)).not.toContain(root);
    expect(JSON.stringify(outOfRoot)).not.toContain(outsideRoot);
    expect(JSON.stringify(outOfRoot)).toContain('LSP hover request failed');
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  async function startHarness(lspSettings: unknown) {
    registry = createLspCapabilityTokenRegistry();
    const { token } = registry.mint(root);
    manager = new LspManager();
    const requestPlanner = {
      planLspRequest(input: {
        settings: unknown;
        uri?: string;
        languageId?: string;
        workspaceRoot: string;
        feature: string;
      }) {
        return planLspRequest({ ...input, settings: input.settings as NormalizedLspSettings });
      }
    };
    const settings = normalizeLspSettings(lspSettings);
    const requestApi = createLspRequestApi({
      getSettings: () => settings,
      hoverService: createHoverService({ requestPlanner, manager }),
      formattingService: createFormattingService({ requestPlanner, manager }),
      foldingRangeService: createFoldingRangeService({ requestPlanner, manager }),
      documentSymbolService: createDocumentSymbolService({ requestPlanner, manager }),
      completionService: createCompletionService({ requestPlanner, manager }),
      signatureHelpService: createSignatureHelpService({ requestPlanner, manager }),
      renameService: createRenameService({ requestPlanner, manager }),
      documentHighlightService: createDocumentHighlightService({ requestPlanner, manager }),
      locationService: createLocationService({ requestPlanner, manager }),
      diagnosticsService: createDiagnosticsService({ manager }),
      codeActionService: createCodeActionService({ requestPlanner, manager }),
      selectionRangeService: createSelectionRangeService({ requestPlanner, manager }),
      semanticTokensService: createSemanticTokensService({ requestPlanner, manager })
    });
    const endpoint = createLspHttpEndpoint({ tokenRegistry: registry, requestApi });
    for (const language of settings.languages) {
      await manager.startServer({
        serverConfigId: language.serverConfigId,
        workspaceRoot: root,
        command: language.command,
        args: language.args,
        env: language.env,
        initializationOptions: language.initializationOptions,
        startupTimeoutMs: settings.startupTimeoutMs
      });
    }
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!(await endpoint.handleNodeRequest(req, res, url))) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected tcp server address');
    }
    return { token, apiUrl: `http://127.0.0.1:${address.port}` };
  }

  async function startMcpClient(options: { token: string; apiUrl: string }) {
    mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/server/lsp/deskLspMcpCli.ts'],
      env: {
        ...process.env,
        DESK_API: options.apiUrl,
        DESK_LSP_TOKEN: options.token,
        DESK_LSP_WORKSPACE_ROOT: root
      },
      cwd: process.cwd()
    });
    mcpClient = new Client({ name: 'desk-lsp-mcp-live-test', version: '0.0.0' });
    await mcpClient.connect(mcpTransport);
    return mcpClient;
  }
});
