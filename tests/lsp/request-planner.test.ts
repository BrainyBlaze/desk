import { describe, expect, it } from 'vitest';
import { planLspRequest } from '../../src/server/lsp/requestPlanner';
import type { NormalizedLspSettings } from '../../src/server/lsp/settings';

describe('planLspRequest', () => {
  it('fans out multi-target features in extension-before-language order', () => {
    const plan = planLspRequest({
      settings: normalizedSettings(),
      uri: '/workspace/src/example.ts',
      languageId: 'javascript',
      workspaceRoot: '/workspace',
      feature: 'hover'
    });

    expect(plan?.targets.map((target) => target.serverConfigId)).toEqual(['ts-eslint', 'typescript', 'javascript']);
    expect(plan?.targets.map((target) => target.workspaceRoot)).toEqual(['/workspace', '/workspace', '/workspace']);
  });

  it('de-dupes duplicate serverConfigId matches', () => {
    const plan = planLspRequest({
      settings: normalizedSettings(),
      uri: '/workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      feature: 'documentHighlight'
    });

    expect(plan?.targets.map((target) => target.serverConfigId)).toEqual(['ts-eslint', 'typescript']);
  });

  it('selects a single deterministic formatting target', () => {
    const plan = planLspRequest({
      settings: normalizedSettings(),
      uri: '/workspace/src/example.ts',
      languageId: 'javascript',
      workspaceRoot: '/workspace',
      feature: 'formatting'
    });

    expect(plan?.targets.map((target) => target.serverConfigId)).toEqual(['ts-eslint']);
  });

  it('selects a single deterministic rename target', () => {
    const plan = planLspRequest({
      settings: normalizedSettings(),
      uri: '/workspace/src/example.ts',
      languageId: 'javascript',
      workspaceRoot: '/workspace',
      feature: 'rename'
    });

    expect(plan?.targets.map((target) => target.serverConfigId)).toEqual(['ts-eslint']);
  });

  it('returns undefined when no server command matches', () => {
    expect(
      planLspRequest({
        settings: normalizedSettings(),
        uri: '/workspace/src/example.go',
        languageId: 'go',
        workspaceRoot: '/workspace',
        feature: 'hover'
      })
    ).toBeUndefined();
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
