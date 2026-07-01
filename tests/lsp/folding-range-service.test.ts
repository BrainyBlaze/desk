import { describe, expect, it, vi } from 'vitest';
import { createFoldingRangeService, sanitizeFoldingRanges } from '../../src/server/lsp/foldingRangeService';

describe('FoldingRangeService', () => {
  it('plans foldingRange requests and returns sanitized multi-target results', async () => {
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
        .mockResolvedValueOnce([
          {
            startLine: 1,
            startCharacter: 2,
            endLine: 4,
            endCharacter: 8,
            kind: 'region',
            collapsedText: 'SECRET_COLLAPSED',
            data: { secret: 'SECRET_DATA' }
          },
          { startLine: 5, endLine: 6, kind: 'custom-SECRET_KIND' }
        ])
        .mockResolvedValueOnce([{ startLine: 7, endLine: 9, kind: 'imports' }])
    };
    const service = createFoldingRangeService({ requestPlanner: planner, manager });

    await expect(
      service.foldingRanges({
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
          result: [
            { startLine: 1, startCharacter: 2, endLine: 4, endCharacter: 8, kind: 'region' },
            { startLine: 5, endLine: 6 }
          ]
        },
        {
          serverConfigId: 'eslint',
          isPrimary: false,
          result: [{ startLine: 7, endLine: 9, kind: 'imports' }]
        }
      ]
    });

    expect(planner.planLspRequest).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      feature: 'foldingRange'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/foldingRange',
      { textDocument: { uri: 'file:///workspace/src/example.ts' } }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/foldingRange',
      { textDocument: { uri: 'file:///workspace/src/example.ts' } }
    );
  });

  it('omits target entries for null, empty, and all-invalid sanitized arrays', async () => {
    const planner = {
      planLspRequest: vi.fn(() => ({
        targets: [
          { serverConfigId: 'nulls', workspaceRoot: '/workspace', isPrimary: true },
          { serverConfigId: 'empty', workspaceRoot: '/workspace', isPrimary: false },
          { serverConfigId: 'invalid', workspaceRoot: '/workspace', isPrimary: false }
        ]
      }))
    };
    const manager = {
      sendRequest: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([]).mockResolvedValueOnce([
        { startLine: 3, endLine: 2 },
        { startLine: '0', endLine: 1 }
      ])
    };
    const service = createFoldingRangeService({ requestPlanner: planner, manager });

    await expect(
      service.foldingRanges({ settings: {}, workspaceRoot: '/workspace', uri: 'file:///workspace/a.ts' })
    ).resolves.toEqual({ results: [] });
  });

  it('allowlist-reconstructs folding ranges without server-origin keys or secret values', () => {
    const token = 'tok_SECRET_FOLDING';
    const sanitized = sanitizeFoldingRanges([
      {
        startLine: 0,
        endLine: 2,
        startCharacter: 1,
        endCharacter: 9,
        kind: `custom-${token}`,
        collapsedText: `hidden-${token}`,
        [`key-${token}`]: 'key leak',
        uri: `file:///workspace/${token}.ts`,
        data: { token },
        command: token,
        arguments: [token],
        env: { SECRET: token },
        serverCommands: { typescript: { command: token } }
      }
    ]);

    expect(sanitized).toEqual([{ startLine: 0, endLine: 2, startCharacter: 1, endCharacter: 9 }]);
    expect(JSON.stringify(sanitized)).not.toContain(token);
    expect(JSON.stringify(sanitized)).not.toContain('collapsedText');
    expect(JSON.stringify(sanitized)).not.toContain('serverCommands');
  });
});
