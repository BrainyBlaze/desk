import { describe, expect, it, vi } from 'vitest';
import {
  createSemanticTokensService,
  sanitizeSemanticTokensResponse,
  sanitizeSemanticTokens
} from '../../src/server/lsp/semanticTokensService';

describe('SemanticTokensService', () => {
  it('plans semantic token requests and returns sanitized data with provider context', async () => {
    const settings = { enabled: true };
    const planner = {
      planLspRequest: vi.fn(() => ({
        targets: [
          { serverConfigId: 'tsserver', workspaceRoot: '/workspace', isPrimary: true },
          { serverConfigId: 'eslint', workspaceRoot: '/workspace', isPrimary: false }
        ]
      }))
    };
    const manager = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce({ resultId: 'opaque-secret-result-id', data: [0, 0, 5, 1, 0, 1, 2, 3, 4, 5] })
        .mockResolvedValueOnce({ data: [0, 1, 2, 3, 4] }),
      getCapabilities: vi.fn((target: { serverConfigId: string }) =>
        target.serverConfigId === 'tsserver'
          ? {
              semanticTokensProvider: {
                legend: { tokenTypes: ['variable', 'function'], tokenModifiers: ['declaration'] },
                full: { delta: true },
                range: true,
                command: 'SECRET_COMMAND'
              }
            }
          : {}
      )
    };
    const service = createSemanticTokensService({ requestPlanner: planner, manager });

    await expect(
      service.semanticTokens({
        settings,
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts',
        languageId: 'typescript'
      })
    ).resolves.toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: { data: [0, 0, 5, 1, 0, 1, 2, 3, 4, 5] },
          legend: { tokenTypes: ['variable', 'function'], tokenModifiers: ['declaration'] },
          semanticTokensProvider: { full: { delta: true }, range: true }
        },
        {
          serverConfigId: 'eslint',
          isPrimary: false,
          result: { data: [0, 1, 2, 3, 4] }
        }
      ]
    });

    expect(planner.planLspRequest).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      feature: 'semanticTokens'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/semanticTokens/full',
      { textDocument: { uri: 'file:///workspace/src/example.ts' } }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/semanticTokens/full',
      { textDocument: { uri: 'file:///workspace/src/example.ts' } }
    );
  });

  it('omits invalid token payloads and strips server-origin opaque ids', () => {
    const token = 'SECRET_SEMANTIC_TOKEN';

    expect(
      sanitizeSemanticTokens({
        resultId: token,
        data: [0, 0, 5, 1, 0],
        command: token,
        env: { SECRET: token },
        serverCommands: { typescript: { command: token } }
      })
    ).toEqual({ data: [0, 0, 5, 1, 0] });

    expect(sanitizeSemanticTokens({ data: [0, -1, 2] })).toBeUndefined();
    expect(sanitizeSemanticTokens({ data: [0, 1.5, 2] })).toBeUndefined();
    expect(sanitizeSemanticTokens({ data: ['0', 1, 2] })).toBeUndefined();
    expect(
      JSON.stringify(
        sanitizeSemanticTokensResponse({
          results: [
            {
              serverConfigId: 'tsserver',
              isPrimary: true,
              result: { resultId: token, data: [0, 0, 5, 1, 0] },
              semanticTokensProvider: {
                legend: { tokenTypes: ['variable'], tokenModifiers: ['declaration'] },
                full: { delta: true },
                range: true,
                command: token
              }
            },
            { serverConfigId: 'bad', isPrimary: false, result: { data: [0, -1, 2] } }
          ]
        })
      )
    ).not.toContain(token);
  });
});
