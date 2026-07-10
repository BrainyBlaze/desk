import { describe, expect, it } from 'vitest';
import { normalizeConfiguredLspServers, normalizeLspSettings, type LspSettingsInput } from '../../src/server/lsp/settings';

describe('normalizeLspSettings', () => {
  it('normalizes accepted settings.lsp languages and serverCommands without requiring top-level enabled', () => {
    const normalized = normalizeLspSettings({
      languages: ['typescript', 'python'],
      maxSessions: 8,
      startupTimeoutMs: 6_000,
      serverCommands: {
        typescript: {
          enabled: true,
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { NODE_ENV: 'test' },
          languageIds: ['typescript', 'javascript'],
          extensions: ['.ts', '.js'],
          initializationOptions: { hostInfo: 'desk' }
        },
        python: {
          enabled: true,
          command: 'pyright-langserver',
          args: ['--stdio'],
          languageIds: ['python'],
          extensions: ['.py']
        }
      }
    });

    expect(normalized).toEqual({
      languages: [
        {
          id: 'typescript',
          serverConfigId: 'typescript',
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { NODE_ENV: 'test' },
          languageIds: ['typescript', 'javascript'],
          extensions: ['.ts', '.js'],
          initializationOptions: { hostInfo: 'desk' }
        },
        {
          id: 'python',
          serverConfigId: 'python',
          command: 'pyright-langserver',
          args: ['--stdio'],
          env: {},
          languageIds: ['python'],
          extensions: ['.py'],
          initializationOptions: {}
        }
      ],
      missingBuiltins: [],
      maxSessions: 8,
      startupTimeoutMs: 6_000
    });
  });

  it('filters malformed, disabled, blank, and unmatched commands without mutating input', () => {
    const input: LspSettingsInput = {
      enabled: false,
      languages: ['typescript', 'disabled', 'blank', 'missing', '', 7],
      serverCommands: {
        typescript: {
          enabled: true,
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { SECRET: 'server-side' },
          languageIds: ['typescript'],
          extensions: ['.ts']
        },
        disabled: {
          enabled: false,
          command: 'disabled-language-server'
        },
        blank: {
          enabled: true,
          command: '   '
        },
        extra: {
          enabled: true,
          command: 'extra-language-server'
        }
      }
    };
    const before = structuredClone(input);

    const normalized = normalizeLspSettings(input);

    expect(input).toEqual(before);
    expect(normalized.languages.map((language) => language.serverConfigId)).toEqual(['typescript']);
    expect(normalized.languages[0]?.env).toEqual({ SECRET: 'server-side' });
  });

  it('clamps manager capacity and startup timeout while keeping absent config fail-closed', () => {
    expect(
      normalizeLspSettings({
        languages: ['typescript'],
        maxSessions: 100,
        startupTimeoutMs: 1,
        serverCommands: {
          typescript: { enabled: true, command: 'typescript-language-server' }
        }
      })
    ).toMatchObject({ maxSessions: 16, startupTimeoutMs: 10 });

    expect(normalizeLspSettings(undefined).languages).toEqual([]);
    expect(normalizeLspSettings({ languages: ['typescript'], serverCommands: {} }).languages).toEqual([]);
  });

  it('keeps persisted-language requestApi settings separate from editor configured-server settings', () => {
    const raw = {
      enabled: true,
      languages: [],
      maxSessions: 2,
      startupTimeoutMs: 7_000,
      serverCommands: {
        typescript: {
          enabled: true,
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { SECRET: 'server-side' },
          languageIds: ['typescript'],
          extensions: ['.ts']
        },
        disabled: {
          enabled: false,
          command: 'disabled-language-server',
          extensions: ['.disabled']
        },
        blank: {
          enabled: true,
          command: '  ',
          extensions: ['.blank']
        }
      }
    };

    expect(normalizeLspSettings(raw).languages).toEqual([]);

    const configured = normalizeConfiguredLspServers(raw);
    expect(configured.maxSessions).toBe(2);
    expect(configured.startupTimeoutMs).toBe(7_000);
    expect(configured.languages.map((language) => language.serverConfigId)).toEqual(['python', 'rust', 'typescript']);
    expect(configured.languages[2]).toMatchObject({
      command: 'typescript-language-server',
      env: { SECRET: 'server-side' },
      languageIds: ['typescript'],
      extensions: ['.ts']
    });
  });

  it('provides built-in TypeScript, Python, and Rust server presets when LSP is enabled without custom commands', () => {
    const configured = normalizeConfiguredLspServers({ enabled: true });

    expect(configured.languages).toHaveLength(3);
    expect(configured.languages[0]).toMatchObject({
      id: 'typescript',
      serverConfigId: 'typescript',
      command: process.execPath,
      env: {},
      languageIds: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
      initializationOptions: {}
    });
    expect(configured.languages[0]?.args.at(-1)).toBe('--stdio');
    expect(configured.languages[0]?.args[0]).toContain('typescript-language-server');
    expect(configured.languages[1]).toMatchObject({
      id: 'python',
      serverConfigId: 'python',
      command: process.execPath,
      env: {},
      languageIds: ['python'],
      extensions: ['.py', '.pyi'],
      initializationOptions: {}
    });
    expect(configured.languages[1]?.args.at(-1)).toBe('--stdio');
    expect(configured.languages[1]?.args[0]).toContain('pyright');
    expect(configured.languages[2]).toMatchObject({
      id: 'rust',
      serverConfigId: 'rust',
      command: process.execPath,
      env: {},
      languageIds: ['rust'],
      extensions: ['.rs'],
      initializationOptions: {}
    });
    expect(configured.languages[2]?.args.join(' ')).toContain('rustAnalyzerLauncher');
    expect(configured.languages[2]?.args).not.toContain('--stdio');
    expect(configured.languages[2]?.args.join(' ')).not.toContain('rustup');
    expect(configured.languages[2]?.command).not.toBe('rust-analyzer');
    expect(configured.languages[2]?.args.join(' ')).not.toContain('/usr/bin/rust-analyzer');
  });

  it('suppresses the built-in Python preset when python has a custom server command entry', () => {
    const configured = normalizeConfiguredLspServers({
      enabled: true,
      serverCommands: {
        python: { enabled: false, command: 'pyright-langserver', extensions: ['.py'] }
      }
    });

    expect(configured.languages.map((language) => language.serverConfigId)).toEqual(['typescript', 'rust']);
  });

  it('suppresses only the matching built-in preset when a custom server command entry exists', () => {
    const configured = normalizeConfiguredLspServers({
      enabled: true,
      serverCommands: {
        typescript: { enabled: false, command: 'typescript-language-server', extensions: ['.ts'] }
      }
    });

    expect(configured.languages.map((language) => language.serverConfigId)).toEqual(['python', 'rust']);
  });

  it('suppresses the built-in Rust resolver without adding a download/cache/network path when rust is configured', () => {
    const configured = normalizeConfiguredLspServers({
      enabled: true,
      serverCommands: {
        rust: { enabled: true, command: '/opt/rust-analyzer', args: ['--stdio'], languageIds: ['rust'], extensions: ['.rs'] }
      }
    });

    expect(configured.languages.map((language) => language.serverConfigId)).toEqual(['typescript', 'python', 'rust']);
    const rust = configured.languages.find((language) => language.serverConfigId === 'rust');
    expect(rust).toMatchObject({
      command: '/opt/rust-analyzer',
      args: ['--stdio'],
      languageIds: ['rust'],
      extensions: ['.rs']
    });
    expect(JSON.stringify(rust)).not.toContain('github.com');
    expect(JSON.stringify(rust)).not.toContain('.cache');
  });

  it('editor configured-server settings fail closed unless top-level LSP enabled is true', () => {
    expect(
      normalizeConfiguredLspServers({
        enabled: false,
        serverCommands: {
          typescript: { enabled: true, command: 'typescript-language-server', extensions: ['.ts'] }
        }
      }).languages
    ).toEqual([]);

    expect(
      normalizeConfiguredLspServers({
        serverCommands: {
          typescript: { enabled: true, command: 'typescript-language-server', extensions: ['.ts'] }
        }
      }).languages
    ).toEqual([]);
  });
});
