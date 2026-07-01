import type { HoverService, HoverServiceInput, HoverServiceResponse, LspPosition } from './hoverService.js';
import type { FormattingOptions, FormattingService, FormattingServiceInput, FormattingServiceResponse } from './formattingService.js';
import type {
  DocumentSymbolService,
  DocumentSymbolServiceInput,
  DocumentSymbolServiceResponse
} from './documentSymbolService.js';
import type { FoldingRangeService, FoldingRangeServiceInput, FoldingRangeServiceResponse } from './foldingRangeService.js';
import type { CompletionService, CompletionServiceInput, CompletionServiceResponse } from './completionService.js';
import type { SignatureHelpService, SignatureHelpServiceInput, SignatureHelpServiceResponse } from './signatureHelpService.js';
import type {
  RenameExecutionServiceInput,
  RenameService,
  RenameServiceInput,
  RenameServiceResponse
} from './renameService.js';
import type {
  DocumentHighlightService,
  DocumentHighlightServiceInput,
  DocumentHighlightServiceResponse
} from './documentHighlightService.js';
import type {
  LocationReferencesInput,
  LocationService,
  LocationServiceInput,
  LocationServiceResponse
} from './locationService.js';
import type { DiagnosticsService, DiagnosticsServiceInput, DiagnosticsServiceResponse } from './diagnosticsService.js';
import type { CodeActionService, CodeActionServiceInput, CodeActionServiceResponse } from './codeActionService.js';
import type {
  SelectionRangeService,
  SelectionRangeServiceInput,
  SelectionRangeServiceResponse
} from './selectionRangeService.js';
import { isSelectionRangePositions } from './selectionRangeService.js';
import type {
  SemanticTokensService,
  SemanticTokensServiceInput,
  SemanticTokensServiceResponse
} from './semanticTokensService.js';

export interface LspRequestApiDependencies {
  getSettings(): unknown | Promise<unknown>;
  hoverService: Pick<HoverService, 'hover'>;
  formattingService: Pick<FormattingService, 'formatDocument'>;
  documentSymbolService: Pick<DocumentSymbolService, 'documentSymbols'>;
  foldingRangeService: Pick<FoldingRangeService, 'foldingRanges'>;
  completionService: Pick<CompletionService, 'complete'>;
  signatureHelpService: Pick<SignatureHelpService, 'signatureHelp'>;
  renameService: Pick<RenameService, 'prepareRename' | 'rename'>;
  documentHighlightService: Pick<DocumentHighlightService, 'documentHighlights'>;
  locationService: Pick<LocationService, 'definition' | 'references' | 'typeDefinition' | 'implementation' | 'declaration'>;
  diagnosticsService: Pick<DiagnosticsService, 'diagnostics'>;
  codeActionService: Pick<CodeActionService, 'codeActions'>;
  selectionRangeService: Pick<SelectionRangeService, 'selectionRanges'>;
  semanticTokensService: Pick<SemanticTokensService, 'semanticTokens'>;
}

export interface LspRequestApi {
  handleRequest(body: unknown): Promise<LspRequestApiResponse>;
}

export type LspRequestApiResponse = LspRequestApiSuccessResponse | LspRequestApiErrorResponse;

export interface LspRequestApiSuccessResponse {
  ok: true;
  result:
    | HoverServiceResponse
    | FormattingServiceResponse
    | DocumentSymbolServiceResponse
    | FoldingRangeServiceResponse
    | CompletionServiceResponse
    | SignatureHelpServiceResponse
    | RenameServiceResponse
    | DocumentHighlightServiceResponse
    | LocationServiceResponse
    | DiagnosticsServiceResponse
    | CodeActionServiceResponse
    | SelectionRangeServiceResponse
    | SemanticTokensServiceResponse;
}

export interface LspRequestApiErrorResponse {
  ok: false;
  error: LspRequestApiError;
}

export interface LspRequestApiError {
  code: 'invalid_request' | 'unsupported_method';
  message: string;
}

