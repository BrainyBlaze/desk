import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveRustAnalyzerAsset } from './rustAnalyzerLauncher.js';
import { resolveTypescriptCli, resolvePyrightCli, lspChildEnv } from './lspResolver.js';

export interface LspSettingsInput {
  languages?: unknown;
  serverCommands?: unknown;
  maxSessions?: unknown;
  startupTimeoutMs?: unknown;
  enabled?: unknown;
}

export interface LspServerCommandInput {
  enabled?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  languageIds?: unknown;
  extensions?: unknown;
  initializationOptions?: unknown;
}

export interface NormalizedLspSettings {
  languages: NormalizedLspLanguage[];
  maxSessions: number;
  startupTimeoutMs: number;
}

export interface NormalizedLspLanguage {
  id: string;
  serverConfigId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  languageIds: string[];
  extensions: string[];
  initializationOptions: Record<string, unknown>;
}

export interface NormalizedLspServer extends NormalizedLspLanguage {}

const DEFAULT_MAX_SESSIONS = 4;
const MAX_MAX_SESSIONS = 16;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const require = createRequire(import.meta.url);
let cachedRustAnalyzerLauncherArgs: string[] | undefined | null;

export function normalizeLspSettings(input: unknown): NormalizedLspSettings {
  if (!isRecord(input) || !Array.isArray(input.languages) || !isRecord(input.serverCommands)) {
    return emptySettings();
  }

  const languages: NormalizedLspLanguage[] = [];
  for (const id of input.languages) {
    if (typeof id !== 'string' || id.trim() === '') {
      continue;
    }
    const command = normalizeServerCommand(id, input.serverCommands[id]);
    if (command) {
      languages.push(command);
    }
  }

  return {
    languages,
    maxSessions: clampInteger(input.maxSessions, DEFAULT_MAX_SESSIONS, 1, MAX_MAX_SESSIONS),
    startupTimeoutMs: clampInteger(input.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 10, 30_000)
  };
}

export function normalizeConfiguredLspServers(input: unknown): NormalizedLspSettings {
  if (!isRecord(input) || input.enabled !== true) {
    return emptySettings();
  }

  const serverCommands = isRecord(input.serverCommands) ? input.serverCommands : {};
  const languages = builtinServerCommands(Object.keys(serverCommands));
  for (const [id, commandInput] of Object.entries(serverCommands)) {
    if (typeof id !== 'string' || id.trim() === '') {
      continue;
    }
    const command = normalizeServerCommand(id, commandInput);
    if (command) {
      languages.push(command);
    }
  }

  return {
    languages,
    maxSessions: clampInteger(input.maxSessions, DEFAULT_MAX_SESSIONS, 1, MAX_MAX_SESSIONS),
    startupTimeoutMs: clampInteger(input.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 10, 30_000)
  };
}

function builtinServerCommands(overriddenIds: string[]): NormalizedLspLanguage[] {
  const languages: NormalizedLspLanguage[] = [];
  if (!overriddenIds.includes('typescript')) {
    const cli = resolveTypescriptCli();
    if (cli) {
      languages.push({
        id: 'typescript',
        serverConfigId: 'typescript',
        command: process.execPath,
        args: [cli, '--stdio'],
        env: lspChildEnv,
        languageIds: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
        initializationOptions: {}
      });
    }
  }

  if (!overriddenIds.includes('python')) {
    const cli = resolvePyrightCli();
    if (cli) {
      languages.push({
        id: 'python',
        serverConfigId: 'python',
        command: process.execPath,
        args: [cli, '--stdio'],
        env: lspChildEnv,
        languageIds: ['python'],
        extensions: ['.py', '.pyi'],
        initializationOptions: {}
      });
    }
  }

  if (!overriddenIds.includes('rust')) {
    const launcherArgs = resolveRustAnalyzerLauncherArgs();
    if (launcherArgs) {
      languages.push({
        id: 'rust',
        serverConfigId: 'rust',
        command: process.execPath,
        args: launcherArgs,
        env: {},
        languageIds: ['rust'],
        extensions: ['.rs'],
        initializationOptions: {}
      });
    }
  }

  return languages;
}

function resolveRustAnalyzerLauncherArgs(): string[] | undefined {
  if (cachedRustAnalyzerLauncherArgs !== undefined) {
    return cachedRustAnalyzerLauncherArgs ?? undefined;
  }
  if (!resolveRustAnalyzerAsset()) {
    cachedRustAnalyzerLauncherArgs = null;
    return undefined;
  }

  const compiledLauncher = fileURLToPath(new URL('./rustAnalyzerLauncher.js', import.meta.url));
  if (existsSync(compiledLauncher)) {
    cachedRustAnalyzerLauncherArgs = [compiledLauncher];
    return cachedRustAnalyzerLauncherArgs;
  }

  const sourceLauncher = fileURLToPath(new URL('./rustAnalyzerLauncher.ts', import.meta.url));
  if (existsSync(sourceLauncher)) {
    try {
      cachedRustAnalyzerLauncherArgs = [require.resolve('tsx/cli'), sourceLauncher];
      return cachedRustAnalyzerLauncherArgs;
    } catch {
      cachedRustAnalyzerLauncherArgs = null;
      return undefined;
    }
  }

  cachedRustAnalyzerLauncherArgs = null;
  return undefined;
}

function normalizeServerCommand(id: string, input: unknown): NormalizedLspLanguage | undefined {
  if (!isRecord(input) || input.enabled !== true || typeof input.command !== 'string' || input.command.trim() === '') {
    return undefined;
  }

  return {
    id,
    serverConfigId: id,
    command: input.command,
    args: arrayOfStrings(input.args),
    env: recordOfStrings(input.env),
    languageIds: arrayOfStrings(input.languageIds),
    extensions: arrayOfStrings(input.extensions),
    initializationOptions: isRecord(input.initializationOptions) ? { ...input.initializationOptions } : {}
  };
}

function emptySettings(): NormalizedLspSettings {
  return {
    languages: [],
    maxSessions: DEFAULT_MAX_SESSIONS,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS
  };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
