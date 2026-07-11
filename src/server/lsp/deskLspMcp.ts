import { lstatSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveFsPath } from '../fsSafety.js';
import { sanitizeFoldingRangeResponse } from './foldingRangeService.js';
import {
  isSelectionRangePositions,
  sanitizeSelectionRangeResponse,
  type SelectionRangePosition
} from './selectionRangeService.js';
import { sanitizeSemanticTokensResponse } from './semanticTokensService.js';

export interface DeskLspMcpEnvironment {
  DESK_API?: string;
  DESK_LSP_TOKEN?: string;
  DESK_LSP_WORKSPACE_ROOT?: string;
  DESK_LSP_ENV_FILE?: string;
}

export interface DeskLspMcpOptions {
  env?: DeskLspMcpEnvironment;
  fetch?: typeof fetch;
}

export type LspToolErrorCode =
  | 'missing-env'
  | 'missing-token'
  | 'fetch-unavailable'
  | 'invalid-input'
  | 'bad-api-url'
  | 'http-failed'
  | 'bad-json'
  | 'bad-response'
  | 'fetch-failed';

export interface LspHoverToolInput {
  uri: string;
  position: {
    line: number;
    character: number;
  };
  languageId?: string;
  [key: string]: unknown;
}

type FetchLike = typeof fetch;

interface LspToolRequest {
  method: string;
  uri: string;
  languageId?: string;
  params: Record<string, unknown>;
}

interface TextDocumentInput {
  uri: string;
  languageId?: string;
}

interface DiagnosticsToolInput extends TextDocumentInput {
  refresh?: boolean;
}

interface SelectionRangeToolInput extends TextDocumentInput {
  positions: SelectionRangePosition[];
}

interface PositionInput extends TextDocumentInput {
  position: {
    line: number;
    character: number;
  };
}

interface FormattingToolInput extends TextDocumentInput {
  options: {
    tabSize: number;
    insertSpaces: boolean;
  };
}

interface CompletionToolInput extends PositionInput {
  context?: {
    triggerKind: number;
    triggerCharacter?: string;
  };
}

interface SignatureHelpToolInput extends PositionInput {
  context?: {
    triggerKind: number;
    triggerCharacter?: string;
    isRetrigger?: boolean;
  };
}

interface RenameToolInput extends PositionInput {
  newName: string;
}

interface ReferencesToolInput extends PositionInput {
  includeDeclaration?: boolean;
}

interface CallLspToolOptions {
  preserveWorkspaceRootInResult?: boolean;
  sanitizeResult?: (value: unknown) => unknown;
  scrubResultKeys?: boolean;
}

const POSITION_INPUT_SCHEMA = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative()
});

const TEXT_DOCUMENT_INPUT_SCHEMA = {
  uri: z.string(),
  languageId: z.string().optional()
};

const POSITIONED_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA,
  position: POSITION_INPUT_SCHEMA
};

const HOVER_INPUT_SCHEMA = {
  ...POSITIONED_INPUT_SCHEMA
};

const FORMAT_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA,
  options: z.object({
    tabSize: z.number(),
    insertSpaces: z.boolean()
  })
};

const DOCUMENT_SYMBOL_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA
};

const FOLDING_RANGE_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA
};

const SEMANTIC_TOKENS_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA
};

const SELECTION_RANGE_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA,
  positions: z.array(POSITION_INPUT_SCHEMA).min(1).max(100)
};

const DIAGNOSTICS_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA,
  refresh: z.boolean().optional()
};

const COMPLETION_INPUT_SCHEMA = {
  ...POSITIONED_INPUT_SCHEMA,
  context: z
    .object({
      triggerKind: z.number(),
      triggerCharacter: z.string().optional()
    })
    .optional()
};

const SIGNATURE_HELP_INPUT_SCHEMA = {
  ...POSITIONED_INPUT_SCHEMA,
  context: z
    .object({
      triggerKind: z.number(),
      triggerCharacter: z.string().optional(),
      isRetrigger: z.boolean().optional()
    })
    .optional()
};

const RENAME_INPUT_SCHEMA = {
  ...POSITIONED_INPUT_SCHEMA,
  newName: z.string()
};

