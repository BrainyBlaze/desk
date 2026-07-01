import { describe, expect, it, vi } from 'vitest';
import { LspFeatureRouter } from '../../src/server/lsp/featureRouter';

describe('LspFeatureRouter', () => {
  it('routes a request to the selected server/workspace through LspManager', async () => {
    const manager = {
      sendRequest: vi.fn(async () => ({ contents: 'hover result' }))
    };
    const router = new LspFeatureRouter(manager);
    const params = {
      textDocument: { uri: 'file:///workspace/example.ts' },
      position: { line: 4, character: 2 }
    };

    const result = await router.routeRequest({
      serverConfigId: 'typescript',
      workspaceRoot: '/workspace',
      method: 'textDocument/hover',
      params
    });

    expect(result).toEqual({ contents: 'hover result' });
    expect(manager.sendRequest).toHaveBeenCalledWith(
      { serverConfigId: 'typescript', workspaceRoot: '/workspace' },
      'textDocument/hover',
      params
    );
  });
});
