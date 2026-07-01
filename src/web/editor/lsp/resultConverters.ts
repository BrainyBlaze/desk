/**
 * Pure LSP -> Monaco result converters (data shape only, no monaco import).
 *
 * These turn LSP response payloads into the shapes Monaco providers must return. The
 * monaco.languages.register* wiring and monaco.Uri construction are later steps; keeping
 * the conversion logic pure makes it unit-testable without a live editor. LSP positions
 * are 0-based; Monaco ranges are 1-based.
 */

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspMarkupContent {
  kind: 'markdown' | 'plaintext';
  value: string;
}
/** LSP MarkedString: a plain string or a language-tagged code block. */
export type LspMarkedString = string | { language: string; value: string };
export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[];
  range?: LspRange;
}

export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
export interface MonacoMarkdownString {
  value: string;
}
export interface MonacoHover {
  contents: MonacoMarkdownString[];
  range?: MonacoRange;
}

/** Convert a 0-based LSP range to a 1-based Monaco range. */
export function toMonacoRange(range: LspRange): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function isMarkupContent(value: unknown): value is LspMarkupContent {
  return typeof value === 'object' && value !== null && 'kind' in value && 'value' in value;
}

/** A MarkedString renders as markdown; a language-tagged one becomes a fenced code block. */
function markedStringToValue(item: LspMarkedString): string {
  if (typeof item === 'string') {
    return item;
  }
  return '```' + item.language + '\n' + item.value + '\n```';
}

function normalizeHoverContents(contents: LspHover['contents']): MonacoMarkdownString[] {
  if (isMarkupContent(contents)) {
    return [{ value: contents.value }];
  }
  if (Array.isArray(contents)) {
    return contents.map((item) => ({ value: markedStringToValue(item) }));
  }
  return [{ value: markedStringToValue(contents) }];
}

/** Convert an LSP Hover to a Monaco Hover (normalized markdown contents, 1-based range). */
export function toMonacoHover(hover: LspHover): MonacoHover {
  const result: MonacoHover = { contents: normalizeHoverContents(hover.contents) };
  if (hover.range) {
    result.range = toMonacoRange(hover.range);
  }
  return result;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}
/** LSP LocationLink: a richer link with target/selection ranges, used by some definition results. */
export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
  originSelectionRange?: LspRange;
}
export interface MonacoLocation {
  uri: string;
  range: MonacoRange;
}

/** Convert a single LSP Location to a Monaco location (1-based range; uri kept as a string). */
export function toMonacoLocation(location: LspLocation): MonacoLocation {
  return { uri: location.uri, range: toMonacoRange(location.range) };
}

function isLocationLink(value: LspLocation | LspLocationLink): value is LspLocationLink {
  return 'targetUri' in value;
}

/**
 * Normalize the polymorphic definition/references result (single Location, Location[], or
 * LocationLink[]) into a flat MonacoLocation[]. A LocationLink contributes its targetUri and
 * targetSelectionRange. null/undefined yields an empty array.
 */
export function toMonacoLocations(
  value: LspLocation | LspLocation[] | LspLocationLink[] | null | undefined
): MonacoLocation[] {
  if (value === null || value === undefined) {
    return [];
  }
  const items: Array<LspLocation | LspLocationLink> = Array.isArray(value) ? value : [value];
  return items.map((item) =>
    isLocationLink(item)
      ? { uri: item.targetUri, range: toMonacoRange(item.targetSelectionRange) }
      : { uri: item.uri, range: toMonacoRange(item.range) }
  );
}

/** LSP TextEdit: replace a range with new text. The most-reused edit primitive. */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
/** Monaco single edit operation shape (1-based range + replacement text). */
export interface MonacoTextEdit {
  range: MonacoRange;
  text: string;
}

/** Convert LSP TextEdit[] to Monaco edit operations (1-based ranges); null/undefined -> []. */
export function toMonacoTextEdits(edits: LspTextEdit[] | null | undefined): MonacoTextEdit[] {
  if (edits === null || edits === undefined) {
    return [];
  }
  return edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));
}

/** Hierarchical LSP DocumentSymbol (the modern outline shape). */
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
/** Legacy flat LSP SymbolInformation (location-based, no children). */
export interface LspSymbolInformation {
  name: string;
  kind: number;
  tags?: number[];
  location: { uri: string; range: LspRange };
}
/** Monaco DocumentSymbol shape; detail and tags are required by Monaco. */
export interface MonacoDocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  tags: number[];
  range: MonacoRange;
  selectionRange: MonacoRange;
  children: MonacoDocumentSymbol[];
}