const DOCUMENT_HIGHLIGHT_INPUT_SCHEMA = {
  ...POSITIONED_INPUT_SCHEMA
};

const REFERENCES_INPUT_SCHEMA = {
  ...POSITIONED_INPUT_SCHEMA,
  includeDeclaration: z.boolean().optional()
};

const CODE_ACTION_INPUT_SCHEMA = {
  ...TEXT_DOCUMENT_INPUT_SCHEMA,
  range: z.object({ start: POSITION_INPUT_SCHEMA, end: POSITION_INPUT_SCHEMA }),
  context: z.object({
    diagnostics: z.array(z.unknown()),
    only: z.array(z.string()).optional(),
    triggerKind: z.number().optional()
  })
};

const TOOL_ERROR_LABELS = {
  hover: 'LSP hover request failed',
  format: 'LSP format request failed',
  documentSymbols: 'LSP document symbols request failed',
  completion: 'LSP completion request failed',
  signatureHelp: 'LSP signature help request failed',
  prepareRename: 'LSP prepare rename request failed',
  rename: 'LSP rename request failed',
  documentHighlights: 'LSP document highlights request failed',
  definition: 'LSP definition request failed',
  references: 'LSP references request failed',
  typeDefinition: 'LSP type definition request failed',
  implementation: 'LSP implementation request failed',
  declaration: 'LSP declaration request failed',
  codeActions: 'LSP code actions request failed',
  diagnostics: 'LSP diagnostics request failed',
  foldingRanges: 'LSP folding ranges request failed',
  selectionRanges: 'LSP selection ranges request failed',
  semanticTokens: 'LSP semantic tokens request failed'
} as const;

const SENSITIVE_KEYS = new Set([
  'servercommands',
  'env',
  'command',
  'args',
  'initializationoptions',
  'token',
  'workspaceroot'
]);

interface DeskLspToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (input: unknown, options: DeskLspMcpOptions) => Promise<CallToolResult>;
}

