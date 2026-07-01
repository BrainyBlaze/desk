import { describe, expect, it, vi } from 'vitest';
import { createSignatureHelpService } from '../../src/server/lsp/signatureHelpService';
import type { SignatureHelpPlanInput, SignatureHelpRequestTarget } from '../../src/server/lsp/signatureHelpService';

describe('createSignatureHelpService', () => {
  it('sends textDocument/signatureHelp to the primary planned target with origin metadata', async () => {
    const input = signatureHelpInput();
    const signatureHelpResult = {
      signatures: [{ label: 'example(value: string)' }],
      activeSignature: 0,
      activeParameter: 0
    };
    const requestPlanner = {
      planLspRequest: vi.fn((planInput: SignatureHelpPlanInput) => ({
        targets: [target('eslint', false), target('tsserver', true)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => signatureHelpResult)
    };
    const service = createSignatureHelpService({ requestPlanner, manager });

    await expect(service.signatureHelp(input)).resolves.toEqual({
      serverConfigId: 'tsserver',
      isPrimary: true,
      result: signatureHelpResult
    });
    expect(requestPlanner.planLspRequest).toHaveBeenCalledWith({
      settings: input.settings,
      uri: input.uri,
      languageId: input.languageId,
      workspaceRoot: input.workspaceRoot,
      feature: 'signatureHelp'
    });
    expect(manager.sendRequest).toHaveBeenCalledTimes(1);
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'tsserver', workspaceRoot: '/workspace' },
      'textDocument/signatureHelp',
      {
        textDocument: { uri: input.uri },
        position: input.position,
        context: input.context
      }
    );
  });

  it('falls back to the first planned target when no target is primary', async () => {
    const signatureHelpResult = { signatures: [{ label: 'fallback()' }] };
    const requestPlanner = {
      planLspRequest: vi.fn(() => ({
        targets: [target('eslint', false), target('tailwind', false)]
      }))
    };
    const manager = {
      sendRequest: vi.fn(async () => signatureHelpResult)
    };
    const service = createSignatureHelpService({ requestPlanner, manager });

    await expect(service.signatureHelp(signatureHelpInput())).resolves.toEqual({
      serverConfigId: 'eslint',
      isPrimary: false,
      result: signatureHelpResult
    });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'eslint', workspaceRoot: '/workspace' },
      'textDocument/signatureHelp',
      {
        textDocument: { uri: 'file:///workspace/src/example.ts' },
        position: { line: 3, character: 7 },
        context: {
          triggerKind: 2,
          triggerCharacter: '(',
          isRetrigger: false
        }
      }
    );
  });

  it('returns null result when no signature-help target is planned', async () => {
    const requestPlanner = {
      planLspRequest: vi.fn(() => undefined)
    };
    const manager = {
      sendRequest: vi.fn()
    };
    const service = createSignatureHelpService({ requestPlanner, manager });

    await expect(service.signatureHelp(signatureHelpInput())).resolves.toEqual({ result: null });
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
      const service = createSignatureHelpService({ requestPlanner, manager });

      await expect(service.signatureHelp(signatureHelpInput())).resolves.toEqual({ result: null });
    }
  });
});

function signatureHelpInput() {
  return {
    settings: { enabled: true, languages: [] },
    uri: 'file:///workspace/src/example.ts',
    languageId: 'typescript',
    workspaceRoot: '/workspace',
    position: { line: 3, character: 7 },
    context: {
      triggerKind: 2,
      triggerCharacter: '(',
      isRetrigger: false
    }
  };
}

function target(serverConfigId: string, isPrimary: boolean): SignatureHelpRequestTarget {
  return { serverConfigId, workspaceRoot: '/workspace', isPrimary };
}