// LSP SymbolKind is 1..26 (File=1); Monaco SymbolKind is 0..25 (File=0). Offset by one.
function toMonacoSymbolKind(lspKind: number): number {
  return lspKind - 1;
}

function isSymbolInformation(value: LspDocumentSymbol | LspSymbolInformation): value is LspSymbolInformation {
  return 'location' in value;
}

function convertDocumentSymbol(symbol: LspDocumentSymbol): MonacoDocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? '',
    kind: toMonacoSymbolKind(symbol.kind),
    tags: symbol.tags ?? [],
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    children: (symbol.children ?? []).map(convertDocumentSymbol)
  };
}

function convertSymbolInformation(symbol: LspSymbolInformation): MonacoDocumentSymbol {
  const range = toMonacoRange(symbol.location.range);
  return {
    name: symbol.name,
    detail: '',
    kind: toMonacoSymbolKind(symbol.kind),
    tags: symbol.tags ?? [],
    range,
    selectionRange: range,
    children: []
  };
}

/**
 * Convert the document-symbol result (hierarchical DocumentSymbol[] or legacy flat
 * SymbolInformation[]) into Monaco DocumentSymbol[]; null/undefined -> [].
 */
export function toMonacoDocumentSymbols(
  symbols: Array<LspDocumentSymbol | LspSymbolInformation> | null | undefined
): MonacoDocumentSymbol[] {
  if (symbols === null || symbols === undefined) {
    return [];
  }
  return symbols.map((symbol) =>
    isSymbolInformation(symbol) ? convertSymbolInformation(symbol) : convertDocumentSymbol(symbol)
  );
}

/** Convert an optional LSP documentation value (string | MarkupContent) to Monaco's form. */
function toMonacoMarkup(doc: string | LspMarkupContent | undefined): string | { value: string } | undefined {
  if (doc === undefined) {
    return undefined;
  }
  return typeof doc === 'string' ? doc : { value: doc.value };
}

export interface LspParameterInformation {
  /** A substring of the signature label, or an inclusive-exclusive [start, end] offset pair into it. */
  label: string | [number, number];
  documentation?: string | LspMarkupContent;
}
export interface LspSignatureInformation {
  label: string;
  documentation?: string | LspMarkupContent;
  parameters?: LspParameterInformation[];
  activeParameter?: number;
}
export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}
export interface MonacoParameterInformation {
  label: string | [number, number];
  documentation?: string | { value: string };
}
export interface MonacoSignatureInformation {
  label: string;
  documentation?: string | { value: string };
  parameters: MonacoParameterInformation[];
  activeParameter?: number;
}
export interface MonacoSignatureHelp {
  signatures: MonacoSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

function convertParameter(parameter: LspParameterInformation): MonacoParameterInformation {
  const result: MonacoParameterInformation = { label: parameter.label };
  const documentation = toMonacoMarkup(parameter.documentation);
  if (documentation !== undefined) {
    result.documentation = documentation;
  }
  return result;
}

function convertSignature(signature: LspSignatureInformation): MonacoSignatureInformation {
  const result: MonacoSignatureInformation = {
    label: signature.label,
    parameters: (signature.parameters ?? []).map(convertParameter)
  };
  const documentation = toMonacoMarkup(signature.documentation);
  if (documentation !== undefined) {
    result.documentation = documentation;
  }
  if (signature.activeParameter !== undefined) {
    result.activeParameter = signature.activeParameter;
  }
  return result;
}

/** Convert LSP SignatureHelp to Monaco SignatureHelp; defaults active indices to 0; null/undefined -> null. */
export function toMonacoSignatureHelp(help: LspSignatureHelp | null | undefined): MonacoSignatureHelp | null {
  if (help === null || help === undefined) {
    return null;
  }
  return {
    signatures: help.signatures.map(convertSignature),
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0
  };
}

export interface LspDocumentHighlight {
  range: LspRange;
  /** LSP DocumentHighlightKind: 1=Text, 2=Read, 3=Write. Defaults to Text when absent. */
  kind?: number;
}
export interface MonacoDocumentHighlight {
  range: MonacoRange;
  /** Monaco DocumentHighlightKind: 0=Text, 1=Read, 2=Write. */
  kind: number;
}

/** Convert LSP DocumentHighlight[] to Monaco (kind offset by one; absent kind -> Text/0); null -> []. */
export function toMonacoDocumentHighlights(
  highlights: LspDocumentHighlight[] | null | undefined
): MonacoDocumentHighlight[] {
  if (highlights === null || highlights === undefined) {
    return [];
  }
  return highlights.map((highlight) => ({
    range: toMonacoRange(highlight.range),
    kind: (highlight.kind ?? 1) - 1
  }));
}

/** A text edit applied to a specific document, optionally version-pinned. */
export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}
/** A documentChanges resource operation (create/rename/delete); deferred to the file-ops path. */
export interface LspResourceOperation {
  kind: string;
  [key: string]: unknown;
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<LspTextDocumentEdit | LspResourceOperation>;
}
export interface MonacoWorkspaceTextEdit {
  resource: string;
  textEdit: MonacoTextEdit;
  versionId?: number;
}
export interface MonacoWorkspaceEdit {
  edits: MonacoWorkspaceTextEdit[];
}