const DESK_LSP_TOOL_DEFINITIONS = [
  {
    name: 'lsp_hover',
    title: 'LSP hover',
    description: 'Return hover information for an in-workspace file URI through Desk LSP.',
    inputSchema: HOVER_INPUT_SCHEMA,
    handler: callLspHover
  },
  {
    name: 'lsp_format',
    title: 'LSP format',
    description: 'Return document formatting edits for an in-workspace file URI through Desk LSP.',
    inputSchema: FORMAT_INPUT_SCHEMA,
    handler: callLspFormat
  },
  {
    name: 'lsp_document_symbols',
    title: 'LSP document symbols',
    description: 'Return document symbols for an in-workspace file URI through Desk LSP.',
    inputSchema: DOCUMENT_SYMBOL_INPUT_SCHEMA,
    handler: callLspDocumentSymbols
  },
  {
    name: 'lsp_folding_ranges',
    title: 'LSP folding ranges',
    description: 'Return sanitized folding ranges for an in-workspace file URI through Desk LSP.',
    inputSchema: FOLDING_RANGE_INPUT_SCHEMA,
    handler: callLspFoldingRanges
  },
  {
    name: 'lsp_selection_ranges',
    title: 'LSP selection ranges',
    description: 'Return sanitized selection ranges for positions in an in-workspace file URI through Desk LSP.',
    inputSchema: SELECTION_RANGE_INPUT_SCHEMA,
    handler: callLspSelectionRanges
  },
  {
    name: 'lsp_semantic_tokens',
    title: 'LSP semantic tokens',
    description: 'Return sanitized full semantic tokens and legend context for an in-workspace file URI through Desk LSP.',
    inputSchema: SEMANTIC_TOKENS_INPUT_SCHEMA,
    handler: callLspSemanticTokens
  },
  {
    name: 'lsp_completion',
    title: 'LSP completion',
    description: 'Return completion items for an in-workspace file URI through Desk LSP.',
    inputSchema: COMPLETION_INPUT_SCHEMA,
    handler: callLspCompletion
  },
  {
    name: 'lsp_signature_help',
    title: 'LSP signature help',
    description: 'Return signature help for an in-workspace file URI through Desk LSP.',
    inputSchema: SIGNATURE_HELP_INPUT_SCHEMA,
    handler: callLspSignatureHelp
  },
  {
    name: 'lsp_prepare_rename',
    title: 'LSP prepare rename',
    description: 'Return prepare-rename information for an in-workspace file URI through Desk LSP.',
    inputSchema: POSITIONED_INPUT_SCHEMA,
    handler: callLspPrepareRename
  },
  {
    name: 'lsp_rename',
    title: 'LSP rename',
    description: 'Return rename workspace edits as data for an in-workspace file URI through Desk LSP.',
    inputSchema: RENAME_INPUT_SCHEMA,
    handler: callLspRename
  },
  {
    name: 'lsp_document_highlights',
    title: 'LSP document highlights',
    description: 'Return document highlights for an in-workspace file URI through Desk LSP.',
    inputSchema: DOCUMENT_HIGHLIGHT_INPUT_SCHEMA,
    handler: callLspDocumentHighlights
  },
  {
    name: 'lsp_definition',
    title: 'LSP definition',
    description: 'Return definition locations for an in-workspace file URI through Desk LSP.',
    inputSchema: POSITIONED_INPUT_SCHEMA,
    handler: callLspDefinition
  },
  {
    name: 'lsp_references',
    title: 'LSP references',
    description: 'Return reference locations for an in-workspace file URI through Desk LSP.',
    inputSchema: REFERENCES_INPUT_SCHEMA,
    handler: callLspReferences
  },
  {
    name: 'lsp_type_definition',
    title: 'LSP type definition',
    description: 'Return type-definition locations for an in-workspace file URI through Desk LSP.',
    inputSchema: POSITIONED_INPUT_SCHEMA,
    handler: callLspTypeDefinition
  },
  {
    name: 'lsp_implementation',
    title: 'LSP implementation',
    description: 'Return implementation locations for an in-workspace file URI through Desk LSP.',
    inputSchema: POSITIONED_INPUT_SCHEMA,
    handler: callLspImplementation
  },
  {
    name: 'lsp_declaration',
    title: 'LSP declaration',
    description: 'Return declaration locations for an in-workspace file URI through Desk LSP.',
    inputSchema: POSITIONED_INPUT_SCHEMA,
    handler: callLspDeclaration
  },
  {
    name: 'lsp_code_actions',
    title: 'LSP code actions',
    description: 'Return code actions as data (no apply/execute) for a range in an in-workspace file URI through Desk LSP.',
    inputSchema: CODE_ACTION_INPUT_SCHEMA,
    handler: callLspCodeActions
  },
  {
    name: 'lsp_diagnostics',
    title: 'LSP diagnostics',
    description: 'Return current diagnostics for an in-workspace file URI through Desk LSP.',
    inputSchema: DIAGNOSTICS_INPUT_SCHEMA,
    handler: callLspDiagnostics
  }
] satisfies readonly DeskLspToolDefinition[];

export function createDeskLspMcpServer(options: DeskLspMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'desk-lsp-mcp', version: '0.1.0' });

  for (const definition of DESK_LSP_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema
      },
      async (input) => definition.handler(input, options)
    );
  }

  return server;
}

export async function callLspHover(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildHoverRequest, TOOL_ERROR_LABELS.hover);
}

export async function callLspFormat(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildFormatRequest, TOOL_ERROR_LABELS.format);
}

export async function callLspDocumentSymbols(
  input: unknown,
  options: DeskLspMcpOptions = {}
): Promise<CallToolResult> {
  return callLspTool(input, options, buildDocumentSymbolsRequest, TOOL_ERROR_LABELS.documentSymbols);
}

export async function callLspFoldingRanges(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildFoldingRangesRequest, TOOL_ERROR_LABELS.foldingRanges, {
    sanitizeResult: sanitizeFoldingRangeResponse,
    scrubResultKeys: true
  });
}

export async function callLspSelectionRanges(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildSelectionRangesRequest, TOOL_ERROR_LABELS.selectionRanges, {
    sanitizeResult: sanitizeSelectionRangeResponse,
    scrubResultKeys: true
  });
}

export async function callLspSemanticTokens(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildSemanticTokensRequest, TOOL_ERROR_LABELS.semanticTokens, {
    sanitizeResult: sanitizeSemanticTokensResponse,
    scrubResultKeys: true
  });
}

