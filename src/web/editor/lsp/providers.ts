/**
 * LSP feature providers (connection + conversion bridges).
 *
 * Each factory returns a small bridge that issues an LSP request over the connection and
 * converts the result into Monaco's expected shape. This is the connection-side half; the
 * Monaco-registration adapter (monaco.languages.register*, model->uri, monaco.Position->LSP
 * position, CancellationToken->AbortSignal) is a later step. Decoupling via a minimal
 * connection interface keeps these bridges unit-testable and reusable by the agent MCP path.
 */

import { toMonacoCompletionList, type LspCompletionResult, type MonacoCompletionListDraft } from './completionConverter.js';
import {
  toMonacoCodeActions,
  toMonacoCodeLenses,
  toMonacoColorInformation,
  toMonacoColorPresentations,
  toMonacoDocumentHighlights,
  toMonacoDocumentLinks,
  toMonacoDocumentSymbols,
  toMonacoFoldingRanges,
  toMonacoHover,
  toMonacoInlayHints,
  toMonacoLinkedEditingRanges,
  toMonacoLocations,
  toMonacoRenamePrepare,
  toMonacoSelectionRanges,
  toMonacoSemanticTokens,
  toMonacoSemanticTokensEdits,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
  toMonacoWorkspaceEdit,
  type LspCodeAction,
  type LspCodeLens,
  type LspColor,
  type LspColorInformation,
  type LspColorPresentation,
  type LspCommand,
  type LspDocumentHighlight,
  type LspDocumentLink,
  type LspDocumentSymbol,
  type LspFoldingRange,
  type LspHover,
  type LspInlayHint,
  type LspLinkedEditingRanges,
  type LspLocation,
  type LspLocationLink,
  type LspPosition,
  type LspPrepareRenameResult,
  type LspRange,
  type LspSelectionRange,
  type LspSemanticTokens,
  type LspSemanticTokensDelta,
  type LspSignatureHelp,
  type LspSymbolInformation,
  type LspTextEdit,
  type LspWorkspaceEdit,
  type MonacoCodeActionList,
  type MonacoCodeLensList,
  type MonacoColorInformation,
  type MonacoColorPresentation,
  type MonacoDocumentHighlight,
  type MonacoDocumentLinkList,
  type MonacoDocumentSymbol,
  type MonacoFoldingRangeDraft,
  type MonacoHover,
  type MonacoInlayHintListDraft,
  type MonacoLinkedEditingRangesDraft,
  type MonacoLocation,
  type MonacoRenamePrepare,
  type MonacoSelectionRange,
  type MonacoSemanticTokens,
  type MonacoSemanticTokensEdits,
  type MonacoSignatureHelp,
  type MonacoTextEdit,
  type MonacoWorkspaceEdit
} from './resultConverters.js';

