import { describe, expect, it, vi } from 'vitest';
import { createLocationService } from '../../src/server/lsp/locationService';
import type { LocationPlanInput, LocationRequestTarget } from '../../src/server/lsp/locationService';

describe('createLocationService', () => {
  it('definition queries each planned target in order and returns non-empty results with origin metadata', async () => {
    const input = locationInput();
    const targets = [target('tsserver', true), target('eslint', false)];
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: LocationPlanInput) => ({ targets }))
    };
    const manager = {
      sendRequest: vi.fn(async (target: { serverConfigId: string }) => {
        if (target.serverConfigId === 'tsserver') {
          return location('file:///workspace/src/example.ts', 4);
        }

        return [location('file:///workspace/src/lint.ts', 8)];
      })
    };

    const service = createLocationService({ requestPlanner, manager });

    await expect(service.definition(input)).resolves.toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: location('file:///workspace/src/example.ts', 4)
        },
        {
          serverConfigId: 'eslint',
          isPrimary: false,
          result: [location('file:///workspace/src/lint.ts', 8)]
        }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'definition'
    });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/definition',
      { textDocument: { uri: input.uri }, position: input.position }
    );
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      2,
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/definition',
      { textDocument: { uri: input.uri }, position: input.position }
    );
  });

  it('references sends includeDeclaration context to each planned target', async () => {
    const input = { ...locationInput(), includeDeclaration: false };
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({ targets: [target('tsserver', true)] }))
    };
    const manager = {
      sendRequest: vi.fn(async () => [location('file:///workspace/src/example.ts', 4)])
    };
    const service = createLocationService({ requestPlanner, manager });

    await expect(service.references(input)).resolves.toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [location('file:///workspace/src/example.ts', 4)]
        }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'references'
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/references',
      {
        textDocument: { uri: input.uri },
        position: input.position,
        context: { includeDeclaration: false }
      }
    );
  });

  it('typeDefinition queries planned targets with textDocument/typeDefinition and returns non-empty results', async () => {
    const input = locationInput();
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({ targets: [target('tsserver', true)] }))
    };
    const manager = {
      sendRequest: vi.fn(async () => [location('file:///workspace/src/types.ts', 9)])
    };
    const service = createLocationService({ requestPlanner, manager });

    await expect(service.typeDefinition(input)).resolves.toEqual({
      results: [
        {
          serverConfigId: 'tsserver',
          isPrimary: true,
          result: [location('file:///workspace/src/types.ts', 9)]
        }
      ]
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'typeDefinition'
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/typeDefinition',
      { textDocument: { uri: input.uri }, position: input.position }
    );
  });

  it('implementation sends textDocument/implementation to each planned target', async () => {
    const input = locationInput();
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({ targets: [target('tsserver', true)] }))
    };
    const manager = {
      sendRequest: vi.fn(async () => [location('file:///workspace/src/impl.ts', 11)])
    };
    const service = createLocationService({ requestPlanner, manager });

    await service.implementation(input);

    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'implementation'
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/implementation',
      { textDocument: { uri: input.uri }, position: input.position }
    );
  });

  it('declaration sends textDocument/declaration to each planned target', async () => {
    const input = locationInput();
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({ targets: [target('tsserver', true)] }))
    };
    const manager = {
      sendRequest: vi.fn(async () => [location('file:///workspace/src/decl.ts', 13)])
    };
    const service = createLocationService({ requestPlanner, manager });

    await service.declaration(input);

    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'declaration'
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/declaration',
      { textDocument: { uri: input.uri }, position: input.position }
    );
  });

  it('filters null and empty location responses without dropping later results', async () => {
    const targets = [
      target('tsserver', true),
      target('eslint', false),
      target('tailwind', false),
      target('css', false)
    ];
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({ targets }))
    };
    const manager = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([location('file:///workspace/src/styles.css', 12)])
    };
    const service = createLocationService({ requestPlanner, manager });

    await expect(service.definition(locationInput())).resolves.toEqual({
      results: [
        {
          serverConfigId: 'css',
          isPrimary: false,
          result: [location('file:///workspace/src/styles.css', 12)]
        }
      ]
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(4);
  });
});

function locationInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 }
  };
}

function target(serverConfigId: string, isPrimary: boolean): LocationRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}

function location(uri: string, line: number) {
  return {
    uri,
    range: {
      start: { line, character: 1 },
      end: { line, character: 5 }
    }
  };
}