export async function callLspCompletion(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildCompletionRequest, TOOL_ERROR_LABELS.completion);
}

export async function callLspSignatureHelp(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildSignatureHelpRequest, TOOL_ERROR_LABELS.signatureHelp);
}

export async function callLspPrepareRename(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildPrepareRenameRequest, TOOL_ERROR_LABELS.prepareRename);
}

export async function callLspRename(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildRenameRequest, TOOL_ERROR_LABELS.rename);
}

export async function callLspDocumentHighlights(
  input: unknown,
  options: DeskLspMcpOptions = {}
): Promise<CallToolResult> {
  return callLspTool(input, options, buildDocumentHighlightsRequest, TOOL_ERROR_LABELS.documentHighlights);
}

export async function callLspDefinition(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspLocationTool(input, options, buildDefinitionRequest, TOOL_ERROR_LABELS.definition);
}

export async function callLspReferences(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspLocationTool(input, options, buildReferencesRequest, TOOL_ERROR_LABELS.references);
}

export async function callLspTypeDefinition(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspLocationTool(input, options, buildTypeDefinitionRequest, TOOL_ERROR_LABELS.typeDefinition);
}

export async function callLspImplementation(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspLocationTool(input, options, buildImplementationRequest, TOOL_ERROR_LABELS.implementation);
}

export async function callLspDeclaration(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspLocationTool(input, options, buildDeclarationRequest, TOOL_ERROR_LABELS.declaration);
}

export async function callLspCodeActions(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildCodeActionRequest, TOOL_ERROR_LABELS.codeActions, {
    preserveWorkspaceRootInResult: true,
    sanitizeResult: stripCodeActionExecutable,
    scrubResultKeys: true
  });
}

export async function callLspDiagnostics(input: unknown, options: DeskLspMcpOptions = {}): Promise<CallToolResult> {
  return callLspTool(input, options, buildDiagnosticsRequest, TOOL_ERROR_LABELS.diagnostics);
}

async function callLspLocationTool(
  input: unknown,
  options: DeskLspMcpOptions,
  buildRequest: (input: unknown) => LspToolRequest | undefined,
  errorMessage: string
): Promise<CallToolResult> {
  return callLspTool(input, options, buildRequest, errorMessage, { preserveWorkspaceRootInResult: true });
}

async function callLspTool(
  input: unknown,
  options: DeskLspMcpOptions,
  buildRequest: (input: unknown) => LspToolRequest | undefined,
  errorMessage: string,
  toolOptions: CallLspToolOptions = {}
): Promise<CallToolResult> {
  const env = loadMcpEnvironment(options.env ?? process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!env) {
    return toolError(errorMessage, 'missing-env');
  }
  const apiBase = typeof env.DESK_API === 'string' ? env.DESK_API.trim() : '';
  const token = typeof env.DESK_LSP_TOKEN === 'string' ? env.DESK_LSP_TOKEN.trim() : '';
  const workspaceRoot =
    typeof env.DESK_LSP_WORKSPACE_ROOT === 'string' && env.DESK_LSP_WORKSPACE_ROOT.trim() !== ''
      ? env.DESK_LSP_WORKSPACE_ROOT.trim()
      : undefined;
  const secrets = [token, workspaceRoot].filter((value): value is string => Boolean(value));

  if (!apiBase) {
    return toolError(errorMessage, 'missing-env');
  }
  if (!token) {
    return toolError(errorMessage, 'missing-token');
  }
  if (typeof fetchImpl !== 'function') {
    return toolError(errorMessage, 'fetch-unavailable');
  }

  const request = buildRequest(input);
  if (!request || !passesOptionalWorkspacePreflight(request.uri, workspaceRoot)) {
    return toolError(errorMessage, 'invalid-input');
  }

  let apiUrl: string;
  try {
    const parsedApiUrl = new URL('/api/lsp', ensureTrailingSlash(apiBase));
    if (parsedApiUrl.protocol !== 'http:' && parsedApiUrl.protocol !== 'https:') {
      return toolError(errorMessage, 'bad-api-url');
    }
    apiUrl = parsedApiUrl.toString();
  } catch {
    return toolError(errorMessage, 'bad-api-url');
  }

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: request.method,
        ...(request.languageId !== undefined ? { languageId: request.languageId } : {}),
        params: request.params
      })
    });
  } catch {
    return toolError(errorMessage, 'fetch-failed');
  }

  if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
    return toolError(errorMessage, 'bad-response');
  }
  if (!response.ok) {
    return toolError(errorMessage, 'http-failed');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return toolError(errorMessage, 'bad-json');
  }
  if (!isRecord(payload) || payload.ok !== true || !('result' in payload)) {
    return toolError(errorMessage, 'bad-response');
  }

  try {
    const resultSecrets = toolOptions.preserveWorkspaceRootInResult ? [token] : secrets;
    const sanitizedResult = toolOptions.sanitizeResult ? toolOptions.sanitizeResult(payload.result) : payload.result;
    return toolSuccess(redactPayload(sanitizedResult, resultSecrets, { scrubKeys: toolOptions.scrubResultKeys === true }));
  } catch {
    return toolError(errorMessage, 'bad-response');
  }
}