function isTextDocumentEdit(entry: LspTextDocumentEdit | LspResourceOperation): entry is LspTextDocumentEdit {
  // Resource operations carry a `kind`; TextDocumentEdits carry an `edits` array.
  return 'edits' in entry && !('kind' in entry);
}

/**
 * Convert an LSP WorkspaceEdit (changes map and/or documentChanges TextDocumentEdits) into a flat
 * list of Monaco workspace text edits. resource is kept as a uri string (the register adapter wraps
 * monaco.Uri). TEXT-EDIT ONLY: CreateFile/RenameFile/DeleteFile resource operations and
 * changeAnnotations are deferred to the file-ops path. null/undefined -> { edits: [] }.
 */
export function toMonacoWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined): MonacoWorkspaceEdit {
  if (edit === null || edit === undefined) {
    return { edits: [] };
  }
  const edits: MonacoWorkspaceTextEdit[] = [];
  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      for (const textEdit of toMonacoTextEdits(textEdits)) {
        edits.push({ resource: uri, textEdit });
      }
    }
  }
  if (edit.documentChanges) {
    for (const entry of edit.documentChanges) {
      if (!isTextDocumentEdit(entry)) {
        continue; // resource operation: deferred to the file-ops path
      }
      const version = entry.textDocument.version;
      for (const textEdit of toMonacoTextEdits(entry.edits)) {
        const workspaceEdit: MonacoWorkspaceTextEdit = { resource: entry.textDocument.uri, textEdit };
        if (version !== undefined && version !== null) {
          workspaceEdit.versionId = version;
        }
        edits.push(workspaceEdit);
      }
    }
  }
  return { edits };
}

/** The LSP prepareRename result forms: a bare range, a range+placeholder, or defaultBehavior. */
export type LspPrepareRenameResult =
  | LspRange
  | { range: LspRange; placeholder: string }
  | { defaultBehavior: boolean }
  | null
  | undefined;
/** Draft prepare-rename location; the register adapter supplies the final text from the model. */
export interface MonacoRenamePrepare {
  range: MonacoRange;
  placeholder?: string;
}

/**
 * Convert an LSP prepareRename result to a draft Monaco rename location.
 * - bare Range -> { range }
 * - { range, placeholder } -> { range, placeholder }
 * - { defaultBehavior: true } -> null (Monaco falls back to word-at-position)
 * - null/undefined -> null
 * NOT a complete Monaco RenameLocation: text is supplied later by the register adapter.
 */
export function toMonacoRenamePrepare(result: LspPrepareRenameResult): MonacoRenamePrepare | null {
  if (result === null || result === undefined) {
    return null;
  }
  if ('defaultBehavior' in result) {
    return null;
  }
  if ('placeholder' in result) {
    return { range: toMonacoRange(result.range), placeholder: result.placeholder };
  }
  return { range: toMonacoRange(result) };
}

/** An LSP Command: a title plus a command id string and optional arguments. */
export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}
export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
}
/** Monaco Command: note the id field (LSP's command string maps to it). */
export interface MonacoCommand {
  id: string;
  title: string;
  arguments?: unknown[];
}
export interface MonacoCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: MonacoWorkspaceEdit;
  command?: MonacoCommand;
}
export interface MonacoCodeActionList {
  actions: MonacoCodeAction[];
}

/** Normalize an LSP Command to a Monaco Command (command string -> required id). */
function toMonacoCommand(command: LspCommand): MonacoCommand {
  const result: MonacoCommand = { id: command.command, title: command.title };
  if (command.arguments !== undefined) {
    result.arguments = command.arguments;
  }
  return result;
}

