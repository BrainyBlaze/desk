import { describe, expect, it, vi } from 'vitest';
import { createRenameService } from '../../src/server/lsp/renameService';
import type { RenamePlanInput, RenameRequestTarget } from '../../src/server/lsp/renameService';

describe('createRenameService', () => {
  it('sends textDocument/rename with newName to the primary planned target with origin metadata', async () => {
    const input = renameInput();
    const renameResult = {
      changes: {
        [input.uri]: [
          {
            range: {
              start: { line: 3, character: 6 },
              end: { line: 3, character: 13 }
            },
            newText: 'renamedExample'
          }
        ]
      }
    };
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: RenamePlanInput) => ({
        targets: [target('eslint', false), target('tsserver', true)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => renameResult)
    };
    const service = createRenameService({ requestPlanner, manager });

    await expect(service.rename(input)).resolves.toEqual({
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: renameResult
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'rename'
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(1);
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/rename',
      {
        textDocument: { uri: input.uri },
        position: input.position,
        newName: input.newName
      }
    );
  });

  it('rename falls back to the first planned target when no target is primary', async () => {
    const renameResult = {
      changes: {}
    };
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [target('eslint', false), target('tailwind', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => renameResult)
    };
    const service = createRenameService({ requestPlanner, manager });

    await expect(service.rename(renameInput())).resolves.toEqual({
      serverConfigId: 'eslint',
      isPrimary: false,
      result: renameResult
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/rename',
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3, character: 7 },
        newName: 'renamedExample'
      }
    );
  });

  it('rename returns null result when no target is planned', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createRenameService({ requestPlanner, manager });

    await expect(service.rename(renameInput())).resolves.toEqual({ result: null });
    expect(manager.sendRequest).not.toHaveBeenCalled();
  });

  it('rename returns null result when the selected server returns null or undefined', async () => {
    for (const serverResult of [null, undefined]) {
      const requestPlanner = {
        planLspRequest: vi.fn(() => ({ targets: [target('tsserver', true)] }))
      };
      const manager = {
        sendRequest: vi.fn(async () => serverResult)
      };
      const service = createRenameService({ requestPlanner, manager });

      await expect(service.rename(renameInput())).resolves.toEqual({ result: null });
    }
  });

  it('sends textDocument/prepareRename to the primary planned target with origin metadata', async () => {
    const input = prepareRenameInput();
    const prepareRenameResult = {
      range: {
        start: { line: 3, character: 6 },
        end: { line: 3, character: 13 }
      },
      placeholder: 'example'
    };
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: RenamePlanInput) => ({
        targets: [target('eslint', false), target('tsserver', true)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => prepareRenameResult)
    };
    const service = createRenameService({ requestPlanner, manager });

    await expect(service.prepareRename(input)).resolves.toEqual({
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: prepareRenameResult
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'rename'
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(1);
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/prepareRename',
      {
        textDocument: { uri: input.uri },
        position: input.position
      }
    );
  });

  it('falls back to the first planned target when no target is primary', async () => {
    const prepareRenameResult = {
      range: {
        start: { line: 3, character: 6 },
        end: { line: 3, character: 13 }
      }
    };
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [target('eslint', false), target('tailwind', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => prepareRenameResult)
    };
    const service = createRenameService({ requestPlanner, manager });

    await expect(service.prepareRename(prepareRenameInput())).resolves.toEqual({
      serverConfigId: 'eslint',
      isPrimary: false,
      result: prepareRenameResult
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/prepareRename',
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3, character: 7 }
      }
    );
  });

  it('returns null result when no rename target is planned', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createRenameService({ requestPlanner, manager });

    await expect(service.prepareRename(prepareRenameInput())).resolves.toEqual({ result: null });
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
      const service = createRenameService({ requestPlanner, manager });

      await expect(service.prepareRename(prepareRenameInput())).resolves.toEqual({ result: null });
    }
  });
});

function prepareRenameInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 }
  };
}

function renameInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 },
    newName: 'renamedExample'
  };
}

function target(serverConfigId: string, isPrimary: boolean): RenameRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}
