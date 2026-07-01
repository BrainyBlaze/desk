import { describe, expect, it } from 'vitest';
import type { DeskSettings } from '../src/core/types';
import { applySettingsPatch } from '../src/server/vitePlugin';
import { applyLspUiSettingsPatch, normalizeLspUiSettings, toClientSettings } from '../src/core/lspSettings';

function fullSettings(): DeskSettings {
  return {
    theme: 'medical-calm',
    muted: true,
    editor: {
      root: '/workspace',
      openFiles: ['/workspace/a.ts']
    },
    sidebars: { editor: 320 },
    lsp: {
      enabled: true,
      languages: ['typescript', '', '  ', 'python'],
      baseUrl: 'ws://127.0.0.1:5173',
      maxSessions: 5,
      startupTimeoutMs: 4000,
      serverCommands: {
        typescript: {
          enabled: true,
          command: '/secret/bin/typescript-language-server',
          args: ['--stdio'],
          env: { TYPESCRIPT_TOKEN: 'secret-token' },
          languageIds: ['typescript'],
          extensions: ['.ts', '.tsx'],
          initializationOptions: { apiKey: 'secret-init', nested: { check: true } }
        }
      },
      agents: { enabled: true }
    }
  };
}

describe('LSP settings surface', () => {
  it('normalizes client-visible LSP settings and fails closed for malformed input', () => {
    expect(
      normalizeLspUiSettings({
        enabled: true,
        languages: ['typescript', 4, '', ' python '],
        baseUrl: ' ws://127.0.0.1:5173 '
      })
    ).toEqual({ enabled: true, languages: ['typescript', 'python'], baseUrl: 'ws://127.0.0.1:5173' });

    expect(normalizeLspUiSettings({ enabled: true })).toEqual({ enabled: true, languages: [] });
    expect(normalizeLspUiSettings({ enabled: true, languages: [] })).toEqual({ enabled: true, languages: [] });

    for (const raw of [
      undefined,
      null,
      'typescript',
      { enabled: false, languages: ['typescript'] },
      { enabled: 'true', languages: ['typescript'] }
    ]) {
      expect(normalizeLspUiSettings(raw)).toEqual({ enabled: false, languages: [] });
    }
  });

  it('redacts backend-only LSP fields from client settings without mutating the manifest settings', () => {
    const settings = fullSettings();
    const client = toClientSettings(settings);

    expect(client).toEqual({
      theme: 'medical-calm',
      muted: true,
      editor: {
        root: '/workspace',
        openFiles: ['/workspace/a.ts']
      },
      sidebars: { editor: 320 },
      lsp: {
        enabled: true,
        languages: ['typescript', 'python'],
        baseUrl: 'ws://127.0.0.1:5173'
      }
    });
    expect(client.lsp).not.toHaveProperty('serverCommands');
    expect(client.lsp).not.toHaveProperty('env');
    expect(client.lsp).not.toHaveProperty('maxSessions');
    expect(client.lsp).not.toHaveProperty('startupTimeoutMs');
    expect(client.lsp).not.toHaveProperty('initializationOptions');
    expect(client.lsp).not.toHaveProperty('agents');
    expect(settings.lsp?.serverCommands?.typescript?.env).toEqual({ TYPESCRIPT_TOKEN: 'secret-token' });
    expect(settings.lsp?.serverCommands?.typescript?.initializationOptions).toEqual({
      apiKey: 'secret-init',
      nested: { check: true }
    });
  });

  it('omits absent LSP settings and returns disabled safe LSP settings for malformed blocks', () => {
    expect(toClientSettings({ theme: 'plain' })).toEqual({ theme: 'plain' });
    expect(toClientSettings({ theme: 'plain', lsp: 'bad' as unknown as DeskSettings['lsp'] })).toEqual({
      theme: 'plain',
      lsp: { enabled: false, languages: [] }
    });
    expect(toClientSettings({ theme: 'plain', lsp: { enabled: true } })).toEqual({
      theme: 'plain',
      lsp: { enabled: true, languages: [] }
    });
  });

  it('merges safe LSP POST settings while preserving backend-only LSP fields', () => {
    const settings = fullSettings();

    const next = applySettingsPatch(settings, {
      theme: 'amber',
      muted: false,
      editor: { root: '/new-workspace' },
      sidebars: { editor: 444 },
      lsp: {
        enabled: true,
        languages: [' python ', 'typescript', '', 'python'],
        baseUrl: ' not-a-url ',
        serverCommands: { python: { command: '/leak' } },
        env: { TOKEN: 'leak' },
        initializationOptions: { token: 'leak' },
        agents: { enabled: false },
        maxSessions: 99,
        startupTimeoutMs: 99
      }
    });

    expect(next.theme).toBe('amber');
    expect(next.muted).toBe(false);
    expect(next.editor?.root).toBe('/new-workspace');
    expect(next.sidebars?.editor).toBe(444);
    expect(next.lsp?.enabled).toBe(true);
    expect(next.lsp?.languages).toEqual(settings.lsp?.languages);
    expect(next.lsp?.baseUrl).toBe('not-a-url');
    expect(next.lsp?.serverCommands).toEqual(settings.lsp?.serverCommands);
    expect(next.lsp?.agents).toEqual(settings.lsp?.agents);
    expect(next.lsp?.maxSessions).toBe(settings.lsp?.maxSessions);
    expect(next.lsp?.startupTimeoutMs).toBe(settings.lsp?.startupTimeoutMs);
    expect(next.lsp?.serverCommands?.typescript?.env).toEqual({ TYPESCRIPT_TOKEN: 'secret-token' });
    expect(next.lsp?.serverCommands?.typescript?.initializationOptions).toEqual({
      apiKey: 'secret-init',
      nested: { check: true }
    });
  });

  it('normalizes enabled-only LSP UI patches and preserves or clears baseUrl by explicit shape', () => {
    const current = fullSettings().lsp;

    expect(
      applyLspUiSettingsPatch(current, {
        enabled: true,
        languages: ['', '  ', 4],
        baseUrl: ' any-runtime-base '
      })
    ).toMatchObject({ enabled: true, languages: current?.languages, baseUrl: 'any-runtime-base' });

    const blankBaseUrl = applyLspUiSettingsPatch(current, {
      enabled: false,
      languages: ['typescript'],
      baseUrl: ''
    });
    expect(blankBaseUrl).toMatchObject({ enabled: false, languages: current?.languages });
    expect(blankBaseUrl.baseUrl).toBeUndefined();

    expect(
      applyLspUiSettingsPatch(current, {
        enabled: true,
        languages: ['go'],
        baseUrl: 42
      })
    ).toMatchObject({ enabled: true, languages: current?.languages, baseUrl: current?.baseUrl });

    const cleared = applyLspUiSettingsPatch(current, {
      enabled: true,
      languages: ['typescript'],
      baseUrl: null
    });
    expect(cleared.baseUrl).toBeUndefined();
    expect(cleared.serverCommands).toEqual(current?.serverCommands);
  });

  it('preserves full LSP settings when unrelated settings are saved', () => {
    const settings = fullSettings();
    const next = applySettingsPatch(settings, { muted: false });

    expect(next.lsp).toEqual(settings.lsp);
  });

  it('normalizes the client-visible disabledLanguages denylist (trim/dedupe/drop-malformed, omit when empty)', () => {
    expect(
      normalizeLspUiSettings({
        enabled: true,
        languages: ['typescript', 'python'],
        disabledLanguages: ['python', 'python', '', '  ', 4, ' go ', null]
      })
    ).toEqual({ enabled: true, languages: ['typescript', 'python'], disabledLanguages: ['python', 'go'] });

    // Absent or empty-after-normalize -> the key is omitted entirely (mirrors baseUrl).
    expect(normalizeLspUiSettings({ enabled: true, languages: ['typescript'] })).toEqual({
      enabled: true,
      languages: ['typescript']
    });
    expect(
      normalizeLspUiSettings({ enabled: true, languages: ['typescript'], disabledLanguages: [] })
    ).toEqual({ enabled: true, languages: ['typescript'] });
    expect(
      normalizeLspUiSettings({ enabled: true, languages: ['typescript'], disabledLanguages: 'python' })
    ).toEqual({ enabled: true, languages: ['typescript'] });

    // Unknown (non-detected) disabled ids are preserved -- they are inert but the choice must survive.
    expect(
      normalizeLspUiSettings({ enabled: true, languages: ['typescript'], disabledLanguages: ['rust'] })
    ).toEqual({ enabled: true, languages: ['typescript'], disabledLanguages: ['rust'] });
  });

  it('exposes disabledLanguages on the client settings while still redacting server-only fields', () => {
    const settings = fullSettings();
    settings.lsp!.disabledLanguages = ['python', 'python', '', 'rust'];
    const client = toClientSettings(settings);

    expect(client.lsp).toEqual({
      enabled: true,
      languages: ['typescript', 'python'],
      baseUrl: 'ws://127.0.0.1:5173',
      disabledLanguages: ['python', 'rust']
    });
    expect(client.lsp).not.toHaveProperty('serverCommands');
    expect(client.lsp).not.toHaveProperty('env');
    // Server settings are not mutated by the redaction.
    expect(settings.lsp?.serverCommands?.typescript?.env).toEqual({ TYPESCRIPT_TOKEN: 'secret-token' });
  });

  it('persists a normalized disabledLanguages denylist from a patch without spreading or touching server-only fields', () => {
    const current = fullSettings().lsp;

    const next = applyLspUiSettingsPatch(current, {
      enabled: true,
      disabledLanguages: ['python', 4, '', 'python', ' go ', null],
      // hostile sidecar keys that must never be read from the patch:
      languages: ['injected'],
      serverCommands: { python: { command: '/leak' } },
      env: { TOKEN: 'leak' },
      initializationOptions: { token: 'leak' },
      maxSessions: 99,
      startupTimeoutMs: 99
    } as unknown);

    expect(next.disabledLanguages).toEqual(['python', 'go']);
    // languages is NEVER taken from the patch (server-detected list stays authoritative).
    expect(next.languages).toEqual(current?.languages);
    // server-only fields preserved byte-for-byte.
    expect(next.serverCommands).toEqual(current?.serverCommands);
    expect(next.maxSessions).toBe(current?.maxSessions);
    expect(next.startupTimeoutMs).toBe(current?.startupTimeoutMs);
    expect(next).not.toHaveProperty('env');
    expect(next).not.toHaveProperty('initializationOptions');
  });

  it('clears the denylist on an explicit empty array but preserves it when the key is absent', () => {
    const current = { ...fullSettings().lsp, disabledLanguages: ['python', 'rust'] };

    const cleared = applyLspUiSettingsPatch(current, { enabled: true, disabledLanguages: [] });
    expect(cleared.disabledLanguages).toEqual([]);

    const preserved = applyLspUiSettingsPatch(current, { enabled: false });
    expect(preserved.disabledLanguages).toEqual(['python', 'rust']);

    // A non-array disabledLanguages is ignored (denylist preserved), never coerced.
    const ignored = applyLspUiSettingsPatch(current, { enabled: true, disabledLanguages: 'python' } as unknown);
    expect(ignored.disabledLanguages).toEqual(['python', 'rust']);
  });
});
