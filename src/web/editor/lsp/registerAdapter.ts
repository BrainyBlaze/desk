/**
 * Monaco registration adapter (orchestration).
 *
 * registerLspProviders wires the connection-side provider bridges into Monaco's languages registry,
 * gating each registration on the server's advertised capabilities and returning a composite
 * Disposable. This slice covers hover plus the position-to-locations providers (definition,
 * typeDefinition, implementation, declaration); remaining providers, draft compilation, and the
 * semantic-token legend/lastResultId are later slices.
 *
 * Inputs are minimal structural shapes (MonacoLanguagesLike/MonacoModelLike/MonacoUriLike), so the
 * orchestration is unit-testable without the monaco runtime; the real-Monaco render proof is a
 * separate browser slice.
 *
 * URI boundary: request params use model.uri.toString() (Monaco Uri object -> string). Location
 * results come back from the converters with string uris, so they are mapped back to Monaco Uri
 * objects through the injected createUri factory (real wiring passes monaco.Uri.parse).
 */

import {
  cancellationTokenToAbortSignal,
  monacoPositionToLsp,
  monacoRangeToLsp,
  type CancellationTokenLike,
  type MonacoPositionLike,
  type MonacoRangeLike
} from './adapterConversions.js';
import type { MonacoCompletionItemDraft } from './completionConverter.js';
import { toLspDiagnostics, type MonacoMarkerInput } from './diagnosticsAdapter.js';
import type { ServerCapabilities } from './connection.js';
import { createImmediateProviderScheduler, ProviderSupersededError, type ProviderScheduler } from './providerScheduler.js';
import {
  createCodeLensProvider,
  createCodeActionProvider,
  createColorProvider,
  createCompletionProvider,
  createDeclarationProvider,
  createDocumentRangeSemanticTokensProvider,
  createDocumentSemanticTokensProvider,
  createDefinitionProvider,
  createDocumentFormattingProvider,
  createFoldingRangeProvider,
  createDocumentLinkProvider,
  createDocumentOnTypeFormattingProvider,
  createDocumentRangeFormattingProvider,
  createDocumentHighlightProvider,
  createDocumentSymbolProvider,
  createHoverProvider,
  createImplementationProvider,
  createInlayHintProvider,
  createLinkedEditingRangeProvider,
  createPrepareRenameProvider,
  createReferencesProvider,
  createRenameProvider,
  createSelectionRangeProvider,
  createSignatureHelpProvider,
  createTypeDefinitionProvider,
  type CodeActionContext,
  type CompletionContext,
  type FormattingOptions,
  type ProviderConnection,
  type ProviderTarget,
  type SignatureHelpContext
} from './providers.js';
import type {
  LspColor,
  MonacoCodeAction,
  MonacoCodeLensList,
  MonacoCommand,
  MonacoColorInformation,
  MonacoColorPresentation,
  MonacoDocumentLinkList,
  MonacoDocumentHighlight,
  MonacoDocumentSymbol,
  MonacoHover,
  MonacoInlayHint,
  MonacoLinkedEditingRangesDraft,
  MonacoLocation,
  MonacoRange,
  MonacoRenamePrepare,
  MonacoSelectionRange,
  MonacoSemanticTokens,
  MonacoSemanticTokensEdits,
  MonacoSignatureHelp,
  MonacoTextEdit,
  MonacoWorkspaceEdit
} from './resultConverters.js';

/** Minimal shape of a Monaco Uri (it is an object with toString(), not a plain string). */
export interface MonacoUriLike {
  toString(): string;
}
/**
 * Minimal shape of a Monaco text model. getWordUntilPosition is used only by the completion path;
 * getValueInRange is used only by the rename-prepare path.
 */
export interface MonacoModelLike {
  uri: MonacoUriLike;
  getWordUntilPosition(position: MonacoPositionLike): { startColumn: number; endColumn: number };
  getValueInRange(range: MonacoRange): string;
}
/** A Monaco location result: like MonacoLocation but with a Uri object instead of a string. */
export interface MonacoLocationOut<TUri = MonacoUriLike> {
  uri: TUri;
  range: MonacoLocation['range'];
}

