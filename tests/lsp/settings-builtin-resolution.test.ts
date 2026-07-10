import { createRequire as realCreateRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('built-in LSP server resolution', () => {
  afterEach(() => {
    vi.doUnmock('node:module');
    vi.resetModules();
  });

  it('isolates pyright resolution failure without disabling the TypeScript preset', async () => {
    vi.resetModules();
    vi.doMock('node:module', () => ({
      createRequire: (url: string) => {
        const realRequire = realCreateRequire(url);
        const mockedRequire = ((specifier: string) => realRequire(specifier)) as NodeJS.Require;
        mockedRequire.resolve = (specifier: string) => {
          if (specifier === 'pyright/langserver.index.js') {
            throw new Error('pyright missing');
          }
          return realRequire.resolve(specifier);
        };
        return mockedRequire;
      }
    }));

    const { normalizeConfiguredLspServers } = await import('../../src/server/lsp/settings');

    const configured = normalizeConfiguredLspServers({ enabled: true });
    expect(configured.languages.map((language) => language.serverConfigId)).toEqual([
      'typescript',
      'rust'
    ]);
    expect(configured.missingBuiltins).toEqual(['python']);
  });
});
