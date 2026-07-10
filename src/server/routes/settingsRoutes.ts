import { readManifestFile, resolveManifestPath, updateManifestFile } from '../../core/config.js';
import { applyLspUiSettingsPatch, toClientSettings } from '../../core/lspSettings.js';
import type { DeskSettings } from '../../core/types.js';
import { readJsonBody, sendJson } from '../httpUtil.js';
import { normalizeConfiguredLspServers } from '../lsp/settings.js';
import type { DeskRoute } from '../plugin.js';

export function applySettingsPatch(current: DeskSettings | undefined, body: Record<string, unknown>): DeskSettings {
  const settings: DeskSettings = { ...(current ?? {}) };
  if (typeof body.theme === 'string') {
    settings.theme = body.theme;
  }
  if (typeof body.muted === 'boolean') {
    settings.muted = body.muted;
  }
  if (body.editor && typeof body.editor === 'object') {
    const editor = body.editor as Record<string, unknown>;
    const next = { ...(settings.editor ?? {}) };
    if (typeof editor.root === 'string') {
      next.root = editor.root;
    }
    if (Array.isArray(editor.openFiles)) {
      next.openFiles = editor.openFiles.filter((file): file is string => typeof file === 'string');
    }
    if (typeof editor.activeFile === 'string') {
      next.activeFile = editor.activeFile;
    } else if (editor.activeFile === null) {
      delete next.activeFile;
    }
    if (editor.autosave === 'off' || editor.autosave === 'after-delay' || editor.autosave === 'on-focus-change') {
      next.autosave = editor.autosave;
    }
    if (typeof editor.autosaveDelayMs === 'number' && Number.isFinite(editor.autosaveDelayMs)) {
      next.autosaveDelayMs = Math.min(30_000, Math.max(250, Math.round(editor.autosaveDelayMs)));
    }
    settings.editor = next;
  }
  if (body.sidebars && typeof body.sidebars === 'object') {
    const sidebars = { ...(settings.sidebars ?? {}) };
    for (const [key, value] of Object.entries(body.sidebars as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        sidebars[key] = Math.min(560, Math.max(180, Math.round(value)));
      }
    }
    settings.sidebars = sidebars;
  }
  if (body.lsp && typeof body.lsp === 'object') {
    settings.lsp = applyLspUiSettingsPatch(settings.lsp, body.lsp);
  }
  return settings;
}

export function createSettingsRoutes(): DeskRoute {
  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const manifest = readManifestFile(resolveManifestPath());
      sendJson(
        res,
        200,
        toClientSettings(manifest.settings, {
          missingBuiltins: normalizeConfiguredLspServers(manifest.settings?.lsp).missingBuiltins
        })
      );
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const updated = await updateManifestFile(manifestPath, (manifest) => {
        const settings = applySettingsPatch(manifest.settings, body);
        return { ...manifest, settings };
      });
      const settings = updated?.settings;
      if (!settings) {
        throw new Error('settings update unexpectedly produced no manifest');
      }
      sendJson(
        res,
        200,
        toClientSettings(settings, {
          missingBuiltins: normalizeConfiguredLspServers(settings.lsp).missingBuiltins
        })
      );
      return true;
    }

    return false;
  };
}
