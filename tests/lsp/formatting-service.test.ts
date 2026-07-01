import { describe, expect, it, vi } from 'vitest';
import { createFormattingService } from '../../src/server/lsp/formattingService';
import type { FormattingPlanInput, FormattingRequestTarget } from '../../src/server/lsp/formattingService';

describe('createFormattingService', () => {
  it('sends textDocument/formatting to the first planned target and returns edits with origin metadata', async () => {
    const input = formattingInput();
    const edits = [textEdit(2, 'const x = 1;\n')];
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: FormattingPlanInput) => ({
        targets: [target('prettier', true), target('eslint', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => edits)
    };
    const service = createFormattingService({ requestPlanner, manager });

    await expect(service.formatDocument(input)).resolves.toEqual({
      serverConfigId: 'prettier',
      isPrimary: true,
      result: edits
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'formatting'
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(1);
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'prettier', workspaceRoot: '/workspace' },
      'textDocument/formatting',
      { textDocument: { uri: input.uri }, options: input.options }
    );
  });

  it('returns empty edits without calling manager when no formatting target is planned', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createFormattingService({ requestPlanner, manager });

    await expect(service.formatDocument(formattingInput())).resolves.toEqual({ result: [] });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('returns empty edits for null or empty server results', async () => {
    for (const serverResult of [null, undefined, []]) {
      const requestPlanner = {
        planLspRequest: vi.fn(() => ({ targets: [target('prettier', true)] }))
      };
      const manager = {
        sendRequest: vi.fn(async () => serverResult)
      };
      const service = createFormattingService({ requestPlanner, manager });

      await expect(service.formatDocument(formattingInput())).resolves.toEqual({ result: [] });
    }
  });
});

function formattingInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    options: { tabSize: 2, insertSpaces: true }
  };
}

function target(serverConfigId: string, isPrimary: boolean): FormattingRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}

function textEdit(line: number, newText: string) {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 12 }
    },
    newText
  };
}
