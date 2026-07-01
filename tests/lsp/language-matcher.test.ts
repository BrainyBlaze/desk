import { describe, expect, it } from 'vitest';
import { matchLspLanguages } from '../../src/server/lsp/languageMatcher';
import type { NormalizedLspSettings } from '../../src/server/lsp/settings';

describe('matchLspLanguages', () => {
  it('returns extension matches before languageId matches in settings order', () => {
    const matches = matchLspLanguages({
      settings: normalizedSettings(),
      uri: 'file:///workspace/src/example.ts',
      languageId: 'javascript'
    });

    expect(matches.map((match) => match.serverConfigId)).toEqual(['ts-eslint', 'typescript', 'javascript']);
  });

  it('de-dupes serverConfigId while preserving the first occurrence', () => {
    const matches = matchLspLanguages({
      settings: normalizedSettings(),
      uri: '/workspace/src/example.ts',
      languageId: 'typescript'
    });

    expect(matches.map((match) => match.serverConfigId)).toEqual(['ts-eslint', 'typescript']);
  });

  it('returns no matches when no extension or languageId applies', () => {
    expect(
      matchLspLanguages({
        settings: normalizedSettings(),
        uri: '/workspace/src/example.go',
        languageId: 'go'
      })
    ).toEqual([]);
  });
});

function normalizedSettings(): NormalizedLspSettings {
  return {
    maxSessions: 4,
    startupTimeoutMs: 5_000,
    languages: [
      {
        id: 'ts-eslint',
        serverConfigId: 'ts-eslint',
        command: 'eslint-language-server',
        args: ['--stdio'],
        env: {},
        initializationOptions: {},
        languageIds: ['typescript'],
        extensions: ['.ts']
      },
      {
        id: 'typescript',
        serverConfigId: 'typescript',
        command: 'typescript-language-server',
        args: ['--stdio'],
        env: {},
        initializationOptions: {},
        languageIds: ['typescript'],
        extensions: ['.ts']
      },
      {
        id: 'javascript',
        serverConfigId: 'javascript',
        command: 'javascript-language-server',
        args: ['--stdio'],
        env: {},
        initializationOptions: {},
        languageIds: ['javascript'],
        extensions: ['.js']
      }
    ]
  };
}
