import type { DeskLspSettings, DeskSettings } from './types.js';

export interface DeskLspUiSettings {
  enabled: boolean;
  languages: string[];
  /**
   * User denylist of language ids to keep OFF, even when detected. Omitted when empty.
   * Server-detected `languages` stays authoritative; this only SUBTRACTS from it at runtime.
   */
  disabledLanguages?: string[];
  baseUrl?: string;
}

export type DeskClientSettings = Omit<DeskSettings, 'lsp'> & {
  lsp?: DeskLspUiSettings;
};

export interface DeskLspUiSettingsPatch {
  enabled?: boolean;
  disabledLanguages?: string[];
  baseUrl?: string | null;
}

export function normalizeLspUiSettings(raw: unknown): DeskLspUiSettings {
  if (!isRecord(raw) || raw.enabled !== true) {
    return disabledLspSettings(raw);
  }
  const languages = normalizeLanguageList(raw.languages);
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== '' ? raw.baseUrl.trim() : undefined;
  const settings: DeskLspUiSettings = { enabled: true, languages };
  attachDisabledLanguages(settings, raw.disabledLanguages);
  if (baseUrl !== undefined) {
    settings.baseUrl = baseUrl;
  }
  return settings;
}

export function toClientSettings(settings: DeskSettings | undefined): DeskClientSettings {
  if (!settings) {
    return {};
  }
  const { lsp: _lsp, ...rest } = settings as DeskSettings & { lsp?: unknown };
  const clientSettings: DeskClientSettings = { ...rest };
  if ('lsp' in settings) {
    clientSettings.lsp = normalizeLspUiSettings(_lsp);
  }
  return clientSettings;
}

export function applyLspUiSettingsPatch(current: DeskLspSettings | undefined, patch: unknown): DeskLspSettings {
  const next: DeskLspSettings = { ...(current ?? {}) };
  if (!isRecord(patch)) {
    return next;
  }
  if (typeof patch.enabled === 'boolean') {
    next.enabled = patch.enabled;
  }
  // Denylist is the ONLY user-writable list. An array (incl. empty) replaces it with the normalized
  // set; an explicit [] clears it; any non-array value leaves the stored denylist untouched. Never
  // read from `languages` (server-detected) or any server-only key here.
  if (Array.isArray(patch.disabledLanguages)) {
    next.disabledLanguages = normalizeLanguageList(patch.disabledLanguages);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'baseUrl')) {
    if (patch.baseUrl === null || (typeof patch.baseUrl === 'string' && patch.baseUrl.trim() === '')) {
      delete next.baseUrl;
    } else if (typeof patch.baseUrl === 'string') {
      next.baseUrl = patch.baseUrl.trim();
    }
  }
  return next;
}

function disabledLspSettings(raw?: unknown): DeskLspUiSettings {
  const settings: DeskLspUiSettings = { enabled: false, languages: [] };
  // Preserve a remembered denylist even while the master toggle is off, so the user's per-language
  // choices survive a round-trip and re-apply when LSP is re-enabled.
  if (isRecord(raw)) {
    attachDisabledLanguages(settings, raw.disabledLanguages);
  }
  return settings;
}

/** Attach `disabledLanguages` only when the normalized denylist is non-empty (mirrors baseUrl's omit-when-empty). */
function attachDisabledLanguages(target: DeskLspUiSettings, raw: unknown): void {
  if (!Array.isArray(raw)) {
    return;
  }
  const disabled = normalizeLanguageList(raw);
  if (disabled.length > 0) {
    target.disabledLanguages = disabled;
  }
}

function normalizeLanguageList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const languages: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const language = entry.trim();
    if (language !== '' && !languages.includes(language)) {
      languages.push(language);
    }
  }
  return languages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
