import { describe, expect, it, vi } from 'vitest';
import { createCompletionService } from '../../src/server/lsp/completionService';
import type { CompletionPlanInput, CompletionRequestTarget } from '../../src/server/lsp/completionService';

describe('createCompletionService', () => {
  it('sends textDocument/completion to the primary planned target with origin metadata', async () => {
    const input = completionInput();
    const completionResult = {
      isIncomplete: false,
      items: [{ label: 'example', kind: 3 }]
    };
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: CompletionPlanInput) => ({
        targets: [target('eslint', false), target('tsserver', true)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => completionResult)
    };
    const service = createCompletionService({ requestPlanner, manager });

    await expect(service.complete(input)).resolves.toEqual({
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: completionResult
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'completion'
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(1);
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/completion',
      {
        textDocument: { uri: input.uri },
        position: input.position,
        context: input.context
      }
    );
  });

  it('falls back to the first planned target when no target is primary', async () => {
    const completionResult = [{ label: 'fallback' }];
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [target('eslint', false), target('tailwind', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => completionResult)
    };
    const service = createCompletionService({ requestPlanner, manager });

    await expect(service.complete(completionInput())).resolves.toEqual({
      serverConfigId: 'eslint',
      isPrimary: false,
      result: completionResult
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/completion',
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3, character: 7 },
        context: { triggerKind: 2, triggerCharacter: '.' }
      }
    );
  });

  it('returns null result when no completion target is planned', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createCompletionService({ requestPlanner, manager });

    await expect(service.complete(completionInput())).resolves.toEqual({ result: null });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('returns null result when the selected server returns null or undefined', async () => {
    for (const serverResult of [null, undefined]) {
      const requestPlanner = {
        planLspRequest: vi.fn(() => ({ targets: [target('tsserver', true)] }))
      };
      const manager = {
        sendRequest: vi.fn(async () => serverResult)
      };
      const service = createCompletionService({ requestPlanner, manager });

      await expect(service.complete(completionInput())).resolves.toEqual({ result: null });
    }
  });
});

function completionInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 },
    context: { triggerKind: 2, triggerCharacter: '.' }
  };
}

function target(serverConfigId: string, isPrimary: boolean): CompletionRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}
