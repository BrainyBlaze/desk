import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveLspSettings } from '../src/web/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchReturning(body: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body)
    } as Response);
  });
  vi.stubGlobal('fetch', fetchStub);
  return { calls };
}

describe('saveLspSettings', () => {
  it('POSTs ONLY { lsp: { enabled, disabledLanguages } } -- never languages/serverCommands/env', async () => {
    const { calls } = stubFetchReturning({ lsp: { enabled: true, languages: ['typescript'] } });

    await saveLspSettings({ enabled: true, disabledLanguages: ['python', 'go'] });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/settings');
    expect(calls[0]!.init.method).toBe('POST');
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({ lsp: { enabled: true, disabledLanguages: ['python', 'go'] } });
    // Hard boundary: the write payload exposes no server-only key, ever.
    const serialized = calls[0]!.init.body as string;
    for (const forbidden of ['languages":', 'serverCommands', 'env', 'initializationOptions', 'baseUrl', 'maxSessions', 'startupTimeoutMs']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('omits disabledLanguages from the body when none is supplied (master-toggle-only save)', async () => {
    const { calls } = stubFetchReturning({ lsp: { enabled: false, languages: [] } });

    await saveLspSettings({ enabled: false });

    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({ lsp: { enabled: false } });
  });

  it('returns the server-normalized settings so the caller adopts the single source of truth', async () => {
    stubFetchReturning({ lsp: { enabled: true, languages: ['typescript'], disabledLanguages: ['python'] } });

    const saved = await saveLspSettings({ enabled: true, disabledLanguages: ['python'] });

    expect(saved.lsp).toEqual({ enabled: true, languages: ['typescript'], disabledLanguages: ['python'] });
  });
});
