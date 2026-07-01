import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DeskManifest } from '../../core/types.js';
import type { LspLifecycleStatusEvent } from '../lspWebSocketBridge.js';
import type { LspLanguageDetector } from './languageDetection.js';
import type { LspManager, LspServerLease, LspServerStartOptions } from './manager.js';
import { normalizeConfiguredLspServers, type NormalizedLspLanguage } from './settings.js';

export interface LspWarmSessionCoordinator {
  scheduleBootWarmup(): void;
  warmProject(): Promise<LspWarmProjectResult>;
  getStatus(input: { serverConfigId: string; workspaceRoot: string; languageId?: string }): LspLifecycleStatusEvent | undefined;
  dispose(): void;
}

export interface LspWarmProjectResult {
  warmed: number;
  degraded: number;
  skipped: number;
}

export interface CreateLspWarmSessionCoordinatorOptions {
  manager: Pick<LspManager, 'acquireServer'>;
  languageDetector: Pick<LspLanguageDetector, 'detect'>;
  readManifest: () => Pick<DeskManifest, 'settings'>;
  schedule?: (task: () => void | Promise<void>) => void;
}

const DEFAULT_REASON = 'warm-start-failed';

export function createLspWarmSessionCoordinator(options: CreateLspWarmSessionCoordinatorOptions): LspWarmSessionCoordinator {
  return new WarmSessionCoordinator(options);
}

class WarmSessionCoordinator implements LspWarmSessionCoordinator {
  private readonly leases = new Map<string, LspServerLease>();
  private readonly statuses = new Map<string, LspLifecycleStatusEvent>();
  private readonly schedule: (task: () => void | Promise<void>) => void;
  private disposed = false;
  private bootScheduled = false;

  constructor(private readonly options: CreateLspWarmSessionCoordinatorOptions) {
    this.schedule =
      options.schedule ??
      ((task) => {
        const timer = setTimeout(() => {
          void task();
        }, 0);
        timer.unref?.();
      });
  }

  scheduleBootWarmup(): void {
    if (this.disposed || this.bootScheduled) {
      return;
    }
    this.bootScheduled = true;
    this.schedule(async () => {
      await this.warmProject();
    });
  }

  async warmProject(): Promise<LspWarmProjectResult> {
    if (this.disposed) {
      return emptyResult();
    }
    let manifest: Pick<DeskManifest, 'settings'>;
    try {
      manifest = this.options.readManifest();
    } catch {
      return emptyResult();
    }
    const workspaceRoot = resolveWorkspaceRoot(manifest.settings?.editor?.root);
    if (!workspaceRoot) {
      return emptyResult();
    }
    const config = normalizeConfiguredLspServers((manifest.settings as { lsp?: unknown } | undefined)?.lsp);
    if (config.languages.length === 0) {
      return emptyResult();
    }

    let detected: string[];
    try {
      detected = (await this.options.languageDetector.detect({ root: workspaceRoot, refresh: false })).languages;
    } catch {
      return emptyResult();
    }

    const disabled = new Set(normalizeStringList((manifest.settings as { lsp?: { disabledLanguages?: unknown } } | undefined)?.lsp?.disabledLanguages));
    const activeDetected = detected.filter((language) => !disabled.has(language));
    const targets = warmTargets(config.languages, activeDetected);
    const result = { warmed: 0, degraded: 0, skipped: Math.max(0, detected.length - activeDetected.length) };

    for (const target of targets) {
      if (this.disposed) {
        break;
      }
      const languageId = firstMatchingLanguageId(target, activeDetected);
      const key = statusKey(target.serverConfigId, workspaceRoot);
      const baseStatus = { serverConfigId: target.serverConfigId, workspaceRoot, languageId };
      this.statuses.set(key, { state: 'warming', ...baseStatus });
      if (this.leases.has(key)) {
        this.statuses.set(key, { state: 'ready', ...baseStatus });
        result.warmed += 1;
        continue;
      }
      try {
        const lease = await this.options.manager.acquireServer(startOptions(target, workspaceRoot, config.startupTimeoutMs), {
          maxSessions: config.maxSessions
        });
        if (this.disposed) {
          lease.release();
          break;
        }
        this.leases.set(key, lease);
        this.statuses.set(key, { state: 'ready', ...baseStatus });
        result.warmed += 1;
      } catch {
        this.statuses.set(key, { state: 'degraded', ...baseStatus, reason: DEFAULT_REASON });
        result.degraded += 1;
      }
    }

    return result;
  }

  getStatus(input: { serverConfigId: string; workspaceRoot: string; languageId?: string }): LspLifecycleStatusEvent | undefined {
    const workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot);
    if (!workspaceRoot) {
      return undefined;
    }
    const status = this.statuses.get(statusKey(input.serverConfigId, workspaceRoot));
    if (!status) {
      return undefined;
    }
    return {
      ...status,
      ...(input.languageId ? { languageId: input.languageId } : {})
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const lease of this.leases.values()) {
      lease.release();
    }
    this.leases.clear();
    this.statuses.clear();
  }
}

function warmTargets(commands: NormalizedLspLanguage[], detectedLanguages: string[]): NormalizedLspLanguage[] {
  const detected = new Set(detectedLanguages);
  return commands.filter((command) => languageIds(command).some((languageId) => detected.has(languageId)));
}

function firstMatchingLanguageId(command: NormalizedLspLanguage, detectedLanguages: string[]): string | undefined {
  const ids = new Set(languageIds(command));
  return detectedLanguages.find((languageId) => ids.has(languageId)) ?? languageIds(command)[0];
}

function languageIds(command: NormalizedLspLanguage): string[] {
  return command.languageIds.length > 0 ? command.languageIds : [command.id];
}

function startOptions(command: NormalizedLspLanguage, workspaceRoot: string, startupTimeoutMs: number): LspServerStartOptions {
  return {
    serverConfigId: command.serverConfigId,
    workspaceRoot,
    command: command.command,
    args: command.args,
    env: command.env,
    initializationOptions: command.initializationOptions,
    startupTimeoutMs
  };
}

function resolveWorkspaceRoot(root: unknown): string | undefined {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    return undefined;
  }
  try {
    const real = realpathSync(root);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function statusKey(serverConfigId: string, workspaceRoot: string): string {
  return `${serverConfigId}\u0000${workspaceRoot}`;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed !== '' && !strings.includes(trimmed)) {
      strings.push(trimmed);
    }
  }
  return strings;
}

function emptyResult(): LspWarmProjectResult {
  return { warmed: 0, degraded: 0, skipped: 0 };
}