/** Minimal shape of a Monaco hover provider. */
export interface MonacoHoverProviderLike {
  provideHover(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoHover | null>;
}
/** Minimal shapes of the Monaco location-style providers. */
export interface MonacoDefinitionProviderLike<TUri = MonacoUriLike> {
  provideDefinition(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoLocationOut<TUri>[]>;
}
export interface MonacoTypeDefinitionProviderLike<TUri = MonacoUriLike> {
  provideTypeDefinition(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoLocationOut<TUri>[]>;
}
export interface MonacoImplementationProviderLike<TUri = MonacoUriLike> {
  provideImplementation(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoLocationOut<TUri>[]>;
}
export interface MonacoDeclarationProviderLike<TUri = MonacoUriLike> {
  provideDeclaration(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoLocationOut<TUri>[]>;
}
/** Monaco passes a reference context (includeDeclaration) as an extra argument. */
export interface MonacoReferenceContextLike {
  includeDeclaration: boolean;
}
export interface MonacoReferenceProviderLike<TUri = MonacoUriLike> {
  provideReferences(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    context: MonacoReferenceContextLike,
    token: CancellationTokenLike
  ): Promise<MonacoLocationOut<TUri>[]>;
}
/** Document highlights are in-model (range + kind), so no Uri adaptation is needed. */
export interface MonacoDocumentHighlightProviderLike {
  provideDocumentHighlights(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoDocumentHighlight[]>;
}
/** Document symbols are whole-document (no position) and stay in-model. */
export interface MonacoDocumentSymbolProviderLike {
  provideDocumentSymbols(model: MonacoModelLike, token: CancellationTokenLike): Promise<MonacoDocumentSymbol[]>;
}
/** Document formatting takes Monaco FormattingOptions and returns in-model text edits (no Uri adaptation). */
export interface MonacoDocumentFormattingEditProviderLike {
  provideDocumentFormattingEdits(
    model: MonacoModelLike,
    options: FormattingOptions,
    token: CancellationTokenLike
  ): Promise<MonacoTextEdit[]>;
}
/** Range formatting adds a Monaco range (converted to LSP) alongside FormattingOptions. */
export interface MonacoDocumentRangeFormattingEditProviderLike {
  provideDocumentRangeFormattingEdits(
    model: MonacoModelLike,
    range: MonacoRangeLike,
    options: FormattingOptions,
    token: CancellationTokenLike
  ): Promise<MonacoTextEdit[]>;
}
/** On-type formatting carries autoFormatTriggerCharacters (from capabilities) plus the typed character. */
export interface MonacoOnTypeFormattingEditProviderLike {
  autoFormatTriggerCharacters: string[];
  provideOnTypeFormattingEdits(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    ch: string,
    options: FormattingOptions,
    token: CancellationTokenLike
  ): Promise<MonacoTextEdit[]>;
}
/** Monaco passes signature-help context as the 4th argument (after the token). */
export interface MonacoSignatureHelpContextLike {
  triggerKind: number;
  triggerCharacter?: string;
  isRetrigger: boolean;
  activeSignatureHelp?: unknown;
}
/** Monaco wraps signature help in a disposable result. */
export interface MonacoSignatureHelpResultLike {
  value: MonacoSignatureHelp;
  dispose(): void;
}
export interface MonacoSignatureHelpProviderLike {
  signatureHelpTriggerCharacters: string[];
  signatureHelpRetriggerCharacters: string[];
  provideSignatureHelp(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike,
    context: MonacoSignatureHelpContextLike
  ): Promise<MonacoSignatureHelpResultLike | null>;
}
/** Selection ranges take an array of positions and return one inner-to-outer chain per position. */
export interface MonacoSelectionRangeProviderLike {
  provideSelectionRanges(
    model: MonacoModelLike,
    positions: MonacoPositionLike[],
    token: CancellationTokenLike
  ): Promise<MonacoSelectionRange[][]>;
}
/** Code lenses are whole-document; CodeLensList.dispose is optional so the bridge output is returned as-is. */
export interface MonacoCodeLensProviderLike {
  provideCodeLenses(model: MonacoModelLike, token: CancellationTokenLike): Promise<MonacoCodeLensList>;
}
/** Monaco's link provider method is provideLinks; ILinksList.dispose is optional. */
export interface MonacoLinkProviderLike {
  provideLinks(model: MonacoModelLike, token: CancellationTokenLike): Promise<MonacoDocumentLinkList>;
}
/** Monaco semantic-tokens legend (token type/modifier names), supplied by the server capabilities. */
export interface MonacoSemanticTokensLegendLike {
  tokenTypes: string[];
  tokenModifiers: string[];
}
/**
 * Document semantic tokens provider (Monaco contract). provideDocumentSemanticTokens itself returns
 * either a full result or a delta (SemanticTokensEdits): when the server advertises full:{delta:true}
 * and Monaco passes a lastResultId matching the prior result, the adapter requests a delta. Monaco
 * has no separate edits method, so the delta decision lives inside provideDocumentSemanticTokens.
 */
export interface MonacoDocumentSemanticTokensProviderLike {
  getLegend(): MonacoSemanticTokensLegendLike;
  provideDocumentSemanticTokens(
    model: MonacoModelLike,
    lastResultId: string | null,
    token: CancellationTokenLike
  ): Promise<MonacoSemanticTokens | MonacoSemanticTokensEdits | null>;
  releaseDocumentSemanticTokens(resultId: string | undefined): void;
}
/** Range semantic tokens: getLegend plus a range-scoped request; no lastResultId/release. */
export interface MonacoDocumentRangeSemanticTokensProviderLike {
  getLegend(): MonacoSemanticTokensLegendLike;
  provideDocumentRangeSemanticTokens(
    model: MonacoModelLike,
    range: MonacoRangeLike,
    token: CancellationTokenLike
  ): Promise<MonacoSemanticTokens | null>;
}
/** Monaco CodeActionContext: markers (IMarkerData), an optional single kind, and a trigger type. */
export interface MonacoCodeActionContextLike {
  markers: MonacoMarkerInput[];
  only?: string;
  trigger?: number;
}
/** A Monaco code action: like MonacoCodeAction but with the workspace edit's resources as Uri objects. */
export interface MonacoCodeActionOut<TUri = MonacoUriLike> {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: MonacoWorkspaceEditOut<TUri>;
  command?: MonacoCommand;
}
export interface MonacoCodeActionListOut<TUri = MonacoUriLike> {
  actions: MonacoCodeActionOut<TUri>[];
  dispose(): void;
}
export interface MonacoCodeActionProviderLike<TUri = MonacoUriLike> {
  provideCodeActions(
    model: MonacoModelLike,
    range: MonacoRangeLike,
    context: MonacoCodeActionContextLike,
    token: CancellationTokenLike
  ): Promise<MonacoCodeActionListOut<TUri>>;
}
/** Monaco passes a completion context (triggerKind 0-based, triggerCharacter) as the 3rd argument. */
export interface MonacoCompletionContextLike {
  triggerKind: number;
  triggerCharacter?: string;
}
/** A Monaco completion suggestion: the range-less draft completed with the injected required range. */
export type MonacoCompletionItemOut = MonacoCompletionItemDraft & { range: MonacoRange };
export interface MonacoCompletionListOut {
  suggestions: MonacoCompletionItemOut[];
  incomplete: boolean;
}
export interface MonacoCompletionItemProviderLike {
  triggerCharacters: string[];
  provideCompletionItems(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    context: MonacoCompletionContextLike,
    token: CancellationTokenLike
  ): Promise<MonacoCompletionListOut>;
}
/** Minimal Monaco FoldingRangeKind shape ({ value }); real wiring builds it via FoldingRangeKind.fromValue. */
export interface MonacoFoldingRangeKindLike {
  value: string;
}
/** A Monaco folding range: 1-based start/end plus an optional kind built from the injected factory. */
export interface MonacoFoldingRangeOut<TFoldingKind = MonacoFoldingRangeKindLike> {
  start: number;
  end: number;
  kind?: TFoldingKind;
}
export interface MonacoFoldingRangeProviderLike<TFoldingKind = MonacoFoldingRangeKindLike> {
  provideFoldingRanges(
    model: MonacoModelLike,
    context: unknown,
    token: CancellationTokenLike
  ): Promise<MonacoFoldingRangeOut<TFoldingKind>[]>;
}
/** Monaco LinkedEditingRanges: ranges plus an optional COMPILED RegExp wordPattern. */
export interface MonacoLinkedEditingRangesOut {
  ranges: MonacoRange[];
  wordPattern?: RegExp;
}
export interface MonacoLinkedEditingRangeProviderLike {
  provideLinkedEditingRanges(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoLinkedEditingRangesOut | null>;
}
/** Monaco InlayHintList requires a dispose(); the converter draft omits it, so the adapter completes it. */
export interface MonacoInlayHintListOut {
  hints: MonacoInlayHint[];
  dispose(): void;
}
export interface MonacoInlayHintsProviderLike {
  provideInlayHints(
    model: MonacoModelLike,
    range: MonacoRangeLike,
    token: CancellationTokenLike
  ): Promise<MonacoInlayHintListOut>;
}
/** Monaco color info: a color plus the range it occupies. */
export interface MonacoColorInformationLike {
  color: LspColor;
  range: MonacoRangeLike;
}
/** A Monaco workspace text edit: like the converter output but with a Uri-object resource. */
export interface MonacoWorkspaceTextEditOut<TUri = MonacoUriLike> {
  resource: TUri;
  textEdit: MonacoTextEdit;
  /**
   * Always present (value undefined when the server gave no version) to match Monaco's
   * IWorkspaceTextEdit, whose versionId is a required key of type number | undefined.
   */
  versionId: number | undefined;
}
export interface MonacoWorkspaceEditOut<TUri = MonacoUriLike> {
  edits: MonacoWorkspaceTextEditOut<TUri>[];
}
/** Monaco RenameLocation: the range to rename and its current text. */
export interface MonacoRenameLocationOut {
  range: MonacoRange;
  text: string;
}
/** Rename returns a workspace edit; resolveRenameLocation (prepareRename) is optional. */
export interface MonacoRenameProviderLike<TUri = MonacoUriLike> {
  provideRenameEdits(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    newName: string,
    token: CancellationTokenLike
  ): Promise<MonacoWorkspaceEditOut<TUri>>;
  resolveRenameLocation?(
    model: MonacoModelLike,
    position: MonacoPositionLike,
    token: CancellationTokenLike
  ): Promise<MonacoRenameLocationOut | null>;
}
/** One Monaco color provider exposes both document colors and color presentations. */
export interface MonacoColorProviderLike {
  provideDocumentColors(model: MonacoModelLike, token: CancellationTokenLike): Promise<MonacoColorInformation[]>;
  provideColorPresentations(
    model: MonacoModelLike,
    colorInfo: MonacoColorInformationLike,
    token: CancellationTokenLike
  ): Promise<MonacoColorPresentation[]>;
}

/** Minimal shape of the monaco.languages registry surface this slice needs. */
export interface MonacoLanguagesLike<
  TUri = MonacoUriLike,
  TFoldingKind = MonacoFoldingRangeKindLike,
  TSelector = unknown
> {
  registerHoverProvider(selector: TSelector, provider: MonacoHoverProviderLike): { dispose(): void };
  registerDefinitionProvider(selector: TSelector, provider: MonacoDefinitionProviderLike<TUri>): { dispose(): void };
  registerTypeDefinitionProvider(
    selector: TSelector,
    provider: MonacoTypeDefinitionProviderLike<TUri>
  ): { dispose(): void };
  registerImplementationProvider(
    selector: TSelector,
    provider: MonacoImplementationProviderLike<TUri>
  ): { dispose(): void };
  registerDeclarationProvider(selector: TSelector, provider: MonacoDeclarationProviderLike<TUri>): { dispose(): void };
  registerReferenceProvider(selector: TSelector, provider: MonacoReferenceProviderLike<TUri>): { dispose(): void };
  registerDocumentHighlightProvider(selector: TSelector, provider: MonacoDocumentHighlightProviderLike): { dispose(): void };
  registerDocumentSymbolProvider(selector: TSelector, provider: MonacoDocumentSymbolProviderLike): { dispose(): void };
  registerDocumentFormattingEditProvider(
    selector: TSelector,
    provider: MonacoDocumentFormattingEditProviderLike
  ): { dispose(): void };
  registerDocumentRangeFormattingEditProvider(
    selector: TSelector,
    provider: MonacoDocumentRangeFormattingEditProviderLike
  ): { dispose(): void };
  registerOnTypeFormattingEditProvider(
    selector: TSelector,
    provider: MonacoOnTypeFormattingEditProviderLike
  ): { dispose(): void };
  registerSignatureHelpProvider(selector: TSelector, provider: MonacoSignatureHelpProviderLike): { dispose(): void };
  registerSelectionRangeProvider(selector: TSelector, provider: MonacoSelectionRangeProviderLike): { dispose(): void };
  registerCodeLensProvider(selector: TSelector, provider: MonacoCodeLensProviderLike): { dispose(): void };
  registerLinkProvider(selector: TSelector, provider: MonacoLinkProviderLike): { dispose(): void };
  registerColorProvider(selector: TSelector, provider: MonacoColorProviderLike): { dispose(): void };
  registerRenameProvider(selector: TSelector, provider: MonacoRenameProviderLike<TUri>): { dispose(): void };
  registerInlayHintsProvider(selector: TSelector, provider: MonacoInlayHintsProviderLike): { dispose(): void };
  registerLinkedEditingRangeProvider(
    selector: TSelector,
    provider: MonacoLinkedEditingRangeProviderLike
  ): { dispose(): void };
  registerFoldingRangeProvider(
    selector: TSelector,
    provider: MonacoFoldingRangeProviderLike<TFoldingKind>
  ): { dispose(): void };
  registerCompletionItemProvider(selector: TSelector, provider: MonacoCompletionItemProviderLike): { dispose(): void };
  registerDocumentSemanticTokensProvider(
    selector: TSelector,
    provider: MonacoDocumentSemanticTokensProviderLike
  ): { dispose(): void };
  registerDocumentRangeSemanticTokensProvider(
    selector: TSelector,
    provider: MonacoDocumentRangeSemanticTokensProviderLike
  ): { dispose(): void };
  registerCodeActionProvider(selector: TSelector, provider: MonacoCodeActionProviderLike<TUri>): { dispose(): void };
}

/**
 * Build a Monaco provider method from a connection bridge: normalize the model URI, convert the
 * position to LSP, bridge the CancellationToken to an AbortSignal, run the bridge, map the result,
 * and always dispose the cancellation bridge once the request settles.
 */
function makePositionHandler<TResult, TOut>(
  callBridge: (target: ProviderTarget, signal: AbortSignal) => Promise<TResult>,
  mapResult: (result: TResult) => TOut
): (model: MonacoModelLike, position: MonacoPositionLike, token: CancellationTokenLike) => Promise<TOut> {
  return async (model, position, token) => {
    const uri = model.uri.toString();
    const lspPosition = monacoPositionToLsp(position);
    const bridge = cancellationTokenToAbortSignal(token);
    try {
      return mapResult(await callBridge({ uri, position: lspPosition }, bridge.signal));
    } finally {
      bridge.dispose();
    }
  };
}

/**
 * Like makePositionHandler but for whole-document (position-less) providers: normalize the model
 * URI, bridge cancellation, run the bridge with { uri } only, map the result, and dispose on settle.
 */
function makeModelHandler<TResult, TOut>(
  callBridge: (target: { uri: string }, signal: AbortSignal) => Promise<TResult>,
  mapResult: (result: TResult) => TOut
): (model: MonacoModelLike, token: CancellationTokenLike) => Promise<TOut> {
  return async (model, token) => {
    const uri = model.uri.toString();
    const bridge = cancellationTokenToAbortSignal(token);
    try {
      return mapResult(await callBridge({ uri }, bridge.signal));
    } finally {
      bridge.dispose();
    }
  };
}

/**
 * CancellationToken that fires when EITHER Monaco's token cancels OR the scheduler aborts
 * on dispose/root-switch cleanup. Passed to the existing provider handlers so cancellation + caches
 * (e.g. semanticTokens resultId) honor scheduler teardown without any change to provider logic.
 */
function combineCancellation(token: CancellationTokenLike, signal: AbortSignal): CancellationTokenLike {
  return {
    get isCancellationRequested(): boolean {
      return token.isCancellationRequested || signal.aborted;
    },
    onCancellationRequested(listener: () => void): { dispose(): void } {
      const registration = token.onCancellationRequested(listener);
      if (signal.aborted) {
        listener();
      }
      const onAbort = (): void => listener();
      signal.addEventListener('abort', onAbort, { once: true });
      return {
        dispose(): void {
          registration.dispose();
          signal.removeEventListener('abort', onAbort);
        }
      };
    }
  };
}

/** A Monaco-recognized cancellation error (name 'Canceled'): treated as cancellation, not a logged
 *  provider failure, so a superseded request leaves prior decorations intact until the trailing run. */
function monacoCanceled(): Error {
  const error = new Error('Canceled');
  error.name = 'Canceled';
  return error;
}

/**
 * Run a provider handler through the scheduler: leading-edge + trailing-latest by `key`, abort
 * in-flight work on scheduler dispose/root switch, and surface a queued superseded call as a Monaco
 * cancellation (never an empty/null result, which Monaco would treat as authoritative).
 */
function runScheduled<T>(
  scheduler: ProviderScheduler,
  key: string,
  token: CancellationTokenLike,
  exec: (token: CancellationTokenLike) => Promise<T>
): Promise<T> {
  const result = scheduler.run(key, (signal) => exec(combineCancellation(token, signal))).catch((error: unknown) => {
    if (error instanceof ProviderSupersededError) {
      throw monacoCanceled();
    }
    throw error;
  });
  // Guard: a superseded call rejects before Monaco (or a test) attaches a handler. Attach a no-op
  // catch so it is never an *unhandled* rejection; the returned promise still rejects for the caller.
  result.catch(() => undefined);
  return result;
}

/**
 * Register LSP-backed providers into Monaco for the given language selector, gated by capabilities.
 * Location providers also require createUri so their string-uri results can be mapped to Monaco Uri
 * objects. Returns a composite Disposable that tears down every registration made here.
 */
export function registerLspProviders<
  TUri = MonacoUriLike,
  TFoldingKind = MonacoFoldingRangeKindLike,
  TSelector = unknown
>(
  languages: MonacoLanguagesLike<TUri, TFoldingKind, TSelector>,
  connection: ProviderConnection,
  capabilities: ServerCapabilities,
  selector: TSelector,
  createUri?: (value: string) => TUri,
  createFoldingRangeKind?: (value: string) => TFoldingKind,
  // Damper for the on-open burst providers (semanticTokens, codeLens, documentSymbol,
  // foldingRange, inlayHint, codeAction). Defaults to a no-op so provider-logic unit tests keep their
  // synchronous behavior; production passes createProviderScheduler({delayMs}) to debounce/coalesce.
  // Latency-sensitive direct actions (hover, definition, completion, rename, formatting, references,
  // signatureHelp) are NEVER scheduled.
  burstScheduler: ProviderScheduler = createImmediateProviderScheduler()
): { dispose(): void } {
  const disposables: { dispose(): void }[] = [];

  if (capabilities.hoverProvider) {
    const bridge = createHoverProvider(connection);
    const provideHover = makePositionHandler(
      (target, signal) => bridge.provideHover(target, signal),
      (result: MonacoHover | null) => result
    );
    disposables.push(languages.registerHoverProvider(selector, { provideHover }));
  }

  const make = createUri;
  const mapLocations = make
    ? (locations: MonacoLocation[]): MonacoLocationOut<TUri>[] =>
        locations.map((location) => ({ uri: make(location.uri), range: location.range }))
    : undefined;

  if (capabilities.definitionProvider && mapLocations) {
    const bridge = createDefinitionProvider(connection);
    const provideDefinition = makePositionHandler((target, signal) => bridge.provideDefinition(target, signal), mapLocations);
    disposables.push(languages.registerDefinitionProvider(selector, { provideDefinition }));
  }
  if (capabilities.typeDefinitionProvider && mapLocations) {
    const bridge = createTypeDefinitionProvider(connection);
    const provideTypeDefinition = makePositionHandler(
      (target, signal) => bridge.provideTypeDefinition(target, signal),
      mapLocations
    );
    disposables.push(languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition }));
  }
  if (capabilities.implementationProvider && mapLocations) {
    const bridge = createImplementationProvider(connection);
    const provideImplementation = makePositionHandler(
      (target, signal) => bridge.provideImplementation(target, signal),
      mapLocations
    );
    disposables.push(languages.registerImplementationProvider(selector, { provideImplementation }));
  }
  if (capabilities.declarationProvider && mapLocations) {
    const bridge = createDeclarationProvider(connection);
    const provideDeclaration = makePositionHandler(
      (target, signal) => bridge.provideDeclaration(target, signal),
      mapLocations
    );
    disposables.push(languages.registerDeclarationProvider(selector, { provideDeclaration }));
  }
  if (capabilities.referencesProvider && mapLocations) {
    const bridge = createReferencesProvider(connection);
    // References carries a per-call context (includeDeclaration), so it cannot use makePositionHandler.
    const provideReferences = async (
      model: MonacoModelLike,
      position: MonacoPositionLike,
      context: MonacoReferenceContextLike,
      token: CancellationTokenLike
    ): Promise<MonacoLocationOut<TUri>[]> => {
      const uri = model.uri.toString();
      const lspPosition = monacoPositionToLsp(position);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const locations = await bridge.provideReferences(
          { uri, position: lspPosition },
          { includeDeclaration: context.includeDeclaration },
          abort.signal
        );
        return mapLocations(locations);
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerReferenceProvider(selector, { provideReferences }));
  }
  if (capabilities.documentHighlightProvider) {
    const bridge = createDocumentHighlightProvider(connection);
    const provideDocumentHighlights = makePositionHandler(
      (target, signal) => bridge.provideDocumentHighlights(target, signal),
      (result: MonacoDocumentHighlight[]) => result
    );
    disposables.push(languages.registerDocumentHighlightProvider(selector, { provideDocumentHighlights }));
  }
  if (capabilities.documentSymbolProvider) {
    const bridge = createDocumentSymbolProvider(connection);
    const baseProvideDocumentSymbols = makeModelHandler(
      (target, signal) => bridge.provideDocumentSymbols(target, signal),
      (result: MonacoDocumentSymbol[]) => result
    );
    const provideDocumentSymbols = (model: MonacoModelLike, token: CancellationTokenLike) =>
      runScheduled(burstScheduler, `documentSymbol|${model.uri.toString()}`, token, (t) => baseProvideDocumentSymbols(model, t));
    disposables.push(languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols }));
  }
  if (capabilities.documentFormattingProvider) {
    const bridge = createDocumentFormattingProvider(connection);
    // Formatting carries FormattingOptions (no position), so it uses a dedicated model+options handler.
    const provideDocumentFormattingEdits = async (
      model: MonacoModelLike,
      options: FormattingOptions,
      token: CancellationTokenLike
    ): Promise<MonacoTextEdit[]> => {
      const uri = model.uri.toString();
      const abort = cancellationTokenToAbortSignal(token);
      try {
        return await bridge.provideDocumentFormatting({ uri, options }, abort.signal);
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerDocumentFormattingEditProvider(selector, { provideDocumentFormattingEdits }));
  }
  if (capabilities.documentRangeFormattingProvider) {
    const bridge = createDocumentRangeFormattingProvider(connection);
    const provideDocumentRangeFormattingEdits = async (
      model: MonacoModelLike,
      range: MonacoRangeLike,
      options: FormattingOptions,
      token: CancellationTokenLike
    ): Promise<MonacoTextEdit[]> => {
      const uri = model.uri.toString();
      const lspRange = monacoRangeToLsp(range);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        return await bridge.provideDocumentRangeFormatting({ uri, range: lspRange, options }, abort.signal);
      } finally {
        abort.dispose();
      }
    };
    disposables.push(
      languages.registerDocumentRangeFormattingEditProvider(selector, { provideDocumentRangeFormattingEdits })
    );
  }
  if (capabilities.documentOnTypeFormattingProvider) {
    const onTypeCapability = capabilities.documentOnTypeFormattingProvider as {
      firstTriggerCharacter: string;
      moreTriggerCharacter?: string[];
    };
    const autoFormatTriggerCharacters = [
      onTypeCapability.firstTriggerCharacter,
      ...(onTypeCapability.moreTriggerCharacter ?? [])
    ];
    const bridge = createDocumentOnTypeFormattingProvider(connection);
    const provideOnTypeFormattingEdits = async (
      model: MonacoModelLike,
      position: MonacoPositionLike,
      ch: string,
      options: FormattingOptions,
      token: CancellationTokenLike
    ): Promise<MonacoTextEdit[]> => {
      const uri = model.uri.toString();
      const lspPosition = monacoPositionToLsp(position);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        return await bridge.provideOnTypeFormatting({ uri, position: lspPosition, ch, options }, abort.signal);
      } finally {
        abort.dispose();
      }
    };
    disposables.push(
      languages.registerOnTypeFormattingEditProvider(selector, { autoFormatTriggerCharacters, provideOnTypeFormattingEdits })
    );
  }
  if (capabilities.signatureHelpProvider) {
    const signatureCapability = capabilities.signatureHelpProvider as {
      triggerCharacters?: string[];
      retriggerCharacters?: string[];
    };
    const signatureHelpTriggerCharacters = signatureCapability.triggerCharacters ?? [];
    const signatureHelpRetriggerCharacters = signatureCapability.retriggerCharacters ?? [];
    const bridge = createSignatureHelpProvider(connection);
    const provideSignatureHelp = async (
      model: MonacoModelLike,
      position: MonacoPositionLike,
      token: CancellationTokenLike,
      context: MonacoSignatureHelpContextLike
    ): Promise<MonacoSignatureHelpResultLike | null> => {
      const uri = model.uri.toString();
      const lspPosition = monacoPositionToLsp(position);
      // Map only the scalar context fields; activeSignatureHelp is Monaco-shaped with no LSP reverse converter.
      const lspContext: SignatureHelpContext = { triggerKind: context.triggerKind, isRetrigger: context.isRetrigger };
      if (context.triggerCharacter !== undefined) {
        lspContext.triggerCharacter = context.triggerCharacter;
      }
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const help = await bridge.provideSignatureHelp({ uri, position: lspPosition }, lspContext, abort.signal);
        if (help === null) {
          return null;
        }
        return { value: help, dispose() {} };
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerSignatureHelpProvider(selector, {
      signatureHelpTriggerCharacters,
      signatureHelpRetriggerCharacters,
      provideSignatureHelp
    }));
  }
  if (capabilities.selectionRangeProvider) {
    const bridge = createSelectionRangeProvider(connection);
    const provideSelectionRanges = async (
      model: MonacoModelLike,
      positions: MonacoPositionLike[],
      token: CancellationTokenLike
    ): Promise<MonacoSelectionRange[][]> => {
      const uri = model.uri.toString();
      const lspPositions = positions.map(monacoPositionToLsp);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        return await bridge.provideSelectionRanges({ uri, positions: lspPositions }, abort.signal);
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerSelectionRangeProvider(selector, { provideSelectionRanges }));
  }
  if (capabilities.codeLensProvider) {
    const bridge = createCodeLensProvider(connection);
    const baseProvideCodeLenses = makeModelHandler(
      (target, signal) => bridge.provideCodeLenses(target, signal),
      (result: MonacoCodeLensList) => result
    );
    const provideCodeLenses = (model: MonacoModelLike, token: CancellationTokenLike) =>
      runScheduled(burstScheduler, `codeLens|${model.uri.toString()}`, token, (t) => baseProvideCodeLenses(model, t));
    disposables.push(languages.registerCodeLensProvider(selector, { provideCodeLenses }));
  }
  if (capabilities.documentLinkProvider) {
    const bridge = createDocumentLinkProvider(connection);
    const provideLinks = makeModelHandler(
      (target, signal) => bridge.provideDocumentLinks(target, signal),
      (result: MonacoDocumentLinkList) => result
    );
    disposables.push(languages.registerLinkProvider(selector, { provideLinks }));
  }
  if (capabilities.colorProvider) {
    const bridge = createColorProvider(connection);
    const provideDocumentColors = makeModelHandler(
      (target, signal) => bridge.provideDocumentColors(target, signal),
      (result: MonacoColorInformation[]) => result
    );
    const provideColorPresentations = async (
      model: MonacoModelLike,
      colorInfo: MonacoColorInformationLike,
      token: CancellationTokenLike
    ): Promise<MonacoColorPresentation[]> => {
      const uri = model.uri.toString();
      const lspRange = monacoRangeToLsp(colorInfo.range);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        return await bridge.provideColorPresentations({ uri, color: colorInfo.color, range: lspRange }, abort.signal);
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerColorProvider(selector, { provideDocumentColors, provideColorPresentations }));
  }
  if (capabilities.renameProvider && make) {
    const mapResource = make;
    const bridge = createRenameProvider(connection);
    const provideRenameEdits = async (
      model: MonacoModelLike,
      position: MonacoPositionLike,
      newName: string,
      token: CancellationTokenLike
    ): Promise<MonacoWorkspaceEditOut<TUri>> => {
      const uri = model.uri.toString();
      const lspPosition = monacoPositionToLsp(position);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const workspaceEdit: MonacoWorkspaceEdit = await bridge.provideRenameEdits(
          { uri, position: lspPosition, newName },
          abort.signal
        );
        return {
          edits: workspaceEdit.edits.map((entry) => {
            // versionId key always present (undefined when absent) to match Monaco IWorkspaceTextEdit.
            const mapped: MonacoWorkspaceTextEditOut<TUri> = {
              resource: mapResource(entry.resource),
              textEdit: entry.textEdit,
              versionId: entry.versionId
            };
            return mapped;
          })
        };
      } finally {
        abort.dispose();
      }
    };
    const renameProvider: MonacoRenameProviderLike<TUri> = { provideRenameEdits };
    const renameCapability = capabilities.renameProvider as { prepareProvider?: unknown };
    if (renameCapability.prepareProvider) {
      const prepareBridge = createPrepareRenameProvider(connection);
      renameProvider.resolveRenameLocation = async (model, position, token) => {
        const uri = model.uri.toString();
        const lspPosition = monacoPositionToLsp(position);
        const abort = cancellationTokenToAbortSignal(token);
        try {
          const draft: MonacoRenamePrepare | null = await prepareBridge.providePrepareRename(
            { uri, position: lspPosition },
            abort.signal
          );
          if (draft === null) {
            return null;
          }
          // Prefer the server placeholder (preserving ''); otherwise the current text in the range.
          const text = draft.placeholder ?? model.getValueInRange(draft.range);
          return { range: draft.range, text };
        } finally {
          abort.dispose();
        }
      };
    }
    disposables.push(languages.registerRenameProvider(selector, renameProvider));
  }
  if (capabilities.inlayHintProvider) {
    const bridge = createInlayHintProvider(connection);
    const baseProvideInlayHints = async (
      model: MonacoModelLike,
      range: MonacoRangeLike,
      token: CancellationTokenLike
    ): Promise<MonacoInlayHintListOut> => {
      const uri = model.uri.toString();
      const lspRange = monacoRangeToLsp(range);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const draft = await bridge.provideInlayHints({ uri, range: lspRange }, abort.signal);
        // Complete the draft: Monaco's InlayHintList requires a dispose(); the adapter holds no resource.
        return { hints: draft.hints, dispose() {} };
      } finally {
        abort.dispose();
      }
    };
    // Coarse method+uri key so rapid scroll churn collapses to leading + trailing-latest; the delivered
    // caller still runs its OWN range via the exec closure (superseded callers get cancellation, no data).
    const provideInlayHints = (model: MonacoModelLike, range: MonacoRangeLike, token: CancellationTokenLike) =>
      runScheduled(burstScheduler, `inlayHint|${model.uri.toString()}`, token, (t) => baseProvideInlayHints(model, range, t));
    disposables.push(languages.registerInlayHintsProvider(selector, { provideInlayHints }));
  }
  if (capabilities.linkedEditingRangeProvider) {
    const bridge = createLinkedEditingRangeProvider(connection);
    const provideLinkedEditingRanges = async (
      model: MonacoModelLike,
      position: MonacoPositionLike,
      token: CancellationTokenLike
    ): Promise<MonacoLinkedEditingRangesOut | null> => {
      const uri = model.uri.toString();
      const lspPosition = monacoPositionToLsp(position);
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const draft: MonacoLinkedEditingRangesDraft | undefined = await bridge.provideLinkedEditingRanges(
          { uri, position: lspPosition },
          abort.signal
        );
        if (draft === undefined) {
          return null;
        }
        const result: MonacoLinkedEditingRangesOut = { ranges: draft.ranges };
        if (draft.wordPattern !== undefined) {
          // Compile the LSP string pattern to a RegExp; omit it if the server sends an invalid pattern.
          try {
            result.wordPattern = new RegExp(draft.wordPattern);
          } catch {
            // invalid pattern: leave wordPattern unset
          }
        }
        return result;
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerLinkedEditingRangeProvider(selector, { provideLinkedEditingRanges }));
  }
  if (capabilities.foldingRangeProvider && createFoldingRangeKind) {
    const makeKind = createFoldingRangeKind;
    const bridge = createFoldingRangeProvider(connection);
    const baseProvideFoldingRanges = async (
      model: MonacoModelLike,
      _context: unknown,
      token: CancellationTokenLike
    ): Promise<MonacoFoldingRangeOut<TFoldingKind>[]> => {
      const uri = model.uri.toString();
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const drafts = await bridge.provideFoldingRanges({ uri }, abort.signal);
        return drafts.map((draft) => {
          const folding: MonacoFoldingRangeOut<TFoldingKind> = { start: draft.start, end: draft.end };
          if (draft.kind !== undefined) {
            folding.kind = makeKind(draft.kind);
          }
          return folding;
        });
      } finally {
        abort.dispose();
      }
    };
    const provideFoldingRanges = (model: MonacoModelLike, context: unknown, token: CancellationTokenLike) =>
      runScheduled(burstScheduler, `foldingRange|${model.uri.toString()}`, token, (t) => baseProvideFoldingRanges(model, context, t));
    disposables.push(languages.registerFoldingRangeProvider(selector, { provideFoldingRanges }));
  }
  if (capabilities.completionProvider) {
    const completionCapability = capabilities.completionProvider as { triggerCharacters?: string[] };
    const triggerCharacters = completionCapability.triggerCharacters ?? [];
    const bridge = createCompletionProvider(connection);
    const provideCompletionItems = async (
      model: MonacoModelLike,
      position: MonacoPositionLike,
      context: MonacoCompletionContextLike,
      token: CancellationTokenLike
    ): Promise<MonacoCompletionListOut> => {
      const uri = model.uri.toString();
      const lspPosition = monacoPositionToLsp(position);
      // Monaco CompletionTriggerKind is 0-based; LSP is 1-based, so add 1.
      const lspContext: CompletionContext = { triggerKind: context.triggerKind + 1 };
      if (context.triggerCharacter !== undefined) {
        lspContext.triggerCharacter = context.triggerCharacter;
      }
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const draft = await bridge.provideCompletions({ uri, position: lspPosition }, lspContext, abort.signal);
        // CompletionItem.range is required; inject the one model word-range into every suggestion.
        const word = model.getWordUntilPosition(position);
        const range: MonacoRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn
        };
        return {
          suggestions: draft.suggestions.map((suggestion) => ({ ...suggestion, range })),
          incomplete: draft.incomplete
        };
      } finally {
        abort.dispose();
      }
    };
    disposables.push(languages.registerCompletionItemProvider(selector, { triggerCharacters, provideCompletionItems }));
  }
  const semanticTokensCapability = capabilities.semanticTokensProvider as
    | { legend?: MonacoSemanticTokensLegendLike; full?: boolean | { delta?: boolean } }
    | undefined;
  if (semanticTokensCapability && semanticTokensCapability.legend) {
    const legend = semanticTokensCapability.legend;
    const bridge = createDocumentSemanticTokensProvider(connection);
    const fullCapability = semanticTokensCapability.full;
    const deltaEnabled = typeof fullCapability === 'object' && fullCapability !== null && fullCapability.delta === true;
    const getLegend = () => ({ tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers });
    if (!deltaEnabled) {
      // No full:{delta:true}: keep the full-only provider (no Edits method -> Monaco never deltas).
      const provider: MonacoDocumentSemanticTokensProviderLike = {
        getLegend,
        provideDocumentSemanticTokens(model, _lastResultId, token) {
          return runScheduled(burstScheduler, `semanticTokens|${model.uri.toString()}`, token, async (t) => {
            const uri = model.uri.toString();
            const abort = cancellationTokenToAbortSignal(t);
            try {
              return await bridge.provideDocumentSemanticTokens({ uri }, abort.signal);
            } finally {
              abort.dispose();
            }
          });
        },
        releaseDocumentSemanticTokens() {
          // No cached result to release.
        }
      };
      disposables.push(languages.registerDocumentSemanticTokensProvider(selector, provider));
    } else {
      // uri -> the resultId last handed to Monaco. A delta is requested only when Monaco's
      // previousResultId matches this; released/stale/cross-session ids fall back to full.
      const resultIds = new Map<string, string>();
      const remember = (uri: string, result: MonacoSemanticTokens | MonacoSemanticTokensEdits | null): void => {
        const resultId = result?.resultId;
        if (typeof resultId === 'string') {
          resultIds.set(uri, resultId);
        } else {
          resultIds.delete(uri);
        }
      };
      const provider: MonacoDocumentSemanticTokensProviderLike = {
        getLegend,
        // Monaco passes the prior result's resultId here (no separate edits method). Matching cached
        // id -> request a delta; null/missing/mismatch/released/reset -> full.
        provideDocumentSemanticTokens(model, lastResultId, token) {
          // Scheduled; queued superseded calls reject before exec, and dispose/root-switch cancellation
          // rejects before delivery -> resultId is updated ONLY after a non-aborted success.
          return runScheduled(burstScheduler, `semanticTokens|${model.uri.toString()}`, token, async (t) => {
            const uri = model.uri.toString();
            const abort = cancellationTokenToAbortSignal(t);
            try {
              if (typeof lastResultId === 'string' && resultIds.get(uri) === lastResultId) {
                try {
                  const delta = await bridge.provideDocumentSemanticTokensDelta({ uri }, lastResultId, abort.signal);
                  remember(uri, delta); // delta edits, delta-endpoint full, or null (clears) all handled here
                  return delta;
                } catch (error) {
                  // Cancellation propagates (no fallback); any other failure clears the cache and
                  // retries exactly one full request.
                  if (abort.signal.aborted) {
                    throw error;
                  }
                  resultIds.delete(uri);
                  const full = await bridge.provideDocumentSemanticTokens({ uri }, abort.signal);
                  remember(uri, full);
                  return full;
                }
              }
              const full = await bridge.provideDocumentSemanticTokens({ uri }, abort.signal);
              remember(uri, full);
              return full;
            } finally {
              abort.dispose();
            }
          });
        },
        releaseDocumentSemanticTokens(resultId) {
          if (resultId === undefined) {
            return;
          }
          for (const [uri, id] of resultIds) {
            if (id === resultId) {
              resultIds.delete(uri);
            }
          }
        }
      };
      disposables.push(languages.registerDocumentSemanticTokensProvider(selector, provider));
      // Provider/session/root dispose clears the cache so a fresh session never reuses a resultId.
      disposables.push({ dispose: () => resultIds.clear() });
    }
  }
  if (semanticTokensCapability && semanticTokensCapability.legend && (semanticTokensCapability as { range?: unknown }).range) {
    const legend = semanticTokensCapability.legend;
    const bridge = createDocumentRangeSemanticTokensProvider(connection);
    const provider: MonacoDocumentRangeSemanticTokensProviderLike = {
      getLegend() {
        return { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers };
      },
      async provideDocumentRangeSemanticTokens(model, range, token) {
        const uri = model.uri.toString();
        const lspRange = monacoRangeToLsp(range);
        const abort = cancellationTokenToAbortSignal(token);
        try {
          return await bridge.provideDocumentRangeSemanticTokens({ uri, range: lspRange }, abort.signal);
        } finally {
          abort.dispose();
        }
      }
    };
    disposables.push(languages.registerDocumentRangeSemanticTokensProvider(selector, provider));
  }
  if (capabilities.codeActionProvider && make) {
    const mapResource = make;
    const bridge = createCodeActionProvider(connection);
    const baseProvideCodeActions = async (
      model: MonacoModelLike,
      range: MonacoRangeLike,
      context: MonacoCodeActionContextLike,
      token: CancellationTokenLike
    ): Promise<MonacoCodeActionListOut<TUri>> => {
      const uri = model.uri.toString();
      const lspRange = monacoRangeToLsp(range);
      const lspContext: CodeActionContext = { diagnostics: toLspDiagnostics(context.markers) };
      if (context.only !== undefined) {
        lspContext.only = [context.only];
      }
      if (context.trigger !== undefined) {
        lspContext.triggerKind = context.trigger;
      }
      const abort = cancellationTokenToAbortSignal(token);
      try {
        const list = await bridge.provideCodeActions({ uri, range: lspRange, context: lspContext }, abort.signal);
        const actions = list.actions.map((action: MonacoCodeAction) => {
          const out: MonacoCodeActionOut<TUri> = { title: action.title };
          if (action.kind !== undefined) {
            out.kind = action.kind;
          }
          if (action.isPreferred !== undefined) {
            out.isPreferred = action.isPreferred;
          }
          if (action.command !== undefined) {
            out.command = action.command;
          }
          if (action.edit !== undefined) {
            out.edit = {
              edits: action.edit.edits.map((entry) => {
                // versionId key always present (undefined when absent) to match Monaco IWorkspaceTextEdit.
                const mapped: MonacoWorkspaceTextEditOut<TUri> = {
                  resource: mapResource(entry.resource),
                  textEdit: entry.textEdit,
                  versionId: entry.versionId
                };
                return mapped;
              })
            };
          }
          return out;
        });
        return { actions, dispose() {} };
      } finally {
        abort.dispose();
      }
    };
    // Coarse method+uri key so rapid auto-codeAction churn (cursor moves) collapses to leading +
    // trailing-latest; the delivered caller runs its OWN range/context (superseded callers get no data).
    const provideCodeActions = (
      model: MonacoModelLike,
      range: MonacoRangeLike,
      context: MonacoCodeActionContextLike,
      token: CancellationTokenLike
    ) => runScheduled(burstScheduler, `codeAction|${model.uri.toString()}`, token, (t) => baseProvideCodeActions(model, range, context, t));
    disposables.push(languages.registerCodeActionProvider(selector, { provideCodeActions }));
  }

  return {
    dispose() {
      burstScheduler.dispose();
      for (const disposable of disposables) {
        disposable.dispose();
      }
    }
  };
}
