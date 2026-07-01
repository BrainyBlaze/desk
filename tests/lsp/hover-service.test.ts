import { describe, expect, it, vi } from 'vitest';
import { createHoverService } from '../../src/server/lsp/hoverService';
import type { HoverPlanInput, HoverRequestTarget } from '../../src/server/lsp/hoverService';

describe('createHoverService', () => {
  it('queries each planned hover target in order and returns non-null hover results with origin metadata', async () => {
    const input = hoverInput();
    const targets = [target('tsserver', true), target('eslint', false)];
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: HoverPlanInput) => ({ targets }))
    };
    const manager = {
      sendRequest: vi.fn(async (target: { serverConfigId: string }) => {
        if (target.serverConfigId === 'tsserver') {
          return { contents: 'TypeScript hover' };
        }

        return { contents: 'ESLint hover' };
      })
    };

    const service = createHoverService({ requestPlanner, manager });

    await expect(service.hover(input)).resolves.toEqual({
      results: [
        { serverConfigId: 'tsserver', isPrimary: true, result: { contents: 'TypeScript hover' } },
        { serverConfigId: 'eslint', isPrimary: false, result: { contents: 'ESLint hover' } }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'hover'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/hover',
      { textDocument: { uri: input.uri }, position: input.position }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/hover',
      { textDocument: { uri: input.uri }, position: input.position }
    );
  });

  it('returns no results and sends no requests when planning finds no hover targets', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createHoverService({ requestPlanner, manager });

    await expect(service.hover(hoverInput())).resolves.toEqual({ results: [] });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('filters null and undefined hover responses without dropping later results', async () => {
    const targets = [target('tsserver', true), target('eslint', false), target('tailwind', false)];
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({ targets }))
    };
    const manager = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ contents: 'Tailwind hover' })
    };
    const service = createHoverService({ requestPlanner, manager });

    await expect(service.hover(hoverInput())).resolves.toEqual({
      results: [{ serverConfigId: 'tailwind', isPrimary: false, result: { contents: 'Tailwind hover' } }]
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(3);
  });
});

function hoverInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 }
  };
}

function target(serverConfigId: string, isPrimary: boolean): HoverRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}