// A bare Command has its `command` field as a string; a CodeAction's command (if any) is an object.
function isBareCommand(entry: LspCommand | LspCodeAction): entry is LspCommand {
  return typeof (entry as LspCommand).command === 'string';
}

/**
 * Convert an LSP (Command | CodeAction)[] result into Monaco code actions. Bare Commands and
 * nested CodeAction.command both normalize through toMonacoCommand (command -> id). CodeAction
 * edits convert via toMonacoWorkspaceEdit. Diagnostics attachment and resolve are deferred.
 * null/undefined/empty -> { actions: [] }.
 */
export function toMonacoCodeActions(
  result: Array<LspCommand | LspCodeAction> | null | undefined
): MonacoCodeActionList {
  if (result === null || result === undefined) {
    return { actions: [] };
  }
  const actions = result.map((entry) => {
    if (isBareCommand(entry)) {
      return { title: entry.title, command: toMonacoCommand(entry) };
    }
    const action: MonacoCodeAction = { title: entry.title };
    if (entry.kind !== undefined) {
      action.kind = entry.kind;
    }
    if (entry.isPreferred !== undefined) {
      action.isPreferred = entry.isPreferred;
    }
    if (entry.edit !== undefined) {
      action.edit = toMonacoWorkspaceEdit(entry.edit);
    }
    if (entry.command !== undefined) {
      action.command = toMonacoCommand(entry.command);
    }
    return action;
  });
  return { actions };
}

export interface LspFoldingRange {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  /** 'comment' | 'imports' | 'region' (or a custom string). */
  kind?: string;
}
/**
 * Headless draft folding range: kind stays a string here. The register adapter maps it to
 * monaco.languages.FoldingRangeKind (via FoldingRangeKind.fromValue) - this is NOT the final
 * Monaco FoldingRange.
 */
export interface MonacoFoldingRangeDraft {
  start: number;
  end: number;
  kind?: string;
}

/** Convert LSP FoldingRange[] (0-based lines) to 1-based draft ranges; characters dropped; null -> []. */
export function toMonacoFoldingRanges(ranges: LspFoldingRange[] | null | undefined): MonacoFoldingRangeDraft[] {
  if (ranges === null || ranges === undefined) {
    return [];
  }
  return ranges.map((range) => {
    const draft: MonacoFoldingRangeDraft = { start: range.startLine + 1, end: range.endLine + 1 };
    if (range.kind !== undefined) {
      draft.kind = range.kind;
    }
    return draft;
  });
}

export interface LspDocumentLink {
  range: LspRange;
  target?: string;
  tooltip?: string;
  /** Opaque resolve payload; carried only for documentLink/resolve, dropped here. */
  data?: unknown;
}
export interface MonacoDocumentLink {
  range: MonacoRange;
  url?: string;
  tooltip?: string;
}
/** Monaco LinkProvider.provideLinks returns a list wrapper (ILinksList), not a bare array. */
export interface MonacoDocumentLinkList {
  links: MonacoDocumentLink[];
}

/** Convert LSP DocumentLink[] to a Monaco link list (target -> url, 1-based range); null -> { links: [] }. */
export function toMonacoDocumentLinks(links: LspDocumentLink[] | null | undefined): MonacoDocumentLinkList {
  if (links === null || links === undefined) {
    return { links: [] };
  }
  return {
    links: links.map((link) => {
      const monacoLink: MonacoDocumentLink = { range: toMonacoRange(link.range) };
      if (link.target !== undefined) {
        monacoLink.url = link.target;
      }
      if (link.tooltip !== undefined) {
        monacoLink.tooltip = link.tooltip;
      }
      return monacoLink;
    })
  };
}

export interface LspCodeLens {
  range: LspRange;
  command?: LspCommand;
  /** Opaque resolve payload; carried only for codeLens/resolve, dropped here. */
  data?: unknown;
}
export interface MonacoCodeLens {
  range: MonacoRange;
  command?: MonacoCommand;
}
/** Monaco CodeLensProvider.provideCodeLenses returns a CodeLensList wrapper. */
export interface MonacoCodeLensList {
  lenses: MonacoCodeLens[];
}