function parseHoverInput(input: unknown): LspHoverToolInput | undefined {
  if (!isRecord(input) || typeof input.uri !== 'string' || !isRecord(input.position)) {
    return undefined;
  }
  const line = input.position.line;
  const character = input.position.character;
  if (typeof line !== 'number' || typeof character !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    return undefined;
  }
  return {
    uri: input.uri,
    position: { line, character },
    ...(typeof input.languageId === 'string' ? { languageId: input.languageId } : {})
  };
}

function buildHoverRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseHoverInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/hover',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position
    }
  };
}

function buildFormatRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseFormattingInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/formatting',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      options: parsed.options
    }
  };
}

function buildDocumentSymbolsRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseTextDocumentInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/documentSymbol',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri }
    }
  };
}

function buildFoldingRangesRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseTextDocumentInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/foldingRange',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri }
    }
  };
}

function buildSelectionRangesRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseSelectionRangeInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/selectionRange',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      positions: parsed.positions
    }
  };
}

function buildSemanticTokensRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseTextDocumentInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/semanticTokens/full',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri }
    }
  };
}

function buildCompletionRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseCompletionInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/completion',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position,
      ...(parsed.context !== undefined ? { context: parsed.context } : {})
    }
  };
}

function buildSignatureHelpRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseSignatureHelpInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/signatureHelp',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position,
      ...(parsed.context !== undefined ? { context: parsed.context } : {})
    }
  };
}

function buildPrepareRenameRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parsePositionInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/prepareRename',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position
    }
  };
}

function buildRenameRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseRenameInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/rename',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position,
      newName: parsed.newName
    }
  };
}

function buildDocumentHighlightsRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parsePositionInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/documentHighlight',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position
    }
  };
}

function buildDefinitionRequest(input: unknown): LspToolRequest | undefined {
  return buildPositionRequest(input, 'textDocument/definition');
}

function buildTypeDefinitionRequest(input: unknown): LspToolRequest | undefined {
  return buildPositionRequest(input, 'textDocument/typeDefinition');
}

function buildImplementationRequest(input: unknown): LspToolRequest | undefined {
  return buildPositionRequest(input, 'textDocument/implementation');
}

function buildDeclarationRequest(input: unknown): LspToolRequest | undefined {
  return buildPositionRequest(input, 'textDocument/declaration');
}

function buildCodeActionRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseCodeActionInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/codeAction',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      range: parsed.range,
      context: parsed.context
    }
  };
}

function parseCodeActionInput(input: unknown):
  | {
      uri: string;
      languageId?: string;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      context: { diagnostics: unknown[]; only?: string[]; triggerKind?: number };
    }
  | undefined {
  const textDocument = parseTextDocumentInput(input);
  if (!textDocument || !isRecord(input)) {
    return undefined;
  }
  const range = parseCodeActionRange(input.range);
  if (!range) {
    return undefined;
  }
  const context = input.context;
  if (!isRecord(context) || !Array.isArray(context.diagnostics)) {
    return undefined;
  }
  if (context.only !== undefined && !(Array.isArray(context.only) && context.only.every((entry) => typeof entry === 'string'))) {
    return undefined;
  }
  if (context.triggerKind !== undefined && typeof context.triggerKind !== 'number') {
    return undefined;
  }
  return {
    ...textDocument,
    range,
    context: {
      diagnostics: context.diagnostics,
      ...(context.only !== undefined ? { only: context.only as string[] } : {}),
      ...(context.triggerKind !== undefined ? { triggerKind: context.triggerKind as number } : {})
    }
  };
}

