import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { installLspWebSocketBridge } from '../src/server/lspWebSocketBridge';
import { createEditorSharedSessionFactory } from '../src/server/lsp/editorSharedSessionFactory';
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

interface Harness {
  server: Server;
  manager: LspManager;
  token: string;
  apiUrl: string;
  root: string;
  uri: string;
  logFile: string;
  dispose: () => void;
}

const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  sockets.length = 0;
  for (const h of harnesses) {
    h.dispose();
    if (h.server.listening) await new Promise<void>((r) => h.server.close(() => r()));
    await h.manager.stopAll();
    rmSync(h.root, { recursive: true, force: true });
  }
  harnesses.length = 0;
  forceKillActiveStdioVirtualSessionChildren();
});

async function startSharedHarness(idleTimeoutMs = 5000): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desk-shared-')));
  writeFileSync(join(root, 'sample.ts'), 'const value = 1;\n');
  const uri = pathToFileURL(join(root, 'sample.ts')).href;
  const logFile = join(root, 'fake-lsp.log');
  const fake = createStubBridgeStdioServerCommand({ logFile, label: 'typescript', publishDiagnostics: true });
  const lsp = {
    enabled: true,
    languages: ['typescript'],
    maxSessions: 4,
    serverCommands: {
      typescript: { enabled: true, command: fake.command, args: fake.args, env: fake.env, languageIds: ['typescript'], extensions: ['.ts'] }
    }
  };
  const settings = normalizeLspSettings(lsp);
  const registry = createLspCapabilityTokenRegistry();
  const { token } = registry.mint(root);
  const manager = new LspManager(undefined, { idleTimeoutMs });
  const requestPlanner = {
    planLspRequest(input: { settings: unknown; uri?: string; languageId?: string; workspaceRoot: string; feature: string }) {
      return planLspRequest({ ...input, settings: input.settings as NormalizedLspSettings });
    }
  };
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
  const editorFactory = createEditorSharedSessionFactory({ manager, readManifest: () => ({ settings: { lsp } }) as any });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!(await endpoint.handleNodeRequest(req, res, url))) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  const disposeBridge = installLspWebSocketBridge(server, { createSession: editorFactory });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  const h: Harness = { server, manager, token, apiUrl: `http://127.0.0.1:${port}`, root, uri, logFile, dispose: disposeBridge };
  harnesses.push(h);
  return h;
}