/** Convert LSP CodeLens[] to a Monaco code lens list (command -> id; unresolved = range only); null -> { lenses: [] }. */
export function toMonacoCodeLenses(lenses: LspCodeLens[] | null | undefined): MonacoCodeLensList {
  if (lenses === null || lenses === undefined) {
    return { lenses: [] };
  }
  return {
    lenses: lenses.map((lens) => {
      const monacoLens: MonacoCodeLens = { range: toMonacoRange(lens.range) };
      if (lens.command !== undefined) {
        monacoLens.command = toMonacoCommand(lens.command);
      }
      return monacoLens;
    })
  };
}

/** RGBA color, channels as floats 0..1. Shared by LSP and Monaco. */
export interface LspColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}
export interface LspColorInformation {
  range: LspRange;
  color: LspColor;
}
export interface MonacoColorInformation {
  range: MonacoRange;
  color: LspColor;
}

/** One part of a structured inlay-hint label; location/command are deferred. */
export interface LspInlayHintLabelPart {
  value: string;
  tooltip?: string | LspMarkupContent;
}
export interface LspInlayHint {
  position: LspPosition;
  label: string | LspInlayHintLabelPart[];
  /** LSP InlayHintKind: 1=Type, 2=Parameter (matches Monaco). */
  kind?: number;
  tooltip?: string | LspMarkupContent;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}
