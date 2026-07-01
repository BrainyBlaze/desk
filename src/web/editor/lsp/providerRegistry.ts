/**
 * Capability-gating for Monaco LSP providers.
 *
 * Pure planning only: given the virtual server's advertised ServerCapabilities, decide
 * which Monaco providers should be registered and with what trigger characters. The
 * actual monaco.languages.register* calls are a later wiring step; keeping the gating
 * logic pure makes it unit-testable without a live editor.
 *
 * Rule: register a provider only when its capability is advertised (truthy). LSP
 * capabilities are `boolean | object`, so "advertised" means not undefined/null/false.
 */

import type { ServerCapabilities } from './connection.js';

export type ProviderKind =
  | 'hover'
  | 'completion'
  | 'signatureHelp'
  | 'definition'
  | 'typeDefinition'
  | 'implementation'
  | 'declaration'
  | 'references'
  | 'documentHighlight'
  | 'documentSymbol'
  | 'rename'
  | 'documentFormatting'
  | 'documentRangeFormatting'
  | 'onTypeFormatting'
  | 'codeAction'
  | 'codeLens'
  | 'documentLink'
  | 'color'
  | 'foldingRange'
  | 'selectionRange'
  | 'semanticTokens'
  | 'inlayHint'
  | 'linkedEditing';

export interface ProviderRegistration {
  kind: ProviderKind;
  /** Present for features that drive registration off trigger characters (completion, signatureHelp). */
  triggerCharacters?: string[];
}

/** Capabilities whose advertised (truthy) presence maps 1:1 to a provider kind. */
const SIMPLE_CAPABILITY_KINDS: ReadonlyArray<readonly [string, ProviderKind]> = [
  ['hoverProvider', 'hover'],
  ['definitionProvider', 'definition'],
  ['typeDefinitionProvider', 'typeDefinition'],
  ['implementationProvider', 'implementation'],
  ['declarationProvider', 'declaration'],
  ['referencesProvider', 'references'],
  ['documentHighlightProvider', 'documentHighlight'],
  ['documentSymbolProvider', 'documentSymbol'],
  ['renameProvider', 'rename'],
  ['documentFormattingProvider', 'documentFormatting'],
  ['documentRangeFormattingProvider', 'documentRangeFormatting'],
  ['documentOnTypeFormattingProvider', 'onTypeFormatting'],
  ['codeActionProvider', 'codeAction'],
  ['codeLensProvider', 'codeLens'],
  ['documentLinkProvider', 'documentLink'],
  ['colorProvider', 'color'],
  ['foldingRangeProvider', 'foldingRange'],
  ['selectionRangeProvider', 'selectionRange'],
  ['semanticTokensProvider', 'semanticTokens'],
  ['inlayHintProvider', 'inlayHint'],
  ['linkedEditingRangeProvider', 'linkedEditing']
];

function isAdvertised(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function triggerCharactersOf(value: unknown): string[] | undefined {
  if (value && typeof value === 'object') {
    const candidate = (value as { triggerCharacters?: unknown }).triggerCharacters;
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string')) {
      return candidate as string[];
    }
  }
  return undefined;
}

/** Map advertised capabilities to the set of Monaco providers to register. */
export function planProviderRegistrations(capabilities: ServerCapabilities): ProviderRegistration[] {
  const plan: ProviderRegistration[] = [];

  // Trigger-character-driven features keep their characters in the plan.
  for (const [key, kind] of [
    ['completionProvider', 'completion'],
    ['signatureHelpProvider', 'signatureHelp']
  ] as ReadonlyArray<readonly [string, ProviderKind]>) {
    if (isAdvertised(capabilities[key])) {
      const triggerCharacters = triggerCharactersOf(capabilities[key]);
      plan.push(triggerCharacters ? { kind, triggerCharacters } : { kind });
    }
  }

  for (const [key, kind] of SIMPLE_CAPABILITY_KINDS) {
    if (isAdvertised(capabilities[key])) {
      plan.push({ kind });
    }
  }

  return plan;
}
