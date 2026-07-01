import { describe, expect, it, vi } from 'vitest';
import { createSelectionRangeService, sanitizeSelectionRanges } from '../../src/server/lsp/selectionRangeService';

describe('SelectionRangeService', () => {
  it('plans selectionRange requests with exact positions and returns sanitized multi-target results', async () => {
    const settings = { enabled: true };
    const positions = [
      { line: 1, character: 2 },
      { line: 3, character: 4 }
    ];
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
            range: range(1, 2, 1, 5),
            parent: { range: range(1, 0, 1, 8), data: 'SECRET_DATA' },
            uri: 'file:///secret.ts'
          }
        ])
        .mockResolvedValueOnce([{ range: range(3, 4, 3, 9) }])
    };
    const service = createSelectionRangeService({ requestPlanner: planner, manager });

    await expect(
      service.selectionRanges({
        settings,
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/src/example.ts',
        languageId: 'typescript',
        positions
      })
    ).resolves.toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [{ range: range(1, 2, 1, 5), parent: { range: range(1, 0, 1, 8) } }]
        },
        {
          serverConfigId: 'eslint',
          isPrimary: false,
          result: [{ range: range(3, 4, 3, 9) }]
        }
      ]
    });

    expect(planner.planLspRequest).toHaveBeenCalledWith({
      settings,
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      workspaceRoot: '/workspace',
      feature: 'selectionRange'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/selectionRange',
      { textDocument: { uri: 'file:///workspace/src/example.ts' }, positions }
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
        { range: { bad: true } },
        { range: range(0, 0, 0, -1) }
      ])
    };
    const service = createSelectionRangeService({ requestPlanner: planner, manager });

    await expect(
      service.selectionRanges({
        settings: {},
        workspaceRoot: '/workspace',
        uri: 'file:///workspace/a.ts',
        positions: [{ line: 0, character: 0 }]
      })
    ).resolves.toEqual({ results: [] });
  });

  it('allowlist-reconstructs selection ranges, truncates unsafe parents, and survives cycles/deep chains', () => {
    const token = 'tok_SECRET_SELECTION';
    const root: any = {
      range: range(0, 1, 0, 3),
      [`key-${token}`]: 'key leak',
      uri: `file:///workspace/${token}.ts`,
      data: { token },
      command: token,
      arguments: [token],
      env: { SECRET: token },
      serverCommands: { typescript: { command: token } }
    };
    let cursor = root;
    for (let index = 0; index < 80; index += 1) {
      cursor.parent = {
        range: range(index + 1, 0, index + 1, 5),
        [`nested-${token}-${index}`]: token,
        data: token
      };
      cursor = cursor.parent;
    }
    cursor.parent = root;

    const sanitized = sanitizeSelectionRanges([
      root,
      { range: range(90, 0, 90, 2), parent: { range: { bad: true }, [`invalid-${token}`]: token } }
    ]);

    expect(JSON.stringify(sanitized)).not.toContain(token);
    expect(JSON.stringify(sanitized)).not.toContain('serverCommands');
    expect(countChain(sanitized[0])).toBe(64);
    expect(sanitized[1]).toEqual({ range: range(90, 0, 90, 2) });
  });
});

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter }
  };
}

function countChain(value: any): number {
  let count = 0;
  let cursor = value;
  while (cursor) {
    count += 1;
    cursor = cursor.parent;
  }
  return count;
}