function parseCodeActionRange(
  value: unknown
): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = parseCodeActionPosition(value.start);
  const end = parseCodeActionPosition(value.end);
  if (!start || !end) {
    return undefined;
  }
  return { start, end };
}

function parseCodeActionPosition(value: unknown): { line: number; character: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { line, character } = value as { line?: unknown; character?: unknown };
  if (typeof line !== 'number' || typeof character !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    return undefined;
  }
  return { line, character };
}

function stripCodeActionExecutable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCodeActionExecutable);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'command' && key !== 'arguments' && key !== 'data')
        .map(([key, entry]) => [key, stripCodeActionExecutable(entry)])
    );
  }
  return value;
}

function buildPositionRequest(input: unknown, method: string): LspToolRequest | undefined {
  const parsed = parsePositionInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method,
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position
    }
  };
}

function buildReferencesRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseReferencesInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'textDocument/references',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      position: parsed.position,
      context: { includeDeclaration: parsed.includeDeclaration ?? false }
    }
  };
}

function buildDiagnosticsRequest(input: unknown): LspToolRequest | undefined {
  const parsed = parseDiagnosticsInput(input);
  if (!parsed) {
    return undefined;
  }
  return {
    method: 'desk/lspDiagnostics',
    uri: parsed.uri,
    languageId: parsed.languageId,
    params: {
      textDocument: { uri: parsed.uri },
      ...(parsed.refresh === true ? { refresh: true } : {})
    }
  };
}

function parseDiagnosticsInput(input: unknown): DiagnosticsToolInput | undefined {
  const parsed = parseTextDocumentInput(input);
  if (!parsed || !isRecord(input)) {
    return undefined;
  }
  return {
    ...parsed,
    ...(input.refresh === true ? { refresh: true } : {})
  };
}

function parseSelectionRangeInput(input: unknown): SelectionRangeToolInput | undefined {
  const parsed = parseTextDocumentInput(input);
  if (!parsed || !isRecord(input) || !isSelectionRangePositions(input.positions)) {
    return undefined;
  }
  return { ...parsed, positions: input.positions };
}

function parseTextDocumentInput(input: unknown): TextDocumentInput | undefined {
  if (!isRecord(input) || typeof input.uri !== 'string') {
    return undefined;
  }
  return {
    uri: input.uri,
    ...(typeof input.languageId === 'string' ? { languageId: input.languageId } : {})
  };
}

function parsePositionInput(input: unknown): PositionInput | undefined {
  const textDocument = parseTextDocumentInput(input);
  if (!textDocument || !isRecord(input) || !isRecord(input.position)) {
    return undefined;
  }
  const line = input.position.line;
  const character = input.position.character;
  if (typeof line !== 'number' || typeof character !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    return undefined;
  }
  return { ...textDocument, position: { line, character } };
}

function parseFormattingInput(input: unknown): FormattingToolInput | undefined {
  const textDocument = parseTextDocumentInput(input);
  if (!textDocument || !isRecord(input) || !isRecord(input.options)) {
    return undefined;
  }
  const tabSize = input.options.tabSize;
  const insertSpaces = input.options.insertSpaces;
  if (typeof tabSize !== 'number' || typeof insertSpaces !== 'boolean') {
    return undefined;
  }
  return { ...textDocument, options: { tabSize, insertSpaces } };
}

function parseCompletionInput(input: unknown): CompletionToolInput | undefined {
  const positioned = parsePositionInput(input);
  if (!positioned || !isRecord(input)) {
    return undefined;
  }
  if (!isCompletionContext(input.context)) {
    return undefined;
  }
  return {
    ...positioned,
    ...(input.context !== undefined ? { context: input.context } : {})
  };
}