/** Minimal connection surface a provider bridge needs. */
export interface ProviderConnection {
  request(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Document position target for a provider request (LSP 0-based position). */
export interface ProviderTarget {
  uri: string;
  position: LspPosition;
}

export interface HoverProvider {
  provideHover(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoHover | null>;
}

/** Bridge textDocument/hover to a Monaco hover; resolves null when the server returns nothing. */
export function createHoverProvider(connection: ProviderConnection): HoverProvider {
  return {
    async provideHover(target, signal) {
      const result = await connection.request(
        'textDocument/hover',
        { textDocument: { uri: target.uri }, position: target.position },
        { signal }
      );
      if (result === null || result === undefined) {
        return null;
      }
      return toMonacoHover(result as LspHover);
    }
  };
}

type LspLocationResult = LspLocation | LspLocation[] | LspLocationLink[] | null | undefined;

export interface DefinitionProvider {
  provideDefinition(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoLocation[]>;
}

/** Bridge textDocument/definition to Monaco locations (empty array when the server returns nothing). */
export function createDefinitionProvider(connection: ProviderConnection): DefinitionProvider {
  return {
    async provideDefinition(target, signal) {
      const result = await connection.request(
        'textDocument/definition',
        { textDocument: { uri: target.uri }, position: target.position },
        { signal }
      );
      return toMonacoLocations(result as LspLocationResult);
    }
  };
}

/** Shared request+convert for the location-based navigation features that take no extra params. */
async function requestLocations(
  connection: ProviderConnection,
  method: string,
  target: ProviderTarget,
  signal?: AbortSignal
): Promise<MonacoLocation[]> {
  const result = await connection.request(
    method,
    { textDocument: { uri: target.uri }, position: target.position },
    { signal }
  );
  return toMonacoLocations(result as LspLocationResult);
}

export interface TypeDefinitionProvider {
  provideTypeDefinition(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoLocation[]>;
}
/** Bridge textDocument/typeDefinition to Monaco locations. */
export function createTypeDefinitionProvider(connection: ProviderConnection): TypeDefinitionProvider {
  return {
    provideTypeDefinition: (target, signal) => requestLocations(connection, 'textDocument/typeDefinition', target, signal)
  };
}

export interface ImplementationProvider {
  provideImplementation(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoLocation[]>;
}
/** Bridge textDocument/implementation to Monaco locations. */
export function createImplementationProvider(connection: ProviderConnection): ImplementationProvider {
  return {
    provideImplementation: (target, signal) => requestLocations(connection, 'textDocument/implementation', target, signal)
  };
}

export interface DeclarationProvider {
  provideDeclaration(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoLocation[]>;
}
/** Bridge textDocument/declaration to Monaco locations. */
export function createDeclarationProvider(connection: ProviderConnection): DeclarationProvider {
  return {
    provideDeclaration: (target, signal) => requestLocations(connection, 'textDocument/declaration', target, signal)
  };
}

export interface ReferenceContext {
  includeDeclaration: boolean;
}
export interface ReferencesProvider {
  provideReferences(target: ProviderTarget, context: ReferenceContext, signal?: AbortSignal): Promise<MonacoLocation[]>;
}

/** Bridge textDocument/references to Monaco locations, carrying the includeDeclaration context. */
export function createReferencesProvider(connection: ProviderConnection): ReferencesProvider {
  return {
    async provideReferences(target, context, signal) {
      const result = await connection.request(
        'textDocument/references',
        {
          textDocument: { uri: target.uri },
          position: target.position,
          context: { includeDeclaration: context.includeDeclaration }
        },
        { signal }
      );
      return toMonacoLocations(result as LspLocationResult);
    }
  };
}

/** LSP FormattingOptions (extra implementation-specific keys are allowed). */
export interface FormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
  [key: string]: unknown;
}
export interface DocumentFormattingTarget {
  uri: string;
  options: FormattingOptions;
}
export interface DocumentFormattingProvider {
  provideDocumentFormatting(target: DocumentFormattingTarget, signal?: AbortSignal): Promise<MonacoTextEdit[]>;
}

/** Bridge textDocument/formatting to Monaco edit operations (empty when the server returns nothing). */
export function createDocumentFormattingProvider(connection: ProviderConnection): DocumentFormattingProvider {
  return {
    async provideDocumentFormatting(target, signal) {
      const result = await connection.request(
        'textDocument/formatting',
        { textDocument: { uri: target.uri }, options: target.options },
        { signal }
      );
      return toMonacoTextEdits(result as LspTextEdit[] | null | undefined);
    }
  };
}

export interface DocumentSymbolTarget {
  uri: string;
}
export interface DocumentSymbolProvider {
  provideDocumentSymbols(target: DocumentSymbolTarget, signal?: AbortSignal): Promise<MonacoDocumentSymbol[]>;
}

/** Bridge textDocument/documentSymbol to Monaco document symbols (whole-document; null -> []). */
export function createDocumentSymbolProvider(connection: ProviderConnection): DocumentSymbolProvider {
  return {
    async provideDocumentSymbols(target, signal) {
      const result = await connection.request(
        'textDocument/documentSymbol',
        { textDocument: { uri: target.uri } },
        { signal }
      );
      return toMonacoDocumentSymbols(result as Array<LspDocumentSymbol | LspSymbolInformation> | null | undefined);
    }
  };
}

/** LSP CompletionContext: how completion was triggered. */
export interface CompletionContext {
  triggerKind: number;
  triggerCharacter?: string;
}
export interface CompletionProvider {
  provideCompletions(
    target: ProviderTarget,
    context?: CompletionContext,
    signal?: AbortSignal
  ): Promise<MonacoCompletionListDraft>;
}

/**
 * Bridge textDocument/completion to a range-less Monaco completion list draft. The register
 * adapter injects each suggestion's range (model word-range/textEdit) later. null -> empty draft.
 */
export function createCompletionProvider(connection: ProviderConnection): CompletionProvider {
  return {
    async provideCompletions(target, context, signal) {
      const params: Record<string, unknown> = {
        textDocument: { uri: target.uri },
        position: target.position
      };
      if (context !== undefined) {
        params.context = context;
      }
      const result = await connection.request('textDocument/completion', params, { signal });
      return toMonacoCompletionList(result as LspCompletionResult);
    }
  };
}

/** LSP SignatureHelpContext; activeSignatureHelp carries the prior help on retrigger. */
export interface SignatureHelpContext {
  triggerKind: number;
  triggerCharacter?: string;
  isRetrigger?: boolean;
  activeSignatureHelp?: unknown;
}
export interface SignatureHelpProvider {
  provideSignatureHelp(
    target: ProviderTarget,
    context?: SignatureHelpContext,
    signal?: AbortSignal
  ): Promise<MonacoSignatureHelp | null>;
}

/** Bridge textDocument/signatureHelp to Monaco signature help; passes the full context through; null -> null. */
export function createSignatureHelpProvider(connection: ProviderConnection): SignatureHelpProvider {
  return {
    async provideSignatureHelp(target, context, signal) {
      const params: Record<string, unknown> = {
        textDocument: { uri: target.uri },
        position: target.position
      };
      if (context !== undefined) {
        params.context = context;
      }
      const result = await connection.request('textDocument/signatureHelp', params, { signal });
      return toMonacoSignatureHelp(result as LspSignatureHelp | null | undefined);
    }
  };
}

export interface DocumentHighlightProvider {
  provideDocumentHighlights(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoDocumentHighlight[]>;
}

/** Bridge textDocument/documentHighlight to Monaco highlights (null -> []). */
export function createDocumentHighlightProvider(connection: ProviderConnection): DocumentHighlightProvider {
  return {
    async provideDocumentHighlights(target, signal) {
      const result = await connection.request(
        'textDocument/documentHighlight',
        { textDocument: { uri: target.uri }, position: target.position },
        { signal }
      );
      return toMonacoDocumentHighlights(result as LspDocumentHighlight[] | null | undefined);
    }
  };
}

export interface RenameTarget {
  uri: string;
  position: LspPosition;
  newName: string;
}
export interface RenameProvider {
  provideRenameEdits(target: RenameTarget, signal?: AbortSignal): Promise<MonacoWorkspaceEdit>;
}

/** Bridge textDocument/rename to a Monaco workspace edit (null -> { edits: [] }). */
export function createRenameProvider(connection: ProviderConnection): RenameProvider {
  return {
    async provideRenameEdits(target, signal) {
      const result = await connection.request(
        'textDocument/rename',
        { textDocument: { uri: target.uri }, position: target.position, newName: target.newName },
        { signal }
      );
      return toMonacoWorkspaceEdit(result as LspWorkspaceEdit | null | undefined);
    }
  };
}

export interface PrepareRenameProvider {
  providePrepareRename(target: ProviderTarget, signal?: AbortSignal): Promise<MonacoRenamePrepare | null>;
}

/** Bridge textDocument/prepareRename to a draft rename location (null -> null; register adapter supplies text). */
export function createPrepareRenameProvider(connection: ProviderConnection): PrepareRenameProvider {
  return {
    async providePrepareRename(target, signal) {
      const result = await connection.request(
        'textDocument/prepareRename',
        { textDocument: { uri: target.uri }, position: target.position },
        { signal }
      );
      return toMonacoRenamePrepare(result as LspPrepareRenameResult);
    }
  };
}

/** LSP CodeActionContext: in-scope diagnostics, optional kind filter, and optional trigger kind. */
export interface CodeActionContext {
  diagnostics: unknown[];
  only?: string[];
  triggerKind?: number;
}
export interface CodeActionTarget {
  uri: string;
  range: LspRange;
  context: CodeActionContext;
}
export interface CodeActionProvider {
  provideCodeActions(target: CodeActionTarget, signal?: AbortSignal): Promise<MonacoCodeActionList>;
}

/** Bridge textDocument/codeAction (range + full context passthrough) to Monaco code actions (null -> { actions: [] }). */
export function createCodeActionProvider(connection: ProviderConnection): CodeActionProvider {
  return {
    async provideCodeActions(target, signal) {
      const result = await connection.request(
        'textDocument/codeAction',
        { textDocument: { uri: target.uri }, range: target.range, context: target.context },
        { signal }
      );
      return toMonacoCodeActions(result as Array<LspCommand | LspCodeAction> | null | undefined);
    }
  };
}

export interface FoldingRangeTarget {
  uri: string;
}
export interface FoldingRangeProvider {
  provideFoldingRanges(target: FoldingRangeTarget, signal?: AbortSignal): Promise<MonacoFoldingRangeDraft[]>;
}

/** Bridge textDocument/foldingRange to draft folding ranges (whole-document; null -> []). */
export function createFoldingRangeProvider(connection: ProviderConnection): FoldingRangeProvider {
  return {
    async provideFoldingRanges(target, signal) {
      const result = await connection.request(
        'textDocument/foldingRange',
        { textDocument: { uri: target.uri } },
        { signal }
      );
      return toMonacoFoldingRanges(result as LspFoldingRange[] | null | undefined);
    }
  };
}

export interface DocumentLinkTarget {
  uri: string;
}
export interface DocumentLinkProvider {
  provideDocumentLinks(target: DocumentLinkTarget, signal?: AbortSignal): Promise<MonacoDocumentLinkList>;
}

/** Bridge textDocument/documentLink to a Monaco link list (whole-document; null -> { links: [] }). */
export function createDocumentLinkProvider(connection: ProviderConnection): DocumentLinkProvider {
  return {
    async provideDocumentLinks(target, signal) {
      const result = await connection.request(
        'textDocument/documentLink',
        { textDocument: { uri: target.uri } },
        { signal }
      );
      return toMonacoDocumentLinks(result as LspDocumentLink[] | null | undefined);
    }
  };
}

export interface CodeLensTarget {
  uri: string;
}
export interface CodeLensProvider {
  provideCodeLenses(target: CodeLensTarget, signal?: AbortSignal): Promise<MonacoCodeLensList>;
}

/** Bridge textDocument/codeLens to a Monaco code lens list (whole-document; null -> { lenses: [] }). */
export function createCodeLensProvider(connection: ProviderConnection): CodeLensProvider {
  return {
    async provideCodeLenses(target, signal) {
      const result = await connection.request(
        'textDocument/codeLens',
        { textDocument: { uri: target.uri } },
        { signal }
      );
      return toMonacoCodeLenses(result as LspCodeLens[] | null | undefined);
    }
  };
}

export interface ColorTarget {
  uri: string;
}
export interface ColorPresentationTarget {
  uri: string;
  color: LspColor;
  range: LspRange;
}
export interface ColorProvider {
  provideDocumentColors(target: ColorTarget, signal?: AbortSignal): Promise<MonacoColorInformation[]>;
  provideColorPresentations(target: ColorPresentationTarget, signal?: AbortSignal): Promise<MonacoColorPresentation[]>;
}

/** Bridge the two document-color methods (documentColor + colorPresentation); null -> []. */
export function createColorProvider(connection: ProviderConnection): ColorProvider {
  return {
    async provideDocumentColors(target, signal) {
      const result = await connection.request(
        'textDocument/documentColor',
        { textDocument: { uri: target.uri } },
        { signal }
      );
      return toMonacoColorInformation(result as LspColorInformation[] | null | undefined);
    },
    async provideColorPresentations(target, signal) {
      const result = await connection.request(
        'textDocument/colorPresentation',
        { textDocument: { uri: target.uri }, color: target.color, range: target.range },
        { signal }
      );
      return toMonacoColorPresentations(result as LspColorPresentation[] | null | undefined);
    }
  };
}

export interface SelectionRangeTarget {
  uri: string;
  positions: LspPosition[];
}
export interface SelectionRangeProvider {
  provideSelectionRanges(target: SelectionRangeTarget, signal?: AbortSignal): Promise<MonacoSelectionRange[][]>;
}

/** Bridge textDocument/selectionRange (multi-position) to per-position Monaco chains; null -> []. */
export function createSelectionRangeProvider(connection: ProviderConnection): SelectionRangeProvider {
  return {
    async provideSelectionRanges(target, signal) {
      const result = await connection.request(
        'textDocument/selectionRange',
        { textDocument: { uri: target.uri }, positions: target.positions },
        { signal }
      );
      return toMonacoSelectionRanges(result as LspSelectionRange[] | null | undefined);
    }
  };
}

export interface InlayHintTarget {
  uri: string;
  range: LspRange;
}
export interface InlayHintProvider {
  provideInlayHints(target: InlayHintTarget, signal?: AbortSignal): Promise<MonacoInlayHintListDraft>;
}

/** Bridge textDocument/inlayHint (range-based) to a draft hint list; null -> { hints: [] }. */
export function createInlayHintProvider(connection: ProviderConnection): InlayHintProvider {
  return {
    async provideInlayHints(target, signal) {
      const result = await connection.request(
        'textDocument/inlayHint',
        { textDocument: { uri: target.uri }, range: target.range },
        { signal }
      );
      return toMonacoInlayHints(result as LspInlayHint[] | null | undefined);
    }
  };
}

export interface DocumentRangeFormattingTarget {
  uri: string;
  range: LspRange;
  options: FormattingOptions;
}
export interface DocumentRangeFormattingProvider {
  provideDocumentRangeFormatting(
    target: DocumentRangeFormattingTarget,
    signal?: AbortSignal
  ): Promise<MonacoTextEdit[]>;
}

/** Bridge textDocument/rangeFormatting to Monaco edit operations (empty when the server returns nothing). */
export function createDocumentRangeFormattingProvider(connection: ProviderConnection): DocumentRangeFormattingProvider {
  return {
    async provideDocumentRangeFormatting(target, signal) {
      const result = await connection.request(
        'textDocument/rangeFormatting',
        { textDocument: { uri: target.uri }, range: target.range, options: target.options },
        { signal }
      );
      return toMonacoTextEdits(result as LspTextEdit[] | null | undefined);
    }
  };
}

export interface OnTypeFormattingTarget {
  uri: string;
  position: LspPosition;
  ch: string;
  options: FormattingOptions;
}
export interface OnTypeFormattingProvider {
  provideOnTypeFormatting(target: OnTypeFormattingTarget, signal?: AbortSignal): Promise<MonacoTextEdit[]>;
}

/**
 * Bridge textDocument/onTypeFormatting to Monaco edit operations (empty when the server returns nothing).
 * Trigger-character registration (autoFormatTriggerCharacters/moreTriggerCharacter) is left to the
 * future register adapter; this bridge only issues the request for an already-typed character.
 */
export function createDocumentOnTypeFormattingProvider(connection: ProviderConnection): OnTypeFormattingProvider {
  return {
    async provideOnTypeFormatting(target, signal) {
      const result = await connection.request(
        'textDocument/onTypeFormatting',
        { textDocument: { uri: target.uri }, position: target.position, ch: target.ch, options: target.options },
        { signal }
      );
      return toMonacoTextEdits(result as LspTextEdit[] | null | undefined);
    }
  };
}

export interface LinkedEditingRangeTarget {
  uri: string;
  position: LspPosition;
}
export interface LinkedEditingRangeProvider {
  provideLinkedEditingRanges(
    target: LinkedEditingRangeTarget,
    signal?: AbortSignal
  ): Promise<MonacoLinkedEditingRangesDraft | undefined>;
}

/**
 * Bridge textDocument/linkedEditingRange to a Monaco linked-editing draft (null -> undefined).
 * The draft's wordPattern stays a raw string; the future register adapter compiles the RegExp
 * and wires the trigger-on-cursor behaviour.
 */
export function createLinkedEditingRangeProvider(connection: ProviderConnection): LinkedEditingRangeProvider {
  return {
    async provideLinkedEditingRanges(target, signal) {
      const result = await connection.request(
        'textDocument/linkedEditingRange',
        { textDocument: { uri: target.uri }, position: target.position },
        { signal }
      );
      return toMonacoLinkedEditingRanges(result as LspLinkedEditingRanges | null | undefined);
    }
  };
}

export interface SemanticTokensTarget {
  uri: string;
}
export interface DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(
    target: SemanticTokensTarget,
    signal?: AbortSignal
  ): Promise<MonacoSemanticTokens | null>;
  /**
   * Bridge textDocument/semanticTokens/full/delta. The server may answer with a delta
   * (SemanticTokensDelta -> Monaco SemanticTokensEdits) OR a full SemanticTokens (-> Monaco
   * SemanticTokens); null -> null. Discriminated by the presence of an `edits` array.
   */
  provideDocumentSemanticTokensDelta(
    target: SemanticTokensTarget,
    previousResultId: string,
    signal?: AbortSignal
  ): Promise<MonacoSemanticTokens | MonacoSemanticTokensEdits | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'number');
}
/** Valid LSP SemanticTokensDelta.edits: each entry is { start:number, deleteCount:number, data?:number[] }. */
function isValidSemanticTokensEdits(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (edit) =>
        isRecord(edit) &&
        typeof edit.start === 'number' &&
        typeof edit.deleteCount === 'number' &&
        (edit.data === undefined || isNumberArray(edit.data))
    )
  );
}

/**
 * Bridge textDocument/semanticTokens/full (+ /full/delta) to Monaco semantic tokens (null -> null).
 * The legend (getLegend), releaseDocumentSemanticTokens, model/lastResultId adaptation, the
 * uri->resultId cache, and range tokens stay register-adapter work.
 */
export function createDocumentSemanticTokensProvider(connection: ProviderConnection): DocumentSemanticTokensProvider {
  return {
    async provideDocumentSemanticTokens(target, signal) {
      const result = await connection.request(
        'textDocument/semanticTokens/full',
        { textDocument: { uri: target.uri } },
        { signal }
      );
      return toMonacoSemanticTokens(result as LspSemanticTokens | null | undefined);
    },
    async provideDocumentSemanticTokensDelta(target, previousResultId, signal) {
      const result = await connection.request(
        'textDocument/semanticTokens/full/delta',
        { textDocument: { uri: target.uri }, previousResultId },
        { signal }
      );
      if (result === null || result === undefined) {
        return null;
      }
      // The delta endpoint may answer with a delta (edits) or a full token set (data). Validate the
      // shape strictly: a malformed response (e.g. {} or { edits: 'bad' } or a bad edit entry) must
      // THROW so the adapter clears the cache and retries one full request -- never be silently
      // accepted as an empty/full token set.
      if (!isRecord(result)) {
        throw new Error('malformed semantic tokens delta response');
      }
      if (result.edits !== undefined) {
        if (!isValidSemanticTokensEdits(result.edits)) {
          throw new Error('malformed semantic tokens delta edits');
        }
        return toMonacoSemanticTokensEdits(result as unknown as LspSemanticTokensDelta);
      }
      if (!isNumberArray(result.data)) {
        throw new Error('malformed semantic tokens delta response');
      }
      return toMonacoSemanticTokens(result as unknown as LspSemanticTokens);
    }
  };
}

export interface SemanticTokensRangeTarget {
  uri: string;
  range: LspRange;
}
export interface DocumentRangeSemanticTokensProvider {
  provideDocumentRangeSemanticTokens(
    target: SemanticTokensRangeTarget,
    signal?: AbortSignal
  ): Promise<MonacoSemanticTokens | null>;
}

/**
 * Bridge textDocument/semanticTokens/range to Monaco semantic tokens (null -> null).
 * Range variant; the legend (getLegend), range/full edits, and model adaptation stay
 * register-adapter or separate-bridge work.
 */
export function createDocumentRangeSemanticTokensProvider(
  connection: ProviderConnection
): DocumentRangeSemanticTokensProvider {
  return {
    async provideDocumentRangeSemanticTokens(target, signal) {
      const result = await connection.request(
        'textDocument/semanticTokens/range',
        { textDocument: { uri: target.uri }, range: target.range },
        { signal }
      );
      return toMonacoSemanticTokens(result as LspSemanticTokens | null | undefined);
    }
  };
}
