import { fileURLToPath } from 'node:url';
import type { NormalizedLspLanguage, NormalizedLspSettings } from './settings.js';

export interface LspLanguageMatchInput {
  settings: NormalizedLspSettings;
  uri?: string;
  languageId?: string;
}

export function matchLspLanguages(input: LspLanguageMatchInput): NormalizedLspLanguage[] {
  const matches: NormalizedLspLanguage[] = [];
  const seen = new Set<string>();
  const path = input.uri ? uriToPath(input.uri) : undefined;

  if (path) {
    for (const language of input.settings.languages) {
      if (language.extensions.some((extension) => extension !== '' && path.endsWith(extension))) {
        pushUnique(matches, seen, language);
      }
    }
  }

  if (input.languageId) {
    for (const language of input.settings.languages) {
      if (language.languageIds.includes(input.languageId)) {
        pushUnique(matches, seen, language);
      }
    }
  }

  return matches;
}

export function matchLspLanguage(input: LspLanguageMatchInput): NormalizedLspLanguage | undefined {
  return matchLspLanguages(input)[0];
}

function pushUnique(matches: NormalizedLspLanguage[], seen: Set<string>, language: NormalizedLspLanguage): void {
  if (seen.has(language.serverConfigId)) {
    return;
  }
  seen.add(language.serverConfigId);
  matches.push(language);
}

function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }

  return fileURLToPath(uri);
}