function parseSignatureHelpInput(input: unknown): SignatureHelpToolInput | undefined {
  const positioned = parsePositionInput(input);
  if (!positioned || !isRecord(input)) {
    return undefined;
  }
  if (!isSignatureHelpContext(input.context)) {
    return undefined;
  }
  return {
    ...positioned,
    ...(input.context !== undefined ? { context: input.context } : {})
  };
}

function parseRenameInput(input: unknown): RenameToolInput | undefined {
  const positioned = parsePositionInput(input);
  if (!positioned || !isRecord(input) || typeof input.newName !== 'string') {
    return undefined;
  }
  return { ...positioned, newName: input.newName };
}

function parseReferencesInput(input: unknown): ReferencesToolInput | undefined {
  const positioned = parsePositionInput(input);
  if (!positioned || !isRecord(input)) {
    return undefined;
  }
  if (input.includeDeclaration !== undefined && typeof input.includeDeclaration !== 'boolean') {
    return undefined;
  }
  return {
    ...positioned,
    ...(input.includeDeclaration !== undefined ? { includeDeclaration: input.includeDeclaration } : {})
  };
}

function isCompletionContext(value: unknown): value is CompletionToolInput['context'] {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.triggerKind === 'number' &&
      (value.triggerCharacter === undefined || typeof value.triggerCharacter === 'string'))
  );
}

function isSignatureHelpContext(value: unknown): value is SignatureHelpToolInput['context'] {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.triggerKind === 'number' &&
      (value.triggerCharacter === undefined || typeof value.triggerCharacter === 'string') &&
      (value.isRetrigger === undefined || typeof value.isRetrigger === 'boolean'))
  );
}

function passesOptionalWorkspacePreflight(uriText: string, workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) {
    return true;
  }
  try {
    const uri = new URL(uriText);
    if (uri.protocol !== 'file:') {
      return false;
    }
    resolveFsPath(fileURLToPath(uri), workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

function toolSuccess(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

function toolError(message: string, code: LspToolErrorCode): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }]
  };
}

function redactPayload(value: unknown, secrets: readonly string[], options: { scrubKeys?: boolean } = {}): unknown {
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, secrets, options));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEYS.has(key.toLowerCase()))
        .map(([key, entry]) => [
          options.scrubKeys === true ? redactString(key, secrets) : key,
          redactPayload(entry, secrets, options)
        ])
    );
  }
  return value;
}

function redactString(value: string, secrets: readonly string[]): string {
  return secrets.reduce((next, secret) => (secret ? next.split(secret).join('[redacted]') : next), value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function loadMcpEnvironment(env: DeskLspMcpEnvironment): DeskLspMcpEnvironment | undefined {
  const envFile = typeof env.DESK_LSP_ENV_FILE === 'string' ? env.DESK_LSP_ENV_FILE.trim() : '';
  if (!envFile) {
    return env;
  }
  try {
    const runtimeRoot = realpathSync(join(tmpdir(), 'desk-lsp-managed-agents'));
    const linkStats = lstatSync(envFile);
    if (!linkStats.isFile()) {
      return undefined;
    }
    const realEnvFile = realpathSync(envFile);
    const rel = relative(runtimeRoot, realEnvFile);
    if (rel.startsWith('..') || rel === '' || rel.includes('\0')) {
      return undefined;
    }
    const relParts = rel.split(/[\\/]+/);
    if (relParts.length !== 3 || relParts.some((part) => part === '') || relParts[2] !== 'env.json') {
      return undefined;
    }
    const sessionDir = dirname(realEnvFile);
    const serverDir = dirname(sessionDir);
    const serverStats = statSync(serverDir);
    const sessionStats = statSync(sessionDir);
    if (
      !serverStats.isDirectory() ||
      !sessionStats.isDirectory() ||
      (serverStats.mode & 0o777) !== 0o700 ||
      (sessionStats.mode & 0o777) !== 0o700
    ) {
      return undefined;
    }
    const stats = statSync(realEnvFile);
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(realEnvFile, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const next: DeskLspMcpEnvironment = {};
    for (const key of ['DESK_API', 'DESK_LSP_TOKEN', 'DESK_LSP_WORKSPACE_ROOT'] as const) {
      const value = parsed[key];
      if (typeof value !== 'string' || value.trim() === '') {
        return undefined;
      }
      next[key] = value;
    }
    return next;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
