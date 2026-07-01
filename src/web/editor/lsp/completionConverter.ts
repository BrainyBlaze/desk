/**
 * Pure LSP -> Monaco completion conversion (no monaco import).
 *
 * Produces a RANGE-LESS draft suggestion: Monaco's CompletionItem.range is required but
 * depends on the editor's current word range (or a server textEdit), so the register adapter
 * injects it later. textEdit/additionalTextEdits/commitCharacters/resolve are deferred.
 *
 * CompletionItemKind differs in ordering between the specs, so the mapping is a lookup table
 * verified against this repo's monaco-editor (Function=1, Class=5, Tool=27, Snippet=28).
 */

export interface LspMarkupContent {
  kind: 'markdown' | 'plaintext';
  value: string;
}
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  insertText?: string;
  /** LSP InsertTextFormat: 1 = PlainText, 2 = Snippet. */
  insertTextFormat?: number;
  sortText?: string;
  filterText?: string;
}
export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}
export type LspCompletionResult = LspCompletionItem[] | LspCompletionList | null | undefined;

/** Range-less Monaco completion suggestion; the register adapter injects `range` later. */
export interface MonacoCompletionItemDraft {
  label: string;
  kind: number;
  insertText: string;
  detail?: string;
  documentation?: string | { value: string };
  /** Monaco CompletionItemInsertTextRule.InsertAsSnippet === 4. */
  insertTextRules?: number;
  sortText?: string;
  filterText?: string;
}
export interface MonacoCompletionListDraft {
  incomplete: boolean;
  suggestions: MonacoCompletionItemDraft[];
}

// LSP CompletionItemKind (1..25) -> Monaco CompletionItemKind, verified against monaco.d.ts.
const LSP_TO_MONACO_COMPLETION_KIND: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24 // TypeParameter
};
const DEFAULT_MONACO_KIND = 18; // Monaco Text, when LSP kind is absent/unknown
const INSERT_AS_SNIPPET = 4;
const SNIPPET_FORMAT = 2;

function toMonacoCompletionKind(lspKind: number | undefined): number {
  if (lspKind === undefined) {
    return DEFAULT_MONACO_KIND;
  }
  return LSP_TO_MONACO_COMPLETION_KIND[lspKind] ?? DEFAULT_MONACO_KIND;
}

function convertDocumentation(doc: string | LspMarkupContent | undefined): string | { value: string } | undefined {
  if (doc === undefined) {
    return undefined;
  }
  return typeof doc === 'string' ? doc : { value: doc.value };
}

function convertItem(item: LspCompletionItem): MonacoCompletionItemDraft {
  const draft: MonacoCompletionItemDraft = {
    label: item.label,
    kind: toMonacoCompletionKind(item.kind),
    insertText: item.insertText ?? item.label
  };
  if (item.detail !== undefined) {
    draft.detail = item.detail;
  }
  const documentation = convertDocumentation(item.documentation);
  if (documentation !== undefined) {
    draft.documentation = documentation;
  }
  if (item.insertTextFormat === SNIPPET_FORMAT) {
    draft.insertTextRules = INSERT_AS_SNIPPET;
  }
  if (item.sortText !== undefined) {
    draft.sortText = item.sortText;
  }
  if (item.filterText !== undefined) {
    draft.filterText = item.filterText;
  }
  return draft;
}

/** Convert an LSP completion result into a range-less Monaco completion list draft. */
export function toMonacoCompletionList(result: LspCompletionResult): MonacoCompletionListDraft {
  if (result === null || result === undefined) {
    return { incomplete: false, suggestions: [] };
  }
  if (Array.isArray(result)) {
    return { incomplete: false, suggestions: result.map(convertItem) };
  }
  return { incomplete: result.isIncomplete === true, suggestions: result.items.map(convertItem) };
}