function openWs(h: Harness, query: string): WebSocket {
  const { port } = h.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/lsp?${query}`);
  sockets.push(ws);
  return ws;
}
function onMessages(ws: WebSocket): any[] {
  const out: any[] = [];
  ws.on('message', (d) => out.push(JSON.parse(String(d))));
  return out;
}
async function waitReady(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws ready timeout')), 4000);
    ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(String(d))); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}
async function agent(h: Harness, body: unknown, token = h.token): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.apiUrl}/api/lsp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}
const initializeCount = (logFile: string) =>
  readStubBridgeLog(logFile).filter((e: any) => e?.method === 'initialize').length;

describe('shared editor+agent live (current-runtime semantics)', () => {
  it('shares ONE child for concurrent editor /ws/lsp + agent /api/lsp; both correct; diagnostics to both', async () => {
    const h = await startSharedHarness();
    const ws = openWs(h, `workspaceRoot=${encodeURIComponent(h.root)}&uri=${encodeURIComponent(h.uri)}&languageId=typescript`);
    const editorMsgs = onMessages(ws);
    const ready = await waitReady(ws);
    expect(ready).toMatchObject({ type: 'ready' });
    expect((ready as any).capabilities?.hoverProvider).toBe(true);

    // editor hover round-trips through the shared child
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 0, character: 0 } } }));
    await vi.waitFor(() => expect(editorMsgs.some((m) => m.id === 1 && m.result)).toBe(true), { timeout: 4000 });
    expect(editorMsgs.find((m) => m.id === 1).result.contents).toContain('typescript hover');

    // editor received a raw publishDiagnostics notification (full fields) from the shared child
    await vi.waitFor(() => expect(editorMsgs.some((m) => m.method === 'textDocument/publishDiagnostics')).toBe(true), { timeout: 4000 });

    // concurrent agent hover reuses the SAME session
    const aHover = await agent(h, { method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 1, character: 2 } } });
    expect(aHover.status).toBe(200);
    expect(aHover.json.ok).toBe(true);
    expect(JSON.stringify(aHover.json.result)).toContain('typescript hover');

    // agent sees diagnostics via desk/lspDiagnostics (minimal shape, no relatedInformation/codeDescription/data/uri)
    const aDiag = await agent(h, { method: 'desk/lspDiagnostics', params: { textDocument: { uri: h.uri } } });
    expect(aDiag.json.ok).toBe(true);
    const diags = aDiag.json.result.diagnostics;
    expect(Array.isArray(diags)).toBe(true);
    expect(diags.length).toBeGreaterThan(0);
    const d0 = diags[0];
    expect(d0.message).toContain('typescript diagnostic');
    expect('relatedInformation' in d0).toBe(false);
    expect('codeDescription' in d0).toBe(false);
    expect('data' in d0).toBe(false);
    expect('uri' in d0).toBe(false);

    // ONE child: exactly one initialize in the shared child's log
    expect(initializeCount(h.logFile)).toBe(1);
  });

  it('agent Authorization is rejected without a valid bearer token (header-only, no body token)', async () => {
    const h = await startSharedHarness();
    const ws = openWs(h, `workspaceRoot=${encodeURIComponent(h.root)}&uri=${encodeURIComponent(h.uri)}&languageId=typescript`);
    await waitReady(ws);
    const noToken = await agent(h, { method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 0, character: 0 } } }, 'wrong');
    expect(noToken.status).toBe(401);
    expect(JSON.stringify(noToken.json)).not.toContain(h.token);
  });

  it('id/cancel isolation: held editor request + cancel do not cross with a concurrent agent request', async () => {
    const h = await startSharedHarness();
    const ws = openWs(h, `workspaceRoot=${encodeURIComponent(h.root)}&uri=${encodeURIComponent(h.uri)}&languageId=typescript`);
    const editorMsgs = onMessages(ws);
    await waitReady(ws);
    // editor request id 1 held server-side (no response)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 0, character: 0 }, hold: true } }));
    // concurrent agent request completes correctly (own id space, no cross)
    const aHover = await agent(h, { method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 3, character: 4 } } });
    expect(aHover.json.ok).toBe(true);
    expect(JSON.stringify(aHover.json.result)).toContain('typescript hover');
    // editor cancels id 1; fake observes a $/cancelRequest; editor never received an id-1 result (held, no cross)
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } }));
    await vi.waitFor(() => expect(readStubBridgeLog(h.logFile).some((e: any) => e?.method === '$/cancelRequest')).toBe(true), { timeout: 4000 });
    expect(editorMsgs.some((m) => m.id === 1 && 'result' in m)).toBe(false);
    expect(initializeCount(h.logFile)).toBe(1);
  });

  it('reconnect within the idle window reuses the same child and resumes', async () => {
    const h = await startSharedHarness(5000);
    const q = `workspaceRoot=${encodeURIComponent(h.root)}&uri=${encodeURIComponent(h.uri)}&languageId=typescript`;
    const ws1 = openWs(h, q);
    await waitReady(ws1);
    expect(initializeCount(h.logFile)).toBe(1);
    ws1.close();
    await new Promise((r) => ws1.once('close', r));
    // reconnect promptly (within idle window) -> same child
    const ws2 = openWs(h, q);
    const msgs2 = onMessages(ws2);
    await waitReady(ws2);
    ws2.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 0, character: 0 } } }));
    await vi.waitFor(() => expect(msgs2.some((m) => m.id === 9 && m.result)).toBe(true), { timeout: 4000 });
    expect(initializeCount(h.logFile)).toBe(1); // no second child spawned
  });

  it('after editor close + idle expiry, a later agent request does not keep/reuse a session (current semantics)', async () => {
    const h = await startSharedHarness(30); // short idle
    const ws = openWs(h, `workspaceRoot=${encodeURIComponent(h.root)}&uri=${encodeURIComponent(h.uri)}&languageId=typescript`);
    await waitReady(ws);
    expect(initializeCount(h.logFile)).toBe(1);
    ws.close();
    await new Promise((r) => ws.once('close', r));
    await new Promise((r) => setTimeout(r, 200)); // exceed idle window -> editor-owned session idle-stops
    // agent request is a transient sendRequest; it does NOT own a persistent lease.
    const aHover = await agent(h, { method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 0, character: 0 } } });
    // current semantics: with no editor-owned session, the transient agent request fails closed (no lease, no editor session to reuse)
    expect(aHover.json.ok).toBe(false);
  });

  it('real ~/.config/desk/desk.yml is untouched by the shared proof', async () => {
    const real = join(homedir(), '.config', 'desk', 'desk.yml');
    const before = existsSync(real) ? createHash('sha256').update(readFileSync(real)).digest('hex') : 'absent';
    const h = await startSharedHarness();
    const ws = openWs(h, `workspaceRoot=${encodeURIComponent(h.root)}&uri=${encodeURIComponent(h.uri)}&languageId=typescript`);
    await waitReady(ws);
    await agent(h, { method: 'textDocument/hover', params: { textDocument: { uri: h.uri }, position: { line: 0, character: 0 } } });
    const after = existsSync(real) ? createHash('sha256').update(readFileSync(real)).digest('hex') : 'absent';
    expect(after).toBe(before);
  });
});