export interface MonacoInlayHintLabelPart {
  label: string;
  tooltip?: string | { value: string };
}
export interface MonacoInlayHint {
  position: { lineNumber: number; column: number };
  label: string | MonacoInlayHintLabelPart[];
  kind?: number;
  tooltip?: string | { value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
}
/** Headless draft: the register adapter supplies the InlayHintList dispose() later. */
export interface MonacoInlayHintListDraft {
  hints: MonacoInlayHint[];
}

function toMonacoLabelPart(part: LspInlayHintLabelPart): MonacoInlayHintLabelPart {
  const result: MonacoInlayHintLabelPart = { label: part.value };
  const tooltip = toMonacoMarkup(part.tooltip);
  if (tooltip !== undefined) {
    result.tooltip = tooltip;
  }
  return result;
}

/** Convert LSP InlayHint[] to a Monaco inlay-hint draft list (position 1-based; value->label); null -> { hints: [] }. */
export function toMonacoInlayHints(hints: LspInlayHint[] | null | undefined): MonacoInlayHintListDraft {
  if (hints === null || hints === undefined) {
    return { hints: [] };
  }
  return {
    hints: hints.map((hint) => {
      const monacoHint: MonacoInlayHint = {
        position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
        label: typeof hint.label === 'string' ? hint.label : hint.label.map(toMonacoLabelPart)
      };
      const tooltip = toMonacoMarkup(hint.tooltip);
      if (tooltip !== undefined) {
        monacoHint.tooltip = tooltip;
      }
      if (hint.kind !== undefined) {
        monacoHint.kind = hint.kind;
      }
      if (hint.paddingLeft !== undefined) {
        monacoHint.paddingLeft = hint.paddingLeft;
      }
      if (hint.paddingRight !== undefined) {
        monacoHint.paddingRight = hint.paddingRight;
      }
      return monacoHint;
    })
  };
}

/** LSP SelectionRange: a range plus an optional outer parent (a linked list, inner -> outer). */
export interface LspSelectionRange {
  range: LspRange;
  parent?: LspSelectionRange;
}
export interface MonacoSelectionRange {
  range: MonacoRange;
}

/**
 * Convert LSP SelectionRange[] (one nested chain per requested position) to Monaco's shape:
 * one flat inner-to-outer array per position. null/undefined -> [].
 */
export function toMonacoSelectionRanges(
  ranges: LspSelectionRange[] | null | undefined
): MonacoSelectionRange[][] {
  if (ranges === null || ranges === undefined) {
    return [];
  }
  return ranges.map((selectionRange) => {
    const chain: MonacoSelectionRange[] = [];
    let current: LspSelectionRange | undefined = selectionRange;
    while (current !== undefined) {
      chain.push({ range: toMonacoRange(current.range) });
      current = current.parent;
    }
    return chain;
  });
}

/** Convert LSP ColorInformation[] to Monaco (1-based range; color passed through); null -> []. */
export function toMonacoColorInformation(
  colors: LspColorInformation[] | null | undefined
): MonacoColorInformation[] {
  if (colors === null || colors === undefined) {
    return [];
  }
  return colors.map((entry) => ({ range: toMonacoRange(entry.range), color: entry.color }));
}

export interface LspColorPresentation {
  label: string;
  textEdit?: LspTextEdit;
  additionalTextEdits?: LspTextEdit[];
}
export interface MonacoColorPresentation {
  label: string;
  textEdit?: MonacoTextEdit;
  additionalTextEdits?: MonacoTextEdit[];
}

/** Convert LSP ColorPresentation[] to Monaco (label passthrough; edits via toMonacoTextEdits); null -> []. */
export function toMonacoColorPresentations(
  presentations: LspColorPresentation[] | null | undefined
): MonacoColorPresentation[] {
  if (presentations === null || presentations === undefined) {
    return [];
  }
  return presentations.map((presentation) => {
    const result: MonacoColorPresentation = { label: presentation.label };
    if (presentation.textEdit !== undefined) {
      const [edit] = toMonacoTextEdits([presentation.textEdit]);
      if (edit !== undefined) {
        result.textEdit = edit;
      }
    }
    if (presentation.additionalTextEdits !== undefined) {
      result.additionalTextEdits = toMonacoTextEdits(presentation.additionalTextEdits);
    }
    return result;
  });
}

export interface LspLinkedEditingRanges {
  ranges: LspRange[];
  wordPattern?: string;
}
/**
 * Draft linked-editing result. Monaco's LinkedEditingRanges.wordPattern is a RegExp, but LSP gives a
 * string; this pure converter carries the raw string and leaves RegExp compilation to the register
 * adapter (which owns Monaco coupling and any malformed-pattern handling).
 */
export interface MonacoLinkedEditingRangesDraft {
  ranges: MonacoRange[];
  wordPattern?: string;
}

/** Convert LSP LinkedEditingRanges to a Monaco draft (1-based ranges; wordPattern kept as a raw string); null/undefined -> undefined. */
export function toMonacoLinkedEditingRanges(
  result: LspLinkedEditingRanges | null | undefined
): MonacoLinkedEditingRangesDraft | undefined {
  if (result === null || result === undefined) {
    return undefined;
  }
  const draft: MonacoLinkedEditingRangesDraft = { ranges: result.ranges.map(toMonacoRange) };
  if (result.wordPattern !== undefined) {
    draft.wordPattern = result.wordPattern;
  }
  return draft;
}

export interface LspSemanticTokens {
  resultId?: string;
  data: number[];
}
/**
 * Monaco SemanticTokens (full result). The token-type/modifier legend is NOT part of this payload;
 * it comes from server capabilities (semanticTokensProvider.legend) and is supplied at register time
 * via the provider's getLegend(), so it stays register-adapter work.
 */
export interface MonacoSemanticTokens {
  resultId?: string;
  data: Uint32Array;
}

/** Convert an LSP full SemanticTokens result to Monaco's shape (data as Uint32Array); null/undefined -> null. */
export function toMonacoSemanticTokens(
  tokens: LspSemanticTokens | null | undefined
): MonacoSemanticTokens | null {
  if (tokens === null || tokens === undefined) {
    return null;
  }
  const result: MonacoSemanticTokens = { data: new Uint32Array(tokens.data) };
  if (tokens.resultId !== undefined) {
    result.resultId = tokens.resultId;
  }
  return result;
}

export interface LspSemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: number[];
}
export interface LspSemanticTokensDelta {
  resultId?: string;
  edits: LspSemanticTokensEdit[];
}
export interface MonacoSemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: Uint32Array;
}
/** Monaco SemanticTokensEdits (delta result). The legend stays register-adapter work, as with the full result. */
export interface MonacoSemanticTokensEdits {
  resultId?: string;
  edits: MonacoSemanticTokensEdit[];
}

/**
 * Convert an LSP SemanticTokensDelta to Monaco's SemanticTokensEdits (each edit's data as Uint32Array
 * only when present; start/deleteCount/resultId passed through); null/undefined -> null.
 */
export function toMonacoSemanticTokensEdits(
  delta: LspSemanticTokensDelta | null | undefined
): MonacoSemanticTokensEdits | null {
  if (delta === null || delta === undefined) {
    return null;
  }
  const edits: MonacoSemanticTokensEdit[] = delta.edits.map((edit) => {
    const converted: MonacoSemanticTokensEdit = { start: edit.start, deleteCount: edit.deleteCount };
    if (edit.data !== undefined) {
      converted.data = new Uint32Array(edit.data);
    }
    return converted;
  });
  const result: MonacoSemanticTokensEdits = { edits };
  if (delta.resultId !== undefined) {
    result.resultId = delta.resultId;
  }
  return result;
}
