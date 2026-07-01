import { describe, expect, it, vi } from 'vitest';
import { createCodeActionService } from '../../src/server/lsp/codeActionService';
import type { CodeActionPlanInput, CodeActionRequestTarget } from '../../src/server/lsp/codeActionService';

describe('createCodeActionService', () => {
  it('sends textDocument/codeAction with range and context to planned targets in order', async () => {
    const input = codeActionInput();
    const tsActions = [codeAction('Add missing import')];
    const eslintActions = [codeAction('Fix lint issue')];
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: CodeActionPlanInput) => ({
        targets: [target('tsserver', false), target('eslint', true)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async (target: { serverConfigId: string }) => {
        if (target.serverConfigId === 'tsserver') {
          return tsActions;
        }

        return eslintActions;
      })
    };
    const service = createCodeActionService({ requestPlanner, manager });

    await expect(service.codeActions(input)).resolves.toEqual({
      results: [
        { serverConfigId: 'tsserver', isPrimary: false, result: tsActions },
        { serverConfigId: 'eslint', isPrimary: true, result: eslintActions }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'codeAction'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/codeAction',
      { textDocument: { uri: input.uri }, range: input.range, context: input.context }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/codeAction',
      { textDocument: { uri: input.uri }, range: input.range, context: input.context }
    );
  });

  it('filters null undefined and empty-array responses without dropping later results', async () => {
    const actions = [codeAction('Fix final issue')];
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [
          target('tsserver', false),
          target('eslint', true),
          target('tailwind', false),
          target('astro', false)
        ]
      }))
    };
    const manager = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(actions)
    };
    const service = createCodeActionService({ requestPlanner, manager });

    await expect(service.codeActions(codeActionInput())).resolves.toEqual({
      results: [{ serverConfigId: 'astro', isPrimary: false, result: actions }]
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(4);
  });

  it('returns an empty results list when no plan exists', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createCodeActionService({ requestPlanner, manager });

    await expect(service.codeActions(codeActionInput())).resolves.toEqual({ results: [] });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });
});

function codeActionInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    range: {
      start: { line: 3, character: 6 },
      end: { line: 3, character: 13 }
    },
    context: {
      diagnostics: [
        {
          range: {
            start: { line: 3, character: 6 },
            end: { line: 3, character: 13 }
          },
          message: 'Missing import'
        }
      ],
      only: ['quickfix'],
      triggerKind: 1
    }
  };
}

function target(serverConfigId: string, isPrimary: boolean): CodeActionRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}

function codeAction(title: string) {
  return { title, kind: 'quickfix' };
}