export function createLspRequestApi({
  getSettings,
  hoverService,
  formattingService,
  documentSymbolService,
  foldingRangeService,
  completionService,
  signatureHelpService,
  renameService,
  documentHighlightService,
  locationService,
  diagnosticsService,
  codeActionService,
  selectionRangeService,
  semanticTokensService
}: LspRequestApiDependencies): LspRequestApi {
  return {
    async handleRequest(body) {
      if (!isObject(body) || typeof body.method !== 'string') {
        return invalidRequest();
      }

      if (body.method === 'textDocument/hover') {
        const hoverInput = toHoverInput(body);
        if (!hoverInput) {
          return invalidRequest('textDocument/hover');
        }

        const settings = await getSettings();
        const result = await hoverService.hover({ ...hoverInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/formatting') {
        const formattingInput = toFormattingInput(body);
        if (!formattingInput) {
          return invalidRequest('textDocument/formatting');
        }

        const settings = await getSettings();
        const result = await formattingService.formatDocument({ ...formattingInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/documentSymbol') {
        const documentSymbolInput = toDocumentSymbolInput(body);
        if (!documentSymbolInput) {
          return invalidRequest('textDocument/documentSymbol');
        }

        const settings = await getSettings();
        const result = await documentSymbolService.documentSymbols({ ...documentSymbolInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/foldingRange') {
        const foldingRangeInput = toFoldingRangeInput(body);
        if (!foldingRangeInput) {
          return invalidRequest('textDocument/foldingRange');
        }

        const settings = await getSettings();
        const result = await foldingRangeService.foldingRanges({ ...foldingRangeInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/completion') {
        const completionInput = toCompletionInput(body);
        if (!completionInput) {
          return invalidRequest('textDocument/completion');
        }

        const settings = await getSettings();
        const result = await completionService.complete({ ...completionInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/selectionRange') {
        const selectionRangeInput = toSelectionRangeInput(body);
        if (!selectionRangeInput) {
          return invalidRequest('textDocument/selectionRange');
        }

        const settings = await getSettings();
        const result = await selectionRangeService.selectionRanges({ ...selectionRangeInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/semanticTokens/full') {
        const semanticTokensInput = toSemanticTokensInput(body);
        if (!semanticTokensInput) {
          return invalidRequest('textDocument/semanticTokens/full');
        }

        const settings = await getSettings();
        const result = await semanticTokensService.semanticTokens({ ...semanticTokensInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/signatureHelp') {
        const signatureHelpInput = toSignatureHelpInput(body);
        if (!signatureHelpInput) {
          return invalidRequest('textDocument/signatureHelp');
        }

        const settings = await getSettings();
        const result = await signatureHelpService.signatureHelp({ ...signatureHelpInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/prepareRename') {
        const prepareRenameInput = toPrepareRenameInput(body);
        if (!prepareRenameInput) {
          return invalidRequest('textDocument/prepareRename');
        }

        const settings = await getSettings();
        const result = await renameService.prepareRename({ ...prepareRenameInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/rename') {
        const renameInput = toRenameInput(body);
        if (!renameInput) {
          return invalidRequest('textDocument/rename');
        }

        const settings = await getSettings();
        const result = await renameService.rename({ ...renameInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/documentHighlight') {
        const documentHighlightInput = toDocumentHighlightInput(body);
        if (!documentHighlightInput) {
          return invalidRequest('textDocument/documentHighlight');
        }

        const settings = await getSettings();
        const result = await documentHighlightService.documentHighlights({ ...documentHighlightInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/definition') {
        const locationInput = toLocationInput(body);
        if (!locationInput) {
          return invalidRequest('textDocument/definition');
        }

        const settings = await getSettings();
        const result = await locationService.definition({ ...locationInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/references') {
        const referencesInput = toReferencesInput(body);
        if (!referencesInput) {
          return invalidRequest('textDocument/references');
        }

        const settings = await getSettings();
        const result = await locationService.references({ ...referencesInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/typeDefinition') {
        const locationInput = toLocationInput(body);
        if (!locationInput) {
          return invalidRequest('textDocument/typeDefinition');
        }

        const settings = await getSettings();
        const result = await locationService.typeDefinition({ ...locationInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/implementation') {
        const locationInput = toLocationInput(body);
        if (!locationInput) {
          return invalidRequest('textDocument/implementation');
        }

        const settings = await getSettings();
        const result = await locationService.implementation({ ...locationInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/declaration') {
        const locationInput = toLocationInput(body);
        if (!locationInput) {
          return invalidRequest('textDocument/declaration');
        }

        const settings = await getSettings();
        const result = await locationService.declaration({ ...locationInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'textDocument/codeAction') {
        const codeActionInput = toCodeActionInput(body);
        if (!codeActionInput) {
          return invalidRequest('textDocument/codeAction');
        }

        const settings = await getSettings();
        const result = await codeActionService.codeActions({ ...codeActionInput, settings });
        return { ok: true, result };
      }

      if (body.method === 'desk/lspDiagnostics') {
        const diagnosticsInput = toDiagnosticsInput(body);
        if (!diagnosticsInput) {
          return invalidRequest('desk/lspDiagnostics');
        }

        const settings = diagnosticsInput.refresh === true ? await getSettings() : undefined;
        const result = await diagnosticsService.diagnostics(
          settings === undefined ? diagnosticsInput : { ...diagnosticsInput, settings }
        );
        return { ok: true, result };
      }

      return {
        ok: false,
        error: { code: 'unsupported_method', message: `Unsupported LSP request method: ${body.method}` }
      };
    }
  };
}

function toDiagnosticsInput(body: Record<string, unknown>): DiagnosticsServiceInput | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    ...(params.refresh === true ? { refresh: true } : {})
  };
}

function toReferencesInput(body: Record<string, unknown>): Omit<LocationReferencesInput, 'settings'> | undefined {
  const locationInput = toLocationInput(body);
  if (!locationInput || !isObject(body.params)) {
    return undefined;
  }

  const context = body.params.context;
  if (context !== undefined && !isObject(context)) {
    return undefined;
  }
  const includeDeclaration = isObject(context) ? context.includeDeclaration : undefined;
  if (includeDeclaration !== undefined && typeof includeDeclaration !== 'boolean') {
    return undefined;
  }

  return {
    ...locationInput,
    includeDeclaration: includeDeclaration ?? false
  };
}

function toLocationInput(body: Record<string, unknown>): Omit<LocationServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string' || !isPosition(params.position)) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position
  };
}

function toCodeActionInput(body: Record<string, unknown>): Omit<CodeActionServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string' || !isRange(params.range)) {
    return undefined;
  }

  const context = params.context;
  if (!isObject(context) || !Array.isArray(context.diagnostics)) {
    return undefined;
  }
  if (context.only !== undefined && !(Array.isArray(context.only) && context.only.every((entry) => typeof entry === 'string'))) {
    return undefined;
  }
  if (context.triggerKind !== undefined && typeof context.triggerKind !== 'number') {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    range: params.range,
    context: {
      diagnostics: context.diagnostics,
      ...(context.only !== undefined ? { only: context.only as string[] } : {}),
      ...(context.triggerKind !== undefined ? { triggerKind: context.triggerKind as number } : {})
    }
  };
}

function isRange(value: unknown): value is { start: LspPosition; end: LspPosition } {
  return isObject(value) && isPosition(value.start) && isPosition(value.end);
}

function toRenameInput(body: Record<string, unknown>): Omit<RenameExecutionServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (
    !isObject(params.textDocument) ||
    typeof params.textDocument.uri !== 'string' ||
    !isPosition(params.position) ||
    typeof params.newName !== 'string'
  ) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position,
    newName: params.newName
  };
}

function toDocumentHighlightInput(
  body: Record<string, unknown>
): Omit<DocumentHighlightServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string' || !isPosition(params.position)) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position
  };
}

function toPrepareRenameInput(body: Record<string, unknown>): Omit<RenameServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string' || !isPosition(params.position)) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position
  };
}

function toSignatureHelpInput(body: Record<string, unknown>): Omit<SignatureHelpServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (
    !isObject(params.textDocument) ||
    typeof params.textDocument.uri !== 'string' ||
    !isPosition(params.position) ||
    !isSignatureHelpContext(params.context)
  ) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position,
    context: params.context
  };
}

function toCompletionInput(body: Record<string, unknown>): Omit<CompletionServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (
    !isObject(params.textDocument) ||
    typeof params.textDocument.uri !== 'string' ||
    !isPosition(params.position) ||
    !isCompletionContext(params.context)
  ) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position,
    context: params.context
  };
}

function toDocumentSymbolInput(body: Record<string, unknown>): Omit<DocumentSymbolServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot
  };
}

function toFoldingRangeInput(body: Record<string, unknown>): Omit<FoldingRangeServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot
  };
}

function toSelectionRangeInput(body: Record<string, unknown>): Omit<SelectionRangeServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (
    !isObject(params.textDocument) ||
    typeof params.textDocument.uri !== 'string' ||
    !isSelectionRangePositions(params.positions)
  ) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    positions: params.positions
  };
}

function toSemanticTokensInput(body: Record<string, unknown>): Omit<SemanticTokensServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string') {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot
  };
}

function toFormattingInput(body: Record<string, unknown>): Omit<FormattingServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string' || !isFormattingOptions(params.options)) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    options: params.options
  };
}

function isFormattingOptions(value: unknown): value is FormattingOptions {
  return isObject(value) && typeof value.tabSize === 'number' && typeof value.insertSpaces === 'boolean';
}

function toHoverInput(body: Record<string, unknown>): Omit<HoverServiceInput, 'settings'> | undefined {
  if (typeof body.workspaceRoot !== 'string' || !isObject(body.params)) {
    return undefined;
  }

  const params = body.params;
  if (!isObject(params.textDocument) || typeof params.textDocument.uri !== 'string' || !isPosition(params.position)) {
    return undefined;
  }

  return {
    uri: params.textDocument.uri,
    languageId: typeof body.languageId === 'string' ? body.languageId : undefined,
    workspaceRoot: body.workspaceRoot,
    position: params.position
  };
}

function isPosition(value: unknown): value is LspPosition {
  return isObject(value) && typeof value.line === 'number' && typeof value.character === 'number';
}

function isCompletionContext(value: unknown): value is CompletionServiceInput['context'] {
  return (
    value === undefined ||
    (isObject(value) &&
      typeof value.triggerKind === 'number' &&
      (value.triggerCharacter === undefined || typeof value.triggerCharacter === 'string'))
  );
}

function isSignatureHelpContext(value: unknown): value is SignatureHelpServiceInput['context'] {
  return (
    value === undefined ||
    (isObject(value) &&
      typeof value.triggerKind === 'number' &&
      (value.triggerCharacter === undefined || typeof value.triggerCharacter === 'string') &&
      (value.isRetrigger === undefined || typeof value.isRetrigger === 'boolean'))
  );
}

function invalidRequest(method = 'textDocument/hover'): LspRequestApiErrorResponse {
  return {
    ok: false,
    error: { code: 'invalid_request', message: `Invalid ${method} request body` }
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
